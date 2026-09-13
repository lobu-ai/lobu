import { type DbClient, getDb } from '../db/client';
import { markAutomationRunFailed } from './run-completion';
import { AUTOMATION_SCRIPT_TASK } from '../scheduled/task-definitions';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';

export interface AutomationScriptTaskPayload {
  organizationId: string;
  automationId: number;
  sourceRunId: number;
}

/** Transfer a dispatcher claim to the durable sandbox task in the same transaction. */
export async function enqueueAutomationScript(
  sql: DbClient,
  payload: AutomationScriptTaskPayload
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [run] = await tx`
      UPDATE runs SET status = 'running', claimed_by = 'automation-script', last_heartbeat_at = claimed_at
      WHERE id = ${payload.sourceRunId} AND organization_id = ${payload.organizationId}
        AND automation_id = ${payload.automationId} AND run_type = 'automation'
        AND status = 'claimed' AND claimed_by = 'lobu-dispatcher'
        AND approved_input->'executor'->>'kind' = 'script'
      RETURNING id
    `;
    if (!run) return false;
    const key = `${AUTOMATION_SCRIPT_TASK}:${payload.sourceRunId}`;
    const tasks = await enqueueTasksInTransaction(tx, [
      {
        name: AUTOMATION_SCRIPT_TASK,
        payload,
        opts: {
          idempotencyKey: key,
          maxAttempts: 3,
          organizationId: payload.organizationId,
          automationId: payload.automationId,
          parentRunId: payload.sourceRunId,
        },
      },
    ]);
    const taskRunId = tasks.get(key);
    if (taskRunId === undefined)
      throw new Error('Automation script task was not queued');
    await tx`
      UPDATE runs
      SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) ||
        ${tx.json({ executor_task_run_id: taskRunId })}::jsonb
      WHERE id = ${payload.sourceRunId}
    `;
    return true;
  });
}

/** Queue exhaustion/process death must not strand the parent or claim arrival progress. */
export async function reconcileAutomationScriptRuns(
  sql = getDb()
): Promise<number> {
  const rows = await sql`
    SELECT r.id, task.error_message, task.status AS task_status
    FROM runs r
    JOIN runs task
      ON task.id = (r.run_metadata->>'executor_task_run_id')::bigint
      AND task.parent_run_id = r.id
      AND task.organization_id = r.organization_id
      AND task.automation_id = r.automation_id
      AND task.run_type = 'task'
      AND task.action_key = ${AUTOMATION_SCRIPT_TASK}
    WHERE r.run_type = 'automation' AND r.status = 'running'
      AND task.status IN ('failed', 'cancelled', 'timeout', 'completed')
    LIMIT 100
  `;
  let count = 0;
  for (const row of rows) {
    const message =
      row.error_message ||
      `Automation script task ended ${row.task_status} before completing its run`;
    if (await markAutomationRunFailed(sql, Number(row.id), message)) count++;
  }
  return count;
}
