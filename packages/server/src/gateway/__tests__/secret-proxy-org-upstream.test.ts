import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createBuiltinSecretRef, generateWorkerToken, moduleRegistry, SDK_COMPAT_PROTOCOLS, type ModuleInterface, type SdkCompat } from "@lobu/core";
import bundledProviders from "../../../../../config/providers.json";
import * as providerSecrets from "../../lobu/stores/provider-secrets.js";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { ProviderCatalogService } from "../auth/provider-catalog.js";
import type { SecretStore } from "../secrets/index.js";

/**
 * Real Hono egress regressions for canonical credentials and org aliases.
 * Store reads are stubbed here; provider-alias-isolation.test.ts exercises
 * actual HTTP ingress and encrypted Postgres rows without credential mocks.
 */

let inferenceConfig: {
  baseUrl?: string;
  apiKey?: string;
  custom: boolean;
};

const resolveInferenceProviderConfigSpy = spyOn(
  providerSecrets,
  "resolveInferenceProviderConfig"
).mockImplementation(async () => inferenceConfig);

// Import AFTER the mock so secret-proxy's transitive import of the invariant
// (which imports the store) picks up the stub.
const { SecretProxy, generatePlaceholder, __resetPlaceholderCacheForTests } = await import("../proxy/secret-proxy.js");

afterAll(() => {
  resolveInferenceProviderConfigSpy.mockRestore();
});

describe("SecretProxy — authenticated organization alias isolation", () => {
  type Row = { kind: string; baseUrl?: string; apiKey?: string };
  const alias = "synthetic-shared-provider";
  const orgA = "synthetic-org-a";
  const orgB = "synthetic-org-b";
  let rows: Map<string, Row>;
  let outgoing: Array<{ url: string; headers: Headers }>;
  let restore: Array<() => void>;
  let profile: { credential: string; authType: "api-key" | "oauth" } | null;
  let profileReads: number;
  const profiles = {
    getBestProfile: async () => { profileReads++; return profile; },
    ensureFreshCredential: async () => profile?.credential,
  };
  const rowKey = (org: string, slug = alias) => JSON.stringify([org, slug]);
  const token = (org: string, agent = `synthetic-agent-${org}`) =>
    generateWorkerToken("synthetic-user", "synthetic-conversation", "synthetic-deployment", {
      channelId: "synthetic-channel", organizationId: org, agentId: agent,
    });
  const rowReads = spyOn(providerSecrets, "resolveInferenceProviderCredential");
  afterAll(() => rowReads.mockRestore());

  beforeEach(() => {
    rows = new Map();
    outgoing = [];
    restore = [];
    profile = null;
    profileReads = 0;
    __resetPlaceholderCacheForTests();
    const priorKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    restore.push(() => {
      if (priorKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = priorKey;
    });
    const registry = moduleRegistry as unknown as { modules: Map<string, ModuleInterface> };
    const priorModules = registry.modules;
    registry.modules = new Map();
    restore.push(() => { registry.modules = priorModules; });
    for (const id of ["openai", "claude"]) {
      const config = bundledProviders.providers.find(p => p.id === id)!.providers[0]!;
      const sdkCompat = config.sdkCompat as SdkCompat;
      moduleRegistry.register(new ApiKeyProviderModule({
        ...config, providerId: id, slug: id, providerDisplayName: config.displayName,
        providerIconUrl: config.iconUrl, sdkCompat,
        apiKeyHeader: SDK_COMPAT_PROTOCOLS[sdkCompat].apiKeyHeader,
        authProfilesManager: profiles as never,
      }));
    }
    rowReads.mockClear();
    rowReads.mockImplementation(async (org, slug) => rows.get(rowKey(org, slug)) ?? null);
    resolveInferenceProviderConfigSpy.mockImplementation(async (org, slug) => {
      const row = rows.get(rowKey(org, slug));
      return row ? { ...row, custom: Boolean(row.baseUrl) } : null;
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      outgoing.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    restore.push(() => fetchSpy.mockRestore());
  });
  afterEach(() => {
    for (const reset of restore.reverse()) reset();
    resolveInferenceProviderConfigSpy.mockImplementation(async () => inferenceConfig);
  });

  function makeProxy() {
    const proxy = new SecretProxy({ defaultUpstreamUrl: "https://default.example.com" }, { get: async () => null });
    for (const id of ["openai", "claude"]) {
      const module = moduleRegistry.getModules().find(m => "providerId" in m && m.providerId === id) as ApiKeyProviderModule;
      proxy.registerUpstream(module.getUpstreamConfig()!, id);
    }
    proxy.setAuthProfilesManager(profiles as never);
    proxy.setSystemKeyResolver(() => ({ value: "synthetic-operator-key", kind: "api-key" }));
    proxy.setAgentOrgResolver(async () => { throw new Error("signed binding must supply the org"); });
    return proxy;
  }
  function makeCatalog() {
    return new ProviderCatalogService(
      { getSettings: async () => ({ models: [`${alias}/synthetic-model`] }) } as never,
      profiles as never,
      async org => {
        const row = rows.get(rowKey(org));
        return row ? [{ id: 1, slug: alias, kind: row.kind, displayName: alias,
          capabilities: { text: { model: "synthetic-model", ...(row.baseUrl ? { base_url: row.baseUrl } : {}) } },
          hasCustomUpstream: Boolean(row.baseUrl), status: "active", createdAt: "2026-01-01T00:00:00Z",
        }] : [];
      }
    );
  }
  function request(proxy: InstanceType<typeof SecretProxy>, org: string, slug = alias, extra: Record<string, string> = {}) {
    return proxy.getApp().request(`/api/proxy/${slug}/a/synthetic-agent-${org}/o/${org}/responses`, {
      method: "POST", headers: { authorization: `Bearer ${token(org)}`, "content-type": "application/json", ...extra },
      body: JSON.stringify({ model: "synthetic-model", stream: true }),
    });
  }

  test.each([false, true])("real catalog cannot cross-wire two signed orgs (reverse=%s)", async reverse => {
    rows.set(rowKey(orgA), { kind: "openai", baseUrl: "https://a.example.com/v1", apiKey: "synthetic-a-key" });
    rows.set(rowKey(orgB), { kind: "openai", apiKey: "synthetic-b-key" });
    const proxy = makeProxy();
    const catalog = makeCatalog();
    for (const org of reverse ? [orgA, orgB] : [orgB, orgA]) {
      expect(await catalog.getInstalledModules(`synthetic-agent-${org}`, org)).toHaveLength(1);
    }
    for (const org of [orgB, orgA, orgB]) expect((await request(proxy, org)).status).toBe(200);
    expect(outgoing.map(r => r.url)).toEqual([
      "https://api.openai.com/v1/responses", "https://a.example.com/v1/responses", "https://api.openai.com/v1/responses",
    ]);
    expect(outgoing.map(r => r.headers.get("authorization"))).toEqual([
      "Bearer synthetic-b-key", "Bearer synthetic-a-key", "Bearer synthetic-b-key",
    ]);
    expect(profileReads).toBe(0);
  });

  test.each([false, true])("same alias keeps each org's provider/header on fresh replicas (reverse=%s)", async reverse => {
    rows.set(rowKey(orgA), { kind: "claude", baseUrl: "https://a.example.com", apiKey: "synthetic-a-key" });
    rows.set(rowKey(orgB), { kind: "openai", baseUrl: "https://b.example.com/v1", apiKey: "synthetic-b-key" });
    const proxy = makeProxy();
    const catalog = makeCatalog();
    for (const org of reverse ? [orgB, orgA] : [orgA, orgB]) await catalog.getInstalledModules(`synthetic-agent-${org}`, org);
    for (const replica of [proxy, makeProxy()]) {
      expect((await request(replica, orgA)).status).toBe(200);
      expect((await request(replica, orgB)).status).toBe(200);
    }
    for (let i = 0; i < outgoing.length; i += 2) {
      expect(outgoing[i]!.url).toBe("https://a.example.com/responses");
      expect(outgoing[i]!.headers.get("x-api-key")).toBe("synthetic-a-key");
      expect(outgoing[i]!.headers.has("authorization")).toBe(false);
      expect(outgoing[i + 1]!.url).toBe("https://b.example.com/v1/responses");
      expect(outgoing[i + 1]!.headers.get("authorization")).toBe("Bearer synthetic-b-key");
      expect(outgoing[i + 1]!.headers.has("x-api-key")).toBe(false);
    }
  });

  test("fresh alias honors deployment endpoint configuration", async () => {
    rows.set(rowKey(orgB), { kind: "openai", apiKey: "synthetic-b-key" });
    const prior = process.env.OPENAI_API_BASE_URL;
    process.env.OPENAI_API_BASE_URL = "https://deployment.example.com/v1";
    restore.push(() => {
      if (prior === undefined) delete process.env.OPENAI_API_BASE_URL;
      else process.env.OPENAI_API_BASE_URL = prior;
    });
    expect((await request(makeProxy(), orgB)).status).toBe(200);
    expect(outgoing[0]!.url).toBe("https://deployment.example.com/v1/responses");
    expect(outgoing[0]!.headers.get("authorization")).toBe("Bearer synthetic-b-key");
  });

  test.each([null, { kind: "openai" }, { kind: "unknown", apiKey: "synthetic-b-key" }])(
    "missing alias row, key or trusted fallback never uses an operator/profile key (%j)", async row => {
      if (row) rows.set(rowKey(orgB), row);
      profile = { credential: "synthetic-profile-key", authType: "api-key" };
      const res = await request(makeProxy(), orgB);
      expect(res.status).toBe(401);
      expect(outgoing).toHaveLength(0);
      expect(profileReads).toBe(0);
    }
  );

  test("tagged placeholder binds a fresh alias to one agent/org pair", async () => {
    rows.set(rowKey(orgB), { kind: "openai", apiKey: "synthetic-b-key" });
    const placeholder = generatePlaceholder(`synthetic-agent-${orgB}`, "KEY",
      createBuiltinSecretRef("synthetic-secret"), "synthetic-deployment", { organizationId: orgB });
    expect((await request(makeProxy(), orgB, alias, { authorization: `Bearer ${placeholder}` })).status).toBe(200);
    expect(outgoing[0]!.headers.get("authorization")).toBe("Bearer synthetic-b-key");
  });

  test.each([orgA, undefined])("wrong-org or untagged placeholders cannot resolve an alias (%s)", async org => {
    const placeholder = generatePlaceholder(`synthetic-agent-${orgB}`, "KEY",
      createBuiltinSecretRef("synthetic-secret"), "synthetic-deployment", { organizationId: org });
    expect((await request(makeProxy(), orgB, alias, { authorization: `Bearer ${placeholder}` })).status).toBe(403);
    expect(rowReads).not.toHaveBeenCalled();
    expect(outgoing).toHaveLength(0);
  });

  test("a subscription-only kind cannot supply an API-key alias fallback", async () => {
    moduleRegistry.register(new ApiKeyProviderModule({
      providerId: "synthetic-subscription", sdkCompat: "openai-codex", authType: "oauth", supportedAuthTypes: ["oauth"],
      upstreamBaseUrl: "https://subscription.example.com", envVarName: "SYNTHETIC_SUBSCRIPTION_KEY",
      providerDisplayName: "Synthetic subscription", providerIconUrl: "", apiKeyInstructions: "", apiKeyPlaceholder: "",
      authProfilesManager: profiles as never,
    }));
    rows.set(rowKey(orgB), { kind: "synthetic-subscription", apiKey: "synthetic-b-key" });
    expect((await request(makeProxy(), orgB)).status).toBe(401);
    expect(outgoing).toHaveLength(0);
  });

  test.each(["path-org", "path-agent", "mixed-claims", "unverified"])(
    "rejects %s before alias provider-row reads", async mismatch => {
      rows.set(rowKey(orgB), { kind: "openai", apiKey: "synthetic-b-key" });
      const proxy = makeProxy();
      const extra = mismatch === "unverified" ? { authorization: "Bearer unverified-token" }
        : mismatch === "path-agent" ? { authorization: `Bearer ${token(orgB, "synthetic-other-agent")}` }
        : { "x-lobu-worker-token": mismatch === "mixed-claims"
            ? generateWorkerToken("synthetic-user", "synthetic-conversation", "synthetic-deployment", { channelId: "synthetic-channel", organizationId: orgA })
            : token(orgA) };
      expect((await request(proxy, orgB, alias, extra)).status).toBe(403);
      expect(rowReads).not.toHaveBeenCalled();
      expect(outgoing).toHaveLength(0);
    }
  );

  test.each(["custom", "missing-key", "no-url", "other-org"])(
    "canonical slug collision preserves canonical protocol/header/credential rules (%s)", async mode => {
      rows.set(rowKey(orgA, "openai"), { kind: "claude", baseUrl: "https://a.example.com/v1", apiKey: "synthetic-a-key" });
      if (mode !== "other-org") rows.set(rowKey(orgB, "openai"), {
        kind: "claude", ...(mode !== "no-url" ? { baseUrl: "https://b.example.com/v1" } : {}),
        ...(mode !== "missing-key" ? { apiKey: "synthetic-b-key" } : {}),
      });
      profile = { credential: "synthetic-profile-key", authType: "api-key" };
      const res = await request(makeProxy(), orgB, "openai");
      expect(res.status).toBe(mode === "missing-key" ? 401 : 200);
      expect(outgoing).toHaveLength(mode === "missing-key" ? 0 : 1);
      if (outgoing.length) {
        expect(outgoing[0]!.url).toBe(mode === "custom" ? "https://b.example.com/v1/responses" : "https://api.openai.com/v1/responses");
        expect(outgoing[0]!.headers.get("authorization")).toBe(mode === "other-org" ? "Bearer synthetic-profile-key" : "Bearer synthetic-b-key");
        expect(outgoing[0]!.headers.has("x-api-key")).toBe(false);
      }
      expect(profileReads).toBe(mode === "other-org" ? 1 : 0);
    }
  );

  test("custom destination failures do not log the URL or resolved key", async () => {
    const baseUrl = "https://private.example.com/v1";
    const key = "synthetic-private-key";
    rows.set(rowKey(orgB), { kind: "openai", baseUrl, apiKey: key });
    const logs: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      const logSpy = spyOn(console, method).mockImplementation((...args) => { logs.push(args.join(" ")); });
      restore.push(() => logSpy.mockRestore());
    }
    globalThis.fetch = (async () => { throw new TypeError(`request failed: ${baseUrl} ${key}`); }) as typeof fetch;
    expect((await request(makeProxy(), orgB)).status).toBe(500);
    expect(logs.join("\n")).not.toContain(baseUrl);
    expect(logs.join("\n")).not.toContain(key);
  });
});

describe("SecretProxy — org custom-upstream slug routing (URL invariant)", () => {
  beforeEach(() => {
    inferenceConfig = {
      baseUrl: "https://myzai.example.com/v1",
      apiKey: "org-myzai-key",
      custom: true,
    };
  });

  test.each([true, false])("Codex account header comes only from the stored credential (identity=%s)", async (hasIdentity) => {
    inferenceConfig = { custom: false };
    const credential = `e30.${Buffer.from(JSON.stringify(hasIdentity
      ? { "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }
      : {})).toString("base64url")}.synthetic`;
    const proxy = new SecretProxy({ defaultUpstreamUrl: "https://default.example.com" }, { get: async () => null });
    proxy.registerUpstream({ slug: "openai-codex", upstreamBaseUrl: "https://chatgpt.com/backend-api" }, "chatgpt");
    proxy.setAuthProfilesManager({
      getBestProfile: async () => ({ credential, authType: "oauth" }),
      ensureFreshCredential: async () => credential,
    } as never);
    proxy.setAgentOrgResolver(async () => "org-1");
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const res = await proxy.getApp().request("/api/proxy/openai-codex/a/agent-1/codex/responses", {
        method: "POST", headers: { authorization: "Bearer worker-token-test", "content-type": "application/json",
          "ChatGPT-Account-Id": "attacker-account" }, body: JSON.stringify({ model: "gpt-5.6-luna", stream: true }),
      });
      expect(res.status).toBe(hasIdentity ? 200 : 401);
      expect(requests).toHaveLength(hasIdentity ? 1 : 0);
      if (!hasIdentity) {
        // pi-ai reads `error.message`; a bare string reaches the user as JSON.
        expect((await res.json()).error.message).toContain("account identity");
      }
      if (hasIdentity) {
        expect(requests[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
        expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${credential}`);
        expect(requests[0]!.headers.get("chatgpt-account-id")).toBe("synthetic-account");
      }
    } finally { globalThis.fetch = originalFetch; }
  });

  test("registered org slug routes to the row base_url with the org key", async () => {
    const proxy = new SecretProxy(
      { defaultUpstreamUrl: "https://default.example.com" },
      { get: async () => null } satisfies SecretStore
    );

    // A statically registered slug whose org row names its own upstream.
    proxy.registerUpstream(
      { slug: "myzai", upstreamBaseUrl: "https://myzai.example.com/v1" },
      "myzai"
    );

    // The invariant path is gated on slugToProviderId AND authProfilesManager.
    proxy.setAuthProfilesManager({
      // Should NOT be consulted on the org-only path (fail-closed to the row key).
      getBestProfile: async () => {
        throw new Error("profile lookup must not run on org-only path");
      },
      ensureFreshCredential: async () => undefined,
    } as never);
    // Independent source of the caller's org for the invariant lookup.
    proxy.setAgentOrgResolver(async () => "org-1");

    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      capturedAuth =
        (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/myzai/a/agent-1/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer worker-token-test",
          },
          body: JSON.stringify({ model: "myzai/glm-4.6", prompt: "hi" }),
        });

      expect(res.status).toBe(200);
      // Routed to the tenant-defined URL from the row (NOT the static default).
      expect(capturedUrl).toBe(
        "https://myzai.example.com/v1/v1/chat/completions"
      );
      // Authenticated with the org row's key (Bearer for openai-compat).
      expect(capturedAuth).toBe("Bearer org-myzai-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("catalog upstream uses the inference-provider row key", async () => {
    inferenceConfig = {
      apiKey: "org-zai-key",
      custom: false,
    };
    const proxy = new SecretProxy(
      { defaultUpstreamUrl: "https://default.example.com" },
      { get: async () => null } satisfies SecretStore
    );
    proxy.registerUpstream(
      { slug: "z-ai", upstreamBaseUrl: "https://api.z.ai/api/paas/v4" },
      "z-ai"
    );
    proxy.setAuthProfilesManager({
      getBestProfile: async () => {
        throw new Error("profile lookup must not run when the org row has a key");
      },
      ensureFreshCredential: async () => undefined,
    } as never);
    proxy.setAgentOrgResolver(async () => "org-1");

    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      capturedAuth =
        (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/z-ai/a/agent-1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer worker-token-test",
          },
          body: JSON.stringify({ model: "glm-5.2", prompt: "hi" }),
        });

      expect(res.status).toBe(200);
      expect(capturedUrl).toBe(
        "https://api.z.ai/api/paas/v4/chat/completions"
      );
      expect(capturedAuth).toBe("Bearer org-zai-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
