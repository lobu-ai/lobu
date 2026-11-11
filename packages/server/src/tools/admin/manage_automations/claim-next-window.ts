import { encodeExternalAutomationClaimOwner } from '../../../automations/external-claim-owner';
import type {
  AutomationClaimNextWindowContext,
  AutomationClaimNextWindowResult,
} from '@lobu/core/contracts/tools/manage-automations';
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
import { isAdminOrOwnerRole, memberReadRole } from '../../access-control';
import { handleAutomationMode } from '../../get_content/automation-mode';
import { parseAutomationSkillSnapshots } from '../../../automations/skill-snapshots';
import type { ToolContext } from '../../registry';
import type { ManageAutomationsArgs } from '../manage_automations';
import { resolveAutomationExecutor } from './executors';
import { runLeaseFence } from '../../../runs/run-lease';
import type { AutomationTrigger } from '../../../types/automations';
import { advanceAutomationScheduleAfterSuccessfulWindow } from '../../../automations/schedule-cursor';
import { recordAutomationRunFailure } from '../../../automations/scheduled-failure-policy';
import {
  completeSkippedAutomationRun,
  inspectUnchangedWindow,
} from '../../../automations/unchanged-window';

/** Preparation belongs to native execution, including after its result is saved. */
async function assertNoNativeModuleClaim(sql: DbClient, runId: number): Promise<void> {
  const [run] = await sql`
    SELECT approved_input->'automation_script' AS module
    FROM runs WHERE id = ${runId}
  `;
  if (run?.module?.has_prepare || run?.module?.has_analysis === false) {
    throw new ToolUserError('Code modules execute through the native runtime and cannot be claimed by an external processor.', 409);
  }
}

const DEFAULT_LEASE_SECONDS = 900;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 3600;
const SCRIPT_EXTERNAL_CLAIM_ERROR =
  'Script Automations execute through the runtime and cannot be claimed by an external processor.';

export { encodeExternalAutomationClaimOwner } from '../../../automations/external-claim-owner';

/** The one rejection for work on an auto-paused external Automation. */
export function autoPausedAutomationError(automationId: number): ToolUserError {
  return new ToolUserError(
    `Automation ${automationId} is auto-paused after repeated failed runs. ` +
      'A person must review its latest run and resume it with Run now; agents and API clients cannot resume it.',
    409
  );
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
      next_run_at: string | Date | null;
      schedule_auto_paused_at: string | Date | null;
      triggers: AutomationTrigger[] | null;
    }>`
      SELECT organization_id, schedule, next_run_at, schedule_auto_paused_at, managed_agent_id, device_worker_id, agent_kind,
             triggers, execution_config->'executor'->>'kind' AS executor_kind
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
      await assertNoNativeModuleClaim(tx, runId);
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
      // Reconcile expired leases first: the expiry may be the failure that
      // pauses the Automation. A paused Automation hands out no new window,
      // queued or not; only a person's Run now (trigger) resumes it.
      await expireExternalClaims(tx, automationId);
      const [state] = await tx`SELECT schedule_auto_paused_at FROM automations WHERE id = ${automationId}`;
      if (state?.schedule_auto_paused_at) {
        // Commit the timeout and failure count before returning the rejection,
        // just as the no-op branch commits its completion before its receipt.
        return autoPausedAutomationError(automationId);
      }
      // The arrival window [mark, horizon) stays empty while the settle delay
      // or an open writer keeps the horizon at or behind the mark.
      const pending = await computePendingWindow(tx, automationId);
      windowStart = pending.windowStart;
      windowEnd = pending.windowEnd;
      if (windowEnd <= windowStart) {
        throw new ToolUserError(
          `Automation ${automationId} has nothing new to claim yet: rows stored after ` +
            `${windowStart.toISOString()} must settle for ${automationArrivalSettleMs() / 1000}s, ` +
            'and in-flight transactions can delay the window further.',
          409
        );
      }
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
        agent_id: string | null;
        device_worker_id: string | null;
      }>`
        SELECT id, approved_input->>'window_end' AS window_end,
               approved_input->'executor'->>'kind' AS executor_kind,
               approved_input->>'agent_id' AS agent_id,
               approved_input->>'device_worker_id' AS device_worker_id
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
      const executorKind = queued ? queued.executor_kind : automation.executor_kind;
      const agentId = queued ? queued.agent_id : automation.managed_agent_id;
      if (
        queued?.executor_kind === 'script' ||
        (!queued && automation.executor_kind === 'script')
      ) {
        throw new ToolUserError(SCRIPT_EXTERNAL_CLAIM_ERROR, 409);
      }
      const executor = resolveAutomationExecutor({
        agentId,
        deviceWorkerId: queued ? queued.device_worker_id : automation.device_worker_id,
        executionConfig: { executor: { kind: executorKind } },
      });
      if (executor.kind !== 'external') {
        throw new ToolUserError('This Automation run is assigned to a managed agent or device and cannot be claimed by an external processor. Use trigger and follow its execution handoff.', 409);
      }
      if (ctx.agentId && agentId && agentId !== ctx.agentId) {
        throw new ToolUserError('This external Automation belongs to another agent.', 403);
      }
      if (!queued && automation.schedule &&
          (automation.schedule_auto_paused_at || !automation.next_run_at ||
           new Date(automation.next_run_at).getTime() > now.getTime())) {
        throw new ToolUserError('This external Automation is not due. Read its schedule and next_run_at before checking again.', 409);
      }
      if (queued) windowEnd = new Date(queued.window_end);
      // A due external schedule honors `skip_if_unchanged` exactly like the
      // native materializer: a window with nothing new is booked as a no-op
      // run and the schedule advances, so the client is not handed a turn's
      // worth of work to discover an empty window. The source read opens its
      // own read-only transaction, so it takes the pool client; the row lock
      // held here still serializes it against concurrent claims.
      const unchangedWindow =
        !queued && automation.schedule
          ? await inspectUnchangedWindow(
              sql,
              { id: automationId, triggers: automation.triggers },
              { windowStart, windowEnd }
            )
          : null;
      const sourceFingerprint = unchangedWindow?.sourceFingerprint;
      if (unchangedWindow?.unchanged) {
        const skipped = await createAutomationRunInTransaction(
          {
            organizationId: automation.organization_id,
            automationId,
            agentId: automation.managed_agent_id,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            dispatchSource: 'scheduled',
            sourceFingerprint,
          },
          tx
        );
        if (!skipped.created) {
          throw new ToolUserError(`Automation ${automationId} window was claimed concurrently.`, 409);
        }
        // Keep admission and completion under the same row lock. Publishing a
        // pending no-op between transactions lets another replica claim it.
        await completeSkippedAutomationRun(tx, automationId, windowStart, windowEnd, skipped.runId);
        await advanceAutomationScheduleAfterSuccessfulWindow(tx, automationId);
        return { skipped: true as const, runId: skipped.runId, windowStart, windowEnd };
      }
      const run = queued
        ? { runId: Number(queued.id) }
        : await createAutomationRunInTransaction(
            {
              organizationId: automation.organization_id,
              automationId,
              agentId: automation.managed_agent_id,
              windowStart: windowStart.toISOString(),
              windowEnd: windowEnd.toISOString(),
              dispatchSource: automation.schedule ? 'scheduled' : 'manual',
              deviceWorkerId: automation.device_worker_id,
              agentKind: automation.agent_kind,
              sourceFingerprint,
            },
            tx
          );
      runId = run.runId;
      await assertNoNativeModuleClaim(tx, runId);
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
      skipped: false as const,
      runId,
      windowStart,
      windowEnd,
      leaseExpiresAt,
      templateVersionId: snapshot?.version_id == null ? null : Number(snapshot.version_id),
    };
  });

  if (claimedWindow instanceof ToolUserError) throw claimedWindow;
  if (claimedWindow.skipped) {
    return {
      action: 'claim_next_window',
      automation_id: String(automationId),
      status: 'completed',
      run_id: claimedWindow.runId,
      skipped_unchanged: true,
      window_start: claimedWindow.windowStart.toISOString(),
      window_end: claimedWindow.windowEnd.toISOString(),
    };
  }

  // Everything after the claim commits runs against a leased run. A failure
  // here fails that run and counts it, behind the lease fence, so a client
  // that keeps hitting it trips auto-pause instead of an endless retry loop.
  const failClaimedRun = (errorMessage: string, cause: string) =>
    sql.begin(async (tx) => {
      const [failed] = await tx<{ dispatch_source: string | null; executor_kind: string | null }>`
        UPDATE runs
        SET status = 'failed',
            outcome = ${classifyRunOutcome({ status: 'failed', errorMessage: cause })},
            completed_at = current_timestamp,
            error_message = ${errorMessage}
        WHERE id = ${claimedWindow.runId}
          AND automation_id = ${automationId}
          ${runLeaseFence(tx, owner)}
          AND expires_at = ${claimedWindow.leaseExpiresAt.toISOString()}::timestamptz
        RETURNING approved_input->>'dispatch_source' AS dispatch_source,
                  approved_input->'executor'->>'kind' AS executor_kind
      `;
      if (failed) {
        await recordAutomationRunFailure(tx, automationId, {
          dispatchSource: failed.dispatch_source,
          executorKind: failed.executor_kind,
        });
      }
    });

  // Instructions belong to the window, not each page: only the first page
  // carries them, so a long continuation loop does not re-ship the prompt.
  const versionId = claimedWindow.templateVersionId;
  let instructions: PinnedInstructions | undefined;
  if (versionId != null && !args.source_cursor && !hasBeforeOccurredAt) {
    try {
      instructions = await readPinnedInstructions(sql, ctx.organizationId, automationId, versionId);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      await failClaimedRun(`Automation pinned version ${versionId} could not be read: ${cause}`, cause);
      throw new ToolUserError(
        `Automation ${automationId} run ${claimedWindow.runId} failed: its pinned version ${versionId} ` +
          `could not be read (${cause}). The run is recorded as failed; refresh activity before claiming again.`,
        409,
        'PRECONDITION_FAILED',
        { run_id: claimedWindow.runId, version_id: versionId }
      );
    }
  }

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
        agentId: ctx.agentId,
        actingAutomationId: ctx.actingAutomationId,
        sourceContext: ctx.sourceContext ?? null,
        tokenType: ctx.tokenType,
        abortSignal: ctx.abortSignal,
        excludeWorkspaceAudit: !isAdminOrOwnerRole(memberReadRole(ctx)),
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
    const claimContext: AutomationClaimNextWindowContext = {
      ...context,
      window_token: context.window_token,
      window_start: context.window_start,
      window_end: context.window_end,
      ...(instructions ? { instructions } : {}),
    };
    return {
      action: 'claim_next_window',
      automation_id: String(automationId),
      status: 'claimed',
      run_id: claimedWindow.runId,
      lease_expires_at: claimedWindow.leaseExpiresAt.toISOString(),
      context: claimContext,
    };
  } catch (error) {
    const sourceError = error instanceof Error ? error.message : String(error);
    await failClaimedRun(`Automation source context failed: ${sourceError}`, sourceError);
    throw error;
  }
}

type PinnedInstructions = NonNullable<AutomationClaimNextWindowContext['instructions']>;

/**
 * The prompt and skill snapshots of the version a run is pinned to. An
 * external client has no worker to receive them, so the claim is its only
 * delivery; reading the pinned row (never `current_version_id`) keeps a
 * mid-run edit from changing what the claimer is told. A pinned version that
 * cannot be read fails the claimed run, as it fails native dispatch, rather
 * than letting the client fall back to a stale cached copy.
 */
async function readPinnedInstructions(
  sql: DbClient,
  organizationId: string,
  automationId: number,
  versionId: number
): Promise<PinnedInstructions> {
  const [version] = await sql<{ prompt: string | null; skills: unknown }>`
    SELECT v.prompt, v.skills
    FROM automations a
    JOIN automation_versions v
      ON v.id = ${versionId}
     AND v.automation_id = a.automation_group_id
    WHERE a.id = ${automationId}
      AND a.organization_id = ${organizationId}
    LIMIT 1
  `;
  if (!version) {
    throw new Error(`Automation ${automationId} run's pinned version ${versionId} was not found.`);
  }
  return {
    version_id: versionId,
    prompt: version.prompt?.trim() ? version.prompt : null,
    skills: parseAutomationSkillSnapshots(version.skills),
  };
}

export async function expireExternalClaims(tx: DbClient, automationId: number): Promise<boolean> {
  const expired = await tx<{ previous_status: string; dispatch_source: string | null; executor_kind: string | null }>`
    WITH expired AS (
      SELECT id, status AS previous_status FROM runs
      WHERE automation_id = ${automationId}
        AND run_type = 'automation'
        AND status IN ('claimed', 'running')
        AND expires_at IS NOT NULL AND expires_at <= current_timestamp
      FOR UPDATE SKIP LOCKED
    )
    UPDATE runs r
    SET status = 'timeout', outcome = ${classifyRunOutcome({ status: 'timeout' })},
        completed_at = current_timestamp,
        error_message = 'External Automation window lease expired'
    FROM expired WHERE r.id = expired.id AND r.status = expired.previous_status
    RETURNING expired.previous_status, r.approved_input->>'dispatch_source' AS dispatch_source,
              r.approved_input->'executor'->>'kind' AS executor_kind
  `;
  for (const row of expired) {
    // Same rule as the stale-run sweep: an external lease counts from either
    // status, a native row only once it reached `running`.
    if (row.previous_status === 'running' || row.executor_kind === 'external') {
      await recordAutomationRunFailure(tx, automationId, {
        dispatchSource: row.dispatch_source,
        executorKind: row.executor_kind,
      });
    }
  }
  return expired.length > 0;
}
