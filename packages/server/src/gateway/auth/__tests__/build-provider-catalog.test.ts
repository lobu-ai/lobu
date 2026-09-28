import { beforeEach, describe, expect, test } from "bun:test";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import type { ProviderConfigEntry } from "@lobu/core";
import { ApiKeyProviderModule } from "../api-key-provider-module.js";
import { buildProviderCatalog } from "../provider-catalog.js";

/**
 * buildProviderCatalog is the single source both the org inference-providers
 * catalog route and the per-agent agent-config catalog map from. It must:
 *  - include OAuth modules (Claude/ChatGPT) with their auth metadata, so they
 *    appear in the "Add provider" catalog;
 *  - carry sdkCompat so the POST route can gate on routable protocols via
 *    isSdkCompat (openai, anthropic, google, …) — not only "openai". OAuth /
 *    subscription-only providers carry a null sdkCompat ⇒ rejected.
 *
 * The registry is a process-global singleton; these tests register minimal fake
 * modules and clear between cases to stay hermetic.
 */

function fakeModule(
  overrides: Partial<Record<string, unknown>> & { providerId: string }
): ModuleInterface {
  return {
    // Registry keys modules by `name` and only stores enabled ones.
    name: `${overrides.providerId}-provider`,
    isEnabled: () => true,
    // Fields buildProviderCatalog reads off the module.
    providerDisplayName: overrides.providerId,
    providerIconUrl: "",
    authType: "api-key",
    // Marks it as a ModelProviderModule for getModelProviderModules()'s filter.
    getSecretEnvVarNames: () => [],
    ...overrides,
  } as unknown as ModuleInterface;
}

function clearRegistry(): void {
  // No public clear(); reset the internal Map between tests.
  (
    moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
  ).modules = new Map();
}

describe("buildProviderCatalog", () => {
  beforeEach(() => clearRegistry());

  test("API-key modules supply the catalog protocol, default model, and base URL", () => {
    moduleRegistry.register(new ApiKeyProviderModule({
      providerId: "synthetic-compatible", providerDisplayName: "Synthetic", providerIconUrl: "",
      envVarName: "SYNTHETIC_API_KEY", upstreamBaseUrl: "https://provider.example.test/v1",
      sdkCompat: "openai", defaultModel: "private-model", authProfilesManager: {} as never,
    }));
    expect(buildProviderCatalog()[0]).toMatchObject({
      slug: "synthetic-compatible", sdkCompat: "openai", defaultModel: "private-model",
      baseUrl: "https://provider.example.test/v1",
    });
  });

  test("OAuth modules appear with their auth metadata and null sdkCompat", () => {
    moduleRegistry.register(
      fakeModule({
        providerId: "claude",
        providerDisplayName: "Claude",
        authType: "oauth",
        supportedAuthTypes: ["oauth", "api-key"],
      })
    );

    const catalog = buildProviderCatalog();
    const claude = catalog.find((e) => e.slug === "claude");
    expect(claude).toBeDefined();
    expect(claude?.authType).toBe("oauth");
    expect(claude?.supportedAuthTypes).toEqual(["oauth", "api-key"]);
    // No providers.json enrichment and no module metadata ⇒ not addable by key.
    expect(claude?.sdkCompat).toBeNull();
  });

  test("config enrichment sets sdkCompat/modalities for api-key providers", () => {
    moduleRegistry.register(
      fakeModule({ providerId: "groq", providerDisplayName: "Groq" })
    );
    const configs: Record<string, ProviderConfigEntry> = {
      groq: {
        displayName: "Groq",
        iconUrl: "https://icon/groq.png",
        envVarName: "GROQ_API_KEY",
        upstreamBaseUrl: "https://api.groq.com/openai/v1",
        apiKeyInstructions: "",
        apiKeyPlaceholder: "gsk_...",
        sdkCompat: "openai",
        modalities: ["text", "stt"],
        defaultModel: "llama-3.3-70b-versatile",
      },
    };

    const catalog = buildProviderCatalog(configs);
    const groq = catalog.find((e) => e.slug === "groq");
    expect(groq?.sdkCompat).toBe("openai");
    expect(groq?.modalities).toEqual(["text", "stt"]);
    expect(groq?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(groq?.defaultModel).toBe("llama-3.3-70b-versatile");
  });

  test("marks providers backed by a system credential as available", () => {
    moduleRegistry.register(
      fakeModule({
        providerId: "claude",
        providerDisplayName: "Claude",
        hasSystemKey: () => true,
      })
    );

    const claude = buildProviderCatalog().find((e) => e.slug === "claude");
    expect(claude?.systemAvailable).toBe(true);
  });

  test("supportedAuthTypes defaults to [authType] when absent", () => {
    moduleRegistry.register(fakeModule({ providerId: "cerebras" }));
    const catalog = buildProviderCatalog();
    const cerebras = catalog.find((e) => e.slug === "cerebras");
    expect(cerebras?.authType).toBe("api-key");
    expect(cerebras?.supportedAuthTypes).toEqual(["api-key"]);
    // No config ⇒ text-only default.
    expect(cerebras?.modalities).toEqual(["text"]);
  });

  test("catalogVisible === false hides a module", () => {
    moduleRegistry.register(
      fakeModule({ providerId: "hidden", catalogVisible: false })
    );
    const catalog = buildProviderCatalog();
    expect(catalog.find((e) => e.slug === "hidden")).toBeUndefined();
  });

  test("entries are sorted by slug", () => {
    moduleRegistry.register(fakeModule({ providerId: "zebra" }));
    moduleRegistry.register(fakeModule({ providerId: "alpha" }));
    const slugs = buildProviderCatalog().map((e) => e.slug);
    expect(slugs).toEqual(["alpha", "zebra"]);
  });
});
