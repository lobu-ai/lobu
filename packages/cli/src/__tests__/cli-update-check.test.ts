import { describe, expect, test } from "bun:test";
import {
  checkForCliUpdate,
  isNewerCliRelease,
  startCliUpdateNotifier,
} from "../internal/cli-update-check";

function distTags(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("lobu daemon update check", () => {
  test("compares release components, not strings", () => {
    expect(isNewerCliRelease("19.2.0", "24.3.0")).toBe(true);
    expect(isNewerCliRelease("9.0.0", "10.0.0")).toBe(true);
    expect(isNewerCliRelease("24.3.0", "24.3.0")).toBe(false);
    expect(isNewerCliRelease("24.3.1", "24.3.0")).toBe(false);
    // A canary is built after its base release.
    expect(
      isNewerCliRelease(`24.3.0-canary.1700000000.g${"a".repeat(40)}`, "24.3.0")
    ).toBe(false);
    expect(
      isNewerCliRelease(`24.3.0-canary.1700000000.g${"a".repeat(40)}`, "24.4.0")
    ).toBe(true);
    expect(isNewerCliRelease("dev", "24.3.0")).toBe(false);
    expect(isNewerCliRelease("24.3.0", "garbage")).toBe(false);
  });

  test("prints one line naming both versions and the update steps", async () => {
    const line = await checkForCliUpdate(
      "19.2.0",
      distTags({ latest: "24.3.0", canary: "24.4.0-canary.1" })
    );
    expect(line).toContain("Lobu CLI 24.3.0 is available");
    expect(line).toContain("runs 19.2.0");
    expect(line).toContain("npx -y @lobu/cli@latest daemon");
    expect(line).toContain("LOBU_NO_UPDATE_CHECK=1");
    expect(line).not.toContain("\n");
  });

  test("an up-to-date daemon prints nothing", async () => {
    expect(
      await checkForCliUpdate("24.3.0", distTags({ latest: "24.3.0" }))
    ).toBeNull();
  });

  test("registry failures never surface", async () => {
    expect(
      await checkForCliUpdate("19.2.0", distTags({ error: "nope" }, 503))
    ).toBeNull();
    expect(await checkForCliUpdate("19.2.0", distTags(null))).toBeNull();
    expect(
      await checkForCliUpdate("19.2.0", (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch)
    ).toBeNull();
  });

  test("the notifier checks at start and on its interval, then stops", async () => {
    const printed: string[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ latest: "24.3.0" }));
    }) as unknown as typeof fetch;
    const stop = startCliUpdateNotifier({
      currentVersion: "19.2.0",
      env: {},
      fetchImpl,
      print: (line) => printed.push(line),
      intervalMs: 20,
    });
    await flush();
    expect(calls).toBe(1);
    expect(printed).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    const afterStop = calls;
    expect(afterStop).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(afterStop);
  });

  test("the opt-out and an unknown running version skip the registry entirely", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ latest: "24.3.0" }));
    }) as unknown as typeof fetch;
    startCliUpdateNotifier({
      currentVersion: "19.2.0",
      env: { LOBU_NO_UPDATE_CHECK: "1" },
      fetchImpl,
    })();
    startCliUpdateNotifier({ currentVersion: undefined, env: {}, fetchImpl })();
    await flush();
    expect(calls).toBe(0);
  });

  test("stopping suppresses a check that was already in flight", async () => {
    const printed: string[] = [];
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const stop = startCliUpdateNotifier({
      currentVersion: "19.2.0",
      env: {},
      fetchImpl: (() => pending) as typeof fetch,
      print: (line) => printed.push(line),
    });
    stop();
    finish(new Response(JSON.stringify({ latest: "24.3.0" })));
    await flush();
    expect(printed).toEqual([]);
  });
});
