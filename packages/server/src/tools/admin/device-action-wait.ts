/**
 * Wait for a device-bound action run (approval_mode='device') to finish.
 *
 * Extracted from manage_operations so dispatch-chrome-action can await device
 * completion without importing the full manage_operations module (breaks a
 * circular init cycle: manage_operations → dispatch-chrome-action →
 * manage_operations that left MANAGE_AUTOMATIONS_ACTION_KEY / manageAutomations in
 * TDZ and red-failed CI unit on main).
 */

import { DEVICE_ACTION_QUEUE_BUDGET_MS } from '../../config/intervals';
import { type DbClient, getDb } from '../../db/client';
import { classifyRunOutcome } from '../../runs/run-outcome';
import { supersedeActionEvent } from './approval-events';
import { describeDeviceLastSeen } from '../../utils/device-liveness';

/**
 * How long the device pinned to this run's connection has been silent.
 * Runs only on the pre-claim timeout path, so the extra round-trip costs
 * nothing on the happy path. Never throws: a diagnostic that can fail the
 * operation it is diagnosing is worse than no diagnostic.
 */
export async function describeRunDeviceLastSeen(
  runId: number,
  organizationId: string
): Promise<string> {
  try {
    const rows = (await getDb()`
      SELECT dw.label, dw.last_seen_at
      FROM runs r
      JOIN connections c ON c.id = r.connection_id
      JOIN device_workers dw ON dw.id = c.device_worker_id
      WHERE r.id = ${runId} AND r.organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{ label: string | null; last_seen_at: Date | string | null }>;
    const row = rows[0];
    if (!row) return 'run has no paired device';
    const age = describeDeviceLastSeen(row.last_seen_at);
    return row.label ? `device "${row.label}" ${age}` : `device ${age}`;
  } catch {
    return 'device liveness unavailable';
  }
}

/**
 * Sleep between polls, but wake IMMEDIATELY on abort.
 *
 * A plain `setTimeout` would hold an aborted wait for the rest of the poll
 * interval before the loop noticed, and the caller's run stays in flight —
 * claimable, and still holding its payload — for that whole window. Callers
 * with a short deadline (an explicit `read_feeds` source read) measure their
 * budget in a handful of poll intervals, so "up to 500ms late" is a meaningful
 * share of it.
 *
 * The listener is always removed: this runs once per poll for the life of the
 * wait, and a signal that outlives the loop would otherwise accumulate them.
 */
async function sleepUnlessAborted(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (abortSignal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    abortSignal.addEventListener('abort', done, { once: true });
  });
}

// Deadline strategy: two phases.
//
//   - PRE-CLAIM (status='pending'): how long the device has to even
//     pick the run up. The chrome extension polls /poll every 5s; we
//     allow up to the shared device-action queue budget for it to arrive.
//
//   - POST-CLAIM (status='running'): how long the device has to
//     execute, after it claimed the run. The default matches the chrome
//     extension's own per-run watchdog (background.js RUN_TIMEOUT_MS=90s)
//     plus a buffer, so the gateway never times out a legitimately-running
//     tool.
//     An action whose declared input schema bounds a `timeout_ms` budget (a
//     shell command, for one) is allowed the run's requested value, clamped
//     to that declared maximum, plus a completion grace: by contract the
//     device is still executing well past the watchdog, and a flat 95s here
//     terminalized those runs while the device was mid-command, so their
//     output was lost. The caller's abort signal bounds the whole wait
//     regardless of either budget.
//
// Without the two-phase split, a slow poll cycle (worker offline for
// 20-30s) could exhaust a flat-100s deadline before the worker even
// claimed the run, marking it timeout while the worker was about to
// pick it up.
const POST_CLAIM_BUDGET_MS = 95_000; // extension's 90s watchdog + 5s buffer
// After the requested budget elapses the device still has to tear the process
// group down (SIGTERM grace, reaping) and deliver the terminal result.
const ACTION_COMPLETION_GRACE_MS = 30_000;
// Hard ceiling on any derived budget. `timeout_ms.maximum` is declared by a
// connector definition an organization can install, so it is tenant input, not
// a platform constant: without this a definition declaring `maximum: 86400000`
// would hold a gateway request open for a day. 180s is the wall-clock ceiling
// the rest of the product already enforces (`MAX_SCRIPT_TIMEOUT_MS`), and the
// shipped shell contract's 150s maximum plus completion grace lands exactly on
// it, so nothing legitimate is clipped today.
const MAX_POST_CLAIM_BUDGET_MS = 180_000;
const POLL_MS = 500;

/**
 * Post-claim budget for one run, read ONCE before polling: `action_input` is
 * immutable after creation and can be large (a shell action's stdin runs to a
 * megabyte), so it has no business in the 500ms poll.
 *
 * The action's declared input schema is the contract. When it bounds
 * `timeout_ms` with a `maximum`, the device has committed to executing for up
 * to that long, so the wait honors the run's requested value — clamped to the
 * declared maximum, which is also what input validation enforced at creation —
 * plus completion grace. A requested value under an action that declares no
 * maximum is ignored, and a run whose definition no longer resolves keeps the
 * default. Only a JSON number counts as a request; a string "150000" or a
 * fractional value is not a budget. The default is a floor, never a ceiling: a
 * request SHORTER than it leaves the wait as it was, since a device that gives
 * up early reports the failure itself. A declared maximum is tenant input, so
 * the result is capped at {@link MAX_POST_CLAIM_BUDGET_MS} however large the
 * definition claims its action may run.
 */
async function resolvePostClaimBudgetMs(
  sql: DbClient,
  runId: number,
  organizationId: string,
  defaultMs: number
): Promise<number> {
  const rows = (await sql`
    SELECT
      CASE
        WHEN jsonb_typeof(r.action_input->'timeout_ms') = 'number'
          THEN r.action_input->>'timeout_ms'
      END AS requested,
      COALESCE(
        def.actions_schema->r.action_key->'input_schema',
        def.actions_schema->r.action_key->'inputSchema'
      )->'properties'->'timeout_ms'->>'maximum' AS declared_max
    FROM runs r
    LEFT JOIN LATERAL (
      SELECT cd.actions_schema
      FROM connector_definitions cd
      WHERE cd.organization_id = r.organization_id
        AND cd.key = r.connector_key
        AND cd.status = 'active'
        AND (r.connector_version IS NULL OR cd.version = r.connector_version)
      ORDER BY cd.updated_at DESC, cd.id DESC
      LIMIT 1
    ) def ON true
    WHERE r.id = ${runId} AND r.organization_id = ${organizationId}
    LIMIT 1
  `) as Array<{ requested: string | null; declared_max: string | null }>;
  const requested = positiveIntegerMs(rows[0]?.requested);
  const declaredMax = positiveIntegerMs(rows[0]?.declared_max);
  if (requested == null || declaredMax == null) return defaultMs;
  const declared = Math.min(requested, declaredMax) + ACTION_COMPLETION_GRACE_MS;
  return Math.max(defaultMs, Math.min(declared, MAX_POST_CLAIM_BUDGET_MS));
}

/** `->>` renders a JSON number as its literal text; anything else is not a budget. */
function positiveIntegerMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface DeviceActionRunOutcome {
  status: 'completed' | 'failed' | 'timeout';
  // `action_output` is arbitrary connector/device JSON — object, array, or
  // scalar — so the completed output is `unknown`, not an object.
  output?: unknown;
  error_message?: string;
}

interface WaitForDeviceActionRunOptions {
  queueMs: number;
  /**
   * Default post-claim budget. An action whose declared schema bounds a
   * `timeout_ms` budget may extend it; see {@link resolvePostClaimBudgetMs}.
   */
  postClaimMs: number;
  pollMs: number;
  /** Clock the deadlines are measured against. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Poll delay. Defaults to an abort-aware sleep over `abortSignal`; a
   * replacement is responsible for its own abort handling.
   */
  sleep?: (ms: number) => Promise<void>;
  abortSignal?: AbortSignal;
}

export function waitForDeviceActionRun(
  runId: number,
  organizationId: string,
  /**
   * Abort the wait early (e.g. an automation reaction hit its wall-clock budget).
   * On abort we stop polling and finalize the run as `timeout` so the orphaned
   * poll loop and any in-flight device work don't leak past the caller.
   */
  abortSignal?: AbortSignal
): Promise<DeviceActionRunOutcome> {
  return waitForDeviceActionRunWithOptions(runId, organizationId, {
    queueMs: DEVICE_ACTION_QUEUE_BUDGET_MS,
    postClaimMs: POST_CLAIM_BUDGET_MS,
    pollMs: POLL_MS,
    abortSignal,
  });
}

/**
 * The waiter itself, with its budgets and timing boundary supplied by the
 * caller. Tests use it to shrink the budgets — and, for the phase switch, to
 * drive the clock — while running the same database reads and timeout
 * finalization as production. Runtime callers should use
 * {@link waitForDeviceActionRun}, which supplies the production budgets.
 */
export async function waitForDeviceActionRunWithOptions(
  runId: number,
  organizationId: string,
  options: WaitForDeviceActionRunOptions
): Promise<DeviceActionRunOutcome> {
  const sql = getDb();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => sleepUnlessAborted(ms, options.abortSignal));
  const queueDeadline = now() + options.queueMs;
  let claimedAtMs: number | null = null;
  const postClaimMs = await resolvePostClaimBudgetMs(
    sql,
    runId,
    organizationId,
    options.postClaimMs
  );

  while (true) {
    const rows = (await sql`
      SELECT status, action_output, error_message, claimed_at
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: unknown;
      error_message: string | null;
      claimed_at: Date | string | null;
    }>;
    const row = rows[0];
    if (!row) {
      return {
        status: 'failed',
        error_message: `Run ${runId} disappeared from runs table while waiting.`,
      };
    }
    if (row.status === 'completed') {
      return {
        status: 'completed',
        output: row.action_output ?? {},
      };
    }
    if (row.status === 'failed' || row.status === 'timeout') {
      return {
        status: row.status as 'failed' | 'timeout',
        error_message: row.error_message ?? `Run ${runId} ${row.status}`,
      };
    }
    // Still pending or running. Check the right deadline for this phase.
    if (row.claimed_at && claimedAtMs == null) {
      claimedAtMs =
        row.claimed_at instanceof Date
          ? row.claimed_at.getTime()
          : new Date(row.claimed_at).getTime();
    }
    // Caller aborted (e.g. reaction timeout) — stop polling and let the
    // timeout finalization below mark the run, so we don't leak this loop.
    if (options.abortSignal?.aborted) break;
    const currentTimeMs = now();
    if (claimedAtMs != null) {
      if (currentTimeMs - claimedAtMs >= postClaimMs) break;
    } else {
      if (currentTimeMs >= queueDeadline) break;
    }
    await sleep(options.pollMs);
  }

  // Which phase timed out decides what the operator needs to hear. A run that
  // was never CLAIMED failed because no device asked for it, and the server
  // knows exactly how long that device has been quiet — say so instead of
  // "the device may be offline", which sends the reader looking for a fault
  // that is already measured here. A run that WAS claimed died mid-execution
  // on the device, where last_seen tells you nothing.
  // Looked up ONCE and used for both the stored `runs.error_message` and the
  // string returned to the caller below — those are two different readers of
  // the same failure and both used to say "may be offline".
  const deviceDiagnostic =
    claimedAtMs != null
      ? null
      : await describeRunDeviceLastSeen(runId, organizationId);
  const timeoutMessage =
    deviceDiagnostic == null
      ? 'waitForDeviceActionRun: device claimed the run but did not complete in time'
      : `waitForDeviceActionRun: no device claimed the run within ${Math.round(
          options.queueMs / 1000
        )}s (${deviceDiagnostic})`;

  // Atomic timeout finalization, with the operation card supersede in the SAME
  // transaction: a gateway-side timeout is the run's terminal state, and the
  // ledger must not keep showing it as dispatched. The WHERE clause matches
  // only non-terminal states; if the worker raced us and posted completion
  // between our last SELECT and this UPDATE, this UPDATE is a no-op and we
  // re-read the row to surface the worker's verdict. No fail-closed card guard
  // here, unlike the approval-gated writers in worker-api: every caller of this
  // waiter dispatches an auto run, and an auto run created before the dispatch
  // card existed has none and must still reach a terminal state.
  const updated = (await sql.begin(async (tx) => {
    const rows = (await tx`
      UPDATE runs
      SET status = 'timeout',
          outcome = ${classifyRunOutcome({ status: 'timeout' })},
          completed_at = current_timestamp,
          error_message = ${timeoutMessage}
      WHERE id = ${runId}
        AND organization_id = ${organizationId}
        AND status IN ('pending', 'running')
      RETURNING id, action_key
    `) as Array<{ id: number; action_key: string | null }>;
    if (rows.length === 0) return rows;
    const actionKey = rows[0].action_key ?? 'Operation';
    await supersedeActionEvent(
      runId,
      organizationId,
      'failed',
      `${actionKey} — timed out`,
      `Operation timed out: ${actionKey} — ${timeoutMessage}`,
      { error_message: timeoutMessage, run_status: 'timeout' },
      null,
      tx
    );
    return rows;
  })) as Array<{ id: number }>;

  if (updated.length === 0) {
    // Worker won the race. Re-read to return whatever it actually said.
    const finalRows = (await sql`
      SELECT status, action_output, error_message
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: Record<string, unknown> | null;
      error_message: string | null;
    }>;
    const final = finalRows[0];
    if (final?.status === 'completed') {
      return {
        status: 'completed',
        output: (final.action_output ?? {}) as Record<string, unknown>,
      };
    }
    if (final?.status === 'failed') {
      return {
        status: 'failed',
        error_message: final.error_message ?? `Run ${runId} failed`,
      };
    }
    // Shouldn't reach here, but fall through to timeout.
  }

  return {
    status: 'timeout',
    error_message:
      deviceDiagnostic == null
        ? `Run ${runId} claimed but the device worker didn't finish within ${postClaimMs}ms.`
        : `Run ${runId} was never claimed within ${options.queueMs}ms — ${deviceDiagnostic}.`,
  };
}
