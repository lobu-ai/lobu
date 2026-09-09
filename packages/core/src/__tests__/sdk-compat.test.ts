import { describe, expect, test } from "bun:test";
import {
  isSdkCompat,
  resolveSdkCompat,
  SDK_COMPAT_PROTOCOLS,
} from "../sdk-compat";

describe("sdk-compat registry", () => {
  test("openai maps to the openai-completions adapter", () => {
    const p = resolveSdkCompat("openai");
    expect(p?.api).toBe("openai-completions");
    expect(p?.registryAlias).toBe("openai");
    // OpenAI-compatible keys ride as Bearer (no explicit header).
    expect(p?.apiKeyHeader).toBeUndefined();
  });

  test("anthropic maps to anthropic-messages with x-api-key", () => {
    const p = resolveSdkCompat("anthropic");
    expect(p?.api).toBe("anthropic-messages");
    expect(p?.registryAlias).toBe("anthropic");
    // Anthropic 401s on Bearer — the key must ride in x-api-key.
    expect(p?.apiKeyHeader).toBe("x-api-key");
  });

  test("isSdkCompat gates routable protocols", () => {
    expect(isSdkCompat("openai")).toBe(true);
    expect(isSdkCompat("openai-responses")).toBe(true);
    expect(isSdkCompat("anthropic")).toBe(true);
    // Not routable:
    expect(isSdkCompat(null)).toBe(false);
    expect(isSdkCompat(undefined)).toBe(false);
    expect(isSdkCompat("made-up")).toBe(false);
  });

  test("rejects a protocol no turn can execute, at CONFIGURATION time", () => {
    // These three were routable per this gate and unrunnable in the isolate:
    // their pi-ai adapters need Node-bound SDKs (AWS SigV4, `@google/genai`,
    // `@mistralai/mistralai`), which do not bundle into the guest. A config
    // declaring one passed here and then failed at turn time reporting
    // NO_MODEL_CONFIGURED — sending the user to look for a missing setting
    // when the protocol was the problem.
    //
    // These vendors are still supported; they are reached by translating
    // server-side and offering an OpenAI-compatible endpoint, which is what
    // `BedrockOpenAIService` does for Bedrock.
    for (const unrunnable of ["google", "bedrock", "mistral"]) {
      expect(isSdkCompat(unrunnable), unrunnable).toBe(false);
      expect(resolveSdkCompat(unrunnable), unrunnable).toBeNull();
    }
  });

  test("every routable protocol is one a turn envelope can carry", () => {
    // The isolate lane admits exactly these three adapters (`LANE_APIS` in the
    // agent-turn producer). A row whose `api` is not among them cannot run, so
    // this is the invariant that keeps the table honest as it grows.
    const laneAdapters = new Set([
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ]);
    for (const [key, p] of Object.entries(SDK_COMPAT_PROTOCOLS)) {
      expect(laneAdapters.has(p.api), `${key} -> ${p.api}`).toBe(true);
    }
  });

  test("resolveSdkCompat returns null for unroutable input", () => {
    expect(resolveSdkCompat(null)).toBeNull();
    expect(resolveSdkCompat("nope")).toBeNull();
  });

  test("every protocol declares api, registryAlias, and label", () => {
    for (const [key, p] of Object.entries(SDK_COMPAT_PROTOCOLS)) {
      expect(p.api, `${key}.api`).toBeTruthy();
      expect(p.registryAlias, `${key}.registryAlias`).toBeTruthy();
      expect(p.label, `${key}.label`).toBeTruthy();
    }
  });
});
