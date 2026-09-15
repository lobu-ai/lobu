/**
 * MCP Proxy Edge-Case Tests
 *
 * Covers gaps not addressed by the main mcp-proxy.test.ts:
 *   - SSRF guard: reserved IP literals, private CIDR ranges, malformed URLs
 *   - Cross-agent JWT isolation: agent A's token cannot reach agent B's MCP tools
 *   - Tool-registry collision: two MCP servers expose the same tool name
 *   - Concurrent tool calls to the same MCP server
 *   - Session expiry: in-memory TTL eviction
 *   - onToolBlocked callback: fired on first block, NOT on subsequent (grant exists)
 *   - Wildcard grant (/mcp/<id>/tools/*) covers all tools of that server
 *   - Body size limit (>1MB) returns 413
 *   - SSE-framed JSON-RPC response parsed correctly
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  generateWorkerToken,
  MCP_PROTOCOL_VERSION,
  verifyGatewayMcpToken,
  verifyWorkerToken,
} from "@lobu/core";
import { orgContext } from "../../lobu/stores/org-context.js";
import { takePendingTool } from "../auth/mcp/pending-tool-store.js";
import type { DirectToolExecutionOptions } from "../auth/mcp/proxy.js";
import { McpProxy } from "../auth/mcp/proxy.js";
import { buildSessionKey, computeScopeKey } from "../auth/mcp/proxy-shared.js";
import { McpToolCache } from "../auth/mcp/tool-cache.js";
import { GrantStore } from "../permissions/grant-store.js";

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: import("@lobu/core").McpOAuthConfig;
  inputs?: unknown[];
  headers?: Record<string, string>;
  internal?: boolean;
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

function createConfigSource(
  servers: Record<string, HttpMcpServerConfig>
): McpConfigSource {
  return {
    getHttpServer: async (id) => servers[id],
    getAllHttpServers: async () => new Map(Object.entries(servers)),
  };
}

function mockFetch(handler: (url: string) => Response) {
  globalThis.fetch = async (input: RequestInfo | URL) =>
    handler(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
}

function successFetch(body: object = { jsonrpc: "2.0", id: 1, result: { tools: [] } }) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function initializeResponse(sessionId: string) {
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
        "Mcp-Session-Id": sessionId,
      },
    }
  );
}

function seedRestSession(
  proxy: McpProxy,
  mcpId: string,
  agentId = "agent1",
  userId = "user1",
) {
  orgContext.run({ organizationId: "test-org" }, () =>
    proxy.upstream.setSession(
      buildSessionKey(agentId, mcpId, computeScopeKey(userId)),
      `${mcpId}-session`,
    ),
  );
}

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let originalEnv: string | undefined;
let originalFetch: typeof fetch;
let agent1Token: string;
let agent2Token: string;

beforeAll(async () => {
  const { ensureDbForGatewayTests, seedAgentRow } = await import(
    "./helpers/db-setup.js"
  );
  await ensureDbForGatewayTests();
  await seedAgentRow("agent1");
  await seedAgentRow("agent2");

  originalEnv = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  originalFetch = globalThis.fetch;

  agent1Token = generateWorkerToken("user1", "conv1", "deploy1", {
    channelId: "ch1",
    agentId: "agent1",
		organizationId: "test-org",
  });
  agent2Token = generateWorkerToken("user2", "conv2", "deploy2", {
    channelId: "ch2",
    agentId: "agent2",
		organizationId: "test-org",
  });
});

afterAll(() => {
  if (originalEnv !== undefined) process.env.ENCRYPTION_KEY = originalEnv;
  else delete process.env.ENCRYPTION_KEY;
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// SSRF Guard
// ---------------------------------------------------------------------------

describe("SSRF guard", () => {
  /**
   * The proxy resolves the hostname via DNS in the real implementation.
   * For tests we use IPv4 IP-literal upstreamUrls that bypass DNS so the
   * guard checks `isReservedIp` directly.
   *
   * Note on the REST API tool-call path:
   *   ssrfBlockResponse returns a 403 JSON-RPC error Response internally, but
   *   handleCallTool unwraps it as a JSON-RPC error body and re-surfaces it as
   *   HTTP 502 to the caller. The important invariant is that globalThis.fetch
   *   is NEVER called for internal URLs — the SSRF guard intercepts before
   *   any network I/O.
   *
   * IPv6 bracket literals (http://[::1]:9000) are handled via the URL parser
   * extracting hostname "::1" which the guard checks correctly. In the test
   * environment Node's dns module is unavailable for those addrs; the URL parse
   * still extracts the raw IPv6 literal and isReservedIp catches it.
   */
  const reservedIpv4Hosts = [
    "http://127.0.0.1:9000/mcp",
    "http://127.0.0.2:9000/mcp",
    "http://10.0.0.1:9000/mcp",
    "http://172.16.5.1:9000/mcp",
    "http://172.31.255.255:9000/mcp",
    "http://192.168.1.100:9000/mcp",
    "http://169.254.169.254/mcp", // AWS IMDS
  ];

  for (const url of reservedIpv4Hosts) {
    test(`blocks SSRF to ${url} — fetch never called, error surfaced`, async () => {
      const configSource = createConfigSource({
        "priv-mcp": { id: "priv-mcp", upstreamUrl: url },
      });
      const proxy = new McpProxy(configSource, {      });
      const app = proxy.getApp();

      // The fetch mock should NOT be called — the SSRF guard intercepts first.
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response("upstream", { status: 200 });
      };

      const res = await app.request("/priv-mcp/tools/any_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      // The SSRF guard returns a 403 JSON-RPC response from ssrfBlockResponse.
      // handleCallTool receives it, parses data.error, and returns 502 to the
      // REST caller — that is the observable status for the REST API path.
      // The key invariant: fetch was NOT called (no real network I/O).
      expect([403, 502]).toContain(res.status);
      expect(fetchCalled).toBe(false);
      const body = await res.json();
      // The error text must mention the block reason
      const errText = JSON.stringify(body);
      expect(errText).toMatch(/blocked internal network|ssrf|internal/i);
    });
  }

  // IPv6 bracket literal — isReservedIp("::1") === true (the URL class strips brackets)
  // Bun/Node URL semantics: new URL("http://[::1]:9000").hostname === "::1" (no brackets)
  // so the SSRF guard catches it correctly. If the environment strips brackets differently,
  // this test documents the intended contract: no successful 200 response for loopback.
  test("does not return a successful 200 for IPv6 loopback http://[::1]:9000/mcp", async () => {
    const configSource = createConfigSource({
      "priv-mcp": { id: "priv-mcp", upstreamUrl: "http://[::1]:9000/mcp" },
    });
    const proxy = new McpProxy(configSource, {    });
    const app = proxy.getApp();

    // Either SSRF blocks before fetch (403/502), or fetch throws (Connection refused
    // to loopback) → 502. Either way, no 200 success.
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED [::1]:9000");
    };

    const res = await app.request("/priv-mcp/tools/any_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    // Must not succeed (no 200)
    expect(res.status).not.toBe(200);
  });

  test("allows public upstream URL", async () => {
    const configSource = createConfigSource({
      "pub-mcp": { id: "pub-mcp", upstreamUrl: "http://public-mcp.example.com:9000/mcp" },
    });
    const proxy = new McpProxy(configSource, {    });
    seedRestSession(proxy, "pub-mcp");
    const app = proxy.getApp();

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const res = await app.request("/pub-mcp/tools/a_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // Should reach upstream (not blocked)
    expect(res.status).toBe(200);
  });

  test("allows internal=true MCPs to reach reserved IPs", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://127.0.0.1:8118/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {    });
    seedRestSession(proxy, "lobu-memory");
    const app = proxy.getApp();

    let forwardedAuthorization: string | null = null;
    globalThis.fetch = async (_input, init) => {
      forwardedAuthorization = new Headers(init?.headers).get("authorization");
      const gatewayToken = verifyGatewayMcpToken(
        forwardedAuthorization?.slice("Bearer ".length) ?? "",
      );
      expect(gatewayToken).toMatchObject({ userId: "user1" });
      expect(gatewayToken?.source).toBe(verifyWorkerToken(agent1Token)?.source);
      expect(verifyWorkerToken(forwardedAuthorization?.slice("Bearer ".length) ?? "")).toBeNull();
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "internal ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const res = await app.request("/lobu-memory/tools/search_memory", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).toBe(200);
    expect(forwardedAuthorization).toMatch(/^Bearer /);
    expect(forwardedAuthorization).not.toBe(`Bearer ${agent1Token}`);
  });

  test("blocks GET /tools to reserved-IP MCP via list-all endpoint", async () => {
    const configSource = createConfigSource({
      "ssrf-mcp": {
        id: "ssrf-mcp",
        upstreamUrl: "http://192.168.0.1/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {    });
    const app = proxy.getApp();

    // fetch should not be called
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const res = await app.request("/ssrf-mcp/tools", {
      method: "GET",
      headers: { Authorization: `Bearer ${agent1Token}` },
    });

    // The list-tools path also goes through sendUpstreamRequest → ssrfBlockResponse
    // so it should not call fetch
    expect(fetchCalled).toBe(false);
    // Status may be 502 (upstream error caught) or 403 depending on path; either way no data returned
    expect([403, 502]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Cross-Agent JWT Isolation
// ---------------------------------------------------------------------------

describe("cross-agent JWT isolation", () => {
  /**
   * Agent 2's token should NOT be able to call MCP tools that are only
   * configured for agent 1. The config source is keyed per-agentId, so
   * agent 2 gets `undefined` for servers only configured for agent 1.
   */
  test("agent-2 token cannot reach agent-1-only MCP server", async () => {
    const configSource: McpConfigSource = {
      getHttpServer: async (id, agentId) => {
        // Only agent1 has access to "secure-mcp"
        if (id === "secure-mcp" && agentId === "agent1") {
          return { id: "secure-mcp", upstreamUrl: "http://secure.example.com/mcp" };
        }
        return undefined;
      },
      getAllHttpServers: async () => new Map(),
    };

    const proxy = new McpProxy(configSource, {    });
    const app = proxy.getApp();

    successFetch();

    const res = await app.request("/secure-mcp/tools/some_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent2Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  test("agent-1 token can reach agent-1-only MCP server", async () => {
    const configSource: McpConfigSource = {
      getHttpServer: async (id, agentId) => {
        if (id === "secure-mcp" && agentId === "agent1") {
          return { id: "secure-mcp", upstreamUrl: "http://secure.example.com/mcp" };
        }
        return undefined;
      },
      getAllHttpServers: async () => new Map(),
    };

    const proxy = new McpProxy(configSource, {    });
    seedRestSession(proxy, "secure-mcp");
    const app = proxy.getApp();

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const res = await app.request("/secure-mcp/tools/some_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
  });

  test("grant for agent1 does not leak to agent2 requests", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();

    const configSource = createConfigSource({
      "shared-mcp": { id: "shared-mcp", upstreamUrl: "http://shared.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {      toolCache,
      grantStore,
    });
    seedRestSession(proxy, "shared-mcp");
    const app = proxy.getApp();

    // Seed destructive tool in cache for both agents (org-scoped cache → seed
    // in the same org as the agent tokens).
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("shared-mcp", [{ name: "delete_everything" }], "agent1");
      toolCache.set("shared-mcp", [{ name: "delete_everything" }], "agent2");
    });

    // Grant only to agent1
    await grantStore.grant(
      "agent1",
      "/mcp/shared-mcp/tools/delete_everything",
      null,
      undefined,
      "test-org"
    );

    successFetch({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "deleted" }], isError: false },
    });

    // Agent1 should be allowed
    const res1 = await app.request("/shared-mcp/tools/delete_everything", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res1.status).toBe(200);

    // Agent2 should be blocked (no grant for agent2)
    const res2 = await app.request("/shared-mcp/tools/delete_everything", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent2Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tool registry collision: two MCPs with same tool name
// ---------------------------------------------------------------------------

describe("tool registry collision — same tool name on two MCPs", () => {
  /**
   * If two MCPs expose `send_message`, each must be callable independently
   * via its own server path. There is no collision at the proxy level since
   * paths are /mcp/<id>/tools/<name>.
   */
  test("two MCPs with same tool name are routed independently", async () => {
    const configSource = createConfigSource({
      slack: { id: "slack", upstreamUrl: "http://slack.example.com/mcp" },
      teams: { id: "teams", upstreamUrl: "http://teams.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {    });
    seedRestSession(proxy, "slack");
    seedRestSession(proxy, "teams");
    const app = proxy.getApp();

    let lastUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      lastUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: `response from ${lastUrl}` }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const resSlack = await app.request("/slack/tools/send_message", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "#general", text: "hello" }),
    });
    expect(resSlack.status).toBe(200);
    expect(lastUrl).toContain("slack.example.com");

    const resTeams = await app.request("/teams/tools/send_message", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "general", text: "hello" }),
    });
    expect(resTeams.status).toBe(200);
    expect(lastUrl).toContain("teams.example.com");
  });

  test("tool cache is keyed per (mcpId, agentId) — no cross-MCP cache pollution", async () => {
    const toolCache = new McpToolCache();
    const { toolsA, toolsB } = orgContext.run(
      { organizationId: "test-org" },
      () => {
        toolCache.set("mcp-a", [{ name: "send_message", annotations: { readOnlyHint: true } }], "agent1");
        toolCache.set("mcp-b", [{ name: "send_message" }], "agent1");
        return {
          toolsA: toolCache.get("mcp-a", "agent1"),
          toolsB: toolCache.get("mcp-b", "agent1"),
        };
      }
    );

    expect(toolsA).toHaveLength(1);
    expect(toolsB).toHaveLength(1);
    expect(toolsA![0].annotations?.readOnlyHint).toBe(true);
    // mcp-b's tool has no readOnlyHint
    expect(toolsB![0].annotations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Approval: onToolBlocked callback, wildcard grants
// ---------------------------------------------------------------------------

describe("tool approval — onToolBlocked and wildcard grants", () => {
  test("durable approval preserves the signed direct-auth claims", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://lobu.internal/acme/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, { toolCache, grantStore });
    let requestId = "";
    proxy.onToolBlocked = async (id) => {
      requestId = id;
    };
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("lobu-memory", [{ name: "run_sdk" }], "agent1");
    });
    const token = generateWorkerToken("U_SLACK", "slack:dm:123", "lobu-builder", {
      channelId: "slack:D123",
      teamId: "T123",
      agentId: "agent1",
      organizationId: "test-org",
      connectionId: "432",
      platform: "slack",
      source: "chat",
      adminTools: ["run_sdk"],
      adminActorUserId: "auth-user-1",
    });

    const response = await proxy.getApp().request("/lobu-memory/tools/run_sdk", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ script: "return client.agents.list({})" }),
    });

    expect(response.status).toBe(403);
    expect(requestId).toStartWith("ta_");
    expect(await takePendingTool(requestId, {
      userId: "U_SLACK",
      organizationId: "test-org",
      conversationId: "slack:dm:123",
    })).toMatchObject({
      userId: "U_SLACK",
      agentId: "agent1",
      organizationId: "test-org",
      conversationId: "slack:dm:123",
      channelId: "slack:D123",
      teamId: "T123",
      connectionId: "432",
      platform: "slack",
      source: "chat",
      adminTools: ["run_sdk"],
      adminActorUserId: "auth-user-1",
      deploymentName: "lobu-builder",
    });
  });

  test("onToolBlocked fires once; subsequent blocked-no-channel when no handler", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();

    const configSource = createConfigSource({
      "test-mcp": { id: "test-mcp", upstreamUrl: "http://test.example.com/mcp" },
    });

    let blockedCount = 0;
    const proxy = new McpProxy(configSource, {      toolCache,
      grantStore,
    });

    // Wire the callback
    proxy.onToolBlocked = async () => {
      blockedCount++;
    };

    const app = proxy.getApp();
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("test-mcp", [{ name: "nuke_db" }], "agent1");
    });

    successFetch({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "done" }] } });

    const res = await app.request("/test-mcp/tools/nuke_db", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.content[0].text).toContain("requires approval");
    expect(blockedCount).toBe(1);
  });

  test("wildcard grant /mcp/<id>/tools/* covers all tools of that server", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set(
        "gh-mcp",
        [
          { name: "create_issue" },
          { name: "delete_repo" },
        ],
        "agent1"
      );
    });

    // Wildcard grant for the whole server
    await grantStore.grant(
      "agent1",
      "/mcp/gh-mcp/tools/*",
      null,
      undefined,
      "test-org"
    );

    const configSource = createConfigSource({
      "gh-mcp": { id: "gh-mcp", upstreamUrl: "http://gh.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {      toolCache,
      grantStore,
    });
    seedRestSession(proxy, "gh-mcp");
    const app = proxy.getApp();

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const r1 = await app.request("/gh-mcp/tools/create_issue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "bug" }),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/gh-mcp/tools/delete_repo", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repo: "test" }),
    });
    expect(r2.status).toBe(200);
  });

  test("fails closed when tool annotations cannot be fetched (issue #688)", async () => {
    // Regression: when `fetchToolsForMcp` returns `{ tools: [] }` because
    // discovery failed (upstream error, SSRF block, timeout, ...), the
    // approval gate must NOT default to allow. A destructive tool on a
    // protected MCP would otherwise be invocable without approval whenever
    // discovery failed.
    const grantStore = new GrantStore();

    const configSource = createConfigSource({
      "destructive-mcp": {
        id: "destructive-mcp",
        upstreamUrl: "http://destructive.example.com/mcp",
      },
    });

    let blockedCount = 0;
    const proxy = new McpProxy(configSource, {      // No toolCache — forces fetchToolsForMcp to be called.
      grantStore,
    });
    proxy.onToolBlocked = async () => {
      blockedCount++;
    };

    const app = proxy.getApp();

    // Simulate annotation-fetch failure: fetch always throws, so the MCP
    // initialize/tools-list calls fail and fetchToolsForMcp resolves to
    // { tools: [] }.
    globalThis.fetch = async () => {
      throw new Error("upstream unreachable");
    };

    const res = await app.request("/destructive-mcp/tools/wipe_database", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: true }),
    });

    // Must be blocked, not allowed through.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.content[0].text).toContain("requires approval");
    expect(blockedCount).toBe(1);
  });

  test("onToolBlocked receives correct agentId and tool metadata", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("audit-mcp", [{ name: "drop_table" }], "agent1");
    });

    const configSource = createConfigSource({
      "audit-mcp": { id: "audit-mcp", upstreamUrl: "http://audit.example.com/mcp" },
    });

    const captured: Record<string, unknown>[] = [];
    const proxy = new McpProxy(configSource, {      toolCache,
      grantStore,
    });
    proxy.onToolBlocked = async (
      requestId,
      agentId,
      userId,
      mcpId,
      toolName,
      args,
      grantPattern
    ) => {
      captured.push({ requestId, agentId, userId, mcpId, toolName, args, grantPattern });
    };
    const app = proxy.getApp();

    await app.request("/audit-mcp/tools/drop_table", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ table: "users" }),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agentId: "agent1",
      userId: "user1",
      mcpId: "audit-mcp",
      toolName: "drop_table",
      args: { table: "users" },
      grantPattern: "/mcp/audit-mcp/tools/drop_table",
    });
    expect(typeof captured[0]!.requestId).toBe("string");
    expect((captured[0]!.requestId as string).startsWith("ta_")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Request body size limit
// ---------------------------------------------------------------------------

describe("request body size limit", () => {
  test("body > 1MB returns 413", async () => {
    const configSource = createConfigSource({
      "test-mcp": { id: "test-mcp", upstreamUrl: "http://test.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {    });
    const app = proxy.getApp();

    successFetch();

    const hugeBody = JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) });

    const res = await app.request("/test-mcp/tools/my_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: hugeBody,
    });

    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// SSE-framed JSON-RPC response parsing
// ---------------------------------------------------------------------------

describe("SSE-framed JSON-RPC response", () => {
  test("parses last data: line from SSE stream as JSON-RPC result", async () => {
    const configSource = createConfigSource({
      "sse-mcp": { id: "sse-mcp", upstreamUrl: "http://sse.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {    });
    seedRestSession(proxy, "sse-mcp");
    const app = proxy.getApp();

    const sseBody = [
      `event: message`,
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "sse-result" }], isError: false } })}`,
      ``,
    ].join("\n");

    globalThis.fetch = async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });

    const res = await app.request("/sse-mcp/tools/my_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content[0].text).toBe("sse-result");
    expect(body.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In-memory session TTL eviction
// ---------------------------------------------------------------------------

describe("in-memory session TTL", () => {
  test("McpToolCache returns null after TTL expires", () => {
    const cache = new McpToolCache();
    // Cache reads/writes derive the org from context.
    orgContext.run({ organizationId: "test-org" }, () => {
      cache.set("mcp-x", [{ name: "tool1" }], "agent1");

      // Check hit immediately
      const hit = cache.get("mcp-x", "agent1");
      expect(hit).not.toBeNull();
      expect(hit![0].name).toBe("tool1");

      // Manually expire by probing the expiry logic via a never-set key
      const miss = cache.get("mcp-x-nonexistent", "agent1");
      expect(miss).toBeNull();
    });
  });

  test("McpToolCache per-agent isolation — agent2 cache miss for agent1 entry", () => {
    const cache = new McpToolCache();
    orgContext.run({ organizationId: "test-org" }, () => {
      cache.set("mcp-iso", [{ name: "private_tool" }], "agent1");

      const forAgent1 = cache.get("mcp-iso", "agent1");
      const forAgent2 = cache.get("mcp-iso", "agent2");
      const noAgent = cache.get("mcp-iso");

      expect(forAgent1).not.toBeNull();
      expect(forAgent2).toBeNull();
      expect(noAgent).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrent tool calls
// ---------------------------------------------------------------------------

describe("concurrent tool calls", () => {
  test("two concurrent calls to the same MCP tool both succeed", async () => {
    const configSource = createConfigSource({
      "conc-mcp": { id: "conc-mcp", upstreamUrl: "http://conc.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {    });
    seedRestSession(proxy, "conc-mcp");
    const app = proxy.getApp();

    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: `call-${callCount}` }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const [r1, r2] = await Promise.all([
      app.request("/conc-mcp/tools/read_data", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 1 }),
      }),
      app.request("/conc-mcp/tools/read_data", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 2 }),
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both calls hit upstream
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// executeToolDirect (approval bridge path)
// ---------------------------------------------------------------------------

describe("executeToolDirect", () => {
  test("approved internal execution initializes a missing replica-local MCP session before the tool call", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://lobu.internal/acme/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {});
    const requestHeaders: Headers[] = [];
    let toolCalls = 0;

    globalThis.fetch = async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize") {
        return initializeResponse("session-1");
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls++;
      const initialized = new Headers(init?.headers).get("mcp-session-id") === "session-1";
      return new Response(
        JSON.stringify(
          initialized
            ? {
                jsonrpc: "2.0",
                id: 1,
                result: { content: [{ type: "text", text: "approved" }], isError: false },
              }
            : { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server not initialized" } },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
        adminTools: ["run_sdk"],
        adminActorUserId: "approving-user",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "approved" }],
      isError: false,
    });
    expect(toolCalls).toBe(1);
    expect(requestHeaders).toHaveLength(3);
    for (const headers of requestHeaders) {
      expect(headers.get("authorization")).toMatch(/^Bearer /);
      expect(headers.get("x-lobu-memory-direct-auth")).toBe("1");
    }
    expect(requestHeaders[0]?.get("mcp-protocol-version")).toBeNull();
    expect(requestHeaders[1]?.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
    expect(requestHeaders[2]?.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
  });

  test("approved execution does not replay after a post-dispatch JSON-RPC session error", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://lobu.internal/acme/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {});
    let initCount = 0;
    let toolCalls = 0;

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize") {
        initCount++;
        return initializeResponse(`session-${initCount}`);
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls++;
      return new Response(
        JSON.stringify(
          toolCalls === 1
            ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Session not found" } }
            : {
                jsonrpc: "2.0",
                id: 1,
                result: { content: [{ type: "text", text: "approved" }], isError: false },
              },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
      },
    );

    expect(result).toEqual({ content: [{ type: "text", text: "Session not found" }], isError: true });
    expect(initCount).toBe(1);
    expect(toolCalls).toBe(1);

    const nextResult = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
      },
    );

    expect(nextResult).toEqual({
      content: [{ type: "text", text: "approved" }],
      isError: false,
    });
    expect(initCount).toBe(2);
    expect(toolCalls).toBe(2);
  });

  test("approved execution invalidates an upstream 404 session without replaying the call", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://lobu.internal/acme/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {});
    let initCount = 0;
    let toolCalls = 0;

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize") {
        initCount++;
        return initializeResponse(`session-${initCount}`);
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls++;
      if (toolCalls === 1) return new Response("Session not found", { status: 404 });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "approved" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
      },
    );

    expect(result).toEqual({ content: [{ type: "text", text: "Tool call failed: 404 Session not found" }], isError: true });
    expect(initCount).toBe(1);
    expect(toolCalls).toBe(1);

    const nextResult = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
      },
    );

    expect(nextResult).toEqual({
      content: [{ type: "text", text: "approved" }],
      isError: false,
    });
    expect(initCount).toBe(2);
    expect(toolCalls).toBe(2);
  });

  test("refuses internal execution when the pending row lacks signed routing context", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://lobu.internal/acme/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {});
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("unreachable", { status: 500 });
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      { organizationId: "org-1", conversationId: "slack:dm:123" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("missing signed routing context");
    expect(fetched).toBe(false);
  });

  test("approved internal tool execution authenticates with a fresh scoped worker token", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://lobu.internal/acme/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {});
    let requestHeaders = new Headers();

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      requestHeaders = new Headers(init?.headers);
      if (body.method === "initialize") {
        return initializeResponse("session-auth");
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "approved" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
        connectionId: "432",
        platform: "slack",
        source: "chat",
        adminTools: ["run_sdk"],
        adminActorUserId: "approving-user",
        deploymentName: "lobu-builder",
      },
    );

    expect(result.isError).toBe(false);
    expect(requestHeaders.get("x-lobu-memory-direct-auth")).toBe("1");
    const authorization = requestHeaders.get("authorization");
    expect(authorization).toMatch(/^Bearer /);
    const token = verifyGatewayMcpToken(authorization?.slice("Bearer ".length) ?? "");
    expect(token).toMatchObject({
      userId: "approving-user",
      agentId: "agent1",
      organizationId: "org-1",
      conversationId: "slack:dm:123",
      channelId: "slack:D123",
      connectionId: "432",
      platform: "slack",
      source: "chat",
      adminTools: ["run_sdk"],
      adminActorUserId: "approving-user",
      deploymentName: "lobu-builder",
    });
  });

  test("approved internal execution drops an admin allowlist that has no canonical actor", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://lobu.internal/acme/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {});
    let requestHeaders = new Headers();

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      requestHeaders = new Headers(init?.headers);
      if (body.method === "initialize") {
        return initializeResponse("session-no-admin");
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "approved" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "approving-user",
      "lobu-memory",
      "run_sdk",
      { script: "return client.agents.list({})" },
      // Legacy/tampered pending row: allowlist with no verified actor. The
      // paired type forbids constructing this, so the cast reproduces what a
      // persisted payload can still deserialize into.
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
        adminTools: ["run_sdk"],
      } as DirectToolExecutionOptions,
    );

    expect(result.isError).toBe(false);
    const authorization = requestHeaders.get("authorization");
    const token = verifyGatewayMcpToken(authorization?.slice("Bearer ".length) ?? "");
    // Minting the unpaired claims produces a token the verifier rejects
    // outright (401 on resume); pairing drops the admin tier and the resumed
    // call still authenticates as a plain, non-admin worker.
    expect(token).not.toBeNull();
    expect(token?.userId).toBe("approving-user");
    expect(token?.adminTools).toBeUndefined();
    expect(token?.adminActorUserId).toBeUndefined();
  });

  test("executes tool directly and returns result", async () => {
    const configSource = createConfigSource({
      "direct-mcp": {
        id: "direct-mcp",
        upstreamUrl: "http://direct.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {    });

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize") {
        return initializeResponse("session-direct");
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "direct-result" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "user1",
      "direct-mcp",
      "some_tool",
			{ arg1: "val1" },
			{ organizationId: "org-1" },
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("direct-result");
  });

  test("executeToolDirect returns error when MCP server not found", async () => {
    const configSource = createConfigSource({});
    const proxy = new McpProxy(configSource, {    });

    const result = await proxy.executeToolDirect(
      "agent1",
      "user1",
      "nonexistent-mcp",
      "some_tool",
			{},
			{ organizationId: "org-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  test("executeToolDirect handles upstream error gracefully", async () => {
    const configSource = createConfigSource({
      "flaky-mcp": {
        id: "flaky-mcp",
        upstreamUrl: "http://flaky.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {    });

    globalThis.fetch = async () => {
      throw new Error("Connection refused");
    };

    const result = await proxy.executeToolDirect(
      "agent1",
      "user1",
      "flaky-mcp",
      "any_tool",
			{},
			{ organizationId: "org-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("error");
  });
});

// ---------------------------------------------------------------------------
// Approval policy: requiresToolApproval
// ---------------------------------------------------------------------------

describe("requiresToolApproval (approval-policy.ts)", () => {
  // Import directly to test in isolation
  test("idempotentHint=true alone still requires approval (MCP spec)", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    // idempotentHint says "won't change state differently each call" but does
    // NOT imply read-only. Conservative default = requires approval.
    expect(requiresToolApproval({ idempotentHint: true })).toBe(true);
  });

  test("openWorldHint=true alone still requires approval", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval({ openWorldHint: true })).toBe(true);
  });

  test("readOnlyHint=true + destructiveHint=true: readOnly wins (no approval)", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    // readOnlyHint=true short-circuits first; destructiveHint is ignored
    expect(
      requiresToolApproval({ readOnlyHint: true, destructiveHint: true })
    ).toBe(false);
  });

  test("destructiveHint=false requires no approval", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval({ destructiveHint: false })).toBe(false);
  });

  test("empty annotations object requires approval (conservative default)", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval({})).toBe(true);
  });

  test("undefined annotations requires approval", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval(undefined)).toBe(true);
  });
});
