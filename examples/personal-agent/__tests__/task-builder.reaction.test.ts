import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import applyReminderChanges, { input, marker } from "../task-builder.reaction";

type Execute = Parameters<ReactionClient["operations"]["execute"]>[0];
type ListRuns = Parameters<ReactionClient["operations"]["listRuns"]>[0];

const context = (changes: unknown[]): ReactionContext =>
  ({
    extracted_data: { changes },
    entities: [],
    window: {
      run_id: 901,
      automation_id: 71,
      window_start: "2026-09-10T10:00:00Z",
      window_end: "2026-09-10T12:00:00Z",
      content_analyzed: 1,
    },
    automation: {
      id: 71,
      slug: "hourly-task-collaborator",
      name: "Task Collaborator",
      version: 1,
    },
    organization_id: "synthetic-org",
    organization_slug: "example",
  }) as unknown as ReactionContext;

function harness(
  options: {
    connections?: Array<{ id: number }>;
    recentCreates?: Array<Record<string, unknown>>;
  } = {}
) {
  const executed: Execute[] = [];
  const listed: ListRuns[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql.includes("connector_key = 'apple.reminders'"))
        return options.connections ?? [{ id: 7 }];
      throw new Error(`unexpected query: ${sql}`);
    },
    operations: {
      listRuns: async (input: ListRuns) => {
        listed.push(input);
        return { runs: options.recentCreates ?? [] };
      },
      execute: async (input: Execute) => {
        executed.push(input);
        return { status: "in_progress", run_id: 500 + executed.length };
      },
    },
    log: () => undefined,
  } as unknown as ReactionClient;
  return { client, executed, listed };
}

const key = {
  source_scope: "connection:3",
  source_origin_id: "thread-1",
  task_key: "reply",
};
const create = {
  action: "create",
  key,
  title: "  Reply to  Ana ",
  notes: "Gmail: Ana asked for the contract",
  due: "2026-10-20T09:00:00Z",
};
const source = { automation_id: 71, run_id: 901 };

describe("Task Collaborator reminder changes", () => {
  test("no changes touch nothing", async () => {
    const h = harness({ connections: [] });
    await applyReminderChanges(context([]), h.client);
    expect(h.executed).toHaveLength(0);
  });

  test("refuses to guess between zero or several Reminders connections", async () => {
    for (const connections of [[], [{ id: 7 }, { id: 8 }]]) {
      const h = harness({ connections });
      await expect(
        applyReminderChanges(context([create]), h.client)
      ).rejects.toThrow("Expected one Apple Reminders connection");
      expect(h.executed).toHaveLength(0);
    }
  });

  test("creates a reminder in the Lobu list with its source line", async () => {
    const h = harness();
    await applyReminderChanges(context([create]), h.client);
    expect(h.executed).toEqual([
      {
        connection_id: 7,
        operation_key: "create_reminder",
        input: {
          title: "Reply to Ana",
          notes:
            "Gmail: Ana asked for the contract\n\nlobu:connection:3|thread-1|reply",
          list: "Lobu",
          due: "2026-10-20T09:00:00Z",
        },
        idempotency_key: "task-reminders:901:0",
        automation_source: source,
        background: true,
      },
    ]);
    expect(h.listed[0]).toMatchObject({
      connection_id: 7,
      operation_key: "create_reminder",
    });
  });

  test("a create without notes or due carries only the source line", async () => {
    const h = harness();
    await applyReminderChanges(
      context([{ action: "create", key, title: "Call" }]),
      h.client
    );
    expect(h.executed[0]?.input).toEqual({
      title: "Call",
      notes: marker(key),
      list: "Lobu",
    });
  });

  test("skips a create already queued or done by an earlier run", async () => {
    for (const status of ["pending", "in_progress", "completed"]) {
      const h = harness({
        recentCreates: [{ status, input: { notes: `x\n\n${marker(key)}` } }],
      });
      await applyReminderChanges(context([create]), h.client);
      expect(h.executed).toHaveLength(0);
    }
  });

  test("a failed or rejected earlier create does not block a new one", async () => {
    for (const status of ["failed", "timeout", "cancelled"]) {
      const h = harness({
        recentCreates: [{ status, input: { notes: marker(key) } }],
      });
      await applyReminderChanges(context([create]), h.client);
      expect(h.executed).toHaveLength(1);
    }
  });

  test("the same action proposed twice in one run is created once", async () => {
    const h = harness();
    await applyReminderChanges(context([create, create]), h.client);
    expect(h.executed).toHaveLength(1);
  });

  test("completes and updates by reminder identity, keyed to this run", async () => {
    const h = harness();
    await applyReminderChanges(
      context([
        { action: "complete", origin_id: "reminder:a" },
        {
          action: "update",
          origin_id: "reminder:b",
          due: "2026-10-21T09:00:00Z",
        },
      ]),
      h.client
    );
    expect(h.listed).toHaveLength(0);
    expect(
      h.executed.map(({ operation_key, input, idempotency_key }) => ({
        operation_key,
        input,
        idempotency_key,
      }))
    ).toEqual([
      {
        operation_key: "complete_reminder",
        input: { origin_id: "reminder:a" },
        idempotency_key: "task-reminders:901:0",
      },
      {
        operation_key: "update_reminder",
        input: { origin_id: "reminder:b", due: "2026-10-21T09:00:00Z" },
        idempotency_key: "task-reminders:901:1",
      },
    ]);
  });

  test("never deletes", async () => {
    const h = harness();
    await applyReminderChanges(
      context([create, { action: "complete", origin_id: "reminder:a" }]),
      h.client
    );
    expect(h.executed.map((call) => call.operation_key)).not.toContain(
      "delete_reminder"
    );
  });

  // Same options as the host's window completion (complete-window.ts).
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    removeAdditional: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(input);

  test("the host's validator keeps every field of every change", () => {
    const changes = [
      create,
      { action: "complete", origin_id: "reminder:a" },
      { action: "update", origin_id: "reminder:b", title: "New" },
    ];
    const data = structuredClone({ changes });
    expect(validate(data)).toBe(true);
    expect(data).toEqual({ changes });
  });

  test("the host's validator rejects deletes and incomplete changes", () => {
    for (const change of [
      { action: "delete", origin_id: "reminder:a" },
      { action: "create", key },
      { action: "complete" },
      { action: "create", key, title: "x", due: "tomorrow" },
    ]) {
      expect(validate({ changes: [change] })).toBe(false);
    }
  });
});
