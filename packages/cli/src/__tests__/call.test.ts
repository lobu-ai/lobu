import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCallTitle,
  buildArgs,
  callCommand,
  parseArgEntry,
} from "../commands/call";
import { ValidationError } from "../commands/memory/_lib/errors";
import * as memoryAuth from "../commands/memory/_lib/memory-auth";
import * as apiClient from "../internal/api-client";

const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array, cb?: unknown) => {
    chunks.push(String(chunk));
    if (typeof cb === "function") {
      (cb as (error?: Error | null) => void)(null);
    }
    return true;
  }) as typeof process.stdout.write;
  return {
    chunks,
    restore: () => {
      process.stdout.write = originalStdoutWrite;
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  mock.restore();
});

describe("parseArgEntry", () => {
  test("key=value parses as a string", () => {
    expect(parseArgEntry("name=alice")).toEqual(["name", "alice"]);
  });

  test("preserves '=' characters in the value", () => {
    expect(parseArgEntry("query=a=b=c")).toEqual(["query", "a=b=c"]);
  });

  test("key:=<json> parses the right-hand side as JSON", () => {
    expect(parseArgEntry("count:=42")).toEqual(["count", 42]);
    expect(parseArgEntry("enabled:=true")).toEqual(["enabled", true]);
    expect(parseArgEntry("arr:=[1,2,3]")).toEqual(["arr", [1, 2, 3]]);
    expect(parseArgEntry('obj:={"a":1}')).toEqual(["obj", { a: 1 }]);
  });

  test("':=' wins over a later '='", () => {
    expect(parseArgEntry('payload:={"foo":"bar=baz"}')).toEqual([
      "payload",
      { foo: "bar=baz" },
    ]);
  });

  test("rejects entries with no '=' or ':='", () => {
    expect(() => parseArgEntry("nope")).toThrow(ValidationError);
  });

  test("rejects empty keys", () => {
    expect(() => parseArgEntry("=value")).toThrow(ValidationError);
    expect(() => parseArgEntry(":=42")).toThrow(ValidationError);
  });

  test("rejects malformed JSON after ':='", () => {
    expect(() => parseArgEntry("x:={not-json}")).toThrow(ValidationError);
  });
});

describe("buildArgs", () => {
  test("builds an object from a mix of string and JSON args", async () => {
    const result = await buildArgs({
      arg: ["action=trigger_feed", "feed_id:=42", "force:=true"],
    });
    expect(result).toEqual({
      action: "trigger_feed",
      feed_id: 42,
      force: true,
    });
  });

  test("reads --input-file when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-call-"));
    const path = join(dir, "args.json");
    writeFileSync(path, JSON.stringify({ action: "list", page: 2 }));
    try {
      const result = await buildArgs({ inputFile: path });
      expect(result).toEqual({ action: "list", page: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects --arg + --input-file combination", async () => {
    expect(
      buildArgs({ arg: ["foo=bar"], inputFile: "/tmp/whatever.json" })
    ).rejects.toThrow(ValidationError);
  });

  test("rejects --input-file pointing at a JSON array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-call-"));
    const path = join(dir, "args.json");
    writeFileSync(path, JSON.stringify([1, 2, 3]));
    try {
      expect(buildArgs({ inputFile: path })).rejects.toThrow(ValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("callCommand", () => {
  function stubAuth() {
    spyOn(memoryAuth, "resolveOrg").mockResolvedValue("acme");
    spyOn(memoryAuth, "getSessionForOrg").mockResolvedValue({
      session: {
        mcpUrl: "https://example.test/mcp/acme",
        org: "acme",
        tokenType: "Bearer",
      },
      key: "https://example.test/mcp/acme",
    });
    spyOn(apiClient, "resolveApiClient").mockResolvedValue({
      client: new apiClient.ApiClient("https://example.test", "test-token", ((
        input,
        init
      ) => globalThis.fetch(input, init)) as typeof fetch),
      contextName: "default",
      apiBaseUrl: "https://example.test",
      orgSlug: "acme",
      token: "test-token",
    });
    spyOn(memoryAuth, "getUsableToken").mockResolvedValue({
      token: "test-token",
      contextName: "default",
      session: {
        mcpUrl: "https://example.test/mcp/acme",
        org: "acme",
        tokenType: "Bearer",
      },
    });
  }

  test("--list prints a tool table, filtering internal tools by default", async () => {
    stubAuth();
    const fetchMock = mock(async (url: string) => {
      expect(url).toBe("https://example.test/api/acme/tools");
      return new Response(
        JSON.stringify({
          tools: [
            { name: "manage_feeds", description: "Feed mgmt", internal: true },
            {
              name: "search_memory",
              description: "Search memory",
              internal: false,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const captured = captureStdout();
    try {
      await callCommand(undefined, { list: true });
    } finally {
      captured.restore();
    }
    const output = captured.chunks.join("");
    expect(output).toContain("search_memory");
    expect(output).not.toContain("manage_feeds");
    expect(output).toContain("1 tool(s)");
  });

  test("--list --all includes admin tools with [admin] marker", async () => {
    stubAuth();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tools: [
            { name: "manage_feeds", description: "Feeds", internal: true },
            { name: "search_memory", description: "Search", internal: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    const captured = captureStdout();
    try {
      await callCommand(undefined, { list: true, all: true });
    } finally {
      captured.restore();
    }
    const output = captured.chunks.join("");
    expect(output).toContain("manage_feeds");
    expect(output).toContain("[admin]");
    expect(output).toContain("2 tool(s)");
  });

  test("--list --json emits a tools array as JSON", async () => {
    stubAuth();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tools: [{ name: "search_memory", description: "x", internal: false }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    const captured = captureStdout();
    try {
      await callCommand(undefined, { list: true, json: true });
    } finally {
      captured.restore();
    }
    const parsed = JSON.parse(captured.chunks.join(""));
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("search_memory");
  });

  test("--list uses the explicit/context API origin instead of the marketing host", async () => {
    stubAuth();
    const fetchMock = mock(async (url: string) => {
      expect(url).toBe("https://cloud.example.test/api/acme/tools");
      return new Response(JSON.stringify({ tools: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    spyOn(apiClient, "resolveApiClient").mockResolvedValue({
      client: new apiClient.ApiClient(
        "https://cloud.example.test",
        "test-token",
        fetchMock as unknown as typeof fetch
      ),
      contextName: "cloud",
      apiBaseUrl: "https://cloud.example.test",
      orgSlug: "acme",
      token: "test-token",
    });

    await callCommand(undefined, {
      list: true,
      context: "cloud",
      url: "https://cloud.example.test/api/v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("dispatches a tool call and prints the JSON result", async () => {
    stubAuth();
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://example.test/api/acme/manage_feeds");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "list",
        page: 2,
      });
      return new Response(JSON.stringify({ feeds: [{ id: 1 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const captured = captureStdout();
    try {
      await callCommand("manage_feeds", {
        arg: ["action=list", "page:=2"],
      });
    } finally {
      captured.restore();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(captured.chunks.join(""));
    expect(parsed).toEqual({ feeds: [{ id: 1 }] });
  });

  test("missing org slug surfaces a ValidationError", async () => {
    spyOn(memoryAuth, "resolveOrg").mockResolvedValue(undefined);
    // An explicit --arg keeps buildArgs off process stdin, which bun:test
    // shares across every test in the file.
    await expect(
      callCommand("manage_feeds", { arg: ["action=list"] })
    ).rejects.toThrow(ValidationError);
  });

  test("404 on missing tool propagates as an ApiError", async () => {
    stubAuth();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Tool not found: bogus" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(callCommand("bogus", { arg: ["x=1"] })).rejects.toThrow(
      /Tool not found: bogus/
    );
  });

  test("a 200 soft-error payload prints JSON and exits non-zero", async () => {
    stubAuth();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ rows: [], error: "syntax error near DROP" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    // NOTE: `process.exitCode = undefined` does not clear a set code in
    // Bun — baseline to numeric 0 explicitly (see memory-auth.test.ts).
    const priorExitCode = process.exitCode ?? 0;
    process.exitCode = 0;
    const captured = captureStdout();
    let code: number | undefined;
    try {
      await callCommand("query_sql", {
        arg: ["title=Soft error probe", "sql=SELECT 1"],
      });
      code = process.exitCode;
    } finally {
      captured.restore();
      process.exitCode = priorExitCode;
    }
    // Stdout contract unchanged — the error payload still parses.
    expect(JSON.parse(captured.chunks.join("")).error).toContain(
      "syntax error"
    );
    expect(code).toBe(1);
  });

  test("a successful call leaves the exit code untouched", async () => {
    stubAuth();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ feeds: [{ id: 1 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const priorExitCode = process.exitCode ?? 0;
    process.exitCode = 0;
    const captured = captureStdout();
    let code: number | undefined = -1;
    try {
      await callCommand("manage_feeds", { arg: ["action=list"] });
      code = process.exitCode;
    } finally {
      captured.restore();
      process.exitCode = priorExitCode;
    }
    expect(code).toBe(0);
  });
});

describe("titled SDK/SQL calls", () => {
  test.each([
    "run_sdk",
    "query_sdk",
    "query_sql",
  ])("%s without a title is refused with the exact fix", (tool) => {
    for (const args of [{}, { title: "" }, { title: "   " }, { title: 7 }]) {
      expect(() => assertCallTitle(tool, args)).toThrow(ValidationError);
    }
    expect(() => assertCallTitle(tool, {})).toThrow(
      `lobu call ${tool} --arg title='Recent support tickets'`
    );
    expect(() =>
      assertCallTitle(tool, { title: "Recent support tickets" })
    ).not.toThrow();
  });

  test("other tools need no title", () => {
    expect(() => assertCallTitle("manage_feeds", {})).not.toThrow();
  });

  test("an untitled run_sdk call never reaches the network", async () => {
    spyOn(memoryAuth, "resolveOrg").mockResolvedValue("acme");
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      callCommand("run_sdk", { arg: ["script=export default async () => 1"] })
    ).rejects.toThrow(/requires a non-empty `title` arg/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    "run_sdk",
    "query_sdk",
    "query_sql",
  ])("%s reports a missing title before resolving a workspace", async (tool) => {
    const resolveOrg = spyOn(memoryAuth, "resolveOrg").mockResolvedValue(
      undefined
    );
    await expect(callCommand(tool, { arg: ["sql=SELECT 1"] })).rejects.toThrow(
      /requires a non-empty `title` arg/
    );
    expect(resolveOrg).not.toHaveBeenCalled();
  });

  test("a title from --input-file satisfies the check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-call-"));
    const path = join(dir, "args.json");
    writeFileSync(
      path,
      JSON.stringify({ title: "From file", sql: "SELECT 1" })
    );
    try {
      const args = await buildArgs({ inputFile: path });
      expect(() => assertCallTitle("query_sql", args)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runtime MCP credential (LOBU_API_TOKEN + LOBU_MEMORY_URL)", () => {
  const RUNTIME_URL = "https://runtime.example.test/mcp/team-org";
  const saved = {
    token: process.env.LOBU_API_TOKEN,
    url: process.env.LOBU_MEMORY_URL,
    org: process.env.LOBU_MEMORY_ORG,
  };

  function restoreEnv(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(() => {
    restoreEnv("LOBU_API_TOKEN", saved.token);
    restoreEnv("LOBU_MEMORY_URL", saved.url);
    restoreEnv("LOBU_MEMORY_ORG", saved.org);
  });

  function stubRuntimeMcp(toolResult: unknown) {
    process.env.LOBU_API_TOKEN = "runtime-worker-token";
    process.env.LOBU_MEMORY_URL = RUNTIME_URL;
    delete process.env.LOBU_MEMORY_ORG;
    spyOn(memoryAuth, "getUsableToken").mockResolvedValue({
      token: "runtime-worker-token",
      contextName: "default",
      session: { mcpUrl: RUNTIME_URL, tokenType: "Bearer" },
    });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer runtime-worker-token"
      );
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ result: { protocolVersion: "2025-03-26" } }),
          { status: 200, headers: { "mcp-session-id": "s-1" } }
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      return new Response(JSON.stringify({ result: toolResult }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return requests;
  }

  test("dispatches the tool over MCP tools/call to LOBU_MEMORY_URL, never REST", async () => {
    const requests = stubRuntimeMcp({
      content: [{ type: "text", text: "ok" }],
    });
    const captured = captureStdout();
    try {
      await callCommand("run_sdk", {
        arg: [
          "title=Read window input",
          "script=export default async (_ctx, client) => 1",
        ],
      });
    } finally {
      captured.restore();
    }
    expect(requests.every((r) => r.url === RUNTIME_URL)).toBe(true);
    expect(requests.map((r) => r.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(requests[2]?.body.params).toEqual({
      name: "run_sdk",
      arguments: {
        title: "Read window input",
        script: "export default async (_ctx, client) => 1",
      },
    });
    expect(JSON.parse(captured.chunks.join(""))).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  test("an MCP isError result prints and exits non-zero", async () => {
    stubRuntimeMcp({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
    const priorExitCode = process.exitCode ?? 0;
    process.exitCode = 0;
    const captured = captureStdout();
    let code: number | undefined;
    try {
      await callCommand("run_sdk", {
        arg: ["title=Failing script", "script=export default async () => 1"],
      });
      code = process.exitCode;
    } finally {
      captured.restore();
      process.exitCode = priorExitCode;
    }
    expect(code).toBe(1);
  });

  test("the title check also guards the MCP transport", async () => {
    const requests = stubRuntimeMcp({});
    await expect(
      callCommand("query_sdk", { arg: ["script=export default async () => 1"] })
    ).rejects.toThrow(ValidationError);
    expect(requests).toHaveLength(0);
  });

  test("--list reads tools/list over MCP", async () => {
    const requests = stubRuntimeMcp({
      tools: [{ name: "run_sdk", description: "Run SDK" }],
    });
    const captured = captureStdout();
    try {
      await callCommand(undefined, { list: true });
    } finally {
      captured.restore();
    }
    expect(requests.at(-1)?.body.method).toBe("tools/list");
    expect(captured.chunks.join("")).toContain("run_sdk");
  });
});
