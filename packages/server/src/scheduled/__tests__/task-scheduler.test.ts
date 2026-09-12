/**
 * Unit tests for TaskScheduler. The dispatch loop and DB-backed claim are
 * exercised end-to-end by RunsQueue integration tests; this file pins the
 * scheduler-specific automation using a mock IMessageQueue:
 *
 *  - register() rejects duplicates and post-start additions
 *  - spawn() encodes name/payload + sets actionKey for observability
 *  - start() seeds cron rows for periodic registrations
 *  - dispatch() routes to the registered handler
 *  - dispatch() seeds the next cron tick BEFORE running the handler so a
 *    crashing handler doesn't strand future ticks
 *  - dispatch() throws on unknown task names (so the runs-queue marks fail/retry)
 */

import { describe, expect, test } from "bun:test";
import type {
  IMessageQueue,
  JobHandler,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "../../gateway/infrastructure/queue/types";
import type { DbClient } from "../../db/client";
import {
  enqueueTasksInTransaction,
  TaskScheduler,
} from "../task-scheduler";
import {
  AUTOMATION_REACTION_TASK,
  AUTOMATION_REACTION_TASK_QUEUE,
  NOTIFICATION_DELIVERY_TASK,
  NOTIFICATION_DELIVERY_TASK_QUEUE,
} from "../task-definitions";

interface SentRecord {
  queueName: string;
  data: unknown;
  options?: QueueOptions;
}

class FakeQueue implements IMessageQueue {
  sent: SentRecord[] = [];
  workers = new Map<string, JobHandler>();
  private idCounter = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createQueue(): Promise<void> {}

  async send<T>(
    queueName: string,
    data: T,
    options?: QueueOptions,
  ): Promise<string> {
    this.sent.push({ queueName, data, options });
    this.idCounter += 1;
    return String(this.idCounter);
  }

  async work<T>(queueName: string, handler: JobHandler<T>): Promise<void> {
    this.workers.set(queueName, handler as JobHandler);
  }

  async pauseWorker(): Promise<void> {}
  async resumeWorker(): Promise<void> {}
  async getQueueStats(): Promise<QueueStats> {
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }
  isHealthy(): boolean {
    return true;
  }
}

describe("TaskScheduler.register", () => {
  test("rejects duplicate registration", () => {
    const scheduler = new TaskScheduler(new FakeQueue());
    scheduler.register("foo", async () => {});
    expect(() => scheduler.register("foo", async () => {})).toThrow(
      /already registered/,
    );
  });

  test("rejects registration after start", async () => {
    const scheduler = new TaskScheduler(new FakeQueue());
    await scheduler.start();
    expect(() => scheduler.register("foo", async () => {})).toThrow(
      /after start/,
    );
  });
});

describe("TaskScheduler.spawn", () => {
  test("rejects unknown tasks", async () => {
    const scheduler = new TaskScheduler(new FakeQueue());
    await expect(scheduler.spawn("nope", {})).rejects.toThrow(/unknown task/);
  });

  test("encodes name + payload, sets actionKey, forwards idempotency key", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register("foo", async () => {});

    await scheduler.spawn("foo", { hello: "world" }, {
      idempotencyKey: "foo:singleton",
      maxAttempts: 5,
      priority: 7,
    });

    expect(queue.sent).toHaveLength(1);
    const sent = queue.sent[0];
    expect(sent.queueName).toBe("task");
    expect(sent.data).toEqual({ name: "foo", payload: { hello: "world" } });
    expect(sent.options?.actionKey).toBe("foo");
    expect(sent.options?.singletonKey).toBe("foo:singleton");
    expect(sent.options?.retryLimit).toBe(5);
    expect(sent.options?.priority).toBe(7);
  });

  test("delays dispatch when runAt is provided", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register("foo", async () => {});

    const future = new Date(Date.now() + 60_000);
    await scheduler.spawn("foo", {}, { runAt: future });

    const delayMs = queue.sent[0].options?.delayMs ?? 0;
    expect(delayMs).toBeGreaterThan(55_000);
    expect(delayMs).toBeLessThanOrEqual(60_000);
  });

  test("uses a rollout-safe dedicated lane for Automation reactions", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register(AUTOMATION_REACTION_TASK, async () => {});

    await scheduler.spawn(AUTOMATION_REACTION_TASK, { sourceRunId: 42 });

    expect(queue.sent[0]?.queueName).toBe(AUTOMATION_REACTION_TASK_QUEUE);
  });
});

describe("enqueueTasksInTransaction", () => {
  test("rejects task names outside the transactional manifest before SQL", async () => {
    let queried = false;
    const tx = Object.assign(
      async () => {
        queried = true;
        return [];
      },
      { json: (value: unknown) => value },
    ) as unknown as DbClient;

    await expect(
      enqueueTasksInTransaction(tx, [
        {
          name: "not-registered",
          payload: {},
          opts: { idempotencyKey: "not-registered:1" },
        },
      ]),
    ).rejects.toThrow(/unknown transactional task/);
    expect(queried).toBe(false);
  });
});

describe("TaskScheduler.start (cron seeding)", () => {
  test("seeds one row per periodic task with per-tick idempotency key", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register("a", async () => {}, { cron: "*/5 * * * *" });
    scheduler.register("b", async () => {}, { cron: "* * * * *" });
    scheduler.register("c", async () => {}); // non-periodic — no seed

    await scheduler.start();

    expect(queue.sent).toHaveLength(2);
    for (const r of queue.sent) {
      expect(r.queueName).toBe("task");
      // Per-tick key shape: cron:<name>:<iso-timestamp>
      expect(r.options?.singletonKey).toMatch(
        /^cron:(a|b):\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    }
    expect(queue.workers.has("task")).toBe(true);
  });

  test("idempotent — calling start twice does not double-seed", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register("a", async () => {}, { cron: "*/5 * * * *" });
    await scheduler.start();
    await scheduler.start();
    expect(queue.sent).toHaveLength(1);
  });

  test.each([
    [AUTOMATION_REACTION_TASK, AUTOMATION_REACTION_TASK_QUEUE],
    [NOTIFICATION_DELIVERY_TASK, NOTIFICATION_DELIVERY_TASK_QUEUE],
  ])("registers the %s lane only when its handler exists", async (taskName, queueName) => {
    const withoutReactionQueue = new FakeQueue();
    await new TaskScheduler(withoutReactionQueue).start();
    expect(
      withoutReactionQueue.workers.has(queueName),
    ).toBe(false);

    const withReactionQueue = new FakeQueue();
    const scheduler = new TaskScheduler(withReactionQueue);
    scheduler.register(taskName, async () => {});
    await scheduler.start();

    expect(withReactionQueue.workers.has(queueName)).toBe(
      true,
    );
  });
});

describe("TaskScheduler.dispatch", () => {
  test("routes payload, run id, and one-based attempt to the handler", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    let received: unknown = null;
    let receivedRunId: number | null = null;
    let receivedAttempt: number | null = null;
    scheduler.register("foo", async (ctx) => {
      received = ctx.payload;
      receivedRunId = ctx.taskRunId;
      receivedAttempt = ctx.attempt;
    });
    await scheduler.start();

    const handler = queue.workers.get("task");
    if (!handler) throw new Error("dispatcher not registered");
    const job: QueueJob = {
      id: "42",
      data: { name: "foo", payload: { x: 1 } },
      name: "task",
      attempt: 1,
    };
    await handler(job);

    expect(received).toEqual({ x: 1 });
    expect(receivedRunId).toBe(42);
    expect(receivedAttempt).toBe(2);
  });

  test("seeds next cron tick BEFORE running the handler", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    let dispatchOrder: string[] = [];
    scheduler.register(
      "ticker",
      async () => {
        dispatchOrder.push("handler");
      },
      { cron: "*/5 * * * *" },
    );
    await scheduler.start(); // seed 1

    queue.sent = []; // reset so we can see what dispatch enqueues
    const handler = queue.workers.get("task");
    if (!handler) throw new Error("dispatcher not registered");

    // Hook: capture when send() is called relative to handler execution.
    const origSend = queue.send.bind(queue);
    queue.send = async (...args) => {
      dispatchOrder.push("send");
      return origSend(...args);
    };

    await handler({
      id: "1",
      data: { name: "ticker", payload: {} },
      name: "task",
    });

    // send (next tick seed) MUST happen before handler runs.
    expect(dispatchOrder).toEqual(["send", "handler"]);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0].options?.singletonKey).toMatch(/^cron:ticker:/);
  });

  test("throws on unknown task name (runs-queue will mark fail/retry)", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    await scheduler.start();
    const handler = queue.workers.get("task");
    if (!handler) throw new Error("dispatcher not registered");
    await expect(
      handler({
        id: "1",
        data: { name: "no-such-task", payload: {} },
        name: "task",
      }),
    ).rejects.toThrow(/No handler/);
  });

  test("next-tick is computed from __scheduledTick payload, not local clock", async () => {
    // Regression for the clock-drift bug: when a row's __scheduledTick falls
    // exactly on a cron boundary, dispatch must seed nextTick = boundary + 1
    // tick, NOT recompute from `new Date()` (which can collide with the
    // current tick under clock skew and strand the cron).
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register("ticker", async () => {}, { cron: "*/5 * * * *" });
    await scheduler.start();
    queue.sent = [];

    const handler = queue.workers.get("task");
    if (!handler) throw new Error("dispatcher not registered");

    // Pretend this row was scheduled for an exact :05 boundary in the past
    // — what would happen if a pod's clock ran a couple seconds behind the DB.
    const scheduledTick = new Date("2026-01-01T00:05:00.000Z");
    await handler({
      id: "1",
      data: {
        name: "ticker",
        payload: {},
        __scheduledTick: scheduledTick.toISOString(),
      },
      name: "task",
    });

    expect(queue.sent).toHaveLength(1);
    const seed = queue.sent[0];
    // nextTick MUST be 00:10 (the next cron tick after :05), not :05 itself.
    expect(seed.options?.singletonKey).toBe(
      "cron:ticker:2026-01-01T00:10:00.000Z",
    );
    // Payload must carry __scheduledTick for the NEXT row's dispatcher.
    expect((seed.data as any).__scheduledTick).toBe("2026-01-01T00:10:00.000Z");
  });

  test("seed failure during dispatch is re-thrown (runs-queue retries the row)", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    let handlerRan = false;
    scheduler.register(
      "ticker",
      async () => {
        handlerRan = true;
      },
      { cron: "*/5 * * * *" },
    );
    await scheduler.start();
    queue.sent = [];

    // Make seed fail.
    queue.send = async () => {
      throw new Error("transient db error");
    };

    const handler = queue.workers.get("task");
    if (!handler) throw new Error("dispatcher not registered");

    await expect(
      handler({
        id: "1",
        data: { name: "ticker", payload: {} },
        name: "task",
      }),
    ).rejects.toThrow(/transient db error/);

    // Handler must NOT have run — we want the runs-queue to retry the whole
    // row (seed + handler) rather than completing the row with no successor.
    expect(handlerRan).toBe(false);
  });

  test("non-periodic task does not enqueue a follow-up", async () => {
    const queue = new FakeQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register("oneshot", async () => {});
    await scheduler.start();
    queue.sent = [];

    const handler = queue.workers.get("task");
    if (!handler) throw new Error("dispatcher not registered");
    await handler({
      id: "1",
      data: { name: "oneshot", payload: {} },
      name: "task",
    });
    expect(queue.sent).toHaveLength(0);
  });
});
