import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import { syncTaskReminders } from "../task-builder.reaction";

type Row = { id: number; name: string; metadata: Record<string, unknown> };
type Execute = Parameters<ReactionClient["operations"]["execute"]>[0];
type Result = Awaited<ReturnType<ReactionClient["operations"]["execute"]>>;

const context = {
  extracted_data: { tasks: [] },
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
    name: "Task Builder",
    version: 1,
  },
  organization_id: "synthetic-org",
  organization_slug: "example",
} as ReactionContext;

// The fake answers each of the module's three task queries by the clause that
// distinguishes it, so a query that drifts from its intent returns nothing.
function harness(options: {
  connections?: Array<{ id: number }>;
  pending?: Row[];
  unlinked?: Row[];
  closed?: Row[];
  runs?: Record<number, Record<string, unknown>>;
  execute?: (input: Execute) => Result;
}) {
  const executed: Execute[] = [];
  const updates: Array<{
    entity_id: number;
    metadata: Record<string, unknown>;
  }> = [];
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM connections"))
        return options.connections ?? [{ id: 7 }];
      if (sql.includes("'origin_id' IS NULL")) return options.pending ?? [];
      if (sql.includes("metadata->'reminder' IS NULL"))
        return options.unlinked ?? [];
      if (sql.includes("'completed_run_id' IS NULL"))
        return options.closed ?? [];
      throw new Error(`unexpected query: ${sql}`);
    },
    operations: {
      execute: async (input: Execute) => {
        executed.push(input);
        return options.execute
          ? options.execute(input)
          : {
              status: "completed",
              run_id: 500 + executed.length,
              output: { origin_id: "reminder:new" },
            };
      },
      getRun: async (runId: number) => ({ run: options.runs?.[runId] ?? {} }),
    },
    entities: {
      update: async (input: {
        entity_id: number;
        metadata: Record<string, unknown>;
      }) => {
        updates.push(input);
        return {};
      },
    },
    log: () => undefined,
  } as unknown as ReactionClient;
  return { client, executed, updates, queries };
}

const dated: Row = {
  id: 11,
  name: "Renew passport",
  metadata: {
    action: "Renew  passport",
    status: "backlog",
    due_date: "2026-10-20T09:00:00Z",
    source_scope: "connection:3",
    source_origin_id: "mail-1",
  },
};

describe("Apple Reminders task mirror", () => {
  test("does nothing without exactly one Reminders connection", async () => {
    for (const connections of [[], [{ id: 7 }, { id: 8 }]]) {
      const h = harness({ connections, unlinked: [dated] });
      await syncTaskReminders(context, h.client);
      expect(h.executed).toHaveLength(0);
      expect(h.queries).toHaveLength(1);
    }
  });

  test("creates a reminder for an open dated task and links it", async () => {
    const h = harness({ unlinked: [dated] });
    await syncTaskReminders(context, h.client);
    expect(h.executed).toEqual([
      {
        connection_id: 7,
        operation_key: "create_reminder",
        input: {
          title: "Renew passport",
          due: "2026-10-20T09:00:00.000Z",
          list: "Lobu",
        },
        idempotency_key: "task-reminder:create:11:901",
        automation_source: { automation_id: 71, run_id: 901 },
      },
    ]);
    expect(h.updates).toEqual([
      {
        entity_id: 11,
        metadata: { reminder: { run_id: 501, origin_id: "reminder:new" } },
      },
    ]);
  });

  test("records a create awaiting approval so no later run creates another", async () => {
    const h = harness({
      unlinked: [dated],
      execute: () => ({ status: "pending_approval", run_id: 77 }),
    });
    await syncTaskReminders(context, h.client);
    expect(h.updates).toEqual([
      { entity_id: 11, metadata: { reminder: { run_id: 77 } } },
    ]);
  });

  test("an unqueued create leaves the task unlinked for a later run", async () => {
    const h = harness({
      unlinked: [dated],
      execute: () => ({ status: "failed", error_message: "device offline" }),
    });
    await syncTaskReminders(context, h.client);
    expect(h.updates).toHaveLength(0);
  });

  test("never creates for tasks that came from Reminders or are closed", async () => {
    const h = harness({});
    await syncTaskReminders(context, h.client);
    const create = h.queries.find((sql) =>
      sql.includes("metadata->'reminder' IS NULL")
    );
    expect(create).toContain("IS DISTINCT FROM 'connection:7'");
    expect(create).toContain("NOT IN ('done', 'dismissed')");
    expect(create).toContain("'due_date' IS NOT NULL");
  });

  test("links a create once its run completes and ignores runs still waiting", async () => {
    const h = harness({
      pending: [
        { id: 21, name: "a", metadata: { reminder: { run_id: 31 } } },
        { id: 22, name: "b", metadata: { reminder: { run_id: 32 } } },
        { id: 23, name: "c", metadata: { reminder: { run_id: 33 } } },
      ],
      runs: {
        31: { status: "completed", output: { origin_id: "reminder:abc" } },
        32: { status: "pending", approval_status: "pending" },
        33: { status: "failed", approval_status: "rejected" },
      },
    });
    await syncTaskReminders(context, h.client);
    expect(h.updates).toEqual([
      {
        entity_id: 21,
        metadata: { reminder: { run_id: 31, origin_id: "reminder:abc" } },
      },
    ]);
    expect(h.executed).toHaveLength(0);
  });

  test("completes the linked reminder of a closed task once", async () => {
    const h = harness({
      closed: [
        {
          id: 41,
          name: "x",
          metadata: {
            status: "done",
            reminder: { run_id: 9, origin_id: "reminder:r1" },
          },
        },
      ],
    });
    await syncTaskReminders(context, h.client);
    expect(h.executed).toEqual([
      {
        connection_id: 7,
        operation_key: "complete_reminder",
        input: { origin_id: "reminder:r1" },
        idempotency_key: "task-reminder:complete:41:901",
        automation_source: { automation_id: 71, run_id: 901 },
      },
    ]);
    expect(h.updates).toEqual([
      {
        entity_id: 41,
        metadata: {
          reminder: {
            run_id: 9,
            origin_id: "reminder:r1",
            completed_run_id: 501,
          },
        },
      },
    ]);
  });

  test("completes the source reminder of a closed task that came from Reminders", async () => {
    const h = harness({
      closed: [
        {
          id: 42,
          name: "y",
          metadata: {
            status: "dismissed",
            source_scope: "connection:7",
            source_origin_id: "reminder:src",
          },
        },
      ],
    });
    await syncTaskReminders(context, h.client);
    expect(h.executed[0]?.input).toEqual({ origin_id: "reminder:src" });
    expect(h.updates[0]?.metadata).toEqual({
      reminder: { origin_id: "reminder:src", completed_run_id: 501 },
    });
  });

  test("a closed task's complete that was not queued is retried next run", async () => {
    const h = harness({
      closed: [
        {
          id: 43,
          name: "z",
          metadata: { status: "done", reminder: { origin_id: "reminder:r2" } },
        },
      ],
      execute: () => ({ status: "failed", error_message: "device offline" }),
    });
    await syncTaskReminders(context, h.client);
    expect(h.executed).toHaveLength(1);
    expect(h.updates).toHaveLength(0);
  });
});
