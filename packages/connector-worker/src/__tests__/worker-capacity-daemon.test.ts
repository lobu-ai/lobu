import { describe, expect, test } from "bun:test";
import { WorkerHttpError } from "../daemon/client";
import { WorkerPollLoop } from "../daemon/poll-loop";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("worker daemon capacity polling", () => {
  for (const throws of [false, true]) {
    test(`drains ten queued commands without interval gaps (executor throws: ${throws})`, async () => {
      const executed: number[] = [];
      let claimed = 0;
      const loop = new WorkerPollLoop({
        client: {
          healthCheck: async () => true,
          poll: async (capacity: number) => capacity > 0 && claimed < 10
            ? { run_id: ++claimed, run_type: "action" }
            : { next_poll_seconds: 1 },
        } as never,
        pollIntervalMs: 1000,
        execute: async (job) => {
          executed.push(job.run_id!);
          if (throws) throw new Error("command failed");
        },
      });
      const running = loop.start();
      try {
        await Bun.sleep(100);
        expect(executed).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      } finally {
        loop.stop();
        await running;
      }
    });
  }

  test("fills free slots immediately without exceeding concurrency", async () => {
    const finish = deferred();
    const capacities: number[] = [];
    let executions = 0;
    const loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async (capacity: number) => {
          capacities.push(capacity);
          return capacity > 0
            ? { run_id: capacities.length, run_type: "action" }
            : { next_poll_seconds: 1 };
        },
      } as never,
      maxConcurrentJobs: 3,
      pollIntervalMs: 1000,
      execute: async () => {
        executions++;
        await finish.promise;
      },
    });
    const running = loop.start();
    try {
      await Bun.sleep(100);
      expect(executions).toBe(3);
      expect(capacities).toEqual([3, 2, 1]);
    } finally {
      loop.stop();
      finish.resolve();
      await running;
      await loop.waitForActiveJobs(1000, 1);
    }
  });

  test("does not lose a capacity wakeup while a zero-capacity poll is in flight", async () => {
    const finish = deferred();
    const pollingAtCapacity = deferred();
    const idleReply = deferred<{ next_poll_seconds: number }>();
    const capacities: number[] = [];
    let loop: WorkerPollLoop;
    loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async (capacity: number) => {
          capacities.push(capacity);
          if (capacities.length === 1) return { run_id: 1, run_type: "action" };
          if (capacities.length === 2) {
            pollingAtCapacity.resolve();
            return idleReply.promise;
          }
          loop.stop();
          return {};
        },
      } as never,
      pollIntervalMs: 5,
      execute: async () => finish.promise,
    });
    const running = loop.start();
    try {
      await pollingAtCapacity.promise;
      finish.resolve();
      await loop.waitForActiveJobs(1000, 1);
      idleReply.resolve({ next_poll_seconds: 1 });
      const repolled = await Promise.race([
        running.then(() => true),
        Bun.sleep(100).then(() => false),
      ]);
      expect(repolled).toBe(true);
      expect(capacities).toEqual([1, 0, 1]);
    } finally {
      loop.stop();
      finish.resolve();
      idleReply.resolve({ next_poll_seconds: 1 });
      await running;
    }
  });

  test("completion cannot interrupt poll-error backoff but shutdown can", async () => {
    const finish = deferred();
    const pollFailed = deferred();
    let polls = 0;
    const loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async () => {
          if (++polls === 1) return { run_id: 1, run_type: "action" };
          pollFailed.resolve();
          throw new WorkerHttpError(503, "/api/workers/poll", "retry");
        },
      } as never,
      pollIntervalMs: 100,
      execute: async () => finish.promise,
    });
    const running = loop.start();
    try {
      await pollFailed.promise;
      finish.resolve();
      await Bun.sleep(20);
      expect(polls).toBe(2);
      loop.stop();
      expect(await Promise.race([
        running.then(() => true),
        Bun.sleep(20).then(() => false),
      ])).toBe(true);
    } finally {
      loop.stop();
      finish.resolve();
      await running;
    }
  });

  test("runs credential maintenance before polls only when no job is active", async () => {
    const order: string[] = [];
    let releaseJob: (() => void) | undefined;
    const jobDone = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    let polls = 0;
    let loop: WorkerPollLoop;
    const client = {
      healthCheck: async () => true,
      poll: async () => {
        polls++;
        order.push(`poll:${polls}`);
        if (polls === 1) return { run_id: 42, run_type: "sync" };
        if (polls === 2) {
          releaseJob?.();
          return { next_poll_seconds: 0.001 };
        }
        loop.stop();
        return { next_poll_seconds: 0.001 };
      },
    } as never;
    loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 1,
      maxConcurrentJobs: 1,
      execute: async () => jobDone,
      beforeIdlePoll: async () => {
        order.push("maintenance");
      },
    });

    await loop.start();

    expect(order).toEqual([
      "maintenance",
      "poll:1",
      "poll:2",
      "maintenance",
      "poll:3",
    ]);
  });

  test("treats credential maintenance refusal as fatal before polling", async () => {
    let polls = 0;
    const loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async () => {
          polls++;
          return {};
        },
      } as never,
      execute: async () => {},
      beforeIdlePoll: async () => {
        throw new Error("device credential was revoked");
      },
    });

    await expect(loop.start()).rejects.toThrow(/credential was revoked/);
    expect(polls).toBe(0);
  });

  for (const status of [401, 403]) {
    test(`persisted credential mode treats poll ${status} as fatal`, async () => {
      let polls = 0;
      const loop = new WorkerPollLoop({
        client: {
          healthCheck: async () => true,
          poll: async () => {
            polls++;
            throw new WorkerHttpError(status, "/api/workers/poll", "rejected");
          },
        } as never,
        execute: async () => {},
        failClosedOnPollAuthError: true,
      });

      await expect(loop.start()).rejects.toMatchObject({ status });
      expect(polls).toBe(1);
    });
  }

  test("persisted credential mode retries poll 429 and 5xx responses", async () => {
    const statuses = [429, 503];
    let polls = 0;
    let loop: WorkerPollLoop;
    loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async () => {
          polls++;
          const status = statuses.shift();
          if (status) {
            throw new WorkerHttpError(status, "/api/workers/poll", "retry");
          }
          loop.stop();
          return { next_poll_seconds: 0.001 };
        },
      } as never,
      pollIntervalMs: 1,
      execute: async () => {},
      failClosedOnPollAuthError: true,
    });

    await loop.start();

    expect(polls).toBe(3);
  });

  test("polls at capacity with zero and does not execute a returned job", async () => {
    const calls: number[] = [];
    let executed = 0;
    const client = {
      poll: async (capacity?: number) => {
        calls.push(capacity ?? -1);
        return { run_id: 42, run_type: "sync", next_poll_seconds: 10 };
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      maxConcurrentJobs: 1,
      execute: async () => {
        executed++;
      },
    });
    (loop as unknown as { activeJobs: number }).activeJobs = 1;

    await (loop as unknown as { pollAndExecute: () => Promise<number | undefined> })
      .pollAndExecute();

    expect(calls).toEqual([0]);
    expect(executed).toBe(0);
  });

  test("sends the number of free slots when below capacity", async () => {
    const calls: number[] = [];
    const client = {
      poll: async (capacity?: number) => {
        calls.push(capacity ?? -1);
        return {};
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      maxConcurrentJobs: 3,
      execute: async () => {},
    });
    (loop as unknown as { activeJobs: number }).activeJobs = 1;

    await (loop as unknown as { pollAndExecute: () => Promise<number | undefined> })
      .pollAndExecute();

    expect(calls).toEqual([2]);
  });

  test("releases one slot when the executor rejects asynchronously", async () => {
    const capacities: number[] = [];
    let firstPoll = true;
    const client = {
      poll: async (capacity?: number) => {
        capacities.push(capacity ?? -1);
        if (firstPoll) {
          firstPoll = false;
          return { run_id: 42, run_type: "sync" };
        }
        return { next_poll_seconds: 1 };
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      maxConcurrentJobs: 1,
      execute: async () => {
        throw new Error("asynchronous executor failure");
      },
    });
    const pollAndExecute = (loop as unknown as {
      pollAndExecute: () => Promise<number | undefined>;
    }).pollAndExecute.bind(loop);

    await pollAndExecute();
    expect(await loop.waitForActiveJobs(1000, 1)).toBe(true);
    await pollAndExecute();

    expect(capacities).toEqual([1, 1]);
  });
});
