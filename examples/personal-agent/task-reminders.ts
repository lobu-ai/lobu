import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

// Mirrors task state into Apple Reminders through the paired Mac's
// apple.reminders operations. Reminders are read live by the Automation; the
// only thing kept here is the link on the task (`reminder`), never a copy.
//
// An action idempotency key is bound to the run that first used it, so a later
// run cannot replay it. Cross-run dedupe is therefore the task's own state:
// `reminder.run_id` is written as soon as a create is queued, and later runs
// read that run back instead of creating again.

type Reminder = {
  run_id?: number;
  origin_id?: string;
  completed_run_id?: number;
};
type TaskRow = { id: number; name: string; metadata: Record<string, unknown> };

const LIST = "Lobu";
const BATCH = 25;

function reminderOf(metadata: Record<string, unknown>): Reminder {
  const value = metadata.reminder;
  return value && typeof value === "object" ? (value as Reminder) : {};
}

export async function syncTaskReminders(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const connections = (await client.query(
    "SELECT id FROM connections WHERE connector_key = 'apple.reminders' AND deleted_at IS NULL ORDER BY id LIMIT 2"
  )) as Array<{ id: number }>;
  if (connections.length !== 1) {
    client.log(
      connections.length === 0
        ? "No Apple Reminders connection; reminder sync skipped."
        : "Multiple Apple Reminders connections; reminder sync skipped."
    );
    return;
  }
  const connectionId = Number(connections[0].id);
  const ownScope = `connection:${connectionId}`;
  const source = {
    automation_id: Number(ctx.window.automation_id),
    run_id: Number(ctx.window.run_id),
  };

  const save = (task: TaskRow, reminder: Reminder) =>
    client.entities.update({
      entity_id: task.id,
      metadata: { reminder },
    } as Parameters<ReactionClient["entities"]["update"]>[0]);

  // 1. Link reminders whose create was queued by an earlier run.
  const pending = (await client.query(
    `SELECT id, name, metadata FROM entities WHERE entity_type = 'task' AND deleted_at IS NULL AND metadata->'reminder'->>'run_id' IS NOT NULL AND metadata->'reminder'->>'origin_id' IS NULL ORDER BY id LIMIT ${BATCH}`
  )) as TaskRow[];
  for (const task of pending) {
    const reminder = reminderOf(task.metadata);
    const { run } = await client.operations.getRun(Number(reminder.run_id));
    const originId = (run.output as Record<string, unknown> | null)?.origin_id;
    if (run.status === "completed" && typeof originId === "string") {
      await save(task, { ...reminder, origin_id: originId });
    } else if (run.status === "failed" || run.approval_status === "rejected") {
      // Not retried: a rejection is the user's answer, and a failure needs a look.
      client.log(`Reminder for task ${task.id} was not created`, {
        run_id: reminder.run_id,
        status: run.status,
        approval_status: run.approval_status,
      });
    }
  }

  // 2. Create a reminder for each open, dated task that has none and did not
  //    come from Reminders.
  const unlinked = (await client.query(
    `SELECT id, name, metadata FROM entities WHERE entity_type = 'task' AND deleted_at IS NULL AND COALESCE(metadata->>'status', 'backlog') NOT IN ('done', 'dismissed') AND metadata->>'due_date' IS NOT NULL AND metadata->'reminder' IS NULL AND metadata->>'source_scope' IS DISTINCT FROM '${ownScope}' ORDER BY id LIMIT ${BATCH}`
  )) as TaskRow[];
  for (const task of unlinked) {
    const title = String(task.metadata.action || task.name)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    const result = await client.operations.execute({
      connection_id: connectionId,
      operation_key: "create_reminder",
      input: {
        title,
        due: new Date(String(task.metadata.due_date)).toISOString(),
        list: LIST,
      },
      idempotency_key: `task-reminder:create:${task.id}:${source.run_id}`,
      automation_source: source,
    });
    if (typeof result.run_id !== "number") {
      client.log(`Reminder create for task ${task.id} was not queued`, {
        status: result.status,
        error: result.error_message,
      });
      continue;
    }
    const originId = result.output?.origin_id;
    await save(task, {
      run_id: result.run_id,
      ...(result.status === "completed" && typeof originId === "string"
        ? { origin_id: originId }
        : {}),
    });
  }

  // 3. Complete the reminder behind each closed task, once.
  const closed = (await client.query(
    `SELECT id, name, metadata FROM entities WHERE entity_type = 'task' AND deleted_at IS NULL AND metadata->>'status' IN ('done', 'dismissed') AND metadata->'reminder'->>'completed_run_id' IS NULL AND (metadata->'reminder'->>'origin_id' IS NOT NULL OR metadata->>'source_scope' = '${ownScope}') ORDER BY id LIMIT ${BATCH}`
  )) as TaskRow[];
  for (const task of closed) {
    const reminder = reminderOf(task.metadata);
    const originId =
      reminder.origin_id ??
      (task.metadata.source_scope === ownScope
        ? String(task.metadata.source_origin_id)
        : undefined);
    if (!originId) continue;
    const result = await client.operations.execute({
      connection_id: connectionId,
      operation_key: "complete_reminder",
      input: { origin_id: originId },
      idempotency_key: `task-reminder:complete:${task.id}:${source.run_id}`,
      automation_source: source,
    });
    if (typeof result.run_id !== "number") {
      client.log(`Reminder complete for task ${task.id} was not queued`, {
        status: result.status,
        error: result.error_message,
      });
      continue;
    }
    await save(task, {
      ...reminder,
      origin_id: originId,
      completed_run_id: result.run_id,
    });
  }
}
