import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

type Proposal = { summary: string; prompt: string };
type Task = {
  id: number;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
};
type ChangeSet = {
  metadata: { changes?: Array<{ entityId?: number; kind?: string }> };
};

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

async function digest(
  client: ReactionClient,
  signature: string
): Promise<string> {
  const [hashed] = (await client.query(
    `SELECT md5(${sqlString(signature)}) AS digest`
  )) as Array<{ digest: string }>;
  if (!hashed || !/^[a-f0-9]{32}$/.test(hashed.digest)) {
    throw new Error("Could not compute task notification key");
  }
  return hashed.digest;
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
  const taskChanges = new Map<number, string>();
  for (const change of changeSets[0]?.metadata.changes ?? []) {
    if (
      typeof change.entityId === "number" &&
      Number.isSafeInteger(change.entityId) &&
      change.entityId > 0 &&
      (change.kind === "created" || change.kind === "updated")
    ) {
      taskChanges.set(change.entityId, change.kind);
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
    if (!taskChanges.has(task.id)) {
      client.log(`Skipped unchanged or denied task ${task.id}`);
      continue;
    }
    const help = proposal(task.metadata.agent_help);
    if (!help && taskChanges.get(task.id) !== "created") continue;
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
      ? `notice:v2:${await digest(client, JSON.stringify({ help, priority, due }))}`
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
      // Replays and display-title edits reuse the saved proposal's key. Changed
      // work or urgency gets a new alert; withdrawing help still sends none.
      idempotency_key: `task-builder:task:${task.id}:${noticeKey}`,
    });
  }
  // Check deadlines even when this run did not create or update a task.
  await remindDueTasks(client);
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
  const hashed = await digest(client, signature);
  await client.notifications.send({
    title:
      overdue.length > 0
        ? `Task reminder — ${overdue.length} overdue`
        : `Task reminder — ${rows.length} due soon`,
    body: lines.join("\n"),
    recipients: "admins",
    idempotency_key: `task-due-digest:${day}:${hashed}`,
  });
}
