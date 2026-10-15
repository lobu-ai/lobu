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
// Recent writes of any status, plus unsettled writes and failures of any age,
// for create admission, failure accounting and per-reminder ordering.
const RECENT_MS = 2 * 24 * 60 * 60 * 1000;
const ACTIVE = ["pending", "running", "claimed"];
const TERMINAL = ["failed", "timeout", "cancelled"];
// Fresh proposals stop after this many failed attempts of the same write.
const MAX_ATTEMPTS = 3;
const OPERATIONS = ["create_reminder", "complete_reminder", "update_reminder"];

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

// Stored inputs come back as jsonb, which does not keep key order.
function canonical(input: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(input)
      .sort()
      .map((key) => [key, input[key]])
  );
}

type Write = {
  operation: string;
  input: Record<string, unknown>;
  // The window run that proposed the write.
  parentRunId: number;
};

function markerOf(write: Write): string | undefined {
  if (write.operation !== "create_reminder") return undefined;
  const notes = write.input.notes;
  const line = typeof notes === "string" ? notes.split("\n").at(-1) : undefined;
  return line?.startsWith("lobu:") ? line : undefined;
}

// Retries retain the same desired input even when a new window dispatches them.
function retryIdentity(write: Write): string {
  return markerOf(write) ?? `${write.operation}|${canonical(write.input)}`;
}

// Creates share admission across windows; other writes belong to their window.
function identity(write: Write): string {
  return markerOf(write) ?? `${write.parentRunId}|${retryIdentity(write)}`;
}

// A create's key moves to a fresh generation after each terminal failure so it
// can be retried. Completions and updates are ordered per reminder instead: the
// key names the newest write to that reminder the reaction saw, so of two
// reactions that read the same state, the server admits one and the other must
// re-read before writing over it. Conflicting writes must also wait for earlier
// attempts to settle: the Mac can execute several admitted operations at once.
function idempotencyKey(
  connectionId: number,
  write: Write,
  failed: number,
  base: string
) {
  const createLine = markerOf(write);
  return createLine
    ? `task-reminders:create:${connectionId}:${digest(createLine)}:${failed}`
    : `task-reminders:write:${connectionId}:${digest(String(write.input.origin_id))}:${base}`;
}

// The reminder fields a write sets.
function fieldsOf(write: Write): string[] {
  return write.operation === "complete_reminder"
    ? ["completed"]
    : Object.keys(write.input).filter((field) => field !== "origin_id");
}

type Attempts = {
  write: Write;
  automationId: number | null;
  // A run is pending, running, claimed or completed.
  settled: boolean;
  failed: number;
  lastStatus: string;
  lastPosition: string;
};

type History = {
  writes: Map<string, Attempts>;
  // The newest attempt on each reminder, including cancellations.
  touched: Map<string, string>;
  // The newest attempt on each reminder field, and the window that proposed it.
  fields: Map<string, { position: string; parentRunId: number }>;
  // Reminder fields with an admitted write that has not settled.
  unsettledFields: Set<string>;
  // Names the ordering base of a reminder with no write in the read horizon.
  horizon: string;
};

function latestAttempt(history: History, write: Write, automationId: number) {
  const key = retryIdentity(write);
  let latest: Attempts | undefined;
  for (const entry of history.writes.values()) {
    if (
      entry.automationId === automationId &&
      retryIdentity(entry.write) === key &&
      (!latest || entry.lastPosition > latest.lastPosition)
    )
      latest = entry;
  }
  return latest;
}

async function readHistory(
  client: ReactionClient,
  connectionId: number
): Promise<History> {
  const createdAfter = new Date(Date.now() - RECENT_MS).toISOString();
  const filters = [
    { created_after: createdAfter },
    ...[...ACTIVE, ...TERMINAL].map((status) => ({
      status,
      created_before: createdAfter,
    })),
  ];
  const writes = new Map<string, Attempts>();
  const touched = new Map<string, string>();
  const fields = new Map<string, { position: string; parentRunId: number }>();
  const unsettledFields = new Set<string>();
  const failures = new Map<string, number>();
  // A run can match two filters, and runs created mid-scan must not shift
  // pages, so pages follow the (created_at, id) keyset and each run counts once.
  const seen = new Set<string>();
  for (const filter of filters) {
    let cursor: { before_created_at: string; before_id: number } | undefined;
    for (;;) {
      const page = await client.operations.listRuns({
        connection_id: connectionId,
        ...filter,
        ...cursor,
        limit: 200,
      });
      for (const run of page.runs) {
        const id = String(run.id);
        const operation = String(run.operation_key);
        if (seen.has(id) || !OPERATIONS.includes(operation)) continue;
        seen.add(id);
        const input = run.input as Record<string, unknown> | null;
        if (!input) continue;
        const write: Write = {
          operation,
          input,
          parentRunId: Number(run.parent_run_id ?? 0),
        };
        // A create is identified by its marker; any other write by the window
        // run that proposed it. A write made outside an Automation (a person's
        // correction) has no window, but still orders the reminder's fields.
        if (operation === "create_reminder" && !markerOf(write)) continue;
        const status = String(run.status);
        const position = `${run.created_at}|${id.padStart(20, "0")}`;
        const key = identity(write);
        const entry = writes.get(key) ?? {
          write,
          automationId:
            run.automation_id == null ? null : Number(run.automation_id),
          settled: false,
          failed: 0,
          lastStatus: status,
          lastPosition: position,
        };
        if (TERMINAL.includes(status)) {
          const retryKey = `${run.automation_id ?? null}|${retryIdentity(write)}`;
          failures.set(retryKey, (failures.get(retryKey) ?? 0) + 1);
        } else entry.settled = true;
        if (position > entry.lastPosition) {
          entry.write = write;
          entry.automationId =
            run.automation_id == null ? null : Number(run.automation_id);
          entry.lastPosition = position;
          entry.lastStatus = status;
        }
        writes.set(key, entry);
        const origin = input.origin_id;
        if (
          typeof origin === "string" &&
          position > (touched.get(origin) ?? "")
        )
          touched.set(origin, position);
        if (typeof origin === "string")
          for (const field of fieldsOf(write)) {
            const key = `${origin}|${field}`;
            if (position > (fields.get(key)?.position ?? ""))
              fields.set(key, { position, parentRunId: write.parentRunId });
            if (ACTIVE.includes(status)) unsettledFields.add(key);
          }
      }
      const last = page.runs.at(-1);
      if (!page.has_more || !last) break;
      cursor = {
        before_created_at: String(last.created_at),
        before_id: Number(last.id),
      };
    }
  }
  // A retry is server-attributed to its current window, not to the hint in
  // automation_source. Count identical inputs across those window parents.
  for (const attempts of writes.values()) {
    attempts.failed =
      failures.get(
        `${attempts.automationId}|${retryIdentity(attempts.write)}`
      ) ?? 0;
  }
  return {
    writes,
    touched,
    fields,
    unsettledFields,
    horizon: `h${createdAfter.slice(0, 10)}`,
  };
}

// The fields of a completion or update no newer write has set. A write is
// newer when a later window proposed it, or when it followed this write's own
// latest attempt. An update keeps only its live fields, so it never sets a
// field back to an older value.
function unsuperseded(history: History, write: Write): Write | undefined {
  const origin = write.input.origin_id;
  if (typeof origin !== "string") return write;
  const own = history.writes.get(identity(write))?.lastPosition;
  const live = fieldsOf(write).filter((field) => {
    const key = `${origin}|${field}`;
    const latest = history.fields.get(key);
    return !(
      latest &&
      (latest.parentRunId > write.parentRunId ||
        (own !== undefined && latest.position > own))
    );
  });
  if (live.length === 0) return undefined;
  if (live.length === fieldsOf(write).length) return write;
  return {
    ...write,
    input: Object.fromEntries([
      ["origin_id", origin],
      ...live.map((field) => [field, write.input[field]]),
    ]),
  };
}

function writeOf(change: Change, parentRunId: number): Write {
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
      parentRunId,
      input: {
        title: change.title.replace(/\s+/g, " ").trim().slice(0, 500),
        notes: [notes, line].filter(Boolean).join("\n\n"),
        list: LIST,
        ...(change.due ? { due: change.due } : {}),
      },
    };
  }
  if (change.action === "complete")
    return {
      operation: "complete_reminder",
      parentRunId,
      input: { origin_id: change.origin_id },
    };
  return {
    operation: "update_reminder",
    parentRunId,
    input: {
      origin_id: change.origin_id,
      ...(change.title ? { title: change.title } : {}),
      ...(change.due !== undefined ? { due: change.due } : {}),
    },
  };
}

export default async function applyReminderChanges(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const changes = (ctx.extracted_data as unknown as { changes: Change[] })
    .changes;
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
  const automationId = Number(ctx.window.automation_id);
  const source = {
    automation_id: automationId,
    run_id: Number(ctx.window.run_id),
  };
  // Every write this window proposes follows its end, so a window inside the
  // read horizon sees all the evidence its changes are checked against. An
  // older window's replay cannot, so it is refused rather than guessed at.
  if (
    changes.length > 0 &&
    Date.parse(ctx.window.window_end) < Date.now() - RECENT_MS
  )
    throw new Error(
      "This window is older than the reminder history horizon; propose its changes again from a fresh window"
    );
  const history = await readHistory(client, connectionId);

  // Writes are queued, and the Mac and any approval finish after the reaction
  // that queued them. The reaction applies only this window's changes and
  // never retries an earlier write: it cannot see Reminders, so it cannot tell
  // whether a timed-out create landed. The agent reads failed writes beside
  // the live list each window and proposes again what is still missing.
  const failures: string[] = [];
  const fresh: Write[] = [];
  for (const [index, change] of changes.entries()) {
    try {
      fresh.push(writeOf(change, source.run_id));
    } catch (error) {
      failures.push(
        `Change ${index}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const writes: Write[] = [];
  for (const write of fresh) {
    // Trimming changes the input identity. Preserve the original admission,
    // cancellation and retry limit before considering its remaining fields.
    const previous = latestAttempt(history, write, automationId);
    if (
      history.writes.get(identity(write))?.settled ||
      previous?.lastStatus === "cancelled" ||
      (previous && previous.failed >= MAX_ATTEMPTS)
    )
      continue;
    // Replaying this extraction has no newer evidence of the create's effect.
    // Only a later window that checked Reminders may propose another attempt.
    if (
      markerOf(write) &&
      previous &&
      previous.write.parentRunId >= write.parentRunId &&
      ["failed", "timeout"].includes(previous.lastStatus)
    ) {
      failures.push(
        "Retrying create_reminder requires a fresh live read in a later window"
      );
      continue;
    }
    const live = markerOf(write) ? write : unsuperseded(history, write);
    if (live) writes.push(live);
  }

  // The ordering base of each reminder, advanced as this reaction writes it.
  const bases = new Map<string, string>();
  const queued = new Set<string>();
  for (const write of writes) {
    const key = identity(write);
    const attempts = history.writes.get(key);
    const createLine = markerOf(write);
    const retryKey = retryIdentity(write);
    const retryState = latestAttempt(history, write, automationId);
    // An earlier attempt of this reaction already admitted the write.
    if (queued.has(retryKey) || attempts?.settled) {
      if (createLine)
        client.log(`Skipped a reminder already being created: ${createLine}`);
      continue;
    }
    if (retryState) {
      if (retryState.lastStatus === "cancelled") continue;
      if (retryState.failed >= MAX_ATTEMPTS) {
        client.log(
          `Gave up on ${write.operation} after ${retryState.failed} failures`,
          {
            parent_run_id: write.parentRunId,
          }
        );
        continue;
      }
    }
    const origin = write.input.origin_id;
    if (typeof origin === "string") {
      // The live read can still show the old value while an identical write
      // waits for approval or the Mac. Reuse that outstanding intent.
      if (
        retryState &&
        ACTIVE.includes(retryState.lastStatus) &&
        history.touched.get(origin) === retryState.lastPosition
      )
        continue;
    }
    queued.add(retryKey);
    try {
      // Approval and device execution can finish out of order. Hold a new
      // value until all earlier writes to that field have settled.
      if (
        typeof origin === "string" &&
        fieldsOf(write).some((field) =>
          history.unsettledFields.has(`${origin}|${field}`)
        )
      )
        throw new Error(`Waiting for an earlier write to ${origin} to settle`);
      let result: Awaited<ReturnType<ReactionClient["operations"]["execute"]>>;
      try {
        result = await client.operations.execute({
          connection_id: connectionId,
          operation_key: write.operation,
          input: write.input,
          idempotency_key: idempotencyKey(
            connectionId,
            write,
            retryState?.failed ?? 0,
            typeof origin === "string"
              ? (bases.get(origin) ??
                  history.touched.get(origin)?.split("|")[1] ??
                  history.horizon)
              : history.horizon
          ),
          automation_source: source,
          background: true,
        });
      } catch (error) {
        // Admission may race another window. A matching newer queued write
        // satisfies this retry even though its trusted parent differs.
        const latest = await readHistory(client, connectionId);
        // Another reaction wrote this reminder first. Its write wins when it is
        // newer; otherwise this write retries on top of it.
        if (!createLine && !unsuperseded(latest, write)) {
          client.log(`Skipped ${write.operation} superseded by a newer write`);
          continue;
        }
        const admitted = [...latest.writes.values()].some(
          (entry) =>
            retryIdentity(entry.write) === retryIdentity(write) &&
            entry.settled &&
            (createLine ||
              (entry.automationId === automationId &&
                entry.lastPosition > (retryState?.lastPosition ?? "")))
        );
        if (admitted) {
          client.log(
            `Skipped ${write.operation} already admitted by another run`
          );
          continue;
        }
        throw error;
      }
      if (result.status === "failed" || result.status === "timeout") {
        throw new Error(
          result.error_message ?? `${write.operation} ${result.status}`
        );
      }
      if (typeof origin === "string" && result.run_id != null)
        bases.set(origin, String(result.run_id).padStart(20, "0"));
      if (
        typeof origin === "string" &&
        (result.status === "pending_approval" ||
          result.status === "in_progress")
      )
        for (const field of fieldsOf(write))
          history.unsettledFields.add(`${origin}|${field}`);
      client.log(`Queued ${write.operation}`, {
        run_id: result.run_id,
        status: result.status,
      });
    } catch (error) {
      failures.push(
        `${write.operation}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
