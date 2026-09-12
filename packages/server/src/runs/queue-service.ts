/**
 * Run Utilities
 *
 * Centralized functions for run operations including:
 * - Sync run creation
 * - Action run creation
 * - JSON utilities for duplicate detection
 */

import { randomUUID } from 'node:crypto';
import type { BrowserActionContext } from '../worker-api/browser-action-context';

import { type DbClient, parsePgTextArray, pgTextArray } from '../db/client';
import {
  resolvedEventExecution,
  type AutomationEventTrigger,
  type AutomationWorkspaceEventTrigger,
} from '@lobu/core/contracts/tools/manage-automations';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import {
  claimAutomationCooldown,
  lockAutomationForActivation,
} from '../automations/cooldown';
import {
  MAX_COALESCED_AUTOMATION_EVENT_INPUTS,
  MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS,
  automationTriggerSignals,
  isWorkspaceEventTriggerSignal,
  type WorkspaceEventTriggerSignal,
} from '../automations/workspace-event-contract';
import { getDb } from '../db/client';
import { DEVICE_ACTION_QUEUE_BUDGET_MS } from '../config/intervals';
import type { Env } from '../index';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import {
  describeMissingBrowserExecutionPin,
  hashlessManifestArtifactMayBeClaimed,
  selectedConnectorVersionArtifactSql,
} from '../utils/connector-execution-placement';
import {
  DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE,
  describeDeviceConnectorSetupRequired,
  findDeviceConnectorReadiness,
  loadDeviceConnectorReadiness,
} from '../worker-api/device-connector-readiness';
import { nextRunAt as nextRunAtFromCron } from '../utils/cron';
import { ToolUserError } from '../utils/errors';
import { stableJson } from '../utils/insert-event';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { normalizePageActivationUrls } from './page-activation';
import { AUTOMATION_RUN_TYPES_PG } from "./run-types.js";

import { notifyWorkerWork } from './worker-wakeup';

type AutomationDispatchSource = 'scheduled' | 'manual' | 'event';
export type AutomationActivationTrigger =
  | AutomationEventTrigger
  | AutomationWorkspaceEventTrigger;
export type AutomationActivationSignal =
  | ConnectorTriggerSignal
  | WorkspaceEventTriggerSignal;

export interface AutomationRunPayload {
  automation_id: number;
  /**
   * The managed agent executing this run. Absent for device-executed runs
   * (the device lane claims via `device_worker_id`) and for manual runs open
   * to any connected MCP client.
   */
  agent_id?: string;
  window_start: string;
  window_end: string;
  dispatch_source: AutomationDispatchSource;
  /**
   * Snapshot of the automation's `current_version_id` at run-creation time.
   * The agent and `complete_window` use this fixed version for the entire
   * extraction lifecycle so a mid-run group edit cannot validate v1's output
   * against v2's schema.
   */
  version_id: number | null;
  /**
   * When non-null, the automation is pinned to a user-owned device worker.
   * The server-side dispatcher (`packages/server/src/automations/automation.ts`)
   * MUST refuse to claim such rows — they are claimed exclusively by the
   * matching device worker via `/api/workers/poll`. Mirrors the
   * `connections.device_worker_id` lane that the worker poll already
   * supports for sync runs.
   */
  device_worker_id?: string | null;
  /**
   * Hint to the device-side dispatcher (Owletto Mac app, etc.) for which
   * local CLI executor to spawn (e.g. `claude-code`, `codex`, `gemini`).
   * Free-form string. Empty / null means "use the device's configured
   * default agent".
   */
  agent_kind?: string | null;
  /** Present for event activations; each signal points at already-durable input. */
  trigger_signal?: AutomationActivationSignal;
  /** Coalesced deliveries waiting in this run, including trigger_signal. */
  trigger_signals?: AutomationActivationSignal[];
  delivery_ids?: string[];
  trigger_execution?: 'turn' | 'window';
  trigger_output?: 'silent' | 'reply_to_source';
  trigger_key?: string;
  source_fingerprint?: string;
}

function automationEventTriggerKey(trigger: AutomationActivationTrigger): string {
  if (trigger.source === 'workspace') {
    return stableJson({
      kind: trigger.kind,
      source: trigger.source,
      entity_type: trigger.entity_type ?? null,
      event_types: [...trigger.event_types].sort(),
      match: trigger.match ?? null,
      execution: resolvedEventExecution(trigger),
      active_run: trigger.active_run ?? 'coalesce',
    });
  }
  return stableJson({
    kind: 'event',
    connector_key: trigger.connector_key,
    connection_id: trigger.connection_id ?? null,
    event_types: [...trigger.event_types].sort(),
    match: trigger.match ?? null,
    execution: resolvedEventExecution(trigger),
    active_run: trigger.active_run ?? 'queue',
    output: trigger.output ?? 'silent',
    skip_if_unchanged: trigger.skip_if_unchanged ?? true,
  });
}

const AUTOMATION_EXECUTION_UNIQUE_INDEX = 'idx_runs_executing_per_automation';

/**
 * Claim one pending Automation run while holding the durable per-Automation row
 * lock. Both the server dispatcher and device poller use this transition so
 * replicas cannot promote different queued runs from the same Automation at the
 * same time.
 */
export async function claimPendingAutomationRun(
  tx: DbClient,
  params: {
    runId: number;
    automationId: number;
    claimedBy: string;
    status: 'claimed' | 'running';
    expiresAt?: Date | null;
    executedByDeviceWorkerId?: string | null;
  }
): Promise<boolean> {
  const automation = await tx`
    SELECT id
    FROM automations
    WHERE id = ${params.automationId}
    FOR UPDATE SKIP LOCKED
  `;
  if (automation.length === 0) return false;

  try {
    const claimed = await tx.savepoint(
      async (sp) => sp`
        UPDATE runs r
        SET status = ${params.status},
            claimed_at = current_timestamp,
            last_heartbeat_at = CASE
              WHEN ${params.status}::text = 'running' THEN current_timestamp
              ELSE r.last_heartbeat_at
            END,
            claimed_by = ${params.claimedBy},
            executed_by_device_worker_id = COALESCE(${params.executedByDeviceWorkerId ?? null}::uuid, r.executed_by_device_worker_id),
            expires_at = ${params.expiresAt?.toISOString() ?? null}::timestamptz
        WHERE r.id = ${params.runId}
          AND r.automation_id = ${params.automationId}
          AND r.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
          AND r.status = 'pending'
          -- Same-type guard, deliberately not widened to both run types: one
          -- Automation at a time per Automation, and one eval at a time per
          -- Automation, but an eval replay must never be blocked by (or block)
          -- the real run it is replaying.
          AND NOT EXISTS (
            SELECT 1
            FROM runs active
            WHERE active.automation_id = r.automation_id
              AND active.run_type = r.run_type
              AND active.status IN ('claimed', 'running')
          )
        RETURNING r.id
      `
    );
    return claimed.length > 0;
  } catch (error) {
    // During a rolling deployment an older replica may still claim without
    // taking the automation row lock. The unique index remains authoritative;
    // contain that expected contention inside the savepoint and skip the run.
    if (isUniqueViolation(error, AUTOMATION_EXECUTION_UNIQUE_INDEX)) return false;
    throw error;
  }
}

// ============================================
// Run Management
// ============================================

/**
 * A feed whose connector can't be resolved to runnable code is an orphan: the
 * connector was archived/uninstalled, or its version was registered without
 * compiled code and has no bundled source to compile on demand. Soft-delete it
 * in-place so it stops appearing in CheckDueFeeds — a warn + return null would
 * repeat at the same cadence forever (~1/min), and a large enough orphan set
 * fills the CheckDueFeeds LIMIT 100 and starves legitimate feeds. Operators
 * recover by registering connector code and clearing `deleted_at`.
 */
async function softDeleteOrphanFeed(
  sql: DbClient,
  feedId: number,
  feed: { connector_key: string; organization_id: string },
  reason: string
): Promise<void> {
  await sql`
    UPDATE feeds
    SET deleted_at = current_timestamp
    WHERE id = ${feedId}
  `;
  logger.warn(
    { feedId, connector_key: feed.connector_key, organization_id: feed.organization_id },
    `[queue] Soft-deleted orphan feed — ${reason}`
  );
}

/**
 * Resolve the active connector version (pinned_version → newest active
 * connector_definition) and, when `requireRunnable`, verify the
 * connector_versions row has compiled_code OR a bundled source file on disk.
 * Returns a discriminated result so each caller maps the failure modes to its
 * own automation (sync soft-deletes the orphan feed; auth/action throw).
 */
type ConnectorVersionResolution =
  | { ok: true; version: string }
  | { ok: false; reason: 'no-definition' }
  | { ok: false; reason: 'no-version'; version: string }
  | { ok: false; reason: 'not-runnable'; version: string };

async function resolveActiveConnectorVersion(
  sql: DbClient,
  params: {
    orgId: string;
    connectorKey: string;
    requireRunnable: boolean;
    pinnedVersion?: string | null;
  }
): Promise<ConnectorVersionResolution> {
  let version: string;
  if (params.pinnedVersion) {
    version = params.pinnedVersion;
  } else {
    const defRows = await sql`
      SELECT version FROM connector_definitions
      WHERE key = ${params.connectorKey}
        AND organization_id = ${params.orgId}
        AND status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;
    if (defRows.length === 0) {
      return { ok: false, reason: 'no-definition' };
    }
    version = (defRows[0] as { version: string }).version;
  }

  // Presence of runnable code, never the bytes: an artifact bundle is
  // megabytes and nothing on this path needs its contents.
  const versionRows = await sql`
    SELECT (compiled_code IS NOT NULL) AS has_compiled_code, source_path
    FROM connector_versions
    WHERE connector_key = ${params.connectorKey} AND version = ${version}
      AND (organization_id = ${params.orgId} OR organization_id IS NULL)
    ORDER BY organization_id NULLS LAST
    LIMIT 1
  `;
  if (versionRows.length === 0) {
    // No stored artifact row at all. A runnable caller still needs one; a
    // caller that only needs the selected version (metadata-only operations,
    // device-executed connectors that ship no gateway-side artifact) keeps
    // working, and there are no organization-supplied bytes to admit.
    if (params.requireRunnable) return { ok: false, reason: 'no-version', version };
    return { ok: true, version };
  }
  const artifact = versionRows[0] as {
    has_compiled_code: boolean;
    source_path: string | null;
  };
  // Runnable if ANY runtime code source exists: stored compiled code, a
  // source_path the runtime can compile on demand, or a bundled connector
  // file. Union of all three so no run type (sync/auth/operation) regresses —
  // resolveConnectorCode() resolves from whichever is present at execution.
  if (
    params.requireRunnable &&
    !artifact.has_compiled_code &&
    !artifact.source_path &&
    !findBundledConnectorFile(params.connectorKey)
  ) {
    return { ok: false, reason: 'not-runnable', version };
  }
  return { ok: true, version };
}

/**
 * Reject an unavailable manifest on the exact execution pin before queuing.
 * Compiled artifacts bypass this check; native hashless artifacts retain capability claims.
 */
async function deviceManifestAdmissionError(
  sql: DbClient,
  organizationId: string,
  connectionId: number,
  connectorKey: string,
  connectorVersion: string,
  deviceWorkerId: string | null
): Promise<string | null> {
  const pinError = describeMissingBrowserExecutionPin(connectorKey, deviceWorkerId);
  if (pinError) return pinError;
  const [row] = await sql<{
    owner_user_id: string | null;
    manifest_hash: string | null;
    runtime: Record<string, unknown> | null;
  }>`
    SELECT COALESCE(c.created_by, dw.user_id) AS owner_user_id, cv.artifact_hash AS manifest_hash,
           cd.runtime
    FROM connections c
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    LEFT JOIN connector_definitions cd
      ON cd.organization_id = c.organization_id AND cd.key = c.connector_key
      AND cd.status = 'active'
    JOIN LATERAL (
      ${selectedConnectorVersionArtifactSql(sql, {
        connectorKey: sql`${connectorKey}`,
        version: sql`${connectorVersion}`,
        organizationId: sql`${organizationId}`,
      })}
    ) cv ON cv.manifest_backed
    WHERE c.id = ${connectionId} AND c.organization_id = ${organizationId}
    LIMIT 1
  `;
  if (!row) return null;
  if (row.manifest_hash == null) {
    return hashlessManifestArtifactMayBeClaimed(connectorKey, row.runtime)
      ? null : DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE;
  }
  const target = {
    ownerUserId: row.owner_user_id,
    connectorKey,
    connectorVersion,
    manifestHash: row.manifest_hash,
    deviceWorkerId,
  };
  const index = await loadDeviceConnectorReadiness({ sql, targets: [target] });
  const readiness = findDeviceConnectorReadiness(index, target);
  if (readiness?.state === 'ready') return null;
  return readiness?.state === 'setup_required'
    ? describeDeviceConnectorSetupRequired(readiness)
    : DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE;
}

/**
 * Why no sync run was queued. The reasons differ in remedy — `already_active`
 * resolves itself when the current run finishes, while the others never will
 * (the two connector reasons also retire the feed) — so callers that surface
 * a skip to a human must render the specific reason, not a catch-all.
 */
export type SyncRunSkipReason =
  | 'already_active'
  | 'feed_not_found'
  | 'sync_unsupported'
  | 'connector_uninstalled'
  | 'connector_version_unrunnable';

export type CreateSyncRunResult =
  | { ok: true; runId: number }
  | {
      ok: false;
      reason: SyncRunSkipReason;
    };

/**
 * Operator-facing sentence per cause. Kept beside the reasons so a new reason
 * cannot be added without deciding what a human should be told.
 */
export function describeSyncRunSkip(reason: SyncRunSkipReason): string {
  switch (reason) {
    case 'already_active':
      return 'Sync already pending or running for this feed';
    case 'feed_not_found':
      return 'Feed not found';
    case 'sync_unsupported':
      return 'This feed does not support sync';
    case 'connector_uninstalled':
      return 'The connector is no longer installed in this workspace; the feed has been retired';
    case 'connector_version_unrunnable':
      return 'The connector version has no runnable code; the feed has been retired';
  }
}

/**
 * Create a pending sync run for a feed (within an existing client/tx). Skips
 * with a `SyncRunSkipReason` instead of queueing when a run is already active,
 * the feed is missing or cloud-restricted, or the connector resolves to
 * nothing runnable — the connector cases also soft-delete the feed (see
 * softDeleteOrphanFeed).
 */
async function createSyncRunWithClient(
  sql: DbClient,
  feedId: number,
  dryRun = false
): Promise<CreateSyncRunResult> {
  // Check if there's already a pending/running run for this feed
  const existing = await sql`
    SELECT id FROM runs
    WHERE feed_id = ${feedId}
      AND run_type = 'sync'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    LIMIT 1
  `;

  if (existing.length > 0) {
    logger.info(
      `[queue] Skipping run creation for feed ${feedId} - already has pending/running run`
    );
    return { ok: false, reason: 'already_active' };
  }

  // Get feed details (including pinned_version)
  const feedRows = await sql`
    SELECT f.organization_id, f.connection_id, f.pinned_version, f.schedule, f.timezone,
           c.connector_key, c.device_worker_id,
           cd.definition_id,
           COALESCE(cd.feed_operations, '[]'::jsonb) AS feed_operations
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    LEFT JOIN LATERAL (
      SELECT connector_definitions.id AS definition_id,
             connector_definitions.feeds_schema -> f.feed_key -> 'operations' AS feed_operations
      FROM connector_definitions
      WHERE connector_definitions.key = c.connector_key
        AND connector_definitions.organization_id = f.organization_id
        AND (
          (f.pinned_version IS NULL AND connector_definitions.status = 'active')
          OR (
            f.pinned_version IS NOT NULL
            AND (
              connector_definitions.version = f.pinned_version
              OR connector_definitions.status = 'active'
            )
          )
        )
      ORDER BY (connector_definitions.version = f.pinned_version) DESC,
               (connector_definitions.status = 'active') DESC,
               connector_definitions.updated_at DESC,
               connector_definitions.id DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE f.id = ${feedId}
  `;
  if (feedRows.length === 0) {
    logger.warn(`[queue] Feed ${feedId} not found`);
    return { ok: false, reason: 'feed_not_found' };
  }
  const feed = feedRows[0] as {
    organization_id: string;
    connection_id: number;
    connector_key: string;
    device_worker_id: string | null;
    pinned_version: string | null;
    schedule: string | null;
    timezone: string | null;
    definition_id: number | null;
    feed_operations: unknown;
  };

  // A feed whose connector declares no `sync` operation can never be polled.
  // Only decide this when a definition actually resolved — an absent definition
  // is the uninstalled case, owned by resolveActiveConnectorVersion below.
  if (
    feed.definition_id != null &&
    (!Array.isArray(feed.feed_operations) ||
      !feed.feed_operations.includes('sync'))
  ) {
    return { ok: false, reason: 'sync_unsupported' };
  }

  // Resolve connector version: pinned_version → connector_definitions.version,
  // then verify the version has compiled code or a bundled source for on-demand
  // compilation.
  const resolved = await resolveActiveConnectorVersion(sql, {
    orgId: feed.organization_id,
    connectorKey: feed.connector_key,
    requireRunnable: true,
    pinnedVersion: feed.pinned_version,
  });
  if (!resolved.ok) {
    if (resolved.reason === 'no-definition') {
      // The connector was archived/uninstalled in this org but the feed wasn't
      // soft-deleted (see softDeleteOrphanFeed for why we soft-delete rather
      // than warn-and-return).
      await softDeleteOrphanFeed(
        sql,
        feedId,
        feed,
        'no active connector_definition for (connector_key, org).'
      );
      return { ok: false, reason: 'connector_uninstalled' };
    }
    if (resolved.reason === 'no-version') {
      throw new Error(
        `No connector version '${resolved.version}' found for '${feed.connector_key}'. Build/register connector code first.`
      );
    }
    // not-runnable: version is registered but has neither persisted compiled
    // code nor a bundled source file to compile on demand (e.g. a connector key
    // like `chrome.tabs` that was never a standalone bundled connector). It can
    // never run — treat it as an orphan so it stops storming CheckDueFeeds with
    // a per-poll error instead of looping forever (#1012).
    await softDeleteOrphanFeed(
      sql,
      feedId,
      feed,
      `no compiled code and no bundled source for version '${resolved.version}'.`
    );
    return { ok: false, reason: 'connector_version_unrunnable' };
  }
  const connectorVersion = resolved.version;
  const admissionError = await deviceManifestAdmissionError(
    sql, feed.organization_id, feed.connection_id, feed.connector_key,
    connectorVersion, feed.device_worker_id
  );
  if (admissionError) throw new ToolUserError(admissionError, 409);

  // Manual feeds (schedule null) keep next_run_at null after enqueue so they
  // are not re-picked by the due-feed scheduler.
  const nextRunAt = feed.schedule
    ? nextRunAtFromCron(feed.schedule, new Date(), feed.timezone)
    : null;
  // A dry run inserts the run row and stops there. A real enqueue advances only
  // the schedule. Source health (`last_sync_status`, `last_error`, and the
  // failure budget) remains the outcome of the last EXECUTED connector run
  // until a worker actually claims this one. Treating a merely queued run as
  // connector activity made never-claimed dispatch failures overwrite source
  // health. poll.ts marks the feed pending atomically with a successful claim.
  // A dry run must not move the schedule either.
  const inserted = dryRun
    ? await sql`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id,
      connector_key, connector_version, status, approval_status, created_at,
      dry_run, target_device_worker_id
    ) VALUES (
      ${feed.organization_id}, 'sync', ${feedId}, ${feed.connection_id},
      ${feed.connector_key}, ${connectorVersion}, 'pending', 'auto', current_timestamp,
      true, ${feed.device_worker_id == null ? null : sql`${feed.device_worker_id}::uuid`}
    )
    RETURNING id
  `
    : await sql`
    WITH inserted AS (
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id,
        connector_key, connector_version, status, approval_status, created_at,
        target_device_worker_id
      ) VALUES (
        ${feed.organization_id}, 'sync', ${feedId}, ${feed.connection_id},
        ${feed.connector_key}, ${connectorVersion}, 'pending', 'auto', current_timestamp,
        ${feed.device_worker_id == null ? null : sql`${feed.device_worker_id}::uuid`}
      )
      RETURNING id, feed_id
    )
    UPDATE feeds f
    SET next_run_at = ${nextRunAt},
        updated_at = current_timestamp
    FROM inserted i
    WHERE f.id = i.feed_id
    RETURNING i.id
  `;
  const runId = Number((inserted[0] as { id: unknown }).id);

  logger.info(
    `[queue] Created sync run ${runId} for feed ${feedId} (${feed.connector_key}, version=${connectorVersion})`
  );
  await notifyWorkerWork(sql);
  return { ok: true, runId };
}

export async function createSyncRun(
  feedId: number,
  _env: Env,
  db?: DbClient,
  // Defaults false so all four existing call sites (connect/routes, app-install,
  // check-due-feeds, manage_feeds) keep persisting. Only an explicit opt-in is
  // dry — a flag that defaulted the other way would silently stop real syncs.
  opts?: { dryRun?: boolean }
): Promise<CreateSyncRunResult> {
  const sql = db ?? getDb();
  const dryRun = opts?.dryRun === true;

  try {
    if (db) {
      return await createSyncRunWithClient(sql, feedId, dryRun);
    }

    return await sql.begin(async (tx) =>
      createSyncRunWithClient(tx, feedId, dryRun)
    );
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_sync_per_feed')) {
      logger.info(`[queue] Skipping run creation for feed ${feedId} - duplicate active sync run`);
      // Lost the race against a concurrent trigger — indistinguishable, from
      // here, from having found that run on the way in.
      return { ok: false, reason: 'already_active' };
    }
    logger.error({ error }, `[queue] Failed to create sync run for feed ${feedId}`);
    throw error;
  }
}

async function findActiveAutomationRun(
  sql: DbClient,
  automationId: number
): Promise<{ id: number; status: string } | null> {
  const existing = await sql`
    SELECT id, status
    FROM runs
    WHERE automation_id = ${automationId}
      AND run_type = 'automation'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    ORDER BY created_at ASC
    LIMIT 1
  `;

  if (existing.length === 0) return null;

  return {
    id: Number((existing[0] as { id: unknown }).id),
    status: String((existing[0] as { status: unknown }).status),
  };
}

async function createAutomationRunWithClient(
  sql: DbClient,
  params: {
    organizationId: string;
    automationId: number;
    agentId?: string | null;
    windowStart: string;
    windowEnd: string;
    dispatchSource: AutomationDispatchSource;
    deviceWorkerId?: string | null;
    agentKind?: string | null;
    sourceFingerprint?: string;
    /** Scheduler-only fence against materializing an arrival window whose mark already advanced. */
    expectedWindowStart?: string;
  }
): Promise<{ runId: number; status: string; created: boolean }> {
  const existing = await findActiveAutomationRun(sql, params.automationId);
  if (existing) {
    logger.info(
      `[queue] Reusing active automation run ${existing.id} for automation ${params.automationId}`
    );
    return { runId: existing.id, status: existing.status, created: false };
  }

  // Snapshot the version and, for a scheduler observation made before this
  // transaction, lock and verify the arrival mark. Without the fence another
  // replica can complete that window after fingerprinting but before this
  // INSERT, allowing the old range to be materialized again.
  const versionRows = params.expectedWindowStart
    ? await sql<{ current_version_id: unknown; next_window_start: string | Date | null }>`
        SELECT current_version_id, next_window_start
        FROM automations
        WHERE id = ${params.automationId}
        FOR UPDATE
      `
    : await sql<{ current_version_id: unknown; next_window_start: string | Date | null }>`
        SELECT current_version_id, next_window_start
        FROM automations
        WHERE id = ${params.automationId}
        LIMIT 1
      `;
  const currentWindowStart = versionRows[0]?.next_window_start == null
    ? null
    : new Date(versionRows[0].next_window_start).toISOString();
  if (params.expectedWindowStart && currentWindowStart !== params.expectedWindowStart) {
    logger.info(
      { automationId: params.automationId },
      '[queue] Skipping stale automation window after its arrival mark advanced'
    );
    return { runId: 0, status: 'superseded', created: false };
  }
  const snapshotVersionId =
    versionRows.length > 0 && versionRows[0].current_version_id != null
      ? Number(versionRows[0].current_version_id)
      : null;

  // device_worker_id + agent_kind get persisted into approved_input so the
  // server-side dispatcher (#802) can skip device-pinned rows from the SQL
  // side, and so /api/workers/poll can claim them with a parallel CTE
  // branch without a runs-schema migration. Empty strings are normalized to
  // null so the dispatcher's `OR '' = ''` guard treats them as un-pinned.
  const normalizedDeviceWorkerId =
    typeof params.deviceWorkerId === 'string' && params.deviceWorkerId.trim() !== ''
      ? params.deviceWorkerId.trim()
      : null;
  const normalizedAgentKind =
    typeof params.agentKind === 'string' && params.agentKind.trim() !== ''
      ? params.agentKind.trim()
      : null;

  const payload: AutomationRunPayload = {
    automation_id: params.automationId,
    agent_id: params.agentId ?? undefined,
    window_start: params.windowStart,
    window_end: params.windowEnd,
    dispatch_source: params.dispatchSource,
    version_id: snapshotVersionId,
    device_worker_id: normalizedDeviceWorkerId,
    agent_kind: normalizedAgentKind,
    source_fingerprint: params.sourceFingerprint,
  };
  const idempotencyKey = [
    'automation',
    params.automationId,
    params.dispatchSource,
    params.windowStart,
    params.windowEnd,
  ].join(':');

  const inserted = await sql`
    INSERT INTO runs (
      organization_id,
      run_type,
      automation_id,
      approval_status,
      status,
      approved_input,
      idempotency_key,
      target_device_worker_id,
      created_at
    ) VALUES (
      ${params.organizationId},
      'automation',
      ${params.automationId},
      'auto',
      'pending',
      ${sql.json(payload)},
      ${idempotencyKey},
      ${normalizedDeviceWorkerId == null ? null : sql`${normalizedDeviceWorkerId}::uuid`},
      current_timestamp
    )
    RETURNING id, status
  `;

  const runId = Number((inserted[0] as { id: unknown }).id);
  const status = String((inserted[0] as { status: unknown }).status);

  logger.info(
    `[queue] Created automation run ${runId} for automation ${params.automationId} (${params.dispatchSource})`
  );

  await notifyWorkerWork(sql);
  return { runId, status, created: true };
}

interface CreateAutomationRunParams {
  organizationId: string;
  automationId: number;
  agentId?: string | null;
  windowStart: string;
  windowEnd: string;
  dispatchSource: AutomationDispatchSource;
  deviceWorkerId?: string | null;
  agentKind?: string | null;
  sourceFingerprint?: string;
  /** Scheduler-only fence against materializing an arrival window whose mark already advanced. */
  expectedWindowStart?: string;
}

async function createAutomationRunInternal(
  params: CreateAutomationRunParams,
  db: DbClient | undefined,
  useSavepoint: boolean
): Promise<{ runId: number; status: string; created: boolean }> {
  const sql = db ?? getDb();

  try {
    if (db) {
      return useSavepoint
        ? await sql.savepoint((tx) => createAutomationRunWithClient(tx, params))
        : await createAutomationRunWithClient(sql, params);
    }

    return await sql.begin(async (tx) => createAutomationRunWithClient(tx, params));
  } catch (error) {
    if (isUniqueViolation(error, 'runs_idempotency_key_uniq')) {
      const idempotencyKey = [
        'automation',
        params.automationId,
        params.dispatchSource,
        params.windowStart,
        params.windowEnd,
      ].join(':');
      const rows = await sql`
        SELECT id, status
        FROM runs
        WHERE idempotency_key = ${idempotencyKey}
          AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        LIMIT 1
      `;
      const existing = rows.length > 0
        ? { id: Number(rows[0]?.id), status: String(rows[0]?.status) }
        : null;
      if (existing) {
        logger.info(
          `[queue] Reusing concurrent automation run ${existing.id} for automation ${params.automationId}`
        );
        return { runId: existing.id, status: existing.status, created: false };
      }
    }

    // Partial unique index idx_runs_pending_non_event_per_automation:
    // one pending non-event automation run per automation. Manual vs scheduled
    // (different idempotency keys) still collides here under TOCTOU races.
    if (isUniqueViolation(error, 'idx_runs_pending_non_event_per_automation')) {
      const rows = await sql`
        SELECT id, status
        FROM runs
        WHERE automation_id = ${params.automationId}
          AND run_type = 'automation'
          AND automation_id IS NOT NULL
          AND status = 'pending'
          AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
        LIMIT 1
      `;
      const existing = rows.length > 0
        ? { id: Number(rows[0]?.id), status: String(rows[0]?.status) }
        : null;
      if (existing) {
        logger.info(
          `[queue] Reusing concurrent pending non-event automation run ${existing.id} for automation ${params.automationId}`
        );
        return { runId: existing.id, status: existing.status, created: false };
      }
    }

    logger.error({ error, automationId: params.automationId }, '[queue] Failed to create automation run');
    throw error;
  }
}

export async function createAutomationRun(
  params: CreateAutomationRunParams,
  db?: DbClient
): Promise<{ runId: number; status: string; created: boolean }> {
  return createAutomationRunInternal(params, db, false);
}

/** Create inside a caller-owned transaction without poisoning it on a unique race. */
export async function createAutomationRunInTransaction(
  params: CreateAutomationRunParams,
  tx: DbClient
): Promise<{ runId: number; status: string; created: boolean }> {
  return createAutomationRunInternal(params, tx, true);
}

/** An activation that produced (or joined) a durable run. */
export interface AutomationEventRunQueued {
  runId: number;
  status: string;
  created: boolean;
  disposition: 'queued' | 'coalesced' | 'duplicate';
}

/**
 * An activation refused by the Automation's `min_cooldown_seconds` window. No
 * run exists, so there is no id to dispatch — the distinct shape stops callers
 * treating a suppressed activation as a queued one.
 */
export interface AutomationEventRunSuppressed {
  runId: null;
  status: 'suppressed';
  created: false;
  disposition: 'cooldown';
}

export type AutomationEventRunResult =
  | AutomationEventRunQueued
  | AutomationEventRunSuppressed;

/**
 * Durably materialize a normalized event signal as an Automation run. A
 * per-Automation transaction lock makes queue/coalesce decisions replica-safe;
 * delivery_ids in historical runs provide dedupe without a webhook ledger.
 */
export async function createAutomationEventRun(
  params: {
    organizationId: string;
    automationId: number;
    agentId?: string | null;
    trigger: AutomationActivationTrigger;
    signal: AutomationActivationSignal;
    deviceWorkerId?: string | null;
    agentKind?: string | null;
  },
  db?: DbClient
): Promise<AutomationEventRunResult> {
  const sql = db ?? getDb();
  const execute = async (tx: DbClient): Promise<AutomationEventRunResult> => {
    await lockAutomationForActivation(tx, params.automationId);

    const duplicate = await tx`
      SELECT id, status
      FROM runs
      WHERE automation_id = ${params.automationId}
        AND run_type = 'automation'
        AND COALESCE(approved_input->'delivery_ids', '[]'::jsonb)
            @> ${tx.json([params.signal.delivery_id])}::jsonb
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (duplicate.length > 0) {
      return {
        runId: Number(duplicate[0]?.id),
        status: String(duplicate[0]?.status),
        created: false,
        disposition: 'duplicate',
      };
    }

    const policy = params.trigger.active_run ??
      (params.trigger.source === 'workspace' ? 'coalesce' : 'queue');
    const triggerKey = automationEventTriggerKey(params.trigger);
    const occurredAt = params.signal.occurred_at
      ? new Date(params.signal.occurred_at)
      : new Date();
    const safeOccurredAt = Number.isNaN(occurredAt.getTime())
      ? new Date()
      : occurredAt;
    const signalWindowStart = safeOccurredAt.toISOString();
    const signalWindowEnd = new Date(safeOccurredAt.getTime() + 1).toISOString();
    if (policy === 'coalesce') {
      const pending = await tx`
        SELECT id, status, approved_input
        FROM runs
        WHERE automation_id = ${params.automationId}
          AND run_type = 'automation'
          AND status = 'pending'
          AND approved_input->>'dispatch_source' = 'event'
          AND approved_input->>'trigger_key' = ${triggerKey}
          AND CASE
            WHEN jsonb_typeof(approved_input->'delivery_ids') = 'array'
              THEN jsonb_array_length(approved_input->'delivery_ids')
            ELSE 0
          END < ${MAX_COALESCED_AUTOMATION_EVENT_INPUTS}
        -- Connector events retain FIFO coalescing. Workspace events prefer the
        -- newest overflow batch because an older run can have room for another
        -- delivery while its bounded root/causal ancestry is already full.
        ORDER BY
          CASE WHEN ${params.trigger.source === 'workspace'} THEN created_at END DESC,
          created_at ASC,
          id ASC
        LIMIT 1
        FOR UPDATE
      `;
      if (pending.length > 0) {
        const input = (pending[0]?.approved_input ?? {}) as AutomationRunPayload;
        const signals = automationTriggerSignals(input);
        const deliveryIds = input.delivery_ids ??
          signals.map((signal) => signal.delivery_id);
        const nextSignals = [...signals, params.signal];
        const nextWorkspaceSignals = nextSignals.filter(
          isWorkspaceEventTriggerSignal
        );
        const causalAutomationIds = new Set(
          nextWorkspaceSignals.flatMap((signal) => signal.causal_automation_ids)
        );
        causalAutomationIds.add(params.automationId);
        const rootEventIds = new Set(
          nextWorkspaceSignals.flatMap((signal) => signal.root_event_ids)
        );
        // A coalesced run inherits the union of every incoming causal path when
        // it emits a downstream event. Split into another durable run before
        // either half of that ancestry becomes an unbounded payload — and
        // before `deriveWorkspaceEventCausality` would have to reject the
        // producer's completed window for exceeding the same bounds.
        if (
          causalAutomationIds.size <= MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS &&
          rootEventIds.size <= MAX_COALESCED_AUTOMATION_EVENT_INPUTS
        ) {
          const currentWindowStart = Date.parse(input.window_start);
          const currentWindowEnd = Date.parse(input.window_end);
          const nextInput: AutomationRunPayload = {
            ...input,
            window_start: Number.isFinite(currentWindowStart) &&
                currentWindowStart <= safeOccurredAt.getTime()
              ? input.window_start
              : signalWindowStart,
            window_end: Number.isFinite(currentWindowEnd) &&
                currentWindowEnd >= safeOccurredAt.getTime() + 1
              ? input.window_end
              : signalWindowEnd,
            trigger_signals: nextSignals,
            delivery_ids: [...deliveryIds, params.signal.delivery_id],
          };
          const merged = await tx`
            UPDATE runs
            SET approved_input = ${tx.json(nextInput)}
            WHERE id = ${pending[0]?.id}
              AND status = 'pending'
          `;
          // A zero rowcount means the run left 'pending' between the snapshot
          // and the merge (only possible for writers outside our advisory
          // lock, e.g. old pods during a rolling deploy). Fall through and
          // queue a fresh run rather than dropping the signal.
          if (merged.count > 0) {
            return {
              runId: Number(pending[0]?.id),
              status: String(pending[0]?.status),
              created: false,
              disposition: 'coalesced',
            };
          }
        }
      }
    }

    // Only a genuinely NEW firing consumes the operator's cooldown window.
    // Everything above this line either returned an existing run (a duplicate
    // delivery) or folded the signal into one already pending (coalesce) —
    // neither starts the Automation again, so neither should count against
    // `min_cooldown_seconds`. We hold the per-Automation advisory lock, so the
    // read-and-consume inside this claim cannot interleave with another
    // replica handling a concurrent delivery.
    if (!(await claimAutomationCooldown(tx, params.automationId))) {
      return {
        runId: null,
        status: 'suppressed',
        created: false,
        disposition: 'cooldown',
      };
    }

    const versionRows = await tx`
      SELECT current_version_id
      FROM automations
      WHERE id = ${params.automationId}
      LIMIT 1
    `;
    const versionId = versionRows[0]?.current_version_id == null
      ? null
      : Number(versionRows[0]?.current_version_id);
    const payload: AutomationRunPayload = {
      automation_id: params.automationId,
      agent_id: params.agentId ?? undefined,
      window_start: signalWindowStart,
      window_end: signalWindowEnd,
      dispatch_source: 'event',
      version_id: versionId,
      device_worker_id: params.deviceWorkerId ?? null,
      agent_kind: params.agentKind ?? null,
      trigger_signal: params.signal,
      trigger_signals: [params.signal],
      delivery_ids: [params.signal.delivery_id],
      trigger_execution: resolvedEventExecution(params.trigger),
      trigger_output: params.trigger.source === 'workspace'
        ? 'silent'
        : (params.trigger.output ?? 'silent'),
      trigger_key: triggerKey,
    };
    const inserted = await tx`
      INSERT INTO runs (
        organization_id, run_type, automation_id, approval_status, status,
        approved_input, idempotency_key, target_device_worker_id, created_at
      ) VALUES (
        ${params.organizationId}, 'automation', ${params.automationId}, 'auto',
        'pending', ${tx.json(payload)},
        ${`automation:${params.automationId}:${params.signal.delivery_id}`},
        ${params.deviceWorkerId == null ? null : tx`${params.deviceWorkerId}::uuid`},
        current_timestamp
      )
      RETURNING id, status
    `;
    await notifyWorkerWork(tx);
    return {
      runId: Number(inserted[0]?.id),
      status: String(inserted[0]?.status),
      created: true,
      disposition: 'queued',
    };
  };

  if (db) return execute(sql);
  try {
    return await sql.begin(execute);
  } catch (error) {
    // Concurrent insert of the same delivery from a writer that did not
    // serialize on our advisory lock (rolling-deploy old pods). The existing
    // run is authoritative; report it instead of failing the delivery.
    if (isUniqueViolation(error, 'runs_idempotency_key_uniq')) {
      const rows = await sql`
        SELECT id, status
        FROM runs
        WHERE idempotency_key = ${`automation:${params.automationId}:${params.signal.delivery_id}`}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (rows.length > 0) {
        return {
          runId: Number(rows[0]?.id),
          status: String(rows[0]?.status),
          created: false,
          disposition: 'duplicate',
        };
      }
    }
    throw error;
  }
}

/**
 * Create an action run.
 *
 * @param params Action run parameters
 * @returns Run ID
 */
/**
 * Create an auth run to drive a connector's interactive authenticate() flow.
 * The auth profile must already exist (typically in 'pending_auth' status).
 */
export async function createAuthRun(params: {
  organizationId: string;
  connectorKey: string;
  authProfileId: number;
  createdByUserId: string;
}, db: DbClient = getDb()): Promise<number> {
  const sql = db;

  // Resolve + verify the connector version is runnable.
  const resolved = await resolveActiveConnectorVersion(sql, {
    orgId: params.organizationId,
    connectorKey: params.connectorKey,
    requireRunnable: true,
  });
  if (!resolved.ok) {
    if (resolved.reason === 'no-definition') {
      throw new Error(`No active connector definition found for '${params.connectorKey}'.`);
    }
    if (resolved.reason === 'no-version') {
      throw new Error(
        `No connector version '${resolved.version}' found for '${params.connectorKey}'.`
      );
    }
    throw new Error(
      `Connector '${params.connectorKey}' has no compiled code or source_path for version '${resolved.version}'.`
    );
  }
  const connectorVersion = resolved.version;

  try {
    const inserted = await sql`
      INSERT INTO runs (
        organization_id, run_type, connector_key, connector_version,
        auth_profile_id, created_by_user_id, approval_status, status, created_at
      ) VALUES (
        ${params.organizationId}, 'auth', ${params.connectorKey}, ${connectorVersion},
        ${params.authProfileId}, ${params.createdByUserId}, 'auto', 'pending', current_timestamp
      )
      RETURNING id
    `;
    const runId = Number((inserted[0] as { id: unknown }).id);
    logger.info(
      `[queue] Created auth run ${runId} (${params.connectorKey}, profile=${params.authProfileId})`
    );
    await notifyWorkerWork(sql);
    return runId;
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_auth_per_profile')) {
      const existing = await sql`
        SELECT id, created_by_user_id FROM runs
        WHERE auth_profile_id = ${params.authProfileId}
          AND run_type = 'auth'
          AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (existing.length > 0) {
        const row = existing[0] as { id: unknown; created_by_user_id: string | null };
        if (row.created_by_user_id && row.created_by_user_id !== params.createdByUserId) {
          throw new Error(
            'An authentication flow is already in progress for this profile by another user.'
          );
        }
        return Number(row.id);
      }
    }
    throw error;
  }
}

export async function createConnectorOperationRun(params: {
  organizationId: string;
  connectionId: number;
  connectorKey: string;
  operationKey: string;
  operationInput: Record<string, unknown>;
  /** Durable caller key. A terminal action run remains authoritative forever. */
  idempotencyKey?: string;
  /**
   * - 'inline'  → status='running', approval='auto'. Caller executes
   *               the connector inline on the gateway (server-side
   *               connectors only).
   * - 'queued'  → status='pending', approval='pending'. Waits for human
   *               approval before any worker can claim.
   * - 'device'  → status='pending', approval='auto'. Skips human gate,
   *               waits for a device worker to claim via /poll. Used
   *               for connectors with `runtime` set (chrome-extension,
   *               macos bridge, ios bridge). No gateway-side execution.
   */
  approvalMode: 'inline' | 'queued' | 'device';
  activation?: {
    kind: 'page_visit';
    urls: string[];
    expiresInSeconds: number;
  };
  requireCompiledCode?: boolean;
  /**
   * The TRUSTED principal (kind + stable id) that requested this operation,
   * derived from execution context — never from caller-supplied attribution.
   * Persisted so a queued run's connector-action policy can be RE-EVALUATED at
   * approve time against the principal that queued it, not the approver (sol
   * review #5). Null for a human requester (no per-principal policy applies).
   */
  policyPrincipalKind?: 'agent' | 'automation' | 'user' | null;
  policyPrincipalId?: string | null;
  /** Trusted user who initiated the operation, used for downstream visibility checks. */
  createdByUserId?: string | null;
  /** Trusted Automation provenance from the executing ToolContext. */
  automationId?: number | null;
  /** Trusted causal parent run. */
  parentRunId?: number | null;
  /** Internal-only metadata persisted in the existing runs.run_metadata column. */
  runMetadata?: Record<string, unknown> | null;
  /** Fresh-insert-only SDK ownership. Replaying an operation never adopts a new invocation. */
  sdkBrowserContext?: BrowserActionContext | null;
  /**
   * Optional transaction handle. When passed, the run INSERT (and its
   * connector-version read) execute on the caller's transaction instead of the
   * singleton pool, so the caller can bind run creation atomically to a sibling
   * write (e.g. the pending approval EVENT — #2033 item 16). If the caller's tx
   * rolls back, the run never exists.
   */
  db?: DbClient;
}): Promise<{
  runId: number;
  created: boolean;
  status: string;
  approvalStatus: string;
  actionOutput: unknown;
  errorMessage: string | null;
  claimedBy: string | null;
}> {
  const sql = params.db ?? getDb();
  if (params.activation && params.approvalMode !== 'inline') {
    throw new Error(
      'Page activation requires inline execution; device and approval-queued operations cannot be parked.'
    );
  }

  const approvalStatus = params.approvalMode === 'queued' ? 'pending' : 'auto';
  const status =
    params.activation || params.approvalMode !== 'inline' ? 'pending' : 'running';
  const inlineOwner =
    params.approvalMode === 'inline' && !params.activation
      ? `gateway-inline-${randomUUID()}`
      : null;

  // Ephemeral device/browser/shell action runs get a bounded claim horizon:
  // a `device` run waits for a device worker to claim it via /poll, and an
  // unclaimed one must not sit pending forever — nor must a stale run be
  // claimable by a device that polls back after the operator already gave up.
  // The horizon matches the gateway's pre-claim wait budget: polling stops
  // claiming the run when the caller gives up, and the reaper terminalizes it
  // on its next tick. Durable human-gated runs (`queued`) get NO expiry here —
  // the long-horizon approval reaper owns their lifecycle. `inline` runs
  // execute immediately on the gateway and are already claimed — unless they
  // carry an activation, which parks them pending until the user visits a
  // matching page; the caller's activation deadline is then the claim horizon.
  const expiresAtSeconds = params.activation
    ? params.activation.expiresInSeconds
    : params.approvalMode === 'device'
      ? DEVICE_ACTION_QUEUE_BUDGET_MS / 1000
      : null;

  // Resolve connector version, verifying it is runnable only when the caller
  // requires compiled code (device/inline executors that load the bundle).
  const resolved = await resolveActiveConnectorVersion(sql, {
    orgId: params.organizationId,
    connectorKey: params.connectorKey,
    requireRunnable: params.requireCompiledCode ?? false,
  });
  if (!resolved.ok) {
    if (resolved.reason === 'no-definition') {
      throw new Error(`No active connector definition found for '${params.connectorKey}'.`);
    }
    if (resolved.reason === 'no-version') {
      throw new Error(
        `No connector version '${resolved.version}' found for '${params.connectorKey}'. Build/register connector code first.`
      );
    }
    throw new Error(
      `Connector '${params.connectorKey}' has no compiled code or source_path for version '${resolved.version}'.`
    );
  }
  const connectorVersion = resolved.version;

  let targetDeviceWorkerId: string | null = null;
  if (params.connectionId && params.approvalMode !== 'inline') {
    const connRows = await sql<{ device_worker_id: string | null }>`
      SELECT device_worker_id FROM connections
      WHERE id = ${params.connectionId}
      LIMIT 1
    `;
    targetDeviceWorkerId = connRows[0]?.device_worker_id ?? null;
  }

  // Record a new unavailable action as terminal. Keeping the existing INSERT
  // conflict path preserves a completed idempotent result when its device is offline.
  const admissionError = params.approvalMode === 'device'
    ? await deviceManifestAdmissionError(
        sql, params.organizationId, params.connectionId, params.connectorKey,
        connectorVersion, targetDeviceWorkerId
      )
    : null;

  const activationUrls = params.activation ? normalizePageActivationUrls(params.activation.urls) : [];
  const runMetadata = params.activation
    ? { ...params.runMetadata, page_activation_identity: 'exact' }
    : params.runMetadata;
  const insertMetadata = params.sdkBrowserContext
    ? {
        ...runMetadata,
        browser_context:
          params.runMetadata?.browser_context ?? params.sdkBrowserContext,
      }
    : runMetadata;
  const inserted = await sql<{
    id: number;
    status: string;
    approval_status: string;
    action_output: unknown;
    error_message: string | null;
    claimed_by: string | null;
  }>`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, connector_version,
      action_key, action_input, approval_status, status,
      automation_id, parent_run_id,
      policy_principal_kind, policy_principal_id, created_by_user_id,
      action_idempotency_key, expires_at, claimed_at, last_heartbeat_at, claimed_by,
      activation_kind, activation_target_urls,
      run_metadata,
      target_device_worker_id, error_message, completed_at,
      created_at
    ) VALUES (
      ${params.organizationId}, 'action', ${params.connectionId},
      ${params.connectorKey}, ${connectorVersion},
      ${params.operationKey}, ${sql.json(params.operationInput)},
      ${approvalStatus}, ${admissionError ? 'failed' : status},
      ${params.automationId ?? null}, ${params.parentRunId ?? null},
      ${params.policyPrincipalKind ?? null}, ${params.policyPrincipalId ?? null},
      ${params.createdByUserId ?? null},
      ${params.idempotencyKey ?? null},
      ${expiresAtSeconds == null
        ? null
        : sql`current_timestamp + (${expiresAtSeconds}::int * interval '1 second')`},
      ${inlineOwner === null ? null : sql`current_timestamp`},
      ${inlineOwner === null ? null : sql`current_timestamp`},
      ${inlineOwner},
      ${params.activation?.kind ?? null},
      ${params.activation ? pgTextArray(activationUrls) : null}::text[],
      ${insertMetadata == null ? null : sql.json(insertMetadata)},
      ${targetDeviceWorkerId == null ? null : sql`${targetDeviceWorkerId}::uuid`},
      ${admissionError}, ${admissionError ? sql`current_timestamp` : null},
      current_timestamp
    )
    ON CONFLICT (organization_id, action_idempotency_key)
      WHERE run_type = 'action' AND action_idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id, status, approval_status, action_output, error_message, claimed_by
  `;

  if (inserted.length === 0) {
    if (!params.idempotencyKey) {
      throw new Error('Action run insert returned no row without an idempotency key.');
    }
    const existing = await sql<{
      id: number;
      connection_id: number;
      connector_key: string;
      action_key: string;
      action_input: Record<string, unknown> | null;
      policy_principal_kind: string | null;
      policy_principal_id: string | null;
      created_by_user_id: string | null;
      automation_id: number | null;
      parent_run_id: number | null;
      run_metadata: Record<string, unknown> | null;
      activation_kind: string | null;
      activation_target_urls: string | string[] | null;
      status: string;
      approval_status: string;
      action_output: unknown;
      error_message: string | null;
      claimed_by: string | null;
    }>`
      SELECT id, connection_id, connector_key, action_key, action_input,
             policy_principal_kind, policy_principal_id, created_by_user_id,
             automation_id, parent_run_id, run_metadata,
             activation_kind, activation_target_urls,
             status, approval_status, action_output, error_message, claimed_by
      FROM runs
      WHERE organization_id = ${params.organizationId}
        AND run_type = 'action'
        AND action_idempotency_key = ${params.idempotencyKey}
      LIMIT 1
    `;
    const prior = existing[0];
    if (!prior) {
      throw new Error('Concurrent action idempotency winner was not readable.');
    }
    const sameRequest =
      Number(prior.connection_id) === params.connectionId &&
      prior.connector_key === params.connectorKey &&
      prior.action_key === params.operationKey &&
      stableJson(prior.action_input ?? {}) === stableJson(params.operationInput) &&
      prior.policy_principal_kind === (params.policyPrincipalKind ?? null) &&
      prior.policy_principal_id === (params.policyPrincipalId ?? null) &&
      prior.created_by_user_id === (params.createdByUserId ?? null);
    const sameActivation =
      prior.activation_kind === (params.activation?.kind ?? null) &&
      stableJson(parsePgTextArray(prior.activation_target_urls)) ===
        stableJson(activationUrls);
    const priorAutomationId = prior.automation_id == null ? null : Number(prior.automation_id);
    const priorParentRunId =
      prior.parent_run_id == null ? null : Number(prior.parent_run_id);
    const requestedAutomationId = params.automationId ?? null;
    const requestedParentRunId = params.parentRunId ?? null;
    const priorBrowserContext =
      prior.run_metadata && typeof prior.run_metadata === 'object'
        ? prior.run_metadata.browser_context
        : null;
    const requestedBrowserContext = params.runMetadata?.browser_context ?? null;
    // Display titles are not identity: the same flow may re-request with a new subject.
    const browserIdentity = (context: unknown) => {
      const { title: _title, ...identity } = context as Record<string, unknown>;
      return stableJson(identity);
    };
    const compatibleBrowserContext =
      priorBrowserContext == null ||
      requestedBrowserContext == null ||
      browserIdentity(priorBrowserContext) === browserIdentity(requestedBrowserContext);
    const compatibleProvenance =
      (priorAutomationId == null || priorAutomationId === requestedAutomationId) &&
      (priorParentRunId == null || priorParentRunId === requestedParentRunId);
    if (!sameRequest || !sameActivation || !compatibleProvenance || !compatibleBrowserContext) {
      throw new ToolUserError(
        `Action idempotency key '${params.idempotencyKey}' is already bound to a different request.`,
        409
      );
    }
    // Runs missing trusted provenance can be hydrated on an exact idempotent
    // replay. The UPDATE repeats the compatibility checks atomically: another
    // replica may stamp the row after the read above, and a conflicting winner
    // must turn this replay into a 409 instead of being overwritten.
    if (
      (priorAutomationId == null && requestedAutomationId != null) ||
      (priorParentRunId == null && requestedParentRunId != null) ||
      (priorBrowserContext == null && requestedBrowserContext != null)
    ) {
      const browserContextGuard =
        requestedBrowserContext == null
          ? sql`TRUE`
          : sql`(
              run_metadata->'browser_context' IS NULL
              OR ((run_metadata->'browser_context') - 'title') = (${sql.json(requestedBrowserContext)}::jsonb - 'title')
            )`;
      const hydrated = await sql`
        UPDATE runs
        SET automation_id = COALESCE(automation_id, ${requestedAutomationId}),
            parent_run_id = COALESCE(parent_run_id, ${requestedParentRunId}),
            run_metadata = CASE
              WHEN ${requestedBrowserContext == null}
                OR run_metadata->'browser_context' IS NOT NULL
              THEN run_metadata
              ELSE jsonb_set(
                COALESCE(run_metadata, '{}'::jsonb),
                '{browser_context}',
                ${sql.json(requestedBrowserContext)}::jsonb,
                true
              )
            END
        WHERE id = ${Number(prior.id)}
          AND organization_id = ${params.organizationId}
          AND (automation_id IS NULL OR automation_id = ${requestedAutomationId})
          AND (parent_run_id IS NULL OR parent_run_id = ${requestedParentRunId})
          AND ${browserContextGuard}
        RETURNING id
      `;
      if (hydrated.length === 0) {
        throw new ToolUserError(
          `Action idempotency key '${params.idempotencyKey}' is already bound to a different request.`,
          409
        );
      }
    }
    return {
      runId: Number(prior.id),
      created: false,
      status: prior.status,
      approvalStatus: prior.approval_status,
      actionOutput: prior.action_output,
      errorMessage: prior.error_message,
      claimedBy: prior.claimed_by,
    };
  }

  const row = inserted[0];
  const runId = Number(row.id);
  logger.info(
    `[queue] Created action run ${runId} (${params.connectorKey}/${params.operationKey}, approval=${approvalStatus})`
  );
  if (row.status === 'pending' && row.approval_status === 'auto') await notifyWorkerWork(sql);
  return {
    runId,
    created: true,
    status: row.status,
    approvalStatus: row.approval_status,
    actionOutput: row.action_output,
    errorMessage: row.error_message,
    claimedBy: row.claimed_by,
  };
}
