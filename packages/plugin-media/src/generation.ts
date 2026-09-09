import {
  createGatewayClient,
  parseErrorBody,
  textResult,
  toolLogger as logger,
  withErrorHandling,
  type GatewayParams,
  type TextResult,
} from "@lobu/plugin-toolkit";
import { fetchAudioProviderSuggestions } from "./audio-provider-suggestions";
import { uploadGeneratedFile } from "./multipart";

// ============================================================================
// Shared driver: generate media → upload to the user
// ============================================================================

/**
 * Shared skeleton for `generate_image` / `generate_audio`: optional preflight
 * "is this configured?" check → POST the generate request → map `!ok` into one
 * of three operator-facing messages (provider-list / missing-scope / generic)
 * → read the binary body → upload it via `uploadGeneratedFile`. The two public
 * tools below are thin config objects over this; only the endpoint, preflight,
 * MIME→ext mapping, scope-substring match, and wording differ.
 */
async function generateAndUploadMedia(
  gw: GatewayParams,
  config: {
    label: string;
    logLine: string;
    /**
     * Pre-generation gate. Returns a `notConfigured` message to short-circuit
     * with, or `null` to proceed. Also exposes the resolved provider list so
     * the missing-scope branch can reference it.
     */
    preflight: () => Promise<{
      notConfigured: string | null;
      providerList: string;
    }>;
    endpoint: string;
    requestBody: Record<string, unknown>;
    /** Substring scan over the lowercased error message → missing-scope path. */
    missingScopeMatch: (lowerError: string) => boolean;
    extFromMime: (mimeType: string) => string;
    defaultMimeType: string;
    providerHeader: string;
    uploadFilename: (ext: string) => string;
    uploadHeaders?: Record<string, string>;
    messages: {
      providerListFailure: (errorMessage: string) => string;
      missingScopeFailure: (providerList: string) => string;
      genericFailure: (errorMessage: string) => string;
      success: (provider: string) => string;
      uploadLog: (provider: string) => string;
    };
  }
): Promise<TextResult> {
  return withErrorHandling(config.label, async () => {
    logger.info(config.logLine);

    const { notConfigured, providerList } = await config.preflight();
    if (notConfigured) {
      return textResult(notConfigured);
    }

    const response = await createGatewayClient({
      baseUrl: gw.gatewayUrl,
      token: gw.workerToken,
    }).request(config.endpoint, {
      method: "POST",
      body: JSON.stringify(config.requestBody),
      // Generation can take a while at high quality, but never minutes — cap
      // the wait so a stalled upstream provider doesn't hang the agent turn.
      timeoutMs: 120_000,
    });

    if (!response.ok) {
      const errorData = (await parseErrorBody(response)) as {
        error?: string;
        availableProviders?: string[];
      };
      const errorMessage = errorData.error || "Unknown error";
      const lowerError = errorMessage.toLowerCase();

      if (errorData.availableProviders?.length) {
        return textResult(config.messages.providerListFailure(errorMessage));
      }

      if (config.missingScopeMatch(lowerError)) {
        return textResult(config.messages.missingScopeFailure(providerList));
      }

      return textResult(config.messages.genericFailure(errorMessage));
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType =
      response.headers.get("Content-Type") || config.defaultMimeType;
    const provider = response.headers.get(config.providerHeader) || "unknown";
    const ext = config.extFromMime(mimeType);

    const uploadError = await uploadGeneratedFile(
      gw,
      bytes,
      config.uploadFilename(ext),
      mimeType,
      config.uploadHeaders
    );
    if (uploadError) return uploadError;

    logger.info(config.messages.uploadLog(provider));
    return textResult(config.messages.success(provider));
  });
}

// ============================================================================
// generate_image
// ============================================================================

function imageExtFromMime(mimeType: string): string {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

export async function generateImage(
  gw: GatewayParams,
  args: {
    prompt: string;
    size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
    quality?: "low" | "medium" | "high" | "auto";
    background?: "transparent" | "opaque" | "auto";
    format?: "png" | "jpeg" | "webp";
  }
): Promise<TextResult> {
  return generateAndUploadMedia(gw, {
    label: "generate_image",
    logLine: `generate_image: ${args.prompt.substring(0, 80)}...`,
    preflight: async () => {
      const capResponse = await createGatewayClient({
        baseUrl: gw.gatewayUrl,
        token: gw.workerToken,
      }).request("/internal/images/capabilities", { timeoutMs: 30_000 });

      if (capResponse.ok) {
        const capabilities = (await capResponse.json()) as {
          available: boolean;
          providers?: Array<{ provider: string; name: string }>;
        };
        if (!capabilities.available) {
          const providerList =
            capabilities.providers?.map((p) => p.name).join(", ") || "OpenAI";
          return {
            notConfigured: `Image generation is not configured. Supported providers: ${providerList}.\n\nAsk an admin to connect one of these providers for the base agent.`,
            providerList,
          };
        }
      }
      return { notConfigured: null, providerList: "OpenAI" };
    },
    endpoint: "/internal/images/generate",
    requestBody: {
      prompt: args.prompt,
      size: args.size,
      quality: args.quality,
      background: args.background,
      format: args.format,
    },
    missingScopeMatch: (lowerError) =>
      lowerError.includes("missing scopes") ||
      lowerError.includes("missing_scope") ||
      (lowerError.includes("scope") &&
        (lowerError.includes("image") || lowerError.includes("model.request"))),
    extFromMime: imageExtFromMime,
    defaultMimeType: "image/png",
    providerHeader: "X-Image-Provider",
    uploadFilename: (ext) => `generated_image.${ext}`,
    messages: {
      providerListFailure: (errorMessage) =>
        `Image generation failed: ${errorMessage}.\n\nAsk an admin to connect one of the supported providers for the base agent.`,
      missingScopeFailure: () =>
        `Image generation failed because the current credential lacks required image permissions.\n\nAsk an admin to connect a provider with image generation access for the base agent.`,
      genericFailure: (errorMessage) =>
        `Error generating image: ${errorMessage}`,
      success: (provider) =>
        `Image sent successfully (generated with ${provider}).`,
      uploadLog: (provider) => `Image generated and sent using ${provider}`,
    },
  });
}

// ============================================================================
// generate_audio
// ============================================================================

function audioExtFromMime(mimeType: string): string {
  if (mimeType.includes("opus")) return "opus";
  if (mimeType.includes("ogg")) return "ogg";
  return "mp3";
}

export async function generateAudio(
  gw: GatewayParams,
  args: { text: string; voice?: string; speed?: number }
): Promise<TextResult> {
  return generateAndUploadMedia(gw, {
    label: "generate_audio",
    logLine: `generate_audio: ${args.text.substring(0, 50)}...`,
    preflight: async () => {
      const suggestions = await fetchAudioProviderSuggestions({
        gatewayUrl: gw.gatewayUrl,
        workerToken: gw.workerToken,
      });
      const providerList =
        suggestions.providerDisplayList || "an audio-capable provider";

      if (suggestions.available === false) {
        return {
          notConfigured: `Audio generation is not configured. To enable it, ask an admin to connect one of the available providers for the base agent: ${providerList}.`,
          providerList,
        };
      }
      return { notConfigured: null, providerList };
    },
    endpoint: "/internal/audio/synthesize",
    requestBody: {
      text: args.text,
      voice: args.voice,
      speed: args.speed,
    },
    missingScopeMatch: (lowerError) =>
      (lowerError.includes("missing scopes") ||
        lowerError.includes("missing_scope")) &&
      lowerError.includes("api.model.audio.request"),
    extFromMime: audioExtFromMime,
    defaultMimeType: "audio/mpeg",
    providerHeader: "X-Audio-Provider",
    uploadFilename: (ext) => `voice_response.${ext}`,
    uploadHeaders: { "X-Voice-Message": "true" },
    messages: {
      providerListFailure: (errorMessage) =>
        `Audio generation failed: ${errorMessage}. No provider configured.\n\nAsk an admin to connect an audio provider for the base agent.`,
      missingScopeFailure: (providerList) =>
        `Audio generation failed because the current OpenAI token lacks api.model.audio.request.\n\nAsk an admin to connect a provider with audio permission for the base agent, or to connect an alternative audio provider (${providerList}).`,
      genericFailure: (errorMessage) =>
        `Error generating audio: ${errorMessage}`,
      success: (provider) =>
        `Voice message sent successfully (generated with ${provider}).`,
      uploadLog: (provider) => `Audio generated and sent using ${provider}`,
    },
  });
}
