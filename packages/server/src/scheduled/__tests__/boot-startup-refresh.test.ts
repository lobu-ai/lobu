/**
 * Startup connector-definition convergence.
 *
 * A deploy is the only event that can change bundled connector source, so
 * bootTaskScheduler converges once per boot instead of waiting for the next
 * hourly tick. Pins:
 *  - exactly one startup spawn with the fixed idempotency key (N pods racing
 *    at rollout collapse to one run via the runs-queue partial unique index)
 *  - a boot-time enqueue failure never crashes boot (hourly tick covers it)
 */

import { describe, expect, test } from "bun:test";
import type { CoreServices } from "../../gateway/services/core-services";
import type { IMessageQueue } from "../../gateway/infrastructure/queue/types";
import { bootTaskScheduler } from "../jobs";

interface SentRecord {
  queueName: string;
  name: string;
  singletonKey?: string;
}

function makeQueue(sent: SentRecord[], failStartup = false): IMessageQueue {
  return {
    send: (async (queueName: string, data: unknown, opts?: { singletonKey?: string }) => {
      const name = (data as { name?: string })?.name ?? "";
      if (failStartup && opts?.singletonKey === "startup:refresh-connector-definitions") {
        throw new Error("transient db error");
      }
      sent.push({ queueName, name, singletonKey: opts?.singletonKey });
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

describe("bootTaskScheduler startup refresh", () => {
  test("spawns refresh-connector-definitions once with the fixed startup key", async () => {
    const sent: SentRecord[] = [];
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueue(sent)),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      const startup = sent.filter(
        (r) => r.singletonKey === "startup:refresh-connector-definitions",
      );
      expect(startup).toHaveLength(1);
      expect(startup[0].name).toBe("refresh-connector-definitions");
      expect(scheduler.hasHandler("refresh-connector-definitions")).toBe(true);
    } finally {
      scheduler.stop();
    }
  });

  test("a startup enqueue failure does not crash boot", async () => {
    const sent: SentRecord[] = [];
    const scheduler = await bootTaskScheduler(
      makeCoreServices(makeQueue(sent, true)),
      { ENVIRONMENT: "test" } as never,
    );
    try {
      // Boot resolved despite the failed spawn; hourly cron seed still exists.
      expect(
        sent.some((r) => r.singletonKey?.startsWith("cron:refresh-connector-definitions:")),
      ).toBe(true);
    } finally {
      scheduler.stop();
    }
  });
});
