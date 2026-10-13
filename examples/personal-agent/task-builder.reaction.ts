import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

type Proposal = { summary: string; prompt: string };
type Task = {
  id: number;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
};
type TaskChange = {
  entityId?: number;
  kind?: string;
  applied?: Record<string, { old: unknown; new: unknown }>;
};
type ChangeSet = { metadata: { changes?: TaskChange[] } };

function proposal(value: unknown): Proposal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Proposal>;
  return typeof candidate.summary === "string" &&
    candidate.summary.trim() &&
    typeof candidate.prompt === "string" &&
    candidate.prompt.trim()
    ? { summary: candidate.summary.trim(), prompt: candidate.prompt.trim() }
    : null;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function noticeValue(field: string, value: unknown): string | null {
  if (field === "agent_help") return JSON.stringify(proposal(value));
  if (field === "due_date")
    return value ? new Date(String(value)).toISOString() : null;
  return value == null ? null : String(value);
}

// Outputs are proposals for writes. Check the run's committed change set, then
// re-read each entity because a later run can close it before this queued task.
export default async function notifyTaskChanges(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const changes = ctx.extracted_data.tasks;
  if (!Array.isArray(changes))
    throw new Error("Task Builder output is missing tasks");
  const changeSets = changes.length
    ? ((await client.query(
        `SELECT metadata FROM events WHERE semantic_type = 'change_set' AND automation_id = ${ctx.window.automation_id} AND run_id = ${ctx.window.run_id} LIMIT 2`
      )) as ChangeSet[])
    : [];
  if (changeSets.length > 1)
    throw new Error("Task Builder run has multiple change sets");
  const taskChanges = new Map<number, TaskChange>();
  for (const change of changeSets[0]?.metadata.changes ?? []) {
    if (
      typeof change.entityId === "number" &&
      Number.isSafeInteger(change.entityId) &&
      change.entityId > 0 &&
      (change.kind === "created" || change.kind === "updated")
    ) {
      taskChanges.set(change.entityId, change);
    }
  }
  for (const value of changes) {
    if (!value || typeof value !== "object")
      throw new Error("Invalid task output");
    const candidate = value as Record<string, unknown>;
    const identity = ["source_scope", "source_origin_id", "task_key"];
    if (
      identity.some(
        (key) => typeof candidate[key] !== "string" || !candidate[key]
      )
    ) {
      throw new Error("Task output is missing its stable identity");
    }
    const where = identity
      .map(
        (key) => `metadata->>'${key}' = ${sqlString(candidate[key] as string)}`
      )
      .join(" AND ");
    const rows = (await client.query(
      `SELECT id, name, slug, metadata FROM entities WHERE entity_type = 'task' AND deleted_at IS NULL AND id IN (${[...taskChanges.keys()].join(",") || "NULL"}) AND ${where} LIMIT 2`
    )) as Task[];
    if (rows.length > 1)
      throw new Error("Task identity matched multiple entities");
    const task = rows[0];
    if (!task || ["done", "dismissed"].includes(String(task.metadata.status)))
      continue;
    const committed = taskChanges.get(task.id);
    if (!committed) {
      client.log(`Skipped unchanged or denied task ${task.id}`);
      continue;
    }
    const help = proposal(task.metadata.agent_help);
    if (!help && committed.kind !== "created") continue;
    const proposed = proposal(candidate.agent_help);
    if (
      Object.hasOwn(candidate, "agent_help") &&
      (proposed?.summary !== help?.summary || proposed?.prompt !== help?.prompt)
    ) {
      client.log(
        `Skipped unapplied or superseded proposal for task ${task.id}`
      );
      continue;
    }
    if (help && committed.kind === "updated") {
      const relevant = ["agent_help", "priority", "due_date"].flatMap(
        (field) => {
          const change = committed.applied?.[field];
          return change ? [{ field, change }] : [];
        }
      );
      // Only applied changes can trigger an alert. Re-read state must still
      // match this run, so a delayed reaction cannot revive a superseded offer.
      if (
        relevant.some(
          ({ field, change }) =>
            noticeValue(field, change.new) !==
            noticeValue(field, task.metadata[field])
        ) ||
        !relevant.some(
          ({ field, change }) =>
            noticeValue(field, change.old) !== noticeValue(field, change.new)
        )
      )
        continue;
    }
    const action = String(task.metadata.action || task.name)
      .replace(/\s+/g, " ")
      .trim();
    const draft = `Review task #${task.id}: ${action}. Read its current status, source, rationale and agent_help before acting. If it is still unresolved, help with the saved proposal. Verify the evidence and available capabilities, prepare reviewable results, and ask for any missing decision or permission. Do not act on a closed task.`;
    const root = `/${encodeURIComponent(ctx.organization_slug)}`;
    const priority = task.metadata.priority ?? null;
    const due = task.metadata.due_date
      ? new Date(String(task.metadata.due_date)).toISOString()
      : null;
    const urgency = [
      priority ? `Priority: ${priority}` : null,
      due ? `Due: ${due}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const noticeKey = help
      ? `notice:v2:${committed.kind === "created" ? "created" : `run:${ctx.window.run_id}`}`
      : "created:v1";
    await client.notifications.send({
      title: (help ? "Agent help available: " : "Task: ")
        .concat(action)
        .slice(0, 200),
      body: (help
        ? `${help.summary}${urgency ? `\n\n${urgency}` : ""}\n\nOpen to review the request and start an agent.`
        : String(task.metadata.rationale || action)
      ).slice(0, 1000),
      recipients: "admins",
      resource_url: help
        ? `${root}/chat/personal-agent?new=1&prompt=${encodeURIComponent(draft)}`
        : `${root}/task/${encodeURIComponent(task.slug)}`,
      // Each relevant committed update has a retry-stable occurrence key.
      // Returning to an earlier proposal or urgency still gets a fresh alert.
      idempotency_key: `task-builder:task:${task.id}:${noticeKey}`,
    });
  }
  // Check deadlines even when this run did not create or update a task.
  await remindDueTasks(client);
  await syncTaskReminders(ctx, client);
}

async function remindDueTasks(client: ReactionClient): Promise<void> {
  const now = new Date();
  const nowMs = now.getTime();
  const soonIso = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const rows = (await client.query(`
    SELECT
      id,
      name,
      metadata->>'due_date' AS due_date,
      metadata->>'priority' AS priority
    FROM entities
    WHERE entity_type = 'task'
      AND deleted_at IS NULL
      AND COALESCE(metadata->>'status', 'backlog') NOT IN ('done', 'dismissed')
      AND metadata->>'due_date' IS NOT NULL
      AND (metadata->>'due_date')::timestamptz <= '${soonIso}'::timestamptz
    ORDER BY (metadata->>'due_date')::timestamptz ASC, id ASC
    LIMIT 25
  `)) as Array<{
    id: number;
    name: string;
    due_date: string;
    priority: string | null;
  }>;

  if (rows.length === 0) {
    client.log("No due or overdue tasks; reminder skipped.");
    return;
  }

  const overdue = rows.filter(
    (row) => new Date(row.due_date).getTime() < nowMs
  );
  const lines = rows.slice(0, 10).map((row) => {
    const label =
      new Date(row.due_date).getTime() < nowMs ? "OVERDUE" : "Due within 24h";
    const priority = row.priority ? ` · ${row.priority}` : "";
    return `• ${label}: ${String(row.name).replace(/\s+/g, " ").trim()} — ${row.due_date}${priority}`;
  });
  if (rows.length > 10) lines.push(`• …and ${rows.length - 10} more`);

  const day = now.toISOString().slice(0, 10);
  const signature = rows
    .map(
      (row) =>
        `${row.id}:${new Date(row.due_date).getTime() < nowMs ? "overdue" : "soon"}`
    )
    .join("-");
  const [hashed] = (await client.query(
    `SELECT md5(${sqlString(signature)}) AS digest`
  )) as Array<{ digest: string }>;
  if (!hashed || !/^[a-f0-9]{32}$/.test(hashed.digest)) {
    throw new Error("Could not compute due-task digest key");
  }
  await client.notifications.send({
    title:
      overdue.length > 0
        ? `Task reminder — ${overdue.length} overdue`
        : `Task reminder — ${rows.length} due soon`,
    body: lines.join("\n"),
    recipients: "admins",
    idempotency_key: `task-due-digest:${day}:${hashed.digest}`,
  });
}

// Mirrors task state into Apple Reminders through the paired Mac's
// apple.reminders operations. Reminders are read live by the Automation; the
// only thing kept here is the link on the task (`reminder`), never a copy.
//
// An action idempotency key is bound to the run that first used it, so a later
// run cannot replay it. Cross-run dedupe is therefore the task's own state: each
// operation's run id is written as soon as it is queued, and later reactions
// read that run back until it settles.
//
// A create that did not succeed is never retried: a timed-out create may still
// have made the reminder, and a rejection is the user's answer. A completion
// that failed is retried, because completing a reminder twice is harmless.

type Reminder = {
  run_id?: number;
  origin_id?: string;
  create_failed?: boolean;
  complete_run_id?: number;
  complete_settled?: boolean;
};
type TaskRow = { id: number; name: string; metadata: Record<string, unknown> };
type Run = Record<string, unknown>;

const LIST = "Lobu";
const BATCH = 25;
const FAILED = ["failed", "timeout", "cancelled"];

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
  const tasks = async (where: string) =>
    (await client.query(
      `SELECT id, name, metadata FROM entities WHERE entity_type = 'task' AND deleted_at IS NULL AND ${where} ORDER BY id LIMIT ${BATCH}`
    )) as TaskRow[];
  const save = (task: TaskRow, reminder: Reminder) =>
    client.entities.update({
      entity_id: task.id,
      metadata: { reminder },
    } as Parameters<ReactionClient["entities"]["update"]>[0]);
  const queued = (
    task: TaskRow,
    action: string,
    result: { status?: string; run_id?: number; error_message?: string }
  ) => {
    if (typeof result.run_id === "number") return true;
    client.log(`Reminder ${action} for task ${task.id} was not queued`, {
      status: result.status,
      error: result.error_message,
    });
    return false;
  };

  // 1. Settle creates queued by an earlier reaction.
  for (const task of await tasks(
    "metadata->'reminder'->>'run_id' IS NOT NULL AND metadata->'reminder'->>'origin_id' IS NULL AND metadata->'reminder'->>'create_failed' IS NULL"
  )) {
    const reminder = reminderOf(task.metadata);
    const { run } = await client.operations.getRun(Number(reminder.run_id));
    const originId = (run.output as Run | null)?.origin_id;
    if (run.status === "completed" && typeof originId === "string") {
      await save(task, { ...reminder, origin_id: originId });
    } else if (FAILED.includes(String(run.status))) {
      client.log(`Reminder for task ${task.id} was not created`, {
        run_id: reminder.run_id,
        status: run.status,
        approval_status: run.approval_status,
      });
      await save(task, { ...reminder, create_failed: true });
    }
  }

  // 2. Settle completions queued by an earlier reaction. A failure clears the
  //    run so step 4 tries again.
  for (const task of await tasks(
    "metadata->'reminder'->>'complete_run_id' IS NOT NULL AND metadata->'reminder'->>'complete_settled' IS NULL"
  )) {
    const reminder = reminderOf(task.metadata);
    const { run } = await client.operations.getRun(
      Number(reminder.complete_run_id)
    );
    if (run.status === "completed" || run.approval_status === "rejected") {
      await save(task, { ...reminder, complete_settled: true });
    } else if (FAILED.includes(String(run.status))) {
      const { complete_run_id: _, ...rest } = reminder;
      await save(task, rest);
    }
  }

  // 3. Create a reminder for each open, dated task that has none and did not
  //    come from Reminders.
  for (const task of await tasks(
    `COALESCE(metadata->>'status', 'backlog') NOT IN ('done', 'dismissed') AND metadata->>'due_date' IS NOT NULL AND metadata->'reminder' IS NULL AND metadata->>'source_scope' IS DISTINCT FROM '${ownScope}'`
  )) {
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
    if (!queued(task, "create", result)) continue;
    const originId = result.output?.origin_id;
    await save(task, {
      run_id: result.run_id,
      ...(result.status === "completed" && typeof originId === "string"
        ? { origin_id: originId }
        : {}),
    });
  }

  // 4. Complete the reminder behind each closed task until that settles.
  for (const task of await tasks(
    `metadata->>'status' IN ('done', 'dismissed') AND metadata->'reminder'->>'complete_run_id' IS NULL AND metadata->'reminder'->>'complete_settled' IS NULL AND (metadata->'reminder'->>'origin_id' IS NOT NULL OR metadata->>'source_scope' = '${ownScope}')`
  )) {
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
    if (!queued(task, "complete", result)) continue;
    await save(task, {
      ...reminder,
      origin_id: originId,
      ...(result.status === "completed"
        ? { complete_settled: true }
        : { complete_run_id: result.run_id }),
    });
  }
}
