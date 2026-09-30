import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken, MCP_PROTOCOL_VERSION } from "@lobu/core";
import { orgContext } from "../../lobu/stores/org-context.js";
import {
  MCP_RESPONSE_BODY_LIMIT,
  MCP_SSE_FRAME_LIMIT,
} from "../../mcp-proxy/http-response.js";
import { McpProxy } from "../auth/mcp/proxy.js";
import { McpUpstreamClient } from "../auth/mcp/proxy-upstream.js";
import { McpToolCache } from "../auth/mcp/tool-cache.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: import("@lobu/core").McpOAuthConfig;
  inputs?: unknown[];
  headers?: Record<string, string>;
}

interface McpConfigSource {
  getHttpServer(
    id: string,
    agentId?: string
  ): Promise<HttpMcpServerConfig | undefined>;
  getAllHttpServers(
    agentId?: string
  ): Promise<Map<string, HttpMcpServerConfig>>;
}

function createMockConfigSource(
  servers: Record<string, HttpMcpServerConfig>
): McpConfigSource {
  return {
    getHttpServer: async (id) => servers[id],
    getAllHttpServers: async () => new Map(Object.entries(servers)),
  };
}

function mockUpstreamFetch(responseData: any) {
  globalThis.fetch = async (_input, init) => {
    const request = init?.body ? JSON.parse(String(init.body)) : {};
    const body =
      request.method === "initialize"
        ? {
            jsonrpc: "2.0",
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
            },
          }
        : responseData;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...(request.method === "initialize"
          ? { "Mcp-Session-Id": "test-session" }
          : {}),
      },
    });
  };
}

const TEST_SERVER: HttpMcpServerConfig = {
  id: "test-mcp",
  upstreamUrl: "http://upstream:9000/mcp",
};

let originalEnv: string | undefined;
let validToken: string;
let originalFetch: typeof fetch;

beforeAll(async () => {
  // Request authentication checks revocation through Postgres.
  const { ensureDbForGatewayTests, seedAgentRow } = await import(
    "./helpers/db-setup.js"
  );
  await ensureDbForGatewayTests();
  await seedAgentRow("agent1");
  originalEnv = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  validToken = generateWorkerToken("user1", "conv1", "deploy1", {
    channelId: "ch1",
    agentId: "agent1",
    organizationId: "test-org",
  });
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  if (originalEnv !== undefined) process.env.ENCRYPTION_KEY = originalEnv;
  else delete process.env.ENCRYPTION_KEY;
  globalThis.fetch = originalFetch;
});

describe("McpProxy", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ---------- Auth tests ----------

  describe("authentication", () => {
    test("rejects missing token", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      const res = await app.request("/test-mcp/tools", { method: "GET" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Invalid authentication token");
    });

    test("rejects invalid token", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: "Bearer invalid-garbage" },
      });
      expect(res.status).toBe(401);
    });

    test("accepts Bearer header", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "tool1" }] },
      });

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
    });

    test("rejects workerToken query param", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "tool1" }] },
      });

      const res = await app.request(
        `/test-mcp/tools?workerToken=${validToken}`,
        { method: "GET" }
      );
      expect(res.status).toBe(401);
    });
  });

  // ---------- GET /:mcpId/tools ----------

  describe("GET /:mcpId/tools", () => {
    test("returns tools from upstream", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      const tools = [
        { name: "read_file", description: "Read a file" },
        { name: "write_file", description: "Write a file" },
      ];
      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: { tools },
      });

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0].name).toBe("read_file");
      expect(body.tools[1].name).toBe("write_file");
    });

    test("returns 404 for unknown MCP", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      const res = await app.request("/nonexistent/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });

    test("accepts a server without tools capability without calling tools/list", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {});
      const app = proxy.getApp();
      const methods: string[] = [];

      globalThis.fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        methods.push(request.method);
        if (request.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
              },
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Mcp-Session-Id": "toolless-session",
              },
            },
          );
        }
        return new Response(null, { status: 202 });
      };

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tools: [] });
      expect(methods).toEqual(["initialize", "notifications/initialized"]);
    });

    test("treats an upstream initialize 401 as an unauthenticated empty catalog", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {});
      const app = proxy.getApp();
      let fetchCount = 0;

      globalThis.fetch = async () => {
        fetchCount++;
        return new Response("authentication required", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      };

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tools: [] });
      expect(fetchCount).toBe(1);
    });

    test("returns 502 on upstream error", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      globalThis.fetch = async () => {
        throw new Error("Connection refused");
      };

      const res = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("Failed to connect");
    });

    test("caches tools on second request", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const toolCache = new McpToolCache();
      const proxy = new McpProxy(configSource, {        toolCache,
      });
      const app = proxy.getApp();

      let fetchCount = 0;
      globalThis.fetch = async (_input, init) => {
        fetchCount++;
        const request = init?.body ? JSON.parse(String(init.body)) : {};
        if (request.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
              },
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Mcp-Session-Id": "cache-session",
              },
            },
          );
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "cached_tool" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      // First request fetches from upstream
      const res1 = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res1.status).toBe(200);
      const firstFetchCount = fetchCount;

      // Second request should use cache
      const res2 = await app.request("/test-mcp/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res2.status).toBe(200);
      const body = await res2.json();
      expect(body.tools[0].name).toBe("cached_tool");
      // fetch should NOT have been called again
      expect(fetchCount).toBe(firstFetchCount);
    });
  });

  // ---------- POST /:mcpId/tools/:toolName ----------

  describe("POST /:mcpId/tools/:toolName", () => {
    test("forwards call and returns result", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      mockUpstreamFetch({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "Hello world" }],
          isError: false,
        },
      });

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ arg1: "value1" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toHaveLength(1);
      expect(body.content[0].text).toBe("Hello world");
      expect(body.isError).toBe(false);
    });

    test("returns 400 for invalid JSON body", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: "not valid json {{{",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid JSON");
    });

    test("returns 404 for unknown MCP", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      const res = await app.request("/nonexistent/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    test("returns 502 on upstream error", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      globalThis.fetch = async () => {
        throw new Error("Connection refused");
      };

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("Failed to connect");
    });

    test("cancels initialize body reads when the downstream request aborts", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {});
      const app = proxy.getApp();
      const downstream = new AbortController();
      let resolveFetchStarted: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => {
        resolveFetchStarted = resolve;
      });
      let upstreamSignal: AbortSignal | null = null;

      globalThis.fetch = async (_input, init) => {
        upstreamSignal = init?.signal ?? null;
        resolveFetchStarted?.();
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => undefined);
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      };

      const responsePromise = app.request(
        new Request("http://localhost/test-mcp/tools", {
          headers: { Authorization: `Bearer ${validToken}` },
          signal: downstream.signal,
        }),
      );
      await fetchStarted;
      downstream.abort();

      const response = await responsePromise;
      expect(response.status).toBe(502);
      expect(upstreamSignal?.aborted).toBe(true);
      expect(upstreamSignal?.reason).toMatchObject({ kind: "caller_abort" });
    });

    test("cancels oversized upstream bodies and logs observed response bytes", async () => {
      const outcomes: unknown[] = [];
      const upstream = new McpUpstreamClient({
        info: (outcome) => outcomes.push(outcome),
      });
      let cancelled = false;
      let emitted = false;
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!emitted) {
                emitted = true;
                controller.enqueue(new Uint8Array(MCP_RESPONSE_BODY_LIMIT + 1));
              }
              return new Promise(() => undefined);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );

      await expect(
        orgContext.run({ organizationId: "test-org" }, () =>
          upstream.sendUpstreamRequest(
            {
              id: "bounded-mcp",
              upstreamUrl: "http://bounded.internal/mcp",
              internal: true,
            },
            "agent1",
            "bounded-mcp",
            "POST",
            JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          ),
        ),
      ).rejects.toMatchObject({
        kind: "oversized_response",
        bytes: MCP_RESPONSE_BODY_LIMIT + 1,
      });

      expect(cancelled).toBe(true);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        response_bytes: MCP_RESPONSE_BODY_LIMIT + 1,
        response_limit: MCP_RESPONSE_BODY_LIMIT,
        truncated: true,
        aborted: false,
        abort_reason: null,
      });
    });

    test("rejects oversized POST SSE frames below the response body limit", async () => {
      const outcomes: unknown[] = [];
      const upstream = new McpUpstreamClient({
        info: (outcome) => outcomes.push(outcome),
      });
      const body = `data: ${"x".repeat(MCP_SSE_FRAME_LIMIT)}\n\n`;
      expect(new TextEncoder().encode(body).byteLength).toBeLessThan(
        MCP_RESPONSE_BODY_LIMIT,
      );
      globalThis.fetch = async () =>
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });

      await expect(
        orgContext.run({ organizationId: "test-org" }, () =>
          upstream.sendUpstreamRequest(
            {
              id: "bounded-mcp",
              upstreamUrl: "http://bounded.internal/mcp",
              internal: true,
            },
            "agent1",
            "bounded-mcp",
            "POST",
            JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          ),
        ),
      ).rejects.toMatchObject({
        kind: "oversized_response",
        limit: MCP_SSE_FRAME_LIMIT,
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        response_bytes: MCP_SSE_FRAME_LIMIT + 1,
        jsonrpc_status: "unknown",
        truncated: true,
      });
    });

    test("relays POST SSE before EOF and cancels it at the POST deadline", async () => {
      const outcomes: unknown[] = [];
      const upstream = new McpUpstreamClient(
        {
          info: (outcome) => outcomes.push(outcome),
        },
        100,
      );
      const frame = new TextEncoder().encode(
        'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
      );
      let cancelled = false;
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );

      const response = await orgContext.run(
        { organizationId: "test-org" },
        () =>
          upstream.sendUpstreamRequest(
            {
              id: "streaming-mcp",
              upstreamUrl: "http://streaming.internal/mcp",
              internal: true,
            },
            "agent1",
            "streaming-mcp",
            "POST",
            JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
          ),
      );
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        new TextDecoder().decode(frame),
      );
      await expect(reader.read()).rejects.toMatchObject({ kind: "timeout" });

      expect(cancelled).toBe(true);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        response_bytes: frame.byteLength,
        jsonrpc_status: "unknown",
        aborted: true,
        abort_reason: "timeout",
      });
    });
  });

  // ---------- Session re-init ----------

  describe("session re-initialization", () => {
    test("does not replay after a post-dispatch JSON-RPC session error", async () => {
      const configSource = createMockConfigSource({
        "test-mcp": TEST_SERVER,
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      const methods: string[] = [];
      globalThis.fetch = async (_input, init) => {
        const request = init?.body ? JSON.parse(String(init.body)) : {};
        methods.push(request.method);
        if (request.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json", "Mcp-Session-Id": "initial-session" },
            },
          );
        }
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "Server not initialized" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const res = await app.request("/test-mcp/tools/my_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("Server not initialized");
      expect(methods).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
    });
  });

  // ---------- GET /tools (list all) ----------

  describe("GET /tools", () => {
    test("lists tools from all MCPs", async () => {
      const configSource = createMockConfigSource({
        mcp1: {
          id: "mcp1",
          upstreamUrl: "http://upstream1:9000/mcp",
        },
        mcp2: {
          id: "mcp2",
          upstreamUrl: "http://upstream2:9000/mcp",
        },
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      globalThis.fetch = async (url: string | URL | Request, init) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        const tools = urlStr.includes("upstream1")
          ? [{ name: "tool_a" }]
          : [{ name: "tool_b" }];
        const request = init?.body ? JSON.parse(String(init.body)) : {};
        if (request.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
              },
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Mcp-Session-Id": `session-${urlStr}`,
              },
            },
          );
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await app.request("/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mcpServers.mcp1.tools[0].name).toBe("tool_a");
      expect(body.mcpServers.mcp2.tools[0].name).toBe("tool_b");
    });

    test("tolerates individual MCP failures", async () => {
      const configSource = createMockConfigSource({
        good: {
          id: "good",
          upstreamUrl: "http://good-upstream:9000/mcp",
        },
        bad: {
          id: "bad",
          upstreamUrl: "http://bad-upstream:9000/mcp",
        },
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      globalThis.fetch = async (url: string | URL | Request, init) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (urlStr.includes("bad-upstream")) {
          throw new Error("Connection refused");
        }
        const request = init?.body ? JSON.parse(String(init.body)) : {};
        if (request.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
              },
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Mcp-Session-Id": "good-session",
              },
            },
          );
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "working_tool" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await app.request("/tools", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The "good" MCP should still have its tools
      expect(body.mcpServers.good.tools[0].name).toBe("working_tool");
      // The "bad" MCP should be absent (empty tools are filtered out)
      expect(body.mcpServers.bad).toBeUndefined();
    });
  });

  // ---------- isMcpRequest ----------

  describe("isMcpRequest", () => {
    test("returns true with x-mcp-id header", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, {      });

      // Use a wrapper Hono app to get a real Context object
      const { Hono } = await import("hono");
      const wrapper = new Hono();
      let result = false;
      wrapper.all("/*", (c) => {
        result = proxy.isMcpRequest(c);
        return c.json({ result });
      });

      await wrapper.request("/anything", {
        method: "GET",
        headers: { "x-mcp-id": "some-mcp" },
      });
      expect(result).toBe(true);
    });

    test("returns false without x-mcp-id header", async () => {
      const configSource = createMockConfigSource({});
      const proxy = new McpProxy(configSource, {      });

      const { Hono } = await import("hono");
      const wrapper = new Hono();
      let result = true;
      wrapper.all("/*", (c) => {
        result = proxy.isMcpRequest(c);
        return c.json({ result });
      });

      await wrapper.request("/anything", { method: "GET" });
      expect(result).toBe(false);
    });
  });
});
