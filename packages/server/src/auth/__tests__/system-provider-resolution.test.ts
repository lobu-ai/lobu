import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
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

/** A fake module-registry provider with a system-level credential. */
function registerSystemKeyModule(providerId: string): void {
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
  } as unknown as ModuleInterface);
}

describe("resolveSystemKeyProvidersAndModel", () => {
  const prevRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;
  const prevOpenAI = process.env.OPENAI_API_KEY;
  const prevDefault = process.env.AGENT_DEFAULT_MODEL;
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
    // Hermetic: clear ambient Claude keys so only the providers set here exist.
    for (const v of CLAUDE_ENV) {
      savedClaude[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    clearRegistry();
    delete process.env.AGENT_DEFAULT_MODEL;
  });

  afterAll(() => {
    if (prevRegistryPath === undefined)
      delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
    else process.env.LOBU_PROVIDER_REGISTRY_PATH = prevRegistryPath;
    if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAI;
    if (prevDefault === undefined) delete process.env.AGENT_DEFAULT_MODEL;
    else process.env.AGENT_DEFAULT_MODEL = prevDefault;
    for (const [k, v] of Object.entries(savedClaude)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("without AGENT_DEFAULT_MODEL every installed provider is a sentinel, never dropped", async () => {
    delete process.env.AGENT_DEFAULT_MODEL;
    registerSystemKeyModule("synthetic-provider");

    const { models } = await resolveSystemKeyProvidersAndModel();
    expect(models).toContain("openai/__unresolved__");
    expect(models).toContain("synthetic-provider/__unresolved__");
    expect(models.every((ref) => ref.endsWith("/__unresolved__"))).toBe(true);
  });

  test("AGENT_DEFAULT_MODEL is index 0 when its provider is installed", async () => {
    process.env.AGENT_DEFAULT_MODEL = "synthetic-provider/vendor/synthetic-model";
    registerSystemKeyModule("synthetic-provider");

    const { models } = await resolveSystemKeyProvidersAndModel();
    expect(models[0]).toBe("synthetic-provider/vendor/synthetic-model");
    expect(models).toContain("openai/__unresolved__");
    expect(models).not.toContain("synthetic-provider/__unresolved__");
  });

  test("AGENT_DEFAULT_MODEL for a provider not installed here is ignored", async () => {
    process.env.AGENT_DEFAULT_MODEL = "absent-provider/synthetic-model";

    const { models } = await resolveSystemKeyProvidersAndModel();
    expect(models.some((ref) => ref.startsWith("absent-provider/"))).toBe(false);
    expect(models).toContain("openai/__unresolved__");
  });
});
