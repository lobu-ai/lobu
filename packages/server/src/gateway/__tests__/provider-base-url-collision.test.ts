import { describe, expect, test } from "bun:test";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { ChatGPTOAuthModule } from "../auth/chatgpt/chatgpt-oauth-module.js";
import { detectProviderBaseUrlCollisions } from "../orchestration/deployment-manager.js";

/**
 * Regression: the `chatgpt` (Codex, chatgpt.com/backend-api) provider once
 * declared `baseUrlEnvVarName: "OPENAI_BASE_URL"` — the SAME key the
 * sdkCompat:"openai" provider (api.openai.com) emits for the OpenAI SDK. When
 * both were installed on an agent, the unguarded `Object.assign` merge in
 * deployment-manager let the codex value clobber OPENAI_BASE_URL, so an
 * `openai/<model>` request egressed to chatgpt.com/backend-api and 403'd
 * (no ChatGPT session on a fresh install). Each provider MUST own a distinct
 * base-URL env key so the merge can never mis-route.
 */
describe("provider base-URL env key collision", () => {
  const PROXY = "http://gateway:8080/api/proxy";

  const openaiModule = () =>
    new ApiKeyProviderModule({
      providerId: "openai",
      providerDisplayName: "OpenAI",
      providerIconUrl: "",
      envVarName: "OPENAI_API_KEY",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "sk-...",
      slug: "openai",
      upstreamBaseUrl: "https://api.openai.com/v1",
      sdkCompat: "openai",
      // Module never touches the manager for base-URL mapping.
      authProfilesManager: {} as never,
    });
  const codexModule = () => new ChatGPTOAuthModule({} as never);

  // A second sdkCompat:"openai" provider — representative of groq/gemini/z-ai/etc.
  const groqModule = () =>
    new ApiKeyProviderModule({
      providerId: "groq",
      providerDisplayName: "Groq",
      providerIconUrl: "",
      envVarName: "GROQ_API_KEY",
      apiKeyInstructions: "",
      apiKeyPlaceholder: "gsk-...",
      slug: "groq",
      upstreamBaseUrl: "https://api.groq.com/openai/v1",
      sdkCompat: "openai",
      authProfilesManager: {} as never,
    });

  test("openai and chatgpt(codex) do not share any base-URL env key", () => {
    const openaiKeys = Object.keys(
      openaiModule().getProxyBaseUrlMappings(PROXY, "a1")
    );
    const codexKeys = Object.keys(
      codexModule().getProxyBaseUrlMappings(PROXY, "a1")
    );
    const shared = openaiKeys.filter((k) => codexKeys.includes(k));
    // Before the fix this was ["OPENAI_BASE_URL"] — a guaranteed clobber.
    expect(shared).toEqual([]);
  });

  test("codex routes under its own key; the OpenAI SDK key stays on openai", () => {
    const codexMap = codexModule().getProxyBaseUrlMappings(PROXY, "a1");
    // The OpenAI SDK reads OPENAI_BASE_URL — the codex provider must NOT claim it.
    expect(codexMap.OPENAI_BASE_URL).toBeUndefined();
    expect(codexMap.OPENAI_CODEX_BASE_URL).toBeDefined();
    expect(codexMap.OPENAI_CODEX_BASE_URL).toContain("openai-codex");

    const openaiMap = openaiModule().getProxyBaseUrlMappings(PROXY, "a1");
    // The plain OpenAI provider owns OPENAI_BASE_URL, routed to its own slug.
    expect(openaiMap.OPENAI_BASE_URL).toBeDefined();
    expect(openaiMap.OPENAI_BASE_URL).not.toContain("openai-codex");
  });

  test("only the literal openai provider claims OPENAI_BASE_URL; other sdkCompat providers use their own key", () => {
    // The general form of the bug: EVERY sdkCompat:"openai" provider used to
    // emit OPENAI_BASE_URL, so co-installing openai with any of them (groq,
    // gemini, z-ai, …) let the last-merged one clobber it and an openai/<model>
    // request egressed to the wrong slug. Only `openai` may own OPENAI_BASE_URL.
    const openaiMap = openaiModule().getProxyBaseUrlMappings(PROXY, "a1");
    const groqMap = groqModule().getProxyBaseUrlMappings(PROXY, "a1");

    expect(openaiMap.OPENAI_BASE_URL).toBeDefined();
    // groq must NOT emit OPENAI_BASE_URL — it resolves via its own key.
    expect(groqMap.OPENAI_BASE_URL).toBeUndefined();
    expect(Object.keys(groqMap).some((k) => k.includes("GROQ"))).toBe(true);
    // No base-URL env key is shared between the two providers.
    const shared = Object.keys(openaiMap).filter((k) =>
      Object.keys(groqMap).includes(k)
    );
    expect(shared).toEqual([]);
  });
});

describe("detectProviderBaseUrlCollisions (deploy-time merge guard)", () => {
  test("flags two providers claiming the same key with different URLs", () => {
    const collisions = detectProviderBaseUrlCollisions([
      { providerId: "openai", mappings: { OPENAI_BASE_URL: "http://gw/openai" } },
      { providerId: "groq", mappings: { OPENAI_BASE_URL: "http://gw/groq" } },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      key: "OPENAI_BASE_URL",
      providerId: "groq",
      existing: "http://gw/openai",
      incoming: "http://gw/groq",
    });
  });

  test("does not flag distinct keys (the fixed state)", () => {
    const collisions = detectProviderBaseUrlCollisions([
      { providerId: "openai", mappings: { OPENAI_BASE_URL: "http://gw/openai" } },
      {
        providerId: "chatgpt",
        mappings: { OPENAI_CODEX_BASE_URL: "http://gw/openai-codex" },
      },
      { providerId: "groq", mappings: { GROQ_API_BASE_URL: "http://gw/groq" } },
    ]);
    expect(collisions).toEqual([]);
  });

  test("same key with the SAME value is not a collision (idempotent)", () => {
    const collisions = detectProviderBaseUrlCollisions([
      { providerId: "a", mappings: { K: "http://gw/x" } },
      { providerId: "b", mappings: { K: "http://gw/x" } },
    ]);
    expect(collisions).toEqual([]);
  });
});
