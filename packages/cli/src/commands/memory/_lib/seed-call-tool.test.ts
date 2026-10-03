import { afterEach, describe, expect, test } from "bun:test";
import { callTool } from "./seed-cmd.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = {
  apiBaseUrl: "https://wrong-host.test",
  orgSlug: "acme",
  token: "t",
} as unknown as Parameters<typeof callTool>[0];

describe("seed callTool failure messages", () => {
  test("an empty 405 names the URL, the status and the memoryUrl fallback", async () => {
    globalThis.fetch = (async () =>
      new Response("", {
        status: 405,
        statusText: "Method Not Allowed",
      })) as unknown as typeof fetch;
    await expect(callTool(ctx, "manage_entity", {})).rejects.toThrow(
      /manage_entity failed via https:\/\/wrong-host\.test\/api\/acme\/manage_entity: HTTP 405[\s\S]*no memoryUrl/
    );
  });

  test("a 200 with a non-JSON body still reports the URL", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(callTool(ctx, "manage_entity", {})).rejects.toThrow(
      /Invalid JSON from manage_entity via https:\/\/wrong-host\.test\/api\/acme\/manage_entity/
    );
  });
});
