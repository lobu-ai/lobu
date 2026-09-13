import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildArgs, callCommand, parseArgEntry } from "../commands/call";
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
      client: new apiClient.ApiClient(
        "https://example.test",
        "test-token",
        ((input, init) => globalThis.fetch(input, init)) as typeof fetch
      ),
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
    expect(callCommand("manage_feeds", {})).rejects.toThrow(ValidationError);
  });

  test("404 on missing tool propagates as an ApiError", async () => {
    stubAuth();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Tool not found: bogus" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    expect(callCommand("bogus", { arg: [] })).rejects.toThrow(
      /Tool not found: bogus/
    );
  });
});
