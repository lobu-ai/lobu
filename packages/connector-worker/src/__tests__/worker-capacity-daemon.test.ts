import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { WORKER_POLL_MAX_WAIT_SECONDS } from "@lobu/core/contracts/worker/protocol";
import { WorkerHttpError } from "../daemon/client";
import { WorkerPollLoop } from "../daemon/poll-loop";
import { defaultDeviceMaxConcurrentJobs } from "../daemon/device-concurrency";
import { ResourceAdmission } from "../daemon/resource-admission";
import { createResourceSampler } from "../daemon/resources";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("resource-aware worker admission", () => {
  test("native isolates respect resource admission through the real HTTP client", async () => {
    const fixture = fileURLToPath(new URL('./fixtures/resource-admission.fixture.ts', import.meta.url));
    const child = Bun.spawn(['node', '--import', 'tsx', '--test', fixture], {
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exitCode, stderr, output: exitCode ? stdout : '' }).toEqual({ exitCode: 0, stderr: '', output: '' });
  }, 30_000);

  test("paces starts and recovers from CPU and memory pressure with hysteresis", () => {
    let now = 0;
    let used = 100;
    let cpu = 0;
    const admission = new ResourceAdmission(() => ({
      memory: [{ usedBytes: used, limitBytes: 1000 }],
      cpu: [{ key: 'container', usageMicros: cpu, cores: 1 }],
    }), () => now);
    expect(admission.capacity()).toBe(1);
    admission.started();
    expect(admission.capacity()).toBe(0);
    now += 500;
    cpu += 500_000;
    expect(admission.capacity()).toBe(0);
    now += 500;
    cpu += 100_000;
    expect(admission.capacity()).toBe(1);
    used = 850;
    now += 500;
    expect(admission.capacity()).toBe(0);
    used = 750;
    now += 500;
    expect(admission.capacity()).toBe(0);
    used = 400;
    now += 500;
    expect(admission.capacity()).toBe(1);
  });

  test("missing samples pause claims and recovery does not require a completion", async () => {
    let healthy = false;
    const admission = new ResourceAdmission(() => healthy ? {
      memory: [{ usedBytes: 100, limitBytes: 1000 }], cpu: [],
    } : null);
    const started = deferred();
    const finish = deferred();
    const capacities: number[] = [];
    const loop = new WorkerPollLoop({
      resourceAdmission: admission,
      maxConcurrentJobs: 2,
      client: { healthCheck: async () => true, poll: async (capacity: number) => {
        capacities.push(capacity);
        return capacity > 0 ? { run_id: 1, run_type: 'action' } : { next_poll_seconds: 30 };
      } } as never,
      execute: async () => { started.resolve(); await finish.promise; },
    });
    const running = loop.start();
    try {
      await Bun.sleep(30);
      expect(capacities).toEqual([0]);
      healthy = true;
      await Promise.race([started.promise, Bun.sleep(1500).then(() => { throw new Error('admission did not recover'); })]);
      expect(capacities).toContain(1);
    } finally {
      loop.stop(); finish.resolve(); await running;
      expect(await loop.waitForActiveJobs(1000, 1)).toBe(true);
    }
  });

  test("executes an already admitted held claim after resources become pressured", async () => {
    let healthy = true;
    const admission = new ResourceAdmission(() => healthy ? {
      memory: [{ usedBytes: 100, limitBytes: 1000 }], cpu: [],
    } : null);
    const entered = deferred();
    const claim = deferred<{ run_id: number; run_type: string }>();
    const executed: number[] = [];
    const loop = new WorkerPollLoop({
      resourceAdmission: admission,
      client: { healthCheck: async () => true, poll: async () => { entered.resolve(); return claim.promise; } } as never,
      execute: async (job) => { executed.push(job.run_id!); loop.stop(); },
    });
    const running = loop.start();
    await entered.promise;
    healthy = false;
    claim.resolve({ run_id: 1, run_type: 'action' });
    await running;
    expect(executed).toEqual([1]);
  });

  test("samples namespaced cgroup v2 usage and inherited fractional CPU limits", () => {
    const files: Record<string, string> = {
      '/proc/self/cgroup': '0::/tenant/worker\n',
      '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
      '/sys/fs/cgroup/tenant/worker/memory.max': 'max',
      '/sys/fs/cgroup/tenant/memory.max': '1000',
      '/sys/fs/cgroup/tenant/memory.current': '700',
      '/sys/fs/cgroup/tenant/cpu.max': '50000 100000',
      '/sys/fs/cgroup/tenant/cpu.stat': 'usage_usec 125000\n',
    };
    const sample = createResourceSampler(path => {
      if (!(path in files)) throw new Error('unavailable');
      return files[path]!;
    }, 'linux')();
    expect(sample?.memory).toContainEqual({ usedBytes: 700, limitBytes: 1000 });
    expect(sample?.cpu).toContainEqual({ key: '/sys/fs/cgroup/tenant', usageMicros: 125000, cores: 0.5 });
    files['/sys/fs/cgroup/tenant/memory.stat'] = 'inactive_file 600\n';
    expect(createResourceSampler(path => {
      if (!(path in files)) throw new Error('unavailable');
      return files[path]!;
    }, 'linux')()?.memory).toContainEqual({ usedBytes: 100, limitBytes: 1000 });
    delete files['/sys/fs/cgroup/tenant/memory.current'];
    expect(createResourceSampler(path => {
      if (!(path in files)) throw new Error('unavailable');
      return files[path]!;
    }, 'linux')()).toBeNull();
  });

  test("supports cgroup v1 mount roots, unlimited sentinels and separate accounting", () => {
    const files: Record<string, string> = {
      '/proc/self/cgroup': '5:memory:/tenant/worker\n4:cpu:/tenant/worker\n3:cpuacct:/tenant/worker\n',
      '/proc/self/mountinfo': [
        '1 0 0:1 /tenant /cg/mem rw - cgroup cgroup rw,memory',
        '2 0 0:2 /tenant /cg/cpu rw - cgroup cgroup rw,cpu',
        '3 0 0:3 /tenant /cg/acct rw - cgroup cgroup rw,cpuacct',
      ].join('\n'),
      '/cg/mem/worker/memory.limit_in_bytes': '9223372036854771712',
      '/cg/mem/memory.limit_in_bytes': '2000',
      '/cg/mem/memory.usage_in_bytes': '1500',
      '/cg/mem/memory.stat': 'total_inactive_file 500\n',
      '/cg/cpu/worker/cpu.cfs_quota_us': '-1',
      '/cg/cpu/worker/cpu.cfs_period_us': '100000',
      '/cg/cpu/cpu.cfs_quota_us': '25000',
      '/cg/cpu/cpu.cfs_period_us': '100000',
      '/cg/acct/cpuacct.usage': '125000000',
    };
    const read = (path: string) => {
      if (!(path in files)) throw new Error('unavailable');
      return files[path]!;
    };
    const sample = createResourceSampler(read, 'linux')();
    expect(sample?.memory).toEqual([{ usedBytes: 1000, limitBytes: 2000 }]);
    expect(sample?.cpu).toEqual([{ key: '/cg/cpu', usageMicros: 125000, cores: 0.25 }]);
    files['/cg/cpu/cpu.cfs_quota_us'] = 'invalid';
    expect(createResourceSampler(read, 'linux')()).toBeNull();
    files['/cg/cpu/cpu.cfs_quota_us'] = '25000';
    // A hybrid host's unified hierarchy does not own the v1 controllers.
    files['/proc/self/cgroup'] += '0::/tenant/worker\n';
    const v1Mounts = files['/proc/self/mountinfo'];
    const v2Mount = '4 0 0:4 / /cg/unified rw - cgroup2 cgroup rw';
    for (const mounts of [`${v1Mounts}\n${v2Mount}`, `${v2Mount}\n${v1Mounts}`]) {
      files['/proc/self/mountinfo'] = mounts;
      expect(createResourceSampler(read, 'linux')()).toEqual(sample);
    }
  });
});

describe("worker daemon capacity polling", () => {
  test("holds only claims with capacity and cancels an idle request on shutdown", async () => {
    const entered = deferred();
    let observedWait: number | undefined;
    let observedSignal: AbortSignal | undefined;
    const loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async (_capacity: number, options: { waitSeconds?: number; signal: AbortSignal }) => {
          observedWait = options.waitSeconds;
          observedSignal = options.signal;
          entered.resolve();
          return new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      } as never,
      execute: async () => { throw new Error('No job was claimed'); },
    });
    const running = loop.start();
    await entered.promise;
    expect(observedWait).toBe(WORKER_POLL_MAX_WAIT_SECONDS);
    loop.stop();
    await running;
    expect(observedSignal?.aborted).toBe(true);
  });

  test("reopens an expired held request without another idle delay", async () => {
    let polls = 0;
    const loop = new WorkerPollLoop({
      client: { healthCheck: async () => true, poll: async () => {
        polls++;
        if (polls === 2) loop.stop();
        return { next_poll_seconds: 0 };
      } } as never,
      execute: async () => {},
    });
    const start = performance.now();
    await loop.start();
    expect(polls).toBe(2);
    expect(performance.now() - start).toBeLessThan(100);
  });

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

  test("four device slots (eight host threads) run independently and the fifth waits for actual capacity", async () => {
    const finishes = Array.from({ length: 5 }, () => deferred());
    const saturated = deferred();
    const fifthStarted = deferred();
    const capacities: number[] = [];
    const executed: number[] = [];
    let claimed = 0;
    let active = 0;
    let peak = 0;
    const loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async (capacity: number) => {
          capacities.push(capacity);
          if (capacity === 0) saturated.resolve();
          return capacity > 0 && claimed < 5
            ? { run_id: ++claimed, run_type: "action" }
            : { next_poll_seconds: 1 };
        },
      } as never,
      maxConcurrentJobs: defaultDeviceMaxConcurrentJobs(8),
      pollIntervalMs: 5,
      execute: async (job) => {
        const id = job.run_id!;
        executed.push(id);
        peak = Math.max(peak, ++active);
        if (id === 5) fifthStarted.resolve();
        try {
          await finishes[id - 1].promise;
        } finally {
          active--;
        }
      },
    });
    const running = loop.start();
    try {
      await saturated.promise;
      expect(executed).toEqual([1, 2, 3, 4]);
      expect(capacities.slice(0, 5)).toEqual([4, 3, 2, 1, 0]);
      expect(active).toBe(4);
      // A short job finishes while the first, long-running command stays busy.
      finishes[1].resolve();
      await fifthStarted.promise;
      expect(executed).toEqual([1, 2, 3, 4, 5]);
      expect(active).toBe(4);
      expect(peak).toBe(4);
      expect(capacities.at(-1)).toBe(1);
    } finally {
      loop.stop();
      for (const finish of finishes) finish.resolve();
      await running;
      expect(await loop.waitForActiveJobs(1000, 1)).toBe(true);
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

  test("budgets agent turns apart from connector work; a backfill borrows a free turn slot", async () => {
    const polls: Array<{ capacity: number; wait?: number; lanes?: unknown }> = [];
    // The gateway gates turns and connector runs per lane, but an embedding
    // backfill only on free capacity, so it can arrive while the connector
    // budget is full.
    const answers: Array<{ run_id?: number; run_type?: string; next_poll_seconds?: number }> = [
      { run_id: 1, run_type: "sync" },
      { run_id: 2, run_type: "embed_backfill" },
    ];
    const finish = new Map<number, () => void>();
    const loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async (capacity: number, options: { waitSeconds?: number; lanes?: unknown }) => {
          polls.push({ capacity, wait: options.waitSeconds, lanes: options.lanes });
          return answers.shift() ?? { next_poll_seconds: 1 };
        },
      } as never,
      maxConcurrentJobs: 1,
      maxConcurrentAgentTurns: 1,
      pollIntervalMs: 10,
      execute: (job) => new Promise<void>((resolve) => { finish.set(Number(job.run_id), resolve); }),
    });
    const running = loop.start();
    try {
      await Bun.sleep(50);
      // Freeing the sync's connector slot does not reopen the borrowed turn
      // slot, so the poll still withdraws turns and does not hold.
      finish.get(1)!();
      await Bun.sleep(50);
      // The backfill hands its turn slot back.
      finish.get(2)!();
      await Bun.sleep(50);
      expect(polls).toEqual([
        { capacity: 2, wait: WORKER_POLL_MAX_WAIT_SECONDS, lanes: { agentTurns: 1, connectorJobs: 1 } },
        { capacity: 1, wait: WORKER_POLL_MAX_WAIT_SECONDS, lanes: { agentTurns: 1, connectorJobs: 0 } },
        { capacity: 0, wait: 0, lanes: { agentTurns: 0, connectorJobs: 0 } },
        { capacity: 1, wait: 0, lanes: { agentTurns: 0, connectorJobs: 1 } },
        { capacity: 2, wait: WORKER_POLL_MAX_WAIT_SECONDS, lanes: { agentTurns: 1, connectorJobs: 1 } },
      ]);
    } finally {
      loop.stop();
      for (const done of finish.values()) done();
      await running;
      await loop.waitForActiveJobs(1000, 1);
    }
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
