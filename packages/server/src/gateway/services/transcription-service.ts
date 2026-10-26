/**
 * Multi-Provider Audio Service
 *
 * Supports speech-to-text and text-to-speech via auth profiles (installed providers):
 * - OpenAI (chatgpt auth profile) - Whisper for STT, TTS API for speech
 *
 * STT selection: the OpenAI built-in plus optional config-driven
 * OpenAI-compatible STT providers declared in system-skills provider config
 * (Groq etc. — any provider with an OpenAI-shaped /audio/transcriptions).
 * TTS selection stays built-in only (OpenAI).
 */

import type { ProviderConfigEntry } from "@lobu/core";
import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import type {
  InferenceProviderConfigSource,
  InferenceProviderCredentialSource,
  ResolvedInferenceProvider,
} from "./inference-provider-source.js";

const logger = createLogger("transcription-service");

// Static defaults for the OpenAI TTS path. An org `inference_providers` row
// with a `capabilities.tts` block overrides these (base_url → URL, model →
// model); an absent block ⇒ these exact values, so existing orgs are
// byte-identical at cutover.
const OPENAI_TTS_DEFAULT_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_DEFAULT_MODEL = "tts-1";

// Every provider call carries an abort timeout: a hung upstream otherwise
// pins the request (and its DB pool connection) indefinitely — none of these
// fetches had a signal before. 120s matches the worker-side budget for
// generate_image/generate_audio; audio payloads can be large, so don't trim
// this without checking real STT latencies.
const PROVIDER_FETCH_TIMEOUT_MS = Number(
  process.env.TRANSCRIPTION_FETCH_TIMEOUT_MS ?? 120_000
);

type TranscriptionProvider = "openai";

interface TranscriptionConfig {
  profileProviderId: string;
  displayName: string;
  provider: TranscriptionProvider;
  apiKey: string;
  openaiCompat?: {
    endpointUrl: string;
    model: string;
  };
  /** OpenAI-compatible TTS override (org `capabilities.tts` base_url/model). */
  ttsCompat?: {
    endpointUrl: string;
    model: string;
  };
}

interface TranscriptionSuccess {
  text: string;
  provider: TranscriptionProvider;
  /**
   * `inference_providers.slug` of the row that served this transcription, so
   * the caller can clear a health error THIS path set. Without it an
   * STT-only slug marked `error` here could never be cleared: the only other
   * writer is the LLM proxy, which such a slug never sees.
   */
  providerSlug: string;
}

/**
 * An upstream provider call that failed with an HTTP status.
 *
 * The status is carried as a FIELD, never only in the message. Flattening it
 * into prose is what made `provider-health-status.ts` status-only in the first
 * place: OpenAI's "no credits remaining" and Alibaba's "quota has been
 * exhausted" both went unclassified in prod when the code matched wording.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** One provider's failed attempt, with the status a health verdict needs. */
export interface TranscriptionAttemptFailure {
  /** `inference_providers.slug` — the row a health writeback targets. */
  providerSlug: string;
  /** Upstream HTTP status, absent when the call never reached the provider. */
  status?: number;
  message: string;
}

interface TranscriptionError {
  error: string;
  availableProviders: TranscriptionProvider[];
  /**
   * Per-provider failures, so a caller that knows the organization can record
   * provider health. Absent when no provider was configured at all.
   */
  attempts?: TranscriptionAttemptFailure[];
}

type TranscriptionResult = TranscriptionSuccess | TranscriptionError;

interface SynthesisSuccess {
  audioBuffer: Buffer;
  mimeType: string;
  provider: TranscriptionProvider;
}

interface SynthesisError {
  error: string;
  availableProviders: TranscriptionProvider[];
  /**
   * The provider was called and the call failed: audio may have been
   * synthesized (and billed) even though none came back. Absent when the
   * request never left, e.g. no provider is configured.
   */
  dispatched?: true;
}

type SynthesisResult = SynthesisSuccess | SynthesisError;

// Voice options for TTS
interface VoiceOptions {
  voice?: string; // Provider-specific voice ID
  speed?: number; // Speech speed (0.5-2.0, default 1.0)
}

// Auth profile providerId → TTS provider mapping (single source of truth)
const TTS_CAPABLE_PROVIDERS: {
  profileProviderId: string;
  ttsProvider: TranscriptionProvider;
  displayName: string;
}[] = [
  {
    profileProviderId: "chatgpt",
    ttsProvider: "openai",
    displayName: "OpenAI",
  },
];

function displayName(provider: TranscriptionProvider): string {
  return (
    TTS_CAPABLE_PROVIDERS.find((p) => p.ttsProvider === provider)
      ?.displayName ?? provider
  );
}

export class TranscriptionService {
  private providerConfigSource?:
    | (() => Promise<Record<string, ProviderConfigEntry>>)
    | undefined;
  private inferenceProviderSource?: InferenceProviderConfigSource | undefined;
  private inferenceProviderCredentialSource?:
    | InferenceProviderCredentialSource
    | undefined;

  constructor(
    private readonly authProfilesManager: AuthProfilesManager,
    providerConfigSource?: () => Promise<Record<string, ProviderConfigEntry>>,
    inferenceProviderSource?: InferenceProviderConfigSource
  ) {
    this.providerConfigSource = providerConfigSource;
    this.inferenceProviderSource = inferenceProviderSource;
  }

  setProviderConfigSource(
    source: () => Promise<Record<string, ProviderConfigEntry>>
  ): void {
    this.providerConfigSource = source;
  }

  setInferenceProviderSource(source: InferenceProviderConfigSource): void {
    this.inferenceProviderSource = source;
  }

  setInferenceProviderCredentialSource(
    source: InferenceProviderCredentialSource
  ): void {
    this.inferenceProviderCredentialSource = source;
  }

  /**
   * Transcribe audio buffer to text
   */
  async transcribe(
    audioBuffer: Buffer,
    agentId: string,
    mimeType = "audio/ogg"
  ): Promise<TranscriptionResult> {
    const configs = await this.getTranscriptionConfigs(agentId);

    if (configs.length === 0) {
      return this.noProviderError(
        "No transcription provider configured",
        agentId
      );
    }

    const attemptErrors: string[] = [];
    const attempts: TranscriptionAttemptFailure[] = [];
    for (const config of configs) {
      logger.info("Transcribing audio", {
        agentId,
        provider: config.provider,
        profileProviderId: config.profileProviderId,
        bufferSize: audioBuffer.length,
        mimeType,
      });

      try {
        const text = await this.transcribeWithProvider(
          audioBuffer,
          config,
          mimeType
        );
        logger.info("Transcription successful", {
          agentId,
          provider: config.provider,
          profileProviderId: config.profileProviderId,
          textLength: text.length,
        });
        return {
          text,
          provider: config.provider,
          providerSlug: config.profileProviderId,
        };
      } catch (error) {
        const errorMessage =
          getErrorMessage(error);
        const status =
          error instanceof ProviderHttpError ? error.status : undefined;
        logger.error("Transcription failed", {
          agentId,
          provider: config.provider,
          profileProviderId: config.profileProviderId,
          status,
          error: errorMessage,
        });
        attemptErrors.push(`${config.displayName}: ${errorMessage}`);
        attempts.push({
          providerSlug: config.profileProviderId,
          status,
          message: errorMessage,
        });
      }
    }

    return {
      error: `Transcription failed with all configured providers: ${attemptErrors.join(" | ")}`,
      availableProviders: [...new Set(configs.map((c) => c.provider))],
      attempts,
    };
  }

  /**
   * Get transcription config for an agent by checking installed auth profiles.
   * First TTS-capable provider with a valid profile wins (OpenAI only).
   */
  async getConfig(agentId: string): Promise<TranscriptionConfig | null> {
    const configs = await this.getTranscriptionConfigs(agentId);
    return configs[0] ?? null;
  }

  private async getSynthesisConfigs(
    agentId: string
  ): Promise<TranscriptionConfig[]> {
    const configs: TranscriptionConfig[] = [];
    for (const { profileProviderId, ttsProvider } of TTS_CAPABLE_PROVIDERS) {
      // Only the OpenAI TTS path supports a custom upstream. Read the org
      // `inference_providers` row once → key + capabilities.tts (base_url/model)
      // together; when present, use the org key (honors the URL invariant).
      const orgTts =
        ttsProvider === "openai"
          ? await this.getConfigDrivenTtsCandidate(agentId, profileProviderId)
          : null;

      const profile = orgTts
        ? undefined
        : await this.authProfilesManager.getBestProfile(
            agentId,
            profileProviderId
          );

      const apiKey = orgTts?.apiKey ?? profile?.credential;
      if (!apiKey) continue;

      configs.push({
        profileProviderId,
        displayName: displayName(ttsProvider),
        provider: ttsProvider,
        apiKey,
        ttsCompat: orgTts
          ? {
              endpointUrl: orgTts.baseUrl ?? OPENAI_TTS_DEFAULT_URL,
              model: orgTts.model ?? OPENAI_TTS_DEFAULT_MODEL,
            }
          : undefined,
      });
    }
    return configs;
  }

  /**
   * Resolve the org `inference_providers` row's `capabilities.tts` for this
   * agent + provider slug (one read → key + base_url + model together). Returns
   * null when no row/block exists ⇒ static OpenAI TTS fallback. Mirrors
   * {@link getConfigDrivenSttCandidates}.
   */
  private async getConfigDrivenTtsCandidate(
    agentId: string,
    profileProviderId: string
  ): Promise<{ apiKey: string; baseUrl?: string; model?: string } | null> {
    if (!this.inferenceProviderSource) return null;
    const resolved = await this.inferenceProviderSource(
      agentId,
      profileProviderId,
      "tts"
    );
    if (!resolved) return null;
    return {
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      model: resolved.model,
    };
  }

  private async getTranscriptionConfigs(
    agentId: string
  ): Promise<TranscriptionConfig[]> {
    const configs = await this.getSynthesisConfigs(agentId);
    const providerIds = new Set(configs.map((c) => c.profileProviderId));
    const configDriven = await this.getConfigDrivenSttCandidates(agentId);

    for (const candidate of configDriven) {
      if (providerIds.has(candidate.profileProviderId)) continue;

      // The org `inference_providers` row (when present) supplies BOTH the key
      // and the base_url/model in the candidate — single read, so honor its key.
      // Otherwise fall back to the per-user auth profile for the credential.
      let apiKey = candidate.orgApiKey;
      if (!apiKey) {
        const profile = await this.authProfilesManager.getBestProfile(
          agentId,
          candidate.profileProviderId
        );
        if (!profile?.credential) continue;
        apiKey = profile.credential;
      }

      configs.push({
        profileProviderId: candidate.profileProviderId,
        displayName: candidate.displayName,
        provider: candidate.provider,
        apiKey,
        openaiCompat: candidate.openaiCompat,
      });
      providerIds.add(candidate.profileProviderId);
    }

    return configs;
  }

  private async getConfigDrivenSttCandidates(
    agentId: string
  ): Promise<
    Array<Omit<TranscriptionConfig, "apiKey"> & { orgApiKey?: string }>
  > {
    if (!this.providerConfigSource) return [];

    let providerConfigs: Record<string, ProviderConfigEntry>;
    try {
      providerConfigs = await this.providerConfigSource();
    } catch (error) {
      logger.warn("Failed to load provider configs for STT", {
        error: getErrorMessage(error),
      });
      return [];
    }

    const candidates: Array<
      Omit<TranscriptionConfig, "apiKey"> & { orgApiKey?: string }
    > = [];
    for (const [providerId, entry] of Object.entries(providerConfigs)) {
      const stt = entry.stt;
      const compat = stt?.sdkCompat || entry.sdkCompat;
      // STT is only offered for providers that declare it. Historically this
      // defaulted ON for every OpenAI-compatible provider, which wrongly listed
      // text-only chat providers (Cerebras, Mistral, …) as transcription
      // candidates — they have no /audio/transcriptions endpoint and 404. Gate
      // on the provider's declared modalities; an explicit `stt` block (with
      // enabled !== false) still counts as declaring STT.
      const declaresStt =
        entry.modalities?.includes("stt") ??
        (stt ? stt.enabled !== false : false);
      const sttEnabled = stt ? stt.enabled !== false : declaresStt;
      if (!sttEnabled) continue;

      if (compat !== "openai") {
        logger.warn("Unsupported config-driven STT compatibility", {
          providerId,
          compat,
        });
        continue;
      }

      // Prefer the org `inference_providers` row's capabilities.stt when
      // present (one read → key + base_url + model + models_endpoint), else the
      // providers.json `stt` block, else the static OpenAI default. Field names
      // map 1:1 (base_url→baseUrl, models_endpoint→transcriptionPath, model).
      // Unlike a custom per-modality config lookup, the credential source also
      // returns the org row's key when `capabilities.stt` is absent. Reaching
      // this point already proved the provider catalog declares STT, so using
      // its trusted endpoint/model defaults is safe and avoids requiring a
      // duplicate per-user OpenAI profile.
      let orgStt: ResolvedInferenceProvider | null = null;
      if (this.inferenceProviderCredentialSource) {
        const credential = await this.inferenceProviderCredentialSource(
          agentId,
          providerId,
          "stt"
        );
        if (credential?.kind === providerId) {
          orgStt = credential;
        } else if (credential) {
          logger.warn("Ignoring mismatched STT provider credential", {
            providerId,
            credentialKind: credential.kind,
          });
        }
      } else if (this.inferenceProviderSource) {
        orgStt = await this.inferenceProviderSource(
          agentId,
          providerId,
          "stt"
        );
      }

      const baseUrl =
        orgStt?.baseUrl || stt?.baseUrl || entry.upstreamBaseUrl;
      const transcriptionPath =
        orgStt?.modelsEndpoint || stt?.transcriptionPath;
      const model =
        orgStt?.model?.trim() || stt?.model?.trim() || "whisper-1";

      const endpoint = this.resolveEndpointUrl(transcriptionPath, baseUrl);
      if (!endpoint) {
        logger.warn("Invalid STT endpoint configuration", {
          providerId,
          transcriptionPath,
          baseUrl,
        });
        continue;
      }

      candidates.push({
        profileProviderId: providerId,
        displayName: entry.displayName || providerId,
        provider: "openai",
        openaiCompat: {
          endpointUrl: endpoint,
          model,
        },
        orgApiKey: orgStt?.apiKey,
      });
    }
    return candidates;
  }

  /**
   * Get provider info for documentation/help messages
   */
  getProviderInfo(): Array<{ provider: TranscriptionProvider; name: string }> {
    return TTS_CAPABLE_PROVIDERS.map(({ ttsProvider, displayName }) => ({
      provider: ttsProvider,
      name: displayName,
    }));
  }

  // ==========================================================================
  // Text-to-Speech (Synthesis)
  // ==========================================================================

  /**
   * Synthesize text to audio
   */
  async synthesize(
    text: string,
    agentId: string,
    options: VoiceOptions = {}
  ): Promise<SynthesisResult> {
    const config = await this.getConfig(agentId);

    if (!config) {
      return this.noProviderError("No audio provider configured", agentId);
    }

    logger.info("Synthesizing audio", {
      agentId,
      provider: config.provider,
      textLength: text.length,
      voice: options.voice,
    });

    try {
      const result = await this.synthesizeWithProvider(text, config, options);
      logger.info("Synthesis successful", {
        agentId,
        provider: config.provider,
        audioSize: result.audioBuffer.length,
      });
      return { ...result, provider: config.provider };
    } catch (error) {
      const errorMessage =
        getErrorMessage(error);
      logger.error("Synthesis failed", {
        agentId,
        provider: config.provider,
        error: errorMessage,
      });
      return {
        error: `Synthesis failed with ${displayName(config.provider)}: ${errorMessage}`,
        availableProviders: [],
        dispatched: true,
      };
    }
  }

  private noProviderError(message: string, agentId: string) {
    const availableProviders = TTS_CAPABLE_PROVIDERS.map((p) => p.ttsProvider);
    logger.info(message, { agentId, availableProviders });
    return { error: message, availableProviders };
  }

  // ==========================================================================
  // Provider-specific implementations - Transcription (STT)
  // ==========================================================================

  private async transcribeWithProvider(
    buffer: Buffer,
    config: TranscriptionConfig,
    mimeType: string
  ): Promise<string> {
    switch (config.provider) {
      case "openai":
        return this.transcribeWithOpenAI(
          buffer,
          config.apiKey,
          mimeType,
          config.openaiCompat
        );
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  private async transcribeWithOpenAI(
    buffer: Buffer,
    apiKey: string,
    mimeType: string,
    options?: { endpointUrl: string; model: string }
  ): Promise<string> {
    const formData = new FormData();
    const ext = this.getExtensionFromMime(mimeType);
    formData.append(
      "file",
      new Blob([buffer], { type: mimeType }),
      `audio.${ext}`
    );
    formData.append("model", options?.model || "whisper-1");

    const resp = await fetch(
      options?.endpointUrl || "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      }
    );

    if (!resp.ok) {
      const error = await resp.text();
      throw new ProviderHttpError(
        resp.status,
        `OpenAI API error: ${resp.status} - ${error}`
      );
    }

    const data = (await resp.json()) as { text: string };
    return data.text;
  }

  // ==========================================================================
  // Provider-specific implementations - Synthesis (TTS)
  // ==========================================================================

  private async synthesizeWithProvider(
    text: string,
    config: TranscriptionConfig,
    options: VoiceOptions
  ): Promise<{ audioBuffer: Buffer; mimeType: string }> {
    switch (config.provider) {
      case "openai":
        return this.synthesizeWithOpenAI(text, config, options);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  private async synthesizeWithOpenAI(
    text: string,
    config: TranscriptionConfig,
    options: VoiceOptions
  ): Promise<{ audioBuffer: Buffer; mimeType: string }> {
    // OpenAI TTS API
    // Voices: alloy, echo, fable, onyx, nova, shimmer
    const voice = options.voice || "alloy";
    const speed = options.speed || 1.0;

    const resp = await fetch(
      config.ttsCompat?.endpointUrl || OPENAI_TTS_DEFAULT_URL,
      {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ttsCompat?.model || OPENAI_TTS_DEFAULT_MODEL,
        input: text,
        voice,
        speed,
        response_format: "opus", // Good for WhatsApp
      }),
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`OpenAI TTS API error: ${resp.status} - ${error}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return {
      audioBuffer: Buffer.from(arrayBuffer),
      mimeType: "audio/opus",
    };
  }

  // ==========================================================================
  // Utility methods
  // ==========================================================================

  private getExtensionFromMime(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      "audio/ogg": "ogg",
      "audio/opus": "opus",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/wav": "wav",
      "audio/webm": "webm",
      "audio/m4a": "m4a",
      "audio/mp4": "m4a",
    };
    return mimeToExt[mimeType] || "ogg";
  }

  private resolveEndpointUrl(
    transcriptionPath: string | undefined,
    baseUrl: string | undefined
  ): string | null {
    const path = (
      transcriptionPath || this.getDefaultOpenAiTranscriptionPath(baseUrl)
    ).trim();
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const base = (baseUrl || "").trim();
    if (!base) return null;

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${base.replace(/\/+$/, "")}${normalizedPath}`;
  }

  private getDefaultOpenAiTranscriptionPath(
    baseUrl: string | undefined
  ): string {
    const trimmedBase = (baseUrl || "").trim().replace(/\/+$/, "");
    if (trimmedBase.endsWith("/v1")) {
      return "/audio/transcriptions";
    }
    return "/v1/audio/transcriptions";
  }
}
