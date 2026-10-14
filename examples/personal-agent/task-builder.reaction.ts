import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

// Applies the Task Collaborator's reminder changes through the paired Mac's
// apple.reminders operations. Apple Reminders is the task list: the Automation
// reads it live and this reaction writes it. Lobu retains run and operation
// history, but does not maintain task entities or sync the reminder feed.
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
          title: { type: "string", minLength: 1, maxLength: 500 },
          notes: { type: "string" },
          // null clears an update's due date; a create ignores it.
          due: { type: ["string", "null"], format: "date-time" },
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
  | {
      action: "update";
      origin_id: string;
      title?: string;
      due?: string | null;
    };

const LIST = "Lobu";
// Recent creates of any status, plus unsettled creates and failures of any
// age. A completed create older than this is already in the agent's live read.
const RECENT_CREATE_MS = 2 * 24 * 60 * 60 * 1000;
const TERMINAL = ["failed", "timeout", "cancelled"];

export function marker(key: Key): string {
  return `lobu:${key.source_scope}|${key.source_origin_id}|${key.task_key}`;
}

// A short stable digest (cyrb53) so a marker of any length fits the 256
// character idempotency key.
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0")
  );
}

type CreateHistory = Map<string, { active: boolean; failed: number }>;

async function readCreateHistory(
  client: ReactionClient,
  connectionId: number
): Promise<CreateHistory> {
  const createdAfter = new Date(Date.now() - RECENT_CREATE_MS).toISOString();
  const filters = [
    { created_after: createdAfter },
    ...["pending", "running", "claimed", ...TERMINAL].map((status) => ({
      status,
      created_before: createdAfter,
    })),
  ];
  const history: CreateHistory = new Map();
  // A run can match two filters, and runs created mid-scan must not shift
  // pages, so pages follow the (created_at, id) keyset and each run counts once.
  const seen = new Set<string>();
  for (const filter of filters) {
    let cursor: { before_created_at: string; before_id: number } | undefined;
    for (;;) {
      const page = await client.operations.listRuns({
        connection_id: connectionId,
        operation_key: "create_reminder",
        ...filter,
        ...cursor,
        limit: 200,
      });
      for (const run of page.runs) {
        const id = String(run.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const notes = (run.input as { notes?: unknown } | null)?.notes;
        const line =
          typeof notes === "string" ? notes.split("\n").at(-1) : undefined;
        if (!line?.startsWith("lobu:")) continue;
        const entry = history.get(line) ?? { active: false, failed: 0 };
        if (TERMINAL.includes(String(run.status))) entry.failed++;
        else entry.active = true;
        history.set(line, entry);
      }
      const last = page.runs.at(-1);
      if (!page.has_more || !last) break;
      cursor = {
        before_created_at: String(last.created_at),
        before_id: Number(last.id),
      };
    }
  }
  return history;
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

  const history = changes.some((change) => change.action === "create")
    ? await readCreateHistory(client, connectionId)
    : new Map();
  const queued = new Set<string>();

  const failures: string[] = [];
  for (const [index, change] of changes.entries()) {
    try {
      let operation: string;
      let input: Record<string, unknown>;
      let createLine: string | undefined;
      if (change.action === "create") {
        // The marker is one notes line split on "|", so a key part holding
        // either would be misread by later runs.
        if (
          Object.values(change.key).some((part) =>
            ["|", "\n", "\r"].some((separator) => part.includes(separator))
          )
        )
          throw new Error("Reminder source key contains a marker separator");
        if (!change.title.trim()) throw new Error("Reminder title is blank");
        const line = marker(change.key);
        if (queued.has(line) || history.get(line)?.active) {
          client.log(`Skipped a reminder already being created: ${line}`);
          continue;
        }
        queued.add(line);
        createLine = line;
        if (line.length > 4000)
          throw new Error("Reminder source marker exceeds the notes limit");
        const notes = change.notes
          ?.trim()
          .slice(0, Math.max(0, 4000 - line.length - 2));
        operation = "create_reminder";
        input = {
          title: change.title.replace(/\s+/g, " ").trim().slice(0, 500),
          notes: [notes, line].filter(Boolean).join("\n\n"),
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
          ...(change.due !== undefined ? { due: change.due } : {}),
        };
      }
      // Queued, not awaited: the Mac and any approval finish after this reaction.
      // A create's key is shared by every run proposing the same source, so the
      // server admits one of any concurrent creates; each terminal failure moves
      // it to a fresh key so the action can be retried. Completing or updating
      // to the same values twice changes nothing, so those writes carry no key
      // and a retried reaction simply sends them again.
      const idempotencyKey = createLine
        ? `task-reminders:create:${connectionId}:${digest(createLine)}:${history.get(createLine)?.failed ?? 0}`
        : undefined;
      let result: Awaited<ReturnType<ReactionClient["operations"]["execute"]>>;
      try {
        result = await client.operations.execute({
          connection_id: connectionId,
          operation_key: operation,
          input,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          automation_source: source,
          background: true,
        });
      } catch (error) {
        // Another run holding the same create key is refused here. Its create
        // is then in the history, which is the record of what already exists.
        if (
          createLine &&
          (await readCreateHistory(client, connectionId)).get(createLine)
            ?.active
        ) {
          client.log(
            `Skipped a reminder another run is creating: ${createLine}`
          );
          continue;
        }
        throw error;
      }
      if (result.status === "failed" || result.status === "timeout") {
        throw new Error(
          result.error_message ?? `${operation} ${result.status}`
        );
      }
      client.log(`Queued ${operation}`, {
        run_id: result.run_id,
        status: result.status,
      });
    } catch (error) {
      failures.push(
        `Change ${index}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
