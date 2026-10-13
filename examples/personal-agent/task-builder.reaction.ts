import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

// Applies the Task Collaborator's reminder changes through the paired Mac's
// apple.reminders operations. Apple Reminders is the task list: the Automation
// reads it live and this reaction writes it, so nothing is stored in Lobu.
//
// A create carries its source identity as the last line of its notes
// ("lobu:<scope>|<origin>|<key>"), which is how later runs recognise it. A run
// reads Reminders before an earlier reaction's create may have landed (it can
// be waiting for approval, or for the Mac), so creates are also checked against
// recent create runs before queuing another.

// One flat item shape: the host validates with Ajv `removeAdditional`, which
// strips properties while trying each `oneOf` branch and so would empty every
// change. The `anyOf` branches only add required fields, so nothing is stripped.
export const input = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { enum: ["create", "complete", "update"] },
          key: {
            type: "object",
            properties: {
              source_scope: { type: "string", minLength: 1 },
              source_origin_id: { type: "string", minLength: 1 },
              task_key: { type: "string", minLength: 1 },
            },
            required: ["source_scope", "source_origin_id", "task_key"],
            additionalProperties: false,
          },
          origin_id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          notes: { type: "string" },
          due: { type: "string", format: "date-time" },
        },
        required: ["action"],
        additionalProperties: false,
        anyOf: [
          {
            properties: { action: { const: "create" } },
            required: ["key", "title"],
          },
          {
            properties: { action: { enum: ["complete", "update"] } },
            required: ["origin_id"],
          },
        ],
      },
    },
  },
  required: ["changes"],
};

type Key = { source_scope: string; source_origin_id: string; task_key: string };
type Change =
  | { action: "create"; key: Key; title: string; notes?: string; due?: string }
  | { action: "complete"; origin_id: string }
  | { action: "update"; origin_id: string; title?: string; due?: string };

const LIST = "Lobu";
// A create still waiting for approval or the Mac is invisible to the live read
// for at most this long; an approval left unanswered longer expires anyway.
const RECENT_CREATE_MS = 2 * 24 * 60 * 60 * 1000;

export function marker(key: Key): string {
  return `lobu:${key.source_scope}|${key.source_origin_id}|${key.task_key}`;
}

export default async function applyReminderChanges(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const changes = (ctx.extracted_data as unknown as { changes: Change[] })
    .changes;
  if (changes.length === 0) return;

  const connections = (await client.query(
    "SELECT id FROM connections WHERE connector_key = 'apple.reminders' AND deleted_at IS NULL ORDER BY id LIMIT 2"
  )) as Array<{ id: number }>;
  if (connections.length !== 1) {
    throw new Error(
      `Expected one Apple Reminders connection, found ${connections.length}`
    );
  }
  const connectionId = Number(connections[0].id);
  const source = {
    automation_id: Number(ctx.window.automation_id),
    run_id: Number(ctx.window.run_id),
  };

  const queued = new Set<string>();
  if (changes.some((change) => change.action === "create")) {
    const { runs } = await client.operations.listRuns({
      connection_id: connectionId,
      operation_key: "create_reminder",
      created_after: new Date(Date.now() - RECENT_CREATE_MS).toISOString(),
      limit: 200,
    } as Parameters<ReactionClient["operations"]["listRuns"]>[0]);
    for (const run of runs) {
      // A failed or rejected create made nothing, so it does not block a retry.
      if (["failed", "timeout", "cancelled"].includes(String(run.status)))
        continue;
      const notes = (run.input as { notes?: unknown } | null)?.notes;
      const line =
        typeof notes === "string" ? notes.split("\n").at(-1) : undefined;
      if (line?.startsWith("lobu:")) queued.add(line);
    }
  }

  for (const [index, change] of changes.entries()) {
    let operation: string;
    let input: Record<string, unknown>;
    if (change.action === "create") {
      const line = marker(change.key);
      if (queued.has(line)) {
        client.log(`Skipped a reminder already being created: ${line}`);
        continue;
      }
      queued.add(line);
      operation = "create_reminder";
      input = {
        title: change.title.replace(/\s+/g, " ").trim().slice(0, 500),
        notes: [change.notes?.trim(), line].filter(Boolean).join("\n\n"),
        list: LIST,
        ...(change.due ? { due: change.due } : {}),
      };
    } else if (change.action === "complete") {
      operation = "complete_reminder";
      input = { origin_id: change.origin_id };
    } else {
      operation = "update_reminder";
      input = {
        origin_id: change.origin_id,
        ...(change.title ? { title: change.title } : {}),
        ...(change.due ? { due: change.due } : {}),
      };
    }
    // Queued, not awaited: the Mac and any approval finish after this reaction.
    // The key is bound to this run, so a retried reaction replays its own
    // writes instead of repeating them.
    const result = await client.operations.execute({
      connection_id: connectionId,
      operation_key: operation,
      input,
      idempotency_key: `task-reminders:${source.run_id}:${index}`,
      automation_source: source,
      background: true,
    });
    client.log(`Queued ${operation}`, {
      run_id: result.run_id,
      status: result.status,
    });
  }
}
