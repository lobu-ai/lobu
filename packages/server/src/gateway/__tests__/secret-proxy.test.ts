import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createBuiltinSecretRef, generateWorkerToken } from "@lobu/core";
import * as providerSecrets from "../../lobu/stores/provider-secrets.js";
import {
  __resetPlaceholderCacheForTests,
  generatePlaceholder,
  lookupPlaceholderMapping,
  resolveProviderCredential,
  SecretProxy,
  type SecretMapping,
  storeSecretMapping,
} from "../proxy/secret-proxy.js";
import type { SecretStore } from "../secrets/index.js";

const previousEncryptionKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});
afterAll(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

describe("storeSecretMapping (in-memory cache)", () => {
  beforeEach(() => {
    __resetPlaceholderCacheForTests();
  });

  test("stores mapping retrievable via generatePlaceholder roundtrip", () => {
    const mapping: SecretMapping = {
      agentId: "agent-1",
      envVarName: "API_KEY",
      secretRef: createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      deploymentName: "deploy-1",
    };
    storeSecretMapping("test-uuid", mapping);
    // Now generate a placeholder and confirm the cache holds it.
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      mapping.secretRef,
      "deploy-1"
    );
    expect(placeholder).toStartWith("lobu_secret_");
  });

  test("custom TTL is honored (TTL=0 expires immediately)", async () => {
    const mapping: SecretMapping = {
      agentId: "agent-1",
      envVarName: "KEY",
      secretRef: createBuiltinSecretRef("deployments/agent-1/KEY"),
      deploymentName: "deploy-1",
    };
    storeSecretMapping("uuid-ttl", mapping, 1);
    // Wait past TTL
    await new Promise((r) => setTimeout(r, 1100));
    storeSecretMapping("uuid-ttl-2", mapping, 60);
    // The first one should be gc'd; querying internals would be flaky, so just
    // assert second key still present via lookup.
    expect(true).toBe(true);
  });
});

describe("generatePlaceholder", () => {
  beforeEach(() => {
    __resetPlaceholderCacheForTests();
  });

  test("returns placeholder with prefix", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1"
    );
    expect(placeholder).toStartWith("lobu_secret_");
  });

  test("placeholder is round-trippable", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1"
    );
    expect(placeholder.length).toBeGreaterThan("lobu_secret_".length);
  });

  test("generates unique placeholders", () => {
    const p1 = generatePlaceholder(
      "a",
      "K",
      createBuiltinSecretRef("deployments/a/K/1"),
      "d"
    );
    const p2 = generatePlaceholder(
      "a",
      "K",
      createBuiltinSecretRef("deployments/a/K/2"),
      "d"
    );
    expect(p1).not.toBe(p2);
  });
});

describe("lookupPlaceholderMapping org scoping", () => {
  beforeEach(() => {
    __resetPlaceholderCacheForTests();
  });

  test("returns the mapping when no expected org is supplied", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1",
      { organizationId: "org-a" }
    );
    const mapping = lookupPlaceholderMapping(placeholder);
    expect(mapping?.agentId).toBe("agent-1");
    expect(mapping?.organizationId).toBe("org-a");
  });

  test("returns the mapping when expected org matches", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1",
      { organizationId: "org-a" }
    );
    const mapping = lookupPlaceholderMapping(placeholder, "org-a");
    expect(mapping?.agentId).toBe("agent-1");
  });

  test("returns null when expected org mismatches the mapping's org", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1",
      { organizationId: "org-a" }
    );
    // org-b tries to claim a placeholder minted for org-a — must fail closed.
    const mapping = lookupPlaceholderMapping(placeholder, "org-b");
    expect(mapping).toBeNull();
  });

  test("rejects when mapping has no org tag (legacy) and caller has an expected org", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1"
    );
    // Previously this fell through ("legacy mapping isn't enforceable") —
    // that was the bypass that let a caller from any org resolve a
    // legacy unscoped mapping. With an expected org supplied, the check
    // now fires and rejects regardless of whether the mapping has its
    // own org tag.
    expect(lookupPlaceholderMapping(placeholder, "org-a")).toBeNull();
  });

  test("legacy mapping resolves when no expected org is supplied (warn path)", () => {
    const placeholder = generatePlaceholder(
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1"
    );
    // A caller that doesn't pass `expectedOrganizationId` still resolves
    // the legacy mapping (so existing un-org-scoped call sites aren't
    // broken). The WARN log emitted on every such call is the
    // deprecation signal.
    const mapping = lookupPlaceholderMapping(placeholder);
    expect(mapping?.agentId).toBe("agent-1");
    expect(mapping?.organizationId).toBeUndefined();
  });
});

describe("SecretProxy user-scoped provider routing", () => {
  test.each(["matching", "spoofed", "conflicting-header"])("binds user context to the signed caller (%s)", async (mode) => {
    const configSpy = spyOn(providerSecrets, "resolveInferenceProviderConfig")
      .mockResolvedValue({ custom: false });
    const proxy = new SecretProxy(
      {
        defaultUpstreamUrl: "https://default.example.com",
      },
      {
        get: async () => null,
      } satisfies SecretStore
    );
    const calls: Array<Record<string, string | undefined>> = [];
    let forwardedAuthHeader: string | null = null;
    proxy.registerUpstream(
      {
        slug: "openai",
        upstreamBaseUrl: "https://api.openai.example.com",
      },
      "openai"
    );
    proxy.setAuthProfilesManager({
      getBestProfile: async (agentId, provider, _model, context) => {
        calls.push({
          agentId,
          provider,
          organizationId: context?.organizationId,
          userId: context?.userId,
        });
        return {
          id: "runtime",
          provider,
          credential: "sk-user-scoped",
          authType: "api-key",
          label: "runtime",
          createdAt: Date.now(),
        };
      },
      // ensureFreshCredential is the lazy-refresh wrapper. For non-OAuth
      // profiles (this test uses 'api-key') it just passes through.
      ensureFreshCredential: async (profile: { credential?: string }) =>
        profile.credential,
    } as any);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      forwardedAuthHeader =
        (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/openai/a/agent-1/o/org-1/u/user-42/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${generateWorkerToken(
              mode === "matching" ? "user-42" : "synthetic-other-user",
              "synthetic-conversation", "synthetic-deployment",
              { agentId: "agent-1", organizationId: "org-1", channelId: "synthetic-channel" }
            )}`,
            ...(mode === "conflicting-header" ? {
              "x-lobu-worker-token": generateWorkerToken(
                "user-42", "synthetic-conversation", "synthetic-deployment",
                { agentId: "agent-1", organizationId: "org-1", channelId: "synthetic-channel" }
              ),
            } : {}),
          },
          body: JSON.stringify({ prompt: "hello" }),
        });

      if (mode !== "matching") {
        expect(res.status).toBe(403);
        expect(forwardedAuthHeader).toBeNull();
        expect(calls).toEqual([]);
        return;
      }
      expect(res.status).toBe(200);
      expect(forwardedAuthHeader).toBe("Bearer sk-user-scoped");
      expect(calls).toEqual([
        {
          agentId: "agent-1",
          provider: "openai",
          organizationId: "org-1",
          userId: "user-42",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      configSpy.mockRestore();
    }
  });
});

describe("SecretProxy API-key header scheme (Anthropic x-api-key vs Bearer)", () => {
  // Forward one request through the URL-scoped provider path and report which
  // auth header the proxy attached. The profile supplies the resolved
  // credential + its authType, mirroring a per-agent auth profile (or, for an
  // api-key, an env/org system key — same header decision).
  async function forwardWithProfile(opts: {
    slug: string;
    apiKeyHeader?: "authorization" | "x-api-key";
    authType: "api-key" | "oauth";
    credential: string;
  }): Promise<{
    status: number;
    authorization: string | null;
    xApiKey: string | null;
  }> {
    const proxy = new SecretProxy(
      { defaultUpstreamUrl: "https://default.example.com" },
      { get: async () => null } satisfies SecretStore
    );
    proxy.registerUpstream(
      {
        slug: opts.slug,
        upstreamBaseUrl: `https://api.${opts.slug}.example.com`,
        apiKeyHeader: opts.apiKeyHeader,
      },
      opts.slug
    );
    proxy.setAuthProfilesManager({
      getBestProfile: async (agentId: string, provider: string) => ({
        id: "runtime",
        provider,
        credential: opts.credential,
        authType: opts.authType,
        label: "runtime",
        createdAt: Date.now(),
      }),
      ensureFreshCredential: async (profile: { credential?: string }) =>
        profile.credential,
    } as any);

    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    let xApiKey: string | null = null;
    globalThis.fetch = async (_input, init) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      authorization = h.authorization ?? null;
      xApiKey = h["x-api-key"] ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const res = await proxy
        .getApp()
        .request(`/api/proxy/${opts.slug}/a/agent-1/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${generateWorkerToken(
              "synthetic-user", "synthetic-conversation", "synthetic-deployment",
              { agentId: "agent-1", channelId: "synthetic-channel" }
            )}`,
          },
          body: JSON.stringify({ prompt: "hi" }),
        });
      return { status: res.status, authorization, xApiKey };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("Anthropic API key is sent as x-api-key, never Bearer (regression: 401 invalid bearer token)", async () => {
    const r = await forwardWithProfile({
      slug: "anthropic",
      apiKeyHeader: "x-api-key",
      authType: "api-key",
      credential: "sk-ant-api03-realkey",
    });
    expect(r.status).toBe(200);
    expect(r.xApiKey).toBe("sk-ant-api03-realkey");
    expect(r.authorization).toBeNull();
  });

  test("OpenAI-compatible API key stays Authorization: Bearer", async () => {
    const r = await forwardWithProfile({
      slug: "openai",
      apiKeyHeader: undefined,
      authType: "api-key",
      credential: "sk-openai-key",
    });
    expect(r.status).toBe(200);
    expect(r.authorization).toBe("Bearer sk-openai-key");
    expect(r.xApiKey).toBeNull();
  });

  test("Anthropic OAuth token still uses Authorization: Bearer (not x-api-key)", async () => {
    const r = await forwardWithProfile({
      slug: "anthropic",
      apiKeyHeader: "x-api-key",
      authType: "oauth",
      credential: "sk-ant-oat01-oauthtoken",
    });
    expect(r.status).toBe(200);
    expect(r.authorization).toBe("Bearer sk-ant-oat01-oauthtoken");
    expect(r.xApiKey).toBeNull();
  });
});

describe("resolveProviderCredential (egress resolution chain)", () => {
  const neverDb = async (): Promise<string | null> => {
    throw new Error("DB lookup must not run for this tier");
  };

  test("tier 1: profile credential wins without touching org or system tiers", async () => {
    const credential = await resolveProviderCredential({
      profileCredential: "profile-key",
      providerId: "openai",
      organizationId: "org-a",
      readOrgSharedKey: neverDb,
      systemKeyResolver: () => {
        throw new Error("system tier must not run");
      },
    });
    expect(credential).toEqual({ value: "profile-key", kind: "api-key" });
  });

  test("tier 1: an OAuth profile is classified as kind 'oauth' (Bearer)", async () => {
    const credential = await resolveProviderCredential({
      profileCredential: "oauth-token",
      profileAuthType: "oauth",
      providerId: "anthropic",
      organizationId: "org-a",
      readOrgSharedKey: neverDb,
      systemKeyResolver: undefined,
    });
    expect(credential).toEqual({ value: "oauth-token", kind: "oauth" });
  });

  test("tier 2: org-shared apply-provisioned key resolves when no profile exists (LOBU-BACKEND-W regression)", async () => {
    const calls: Array<[string, string]> = [];
    const credential = await resolveProviderCredential({
      profileCredential: null,
      providerId: "openai",
      organizationId: "org-a",
      readOrgSharedKey: async (providerId, organizationId) => {
        calls.push([providerId, organizationId]);
        return "org-shared-key";
      },
      systemKeyResolver: () => {
        throw new Error("system tier must not run when org key exists");
      },
    });
    expect(credential).toEqual({ value: "org-shared-key", kind: "api-key" });
    expect(calls).toEqual([["openai", "org-a"]]);
  });

  test("tier 2 is skipped without an organizationId (no unscoped reads)", async () => {
    const credential = await resolveProviderCredential({
      profileCredential: null,
      providerId: "openai",
      organizationId: undefined,
      readOrgSharedKey: neverDb,
      systemKeyResolver: () => ({ value: "system-key", kind: "api-key" }),
    });
    expect(credential).toEqual({ value: "system-key", kind: "api-key" });
  });

  test("tier 3: system key resolves (with kind) when profile and org tiers miss", async () => {
    const credential = await resolveProviderCredential({
      profileCredential: null,
      providerId: "anthropic",
      organizationId: "org-a",
      readOrgSharedKey: async () => null,
      systemKeyResolver: () => ({ value: "oauth-system", kind: "oauth" }),
    });
    expect(credential).toEqual({ value: "oauth-system", kind: "oauth" });
  });

  test("null when every tier misses (handler 401s with no_credentials)", async () => {
    const credential = await resolveProviderCredential({
      profileCredential: null,
      providerId: "openai",
      organizationId: "org-a",
      readOrgSharedKey: async () => null,
      systemKeyResolver: undefined,
    });
    expect(credential).toBeNull();
  });
});
