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

describe("Task Collaborator reminder changes", () => {
  test("no changes and nothing to retry touch nothing", async () => {
    const h = harness();
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
    expect(h.listed[0]).toMatchObject({ connection_id: 7 });
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
    for (const status of ["pending", "claimed", "running", "completed"]) {
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
    const recentPages = h.listed.filter((page) => page.created_after);
    expect(recentPages).toHaveLength(2);
    expect(recentPages[1]?.before_id).toBe(2);
  });

  test("a failed earlier create can be retried", async () => {
    for (const status of ["failed", "timeout"]) {
      const h = harness({
        recentCreates: [{ status, input: { notes: marker(key) } }],
      });
      await applyReminderChanges(context([create]), h.client);
      expect(h.executed).toHaveLength(1);
    }
  });

  test("a reaction replay cannot retry its own failed create without a fresh live read", async () => {
    for (const status of ["failed", "timeout"]) {
      const h = harness();
      await applyReminderChanges(context([create]), h.client);
      // The write may have landed even though its receipt was lost.
      h.runs[0].status = status;
      await expect(
        applyReminderChanges(context([create]), h.client)
      ).rejects.toThrow("requires a fresh live read");
      expect(h.runs).toHaveLength(1);
      // A later window can propose it again after checking the live state.
      await applyReminderChanges(atRun(902, [create]), h.client);
      expect(h.runs).toHaveLength(2);
      h.runs[1].status = status;
      await expect(
        applyReminderChanges(context([create]), h.client)
      ).rejects.toThrow("requires a fresh live read");
      expect(h.runs).toHaveLength(2);
    }
  });

  test("the newest failed create retains its proposing window across history filters", async () => {
    const h = harness({
      recentCreates: [
        {
          status: "failed",
          created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
          parent_run_id: 800,
          input: { notes: marker(key) },
        },
        {
          status: "timeout",
          created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
          parent_run_id: 901,
          input: { notes: marker(key) },
        },
      ],
    });
    await expect(
      applyReminderChanges(context([create]), h.client)
    ).rejects.toThrow("requires a fresh live read");
    expect(h.executed).toHaveLength(0);
  });

  test("fresh proposals cannot bypass cancellation or the attempt limit", async () => {
    for (const statuses of [["cancelled"], ["failed", "failed", "failed"]]) {
      for (const change of [
        create,
        { action: "complete", origin_id: "reminder:a" },
      ]) {
        const h = harness({
          recentCreates: statuses.map((status) => ({
            status,
            parent_run_id: 901,
            operation_key:
              change.action === "create"
                ? "create_reminder"
                : "complete_reminder",
            input:
              change.action === "create"
                ? { notes: marker(key) }
                : { origin_id: "reminder:a" },
          })),
        });
        await applyReminderChanges(context([change]), h.client);
        await applyReminderChanges(atRun(902, [change]), h.client);
        expect(h.executed).toHaveLength(0);
      }
    }
  });

  test("retrying the original reaction cannot resend a superseded failed update", async () => {
    const h = harness();
    const old = [{ action: "update", origin_id: "reminder:b", title: "Old" }];
    await applyReminderChanges(atRun(901, old), h.client);
    h.runs[0].status = "failed";
    await applyReminderChanges(
      atRun(902, [{ action: "update", origin_id: "reminder:b", title: "New" }]),
      h.client
    );
    await applyReminderChanges(atRun(901, old), h.client);
    expect(h.executed).toHaveLength(2);
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

  test("a run created between history pages does not shift a failure into a second count", async () => {
    const recentCreates: Array<Record<string, unknown>> = [
      { status: "completed", input: { notes: "lobu:other|x|y" } },
      { status: "failed", input: { notes: marker(key) } },
      { status: "completed", input: { notes: "lobu:other|x|z" } },
    ];
    const h = harness({
      pageSize: 1,
      recentCreates,
      beforePage: (page) => {
        if (page === 2)
          h.runs.unshift({
            id: 99,
            created_at: new Date(Date.now() + 1000).toISOString(),
            status: "completed",
            operation_key: "create_reminder",
            input: { notes: "lobu:new|x|y" },
          });
      },
    });
    await applyReminderChanges(context([create]), h.client);
    expect(String(h.executed[0]?.idempotency_key).endsWith(":1")).toBe(true);
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
        operations: {
          listAvailable: async () => ({
            operations: [{ execution_targets: [{ connection_id: 7 }] }],
          }),
          listRuns: async () => {
            const runs = ledger.map(({ status, input, parent }) => ({
              status,
              input,
              operation_key: "create_reminder",
              parent_run_id: parent,
              automation_id: 71,
            }));
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

  test("orders completions and updates per reminder on its newest write", async () => {
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
    expect(
      h.executed.map(({ operation_key, input }) => ({ operation_key, input }))
    ).toEqual([
      {
        operation_key: "complete_reminder",
        input: { origin_id: "reminder:a" },
      },
      {
        operation_key: "update_reminder",
        input: { origin_id: "reminder:b", due: "2026-10-21T09:00:00Z" },
      },
    ]);
    const keys = h.executed.map((call) => String(call.idempotency_key));
    expect(keys.map((key) => key.split(":").slice(0, 3))).toEqual([
      ["task-reminders", "write", "7"],
      ["task-reminders", "write", "7"],
    ]);
    // Neither reminder had a write yet, so both order on the read horizon.
    expect(keys.every((key) => /:h\d{4}-\d{2}-\d{2}$/.test(key))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a reaction's second write to a reminder orders on its first", async () => {
    const h = harness();
    await applyReminderChanges(
      context([
        { action: "update", origin_id: "reminder:a", title: "Renamed" },
        { action: "complete", origin_id: "reminder:a" },
      ]),
      h.client
    );
    expect(h.runs).toHaveLength(2);
    expect(
      String(h.executed[1]?.idempotency_key).endsWith(
        `:${String(h.runs[0].id).padStart(20, "0")}`
      )
    ).toBe(true);
  });

  test("a reaction never resends an earlier window's failed write by itself", async () => {
    const h = harness();
    await applyReminderChanges(
      context([{ action: "complete", origin_id: "reminder:a" }]),
      h.client
    );
    // The Mac fails the queued write after the reaction finished.
    h.runs[0].status = "failed";
    await applyReminderChanges(atRun(902, []), h.client);
    expect(h.executed).toHaveLength(1);
  });

  test("the agent's re-proposal of a failed write orders on the failure", async () => {
    const change = { action: "complete", origin_id: "reminder:a" };
    const h = harness();
    await applyReminderChanges(atRun(901, [change]), h.client);
    h.runs[0].status = "failed";
    await applyReminderChanges(atRun(902, [change]), h.client);
    const [first, retry] = h.executed.map((call) =>
      String(call.idempotency_key)
    );
    expect(retry).not.toBe(first);
    expect(retry.endsWith(`:${String(h.runs[0].id).padStart(20, "0")}`)).toBe(
      true
    );
    expect(h.runs.map((run) => run.status)).toEqual(["failed", "pending"]);
  });

  test("later windows do not duplicate an identical unsettled write", async () => {
    for (const status of ["pending", "claimed", "running"]) {
      for (const change of [
        { action: "complete", origin_id: "reminder:a" },
        { action: "update", origin_id: "reminder:a", title: "New" },
      ]) {
        const h = harness();
        await applyReminderChanges(atRun(901, [change]), h.client);
        h.runs[0].status = status;
        await applyReminderChanges(atRun(902, [change]), h.client);
        expect(h.runs).toHaveLength(1);
        // Once settled, new live evidence may require the same correction again.
        h.runs[0].status = "completed";
        await applyReminderChanges(atRun(903, [change]), h.client);
        expect(h.runs).toHaveLength(2);
      }
    }
  });

  test("a newer write to a field waits while an older one awaits approval", async () => {
    const h = harness({
      execute: async () => ({ status: "pending_approval" }),
    });
    await applyReminderChanges(
      atRun(901, [{ action: "update", origin_id: "reminder:a", title: "Old" }]),
      h.client
    );
    const newer = atRun(902, [
      { action: "update", origin_id: "reminder:a", title: "New" },
      {
        action: "update",
        origin_id: "reminder:a",
        due: "2026-10-21T09:00:00Z",
      },
      { action: "complete", origin_id: "reminder:b" },
    ]);
    await expect(applyReminderChanges(newer, h.client)).rejects.toThrow(
      "Waiting for an earlier write to reminder:a to settle"
    );
    // Other fields and other reminders are not held.
    expect(h.runs.map((run) => run.input)).toEqual([
      { origin_id: "reminder:a", title: "Old" },
      { origin_id: "reminder:a", due: "2026-10-21T09:00:00Z" },
      { origin_id: "reminder:b" },
    ]);
    // Approved and applied, the older write no longer holds the newer one.
    h.runs[0].status = "completed";
    h.runs[0].approval_status = "approved";
    await applyReminderChanges(newer, h.client);
    expect(h.runs.at(-1)?.input).toEqual({
      origin_id: "reminder:a",
      title: "New",
    });
  });

  test.each([
    "pending_approval",
    "in_progress",
  ])("a reaction holds its own second write while the first is %s", async (status) => {
    const h = harness({
      execute: async () => ({ status }),
    });
    await expect(
      applyReminderChanges(
        context([
          { action: "update", origin_id: "reminder:a", title: "First" },
          { action: "update", origin_id: "reminder:a", title: "Last" },
        ]),
        h.client
      )
    ).rejects.toThrow("Waiting for an earlier write");
    expect(h.runs).toHaveLength(1);
  });

  test("a newer write waits for older writes to settle even without an approval", async () => {
    for (const status of ["pending", "claimed", "running"]) {
      const h = harness();
      await applyReminderChanges(
        atRun(901, [
          { action: "update", origin_id: "reminder:a", title: "Old" },
        ]),
        h.client
      );
      h.runs[0].status = status;
      const newer = atRun(902, [
        { action: "update", origin_id: "reminder:a", title: "New" },
      ]);
      // The daemon has multiple execution slots: claim order is not effect order.
      await expect(applyReminderChanges(newer, h.client)).rejects.toThrow(
        "Waiting for an earlier write"
      );
      expect(h.runs).toHaveLength(1);
      h.runs[0].status = "completed";
      await applyReminderChanges(newer, h.client);
      expect(h.runs.at(-1)?.input).toEqual({
        origin_id: "reminder:a",
        title: "New",
      });
    }
  });

  test("an intervening different write allows a fresh correction", async () => {
    const h = harness();
    for (const [index, title] of ["Old", "New", "Old"].entries()) {
      await applyReminderChanges(
        atRun(901 + index, [
          { action: "update", origin_id: "reminder:a", title },
        ]),
        h.client
      );
      h.runs[index].status = "completed";
    }
    expect(h.runs.map((run) => (run.input as { title: string }).title)).toEqual(
      ["Old", "New", "Old"]
    );
  });

  test("re-proposals of a write that keeps failing stop after three attempts", async () => {
    for (const change of [
      create,
      { action: "complete", origin_id: "reminder:a" },
    ]) {
      const h = harness();
      await applyReminderChanges(atRun(901, [change]), h.client);
      for (const runId of [902, 903, 904, 905]) {
        h.runs.at(-1)!.status = "failed";
        await applyReminderChanges(atRun(runId, [change]), h.client);
      }
      expect(h.runs).toHaveLength(3);
    }
  });

  test("of two reactions that read the same state, the newer window's update wins in either order", async () => {
    for (const newerFirst of [true, false]) {
      const h = harness();
      const execute = h.client.operations.execute;
      const update = (runId: number, title: string) =>
        applyReminderChanges(
          atRun(runId, [{ action: "update", origin_id: "reminder:b", title }]),
          h.client
        );
      // The other reaction runs to completion after this one read history,
      // just before this one dispatches.
      let interleaved = false;
      h.client.operations.execute = (async (input: Execute) => {
        const run = input.automation_source?.run_id;
        if (!interleaved && run === (newerFirst ? 901 : 902)) {
          interleaved = true;
          await (newerFirst ? update(902, "New") : update(901, "Old"));
        }
        return execute(input);
      }) as typeof execute;
      const first = newerFirst ? update(901, "Old") : update(902, "New");
      if (newerFirst) await first;
      else {
        // The older write won the shared key, so the newer one fails and its
        // reaction retry orders on top of it after it finishes.
        await expect(first).rejects.toThrow("synthetic key conflict");
        h.runs[0].status = "completed";
        await update(902, "New");
      }
      expect(
        h.runs.map((run) => (run.input as { title: string }).title)
      ).toEqual(newerFirst ? ["New"] : ["Old", "New"]);
    }
  });

  test("a newer write to other fields of a reminder does not cancel a failed one", async () => {
    const h = harness();
    const original = {
      action: "update",
      origin_id: "reminder:b",
      title: "Renamed",
      due: "2026-10-20T09:00:00Z",
    };
    await applyReminderChanges(atRun(901, [original]), h.client);
    h.runs[0].status = "failed";
    await applyReminderChanges(
      atRun(902, [
        {
          action: "update",
          origin_id: "reminder:b",
          due: "2026-10-21T09:00:00Z",
        },
      ]),
      h.client
    );
    // A stale re-proposal of the original sets only the title; the due date
    // keeps the newer value.
    await applyReminderChanges(atRun(901, [original]), h.client);
    expect(h.runs.map((run) => run.input)).toEqual([
      {
        origin_id: "reminder:b",
        title: "Renamed",
        due: "2026-10-20T09:00:00Z",
      },
      { origin_id: "reminder:b", due: "2026-10-21T09:00:00Z" },
      { origin_id: "reminder:b", title: "Renamed" },
    ]);
  });

  test("trimming superseded fields cannot revive an admitted or cancelled update", async () => {
    for (const status of [
      "pending",
      "claimed",
      "running",
      "completed",
      "cancelled",
    ]) {
      const h = harness();
      const original = {
        action: "update",
        origin_id: "reminder:b",
        title: "Original title",
        due: "2026-10-20T09:00:00Z",
      };
      await applyReminderChanges(atRun(901, [original]), h.client);
      h.runs[0].status = "completed";
      await applyReminderChanges(
        atRun(902, [
          {
            action: "update",
            origin_id: "reminder:b",
            due: "2026-10-21T09:00:00Z",
          },
        ]),
        h.client
      );
      // Also exercise old ledger states admitted before conflicting writes
      // were made to wait for completion.
      h.runs[0].status = status;
      await applyReminderChanges(atRun(901, [original]), h.client);
      expect(h.runs).toHaveLength(2);
    }
  });

  test("trimming superseded fields cannot reset an exhausted update's attempt limit", async () => {
    const original = {
      action: "update",
      origin_id: "reminder:b",
      title: "Original title",
      due: "2026-10-20T09:00:00Z",
    };
    const h = harness();
    await applyReminderChanges(atRun(901, [original]), h.client);
    for (const runId of [902, 903]) {
      h.runs.at(-1)!.status = "failed";
      await applyReminderChanges(atRun(runId, [original]), h.client);
    }
    h.runs.at(-1)!.status = "failed";
    await applyReminderChanges(
      atRun(904, [
        {
          action: "update",
          origin_id: "reminder:b",
          due: "2026-10-21T09:00:00Z",
        },
      ]),
      h.client
    );
    // Its title alone is a different input, but the original is exhausted.
    await applyReminderChanges(atRun(905, [original]), h.client);
    expect(h.runs).toHaveLength(4);
    expect(h.runs[3].input).toEqual({
      origin_id: "reminder:b",
      due: "2026-10-21T09:00:00Z",
    });
  });

  test("an older proposal whose dispatch never reached the ledger cannot overwrite a newer window", async () => {
    let refuse = true;
    const h = harness({ refuse: () => refuse });
    const runA = [{ action: "update", origin_id: "reminder:b", title: "Old" }];
    await expect(
      applyReminderChanges(atRun(901, runA), h.client)
    ).rejects.toThrow("synthetic dispatch refusal");
    refuse = false;
    await applyReminderChanges(
      atRun(902, [{ action: "update", origin_id: "reminder:b", title: "New" }]),
      h.client
    );
    await applyReminderChanges(atRun(901, runA), h.client);
    expect(h.runs.map((run) => (run.input as { title: string }).title)).toEqual(
      ["New"]
    );
  });

  test("a retried reaction replays its earlier writes instead of overwriting a newer change", async () => {
    let failComplete = true;
    const h = harness({
      execute: async ({ operation_key }) => {
        if (operation_key === "complete_reminder" && failComplete)
          throw new Error("synthetic dispatch failure");
        return { status: "in_progress" };
      },
    });
    const runA = [
      { action: "update", origin_id: "reminder:b", title: "Old" },
      { action: "complete", origin_id: "reminder:a" },
    ];
    await expect(
      applyReminderChanges(atRun(901, runA), h.client)
    ).rejects.toThrow("synthetic dispatch failure");
    h.runs[0].status = "completed";
    await applyReminderChanges(
      atRun(902, [{ action: "update", origin_id: "reminder:b", title: "New" }]),
      h.client
    );
    failComplete = false;
    await applyReminderChanges(atRun(901, runA), h.client);
    const updates = h.runs.filter(
      (run) => run.operation_key === "update_reminder"
    );
    expect(
      updates.map((run) => (run.input as { title: string }).title)
    ).toEqual(["Old", "New"]);
    expect(
      h.runs.filter((run) => run.operation_key === "complete_reminder")
    ).toHaveLength(1);
  });

  test("a failed write superseded by a newer change to the same reminder is not retried", async () => {
    const h = harness();
    await applyReminderChanges(
      atRun(901, [{ action: "update", origin_id: "reminder:b", title: "Old" }]),
      h.client
    );
    h.runs[0].status = "failed";
    await applyReminderChanges(
      atRun(902, [{ action: "update", origin_id: "reminder:b", title: "New" }]),
      h.client
    );
    await applyReminderChanges(atRun(903, []), h.client);
    expect(h.executed).toHaveLength(2);
  });

  test("a new proposal replaces a failed update without queuing both versions", async () => {
    const h = harness();
    await applyReminderChanges(
      atRun(901, [{ action: "update", origin_id: "reminder:a", title: "Old" }]),
      h.client
    );
    h.runs[0].status = "failed";
    await applyReminderChanges(
      atRun(902, [{ action: "update", origin_id: "reminder:a", title: "New" }]),
      h.client
    );
    expect(h.runs.map((run) => (run.input as { title: string }).title)).toEqual(
      ["Old", "New"]
    );
  });

  test("a historical matching success cannot hide a fresh dispatch failure", async () => {
    const h = harness({
      recentCreates: [
        {
          status: "completed",
          operation_key: "update_reminder",
          input: { origin_id: "reminder:a", title: "Old" },
        },
      ],
      execute: async () => {
        throw new Error("synthetic dispatch failure");
      },
    });
    await expect(
      applyReminderChanges(
        context([{ action: "update", origin_id: "reminder:a", title: "Old" }]),
        h.client
      )
    ).rejects.toThrow("synthetic dispatch failure");
  });

  test("another Automation's matching success cannot hide a dispatch failure", async () => {
    const h = harness({
      recentCreates: [
        {
          automation_id: 72,
          status: "completed",
          operation_key: "update_reminder",
          input: { origin_id: "reminder:a", title: "New" },
        },
      ],
      refuse: () => true,
    });
    await expect(
      applyReminderChanges(
        context([{ action: "update", origin_id: "reminder:a", title: "New" }]),
        h.client
      )
    ).rejects.toThrow("synthetic dispatch refusal");
  });

  test("newer cancellations supersede failures even at the same timestamp", async () => {
    const created_at = new Date().toISOString();
    const h = harness({
      recentCreates: [
        {
          id: 1,
          created_at,
          status: "failed",
          operation_key: "update_reminder",
          input: { origin_id: "reminder:a", title: "Old" },
        },
        {
          id: 2,
          created_at,
          status: "cancelled",
          operation_key: "update_reminder",
          input: { origin_id: "reminder:a", title: "New" },
        },
      ],
    });
    // A replay of the failed write's own window must not undo the newer write.
    await applyReminderChanges(
      atRun(800, [{ action: "update", origin_id: "reminder:a", title: "Old" }]),
      h.client
    );
    expect(h.executed).toHaveLength(0);
  });

  test("refuses a window older than the history horizon instead of replaying it", async () => {
    const h = harness({
      recentCreates: [
        {
          status: "completed",
          created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
          operation_key: "update_reminder",
          input: { origin_id: "reminder:a", title: "New" },
        },
      ],
    });
    const old = atRun(800, [
      { action: "update", origin_id: "reminder:a", title: "Old" },
      create,
    ]);
    old.window.window_end = new Date(Date.now() - 4 * 86400000).toISOString();
    await expect(applyReminderChanges(old, h.client)).rejects.toThrow(
      "older than the reminder history horizon"
    );
    expect(h.executed).toHaveLength(0);
  });

  test("a person's correction outside any Automation orders the reminder too", async () => {
    const h = harness();
    const stale = [{ action: "update", origin_id: "reminder:a", title: "Old" }];
    await applyReminderChanges(atRun(901, stale), h.client);
    h.runs[0].status = "failed";
    h.runs.push({
      id: 5000,
      created_at: new Date(Date.now() + 60000).toISOString(),
      operation_key: "update_reminder",
      parent_run_id: null,
      automation_id: null,
      status: "completed",
      input: { origin_id: "reminder:a", title: "Corrected" },
    });
    // Replaying the failed window cannot undo the correction.
    await applyReminderChanges(atRun(901, stale), h.client);
    expect(h.executed).toHaveLength(1);
  });

  test("a person's correction after the window's evidence wins over its first dispatch", async () => {
    const correction = {
      created_at: new Date(Date.now() - 60000).toISOString(),
      operation_key: "update_reminder",
      parent_run_id: null,
      automation_id: null,
      status: "completed",
      input: { origin_id: "reminder:a", title: "Corrected" },
    };
    const h = harness({ recentCreates: [correction] });
    const stale = atRun(901, [
      { action: "update", origin_id: "reminder:a", title: "Old", due: null },
    ]);
    stale.window.window_end = new Date(Date.now() - 3600000).toISOString();
    await applyReminderChanges(stale, h.client);
    // Only the field the person did not touch is written.
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0].input).toEqual({ origin_id: "reminder:a", due: null });
  });

  test("a retry whose first dispatch never reached the ledger yields to a later correction", async () => {
    let refuse = true;
    const h = harness({ refuse: () => refuse });
    const stale = atRun(901, [
      { action: "update", origin_id: "reminder:a", title: "Old" },
    ]);
    stale.window.window_end = new Date(Date.now() - 3600000).toISOString();
    await expect(applyReminderChanges(stale, h.client)).rejects.toThrow(
      "synthetic dispatch refusal"
    );
    refuse = false;
    h.runs.push({
      id: 5000,
      created_at: new Date().toISOString(),
      operation_key: "update_reminder",
      parent_run_id: null,
      automation_id: null,
      status: "completed",
      input: { origin_id: "reminder:a", title: "Corrected" },
    });
    await applyReminderChanges(stale, h.client);
    // Only the refused first dispatch was ever attempted.
    expect(h.executed).toHaveLength(1);
  });

  test("a correction the window already read does not suppress its write", async () => {
    const h = harness({
      recentCreates: [
        {
          created_at: new Date(Date.now() - 7200000).toISOString(),
          operation_key: "update_reminder",
          parent_run_id: null,
          automation_id: null,
          status: "completed",
          input: { origin_id: "reminder:a", title: "Corrected" },
        },
      ],
    });
    const window = atRun(901, [
      { action: "update", origin_id: "reminder:a", title: "Newer" },
    ]);
    window.window.window_end = new Date(Date.now() - 3600000).toISOString();
    await applyReminderChanges(window, h.client);
    expect(h.executed).toHaveLength(1);
  });

  test("personal writes with a connector parent are ordered by evidence time", async () => {
    for (const parentRunId of [800, 1200]) {
      for (const afterEvidence of [true, false]) {
        const h = harness({
          recentCreates: [
            {
              created_at: new Date(
                Date.now() - (afterEvidence ? 60000 : 7200000)
              ).toISOString(),
              operation_key: "update_reminder",
              parent_run_id: parentRunId,
              automation_id: null,
              status: "completed",
              input: { origin_id: "reminder:a", title: "Corrected" },
            },
          ],
        });
        const window = atRun(901, [
          { action: "update", origin_id: "reminder:a", title: "New" },
        ]);
        window.window.window_end = new Date(Date.now() - 3600000).toISOString();
        await applyReminderChanges(window, h.client);
        expect(h.executed).toHaveLength(afterEvidence ? 0 : 1);
      }
    }
  });

  test("bare and prefixed reminder IDs share correction and pending-write guards", async () => {
    for (const priorOrigin of ["a", "reminder:a", " reminder:a "]) {
      for (const proposedOrigin of ["a", "reminder:a"]) {
        const h = harness({
          recentCreates: [
            {
              created_at: new Date(Date.now() - 60000).toISOString(),
              operation_key: "update_reminder",
              parent_run_id: null,
              automation_id: null,
              status: "pending",
              input: { origin_id: priorOrigin, title: "Corrected" },
            },
          ],
        });
        const window = atRun(901, [
          { action: "update", origin_id: proposedOrigin, title: "Old" },
        ]);
        window.window.window_end = new Date(Date.now() - 3600000).toISOString();
        await applyReminderChanges(window, h.client);
        expect(h.executed).toHaveLength(0);
        window.window.window_end = new Date().toISOString();
        await expect(applyReminderChanges(window, h.client)).rejects.toThrow(
          "Waiting for an earlier write"
        );
        expect(h.executed).toHaveLength(0);
      }
    }
  });

  test("completion aliases reuse an active write and retry its failed attempt", async () => {
    const h = harness({
      recentCreates: [
        {
          operation_key: "complete_reminder",
          input: { origin_id: "a" },
        },
      ],
    });
    await applyReminderChanges(
      atRun(901, [{ action: "complete", origin_id: "reminder:a" }]),
      h.client
    );
    expect(h.executed).toHaveLength(0);
    h.runs[0].status = "failed";
    await applyReminderChanges(
      atRun(902, [{ action: "complete", origin_id: "a" }]),
      h.client
    );
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0].input).toEqual({ origin_id: "reminder:a" });
  });

  test("a cancelled write or one out of attempts is not retried", async () => {
    for (const statuses of [["cancelled"], ["failed", "failed", "failed"]]) {
      const h = harness({
        recentCreates: statuses.map((status) => ({
          status,
          operation_key: "complete_reminder",
          input: { origin_id: "reminder:a" },
        })),
      });
      await applyReminderChanges(atRun(902, []), h.client);
      expect(h.executed).toHaveLength(0);
    }
  });

  test("another Automation's failed writes are left alone", async () => {
    const h = harness({
      recentCreates: [
        {
          status: "failed",
          automation_id: 72,
          operation_key: "complete_reminder",
          input: { origin_id: "reminder:a" },
        },
      ],
    });
    await applyReminderChanges(atRun(902, []), h.client);
    expect(h.executed).toHaveLength(0);
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
