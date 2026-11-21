import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import { ApiKeyProviderModule } from "../../gateway/auth/api-key-provider-module";
import { collectProviderModelOptions } from "../../gateway/auth/provider-model-options";
import { resolveSystemKeyProvidersAndModel } from "../system-provider-resolution";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src/auth/__tests__ → repo root.
const PROVIDERS_JSON = path.resolve(
  HERE,
  "../../../../../config/providers.json"
);

function clearRegistry(): void {
  (
    moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
  ).modules = new Map();
}

/**
 * A fake system-key provider module whose concrete default comes ONLY from live
 * getModelOptions (no providers.json entry) — the Bedrock shape. #9: such a
 * provider must still make it into the resolved models list, not be skipped.
 */
function registerLiveOnlySystemKeyModule(
  providerId: string,
  liveModelId: string
): void {
  moduleRegistry.register({
    name: `${providerId}-provider`,
    isEnabled: () => true,
    providerId,
    providerDisplayName: providerId,
    providerIconUrl: "",
    authType: "api-key",
    sdkCompat: "openai",
    hasSystemKey: () => true,
    getSecretEnvVarNames: () => [],
    getModelOptions: async () => [{ value: `${providerId}/${liveModelId}` }],
  } as unknown as ModuleInterface);
}

/**
 * A fake system-key module that resolves NO concrete model (no providers.json
 * entry, no live options). #3(c): it must become a `<slug>/__unresolved__`
 * restriction sentinel, NOT be dropped (which would let the list collapse to
 * `[]` = allow-all when it is the only provider).
 */
function registerUnresolvableSystemKeyModule(providerId: string): void {
  moduleRegistry.register({
    name: `${providerId}-provider`,
    isEnabled: () => true,
    providerId,
    providerDisplayName: providerId,
    providerIconUrl: "",
    authType: "api-key",
    sdkCompat: "openai",
    hasSystemKey: () => true,
    getSecretEnvVarNames: () => [],
    getModelOptions: async () => [],
  } as unknown as ModuleInterface);
}

describe("resolveSystemKeyProvidersAndModel (#9 — every system-key provider resolves)", () => {
  const prevRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;
  const prevOpenAI = process.env.OPENAI_API_KEY;
  const CLAUDE_ENV = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const savedClaude: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await access(PROVIDERS_JSON);
    process.env.LOBU_PROVIDER_REGISTRY_PATH = PROVIDERS_JSON;
    process.env.OPENAI_API_KEY = "sk-test-system-resolution";
    // Hermetic: clear ambient Claude keys so openai is the config default.
    for (const v of CLAUDE_ENV) {
      savedClaude[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => clearRegistry());

  afterAll(() => {
    if (prevRegistryPath === undefined)
      delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
    else process.env.LOBU_PROVIDER_REGISTRY_PATH = prevRegistryPath;
    if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAI;
    for (const [k, v] of Object.entries(savedClaude)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a system-key provider whose model is live-only (Bedrock-shape) appears alongside openai", async () => {
    // openai resolves via providers.json (system key set); the fake provider has
    // NO providers.json entry — its only concrete model is a live option.
    registerLiveOnlySystemKeyModule("amazon-bedrock", "amazon.nova-lite-v1:0");

    const { models } = await resolveSystemKeyProvidersAndModel();
    const slugs = models.map((ref) => ref.slice(0, ref.indexOf("/")));

    // openai (config default) is present…
    expect(slugs).toContain("openai");
    // …and the live-only system-key provider is NOT dropped.
    expect(slugs).toContain("amazon-bedrock");
    // Its concrete ref came from live options, never `<slug>/auto`.
    expect(models).toContain("amazon-bedrock/amazon.nova-lite-v1:0");
    expect(models.every((ref) => !ref.endsWith("/auto"))).toBe(true);
  });

  test("Gemini discovery options never become implicit system defaults", async () => {
    class GeminiWithModels extends ApiKeyProviderModule {
      override hasSystemKey() {
        return true;
      }

      override async getModelOptions() {
        return [{
          value: "gemini/preview-fixture",
          label: "Specialist model fixture",
        }];
      }
    }
    moduleRegistry.register(new GeminiWithModels({
      providerId: "gemini",
      providerDisplayName: "Gemini",
      providerIconUrl: "",
      envVarName: "GEMINI_API_KEY",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "",
      modelsEndpoint: "/models",
      authProfilesManager: {} as never,
    }));
    const { models } = await resolveSystemKeyProvidersAndModel();
    expect(models.filter((ref) => ref.startsWith("gemini/"))).toEqual([
      "gemini/__unresolved__",
    ]);
    const discovery = await collectProviderModelOptions("fixture-agent", "fixture-user");
    expect(discovery.gemini?.map(({ value }) => value)).toEqual(["gemini/preview-fixture"]);
  });

  test("#3(c): a system-key provider with NO resolvable model becomes a sentinel (not dropped)", () => {
    // openai resolves concretely; the unresolvable provider must be KEPT as a
    // `<slug>/__unresolved__` sentinel so the list never collapses toward
    // allow-all when a provider is present but nothing resolved.
    registerUnresolvableSystemKeyModule("noconcrete");

    return resolveSystemKeyProvidersAndModel().then(({ models }) => {
      expect(models).toContain("noconcrete/__unresolved__");
      // openai still resolves its real model.
      expect(models.some((r) => r.startsWith("openai/") && r !== "openai/__unresolved__")).toBe(
        true
      );
    });
  });

  test("#4: a catalog default that is ALREADY slug-qualified is NOT double-prefixed", async () => {
    // nvidia's providers.json defaultModel is `nvidia/moonshotai/kimi-k2.6`
    // (already slug-qualified). Provisioning must emit it verbatim, never
    // `nvidia/nvidia/moonshotai/…`.
    const prevNvidia = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-test";
    try {
      const { models } = await resolveSystemKeyProvidersAndModel();
      const nvidiaRefs = models.filter((r) => r.startsWith("nvidia/"));
      expect(nvidiaRefs.length).toBeGreaterThan(0);
      expect(nvidiaRefs).toContain("nvidia/moonshotai/kimi-k2.6");
      expect(nvidiaRefs.every((r) => !r.startsWith("nvidia/nvidia/"))).toBe(true);
    } finally {
      if (prevNvidia === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = prevNvidia;
    }
  });
});
