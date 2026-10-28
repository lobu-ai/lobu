/**
 * Unit tests for `RunsQueue` helpers and shape.
 *
 * The integration tests that exercise a real Postgres claim loop live in
 * `src/gateway/__tests__/runs-queue-integration.test.ts` and run against
 * `DATABASE_URL` when set, else an embedded Postgres.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  backoffSeconds,
  classifyQueue,
  RunsQueue,
} from "../runs-queue.js";

describe("classifyQueue", () => {
  test("messages -> chat_message", () => {
    expect(classifyQueue("messages")).toBe("chat_message");
  });
  test("thread_message_* -> chat_message", () => {
    expect(classifyQueue("thread_message_telegram-1234")).toBe("chat_message");
  });
  test("thread_response -> chat_message", () => {
    expect(classifyQueue("thread_response")).toBe("chat_message");
  });
  test("messages:dlq -> chat_message", () => {
    expect(classifyQueue("messages:dlq")).toBe("chat_message");
  });
  test("schedule -> schedule", () => {
    expect(classifyQueue("schedule")).toBe("schedule");
    expect(classifyQueue("schedule:cron")).toBe("schedule");
  });
  test("agent_run -> agent_run", () => {
    expect(classifyQueue("agent_run")).toBe("agent_run");
    expect(classifyQueue("agent_run:abc123")).toBe("agent_run");
  });
  test("internal -> internal", () => {
    expect(classifyQueue("internal")).toBe("internal");
    expect(classifyQueue("internal:metrics")).toBe("internal");
  });
  test("task -> task", () => {
    expect(classifyQueue("task")).toBe("task");
    expect(classifyQueue("task:cron-tick")).toBe("task");
  });
  // RunsQueue claims by the classified run_type, so a connector-worker lane
  // name must never pass through as itself (the automation-run race).
  test("never emits a connector-worker lane", () => {
    const connectorLanes = ["sync", "action", "embed_backfill", "automation", "auth"];
    for (const name of [...connectorLanes, "automation:123", "automation_run"]) {
      expect(connectorLanes).not.toContain(classifyQueue(name));
    }
  });
});

describe("backoffSeconds", () => {
  test("exponential ramp", () => {
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(2)).toBe(4);
    expect(backoffSeconds(3)).toBe(8);
    expect(backoffSeconds(4)).toBe(16);
  });
  test("capped at 300s", () => {
    expect(backoffSeconds(20)).toBe(300);
  });
  test("attempt 0 is 1s", () => {
    expect(backoffSeconds(0)).toBe(1);
  });
  test("negative attempt is treated as 0", () => {
    expect(backoffSeconds(-1)).toBe(1);
  });
});

describe("RunsQueue construction", () => {
  test("requires DATABASE_URL", () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => new RunsQueue({})).toThrow(
        /DATABASE_URL is required/,
      );
    } finally {
      if (prev) process.env.DATABASE_URL = prev;
    }
  });
  test("constructs when DATABASE_URL is set (no per-instance config required)", () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    try {
      expect(() => new RunsQueue()).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      else delete process.env.DATABASE_URL;
    }
  });
});

describe("RunsQueue worker lifecycle", () => {
  /**
   * `JobRouter.registerWorker` is documented as safe to call repeatedly, and it
   * is: a worker's SSE connection dropping and coming back re-registers the
   * same `thread_message_<deployment>` queue. That must not let a second job
   * start next to one that is still running.
   */
  test("re-registering a queue keeps one worker and does not run two jobs at once", async () => {
    const prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    const queue = new RunsQueue();
    const rows = [
      { runId: 1, payload: { turn: 1 }, attempts: 0, maxAttempts: 3, retryDelaySeconds: null },
      { runId: 2, payload: { turn: 2 }, attempts: 0, maxAttempts: 3, retryDelaySeconds: null },
    ];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    let secondStarted: (() => void) | undefined;
    const started = new Promise<void>((r) => { firstStarted = r; });
    const secondRan = new Promise<void>((r) => { secondStarted = r; });
    let active = 0;
    let maxActive = 0;
    (queue as any).isConnected = true;
    (queue as any).ensureChannelListened = async () => undefined;
    (queue as any).claimOne = async () => rows.shift() ?? null;
    (queue as any).heartbeatClaim = async () => undefined;
    (queue as any).markCompleted = async () => undefined;

    const first = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      firstStarted?.();
      await new Promise<void>((r) => { releaseFirst = r; });
      active -= 1;
    };
    const replacement = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      secondStarted?.();
      active -= 1;
    };

    try {
      await queue.work("same-queue", first);
      await started;
      const worker = (queue as any).workers.get("same-queue");

      await queue.work("same-queue", replacement);

      // The symptom first: a replacement that claims alongside `first` shows
      // up here as maxActive 2, which is the bug. Asserting worker identity
      // before this would fail on the mechanism instead of the symptom.
      await new Promise((r) => setTimeout(r, 100));
      expect(maxActive).toBe(1);

      // Same worker object, so its in-flight accounting survives.
      expect((queue as any).workers.get("same-queue")).toBe(worker);
      expect(worker.handler).toBe(replacement);
      expect((queue as any).workers.size).toBe(1);

      releaseFirst?.();
      await Promise.race([
        secondRan,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("second job never ran")), 1000),
        ),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst?.();
      // Halt the poll loops directly rather than via stop(), which would reach
      // for a database this test deliberately never needs.
      for (const w of (queue as any).workers.values()) {
        w.stopped = true;
        w.wakeup();
      }
      if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
      else delete process.env.DATABASE_URL;
    }
  });

  /**
   * `stop()` used to drain on `active` alone, so a claim still inside
   * `claimOne` was invisible: the drain broke, the shutdown release ran, and
   * the claim then landed and started a handler on a process that was exiting.
   */
  test("stop waits for an in-flight claim and releases it instead of running it", async () => {
    const prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    const queue = new RunsQueue();
    let finishClaim: (() => void) | undefined;
    let claimStarted: (() => void) | undefined;
    const started = new Promise<void>((r) => { claimStarted = r; });
    const claimMayFinish = new Promise<void>((r) => { finishClaim = r; });
    const handler = mock(async () => undefined);
    const release = mock(async () => undefined);
    (queue as any).isConnected = true;
    (queue as any).ensureChannelListened = async () => undefined;
    (queue as any).releaseClaim = release;
    (queue as any).releaseAllClaims = async () => 0;
    (queue as any).heartbeatClaim = async () => undefined;
    (queue as any).markCompleted = async () => undefined;
    (queue as any).claimOne = async () => {
      claimStarted?.();
      await claimMayFinish;
      return { runId: 41, payload: {}, attempts: 0, maxAttempts: 3, retryDelaySeconds: null };
    };

    try {
      await queue.work("shutdown-race", handler);
      await started;

      const stopping = queue.stop();
      expect(handler).not.toHaveBeenCalled();

      // The claim lands after stop() has already begun.
      finishClaim?.();
      await stopping;

      // Settle past the poll loop's post-claim continuation: without the
      // fence it starts the handler here, so this assertion is what catches
      // work beginning on a process that is exiting.
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(41);
    } finally {
      finishClaim?.();
      if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
      else delete process.env.DATABASE_URL;
    }
  });
});
