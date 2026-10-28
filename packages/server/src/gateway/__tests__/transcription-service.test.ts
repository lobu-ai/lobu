import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProviderConfigEntry } from "@lobu/core";
import {
  ProviderHttpError,
  TranscriptionService,
} from "../services/transcription-service.js";

const openAiProviderConfig = (): Record<string, ProviderConfigEntry> => ({
  openai: {
    displayName: "OpenAI",
    iconUrl: "https://example.com/icon.png",
    envVarName: "OPENAI_API_KEY",
    upstreamBaseUrl: "https://api.openai.com/v1",
    apiKeyInstructions: "x",
    apiKeyPlaceholder: "x",
    sdkCompat: "openai",
    modalities: ["text", "stt"],
    stt: {
      enabled: true,
      transcriptionPath: "/audio/transcriptions",
      model: "gpt-transcribe",
    },
  },
});

describe("TranscriptionService provider selection", () => {
  afterEach(() => {
    mock.restore();
  });

  test("carries the upstream HTTP status per attempt, not just in the message", async () => {
    // The status must survive as a FIELD. `provider-health-status.ts` is
    // status-only precisely because matching provider wording missed OpenAI's
    // "no credits remaining" in prod — so a caller must never have to parse
    // the sentence to learn this was a 429.
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) =>
        providerId === "chatgpt" ? { credential: "openai-key" } : null
      ),
    } as any;
    const service = new TranscriptionService(authProfilesManager);
    (service as any).transcribeWithProvider = mock(async () => {
      throw new ProviderHttpError(
        429,
        'OpenAI API error: 429 - {"code":"credit_balance_exhausted"}'
      );
    });

    const result = await service.transcribe(
      Buffer.from("audio"),
      "agent-429",
      "audio/ogg"
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts?.[0]?.status).toBe(429);
      expect(result.attempts?.[0]?.providerSlug).toBe("chatgpt");
    }
  });

  test("does not send a differently-kinded org credential to the catalog endpoint", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async () => null),
    } as any;
    const providerConfigSource = mock(async () => openAiProviderConfig());
    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );
    service.setInferenceProviderCredentialSource(
      mock(async () => ({ kind: "gemini", apiKey: "gemini-key" }))
    );

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("a Gemini credential must not be sent to OpenAI");
    });
    globalThis.fetch = fetchMock as any;

    try {
      const result = await service.transcribe(
        Buffer.from("audio"),
        "agent-credential-boundary",
        "audio/m4a"
      );
      expect(result).toEqual({
        error: "No transcription provider configured",
        availableProviders: ["openai"],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does NOT treat an OpenAI-compatible provider as STT when it declares no stt modality", async () => {
    // OpenRouter (and Cerebras, z.ai, Mistral, …) speak the OpenAI chat protocol
    // but have no /audio/transcriptions endpoint. Previously STT defaulted ON for
    // every openai-compatible provider, so these were wrongly listed as
    // transcription candidates and 404'd. With no `stt` in modalities and no `stt`
    // block, the provider must be skipped and fetch never called.
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) => {
        if (providerId === "openrouter") {
          return { credential: "or-key" };
        }
        return null;
      }),
    } as any;

    const providerConfigSource = mock(async () => ({
      openrouter: {
        displayName: "OpenRouter",
        iconUrl: "https://example.com/icon.png",
        envVarName: "OPENROUTER_API_KEY",
        upstreamBaseUrl: "https://openrouter.ai/api/v1",
        apiKeyInstructions: "x",
        apiKeyPlaceholder: "x",
        sdkCompat: "openai",
        modalities: ["text"],
      },
    }));

    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("fetch should not be called for a non-STT provider");
    });
    globalThis.fetch = fetchMock as any;

    try {
      const result = await service.transcribe(
        Buffer.from("audio"),
        "agent-4",
        "audio/ogg"
      );
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("No transcription provider configured");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects stt.enabled=false for config-driven providers", async () => {
    const authProfilesManager = {
      getBestProfile: mock(async (_agentId: string, providerId: string) => {
        if (providerId === "openrouter") {
          return { credential: "or-key" };
        }
        return null;
      }),
    } as any;

    const providerConfigSource = mock(async () => ({
      openrouter: {
        displayName: "OpenRouter",
        iconUrl: "https://example.com/icon.png",
        envVarName: "OPENROUTER_API_KEY",
        upstreamBaseUrl: "https://openrouter.ai/api/v1",
        apiKeyInstructions: "x",
        apiKeyPlaceholder: "x",
        sdkCompat: "openai",
        stt: {
          enabled: false,
        },
      },
    }));

    const service = new TranscriptionService(
      authProfilesManager,
      providerConfigSource
    );

    const result = await service.transcribe(
      Buffer.from("audio"),
      "agent-5",
      "audio/ogg"
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("No transcription provider configured");
    }
  });
});
