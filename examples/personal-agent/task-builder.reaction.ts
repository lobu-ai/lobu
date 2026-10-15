import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

// Applies the Task Collaborator's reminder changes through the paired Mac's
// apple.reminders operations. Apple Reminders is the task list: the Automation
// reads it live and this reaction writes it. Lobu retains the operation history,
// not a synced reminder collection.
//
// The reaction orders nothing. An update or completion names the reminder
// state it was decided from, and the Mac (apple.reminders@0.4.0) refuses it if
// its title, due date or completion state no longer matches. The agent
// re-reads Reminders and decides again.
//
// A create carries its source identity as the last line of its notes
// ("lobu:<scope>|<origin>|<key>"), which is how later reads recognise it. A
// window can read Reminders before an earlier create lands (it may wait for
// approval or the Mac), so a create is skipped while another with the same
// marker is queued, done or cancelled. Concurrent creates share an idempotency
// key, so the server admits only one. A failed create is the agent's to propose again.

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
          // A create proposed again names the failed attempt it reassessed.
          retry_of: { type: "integer", minimum: 1 },
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
  | {
      action: "create";
      key: Key;
      title: string;
      notes?: string;
      due?: string;
      retry_of?: number;
    }
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

type CreateHistory = Map<string, { blocked: boolean; retryAfter: number }>;

// Walk retained runs once, without status filters that a transition could
// escape between pages. Retention is based on completion, not creation time;
// an old run can still be awaiting approval or have only just completed.
async function createHistory(
  client: ReactionClient,
  connectionId: number
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
        blocked: false,
        retryAfter: 0,
      };
      if (run.status === "failed" || run.status === "timeout") {
        entry.retryAfter = Math.max(entry.retryAfter, Number(run.id));
      } else {
        // Cancelled creates include rejected approvals, which a new proposal
        // must not turn into another approval request.
        entry.blocked = true;
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

// Writes to one reminder share the state they were decided from, so the first
// to land would make the Mac refuse the rest. Fold them into one write per
// reminder: updates merge, and a completion wins over an update, which the
// agent can propose again from its next read if it still matters.
function onePerReminder(
  changes: Change[],
  client: ReactionClient,
  failures: string[]
): Array<[number, Change]> {
  const kept: Array<[number, Change]> = [];
  const slots = new Map<string, number>();
  for (const [index, change] of changes.entries()) {
    if (change.action === "create") {
      kept.push([index, change]);
      continue;
    }
    const origin = reminderOriginId(change.origin_id);
    const slot = slots.get(origin);
    if (slot === undefined) {
      slots.set(origin, kept.length);
      kept.push([index, change]);
      continue;
    }
    const earlier = kept[slot][1] as Exclude<Change, { action: "create" }>;
    if (canonical(earlier.expected) !== canonical(change.expected)) {
      failures.push(
        `Change ${index}: ${origin} was decided from a different read than change ${kept[slot][0]}; not sent`
      );
      continue;
    }
    if (earlier.action === "complete" || change.action === "complete") {
      if (earlier.action !== change.action)
        client.log(`Dropped an update to ${origin} that is being completed`);
      kept[slot] = [
        kept[slot][0],
        earlier.action === "complete" ? earlier : change,
      ];
      continue;
    }
    kept[slot] = [kept[slot][0], { ...earlier, ...change }];
  }
  return kept;
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
    ? await createHistory(client, connectionId)
    : new Map();
  const failures: string[] = [];
  const queued = new Set<string>();
  for (const [index, change] of onePerReminder(changes, client, failures)) {
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
      if (prior?.blocked) {
        client.log(
          `Skipped a queued, completed or cancelled create: ${write.identity}`
        );
        continue;
      }
      // A failed or timed-out create may still have saved the reminder, so
      // only a proposal that names that attempt, after checking it against
      // the live read, may try again. That includes this reaction's own.
      if (
        prior?.retryAfter &&
        change.action === "create" &&
        change.retry_of !== prior.retryAfter
      ) {
        client.log(
          `Skipped a create whose failed attempt ${prior.retryAfter} was not reassessed: ${write.identity}`
        );
        continue;
      }
      queued.add(key);
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
