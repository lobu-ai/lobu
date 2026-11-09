import type { AutomationScriptContext } from '@lobu/connector-sdk';
import { getDb, pgBigintArray, type DbClient } from '../db/client';
import type { Env } from '../index';
import { notifyWorkerWork } from '../runs/worker-wakeup';
import { AUTOMATION_PREPARATION_TASK } from '../scheduled/task-definitions';
import { ToolUserError } from '../utils/errors';
import { executeAutomationScript } from './reaction-executor';
import { reactionErrorIsNonTransient } from './reaction-task';
import { markAutomationRunFailed } from './run-completion';
import type { AutomationScriptTaskPayload } from './script-enqueue';
import { validatePreparationSources, type PreparationSources } from './preparation';

/** Durable queue owns retries; successful preparation never reruns for agent retries. */
export async function runAutomationPreparationTask(
  payload: AutomationScriptTaskPayload,
  env: Env,
  taskRunId: number,
  attempt = 1,
): Promise<void> {
  const sql = getDb();
  const run = await sql.begin(async (tx) => {
    // The same run-row lock serializes event coalescing. Once this marker is
    // committed, later deliveries form another window instead of changing the
    // context that preparation is about to read.
    const [row] = await tx`
      SELECT r.approved_input, r.run_metadata, r.status, a.slug, v.name, v.version,
             o.slug AS organization_slug
      FROM runs r
      JOIN runs task ON task.id = ${taskRunId} AND task.parent_run_id = r.id
        AND task.organization_id = r.organization_id
        AND task.automation_id = r.automation_id
        AND task.run_type = 'task'
        AND task.action_key = ${AUTOMATION_PREPARATION_TASK}
        AND task.status = 'claimed'
      JOIN automations a ON a.id = r.automation_id
        AND a.organization_id = r.organization_id
      JOIN automation_versions v ON v.id = (r.approved_input->>'version_id')::bigint
        AND v.automation_id = a.automation_group_id
      JOIN organization o ON o.id = r.organization_id
      WHERE r.id = ${payload.sourceRunId}
        AND r.organization_id = ${payload.organizationId}
        AND r.automation_id = ${payload.automationId}
        AND r.run_type = 'automation'
        AND r.run_metadata->>'preparation_task_run_id' = ${String(taskRunId)}
      FOR UPDATE OF r
    `;
    if (row?.status === 'pending' && row.run_metadata?.preparation_sources === undefined) {
      await tx`
        UPDATE runs
        SET run_metadata = run_metadata || jsonb_build_object('preparation_started_at', now())
        WHERE id = ${payload.sourceRunId}
      `;
    }
    return row;
  });
  if (!run) throw new Error('Automation preparation task has no correlated run');
  if (run.status !== 'pending' || run.run_metadata?.preparation_sources !== undefined) return;
  const input = run.approved_input;
  const script = input?.automation_script;
  if (!script?.has_prepare || typeof script.source !== 'string') {
    throw new Error('Automation preparation snapshot is missing');
  }
  const ids: number[] = script.entities;
  const entities = ids.length ? await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.metadata
    FROM entities e JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(ids)}::bigint[])
      AND e.organization_id = ${payload.organizationId}
  ` : [];
  const context: AutomationScriptContext = {
    window: {
      run_id: payload.sourceRunId,
      automation_id: payload.automationId,
      window_start: input.window_start,
      window_end: input.window_end,
    },
    trigger_signals: input.trigger_signals ?? (input.trigger_signal ? [input.trigger_signal] : []),
    entities: entities.map((entity) => ({
      id: Number(entity.id),
      name: entity.name,
      entity_type: entity.entity_type,
      metadata: entity.metadata ?? {},
    })),
    automation: {
      id: payload.automationId,
      slug: run.slug,
      name: run.name,
      version: Number(run.version),
    },
    organization_id: payload.organizationId,
    organization_slug: run.organization_slug,
  };
  const result = await executeAutomationScript({
    compiledScript: script.source,
    context,
    entryExport: 'prepare',
    env: env as Record<string, string | undefined>,
  });
  let error = result.error;
  let sources: PreparationSources | undefined;
  if (result.success) {
    try {
      sources = validatePreparationSources(result.returnValue, script.source_names);
    } catch (failure) {
      if (!(failure instanceof ToolUserError)) throw failure;
      error = `ValidationError: ${failure.message}`;
    }
  }
  if (!result.success || error) {
    if (attempt >= 3 || reactionErrorIsNonTransient(error, result.retryable)) {
      await markAutomationRunFailed(sql, payload.sourceRunId, error ?? 'Automation preparation failed');
      return;
    }
    throw new Error(error ?? 'Automation preparation failed');
  }
  const saved = await sql`
    UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) ||
      ${sql.json({ preparation_sources: sources })}::jsonb
    WHERE id = ${payload.sourceRunId} AND organization_id = ${payload.organizationId}
      AND automation_id = ${payload.automationId} AND status = 'pending'
      AND run_metadata->>'preparation_task_run_id' = ${String(taskRunId)}
      AND NOT (run_metadata ? 'preparation_sources')
    RETURNING id
  `;
  if (saved.length) await notifyWorkerWork(sql);
}

/** A crashed/exhausted queue task must visibly fail its parent, not strand it. */
export async function reconcileAutomationPreparationRuns(sql: DbClient): Promise<void> {
  const rows = await sql`
    SELECT r.id, task.error_message, task.status
    FROM runs r JOIN runs task
      ON task.id = (r.run_metadata->>'preparation_task_run_id')::bigint
      AND task.parent_run_id = r.id AND task.organization_id = r.organization_id
      AND task.automation_id = r.automation_id AND task.run_type = 'task'
      AND task.action_key = ${AUTOMATION_PREPARATION_TASK}
    WHERE r.run_type = 'automation' AND r.status = 'pending'
      AND NOT (r.run_metadata ? 'preparation_sources')
      AND task.status IN ('failed', 'cancelled', 'timeout', 'completed')
    LIMIT 100
  `;
  for (const row of rows) {
    await markAutomationRunFailed(
      sql,
      Number(row.id),
      row.error_message ?? `Automation preparation task ended ${row.status} without a result`,
    );
  }
}
