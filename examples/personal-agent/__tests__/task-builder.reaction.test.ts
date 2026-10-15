import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import applyReminderChanges, { input, marker } from "../task-builder.reaction";

type Execute = Parameters<ReactionClient["operations"]["execute"]>[0];
type ListRuns = NonNullable<
  Parameters<ReactionClient["operations"]["listRuns"]>[0]
>;

const context = (changes: unknown[]): ReactionContext =>
  ({
    extracted_data: { changes },
    entities: [],
    window: {
      run_id: 901,
      automation_id: 71,
      window_start: new Date(Date.now() - 2 * 3600000).toISOString(),
      window_end: new Date().toISOString(),
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

type Run = Record<string, unknown> & {
  id: number;
  created_at: string;
  status: string;
};

// The server's run ledger: runs listed newest first by (created_at, id) with a
// keyset, and an idempotency key replays its first run.
function harness(
  options: {
    connections?: Array<{ id: number }>;
    recentCreates?: Array<Record<string, unknown>>;
    pageSize?: number;
    beforePage?: (page: number) => void;
    execute?: (input: Execute) => Promise<Record<string, unknown>>;
    // Refuses a dispatch before the server records any run.
    refuse?: (input: Execute) => boolean;
  } = {}
) {
  const executed: Execute[] = [];
  const listed: ListRuns[] = [];
  const runs: Run[] = (options.recentCreates ?? []).map((run, index) => ({
    id: index + 1,
    created_at: new Date(Date.now() - (index + 10) * 1000).toISOString(),
    operation_key: "create_reminder",
    parent_run_id: 800,
    automation_id: 71,
    status: "pending",
    ...run,
  }));
  let clock = Date.now();
  const client = {
    operations: {
      listAvailable: async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          connector_key: "apple.reminders",
          include_disconnected: false,
        });
        return {
          operations: ["create_reminder", "complete_reminder"].map(
            (operation_key) => ({
              operation_key,
              execution_targets: (options.connections ?? [{ id: 7 }]).map(
                ({ id }) => ({ connection_id: id })
              ),
            })
          ),
        };
      },
      listRuns: async (input: ListRuns) => {
        listed.push(input);
        options.beforePage?.(listed.length);
        const page = runs
          .filter((run) => {
            if (input.status && run.status !== input.status) return false;
            if (input.created_after && run.created_at < input.created_after)
              return false;
            if (input.created_before && run.created_at >= input.created_before)
              return false;
            if (
              input.before_created_at &&
              (run.created_at > input.before_created_at ||
                (run.created_at === input.before_created_at &&
                  run.id >= Number(input.before_id)))
            )
              return false;
            return true;
          })
          .sort(
            (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id
          );
        const size = options.pageSize ?? page.length;
        return { runs: page.slice(0, size), has_more: size < page.length };
      },
      execute: async (input: Execute) => {
        executed.push(input);
        if (options.refuse?.(input))
          throw new Error("synthetic dispatch refusal");
        const prior = runs.find((run) => run.key === input.idempotency_key);
        if (prior) {
          // A reused key replays only the same request; the server 409s otherwise.
          if (
            prior.parent_run_id !== input.automation_source?.run_id ||
            JSON.stringify(prior.input) !== JSON.stringify(input.input)
          )
            throw new Error("synthetic key conflict");
          return { status: prior.status, run_id: prior.id };
        }
        clock += 1000;
        const run: Run = {
          id: 1000 + runs.length,
          created_at: new Date(clock).toISOString(),
          key: input.idempotency_key,
          operation_key: input.operation_key,
          input: input.input,
          parent_run_id: input.automation_source?.run_id,
          automation_id: input.automation_source?.automation_id,
          status: "pending",
        };
        if (options.execute) {
          const result = await options.execute(input);
          run.status = String(
            ["in_progress", "pending_approval"].includes(String(result.status))
              ? "pending"
              : result.status
          );
          if (result.status === "pending_approval")
            run.approval_status = "pending";
          runs.push(run);
          return { ...result, run_id: run.id };
        }
        runs.push(run);
        return { status: "in_progress", run_id: run.id };
      },
    },
    log: () => undefined,
  } as unknown as ReactionClient;
  return { client, executed, listed, runs };
}

const atRun = (runId: number, changes: unknown[]) =>
  ({
    ...context(changes),
    window: { ...context([]).window, run_id: runId },
  }) as ReactionContext;

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

const seen = { title: "Reply to Ana", due: null, completed: false };

describe("Task Collaborator reminder changes", () => {
  test("no changes touch nothing", async () => {
    const h = harness();
    await applyReminderChanges(context([]), h.client);
    expect(h.executed).toHaveLength(0);
    expect(h.listed).toHaveLength(0);
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

  test("requests the Lobu list and includes the reminder's source line", async () => {
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

  test("skips a create already queued or done, even reworded by a later window", async () => {
    for (const status of ["pending", "claimed", "running", "completed"]) {
      const h = harness({
        recentCreates: [
          { status, input: { title: "Old wording", notes: marker(key) } },
        ],
      });
      await applyReminderChanges(atRun(950, [create]), h.client);
      expect(h.executed).toHaveLength(0);
    }
  });

  test("a create proposed again after a failed one is queued", async () => {
    for (const status of ["failed", "timeout", "cancelled"]) {
      const h = harness({
        recentCreates: [{ status, input: { notes: marker(key) } }],
      });
      await applyReminderChanges(atRun(950, [create]), h.client);
      expect(h.executed).toHaveLength(1);
    }
  });

  test("reads every page of earlier creates", async () => {
    const other = { status: "completed", input: { notes: "lobu:other|x|y" } };
    const h = harness({
      pageSize: 2,
      recentCreates: [
        other,
        other,
        other,
        { status: "completed", input: { notes: marker(key) } },
      ],
    });
    await applyReminderChanges(context([create]), h.client);
    expect(h.executed).toHaveLength(0);
  });

  test("a retried reaction replays its writes instead of repeating them", async () => {
    let fail = true;
    const h = harness({
      refuse: (call) => call.operation_key === "update_reminder" && fail,
    });
    const changes = [
      create,
      {
        action: "complete",
        origin_id: "reminder:a",
        expected: { ...seen, title: "A" },
      },
      {
        action: "update",
        origin_id: "reminder:b",
        title: "New",
        expected: { ...seen, title: "B" },
      },
    ];
    await expect(
      applyReminderChanges(context(changes), h.client)
    ).rejects.toThrow("synthetic dispatch refusal");
    fail = false;
    await applyReminderChanges(context(changes), h.client);
    // The create and completion replay their runs; only the update is new.
    expect(h.runs.map((run) => run.operation_key)).toEqual([
      "create_reminder",
      "complete_reminder",
      "update_reminder",
    ]);
  });

  test("updates and completions carry the state they were decided from", async () => {
    const h = harness();
    await applyReminderChanges(
      context([
        {
          action: "update",
          origin_id: "ABC",
          title: "Reply to Ana today",
          due: null,
          expected: seen,
        },
        { action: "complete", origin_id: "reminder:ABC", expected: seen },
      ]),
      h.client
    );
    expect(h.executed.map((call) => call.input)).toEqual([
      {
        origin_id: "reminder:ABC",
        title: "Reply to Ana today",
        due: null,
        expected: seen,
      },
      { origin_id: "reminder:ABC", expected: seen },
    ]);
    expect(h.listed).toHaveLength(0);
  });

  test("a later window sends its own write: the Mac refuses whichever is stale", async () => {
    const h = harness();
    const update = {
      action: "update",
      origin_id: "reminder:a",
      title: "New",
      expected: seen,
    };
    await applyReminderChanges(atRun(901, [update]), h.client);
    await applyReminderChanges(atRun(902, [update]), h.client);
    expect(h.executed).toHaveLength(2);
    expect(h.executed[0].idempotency_key).not.toBe(
      h.executed[1].idempotency_key
    );
  });

  test("the same change proposed twice in one window is sent once", async () => {
    const h = harness();
    await applyReminderChanges(context([create, create]), h.client);
    expect(h.executed).toHaveLength(1);
  });

  test("keys stay within the server's limit", async () => {
    const h = harness();
    await applyReminderChanges(
      context([
        {
          ...create,
          key: { ...key, source_origin_id: "x".repeat(3000) },
        },
      ]),
      h.client
    );
    expect(h.executed[0].idempotency_key?.length).toBeLessThanOrEqual(256);
  });

  test("reports failed dispatches after attempting the remaining changes", async () => {
    const h = harness({
      refuse: (call) => call.operation_key === "create_reminder",
    });
    await expect(
      applyReminderChanges(
        context([
          create,
          { action: "complete", origin_id: "reminder:a", expected: seen },
        ]),
        h.client
      )
    ).rejects.toThrow("Change 0: synthetic dispatch refusal");
    expect(h.executed.map((call) => call.operation_key)).toEqual([
      "create_reminder",
      "complete_reminder",
    ]);
  });

  test("refuses a blank title or a key that would break the marker line", async () => {
    for (const change of [
      { ...create, title: "   " },
      { ...create, key: { ...key, task_key: "a|b" } },
      { ...create, key: { ...key, task_key: "a\nb" } },
    ]) {
      const h = harness();
      await expect(
        applyReminderChanges(context([change]), h.client)
      ).rejects.toThrow();
      expect(h.executed).toHaveLength(0);
    }
  });

  test("preserves the source marker within the connector's notes limit", async () => {
    const h = harness();
    await applyReminderChanges(
      context([{ ...create, notes: "n".repeat(5000) }]),
      h.client
    );
    const notes = String(h.executed[0]?.input?.notes);
    expect(notes.length).toBeLessThanOrEqual(4000);
    expect(notes.endsWith(marker(key))).toBe(true);
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
      { action: "complete", origin_id: "reminder:a", expected: seen },
      {
        action: "update",
        origin_id: "reminder:b",
        title: "New",
        due: null,
        expected: { ...seen, due: "2026-10-20T09:00:00Z" },
      },
    ];
    const data = structuredClone({ changes });
    expect(validate(data)).toBe(true);
    expect(data).toEqual({ changes });
  });

  test("the host's validator rejects deletes, incomplete changes and writes without their read state", () => {
    for (const change of [
      { action: "delete", origin_id: "reminder:a" },
      { action: "create", key },
      { action: "complete" },
      { action: "complete", origin_id: "reminder:a" },
      { action: "update", origin_id: "reminder:a", title: "x" },
      {
        action: "update",
        origin_id: "reminder:a",
        title: "x",
        expected: { title: "y" },
      },
      { action: "create", key, title: "x", due: "tomorrow" },
      {
        action: "update",
        origin_id: "reminder:a",
        title: "x".repeat(501),
        expected: seen,
      },
    ]) {
      expect(validate({ changes: [change] })).toBe(false);
    }
  });
});
