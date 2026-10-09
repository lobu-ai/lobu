import { beforeAll, describe, expect, it } from "bun:test";
import { raceAbort } from "../../../utils/race-abort";
import { sleepAgainstAbort } from "../../../sandbox/run-script";
import { runOrSkip, stubSDK } from "./_helpers";

describe("raceAbort", () => {
  it("rejects with the signal's reason on abort, before the underlying promise resolves", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("AbortError: deadline")), 10);
    await expect(
      raceAbort(new Promise((r) => setTimeout(() => r("late"), 200)), controller.signal),
    ).rejects.toThrow(/deadline/);
  });
});

describe("sandbox sleep", () => {
  it("rejects invalid and over-limit durations", async () => {
    const signal = new AbortController().signal;
    await expect(sleepAgainstAbort(-1, signal)).rejects.toThrow(/InvalidSleepDuration/);
    await expect(sleepAgainstAbort(30_001, signal)).rejects.toThrow(/SleepLimitExceeded/);
  });

  it("rejects an active sleep with the overall script abort reason", async () => {
    const controller = new AbortController();
    const sleeping = sleepAgainstAbort(1_000, controller.signal);
    const reason = new Error("TimeoutError: script deadline");
    controller.abort(reason);

    await expect(sleeping).rejects.toBe(reason);
  });
});

describe("AbortSignal cancellation", () => {
  beforeAll(async () => {
    // Runtime loading shares the deadline now; resolve availability before
    // measuring short dispatch budgets (Bun cannot load isolated-vm).
    const result = await runOrSkip({
      source: "export default async () => null;",
      sdk: stubSDK(),
    });
    if (result) expect(result.success).toBe(true);
  });

  it("script timeout returns the script before its upstream call resolves", async () => {
    let callCount = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          callCount += 1;
          await new Promise((r) => setTimeout(r, 500));
          return [];
        },
      } as never,
    });

    const start = Date.now();
    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => client.entities.list({ limit: 1 });",
      sdk,
      sdkMode: "full",
      limits: { timeoutMs: 50 },
    });
    if (!result) return;

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(callCount).toBe(1);
    // Returns near 50ms, not 500ms.
    expect(Date.now() - start).toBeLessThan(450);
  });

  it("aborts before subsequent SDK calls run", async () => {
    let callCount = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          callCount += 1;
          if (callCount === 1) await new Promise((r) => setTimeout(r, 100));
          return [];
        },
      } as never,
    });

    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => { await client.entities.list(); await client.entities.list(); await client.entities.list(); return 'done'; };",
      sdk,
      sdkMode: "full",
      limits: { timeoutMs: 30 },
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(callCount).toBeLessThan(3);
  });

  it("the upstream handler receives the wall-clock signal via the SDK builder", async () => {
    // The builder form receives the runScript controller's signal so opted-in
    // handlers can short-circuit. This is the contract `query_sql` relies on.
    let receivedSignal: AbortSignal | null = null;
    let observedAborted = false;
    const result = await runOrSkip({
      source: "export default async (_ctx, client) => client.query('SELECT 1');",
      sdk: (signal) => {
        receivedSignal = signal;
        return stubSDK({
          query: async () => {
            await new Promise((r) => setTimeout(r, 200));
            observedAborted = signal.aborted;
            return [];
          },
        });
      },
      sdkMode: "full",
      limits: { timeoutMs: 30 },
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(receivedSignal).not.toBeNull();
    // Give the upstream handler time to wake up and re-check the signal.
    await new Promise((r) => setTimeout(r, 250));
    expect(observedAborted).toBe(true);
  });
});

describe("automation reaction default", () => {
  it("runScript without sdkMode keeps the full SDK manifest", async () => {
    const sdk = stubSDK({
      entities: { create: async () => ({ id: 99 }) } as never,
    });
    const result = await runOrSkip({
      source: [
        "export default async (_ctx, client) => {",
        "  if (typeof client.entities.create !== 'function') throw new Error('lost write access');",
        "  return client.entities.create({ entity_type: 'company', name: 'Reactor' });",
        "};",
      ].join("\n"),
      sdk,
    });
    if (!result) return;
    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ id: 99 });
  });
});
