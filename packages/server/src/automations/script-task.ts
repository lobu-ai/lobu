import type { AutomationScriptContext } from '@lobu/connector-sdk';
import type { Env } from '../index';
import { getDb, pgBigintArray } from '../db/client';
import { AUTOMATION_SCRIPT_TASK } from '../scheduled/task-definitions';
import { classifyRunOutcome } from '../runs/run-outcome';
import { advanceAutomationArrivalMark } from '../utils/window-utils';
import { advanceAutomationScheduleAfterSuccessfulWindow } from './schedule-cursor';
import { executeAutomationScript } from './reaction-executor';
import { reactionErrorIsNonTransient } from './reaction-task';
import { markAutomationRunFailed } from './run-completion';
import { enqueueAutomationReaction } from './reaction-enqueue';
import type { AutomationScriptTaskPayload } from './script-enqueue';

/** At-least-once execution over a pinned script/window. External writes need run-scoped idempotency. */
export async function runAutomationScriptTask(
  payload: AutomationScriptTaskPayload, env: Env, taskRunId: number, attempt = 1,
): Promise<void> {
  const sql = getDb();
  const [run] = await sql`
    SELECT r.approved_input, r.status, to_jsonb(a.entity_ids) AS entity_ids, a.slug,
           v.name, v.version, o.slug AS organization_slug
    FROM runs r
    JOIN runs task ON task.id = ${taskRunId} AND task.parent_run_id = r.id
      AND task.organization_id = r.organization_id AND task.automation_id = r.automation_id
      AND task.run_type = 'task' AND task.action_key = ${AUTOMATION_SCRIPT_TASK} AND task.status = 'claimed'
    JOIN automations a ON a.id = r.automation_id AND a.organization_id = r.organization_id
    JOIN automation_versions v ON v.id = (r.approved_input->>'version_id')::bigint AND v.automation_id = a.automation_group_id
    JOIN organization o ON o.id = r.organization_id
    WHERE r.id = ${payload.sourceRunId} AND r.organization_id = ${payload.organizationId}
      AND r.automation_id = ${payload.automationId} AND r.run_type = 'automation'
      AND r.run_metadata->>'executor_task_run_id' = ${String(taskRunId)}
  `;
  if (!run) throw new Error('Automation script task has no correlated run and pinned version');
  if (run.status !== 'running') return;
  const input = run.approved_input;
  if (input?.executor?.kind !== 'script' || typeof input.executor.source !== 'string') {
    throw new Error('Automation script snapshot is missing');
  }
  const ids = Array.isArray(run.entity_ids) ? run.entity_ids.map(Number) : [];
  const entities = ids.length > 0 ? await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.metadata
    FROM entities e JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(ids)}::bigint[]) AND e.organization_id = ${payload.organizationId}
  ` : [];
  const context: AutomationScriptContext = {
    window: { run_id: payload.sourceRunId, automation_id: payload.automationId,
      window_start: input.window_start, window_end: input.window_end },
    trigger_signals: input.trigger_signals ?? (input.trigger_signal ? [input.trigger_signal] : []),
    entities: entities.map((e) => ({ id: Number(e.id), name: String(e.name), entity_type: String(e.entity_type), metadata: e.metadata ?? {} })),
    automation: { id: payload.automationId, slug: String(run.slug), name: String(run.name), version: Number(run.version) },
    organization_id: payload.organizationId, organization_slug: String(run.organization_slug),
  };
  const result = await executeAutomationScript({ compiledScript: input.executor.source, params: input.executor.params, context, env: env as Record<string, string | undefined> });
  let error = result.error;
  if (result.success && result.returnValue !== undefined &&
      (!result.returnValue || typeof result.returnValue !== 'object' || Array.isArray(result.returnValue))) {
    error = 'ValidationError: Automation scripts must return an object or no value.';
  }
  if (!result.success || error) {
    if (attempt >= 3 || reactionErrorIsNonTransient(error)) {
      await markAutomationRunFailed(sql, payload.sourceRunId, error ?? 'Automation script failed');
      return;
    }
    throw new Error(error ?? 'Automation script failed');
  }
  await sql.begin(async (tx) => {
    // Match completeWindow's Automation-before-run lock order and pin the
    // optional reaction decision to the same transaction as completion.
    const [automation] = await tx`
      SELECT reaction_script_compiled FROM automations
      WHERE id = ${payload.automationId} AND organization_id = ${payload.organizationId}
      FOR UPDATE
    `;
    if (!automation) throw new Error('Automation disappeared before script completion');
    const [completed] = await tx`
      UPDATE runs SET status = 'completed', outcome = ${classifyRunOutcome({ status: 'completed' })},
        action_output = ${tx.json((result.returnValue ?? {}) as Record<string, unknown>)},
        model_used = 'script', completed_at = now(), error_message = NULL
      WHERE id = ${payload.sourceRunId} AND organization_id = ${payload.organizationId}
        AND automation_id = ${payload.automationId} AND status = 'running' AND run_type = 'automation'
        AND run_metadata->>'executor_task_run_id' = ${String(taskRunId)}
      RETURNING id
    `;
    if (!completed) return;
    if (input.dispatch_source !== 'event') {
      await advanceAutomationArrivalMark(tx, payload.automationId, new Date(input.window_start), new Date(input.window_end));
      await advanceAutomationScheduleAfterSuccessfulWindow(tx, payload.automationId);
    }
    if (automation?.reaction_script_compiled) {
      await enqueueAutomationReaction(tx, payload, String(automation.reaction_script_compiled));
    }
  });
}
