import type { AutomationClaimNextWindowResult } from '@lobu/core/contracts/tools/manage-automations';
import type { DbClient } from '../../../db/client';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import {
  claimPendingAutomationRun,
  createAutomationRunInTransaction,
} from '../../../runs/queue-service';
import { classifyRunOutcome, SUPERSEDED_BY_ARRIVAL_MARK } from '../../../runs/run-outcome';
import { ToolUserError } from '../../../utils/errors';
import { verifyWindowToken } from '../../../utils/jwt';
import {
  automationArrivalSettleMs,
  computePendingWindow,
} from '../../../utils/window-utils';
import { handleAutomationMode } from '../../get_content/automation-mode';
import type { ToolContext } from '../../registry';
import type { ManageAutomationsArgs } from '../manage_automations';
import { runLeaseFence } from '../../../runs/run-lease';

const DEFAULT_LEASE_SECONDS = 900;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 3600;
const SCRIPT_EXTERNAL_CLAIM_ERROR =
  'Script Automations execute through the runtime and cannot be claimed by an external processor.';

/**
 * The durable owner of an Automation window claim.
 *
 * Deliberately excludes `mcp_session_id`. An MCP session is a transport
 * artifact, not an identity: ChatGPT opens a NEW session per tool call (75
 * sessions in 24 minutes, each used exactly once), so a session-scoped owner
 * makes `claim_next_window` -> `complete_window` structurally impossible — the
 * completion never matches the claim, the lease expires, and the same window is
 * re-served forever. Ownership is the caller, and the caller outlives the
 * session.
 *
 * What still fences a completion: the signed `window_token` binds the exact run,
 * attempt and lease; claims serialize per Automation; and the lease expires. So
 * the narrowing this drops is only "a different session of the SAME user, agent
 * and OAuth client", which is the same principal by every other measure.
 */
export function encodeExternalAutomationClaimOwner(
  ctx: ToolContext,
  action: 'claim_next_window' | 'complete_window' = 'claim_next_window'
): string {
  const identity = {
    user_id: ctx.userId ?? null,
    agent_id: ctx.agentId ?? null,
    client_id: ctx.clientId ?? null,
  };
  if (Object.values(identity).every((value) => value == null)) {
    throw new ToolUserError(
      `${action} requires an identified caller to own the window lease.`,
      403
    );
  }
  return `external:${JSON.stringify(identity)}`;
}

export function isExternalAutomationClaimOwner(value: string): boolean {
  if (!value.startsWith('external:')) return false;
  try {
    const identity = JSON.parse(value.slice('external:'.length)) as unknown;
    if (identity == null || typeof identity !== 'object' || Array.isArray(identity)) {
      return false;
    }
    const record = identity as Record<string, unknown>;
    const keys = ['user_id', 'agent_id', 'client_id'];
    // Rows claimed before `mcp_session_id` left the identity still carry it.
    // They can no longer be completed (the owner will not match), but they must
    // still READ as external so `trigger` routes them to the external lane
    // instead of mistaking them for a worker claim.
    const optional = ['mcp_session_id'];
    if (
      !keys.every(
        (key) =>
          Object.hasOwn(record, key) &&
          (record[key] == null || typeof record[key] === 'string')
      ) ||
      Object.keys(record).some((key) => !keys.includes(key) && !optional.includes(key)) ||
      optional.some((key) => Object.hasOwn(record, key) && record[key] != null && typeof record[key] !== 'string')
    ) {
      return false;
    }
    // `optional` counts here too: a legacy row whose only non-null field was
    // `mcp_session_id` is still an external claim, and must read as one so
    // `trigger` does not mistake it for a worker claim.
    return [...keys, ...optional].some((key) => record[key] != null);
  } catch {
    return false;
  }
}

export async function handleClaimNextWindow(
  args: ManageAutomationsArgs,
  env: Env,
  ctx: ToolContext
): Promise<AutomationClaimNextWindowResult> {
  const automationId = Number(args.automation_id);
  if (!Number.isSafeInteger(automationId) || automationId < 1) {
    throw new ToolUserError('automation_id is required for claim_next_window.', 400);
  }
  const leaseSeconds = Math.trunc(args.lease_seconds ?? DEFAULT_LEASE_SECONDS);
  if (leaseSeconds < MIN_LEASE_SECONDS || leaseSeconds > MAX_LEASE_SECONDS) {
    throw new ToolUserError(
      `lease_seconds must be between ${MIN_LEASE_SECONDS} and ${MAX_LEASE_SECONDS}.`,
      400
    );
  }
  if (Boolean(args.source_name) !== Boolean(args.source_cursor) ||
      (args.source_cursor && (args.run_id == null || args.before_occurred_at != null || args.before_id != null))) {
    throw new ToolUserError('Source continuations require source_name, source_cursor and run_id; do not mix event cursors.', 400);
  }
  const hasBeforeOccurredAt = args.before_occurred_at != null;
  const hasBeforeId = args.before_id != null;
  if (hasBeforeOccurredAt !== hasBeforeId) {
    throw new ToolUserError(
      'before_occurred_at and before_id must be provided together.',
      400
    );
  }
  if (hasBeforeOccurredAt && args.run_id == null) {
    throw new ToolUserError(
      'Automation source-page cursors require run_id from the active window claim.',
      400
    );
  }

  if (args.source_cursor) {
    const cursor = await verifyWindowToken(args.source_cursor, env);
    if (cursor.automation_id !== automationId || cursor.run_id !== args.run_id ||
        !cursor.source_pages?.some((page) => page.name === args.source_name && page.next_cursor)) {
      throw new ToolUserError('Source cursor does not continue this Automation run/source.', 409);
    }
  }

  const sql = getDb();
  const owner = encodeExternalAutomationClaimOwner(ctx);
  const claimedWindow = await sql.begin(async (tx) => {
    const [automation] = await tx<{
      organization_id: string;
      schedule: string | null;
      managed_agent_id: string | null;
      device_worker_id: string | null;
      agent_kind: string | null;
      executor_kind: string | null;
    }>`
      SELECT organization_id, schedule, managed_agent_id, device_worker_id, agent_kind,
             execution_config->'executor'->>'kind' AS executor_kind
      FROM automations
      WHERE id = ${automationId}
        AND organization_id = ${ctx.organizationId}
        AND status = 'active'
      FOR UPDATE
    `;
    if (!automation) throw new ToolUserError(`Automation ${automationId} not found.`, 404);

    const now = new Date();
    let runId: number;
    let windowStart: Date;
    let windowEnd: Date;
    let leaseExpiresAt: Date;

    if (args.run_id != null) {
      const [continuation] = await tx<{
        id: number;
        claimed_by: string | null;
        expires_at: string | Date | null;
        window_start: string;
        window_end: string;
        executor_kind: string | null;
      }>`
        SELECT id, claimed_by, expires_at,
               approved_input->>'window_start' AS window_start,
               approved_input->>'window_end' AS window_end,
               approved_input->'executor'->>'kind' AS executor_kind
        FROM runs
        WHERE id = ${args.run_id}
          AND automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'running'
        FOR UPDATE
      `;
      if (
        !continuation ||
        continuation.claimed_by !== owner ||
        !continuation.expires_at ||
        new Date(continuation.expires_at).getTime() <= now.getTime()
      ) {
        throw new ToolUserError('Automation window continuation does not own an active lease.', 409);
      }
      if (continuation.executor_kind === 'script') {
        throw new ToolUserError(SCRIPT_EXTERNAL_CLAIM_ERROR, 409);
      }
      runId = Number(continuation.id);
      windowStart = new Date(continuation.window_start);
      windowEnd = new Date(continuation.window_end);
      leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
      await tx`
        UPDATE runs
        SET expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
            last_heartbeat_at = current_timestamp
        WHERE id = ${runId}
      `;
    } else {
      // The arrival window [mark, horizon). Empty only while the mark is
      // younger than the settle budget (a just-created or just-seeded
      // Automation): nothing stored since it has settled yet.
      const pending = await computePendingWindow(tx, automationId);
      windowStart = pending.windowStart;
      windowEnd = pending.windowEnd;
      if (windowEnd <= windowStart) {
        throw new ToolUserError(
          `Automation ${automationId} has nothing new to claim yet: rows stored after ` +
            `${windowStart.toISOString()} become claimable ${automationArrivalSettleMs() / 1000}s after they land.`,
          409
        );
      }
      await expireExternalClaims(tx, automationId);
      const active = await tx`
        SELECT id FROM runs
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status IN ('claimed', 'running')
        LIMIT 1
      `;
      if (active.length > 0) {
        throw new ToolUserError(`Automation ${automationId} already has an active window claim.`, 409);
      }
      await tx`
        UPDATE runs
        SET status = 'cancelled',
            outcome = ${classifyRunOutcome({
              status: 'cancelled',
              errorMessage: SUPERSEDED_BY_ARRIVAL_MARK,
            })},
            completed_at = current_timestamp,
            error_message = ${SUPERSEDED_BY_ARRIVAL_MARK}
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'pending'
          AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
          AND (approved_input->>'window_start')::timestamptz <> ${windowStart.toISOString()}::timestamptz
      `;
      // A pending run already queued at the mark owns its own horizon (the
      // scheduler or a manual trigger cut it earlier). Adopt that range: it is
      // a prefix of what is claimable now, and the remainder is the next claim.
      const [queued] = await tx<{
        id: number;
        window_end: string;
        executor_kind: string | null;
      }>`
        SELECT id, approved_input->>'window_end' AS window_end,
               approved_input->'executor'->>'kind' AS executor_kind
        FROM runs
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'pending'
          AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
          AND (approved_input->>'window_start')::timestamptz = ${windowStart.toISOString()}::timestamptz
        LIMIT 1
      `;
      // An existing run owns the executor snapshot. Only consult the live
      // Automation when this claim would create a new run; otherwise a config
      // edit could retroactively move already-queued work between lanes.
      if (
        queued?.executor_kind === 'script' ||
        (!queued && automation.executor_kind === 'script')
      ) {
        throw new ToolUserError(SCRIPT_EXTERNAL_CLAIM_ERROR, 409);
      }
      if (queued) windowEnd = new Date(queued.window_end);
      const run = queued
        ? { runId: Number(queued.id) }
        : await createAutomationRunInTransaction(
            {
              organizationId: automation.organization_id,
              automationId,
              agentId: automation.managed_agent_id,
              windowStart: windowStart.toISOString(),
              windowEnd: windowEnd.toISOString(),
              dispatchSource: 'manual',
              deviceWorkerId: automation.device_worker_id,
              agentKind: automation.agent_kind,
            },
            tx
          );
      runId = run.runId;
      leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
      const claimed = await claimPendingAutomationRun(tx, {
        runId,
        automationId,
        claimedBy: owner,
        status: 'running',
        expiresAt: leaseExpiresAt,
      });
      if (!claimed) {
        throw new ToolUserError(`Automation ${automationId} window was claimed concurrently.`, 409);
      }
    }

    const [snapshot] = await tx<{ version_id: number | string | null }>`
      SELECT CASE
               WHEN approved_input->>'version_id' ~ '^\\d+$'
                 THEN (approved_input->>'version_id')::bigint
               ELSE NULL
             END AS version_id
      FROM runs
      WHERE id = ${runId}
        AND automation_id = ${automationId}
      LIMIT 1
    `;

    return {
      runId,
      windowStart,
      windowEnd,
      leaseExpiresAt,
      templateVersionId:
        snapshot?.version_id == null ? null : Number(snapshot.version_id),
    };
  });

  try {
    const context = await handleAutomationMode(
      {
        automation_id: automationId,
        template_version_id: claimedWindow.templateVersionId ?? undefined,
        limit: args.limit,
        before_occurred_at: args.before_occurred_at,
        before_id: args.before_id,
        source_name: args.source_name,
        source_cursor: args.source_cursor,
      },
      env,
      sql,
      {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        excludeWorkspaceAudit: ctx.memberRole !== 'owner' && ctx.memberRole !== 'admin',
        claimedWindow: {
          runId: claimedWindow.runId,
          windowStart: claimedWindow.windowStart.toISOString(),
          windowEnd: claimedWindow.windowEnd.toISOString(),
          leaseExpiresAt: claimedWindow.leaseExpiresAt.toISOString(),
          templateVersionId: claimedWindow.templateVersionId,
        },
        throwOnSourceError: true,
      }
    );
    if (!context.window_token || !context.window_start || !context.window_end) {
      throw new Error('Claimed Automation context is missing its signed window bounds.');
    }
    const claimContext: AutomationClaimNextWindowResult['context'] = {
      ...context,
      window_token: context.window_token,
      window_start: context.window_start,
      window_end: context.window_end,
    };
    return {
      action: 'claim_next_window',
      automation_id: String(automationId),
      run_id: claimedWindow.runId,
      lease_expires_at: claimedWindow.leaseExpiresAt.toISOString(),
      context: claimContext,
    };
  } catch (error) {
    const sourceError = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE runs
      SET status = 'failed',
          outcome = ${classifyRunOutcome({ status: 'failed', errorMessage: sourceError })},
          completed_at = current_timestamp,
          error_message = ${`Automation source context failed: ${sourceError}`}
      WHERE id = ${claimedWindow.runId}
        AND automation_id = ${automationId}
        ${runLeaseFence(sql, owner)}
        AND expires_at = ${claimedWindow.leaseExpiresAt.toISOString()}::timestamptz
    `;
    throw error;
  }
}

export async function expireExternalClaims(tx: DbClient, automationId: number): Promise<void> {
  await tx`
    UPDATE runs
    SET status = 'timeout', outcome = ${classifyRunOutcome({ status: 'timeout' })},
        completed_at = current_timestamp,
        error_message = 'External Automation window lease expired'
    WHERE automation_id = ${automationId}
      AND run_type = 'automation'
      AND status IN ('claimed', 'running')
      AND expires_at IS NOT NULL
      AND expires_at <= current_timestamp
  `;
}
