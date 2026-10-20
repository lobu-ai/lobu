/**
 * Startup connector-definition convergence.
 *
 * Startup uses the booting process's source even if an outgoing pod claims
 * shared queue work. The scan must not block boot, and a rejection after boot
 * must be logged with the hourly refresh still scheduled.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CoreServices } from "../../gateway/services/core-services";
import type { IMessageQueue } from "../../gateway/infrastructure/queue/types";
import logger from "../../utils/logger";
import { bootTaskScheduler } from "../jobs";
import * as refreshModule from "../refresh-connector-definitions";

interface SentRecord {
  name: string;
  singletonKey?: string;
}

/** Simulates another process claiming all shared queue work. */
function makeQueueDrainedElsewhere(sent: SentRecord[]): IMessageQueue {
  return {
    send: (async (_queueName: string, data: unknown, opts?: { singletonKey?: string }) => {
      sent.push({ name: (data as { name?: string })?.name ?? "", singletonKey: opts?.singletonKey });
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

describe("bootTaskScheduler startup refresh", () => {
  afterEach(() => {
    spyOn(refreshModule, "refreshConnectorDefinitions").mockRestore();
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
        { err: failure },
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
});
