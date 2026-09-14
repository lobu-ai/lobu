import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MCP_PROTOCOL_VERSION } from "@lobu/core";
import * as internal from "../../../internal/index.js";
import { memoryRunCommand } from "../run.js";
import { mcpRpc } from "./mcp.js";
import {
  getSessionForOrg,
  getUsableToken,
  normalizeMcpUrl,
  resolveOrg,
} from "./memory-auth.js";

const CLOUD_MCP_URL = "https://lobu.ai/mcp";

function mockProdMemoryContext() {
  spyOn(internal, "resolveContext").mockResolvedValue({
    name: "prod",
    url: "https://community.lobu.ai/api/v1",
    source: "config",
  });
  spyOn(internal, "getMemoryUrl").mockImplementation(async () => CLOUD_MCP_URL);
  spyOn(internal, "getActiveOrg").mockImplementation(async () => "buremba");
  spyOn(internal, "findContextByMemoryUrl").mockResolvedValue({
    name: "lobu",
    url: "https://app.lobu.ai/api/v1",
    source: "default",
  });
  spyOn(internal, "getToken").mockImplementation(async (contextName) =>
    contextName === "prod" ? "prod-token" : null
  );
}

describe("memory auth URL resolution", () => {
  afterEach(() => {
    mock.restore();
    delete process.env.LOBU_API_TOKEN;
    delete process.env.LOBU_MEMORY_URL;
    delete process.env.LOBU_MEMORY_ORG;
  });

  test("preserves a mounted named MCP endpoint", () => {
    expect(normalizeMcpUrl("https://gateway.test/lobu/mcp/lobu-memory")).toBe(
      "https://gateway.test/lobu/mcp/lobu-memory"
    );
  });

  test("explicit runtime MCP URL and bearer ignore the saved active org", async () => {
    spyOn(internal, "getActiveOrg").mockResolvedValue("wrong-org");
    process.env.LOBU_API_TOKEN = "runtime-bearer";
    process.env.LOBU_MEMORY_URL = "https://gateway.test/lobu/mcp/lobu-memory";
    expect(await resolveOrg()).toBeUndefined();
    expect(internal.getActiveOrg).not.toHaveBeenCalled();
  });

  test("getSessionForOrg honors an explicit --url", async () => {
    const session = await getSessionForOrg(
      "dev",
      undefined,
      "http://localhost:8801"
    );
    expect(session?.key).toBe("http://localhost:8801/mcp/dev");
  });

  test("getUsableToken keeps the active context when memory URL matches", async () => {
    mockProdMemoryContext();

    const result = await getUsableToken("https://lobu.ai/mcp/buremba");

    expect(result?.token).toBe("prod-token");
    expect(result?.contextName).toBe("prod");
    expect(result?.session.org).toBe("buremba");
    expect(internal.findContextByMemoryUrl).not.toHaveBeenCalled();
  });

  test("memory run sends the active context token to the MCP server", async () => {
    mockProdMemoryContext();
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer prod-token",
      });
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
            },
          }),
          {
            status: 200,
            headers: { "mcp-session-id": "test-session" },
          }
        );
      }
      expect(init?.headers).toMatchObject({
        "mcp-session-id": "test-session",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      });
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            result: { tools: [{ name: "search_memory" }] },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    });
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await memoryRunCommand(undefined, undefined, { org: "buremba" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("search_memory")
    );
  });

  test("MCP 401 errors include the selected context", async () => {
    mockProdMemoryContext();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
        })
    ) as unknown as typeof fetch;

    try {
      await expect(
        mcpRpc("https://lobu.ai/mcp/buremba", "tools/list")
      ).rejects.toThrow(/using context "prod"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("tool-failure exit codes", () => {
    // NOTE: `process.exitCode = undefined` does NOT clear a set code in Bun
    // (verified: stays 1), so every test baselines to numeric 0 explicitly
    // and restores its own prior value — never undefined.
    async function runWithExitBaseline(
      fn: () => Promise<void>
    ): Promise<number | undefined> {
      const priorExitCode = process.exitCode ?? 0;
      process.exitCode = 0;
      try {
        await fn();
        return process.exitCode;
      } finally {
        process.exitCode = priorExitCode;
      }
    }

    function mockToolsCall(result: unknown) {
      mockProdMemoryContext();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          method?: string;
        };
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
              },
            }),
            {
              status: 200,
              headers: { "mcp-session-id": "test-session" },
            }
          );
        }
        return new Response(JSON.stringify({ result }), { status: 200 });
      }) as unknown as typeof fetch;
      const writeSpy = spyOn(process.stdout, "write").mockImplementation(
        () => true
      );
      return {
        writeSpy,
        restore: () => {
          globalThis.fetch = originalFetch;
        },
      };
    }

    test("an isError tool result prints JSON but exits non-zero", async () => {
      const { writeSpy, restore } = mockToolsCall({
        content: [{ type: "text", text: "boom" }],
        isError: true,
      });
      let code: number | undefined;
      try {
        code = await runWithExitBaseline(async () => {
          await memoryRunCommand("search_memory", "{}", { org: "buremba" });
        });
      } finally {
        restore();
      }
      // Stdout contract unchanged — the error payload still parses.
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("isError"));
      expect(code).toBe(1);
    });

    test("a run_sdk script failure (success:false data) exits non-zero", async () => {
      const { restore } = mockToolsCall({
        success: false,
        error: { message: "boom" },
      });
      let code: number | undefined;
      try {
        code = await runWithExitBaseline(async () => {
          await memoryRunCommand("run_sdk", JSON.stringify({ script: "x" }), {
            org: "buremba",
          });
        });
      } finally {
        restore();
      }
      expect(code).toBe(1);
    });

    test("a successful result leaves the exit code at baseline", async () => {
      const { writeSpy, restore } = mockToolsCall({
        success: true,
        values: [1],
      });
      let code: number | undefined;
      try {
        code = await runWithExitBaseline(async () => {
          await memoryRunCommand("run_sdk", JSON.stringify({ script: "x" }), {
            org: "buremba",
          });
        });
      } finally {
        restore();
      }
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('"success": true')
      );
      expect(code).toBe(0);
    });
  });

  const e2e = process.env.LOBU_E2E_MEMORY === "1" ? test : test.skip;

  e2e("memory run works against a real MCP server", async () => {
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true
    );

    await memoryRunCommand("list_organizations", "{}", {
      context: process.env.LOBU_E2E_CONTEXT,
      org: process.env.LOBU_E2E_MEMORY_ORG,
    });

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("content"));
  });
});
