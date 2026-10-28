/**
 * Runtime for the durable Automation reaction handoff queued by
 * `./reaction-enqueue`.
 *
 * Rehydrates the reaction context from the source run rather than from a
 * serialized bundle: `runs.action_output` holds the cleaned `extracted_data`,
 * `runs.approved_input` the arrival window bounds, and
 * `runs.run_metadata.content_analyzed` the linked-content count — all written
 * by the same transaction that queued this task, so the context the script sees
 * is exactly the one the inline path built.
 *
 * Delivery is at-least-once and external effects are NOT exactly-once. That is
 * unchanged from the inline path, which already re-ran the whole script on a
 * transient failure; what is new is that a crash mid-reaction now redelivers
 * instead of dropping the reaction on the floor. Reaction scripts performing
 * external writes should use connector idempotency keys.
 *
 * Retry budget and failure classification are carried over verbatim from the
 * inline loop: three attempts total, and a deterministic failure
 * (`reactionErrorIsNonTransient`) stops immediately rather than re-burning the
 * executor's 60s wall-clock budget twice more for no chance of recovery. The
 * handler signals those two outcomes differently to the scheduler — a transient
 * failure THROWS so the scheduler retries with its own backoff; a non-transient
 * one returns normally so the task settles, with the failure recorded on the
 * `automation_reactions` log where `get_automation` already surfaces it.
 */

import type { Env, ReactionContext } from '@lobu/connector-sdk';
import { getDb, pgBigintArray } from '../db/client';
import { AUTOMATION_REACTION_TASK } from '../scheduled/task-definitions';
import { trackAutomationReaction } from '../utils/automation-reactions';
import { getErrorMessage } from '@lobu/core';
import logger from '../utils/logger';
import { executeReaction } from './reaction-executor';
import type { AutomationReactionTaskPayload } from './reaction-enqueue';

/**
 * Deterministic reaction-script failure classes that a retry can never fix.
 * The sandbox prefixes these errors (`run-script.ts` classifyRuntimeError +
 * terminateRun): a timed-out, quota-exhausted, oversize, or compile-failed
 * reaction burns its full wall-clock budget on EVERY attempt, so retrying
 * multiplies the stall (a 60s TimeoutError retried 3x costs ~182s) with zero
 * recovery probability. Everything else — provider/network 5xx, transient SDK
 * failures — stays retryable.
 *
 * A failure the host classified itself (a typed SDK error such as a role or
 * scope denial) carries `retryable`; `false` is final whatever its name.
 *
 * Moved here from `complete-window.ts` with the retry loop it guards.
 */
export function reactionErrorIsNonTransient(error: string | undefined, retryable?: boolean): boolean {
  if (retryable === false) return true;
  if (!error) return false;
  return (
    /^(TimeoutError|CompileError|QuotaExceeded|OutputSizeExceeded|InvalidSleepDuration|SleepLimitExceeded|OutOfMemory|ValidationError|ClientSdkActionError|AccessDeniedError|McpScopeRequiredError):/.test(
      error
    ) ||
    /^ScriptError: (?:Script must `export default` an async function|NamespaceNotAvailable:|CrossOrgAccessDenied:|InvalidSDKDispatchEnvelope|Unknown SDK method:)/.test(
      error
    )
  );
}

/** Outcome reported back to the scheduler log; failures are also tracked durably. */
export type AutomationReactionTaskOutcome =
  | { status: 'success' }
  | { status: 'failed'; error: string | undefined }
  | { status: 'skipped'; reason: string };

interface SourceRunRow {
  status: string;
  action_output: unknown;
  approved_input: unknown;
  run_metadata: unknown;
}

interface AutomationRow {
  entity_ids: number[] | null;
  /** COALESCEd in SQL, so never null. */
  name: string;
  slug: string;
  organization_slug: string;
  automation_version: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Execute one queued reaction. Throws only on a TRANSIENT failure, which is the
 * scheduler's signal to retry; every other outcome settles the task.
 */
export async function runAutomationReactionTask(
  payload: AutomationReactionTaskPayload,
  env: Env,
  taskRunId: number,
  attempt = 1
): Promise<AutomationReactionTaskOutcome> {
  const { organizationId, automationId, sourceRunId } = payload;
  const sql = getDb();

  // Re-read the source run under its org + automation. A task that outlived its
  // run (superseded, or an org torn down between commit and claim) must settle
  // rather than retry against state that will never appear.
  const [run] = await sql<SourceRunRow>`
    SELECT status, action_output, approved_input, run_metadata
    FROM runs
    WHERE id = ${sourceRunId}
      AND organization_id = ${organizationId}
      AND automation_id = ${automationId}
    LIMIT 1
  `;
  if (!run) return { status: 'skipped', reason: 'source run not found' };
  if (run.status !== 'completed') {
    return { status: 'skipped', reason: `source run is ${run.status}` };
  }

  const [task] = await sql<{ reaction_script_compiled: string | null }>`
    SELECT run_metadata->>'reaction_script_compiled' AS reaction_script_compiled
    FROM runs
    WHERE id = ${taskRunId}
      AND run_type = 'task'
      AND action_key = ${AUTOMATION_REACTION_TASK}
      AND organization_id = ${organizationId}
      AND automation_id = ${automationId}
      AND parent_run_id = ${sourceRunId}
    LIMIT 1
  `;
  if (!task?.reaction_script_compiled) {
    return { status: 'skipped', reason: 'reaction script snapshot not found' };
  }

  const [automation] = await sql<AutomationRow>`
    SELECT w.entity_ids,
           COALESCE(wv.name, 'automation-' || w.id) AS name,
           COALESCE(w.slug, 'automation-' || w.id) AS slug,
           o.slug AS organization_slug,
           wv.version AS automation_version
    FROM automations w
    JOIN organization o ON o.id = w.organization_id
    LEFT JOIN automation_versions wv ON w.current_version_id = wv.id
    WHERE w.id = ${automationId}
      AND w.organization_id = ${organizationId}
  `;
  if (!automation) return { status: 'skipped', reason: 'automation not found' };

  const entityIds = Array.isArray(automation.entity_ids)
    ? automation.entity_ids.map(Number)
    : [];
  const entityRows =
    entityIds.length > 0
      ? await sql<{
          id: number;
          name: string;
          entity_type: string;
          metadata: Record<string, unknown> | null;
        }>`
          SELECT e.id, e.name, et.slug AS entity_type, e.metadata
          FROM entities e
          JOIN entity_types et ON et.id = e.entity_type_id
          WHERE e.id = ANY(${pgBigintArray(entityIds)}::bigint[])
        `
      : [];

  const approvedInput = asRecord(run.approved_input);
  const runMetadata = asRecord(run.run_metadata);
  const context: ReactionContext = {
    extracted_data: asRecord(run.action_output),
    entities: entityRows.map((e) => ({
      id: Number(e.id),
      name: e.name,
      entity_type: e.entity_type,
      metadata: e.metadata ?? {},
    })),
    window: {
      run_id: sourceRunId,
      automation_id: automationId,
      window_start: String(approvedInput.window_start ?? ''),
      window_end: String(approvedInput.window_end ?? ''),
      content_analyzed: Number(runMetadata.content_analyzed ?? 0),
    },
    automation: {
      id: automationId,
      slug: automation.slug,
      name: automation.name,
      version: Number(automation.automation_version ?? 1),
    },
    organization_id: organizationId,
    organization_slug: automation.organization_slug,
  };

  const execResult = await executeReaction({
    compiledScript: task.reaction_script_compiled,
    context,
    env: env as Record<string, string | undefined>,
  });

  await trackAutomationReaction({
    organizationId,
    automationId,
    sourceRunId,
    reactionType: 'script_execution',
    toolName: 'reaction_executor',
    toolArgs: { attempt },
    toolResult: { success: execResult.success, error: execResult.error },
  });

  if (execResult.success) {
    logger.info(
      { automation_id: automationId, run_id: sourceRunId },
      'Reaction script executed successfully (task)'
    );
    return { status: 'success' };
  }

  if (reactionErrorIsNonTransient(execResult.error, execResult.retryable)) {
    logger.warn(
      { automation_id: automationId, run_id: sourceRunId, error: execResult.error },
      'Reaction script failed on a non-transient error; not retrying'
    );
    return { status: 'failed', error: execResult.error };
  }

  // Transient: hand the retry decision to the scheduler, which owns the attempt
  // count and backoff. Throwing is the only way to signal that.
  throw new Error(
    `Reaction script failed transiently for run ${sourceRunId}: ${getErrorMessage(execResult.error)}`
  );
}
