import type { AuthProfile } from "@lobu/core";
import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import type { InferenceProviderConfigSource } from "./inference-provider-source.js";

const logger = createLogger("image-generation-service");

// Static defaults for the OpenAI image path. An org `inference_providers` row
// with a `capabilities.image` block overrides these (base_url → URL, model →
// model); an absent block ⇒ these exact values, so existing orgs are
// byte-identical at cutover.
const OPENAI_IMAGE_DEFAULT_URL =
  "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_DEFAULT_MODEL = "gpt-image-1";

// Abort hung provider calls instead of pinning the request indefinitely.
// 120s matches the worker-side generate_image budget.
const PROVIDER_FETCH_TIMEOUT_MS = Number(
  process.env.IMAGE_GENERATION_FETCH_TIMEOUT_MS ?? 120_000
);

type ImageGenerationProvider = "openai" | "gemini";

interface ImageGenerationConfig {
  profileProviderId: string;
  displayName: string;
  provider: ImageGenerationProvider;
  apiKey: string;
  /** OpenAI image endpoint URL (org `capabilities.image.base_url` or static default). */
  baseUrl?: string;
  /** OpenAI image model (org `capabilities.image.model` or static default). */
  model?: string;
}

interface ImageGenerationSuccess {
  imageBuffer: Buffer;
  mimeType: string;
  provider: ImageGenerationProvider;
}

interface ImageGenerationError {
  error: string;
  availableProviders: ImageGenerationProvider[];
  /**
   * The provider was called and the call failed: an image may have been
   * generated (and billed) even though none came back. Absent when the
   * request never left, e.g. no provider is configured.
   */
  dispatched?: true;
}

type ImageGenerationResult = ImageGenerationSuccess | ImageGenerationError;

interface ImageGenerationOptions {
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  format?: "png" | "jpeg" | "webp";
}

const IMAGE_CAPABLE_PROVIDERS: {
  profileProviderId: string;
  provider: ImageGenerationProvider;
  displayName: string;
}[] = [
  {
    profileProviderId: "chatgpt",
    provider: "openai",
    displayName: "OpenAI",
  },
  {
    profileProviderId: "openai",
    provider: "openai",
    displayName: "OpenAI-compatible",
  },
  {
    profileProviderId: "gemini",
    provider: "gemini",
    displayName: "Google Gemini",
  },
];

function parseJwtScopes(token: string): Set<string> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] || "", "base64url").toString("utf-8")
    ) as {
      scope?: unknown;
      scp?: unknown;
    };
    const scopes: string[] = [];
    if (typeof payload.scope === "string") {
      scopes.push(...payload.scope.split(/\s+/));
    }
    if (typeof payload.scp === "string") {
      scopes.push(...payload.scp.split(/\s+/));
    }
    if (Array.isArray(payload.scp)) {
      scopes.push(
        ...payload.scp.filter(
          (value): value is string => typeof value === "string"
        )
      );
    }
    const cleaned = scopes.map((scope) => scope.trim()).filter(Boolean);
    return cleaned.length > 0 ? new Set(cleaned) : null;
  } catch {
    return null;
  }
}

function hasImageGenerationAccess(
  profileProviderId: string,
  profile: AuthProfile
): boolean {
  if (!profile.credential) return false;
  if (profileProviderId !== "chatgpt") return true;
  if (profile.authType === "api-key") return true;

  const scopes = parseJwtScopes(profile.credential);
  if (!scopes) return true;
  return (
    scopes.has("api.model.image.request") ||
    scopes.has("api.model.request") ||
    scopes.has("model.image.request")
  );
}

export class ImageGenerationService {
  private inferenceProviderSource?: InferenceProviderConfigSource | undefined;

  constructor(
    private readonly authProfilesManager: AuthProfilesManager,
    inferenceProviderSource?: InferenceProviderConfigSource
  ) {
    this.inferenceProviderSource = inferenceProviderSource;
  }

  setInferenceProviderSource(source: InferenceProviderConfigSource): void {
    this.inferenceProviderSource = source;
  }

  async getConfig(agentId: string): Promise<ImageGenerationConfig | null> {
    for (const {
      profileProviderId,
      provider,
      displayName,
    } of IMAGE_CAPABLE_PROVIDERS) {
      // Prefer the org `inference_providers` row for this provider slug: one
      // read yields the row key + capabilities.image (base_url/model) together,
      // honoring the single-read URL invariant. Only the OpenAI path supports a
      // custom upstream; Gemini keeps its static key-in-URL shape below.
      if (provider === "openai" && this.inferenceProviderSource) {
        const resolved = await this.inferenceProviderSource(
          agentId,
          profileProviderId,
          "image"
        );
        if (resolved) {
          return {
            profileProviderId,
            displayName,
            provider,
            apiKey: resolved.apiKey,
            baseUrl: resolved.baseUrl ?? OPENAI_IMAGE_DEFAULT_URL,
            model: resolved.model ?? OPENAI_IMAGE_DEFAULT_MODEL,
          };
        }
      }

      const profile = await this.authProfilesManager.getBestProfile(
        agentId,
        profileProviderId
      );
      if (!profile?.credential) continue;
      if (!hasImageGenerationAccess(profileProviderId, profile)) {
        logger.info("Skipping provider without image-generation scope", {
          agentId,
          profileProviderId,
          authType: profile.authType,
        });
        continue;
      }
      return {
        profileProviderId,
        displayName,
        provider,
        apiKey: profile.credential,
      };
    }
    return null;
  }

  getProviderInfo(): Array<{
    provider: ImageGenerationProvider;
    name: string;
  }> {
    return IMAGE_CAPABLE_PROVIDERS.map(({ provider, displayName }) => ({
      provider,
      name: displayName,
    }));
  }

  async generate(
    prompt: string,
    agentId: string,
    options: ImageGenerationOptions = {}
  ): Promise<ImageGenerationResult> {
    const config = await this.getConfig(agentId);
    if (!config) {
      return this.noProviderError(
        "No image generation provider configured",
        agentId
      );
    }

    logger.info("Generating image", {
      agentId,
      provider: config.provider,
      profileProviderId: config.profileProviderId,
      promptLength: prompt.length,
      size: options.size,
      quality: options.quality,
      background: options.background,
      format: options.format,
    });

    try {
      const result =
        config.provider === "gemini"
          ? await this.generateWithGemini(prompt, config.apiKey, options)
          : await this.generateWithOpenAI(prompt, config, options);
      return {
        imageBuffer: result.imageBuffer,
        mimeType: result.mimeType,
        provider: config.provider,
      };
    } catch (error) {
      const errorMessage =
        getErrorMessage(error);
      logger.error("Image generation failed", {
        agentId,
        provider: config.provider,
        profileProviderId: config.profileProviderId,
        error: errorMessage,
      });
      return {
        error: `Image generation failed with ${config.displayName}: ${errorMessage}`,
        availableProviders: [config.provider],
        dispatched: true,
      };
    }
  }

  private noProviderError(
    message: string,
    agentId: string
  ): ImageGenerationError {
    const availableProviders = IMAGE_CAPABLE_PROVIDERS.map((p) => p.provider);
    logger.info(message, { agentId, availableProviders });
    return { error: message, availableProviders };
  }

  private async generateWithOpenAI(
    prompt: string,
    config: ImageGenerationConfig,
    options: ImageGenerationOptions
  ): Promise<{ imageBuffer: Buffer; mimeType: string }> {
    const format = options.format || "png";
    const response = await fetch(
      config.baseUrl || OPENAI_IMAGE_DEFAULT_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model || OPENAI_IMAGE_DEFAULT_MODEL,
          prompt,
          size: options.size || "1024x1024",
          quality: options.quality || "auto",
          background: options.background || "auto",
          output_format: format,
          response_format: "b64_json",
        }),
        signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI Images API error: ${response.status} - ${errorText}`
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("OpenAI Images API returned no image payload");
    }

    const mimeType =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
          ? "image/webp"
          : "image/png";

    return {
      imageBuffer: Buffer.from(b64, "base64"),
      mimeType,
    };
  }

  private async generateWithGemini(
    prompt: string,
    apiKey: string,
    options: ImageGenerationOptions
  ): Promise<{ imageBuffer: Buffer; mimeType: string }> {
    const format = options.format || "png";
    const mimeType =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
          ? "image/webp"
          : "image/png";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, outputMimeType: mimeType },
        }),
        signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gemini Imagen API error: ${response.status} - ${errorText}`
      );
    }

    const data = (await response.json()) as {
      predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
    };
    const prediction = data.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      throw new Error("Gemini Imagen API returned no image payload");
    }

    return {
      imageBuffer: Buffer.from(prediction.bytesBase64Encoded, "base64"),
      mimeType: prediction.mimeType || mimeType,
    };
  }
}
