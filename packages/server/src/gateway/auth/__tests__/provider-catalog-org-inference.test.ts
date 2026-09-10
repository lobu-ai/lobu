import { afterEach, describe, expect, test } from "bun:test";
import {
  type ModuleInterface,
  moduleRegistry,
  type SdkCompat,
} from "@lobu/core";
import type { InferenceProviderListItem } from "../../../lobu/stores/provider-secrets.js";
import {
  ApiKeyProviderModule as ApiKeyProviderModuleImpl,
  type ApiKeyProviderModule,
} from "../api-key-provider-module.js";
import { ProviderCatalogService } from "../provider-catalog.js";

/**
 * Register a fake catalog module so buildProviderCatalog() (called inside
 * getInstalledModules to map an org row's `kind` → protocol) can resolve it.
 * Keyed by `name`; the registry only stores enabled modules.
 */
function registerFakeModule(
  providerId: string,
  sdkCompat: string,
  opts: { hasSystemKey?: boolean } = {}
): void {
  moduleRegistry.register({
    name: `${providerId}-provider`,
    isEnabled: () => true,
    providerId,
    providerDisplayName: providerId,
    providerIconUrl: "",
    authType: "oauth",
    sdkCompat,
    hasSystemKey: () => opts.hasSystemKey ?? false,
    getSecretEnvVarNames: () => [],
  } as unknown as ModuleInterface);
}

/**
 * Register a REAL ApiKeyProviderModule so buildProviderCatalog() resolves both
 * the protocol AND the catalog upstream URL for that slug. The plain fake above
 * is not an ApiKeyProviderModule, so it contributes no baseUrl — which is
 * exactly what a kind with no catalog upstream looks like.
 */
function registerCatalogModule(
  providerId: string,
  sdkCompat: SdkCompat,
  upstreamBaseUrl: string
): void {
  moduleRegistry.register(
    new ApiKeyProviderModuleImpl({
      providerId,
      slug: providerId,
      sdkCompat,
      upstreamBaseUrl,
      envVarName: `${providerId.toUpperCase()}_API_KEY`,
      providerDisplayName: providerId,
      providerIconUrl: "",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "",
      authProfilesManager: { getBestProfile: async () => null } as never,
    }) as unknown as ModuleInterface
  );
}

function clearRegistry(): void {
  (
    moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
  ).modules = new Map();
}

/**
 * Org-owned inference-provider slugs (rows in `inference_providers`) must become
 * ROUTABLE worker model providers: an agent with `models: ["<orgSlug>/<model>"]`
 * routes through the gateway proxy to the org's custom `capabilities.text.base_url`.
 *
 * getInstalledModules resolves the agent's `models` list (ordered explicit
 * `<slug>/<model>` refs) into modules: a slug that isn't a providers.json module
 * but matches an org row is synthesized into an ApiKeyProviderModule, routed to
 * the row's own custom upstream when it has one and otherwise to the upstream
 * its `kind` resolves to. The org KEY is never read here — it is injected at
 * egress by resolveUrlInvariant; the synthetic module only makes the slug appear
 * in the worker provider config and the proxy slug maps. Registration happens
 * per-pod, hydrated from the row (multi-replica safe: no shared in-memory map
 * another replica must read).
 *
 * These tests inject the store reader + registerUpstream callback and a fake
 * settings store, so no DB/proxy wiring is required.
 */

function makeCatalog(opts: {
  models: string[] | undefined;
  orgRows?: InferenceProviderListItem[];
  registerUpstream?: (
    upstream: { slug: string; upstreamBaseUrl: string },
    providerId: string
  ) => void;
  withOrgReader?: boolean;
}): ProviderCatalogService {
  const agentSettingsStore = {
    getSettings: async () => ({
      models: opts.models,
    }),
  } as never;
  // findProviderForModel probes each module's getModelOptions, which resolves
  // credentials through the profiles manager — stub it to "no profile".
  const authProfilesManager = { getBestProfile: async () => null } as never;
  const listOrgInferenceProviders =
    opts.withOrgReader === false ? undefined : async () => opts.orgRows ?? [];
  return new ProviderCatalogService(
    agentSettingsStore,
    authProfilesManager,
    listOrgInferenceProviders as never,
    opts.registerUpstream as never
  );
}

function customUpstreamRow(
  slug: string,
  overrides?: Partial<InferenceProviderListItem>
): InferenceProviderListItem {
  return {
    id: 1,
    slug,
    kind: "openai",
    displayName: `${slug} display`,
    capabilities: {
      text: { base_url: `https://${slug}.example.com/v1`, model: "glm-4.6" },
    },
    hasCustomUpstream: true,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProviderCatalogService.getInstalledModules — org inference providers", () => {
  afterEach(() => clearRegistry());

  test("synthesizes a routable module for a custom-upstream org slug + registers its upstream", async () => {
    const registered: Array<{ slug: string; providerId: string; url: string }> =
      [];
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [customUpstreamRow("myzai")],
      registerUpstream: (upstream, providerId) =>
        registered.push({
          slug: upstream.slug,
          providerId,
          url: upstream.upstreamBaseUrl,
        }),
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules).toHaveLength(1);
    const mod = modules[0] as ApiKeyProviderModule;
    expect(mod.providerId).toBe("myzai");

    // getUpstreamConfig() returns {slug, upstreamBaseUrl} matching the row.
    const upstream = mod.getUpstreamConfig();
    expect(upstream).toEqual({
      slug: "myzai",
      upstreamBaseUrl: "https://myzai.example.com/v1",
      apiKeyHeader: undefined,
    });

    // getProviderMetadata() advertises openai sdkCompat + the row's defaultModel.
    const meta = mod.getProviderMetadata();
    expect(meta?.sdkCompat).toBe("openai");
    expect(meta?.defaultModel).toBe("glm-4.6");

    // The slug was registered on the proxy so it becomes routable.
    expect(registered).toEqual([
      {
        slug: "myzai",
        providerId: "myzai",
        url: "https://myzai.example.com/v1",
      },
    ]);

    // Never surfaced in the "Add Provider" catalog.
    expect(mod.catalogVisible).toBe(false);
  });

  test("an org row whose kind is an anthropic provider routes as anthropic (x-api-key)", async () => {
    // Claude-like catalog module so kind "claude" resolves to sdkCompat anthropic.
    registerFakeModule("claude", "anthropic");
    const catalog = makeCatalog({
      models: ["my-claude/claude-x"],
      orgRows: [customUpstreamRow("my-claude", { kind: "claude" })],
      registerUpstream: () => {},
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules).toHaveLength(1);
    const mod = modules[0] as ApiKeyProviderModule;

    // Protocol resolved from the row's kind → anthropic, not the default openai.
    expect(mod.getProviderMetadata()?.sdkCompat).toBe("anthropic");
    // Anthropic keys must present as x-api-key, not Bearer — the proxy reads
    // this off the upstream config at egress.
    expect(mod.getUpstreamConfig()?.apiKeyHeader).toBe("x-api-key");
  });

  test("an ALIAS slug with no custom upstream routes to its kind's catalog URL", async () => {
    // The reachable gap: an org creates a provider whose slug differs from its
    // kind (slug "my-gemini", kind "gemini") and stores a key, but sets no
    // custom `capabilities.text.base_url` — the common case, since the catalog
    // already knows where gemini lives. `moduleMap.get("my-gemini")` misses (no
    // providers.json module answers to the alias), so the row's ONLY route was
    // synthesis — which used to bail without a row base_url. The row persisted,
    // listed as configured, and silently never routed.
    //
    // The kind's own catalog upstream is a safe fallback: it is a trusted
    // providers.json URL, not a tenant-defined one, so resolveUrlInvariant
    // answers `org-credential` and sends the row's own key — never the
    // exfiltration path a tenant URL would open.
    registerCatalogModule(
      "gemini",
      "openai",
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
    const registered: Array<{ slug: string; url: string }> = [];
    const catalog = makeCatalog({
      models: ["my-gemini/gemini-3-pro"],
      orgRows: [
        customUpstreamRow("my-gemini", {
          kind: "gemini",
          capabilities: { text: { model: "gemini-3-pro" } },
          hasCustomUpstream: false,
        }),
      ],
      registerUpstream: (u) =>
        registered.push({ slug: u.slug, url: u.upstreamBaseUrl }),
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules).toHaveLength(1);
    const mod = modules[0] as ApiKeyProviderModule;
    expect(mod.providerId).toBe("my-gemini");
    expect(mod.getUpstreamConfig()?.upstreamBaseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
    // Registered under the ALIAS slug — that is the name the worker's model ref
    // carries, so that is what the proxy must answer to.
    expect(registered).toEqual([
      {
        slug: "my-gemini",
        url: "https://generativelanguage.googleapis.com/v1beta/openai",
      },
    ]);
  });

  test("an official OpenAI alias uses Responses, not Chat Completions", async () => {
    registerCatalogModule(
      "openai",
      "openai",
      "https://api.openai.com/v1"
    );
    const catalog = makeCatalog({
      models: ["my-openai/gpt-5.6-sol"],
      orgRows: [
        customUpstreamRow("my-openai", {
          kind: "openai",
          capabilities: { text: { model: "gpt-5.6-sol" } },
          hasCustomUpstream: false,
        }),
      ],
      registerUpstream: () => {},
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    const mod = modules[0] as ApiKeyProviderModule;
    expect(mod.getUpstreamConfig()?.upstreamBaseUrl).toBe(
      "https://api.openai.com/v1"
    );
    expect(mod.getProviderMetadata()?.sdkCompat).toBe("openai-responses");
  });

  test("an OAuth kind contributes NO fallback upstream", async () => {
    // An OAuth provider (chatgpt, claude) registers as a plain module, not an
    // ApiKeyProviderModule, so buildProviderCatalog() reports baseUrl "" for it
    // — there is nothing for an API key to reach. Routing must refuse such a
    // row, because the create route already does ("it signs in instead"), and
    // the two disagreeing is what promotes an unroutable row to org default.
    registerFakeModule("chatgpt", "openai-codex");
    const catalog = makeCatalog({
      models: ["my-chatgpt/gpt-5"],
      orgRows: [
        customUpstreamRow("my-chatgpt", {
          kind: "chatgpt",
          capabilities: { text: { model: "gpt-5" } },
          hasCustomUpstream: false,
        }),
      ],
      registerUpstream: () => {},
    });

    expect(await catalog.getInstalledModules("agent-1", "org-1")).toHaveLength(
      0
    );
  });

  test("a kind with a REACHABLE upstream but no known protocol contributes none either", async () => {
    // Isolates the `sdkCompat` gate specifically. The test above passes on the
    // empty baseUrl alone, so it would survive deleting that gate — this one
    // cannot: the module IS an ApiKeyProviderModule with a real upstream, and
    // only the unknown protocol stops the fallback.
    //
    // Why the gate has to exist: `synthesizeOrgProviderModule` DEFAULTS an
    // unknown protocol to "openai". Falling back for a kind whose wire protocol
    // we do not actually know would speak OpenAI at an upstream that may not be,
    // and send the org's key while doing it.
    registerCatalogModule(
      "mystery",
      "not-a-protocol" as never,
      "https://mystery.example.com/v1"
    );
    const catalog = makeCatalog({
      models: ["my-mystery/some-model"],
      orgRows: [
        customUpstreamRow("my-mystery", {
          kind: "mystery",
          capabilities: { text: { model: "some-model" } },
          hasCustomUpstream: false,
        }),
      ],
      registerUpstream: () => {},
    });

    expect(await catalog.getInstalledModules("agent-1", "org-1")).toHaveLength(
      0
    );
  });

  test("a row's OWN base_url still wins over the kind's catalog URL", async () => {
    // Guards the fallback direction: adding the catalog default must never
    // re-point an org that deliberately configured its own upstream.
    registerCatalogModule("gemini", "openai", "https://catalog.example.com/v1");
    const catalog = makeCatalog({
      models: ["my-gemini/gemini-3-pro"],
      orgRows: [customUpstreamRow("my-gemini", { kind: "gemini" })],
      registerUpstream: () => {},
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    const mod = modules[0] as ApiKeyProviderModule;
    expect(mod.getUpstreamConfig()?.upstreamBaseUrl).toBe(
      "https://my-gemini.example.com/v1"
    );
  });

  test("does NOT synthesize when neither the row NOR its kind has an upstream", async () => {
    // No module registered for kind "openai", so the catalog contributes no
    // fallback URL either — there is genuinely nowhere to route.
    const registered: string[] = [];
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [
        customUpstreamRow("myzai", {
          capabilities: {},
          hasCustomUpstream: false,
        }),
      ],
      registerUpstream: (u) => registered.push(u.slug),
    });

    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules).toHaveLength(0);
    expect(registered).toEqual([]);
  });

  test("does NOT synthesize when organizationId is absent (slug dropped as before)", async () => {
    let readerCalled = false;
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [customUpstreamRow("myzai")],
    });
    // Wrap to detect that the reader is never consulted without an org.
    (
      catalog as never as { listOrgInferenceProviders?: unknown }
    ).listOrgInferenceProviders = async () => {
      readerCalled = true;
      return [customUpstreamRow("myzai")];
    };

    const modules = await catalog.getInstalledModules("agent-1");
    expect(modules).toHaveLength(0);
    expect(readerCalled).toBe(false);
  });

  test("preserves models order and drops unmatched slugs", async () => {
    // Two org-synthesized slugs plus one models entry with NO matching row.
    // The unmatched slug is dropped (as a non-providers.json slug always was),
    // and the two synthesized modules keep the models-list order.
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6", "no-such-provider/x", "acme/m-1"],
      orgRows: [customUpstreamRow("acme"), customUpstreamRow("myzai")],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    const ids = modules.map((m) => m.providerId);
    // models order preserved (myzai before acme); unmatched slug dropped.
    expect(ids).toEqual(["myzai", "acme"]);
  });

  test("dedups slugs by first appearance across multiple models of one provider", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6", "myzai/glm-5.2", "acme/m-1"],
      orgRows: [customUpstreamRow("acme"), customUpstreamRow("myzai")],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules.map((m) => m.providerId)).toEqual(["myzai", "acme"]);
  });

  test("decision B: does NOT append the org default to a non-empty list", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [
        customUpstreamRow("myzai"),
        customUpstreamRow("acme", { isDefault: true }),
      ],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    // The org default (acme) is NOT reachable — only the listed slug resolves.
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);
  });

  test("GATE: an org provider NOT in the agent's non-empty models list does not resolve", async () => {
    // "acme" is org-installed (a live inference_providers row) but the agent's
    // models list names only "myzai" — so acme must NOT be routable for this
    // agent. Decision B: NO org-default tail — only the listed slugs resolve.
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [
        customUpstreamRow("myzai", { isDefault: true }),
        customUpstreamRow("acme"),
      ],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);

    // The resolver finds no provider for an out-of-list model ref.
    const provider = await catalog.findProviderForModel("acme/some-model", modules);
    expect(provider).toBeUndefined();
  });

  test("EMPTY models list ⇒ all org rows (default first) plus system-key registry modules", async () => {
    // Decision: an agent with no models list gets every org provider — the org
    // default row first, the remaining org rows, then every registry module
    // with a deployment/system key not already covered.
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    registerFakeModule("keyless", "openai", { hasSystemKey: false });
    const catalog = makeCatalog({
      models: [],
      orgRows: [
        customUpstreamRow("myzai"),
        customUpstreamRow("acme", { isDefault: true }),
      ],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    const ids = modules.map((m) => m.providerId);
    // Org default first, then remaining org rows, then system-key modules.
    expect(ids).toEqual(["acme", "myzai", "housekey"]);
    // A registry module WITHOUT a system key is not exposed.
    expect(ids).not.toContain("keyless");
  });

  test("ABSENT models (undefined) behaves like the empty list", async () => {
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: undefined,
      orgRows: [customUpstreamRow("acme", { isDefault: true })],
    });
    const modules = await catalog.getInstalledModules("agent-1", "org-1");
    expect(modules.map((m) => m.providerId)).toEqual(["acme", "housekey"]);
  });
});

describe("ProviderCatalogService.getModelPolicy — exact allow-list", () => {
  afterEach(() => clearRegistry());

  test("non-empty list ⇒ allowedRefs is EXACTLY the listed refs (decision B: NO org-default tail)", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [
        // acme is the org default but must NOT leak into allowedRefs/modules.
        customUpstreamRow("acme", { isDefault: true }),
        customUpstreamRow("myzai"),
      ],
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "agent-1",
      "org-1"
    );
    // Exactly the listed ref — no org-default concrete ref appended.
    expect(allowedRefs).toEqual(["myzai/glm-4.6"]);
    // Modules cover ONLY the listed provider — the org default is not added.
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);
  });

  test("decision B: a sentinel-only list resolves to zero routable modules (hard fail closed)", async () => {
    // models = ["chatgpt/__unresolved__"] is the "restricted but nothing
    // resolvable yet" state: the allow-list contains only the sentinel, and no
    // real module routes it — findProviderForModel refuses the sentinel.
    registerFakeModule("chatgpt", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["chatgpt/__unresolved__"],
      orgRows: [],
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "agent-1",
      "org-1"
    );
    expect(allowedRefs).toEqual(["chatgpt/__unresolved__"]);
    // #2(a): the sentinel's slug MUST NOT contribute a provider module — even
    // though a credentialed chatgpt module exists in the registry. Zero modules
    // means session-context has nothing to fall back to → hard fail closed.
    expect(modules).toHaveLength(0);
    // And findProviderForModel refuses the sentinel ref outright.
    const provider = await catalog.findProviderForModel(
      "chatgpt/__unresolved__",
      modules
    );
    expect(provider).toBeUndefined();
  });

  test("#2(a): a MIXED list exposes the real provider's module but NOT the sentinel's", async () => {
    // models=["ghost/__unresolved__","myzai/glm-4.6"]. The real provider (myzai)
    // routes; the sentinel's slug (ghost) contributes NO module.
    const catalog = makeCatalog({
      models: ["ghost/__unresolved__", "myzai/glm-4.6"],
      orgRows: [customUpstreamRow("myzai", { isDefault: true })],
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "agent-1",
      "org-1"
    );
    // The sentinel stays in the exact allow-list (it's a listed entry)…
    expect(allowedRefs).toEqual(["ghost/__unresolved__", "myzai/glm-4.6"]);
    // …but only the real provider resolves a module.
    expect(modules.map((m) => m.providerId)).toEqual(["myzai"]);
  });

  test("GATE is EXACT: a different model on a LISTED provider is NOT allowed", async () => {
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6"],
      orgRows: [customUpstreamRow("myzai", { isDefault: true })],
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    // The provider is myzai but "myzai/other" is a DIFFERENT model → excluded.
    expect(allowedRefs).toContain("myzai/glm-4.6");
    expect(allowedRefs).not.toContain("myzai/other");
  });

  test("empty list ⇒ allowedRefs is null (allow-all)", async () => {
    const catalog = makeCatalog({
      models: [],
      orgRows: [customUpstreamRow("acme", { isDefault: true })],
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    expect(allowedRefs).toBeNull();
  });

  test("multiple same-provider entries are BOTH in the exact allow-list (ordered)", async () => {
    // The gate must permit each listed model of one provider — this is what
    // lets models[1..] act as ordered same-provider fallbacks.
    const catalog = makeCatalog({
      models: ["myzai/glm-4.6", "myzai/glm-5.2"],
      orgRows: [customUpstreamRow("myzai", { isDefault: true })],
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    expect(allowedRefs?.[0]).toBe("myzai/glm-4.6");
    expect(allowedRefs).toContain("myzai/glm-5.2");
  });
});

describe("ProviderCatalogService.getModelPolicy — not-found / orgless are DENY-ALL (R5 #2/#4)", () => {
  afterEach(() => clearRegistry());

  function makeCatalogWithSettings(settings: {
    getSettings: (agentId: string, ctx?: { organizationId?: string }) => Promise<unknown>;
    isDeclaredAgent?: (agentId: string) => boolean;
  }): ProviderCatalogService {
    return new ProviderCatalogService(
      settings as never,
      { getBestProfile: async () => null } as never,
      (async () => []) as never,
      (() => {}) as never
    );
  }

  test("R5 #2: a NOT-FOUND agent (getSettings→null) is DENY-ALL (allowedRefs=[], zero modules)", async () => {
    // Register a system-key module: if this were allow-all it would leak here.
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    const catalog = makeCatalogWithSettings({
      getSettings: async () => null,
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "ghost-agent",
      "org-1"
    );
    expect(allowedRefs).toEqual([]); // deny-all, NOT null (allow-all)
    expect(modules).toHaveLength(0);

    // Any requested model fails closed.
    const resolved = await catalog.resolveDispatchModel(
      "ghost-agent",
      "org-1",
      "openai/gpt-5"
    );
    expect(resolved.model).toBeUndefined();
    expect(resolved.replaced).toBe(true);
  });

  test("R5 #4: an ORGLESS db-backed read is DENY-ALL (no id-only cross-org lookup)", async () => {
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    let getSettingsCalled = false;
    const catalog = makeCatalogWithSettings({
      getSettings: async () => {
        getSettingsCalled = true;
        // Even if the store WOULD return another org's list, the resolver must
        // refuse the orgless read before this runs.
        return { models: ["claude/other-org-model"] };
      },
      isDeclaredAgent: () => false,
    });
    const { allowedRefs, modules } = await catalog.getModelPolicy(
      "lobu-builder",
      undefined // no org
    );
    expect(allowedRefs).toEqual([]);
    expect(modules).toHaveLength(0);
    // The DB read was never attempted for the orgless db-backed agent.
    expect(getSettingsCalled).toBe(false);
  });

  test("R5 #4: an ORGLESS DECLARED agent still resolves its org-agnostic policy", async () => {
    const catalog = makeCatalogWithSettings({
      getSettings: async () => ({ models: ["openai/gpt-5"] }),
      isDeclaredAgent: () => true, // declared/SDK-embedded → org-agnostic
    });
    const { allowedRefs } = await catalog.getModelPolicy(
      "declared-agent",
      undefined
    );
    expect(allowedRefs).toEqual(["openai/gpt-5"]);
  });

  test("a present agent with an EMPTY models list keeps ALLOW-ALL (null)", async () => {
    registerFakeModule("housekey", "openai", { hasSystemKey: true });
    const catalog = makeCatalogWithSettings({
      getSettings: async () => ({ models: [] }),
    });
    const { allowedRefs } = await catalog.getModelPolicy("agent-1", "org-1");
    expect(allowedRefs).toBeNull(); // allow-all preserved — NOT collapsed to deny
  });
});

/**
 * A quota-exhausted provider keeps its API key, so the routability predicate
 * (`hasSystemKey() || hasCredentials()`) cannot tell it apart from a working
 * one. Observed live in prod: an agent listing
 * ["qwen/… (429)", "xai/grok-4 (active)"] routed every turn to the dead head
 * even though the ordered `models` list already named the healthy alternate.
 *
 * `resolveDispatchModel` therefore prefers a healthy sibling — but only as a
 * PREFERENCE, since `inference_providers.status` is written best-effort from an
 * upstream response and may be stale.
 */
describe("ProviderCatalogService.resolveDispatchModel — provider health", () => {
  afterEach(() => clearRegistry());

  /**
   * `ageMs` is how long ago the health row was stamped. `listInferenceProviders`
   * always returns `updatedAt`, and the routing preference expires with it, so
   * the fixture must carry it or it would not match the producer's shape.
   */
  function healthRow(
    slug: string,
    status: "active" | "error",
    ageMs = 0
  ): InferenceProviderListItem {
    return {
      id: 1,
      slug,
      kind: slug,
      displayName: slug,
      capabilities: { text: { model: "m" } },
      hasCustomUpstream: false,
      status,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: new Date(Date.now() - ageMs).toISOString(),
    } as InferenceProviderListItem;
  }

  test("an exhausted provider yields to the healthy ref the agent already lists", async () => {
    registerFakeModule("qwen", "openai", { hasSystemKey: true });
    registerFakeModule("xai", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["qwen/qwen3.8-max", "xai/grok-4"],
      orgRows: [healthRow("qwen", "error"), healthRow("xai", "active")],
    });

    const r = await catalog.resolveDispatchModel(
      "agent-1",
      "org-1",
      "qwen/qwen3.8-max"
    );

    expect(r.model).toBe("xai/grok-4");
    expect(r.replaced).toBe(true);
  });

  test("an exhausted provider with no healthy alternate still dispatches (never strands)", async () => {
    registerFakeModule("qwen", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["qwen/qwen3.8-max"],
      orgRows: [healthRow("qwen", "error")],
    });

    const r = await catalog.resolveDispatchModel(
      "agent-1",
      "org-1",
      "qwen/qwen3.8-max"
    );

    expect(r.model).toBe("qwen/qwen3.8-max");
    expect(r.replaced).toBe(false);
  });

  test("all-active rows leave the requested ref untouched", async () => {
    registerFakeModule("qwen", "openai", { hasSystemKey: true });
    registerFakeModule("xai", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["qwen/qwen3.8-max", "xai/grok-4"],
      orgRows: [healthRow("qwen", "active"), healthRow("xai", "active")],
    });

    const r = await catalog.resolveDispatchModel(
      "agent-1",
      "org-1",
      "qwen/qwen3.8-max"
    );

    expect(r.model).toBe("qwen/qwen3.8-max");
    expect(r.replaced).toBe(false);
  });

  test("a STALE error row stops steering, so traffic drifts back and can recover", async () => {
    // `error` is cleared only by a proxied 2xx for that slug, so if routing
    // avoided the provider forever nothing would ever clear it and a transient
    // 429 would exile it permanently. The preference expires instead.
    registerFakeModule("qwen", "openai", { hasSystemKey: true });
    registerFakeModule("xai", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["qwen/qwen3.8-max", "xai/grok-4"],
      orgRows: [
        healthRow("qwen", "error", 60 * 60 * 1000),
        healthRow("xai", "active"),
      ],
    });

    const r = await catalog.resolveDispatchModel(
      "agent-1",
      "org-1",
      "qwen/qwen3.8-max"
    );

    expect(r.model).toBe("qwen/qwen3.8-max");
    expect(r.replaced).toBe(false);
  });

  test("a row with no usable updatedAt degrades to health-blind rather than exiling it", async () => {
    registerFakeModule("qwen", "openai", { hasSystemKey: true });
    registerFakeModule("xai", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["qwen/qwen3.8-max", "xai/grok-4"],
      orgRows: [
        { ...healthRow("qwen", "error"), updatedAt: "not-a-date" },
        healthRow("xai", "active"),
      ],
    });

    const r = await catalog.resolveDispatchModel(
      "agent-1",
      "org-1",
      "qwen/qwen3.8-max"
    );

    expect(r.model).toBe("qwen/qwen3.8-max");
    expect(r.replaced).toBe(false);
  });

  test("with no org-provider reader at all, dispatch stays health-blind", async () => {
    // Health is read from the rows getModelPolicy already loads, so there is no
    // separate health query that could fail on its own. An orgless caller (no
    // reader injected) simply gets the pre-existing routability-only ordering.
    registerFakeModule("qwen", "openai", { hasSystemKey: true });
    registerFakeModule("xai", "openai", { hasSystemKey: true });
    const catalog = makeCatalog({
      models: ["qwen/qwen3.8-max", "xai/grok-4"],
      withOrgReader: false,
    });

    const r = await catalog.resolveDispatchModel(
      "agent-1",
      "org-1",
      "qwen/qwen3.8-max"
    );

    expect(r.model).toBe("qwen/qwen3.8-max");
    expect(r.replaced).toBe(false);
  });
});
