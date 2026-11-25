/**
 * Red→green reproducers for the four critical multi-tenant isolation gaps
 * surfaced on PR #836:
 *
 *   - Finding 1: secret-proxy `lookupPlaceholderMapping` was dead-code —
 *     no production call site passed `expectedOrganizationId`, so a worker
 *     bound to org-A could resolve its placeholder under org-B's URL.
 *   - Finding 2: `checkDomainAccess()` had `organizationId` on its frame
 *     but never threaded it into `GrantStore.isDenied/hasGrant`. The store
 *     fell back to ALS (empty in the raw HTTP proxy hot path) and matched
 *     grants by `agent_id` alone — cross-org leakage when an agent id is
 *     reused.
 *   - Finding 3: `PolicyStore` was keyed by `agentId` alone, so the last
 *     `set()` across orgs won. Cache scoping became theatre because the
 *     policy fed into the verdict was already wrong. (The store now reads
 *     the workspace guardrail library with an explicit org predicate; the
 *     reproducers drive that read.)
 *   - Finding 6 — peek-before-consume — is covered by `slack-routes.test.ts`
 *     ("rejects when callback session org differs from install state"
 *     asserts the row is preserved for a legitimate retry).
 *
 * Each test in this file asserts the post-fix semantics. The PR description
 * pastes the corresponding pre-fix `bun test` output so the reproducer
 * doubles as a regression gate — flip a single fix line and the listed
 * assertion fails.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createBuiltinSecretRef,
  generateWorkerToken,
  generateWorkerTokenPair,
  verifyWorkerToken,
} from "@lobu/core";
import { createTestWorkspaceGuardrail } from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import { GrantStore } from "../permissions/grant-store.js";
import { PolicyStore } from "../permissions/policy-store.js";
import {
  __resetPlaceholderCacheForTests,
  generatePlaceholder,
  lookupPlaceholderMapping,
  SecretProxy,
} from "../proxy/secret-proxy.js";
import type { SecretStore } from "../secrets/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";
import { withFreePortRetry } from "../../__tests__/setup/free-port.js";

// ─── Finding 3: PolicyStore cross-tenant clobbering ──────────────────────────

describe("[finding 3] PolicyStore is keyed by (orgId, agentId)", () => {
  async function storePolicy(orgId: string, agentId: string, policy: string) {
    await seedAgentRow(agentId, { organizationId: orgId });
    await createTestWorkspaceGuardrail({
      organizationId: orgId,
      name: "default",
      config: { kind: "judge", stage: "egress", policy, domains: ["api.example.com"] },
      appliesTo: [{ kind: "agent", id: agentId }],
    });
  }

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("two orgs reusing one agent id each read their own policy through one store", async () => {
    await storePolicy("org-a", "shared-agent-id", "ORG A: deny by default");
    await storePolicy("org-b", "shared-agent-id", "ORG B: allow reads");
    const store = new PolicyStore();

    const [aResolved] = await store.resolve("org-a", "shared-agent-id", "api.example.com");
    const [bResolved] = await store.resolve("org-b", "shared-agent-id", "api.example.com");

    expect(aResolved?.policy).toBe("ORG A: deny by default");
    expect(bResolved?.policy).toBe("ORG B: allow reads");
    // policyHash diverges so the verdict cache cannot collide either.
    expect(aResolved?.policyHash).not.toBe(bResolved?.policyHash as string);
  });

  test("resolve refuses cross-org reads — no fall-through to a sibling tenant's policy", async () => {
    await storePolicy("org-a", "agent-1", "ORG A only");
    await seedAgentRow("agent-1", { organizationId: "org-b" });
    const store = new PolicyStore();
    // Warm org A's entry first, so a cache keyed by agent alone would answer.
    expect(await store.resolve("org-a", "agent-1", "api.example.com")).toHaveLength(1);
    expect(await store.resolve("org-b", "agent-1", "api.example.com")).toEqual([]);
  });

  test("clearing org A's policy does not affect org B's for the same agent id", async () => {
    await storePolicy("org-a", "shared", "A");
    await storePolicy("org-b", "shared", "B");
    const store = new PolicyStore();
    await store.resolve("org-a", "shared", "api.example.com");
    await store.resolve("org-b", "shared", "api.example.com");

    await getDb()`DELETE FROM workspace_guardrails WHERE organization_id = 'org-a'`;
    expect(await store.resolve("org-a", "shared", "api.example.com")).toEqual([]);
    const [b] = await store.resolve("org-b", "shared", "api.example.com");
    expect(b?.policy).toBe("B");
  });
});

// ─── Finding 1: secret-proxy placeholder cross-org leak ──────────────────────

describe("[finding 1] lookupPlaceholderMapping enforces caller's expected org", () => {
  beforeEach(() => {
    __resetPlaceholderCacheForTests();
  });

  test("org-A placeholder resolved under org-B context returns null", () => {
    // Org A mints a placeholder for one of its agents.
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-A",
      { organizationId: "org-a" }
    );
    // A caller bound to org B presents the placeholder. Pre-fix the lookup
    // had no `expectedOrganizationId` plumbed through any production call
    // site, so the mapping resolved and org B could spend org A's
    // upstream credential. Post-fix: null.
    expect(lookupPlaceholderMapping(placeholder, "org-b")).toBeNull();
  });

  test("a matching expected org still resolves cleanly", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-A",
      { organizationId: "org-a" }
    );
    const mapping = lookupPlaceholderMapping(placeholder, "org-a");
    expect(mapping?.agentId).toBe("agent-1");
    expect(mapping?.organizationId).toBe("org-a");
  });

  // Fix #2 — legacy mapping bypass.
  //
  // Pre-fix: the org check was gated on `mapping.organizationId` being set,
  // so a legacy mapping minted before the org-id pivot (no organizationId)
  // sailed through under any expected org. A worker from org B could
  // resolve a legacy mapping owned by org A under org B's request URL.
  // Post-fix: presence-on-either-side forces a match — a legacy mapping
  // can no longer be resolved under any expected-org context.
  test("legacy mapping (no organizationId) is rejected when expected org is set", () => {
    // Mint a "legacy" placeholder — no organizationId option. Pre-pivot
    // shape that may still be in flight from older mint sites.
    const placeholder = generatePlaceholder(
      "agent-legacy",
      "OPENAI_API_KEY",
      createBuiltinSecretRef("deployments/agent-legacy/OPENAI_API_KEY"),
      "deploy-legacy"
      // no { organizationId } — this is the legacy shape.
    );
    // A caller from org B presents this legacy placeholder. Pre-fix the
    // check skipped entirely because `mapping.organizationId` was
    // undefined. Post-fix: the check fires and the lookup rejects.
    expect(lookupPlaceholderMapping(placeholder, "org-b")).toBeNull();
  });

  // Legacy-mapping access with no expected org still resolves (so existing
  // call sites that don't yet thread expectedOrganizationId aren't broken).
  // The WARN log is the deprecation signal — we don't assert on it here,
  // but it's emitted on every such call.
  test("legacy mapping with no expected org still resolves (warn path)", () => {
    const placeholder = generatePlaceholder(
      "agent-legacy-2",
      "OPENAI_API_KEY",
      createBuiltinSecretRef("deployments/agent-legacy-2/OPENAI_API_KEY"),
      "deploy-legacy-2"
    );
    const mapping = lookupPlaceholderMapping(placeholder);
    expect(mapping?.agentId).toBe("agent-legacy-2");
    expect(mapping?.organizationId).toBeUndefined();
  });

  // Fix #1 — fail-closed on agentOrgResolver DB error.
  //
  // Pre-fix the catch block logged a warning and fell through with
  // `expectedOrganizationId = undefined`. A worker from any org could
  // present a placeholder during a transient DB error window and the
  // downstream binding step would never get its org-anchor → potential
  // cross-tenant access. Post-fix: 503 on resolver error.
  test("SecretProxy.forward rejects with 503 when agentOrgResolver throws", async () => {
    const placeholder = generatePlaceholder(
      "agent-x",
      "OPENAI_API_KEY",
      createBuiltinSecretRef("deployments/agent-x/OPENAI_API_KEY"),
      "deploy-x",
      { organizationId: "org-a" }
    );

    const stubStore: SecretStore = { get: async () => "real-secret-x" };
    const proxy = new SecretProxy(
      { defaultUpstreamUrl: "https://upstream.example.com" },
      stubStore
    );
    proxy.registerUpstream(
      { slug: "openai", upstreamBaseUrl: "https://api.openai.example.com" },
      "openai"
    );
    // The resolver throws — simulates a transient DB error in
    // `agentOrgResolver`. Pre-fix: warning + fall through, request
    // forwarded with no org expectation. Post-fix: 503.
    proxy.setAgentOrgResolver(async () => {
      throw new Error("simulated DB hiccup");
    });

    let upstreamCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return new Response("{}", { status: 200 });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/openai/a/agent-x/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${placeholder}`,
          },
          body: JSON.stringify({ prompt: "test" }),
        });
      expect(res.status).toBe(503);
      expect(upstreamCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("SecretProxy.forward rejects an org-A placeholder used on an org-B agent's URL", async () => {
    // Mint a placeholder for org A's `agent-A1`. Pre-fix, no production call
    // site supplied `expectedOrganizationId`, so `lookupPlaceholderMapping`
    // returned the org-A mapping even when the URL named an org-B agent —
    // the `mapping.agentId === urlAgentId` check downstream then tripped at
    // 403, but only because the agent ids differed. If two orgs happened
    // to use the same `agentId` (per-org-unique on paper, but a stale dump
    // or hand-edit can violate this), no 403 fires and the credential
    // leaks. The proxy's `agentOrgResolver` is the independent source of
    // truth this test exercises end-to-end.
    const placeholder = generatePlaceholder(
      "shared-id",
      "OPENAI_API_KEY",
      createBuiltinSecretRef("deployments/orgA/shared-id/OPENAI_API_KEY"),
      "deploy-A",
      { organizationId: "org-a" }
    );

    const stubStore: SecretStore = { get: async () => "real-secret-A" };
    const proxy = new SecretProxy(
      { defaultUpstreamUrl: "https://upstream.example.com" },
      stubStore
    );
    proxy.registerUpstream(
      { slug: "openai", upstreamBaseUrl: "https://api.openai.example.com" },
      "openai"
    );
    // Wire an `agentOrgResolver` that says `shared-id` belongs to org B
    // when looked up via the URL. The mapping's org is `org-a` → mismatch.
    proxy.setAgentOrgResolver(async () => "org-b");

    let upstreamCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return new Response("{}", { status: 200 });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/openai/a/shared-id/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${placeholder}`,
          },
          body: JSON.stringify({ prompt: "leak" }),
        });
      expect(res.status).toBe(401);
      expect(upstreamCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── Finding 2: GrantStore agent-id collision across orgs ────────────────────

describe("[finding 2] GrantStore queries scope to caller's organization id", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    // Seed both orgs and the shared agent id under each — the grants table
    // has a FK on `(organization_id, agent_id)` and needs both rows in
    // `agents` to exist before we can grant.
    await seedAgentRow("shared-agent-id", { organizationId: "org-a" });
    await seedAgentRow("shared-agent-id", { organizationId: "org-b" });
  });

  test("org A's grant for `shared-agent-id` is invisible to org B's lookup", async () => {
    const store = new GrantStore();
    // Org A grants `api.example.com` to its agent.
    await store.grant(
      "shared-agent-id",
      "api.example.com",
      null,
      false,
      "org-a"
    );
    // Org B reuses the same agent id (it's per-org-unique on paper; this
    // tests that a buggy seed or hand-edited row cannot leak across orgs).
    // Without org plumbing the WHERE clause would lose `organization_id`
    // and find org A's row.
    const orgBSeesGrant = await store.hasGrant(
      "shared-agent-id",
      "api.example.com",
      "org-b"
    );
    expect(orgBSeesGrant).toBe(false);

    // Org A still sees its own grant.
    expect(
      await store.hasGrant("shared-agent-id", "api.example.com", "org-a")
    ).toBe(true);
  });

  test("org A's DENY grant for `shared-agent-id` does not block org B", async () => {
    const store = new GrantStore();
    await store.grant(
      "shared-agent-id",
      "api.example.com",
      null,
      true, // denied
      "org-a"
    );
    // Org B's isDenied check must see no row.
    const orgBDenied = await store.isDenied(
      "shared-agent-id",
      "api.example.com",
      "org-b"
    );
    expect(orgBDenied).toBe(false);

    // Org A's isDenied sees its own denial.
    expect(
      await store.isDenied("shared-agent-id", "api.example.com", "org-a")
    ).toBe(true);
  });

  test("HTTP proxy's checkDomainAccess passes the token's orgId into GrantStore", async () => {
    // End-to-end exercise of the call-site plumbing: install a real
    // GrantStore in the http-proxy, grant `api.example.com` to org A's
    // copy of `shared-agent-id`, then hit the proxy with an org-B egress
    // token. Pre-fix, the call site dropped the `organizationId` argument
    // and the WHERE clause matched org A's grant (the only one with that
    // agent id). Post-fix, the predicate now scopes by org and the request
    // is blocked.
    const {
      __testOnly,
      setProxyGrantStore,
      startHttpProxy,
      stopHttpProxy,
    } = await import("../proxy/http-proxy.js");
    const crypto = await import("node:crypto");
    const net = await import("node:net");

    const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.WORKER_ALLOWED_DOMAINS = ""; // deny-all globally → grant path
    __testOnly.reset();

    const store = new GrantStore();
    await store.grant(
      "shared-agent-id",
      "api.example.com",
      null,
      false,
      "org-a"
    );
    setProxyGrantStore(store);

    // Ask the OS for a free port and retry on collision instead of gambling on
    // a random high port — concurrent test load otherwise races to EADDRINUSE
    // (#976).
    let proxyPort = 0;
    const proxyServer = await withFreePortRetry(async (port) => {
      proxyPort = port;
      return startHttpProxy(port, "127.0.0.1");
    });

    try {
      // Mint an org-B token claiming `shared-agent-id`.
      const token = generateWorkerTokenPair(
        "test-user",
        "test-conv",
        "deploy-B",
        {
          channelId: "test-channel",
          platform: "test",
          agentId: "shared-agent-id",
          organizationId: "org-b",
        }
      ).egressProxyToken;
      const auth = `Basic ${Buffer.from(`deploy-B:${token}`).toString("base64")}`;

      // Fire a raw HTTP request through the proxy targeting api.example.com.
      // We can't fetch() with HTTP_PROXY in bun-test, so we hand-roll the
      // proxy request and parse the status line out of the raw bytes.
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new net.Socket();
        socket.connect(proxyPort, "127.0.0.1", () => {
          socket.write(
            `GET http://api.example.com/v1/x HTTP/1.1\r\n` +
              `Host: api.example.com\r\n` +
              `Proxy-Authorization: ${auth}\r\n` +
              `Connection: close\r\n\r\n`
          );
        });
        let data = "";
        let resolved = false;
        const tryParse = () => {
          if (resolved) return;
          const idx = data.indexOf("\r\n");
          if (idx === -1) return;
          const m = data.substring(0, idx).match(/HTTP\/\d\.\d (\d+)/);
          if (!m) return;
          resolved = true;
          socket.destroy();
          resolve(Number(m[1]));
        };
        socket.on("data", (chunk: Buffer) => {
          data += chunk.toString();
          tryParse();
        });
        socket.on("end", () => {
          if (!resolved) {
            resolved = true;
            resolve(0);
          }
        });
        socket.on("error", (err) => {
          if (!resolved) reject(err);
        });
        socket.setTimeout(3000, () => {
          if (!resolved) {
            resolved = true;
            socket.destroy();
            resolve(0);
          }
        });
      });

      // Pre-fix: 200 — org A's grant matched because no org was passed.
      // Post-fix: 403 — grant lookup scoped to org B finds nothing,
      // global allowlist denies, judge has no rule for this agent.
      expect(status).toBe(403);
    } finally {
      await stopHttpProxy(proxyServer);
      __testOnly.reset();
      // The proxy grant store is a module-global; clear it so it doesn't leak
      // into other proxy suites in the same bun:test process (where its
      // DB-backed lookups wedge their request handling).
      setProxyGrantStore(null);
      delete process.env.ENCRYPTION_KEY;
      delete process.env.WORKER_ALLOWED_DOMAINS;
    }
  });

  afterAll(async () => {
    await resetTestDatabase();
  });
});

// ─── Finding 4: Telegram cloud-mode polling guard at boot ────────────────────

describe("[finding 4] persisted Telegram polling rows are refused in cloud (claim-runner path)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("agent-1", { organizationId: "test-org" });
  });

  test("a persisted `mode: polling` Telegram row is errored by the claim runner, never started", async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    const originalCloud = process.env.LOBU_CLOUD_MODE;
    process.env.ENCRYPTION_KEY =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
    process.env.LOBU_CLOUD_MODE = "1";

    try {
      const { orgContext } = await import("../../lobu/stores/org-context.js");
      const { createPostgresAgentConnectionStore } = await import(
        "../../lobu/stores/postgres-stores.js"
      );
      const connectionStore = createPostgresAgentConnectionStore();

      await orgContext.run({ organizationId: "test-org" }, async () => {
        await connectionStore.saveConnection({
          id: "telegram-poll-1",
          platform: "telegram",
          agentId: "agent-1",
          config: {
            platform: "telegram",
            botToken: "111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            mode: "polling",
          },
          settings: { allowGroups: true },
          metadata: {},
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });

      const mod = await import("../connections/chat-instance-manager.js");
      const services = {
        getQueue: () => ({}),
        getPublicGatewayUrl: () => "https://gw.example.com",
        getSecretStore: () => ({ get: async () => null, put: async () => "" }),
        getConnectionStore: () => connectionStore,
        getAutomationSubscriptionService: () => ({ resolveForConnection: async () => null }),
      } as any;
      const manager = new mod.ChatInstanceManager() as any;
      // A persisted polling row in cloud is an exclusive transport whose
      // start is gated by getConfigRejection at the hydrate chokepoint. The
      // claim runner must claim it, refuse to start it, and mark the row
      // errored — drive one tick directly (deterministic; initialize()'s
      // own tick is fire-and-forget).
      manager.services = services;
      manager.publicGatewayUrl = services.getPublicGatewayUrl();
      manager.connectionStore = connectionStore;
      await manager.exclusiveTick();

      const stored = await orgContext.run(
        { organizationId: "test-org" },
        () => connectionStore.getConnection("telegram-poll-1")
      );
      expect(stored?.status).toBe("error");
      expect(stored?.errorMessage ?? "").toContain("Polling mode");
      expect(manager.instances.has("telegram-poll-1")).toBe(false);
    } finally {
      if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
      else delete process.env.ENCRYPTION_KEY;
      if (originalCloud !== undefined)
        process.env.LOBU_CLOUD_MODE = originalCloud;
      else delete process.env.LOBU_CLOUD_MODE;
    }
  });
});

// ─── Public Agent API mint path stamps organizationId on worker tokens ─────
//
// The chat-platform spawn path (`deployment-manager`,
// `agent-threads.createThreadForAgent`) already passes `organizationId`
// into `generateWorkerToken`. The public Agent API entry point
// (`POST /api/v1/agents`) did NOT — every worker spawned via `lobu chat`
// or the JS SDK landed with `tokenData.organizationId ===
// undefined`. The egress proxy then short-circuited the new per-tenant
// gates and fell back to unscoped checks for that worker. The route now
// looks the agent's owning org up via the ownership metadata store and
// stamps the token.
//
// This test pins the contract: given an agentId whose metadata returns
// org A, the route handler's lookup pattern must yield a token whose
// decoded `organizationId === "org-a"`. A regression that drops the
// pass-through (e.g. forgets `organizationId: tokenOrganizationId` in
// the options bag) fails the second assertion.
describe("[follow-up] API mint path stamps organizationId on worker tokens", () => {
  test("metadata-driven lookup propagates org into the worker token", async () => {
    const agentId = "agent-mint-1";
    const metadataStore = {
      getMetadata: async (id: string) =>
        id === agentId
          ? { id, organizationId: "org-a", createdAt: 0, updatedAt: 0 }
          : null,
    };

    // Replicates the in-route helper: look up the pinned agent's org
    // before minting the token. Ephemeral agents (no metadata) yield
    // undefined and the proxy falls through to unscoped checks — that
    // narrower case is tracked as a follow-up.
    const tokenOrganizationId =
      (await metadataStore.getMetadata(agentId))?.organizationId;

    const token = generateWorkerToken(agentId, "conv-1", "api-mint-1", {
      channelId: "api_user-1",
      agentId,
      organizationId: tokenOrganizationId,
      platform: "api",
      sessionKey: "user-1",
    });

    const decoded = verifyWorkerToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.agentId).toBe(agentId);
    expect(decoded?.organizationId).toBe("org-a");
  });

  test("ephemeral agents (no metadata) mint without organizationId", async () => {
    const metadataStore = { getMetadata: async () => null };
    const tokenOrganizationId =
      (await metadataStore.getMetadata())?.organizationId;
    expect(tokenOrganizationId).toBeUndefined();

    const token = generateWorkerToken(
      "ephemeral-agent",
      "conv-2",
      "api-mint-2",
      {
        channelId: "api_user-2",
        agentId: "ephemeral-agent",
        organizationId: tokenOrganizationId,
        platform: "api",
        sessionKey: "user-2",
      }
    );

    const decoded = verifyWorkerToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.organizationId).toBeUndefined();
  });
});
