import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as internal from "../../../internal/index.js";
import { callTool, seedMemoryWorkspace } from "./seed-cmd.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

test.each([
  ["https://lobu.ai/mcp", "https://app.lobu.ai"],
  ["http://localhost:8787/mcp", "http://localhost:8787"],
  ["https://gateway.test/mcp", "https://gateway.test"],
])("seed routes %s to its tool API", async (mcpUrl, apiOrigin) => {
  const dir = mkdtempSync(join(import.meta.dir, "seed-routing-"));
  try {
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `import { defineConfig, defineEntityType } from "@lobu/cli/config";
export default defineConfig({
  org: "acme",
  agents: [],
  entities: [defineEntityType({ key: "sample", name: "Sample" })],
});
`
    );
    spyOn(internal, "resolveContext").mockResolvedValue({
      name: "test",
      url: `${apiOrigin}/api/v1`,
      source: "config",
    });
    spyOn(internal, "getMemoryUrl").mockResolvedValue(mcpUrl);
    spyOn(internal, "getToken").mockResolvedValue("test-token");
    spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchMock = mock(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ entities: [] }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await seedMemoryWorkspace({ path: dir, context: "test" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${apiOrigin}/api/acme/manage_entity_schema`,
      `${apiOrigin}/api/acme/manage_entity`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer test-token",
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ctx = {
  apiBaseUrl: "https://wrong-host.test",
  orgSlug: "acme",
  token: "t",
} as unknown as Parameters<typeof callTool>[0];

describe("seed callTool failure messages", () => {
  test("an empty 405 names the URL and the status", async () => {
    globalThis.fetch = (async () =>
      new Response("", {
        status: 405,
        statusText: "Method Not Allowed",
      })) as unknown as typeof fetch;
    await expect(callTool(ctx, "manage_entity", {})).rejects.toThrow(
      /manage_entity failed via https:\/\/wrong-host\.test\/api\/acme\/manage_entity: HTTP 405 Method Not Allowed$/
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
