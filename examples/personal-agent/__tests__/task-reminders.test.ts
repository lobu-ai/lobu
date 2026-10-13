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

// The fake answers each of the four task queries by the clause that
// distinguishes it, so a query that drifts from its intent returns nothing.
function harness(options: {
  connections?: Array<{ id: number }>;
  creating?: Row[];
  completing?: Row[];
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
      if (sql.includes("'complete_run_id' IS NOT NULL"))
        return options.completing ?? [];
      if (sql.includes("'complete_run_id' IS NULL"))
        return options.closed ?? [];
      if (sql.includes("'create_failed' IS NULL"))
        return options.creating ?? [];
      if (sql.includes("metadata->'reminder' IS NULL"))
        return options.unlinked ?? [];
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
  const sql = (clause: string) => queries.find((q) => q.includes(clause));
  return { client, executed, updates, sql, queries };
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
const closedLinked = (id: number, reminder: Record<string, unknown>): Row => ({
  id,
  name: "closed",
  metadata: { status: "done", reminder },
});

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
    const create = h.sql("metadata->'reminder' IS NULL");
    expect(create).toContain("IS DISTINCT FROM 'connection:7'");
    expect(create).toContain("NOT IN ('done', 'dismissed')");
    expect(create).toContain("'due_date' IS NOT NULL");
  });

  test("settles queued creates: links success, retires every failure, waits otherwise", async () => {
    const h = harness({
      creating: [
        { id: 21, name: "a", metadata: { reminder: { run_id: 31 } } },
        { id: 22, name: "b", metadata: { reminder: { run_id: 32 } } },
        { id: 23, name: "c", metadata: { reminder: { run_id: 33 } } },
        { id: 24, name: "d", metadata: { reminder: { run_id: 34 } } },
      ],
      runs: {
        31: { status: "completed", output: { origin_id: "reminder:abc" } },
        32: { status: "pending", approval_status: "pending" },
        33: { status: "cancelled", approval_status: "rejected" },
        34: { status: "timeout", approval_status: "approved" },
      },
    });
    await syncTaskReminders(context, h.client);
    expect(h.updates).toEqual([
      {
        entity_id: 21,
        metadata: { reminder: { run_id: 31, origin_id: "reminder:abc" } },
      },
      {
        entity_id: 23,
        metadata: { reminder: { run_id: 33, create_failed: true } },
      },
      {
        entity_id: 24,
        metadata: { reminder: { run_id: 34, create_failed: true } },
      },
    ]);
    expect(h.executed).toHaveLength(0);
  });

  test("a retired create leaves the pending batch, so later creates still settle", async () => {
    const h = harness({});
    await syncTaskReminders(context, h.client);
    expect(h.sql("'create_failed' IS NULL")).toContain("'origin_id' IS NULL");
  });

  test("completes the linked reminder of a closed task", async () => {
    const h = harness({
      closed: [closedLinked(41, { run_id: 9, origin_id: "reminder:r1" })],
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
            complete_settled: true,
          },
        },
      },
    ]);
  });

  test("tracks a completion awaiting approval instead of settling it", async () => {
    const h = harness({
      closed: [closedLinked(42, { origin_id: "reminder:r2" })],
      execute: () => ({ status: "pending_approval", run_id: 88 }),
    });
    await syncTaskReminders(context, h.client);
    expect(h.updates[0]?.metadata).toEqual({
      reminder: { origin_id: "reminder:r2", complete_run_id: 88 },
    });
  });

  test("settles queued completions and reopens a failed one for retry", async () => {
    const h = harness({
      completing: [
        closedLinked(51, { origin_id: "reminder:a", complete_run_id: 61 }),
        closedLinked(52, { origin_id: "reminder:b", complete_run_id: 62 }),
        closedLinked(53, { origin_id: "reminder:c", complete_run_id: 63 }),
        closedLinked(54, { origin_id: "reminder:d", complete_run_id: 64 }),
      ],
      runs: {
        61: { status: "completed" },
        62: { status: "cancelled", approval_status: "rejected" },
        63: { status: "failed", approval_status: "approved" },
        64: { status: "pending", approval_status: "pending" },
      },
    });
    await syncTaskReminders(context, h.client);
    expect(h.updates).toEqual([
      {
        entity_id: 51,
        metadata: {
          reminder: {
            origin_id: "reminder:a",
            complete_run_id: 61,
            complete_settled: true,
          },
        },
      },
      {
        entity_id: 52,
        metadata: {
          reminder: {
            origin_id: "reminder:b",
            complete_run_id: 62,
            complete_settled: true,
          },
        },
      },
      { entity_id: 53, metadata: { reminder: { origin_id: "reminder:c" } } },
    ]);
  });

  test("only closed tasks with no queued or settled completion are completed", async () => {
    const h = harness({});
    await syncTaskReminders(context, h.client);
    const complete = h.sql("'complete_run_id' IS NULL");
    expect(complete).toContain("'complete_settled' IS NULL");
    expect(complete).toContain("IN ('done', 'dismissed')");
  });

  test("completes the source reminder of a closed task that came from Reminders", async () => {
    const h = harness({
      closed: [
        {
          id: 43,
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
      reminder: { origin_id: "reminder:src", complete_settled: true },
    });
  });

  test("an unqueued completion is retried next run", async () => {
    const h = harness({
      closed: [closedLinked(44, { origin_id: "reminder:r3" })],
      execute: () => ({ status: "failed", error_message: "device offline" }),
    });
    await syncTaskReminders(context, h.client);
    expect(h.executed).toHaveLength(1);
    expect(h.updates).toHaveLength(0);
  });
});
