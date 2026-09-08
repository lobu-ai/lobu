/**
 * Source reads for DEVICE-backed connectors.
 *
 * `readSourceFeed` (connector-pushdown.ts) reads a feed by resolving the
 * connector's COMPILED code and running its per-feed `read()` handler in the
 * connector isolate. A device-manifest connector (`apple.*`, `os.shell`,
 * `chrome.*`, …) has no compiled code at all — it is metadata-only
 * on the server and implemented natively on the paired device — so that path
 * cannot serve it.
 *
 * This module is the missing seam. It reuses the EXISTING device transport
 * end to end rather than inventing a second one:
 *
 *   1. `createConnectorOperationRun({ approvalMode: 'device' })` enqueues an
 *      ephemeral `run_type='action'` row (the same helper
 *      `manage_operations.execute` and `dispatch-chrome-action` use).
 *   2. The paired device claims it on its next `/api/workers/poll` — the pin
 *      and capability rules in poll.ts already cover `run_type='action'` on a
 *      device-pinned connection, so no claim-path change was needed.
 *   3. The device POSTs `/api/workers/complete-action` with the rows.
 *   4. `waitForDeviceActionRun` observes the terminal row and returns.
 *
 * The contract is connector-agnostic: any device connector that declares a
 * feed with `operations: ['read']` in its manifest `feeds_schema` opts in, and
 * implements the reserved {@link DEVICE_FEED_READ_ACTION_KEY} action
 * natively. The action key is reserved protocol, deliberately NOT declared in
 * `actions_schema` — declaring it would flip `supportsExecute` and publish a
 * read seam as a user-invokable operation.
 *
 * Retains NOTHING: no events, no checkpoint, no feed state, no embeddings. The
 * rows DO transit Postgres — the `runs` row is how a result crosses from the
 * device to whichever replica is waiting, and that is also what makes this
 * multi-replica safe — but the caller's filters and the device's rows are
 * scrubbed off that row the moment the read returns, on every path. A direct
 * read is uncopied, not un-transmitted.
 */

import { ToolError } from '@lobu/core';
import { getDb, pgTextArray } from '../db/client';
import { createConnectorOperationRun } from '../runs/queue-service';
import { classifyRunOutcome } from '../runs/run-outcome';
import { waitForDeviceActionRun } from '../tools/admin/device-action-wait';
import { DEVICE_ONLINE_WINDOW_SECONDS, describeDeviceLastSeen } from '../utils/device-liveness';
import logger from '../utils/logger';
import {
  DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE,
  describeDeviceConnectorSetupRequired,
  findDeviceConnectorReadiness,
  loadDeviceConnectorReadiness,
} from '../worker-api/device-connector-readiness';
import { DEVICE_FEED_READ_ACTION_KEY } from './device-feed-read-protocol';

/**
 * The waiter this module calls. Production always uses the imported one; the
 * slot exists so a test can make the wait FAIL.
 *
 * Why a slot and not `vi.mock`: `packages/server/vitest.config.ts` sets
 * `isolate: false` so one Postgres-backed module graph is shared by every test
 * file. Under that setting whether a module mock takes effect depends on which
 * file imported `connector-pushdown` first, which made the two waiter-failure
 * cases pass alone and time out in a full run. A slot is load-order
 * independent.
 *
 * @internal
 */
type DeviceActionWaiter = typeof waitForDeviceActionRun;
let deviceActionWaiter: DeviceActionWaiter = waitForDeviceActionRun;

/**
 * TEST ONLY — not part of any public, SDK, or cross-package surface. Swaps the
 * waiter used by {@link readDeviceFeed}; pass `null` to restore the
 * production one. The only caller is
 * `__tests__/integration/connectors/device-feed-read.test.ts`, which resets it
 * in `beforeEach`.
 *
 * @internal
 */
export function __setDeviceActionWaiterForTest(waiter: DeviceActionWaiter | null): void {
  deviceActionWaiter = waiter ?? waitForDeviceActionRun;
}

/** Row cap a live device read will ever ask for, whatever the caller passed. */
export const DEVICE_FEED_READ_MAX_LIMIT = 500;
/** Row count asked for when the caller names none. */
export const DEVICE_FEED_READ_DEFAULT_LIMIT = 50;
/**
 * Deepest page a source read will ask a device for. Paging is not the point of a
 * live feed — an unbounded offset is a full archive scan per request, paid on
 * the user's laptop — so it is fenced rather than left to the caller.
 */
export const DEVICE_FEED_READ_MAX_OFFSET = 10_000;

export interface DeviceFeedReadParams {
  organizationId: string;
  /** feeds.id — already resolved + visibility-fenced by the caller. */
  feedId: number;
  feedKey: string;
  /** Feed config, merged with the connection config by the caller. */
  feedConfig: Record<string, unknown>;
  connectionId: number;
  connectorKey: string;
  /** Exact connector artifact selected for this read. */
  connectorVersion: string | null;
  manifestHash: string | null;
  /** User whose device fleet is authorized to serve this connection. */
  deviceOwnerUserId: string | null;
  /** `connections.device_worker_id` — the execution pin, or null when unpinned. */
  deviceWorkerId: string | null;
  /** Stored feed lifecycle. Setup diagnostics may still be read while auto-paused. */
  feedStatus: string;
  /** `connector_definitions.required_capability` for the capability pre-check. */
  requiredCapability: string | null;
  query?: string;
  cursor?: string;
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
  /**
   * Caller's deadline. An explicit source read (`read_feeds` /
   * `client.feeds.readMany`) bounds each feed at its own timeout — 10s by
   * default, 30s max — not the device budget (60s pre-claim, then 95s or the
   * action's own declared timeout), so one sleeping laptop cannot hold the
   * batch open. Aborting is not the same as abandoning: the waiter stops
   * polling, finalizes the run as `timeout`, and the cleanup in
   * {@link readDeviceFeed} still scrubs it, so no work is left orphaned behind
   * a `Promise.race` the caller walked away from.
   */
  signal?: AbortSignal;
}

export interface DeviceFeedReadResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total?: number;
  nextCursor?: string;
  hasMore?: boolean;
}

/** The `action_input` a device receives for a direct feed read. */
export interface DeviceFeedReadRequest {
  feed_key: string;
  /** Feed + connection config. Structured filters only — never SQL. */
  config: Record<string, unknown>;
  /** Optional source-native filter/search expression. */
  query?: string;
  /** Optional source-native continuation token. */
  cursor?: string;
  limit: number;
  offset: number;
  /**
   * Requested ordering, or null for the connector's declared default. A device
   * that cannot honour the named column MUST fail the run rather than silently
   * return a different order.
   */
  sort: { column: string; order: 'asc' | 'desc' } | null;
}

/**
 * True when the org's selected active definition is a METADATA-ONLY native
 * device connector — the only shape this seam can serve.
 *
 * `runtime != null` alone is not that signal. `connector_definitions.runtime`
 * is descriptive metadata (platforms, nix inputs); a perfectly ordinary
 * compiled connector may carry it and must keep using the compiled source-read
 * path. What makes a connector unservable by that path is the absence of
 * a bundle: `resolveConnectorCodeForKey` throws, and there is nothing to run.
 *
 * So the discriminator is the conjunction: runtime metadata AND no compiled
 * code for the selected version. Pinning is NOT part of it — a pin says which
 * machine executes, not whether server-side code exists.
 */
export function isMetadataOnlyDeviceConnector(
  runtime: unknown,
  hasCompiledCode: boolean
): boolean {
  return runtime != null && !hasCompiledCode;
}

/** Clamp a caller-supplied row window into the device read budget. */
export function clampDeviceFeedReadWindow(limit?: number, offset?: number): {
  limit: number;
  offset: number;
} {
  const rawLimit = Number.isFinite(limit) ? Number(limit) : DEVICE_FEED_READ_DEFAULT_LIMIT;
  const rawOffset = Number.isFinite(offset) ? Number(offset) : 0;
  return {
    limit: Math.max(1, Math.min(DEVICE_FEED_READ_MAX_LIMIT, Math.floor(rawLimit))),
    offset: Math.max(0, Math.min(DEVICE_FEED_READ_MAX_OFFSET, Math.floor(rawOffset))),
  };
}

/**
 * Normalize whatever the device POSTed into the source-feed read shape.
 *
 * A device is an untrusted-shape producer here: `runs.action_output` is
 * arbitrary JSON. Anything that isn't `{ rows: object[] }` is a protocol
 * violation and throws, so a malformed device reply surfaces as an error
 * instead of an empty result the caller reads as "no messages".
 */
export function normalizeDeviceFeedReadOutput(output: unknown): DeviceFeedReadResult {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('device returned a malformed feed-read result (expected an object)');
  }
  const record = output as Record<string, unknown>;
  if (!Array.isArray(record.rows)) {
    throw new Error('device returned a malformed feed-read result (missing `rows` array)');
  }
  const rows = record.rows.map((row, index) => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`device returned a malformed feed-read row at index ${index}`);
    }
    return row as Record<string, unknown>;
  });
  const columns = Array.isArray(record.columns)
    ? record.columns.flatMap((column) => {
        if (column == null || typeof column !== 'object' || Array.isArray(column)) return [];
        const { name, type } = column as { name?: unknown; type?: unknown };
        if (typeof name !== 'string' || name.length === 0) return [];
        return [{ name, type: typeof type === 'string' && type ? type : 'text' }];
      })
    : [];
  const total = typeof record.total === 'number' && Number.isFinite(record.total)
    ? record.total
    : undefined;
  const nextCursor = typeof record.nextCursor === 'string' && record.nextCursor
    ? record.nextCursor
    : undefined;
  const hasMore = typeof record.hasMore === 'boolean' ? record.hasMore : undefined;
  return { rows, columns, total, nextCursor, hasMore };
}

/**
 * Pre-flight the device BEFORE enqueueing. Without this a read against a
 * sleeping Mac parks a run for the full queue budget and then reports a
 * timeout — 60s to say something the server already knew. Returns null when a
 * device can plausibly serve the read.
 */
async function describeUnservableDevice(
  p: DeviceFeedReadParams
): Promise<string | null> {
  const sql = getDb();
  const readinessIndex = await loadDeviceConnectorReadiness({
    sql,
    targets: [
      {
        ownerUserId: p.deviceOwnerUserId,
        connectorKey: p.connectorKey,
        connectorVersion: p.connectorVersion,
        manifestHash: p.manifestHash,
        deviceWorkerId: p.deviceWorkerId,
      },
    ],
  });
  const connectorReadiness = findDeviceConnectorReadiness(readinessIndex, {
    ownerUserId: p.deviceOwnerUserId,
    connectorKey: p.connectorKey,
    connectorVersion: p.connectorVersion,
    manifestHash: p.manifestHash,
    deviceWorkerId: p.deviceWorkerId,
  });
  if (connectorReadiness?.state === 'setup_required') {
    throw new ToolError(
      'PERMISSION',
      `Live read of feed '${p.feedKey}' requires setup. ${describeDeviceConnectorSetupRequired(
        connectorReadiness
      )}`
    );
  }
  // A selected hash absent from the inventory is unavailable. Prefer the
  // specific pin, heartbeat, and permission diagnostics below when present.
  const manifestError =
    connectorReadiness?.state === 'device_offline' ||
    (!connectorReadiness && p.manifestHash != null)
      ? DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE
      : null;

  if (p.deviceWorkerId) {
    // Reached THROUGH the connection, not by device id alone. The id comes off
    // a row this caller may not own end-to-end, and the diagnostic below quotes
    // the device's label and last-poll time — a corrupt or cross-org
    // `device_worker_id` would otherwise report another tenant's machine back
    // to this org in an error string. Joining through the connection means we
    // can only ever describe the device this org's own connection pins.
    //
    // Deliberately NOT `dw.organization_id = p.organizationId`: that column is
    // the device's HOME org, and poll.ts supports a device pinned into a second
    // org. Fencing on it would break a legitimate cross-org pin.
    const rows = (await sql`
      SELECT dw.label, dw.last_seen_at, dw.capabilities,
             dw.last_seen_at > now() - ${`${DEVICE_ONLINE_WINDOW_SECONDS} seconds`}::interval AS online
      FROM connections c
      JOIN device_workers dw ON dw.id = c.device_worker_id
      WHERE c.id = ${p.connectionId}
        AND c.organization_id = ${p.organizationId}
        AND dw.id = ${p.deviceWorkerId}::uuid
      LIMIT 1
    `) as Array<{
      label: string | null;
      last_seen_at: Date | string | null;
      capabilities: unknown;
      online: boolean;
    }>;
    const device = rows[0];
    const name = device?.label ? `device "${device.label}"` : 'the paired device';
    if (!device) return 'the connection is pinned to a device this workspace cannot reach';
    if (!device.online) return `${name} is offline (${describeDeviceLastSeen(device.last_seen_at)})`;
    const capabilities = Array.isArray(device.capabilities) ? (device.capabilities as string[]) : [];
    if (p.requiredCapability && !capabilities.includes(p.requiredCapability)) {
      return `${name} no longer grants '${p.requiredCapability}'`;
    }
    return manifestError;
  }

  // Unpinned. The question is which org a device may serve WITHOUT a pin, and
  // it is narrower than "an org the owner belongs to".
  //
  // poll.ts branch 1B gates the unpinned claim on `baseOrgScopeIds` — the
  // worker TOKEN's bound org plus the owner's personal org. Only one of those
  // two is derivable here: no token has been presented at preflight time, so
  // the bound org is unknowable. Joining `member` instead would NOT mirror
  // `baseOrgScopeIds`; it is strictly wider. A device owner can belong to many
  // team orgs while their token is bound to none of them, and this preflight
  // would then report "servable" for a run branch 1B will never claim — trading
  // an instant, actionable error for a 60-second queue timeout.
  //
  // So the durable lane is the personal org: a device is automatically servable
  // in the org its owner's account IS. Read from
  // `organization.metadata->>'personal_org_for_user_id'` rather than
  // `device_workers.organization_id`, which is set once at pairing and goes
  // stale the moment the device is re-anchored.
  //
  // A shared org with no pin is refused with the fix, not a diagnosis: pinning
  // the connection is what makes it servable, and the pinned branch above
  // already supports that across home orgs.
  const [target] = (await sql`
    SELECT CASE
             WHEN o.metadata IS NULL THEN NULL
             ELSE (o.metadata::jsonb)->>'personal_org_for_user_id'
           END AS personal_owner_user_id
    FROM connections c
    JOIN "organization" o ON o.id = c.organization_id
    WHERE c.id = ${p.connectionId}
      AND c.organization_id = ${p.organizationId}
    LIMIT 1
  `) as Array<{ personal_owner_user_id: string | null }>;
  if (!target) return 'the connection is not visible to this workspace';
  if (!target.personal_owner_user_id) {
    return (
      'this connection is not pinned to a device — pin it to the device that should serve it, ' +
      'because only a personal workspace serves an unpinned device connection automatically'
    );
  }

  const rows = (await sql`
    SELECT 1
    FROM device_workers dw
    WHERE dw.user_id = ${target.personal_owner_user_id}
      AND dw.last_seen_at > now() - ${`${DEVICE_ONLINE_WINDOW_SECONDS} seconds`}::interval
      AND (
        ${p.requiredCapability}::text IS NULL
        OR dw.capabilities @> ${sql.json([p.requiredCapability ?? ''])}
      )
    LIMIT 1
  `) as Array<unknown>;
  if (rows.length === 0) {
    return p.requiredCapability
      ? `no online device is serving '${p.requiredCapability}'`
      : 'no online device can serve this connection';
  }
  return manifestError;
}

/**
 * Read a device-backed feed at its source. Throws with an actionable message on
 * offline / timeout / device-reported error; never returns a partial result.
 */
export async function readDeviceFeed(
  p: DeviceFeedReadParams
): Promise<DeviceFeedReadResult> {
  const unservable = await describeUnservableDevice(p);
  if (unservable) {
    throw new Error(
      `Live read of feed '${p.feedKey}' is unavailable: ${unservable}. ` +
        'Open the paired device app and try again.'
    );
  }
  if (p.feedStatus !== 'active') {
    throw new ToolError(
      'VALIDATION',
      `Feed '${p.feedKey}' is ${p.feedStatus}; resume it before reading from its source.`
    );
  }

  // The preflight is two DB round-trips against a laptop-liveness window. A
  // tightly-bounded read can genuinely spend its deadline in there, and
  // enqueueing after that creates a transport run whose only future is to be
  // cancelled — a row holding the caller's query, briefly claimable, for a read
  // nobody is waiting on. Check here, where the cheapest correct answer is to
  // not start.
  if (p.signal?.aborted) {
    throw new Error(
      `Live read of feed '${p.feedKey}' was cut short by the caller's read deadline ` +
        'before the request reached the paired device.'
    );
  }

  const { limit, offset } = clampDeviceFeedReadWindow(p.limit, p.offset);
  const request: DeviceFeedReadRequest = {
    feed_key: p.feedKey,
    config: p.feedConfig,
    ...(p.query?.trim() ? { query: p.query.trim() } : {}),
    ...(p.cursor ? { cursor: p.cursor } : {}),
    limit,
    offset,
    sort: p.sort ?? null,
  };

  const run = await createConnectorOperationRun({
    organizationId: p.organizationId,
    connectionId: p.connectionId,
    connectorKey: p.connectorKey,
    operationKey: DEVICE_FEED_READ_ACTION_KEY,
    operationInput: request as unknown as Record<string, unknown>,
    approvalMode: 'device',
    // Metadata-only device connectors have no compiled bundle by construction.
    requireCompiledCode: false,
  });

  // The run row is the TRANSPORT, not a record. `complete-action` persists the
  // device's rows into `runs.action_output`, and `action_input` holds the
  // caller's query and filters — both would then sit in Postgres for the
  // run-retention window, violating the source-read contract's no-copy
  // guarantee.
  //
  // The WAIT is inside the try on purpose. Scrubbing only after it returns
  // leaves the payload behind on the path where it never returns at all — a
  // dropped connection or a query error inside the poll loop throws, and the
  // run row keeps a full page of the user's WhatsApp messages. Every path from
  // the INSERT onward has to reach the cleanup.
  //
  // The cleanup also TERMINALIZES a run that is still in flight. Blanking the
  // payload alone is not enough on the throw path: the run can still be
  // pending, a device can claim it after the blanking, and `complete-action`
  // would write a fresh page of messages back into the row we just cleared.
  // Marking it `timeout` in the same statement closes that window —
  // `finalizeRun` only transitions a `running` run claimed by the poster, so a
  // late completion becomes a no-op.
  try {
    return deliver(p, await deviceActionWaiter(run.runId, p.organizationId, p.signal));
  } finally {
    await scrubFeedReadRunPayload(run.runId, p.organizationId, p.feedKey);
  }
}

/** Statuses from which a source-read run can still be claimed or completed. */
const NON_TERMINAL_RUN_STATUSES = ['pending', 'claimed', 'running'] as const;

/**
 * Blank the caller's filters and the device's rows off a source-feed run, and
 * close it if it is still in flight. The run row itself survives as the audit
 * trail that a source read happened, with no trace of what was read.
 *
 * One statement, so scrubbing and terminalizing cannot interleave with a device
 * claiming the run. An ALREADY-terminal run keeps its status, outcome, and
 * timing untouched — the read's verdict is the caller's to report, not this
 * cleanup's to overwrite.
 *
 * Fenced to the reserved action key (plus org + run id) so it can never touch a
 * real operation's output. Never throws — failing to scrub must be logged, not
 * turned into a failed read the caller retries, which would only create another
 * unscrubbed run.
 */
async function scrubFeedReadRunPayload(
  runId: number,
  organizationId: string,
  feedKey: string
): Promise<void> {
  const sql = getDb();
  const inFlight = pgTextArray([...NON_TERMINAL_RUN_STATUSES]);
  try {
    await sql`
      UPDATE runs
      SET action_output = NULL,
          action_input = ${sql.json({ scrubbed: true, feed_key: feedKey })},
          status = CASE WHEN status = ANY(${inFlight}::text[]) THEN 'timeout' ELSE status END,
          outcome = CASE
            WHEN status = ANY(${inFlight}::text[])
              THEN ${classifyRunOutcome({ status: 'timeout' })}
            ELSE outcome
          END,
          completed_at = CASE
            WHEN status = ANY(${inFlight}::text[]) THEN current_timestamp
            ELSE completed_at
          END,
          error_message = CASE
            WHEN status = ANY(${inFlight}::text[])
              THEN ${`Feed '${feedKey}' source read was abandoned before the device answered.`}
            ELSE error_message
          END
      WHERE id = ${runId}
        AND organization_id = ${organizationId}
        AND run_type = 'action'
        AND action_key = ${DEVICE_FEED_READ_ACTION_KEY}
    `;
  } catch (err) {
    logger.error(
      { runId, organizationId, feedKey, err: err instanceof Error ? err.message : String(err) },
      '[device-feed-read] failed to scrub source-read payload off the run row'
    );
  }
}

/**
 * Turn a finished device action into the caller's result, or an error. Exported
 * for test: short of an aborted wait, the timeout branch is otherwise only
 * reachable after a full queue budget has elapsed.
 */
export function deliver(
  p: DeviceFeedReadParams,
  outcome: Awaited<ReturnType<typeof waitForDeviceActionRun>>
): DeviceFeedReadResult {
  if (outcome.status === 'timeout') {
    // An ABORTED wait is not a device timeout, and must not be reported as one:
    // the device may be perfectly healthy and simply slower than the deadline
    // this particular caller could afford. Reporting a queue budget here would
    // send the reader off diagnosing a device that was never given one.
    if (p.signal?.aborted) {
      throw new Error(
        `Live read of feed '${p.feedKey}' was cut short by the caller's read deadline ` +
          'before the paired device answered.'
      );
    }
    // No duration is quoted here: `waitForDeviceActionRun` already names the
    // phase-specific budget in `error_message` (60s pre-claim; post-claim is
    // 95s unless the action declares a longer timeout), and this caller cannot
    // tell which phase it lost. Quoting the 60s queue budget would mislabel a
    // run a device CLAIMED and then hung on as a 60s timeout when it actually
    // waited out the whole post-claim budget.
    throw new Error(
      `Live read of feed '${p.feedKey}' timed out: ${
        outcome.error_message ?? 'the paired device did not respond'
      }`
    );
  }
  if (outcome.status === 'failed') {
    throw new Error(
      `Live read of feed '${p.feedKey}' failed on the paired device: ${
        outcome.error_message ?? 'unknown device error'
      }`
    );
  }

  const result = normalizeDeviceFeedReadOutput(outcome.output);
  logger.debug(
    {
      feedId: p.feedId,
      feedKey: p.feedKey,
      connectorKey: p.connectorKey,
      rows: result.rows.length,
    },
    '[device-feed-read] source read served by paired device'
  );
  return result;
}
