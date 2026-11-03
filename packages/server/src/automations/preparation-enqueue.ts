import type { DbClient } from '../db/client';
import { AUTOMATION_PREPARATION_TASK } from '../scheduled/task-definitions';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import type { AutomationScriptTaskPayload } from './script-enqueue';

/** Commit preparation with its parent run; no agent is admitted until it succeeds. */
export async function enqueueAutomationPreparation(
  tx: DbClient,
  payload: AutomationScriptTaskPayload,
): Promise<void> {
  const key = `${AUTOMATION_PREPARATION_TASK}:${payload.sourceRunId}`;
  const tasks = await enqueueTasksInTransaction(tx, [{
    name: AUTOMATION_PREPARATION_TASK,
    payload,
    opts: {
      idempotencyKey: key,
      maxAttempts: 3,
      organizationId: payload.organizationId,
      automationId: payload.automationId,
      parentRunId: payload.sourceRunId,
    },
  }]);
  const taskRunId = tasks.get(key);
  if (taskRunId === undefined) throw new Error('Automation preparation task was not queued');
  await tx`
    UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) ||
      ${tx.json({ preparation_task_run_id: taskRunId })}::jsonb
    WHERE id = ${payload.sourceRunId} AND organization_id = ${payload.organizationId}
      AND automation_id = ${payload.automationId}
  `;
}
