/**
 * Startup connector-definition convergence.
 *
 * Startup uses the booting process's source even if an outgoing pod claims
 * shared queue work. The scan must not block boot, and a rejection after boot
 * must be logged with the hourly refresh still scheduled. A delayed local
 * follow-up repairs overwrites from older processes in overlapping deployments;
 * it does not guarantee that a rollout has finished.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CoreServices } from "../../gateway/services/core-services";
import type { IMessageQueue } from "../../gateway/infrastructure/queue/types";
import logger from "../../utils/logger";
import { bootTaskScheduler } from "../jobs";
import { TaskScheduler } from "../task-scheduler";
import * as refreshModule from "../refresh-connector-definitions";
import * as viewRefreshModule from "../refresh-compiled-views";

interface SentRecord {
  queueName?: string;
  name: string;
  singletonKey?: string;
}

/** Simulates another process claiming all shared queue work. */
function makeQueueDrainedElsewhere(sent: SentRecord[]): IMessageQueue {
  return {
    send: (async (queueName: string, data: unknown, opts?: { singletonKey?: string }) => {
      sent.push({ queueName, name: (data as { name?: string })?.name ?? "", singletonKey: opts?.singletonKey });
      return String(sent.length);
    }) as IMessageQueue["send"],
    work: (async () => {}) as IMessageQueue["work"],
  } as unknown as IMessageQueue;
}

function makeCoreServices(queue: IMessageQueue): CoreServices {
  return {
    getQueue: () => queue,
    getAuthProfilesManager: () => null,
  } as unknown as CoreServices;
}

const EMPTY_RESULT = { scanned: 0, refreshed: 0, skippedNoSource: 0, errored: 0 };

const EMPTY_VIEW_RESULT = { scanned: 0, refreshed: 0, errored: 0 };

describe("bootTaskScheduler startup refresh", () => {
  beforeEach(() => {
    spyOn(viewRefreshModule, "refreshCompiledViews").mockResolvedValue(EMPTY_VIEW_RESULT);
  });

  afterEach(() => {
    spyOn(refreshModule, "refreshConnectorDefinitions").mockRestore();
    spyOn(viewRefreshModule, "refreshCompiledViews").mockRestore();
  });

  test("rebuilds compiled views at boot and on the follow-up, with an hourly backstop", async () => {
    spyOn(refreshModule, "refreshConnectorDefinitions").mockResolvedValue(EMPTY_RESULT);
    const views = spyOn(viewRefreshModule, "refreshCompiledViews").mockResolvedValue(EMPTY_VIEW_RESULT);
    const delayed: Array<() => Promise<void>> = [];
    const runOnceAfter = spyOn(TaskScheduler.prototype, "runOnceAfter").mockImplementation((_delayMs, fn) => {
      delayed.push(fn);
    });
    const sent: SentRecord[] = [];
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueueDrainedElsewhere(sent)),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      expect(views).toHaveBeenCalledTimes(1);
      await delayed[0]();
      expect(views).toHaveBeenCalledTimes(2);
      expect(scheduler.hasHandler("refresh-compiled-views")).toBe(true);
      // Its own lane: an older replica working the shared `task` lane during a
      // rollout must not claim a handler it does not have.
      expect(
        sent.filter((r) => r.singletonKey?.startsWith("cron:refresh-compiled-views:")).map((r) => r.queueName),
      ).toEqual(["task:refresh-compiled-views"]);
    } finally {
      runOnceAfter.mockRestore();
      scheduler.stop();
    }
  });

  test("a compiled-view refresh failure is logged and does not crash boot", async () => {
    spyOn(refreshModule, "refreshConnectorDefinitions").mockResolvedValue(EMPTY_RESULT);
    const failure = new Error("compile failed");
    spyOn(viewRefreshModule, "refreshCompiledViews").mockRejectedValue(failure);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueueDrainedElsewhere([])),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warn).toHaveBeenCalledWith(
        { err: failure, phase: "boot" },
        "[task-scheduler] Startup compiled-view refresh failed; hourly tick will cover it",
      );
    } finally {
      warn.mockRestore();
      scheduler.stop();
    }
  });

  test("refreshes locally without waiting for the scan or a shared queue worker", async () => {
    let finishRefresh!: (result: typeof EMPTY_RESULT) => void;
    const pendingRefresh = new Promise<typeof EMPTY_RESULT>((resolve) => {
      finishRefresh = resolve;
    });
    const refresh = spyOn(refreshModule, "refreshConnectorDefinitions").mockReturnValue(pendingRefresh);
    const sent: SentRecord[] = [];
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueueDrainedElsewhere(sent)),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(
        sent.filter((r) => r.name === "refresh-connector-definitions"),
      ).toEqual([{
        queueName: "task",
        name: "refresh-connector-definitions",
        singletonKey: expect.stringMatching(/^cron:refresh-connector-definitions:/),
      }]);
    } finally {
      finishRefresh(EMPTY_RESULT);
      await pendingRefresh;
      scheduler.stop();
    }
  });

  test("a startup refresh failure does not crash boot", async () => {
    spyOn(refreshModule, "refreshConnectorDefinitions").mockRejectedValue(new Error("transient db error"));
    const sent: SentRecord[] = [];
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueueDrainedElsewhere(sent)),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      expect(scheduler.hasHandler("refresh-connector-definitions")).toBe(true);
      expect(
        sent.some((r) => r.singletonKey?.startsWith("cron:refresh-connector-definitions:")),
      ).toBe(true);
    } finally {
      scheduler.stop();
    }
  });

  test("logs a refresh failure that arrives after boot", async () => {
    const failure = new Error("transient db error");
    let rejectRefresh!: (err: Error) => void;
    const pendingRefresh = new Promise<typeof EMPTY_RESULT>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    spyOn(refreshModule, "refreshConnectorDefinitions").mockReturnValue(pendingRefresh);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const sent: SentRecord[] = [];
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueueDrainedElsewhere(sent)),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      rejectRefresh(failure);
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith(
        { err: failure, phase: "boot" },
        "[task-scheduler] Startup connector-definition refresh failed; hourly tick will cover it",
      );
      expect(
        sent.some((r) => r.singletonKey?.startsWith("cron:refresh-connector-definitions:")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      scheduler.stop();
    }
  });

  test.each([false, true])("refreshes locally after the startup delay (failure: %s)", async (failFollowup) => {
    const refresh = spyOn(refreshModule, "refreshConnectorDefinitions").mockResolvedValue(EMPTY_RESULT);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const sent: SentRecord[] = [];
    const delayed: Array<{ delayMs: number; fn: () => Promise<void> }> = [];
    const runOnceAfter = spyOn(TaskScheduler.prototype, "runOnceAfter").mockImplementation((delayMs, fn) => {
      delayed.push({ delayMs, fn });
    });
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueueDrainedElsewhere(sent)),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      expect(delayed).toHaveLength(1);
      expect(delayed[0].delayMs).toBe(10 * 60_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      const failure = new Error("follow-up refresh failed");
      if (failFollowup) refresh.mockRejectedValueOnce(failure);
      await delayed[0].fn();
      expect(refresh).toHaveBeenCalledTimes(2);
      if (failFollowup) {
        expect(warn).toHaveBeenCalledWith(
          { err: failure, phase: "follow-up" },
          "[task-scheduler] Startup connector-definition refresh failed; hourly tick will cover it",
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      expect(
        sent.filter((r) => r.name === "refresh-connector-definitions"),
      ).toEqual([{
        queueName: "task",
        name: "refresh-connector-definitions",
        singletonKey: expect.stringMatching(/^cron:refresh-connector-definitions:/),
      }]);
    } finally {
      warn.mockRestore();
      runOnceAfter.mockRestore();
      scheduler.stop();
    }
  });
});

describe("TaskScheduler.runOnceAfter", () => {
  test.each(["throw", "reject"])("contains a callback failure: %s", async (failureMode) => {
    const scheduler = new TaskScheduler(makeQueueDrainedElsewhere([]));
    await scheduler.start();
    let runs = 0;
    try {
      scheduler.runOnceAfter(5, () => {
        runs += 1;
        const failure = new Error("delayed callback failed");
        if (failureMode === "throw") throw failure;
        return Promise.reject(failure);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runs).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test("does not revive a cancelled callback when restarted", async () => {
    const scheduler = new TaskScheduler(makeQueueDrainedElsewhere([]));
    await scheduler.start();
    let runs = 0;
    try {
      scheduler.runOnceAfter(5, async () => { runs += 1; });
      scheduler.stop();
      await scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runs).toBe(0);
    } finally {
      scheduler.stop();
    }
  });

  test("runs once while the scheduler is started, never after stop", async () => {
    const scheduler = new TaskScheduler(makeQueueDrainedElsewhere([]));
    await scheduler.start();
    let runs = 0;
    try {
      scheduler.runOnceAfter(5, async () => { runs += 1; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runs).toBe(1);

      scheduler.runOnceAfter(5, async () => { runs += 1; });
      scheduler.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runs).toBe(1);
    } finally {
      scheduler.stop();
    }
  });
});
