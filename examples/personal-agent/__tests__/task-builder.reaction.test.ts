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
      slug: "task-collaborator",
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
    pageSize?: number;
    execute?: (input: Execute) => Promise<Record<string, unknown>>;
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
        const runs = (options.recentCreates ?? []).filter((run) => {
          if (input.status && run.status !== input.status) return false;
          if (
            input.created_after &&
            run.created_at &&
            String(run.created_at) < input.created_after
          )
            return false;
          if (
            input.created_before &&
            String(run.created_at ?? new Date().toISOString()) >=
              input.created_before
          )
            return false;
          return true;
        });
        const { offset = 0 } = input as { offset?: number };
        const size = options.pageSize ?? runs.length;
        return {
          runs: runs.slice(offset, offset + size),
          has_more: offset + size < runs.length,
        };
      },
      execute: async (input: Execute) => {
        executed.push(input);
        if (options.execute) return options.execute(input);
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
        idempotency_key: expect.any(String),
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

  test("reads every page of earlier creates", async () => {
    const other = { status: "completed", input: { notes: "lobu:other|x|y" } };
    const h = harness({
      pageSize: 2,
      recentCreates: [
        other,
        other,
        { status: "pending", input: { notes: marker(key) } },
      ],
    });
    await applyReminderChanges(context([create]), h.client);
    expect(h.executed).toHaveLength(0);
    expect(
      h.listed.filter((page) => page.created_after).map((page) => page.offset)
    ).toEqual([0, 2]);
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

  test("keeps old pending and running creates deduplicated until they settle", async () => {
    for (const status of ["pending", "running", "claimed"]) {
      const h = harness({
        pageSize: 1,
        recentCreates: [
          {
            status,
            created_at: new Date(
              Date.now() - 3 * 24 * 60 * 60 * 1000
            ).toISOString(),
            input: { notes: "lobu:other|x|y" },
          },
          {
            status,
            created_at: new Date(
              Date.now() - 4 * 24 * 60 * 60 * 1000
            ).toISOString(),
            input: { notes: marker(key) },
          },
        ],
      });
      await applyReminderChanges(context([create]), h.client);
      expect(h.executed).toHaveLength(0);
    }
  });

  test("preserves the source marker within the connector's notes limit", async () => {
    const h = harness();
    await applyReminderChanges(
      context([{ ...create, notes: "x".repeat(4000) }]),
      h.client
    );
    const notes = h.executed[0]?.input?.notes as string;
    expect(notes.length).toBeLessThanOrEqual(4000);
    expect(notes.endsWith(marker(key))).toBe(true);
  });

  test("reports failed dispatches after attempting the remaining changes", async () => {
    for (const failure of ["failed", "timeout", "throw"]) {
      const h = harness({
        execute: async ({ operation_key }) => {
          if (operation_key === "complete_reminder") {
            if (failure === "throw")
              throw new Error("synthetic dispatch failure");
            return {
              status: failure,
              error_message: "synthetic dispatch failure",
            };
          }
          return { status: "in_progress", run_id: 999 };
        },
      });
      await expect(
        applyReminderChanges(
          context([
            { action: "complete", origin_id: "reminder:a" },
            { action: "update", origin_id: "reminder:b", title: "Reply" },
          ]),
          h.client
        )
      ).rejects.toThrow("synthetic dispatch failure");
      expect(h.executed).toHaveLength(2);
    }
  });

  test("refuses a blank title or a key that would break the marker line", async () => {
    const bad = [
      { ...create, title: "   " },
      ...Object.keys(key).flatMap((field) =>
        ["bad|key", "bad\nkey"].map((value) => ({
          ...create,
          key: { ...key, [field]: value },
        }))
      ),
    ];
    const h = harness();
    await expect(
      applyReminderChanges(
        context([...bad, { action: "complete", origin_id: "reminder:a" }]),
        h.client
      )
    ).rejects.toThrow("marker separator");
    expect(h.executed.map((input) => input.operation_key)).toEqual([
      "complete_reminder",
    ]);
  });

  test("checks unsettled creates of any age", async () => {
    const h = harness();
    await applyReminderChanges(context([create]), h.client);
    expect(
      h.listed.filter((page) => page.status).map((page) => page.status)
    ).toEqual([
      "pending",
      "running",
      "claimed",
      "failed",
      "timeout",
      "cancelled",
    ]);
  });

  test("a create's key is shared across runs and fits the key limit", async () => {
    const keys: string[] = [];
    for (const runId of [901, 902]) {
      const h = harness();
      await applyReminderChanges(
        {
          ...context([{ ...create, notes: "x".repeat(3000) }]),
          window: { ...context([]).window, run_id: runId },
        } as ReactionContext,
        h.client
      );
      keys.push(String(h.executed[0]?.idempotency_key));
    }
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0].startsWith("task-reminders:create:7:")).toBe(true);
    expect(keys[0].endsWith(":0")).toBe(true);
    expect(keys[0].length).toBeLessThanOrEqual(256);
  });

  test("each earlier failure moves a retried create to a fresh key", async () => {
    const failed = { status: "failed", input: { notes: marker(key) } };
    const h = harness({
      recentCreates: [failed, { ...failed, status: "timeout" }],
    });
    await applyReminderChanges(context([create]), h.client);
    expect(String(h.executed[0]?.idempotency_key).endsWith(":2")).toBe(true);
  });

  test("concurrent runs create a source's reminder once", async () => {
    // Shared operation state: the server admits one run per idempotency key and
    // refuses the same key from a different parent run.
    let reads = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ledger: Array<{
      key: string;
      parent: number;
      status: string;
      input: unknown;
    }> = [];
    const client = (runId: number) =>
      ({
        query: async () => [{ id: 7 }],
        operations: {
          listRuns: async () => {
            const runs = ledger.map(({ status, input }) => ({ status, input }));
            // Both runs read history before either one creates.
            reads++;
            if (reads <= 2) {
              if (reads === 2) release();
              await bothRead;
            }
            return { runs, has_more: false };
          },
          execute: async (input: Execute) => {
            await Promise.resolve();
            const prior = ledger.find(
              (run) => run.key === input.idempotency_key
            );
            if (prior && prior.parent !== runId)
              throw new Error("synthetic key conflict");
            if (!prior)
              ledger.push({
                key: String(input.idempotency_key),
                parent: runId,
                status: "pending",
                input: input.input,
              });
            return { status: "in_progress", run_id: ledger.length };
          },
        },
        log: () => undefined,
      }) as unknown as ReactionClient;
    const run = (runId: number) =>
      applyReminderChanges(
        {
          ...context([create]),
          window: { ...context([]).window, run_id: runId },
        } as ReactionContext,
        client(runId)
      );
    await Promise.all([run(901), run(902)]);
    expect(ledger).toHaveLength(1);
  });

  test("an update can clear a due date", async () => {
    const h = harness();
    await applyReminderChanges(
      context([{ action: "update", origin_id: "reminder:b", due: null }]),
      h.client
    );
    expect(h.executed[0]?.input).toEqual({
      origin_id: "reminder:b",
      due: null,
    });
    expect(
      validate({
        changes: [{ action: "update", origin_id: "reminder:b", due: null }],
      })
    ).toBe(true);
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
      { action: "update", origin_id: "reminder:a", title: "x".repeat(501) },
    ]) {
      expect(validate({ changes: [change] })).toBe(false);
    }
  });
});
