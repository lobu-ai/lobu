import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

// Applies the Task Collaborator's reminder changes through the paired Mac's
// apple.reminders operations. Apple Reminders is the task list: the Automation
// reads it live and this reaction writes it. Lobu keeps no copy of reminders.
//
// The reaction orders nothing. An update or completion names the reminder
// state it was decided from, and the Mac (apple.reminders@0.4.0) refuses it if
// the reminder has changed since, so a stale or repeated decision never
// overwrites a newer edit. The agent re-reads Reminders and decides again.
//
// A create carries its source identity as the last line of its notes
// ("lobu:<scope>|<origin>|<key>"), which is how later reads recognise it. A
// window can read Reminders before an earlier create lands (it may wait for
// approval or the Mac), so a create is skipped while another with the same
// marker is queued or done. Concurrent creates share an idempotency key, so
// the server admits only one. A failed create is the agent's to propose again.

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
          // The live state this update or completion was decided from.
          expected: {
            type: "object",
            properties: {
              title: { type: "string" },
              due: { type: ["string", "null"], format: "date-time" },
              completed: { type: "boolean" },
            },
            required: ["title", "due", "completed"],
            additionalProperties: false,
          },
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
            required: ["origin_id", "expected"],
          },
        ],
      },
    },
  },
  required: ["changes"],
};

type Key = { source_scope: string; source_origin_id: string; task_key: string };
type Expected = { title: string; due: string | null; completed: boolean };
type Change =
  | { action: "create"; key: Key; title: string; notes?: string; due?: string }
  | { action: "complete"; origin_id: string; expected: Expected }
  | {
      action: "update";
      origin_id: string;
      title?: string;
      due?: string | null;
      expected: Expected;
    };

const LIST = "Lobu";
const FAILED = ["failed", "timeout", "cancelled"];

export function marker(key: Key): string {
  return `lobu:${key.source_scope}|${key.source_origin_id}|${key.task_key}`;
}

// A short stable digest so a marker of any length fits the 256
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

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
    )
    .join(",")}}`;
}

// EventKit accepts both the feed identity and the bare calendar item
// identifier; keys use the feed form so both name the same reminder.
function reminderOriginId(origin: string): string {
  const trimmed = origin.trim();
  return trimmed.startsWith("reminder:") ? trimmed : `reminder:${trimmed}`;
}

type Write = {
  operation: string;
  input: Record<string, unknown>;
  // A create is named by its source marker, any other write by its content.
  identity: string;
};

function markerOf(input: unknown): string | undefined {
  const notes = (input as { notes?: unknown } | null)?.notes;
  const line = typeof notes === "string" ? notes.split("\n").at(-1) : undefined;
  return line?.startsWith("lobu:") ? line : undefined;
}

type CreateHistory = Map<
  string,
  { live: boolean; retryAfter: number; failedThisRun: boolean }
>;

// Walk retained runs once, without status filters that a transition could
// escape between pages. Retention is based on completion, not creation time;
// an old run can still be awaiting approval or have only just completed.
async function createHistory(
  client: ReactionClient,
  connectionId: number,
  runId: number
): Promise<CreateHistory> {
  const history: CreateHistory = new Map();
  let cursor: { before_created_at: string; before_id: number } | undefined;
  for (;;) {
    const page = await client.operations.listRuns({
      connection_id: connectionId,
      operation_key: "create_reminder",
      ...cursor,
      limit: 200,
    });
    for (const run of page.runs) {
      const line = markerOf(run.input);
      if (!line) continue;
      const entry = history.get(line) ?? {
        live: false,
        retryAfter: 0,
        failedThisRun: false,
      };
      if (FAILED.includes(String(run.status))) {
        entry.retryAfter = Math.max(entry.retryAfter, Number(run.id));
        entry.failedThisRun ||= Number(run.parent_run_id) === runId;
      } else {
        entry.live = true;
      }
      history.set(line, entry);
    }
    const last = page.runs.at(-1);
    if (!page.has_more || !last) break;
    cursor = {
      before_created_at: String(last.created_at),
      before_id: Number(last.id),
    };
  }
  return history;
}

function writeOf(change: Change): Write {
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
    if (line.length > 4000)
      throw new Error("Reminder source marker exceeds the notes limit");
    const notes = change.notes
      ?.trim()
      .slice(0, Math.max(0, 4000 - line.length - 2));
    return {
      operation: "create_reminder",
      identity: line,
      input: {
        title: change.title.replace(/\s+/g, " ").trim().slice(0, 500),
        notes: [notes, line].filter(Boolean).join("\n\n"),
        list: LIST,
        ...(change.due ? { due: change.due } : {}),
      },
    };
  }
  const origin_id = reminderOriginId(change.origin_id);
  const input =
    change.action === "complete"
      ? { origin_id, expected: change.expected }
      : {
          origin_id,
          ...(change.title ? { title: change.title } : {}),
          ...(change.due !== undefined ? { due: change.due } : {}),
          expected: change.expected,
        };
  const operation =
    change.action === "complete" ? "complete_reminder" : "update_reminder";
  return { operation, input, identity: `${operation}|${canonical(input)}` };
}

export default async function applyReminderChanges(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const changes = (ctx.extracted_data as unknown as { changes: Change[] })
    .changes;
  if (changes.length === 0) return;
  // The connection is the Automation author's private device connection. A
  // reaction has no user of its own; operation discovery resolves visibility
  // through the Automation's author, while SQL would not see the connection.
  const available = (await client.operations.listAvailable({
    connector_key: "apple.reminders",
    include_disconnected: false,
    include_input_schema: false,
  })) as {
    operations?: Array<{
      execution_targets?: Array<{ connection_id: number }>;
    }>;
  };
  const connections = [
    ...new Set(
      (available.operations ?? []).flatMap((operation) =>
        (operation.execution_targets ?? []).map((target) =>
          Number(target.connection_id)
        )
      )
    ),
  ];
  if (connections.length !== 1) {
    throw new Error(
      `Expected one Apple Reminders connection, found ${connections.length}`
    );
  }
  const connectionId = connections[0];
  const source = {
    automation_id: Number(ctx.window.automation_id),
    run_id: Number(ctx.window.run_id),
  };

  const history: CreateHistory = changes.some(
    (change) => change.action === "create"
  )
    ? await createHistory(client, connectionId, source.run_id)
    : new Map();
  const failures: string[] = [];
  const queued = new Set<string>();
  for (const [index, change] of changes.entries()) {
    try {
      const write = writeOf(change);
      const prior =
        write.operation === "create_reminder"
          ? history.get(write.identity)
          : undefined;
      // Creates share admission across windows. A terminal run id lets the
      // agent propose a new attempt without counting mutable/pruned history.
      // Other writes replay only within this reaction's run.
      const key =
        write.operation === "create_reminder"
          ? `task-reminders:create:${connectionId}:${digest(write.identity)}:${prior?.retryAfter ?? 0}`
          : `task-reminders:${source.run_id}:${digest(write.identity)}`;
      if (queued.has(key)) continue;
      queued.add(key);
      if (prior?.live) {
        client.log(
          `Skipped a reminder already being created: ${write.identity}`
        );
        continue;
      }
      if (prior?.failedThisRun) {
        throw new Error(
          "Reminder create failed; the agent must reassess it against the live read"
        );
      }
      const result = await client.operations.execute({
        connection_id: connectionId,
        operation_key: write.operation,
        input: write.input,
        idempotency_key: key,
        automation_source: source,
        background: true,
      });
      if (FAILED.includes(String(result.status))) {
        throw new Error(
          `${write.operation} ${result.status} (run ${result.run_id})`
        );
      }
      client.log(`Queued ${write.operation}`, {
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
