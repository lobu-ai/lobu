import type { ConfigProviderMeta, ModelOption, SdkCompat } from "@lobu/core";
import { BaseProviderModule } from "./base-provider-module.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";
import { fetchModelOptions } from "./utils/fetch-model-options.js";

interface ApiKeyProviderConfig {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl: string;
  envVarName: string;
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  systemEnvVarName?: string;
  /** Provider slug for proxy path routing (e.g. "gemini") */
  slug?: string;
  /** Upstream base URL for proxy forwarding (e.g. "https://generativelanguage.googleapis.com") */
  upstreamBaseUrl?: string;
  /** Explicit base URL env var name (defaults to envVarName with _KEY replaced by _BASE_URL) */
  baseUrlEnvVarName?: string;
  /** Relative path to fetch model list (e.g. "/v1/models"). Enables generic model fetching. */
  modelsEndpoint?: string;
  /** Wire protocol (see SDK_COMPAT_PROTOCOLS). "openai" also maps OPENAI_BASE_URL in proxy. */
  sdkCompat?: SdkCompat;
  /** How the API key is presented upstream ("x-api-key" for Anthropic; Bearer otherwise). */
  apiKeyHeader?: "authorization" | "x-api-key";
  /** Default model ID when none is configured */
  defaultModel?: string;
  /** models.dev provider ID when different from `providerId` */
  registryAlias?: string;
  /** Whether to show in "Add Provider" catalog (default: true) */
  catalogVisible?: boolean;
  /**
   * Primary auth type for the catalog. Defaults to `api-key`. Set to
   * `device-code` / `oauth` when this provider also has a subscription OAuth
   * row (e.g. xAI SuperGrok).
   */
  authType?: "oauth" | "device-code" | "api-key";
  /** Full set of supported auth types for the add-provider UI. */
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  authProfilesManager: AuthProfilesManager;
}

/**
 * Generic API-key provider module.
 * Any model provider that only needs a "paste your API key" flow
 * can be instantiated from this class without writing a full module.
 *
 * Config-driven providers (from providers.json) set sdkCompat,
 * defaultModel, and registryAlias to enable dynamic worker model resolution.
 */
export class ApiKeyProviderModule extends BaseProviderModule {
  protected readonly apiKeyConfig: ApiKeyProviderConfig;

  constructor(config: ApiKeyProviderConfig) {
    super(
      {
        providerId: config.providerId,
        providerDisplayName: config.providerDisplayName,
        providerIconUrl: config.providerIconUrl,
        credentialEnvVarName: config.envVarName,
        secretEnvVarNames: [config.envVarName],
        systemEnvVarName: config.systemEnvVarName,
        slug: config.slug || config.providerId,
        upstreamBaseUrl: config.upstreamBaseUrl,
        baseUrlEnvVarName:
          config.baseUrlEnvVarName ||
          config.envVarName.replace("_KEY", "_BASE_URL"),
        authType: config.authType ?? "api-key",
        supportedAuthTypes: config.supportedAuthTypes ?? ["api-key"],
        apiKeyInstructions: config.apiKeyInstructions,
        apiKeyPlaceholder: config.apiKeyPlaceholder,
        catalogVisible: config.catalogVisible,
        sdkCompat: config.sdkCompat,
        catalogProvider: config.registryAlias,
        apiKeyHeader: config.apiKeyHeader,
      },
      config.authProfilesManager,
    );
    this.apiKeyConfig = config;
    this.name = `${config.providerId}-api-key`;
  }

  /**
   * Map OPENAI_BASE_URL so the OpenAI SDK resolves through our proxy — but ONLY
   * for the literal `openai` provider. The worker reads
   * DEFAULT_PROVIDER_BASE_URL_ENV.openai === "OPENAI_BASE_URL", so openai needs
   * it under that exact key. Every OTHER sdkCompat:"openai" provider (groq,
   * gemini, openrouter, …) resolves its base URL through its OWN dedicated
   * <PROVIDER>_BASE_URL key (super emits it; the worker reads it via
   * DEFAULT_PROVIDER_BASE_URL_ENV, or falls back to the per-run singular
   * providerBaseUrl). Emitting OPENAI_BASE_URL for those too made every
   * sdkCompat provider claim the SAME key, so co-installing openai with any of
   * them let the last-merged one clobber it and an openai/<model> request
   * egressed to the wrong slug. Keep this key owned by openai alone.
   */
  override getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string,
    context?: import("../embedded.js").ProviderCredentialContext,
  ): Record<string, string> {
    const mappings = super.getProxyBaseUrlMappings(proxyUrl, agentId, context);
    if (
      this.apiKeyConfig.sdkCompat === "openai" &&
      this.providerId === "openai"
    ) {
      const slug = this.providerConfig.slug || this.providerId;
      mappings.OPENAI_BASE_URL = this.buildAgentScopedProxyUrl(
        proxyUrl,
        slug,
        agentId,
        context,
      );
    }
    return mappings;
  }

  /**
   * Returns metadata for config-driven providers (sdkCompat, defaultModel, etc.)
   * so the worker can register them dynamically. Returns null for hardcoded providers.
   */
  getProviderMetadata(): ConfigProviderMeta | null {
    if (
      !this.apiKeyConfig.sdkCompat &&
      !this.apiKeyConfig.defaultModel &&
      !this.apiKeyConfig.registryAlias
    ) {
      return null;
    }
    return {
      sdkCompat: this.apiKeyConfig.sdkCompat,
      defaultModel: this.apiKeyConfig.defaultModel,
      registryAlias: this.apiKeyConfig.registryAlias,
      baseUrlEnvVar:
        this.providerConfig.baseUrlEnvVarName ||
        this.apiKeyConfig.envVarName.replace("_KEY", "_BASE_URL"),
    };
  }

  async getModelOptions(
    agentId: string,
    userId: string,
  ): Promise<ModelOption[]> {
    const key = await this.getCredential(agentId, { userId });
    if (!key) return [];

    // Gemini uses a non-standard models endpoint with key-in-query auth
    if (this.providerId === "gemini") {
      return this.fetchGeminiModels(key);
    }

    // Generic modelsEndpoint: supports OpenAI format ({data:[{id}]}) and Ollama format ({models:[{name}]})
    const modelsEndpoint = this.apiKeyConfig.modelsEndpoint;
    if (modelsEndpoint && this.apiKeyConfig.upstreamBaseUrl) {
      return this.fetchModelsGeneric(
        key,
        this.apiKeyConfig.upstreamBaseUrl,
        modelsEndpoint,
      );
    }

    return [];
  }

  /**
   * Generic model fetcher using Bearer auth. Works with OpenAI-compatible
   * endpoints ({data:[{id}]}) and Ollama ({models:[{name}]}).
   */
  private async fetchModelsGeneric(
    apiKey: string,
    baseUrl: string,
    endpoint: string,
  ): Promise<ModelOption[]> {
    return fetchModelOptions<{
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string; model?: string }>;
    }>({
      url: `${baseUrl.replace(/\/$/, "")}${endpoint}`,
      headers: { Authorization: `Bearer ${apiKey}` },
      prefix: this.providerId,
      pick: (payload) => {
        if (payload.data) {
          return payload.data.map((m) =>
            m.id?.trim() ? { id: m.id.trim() } : null,
          );
        }
        if (payload.models) {
          return payload.models.map((m) => {
            const id = (m.model || m.name)?.trim();
            return id ? { id } : null;
          });
        }
        return [];
      },
    });
  }

  private async fetchGeminiModels(apiKey: string): Promise<ModelOption[]> {
    const url = new URL(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
    url.searchParams.set("key", apiKey);
    return fetchModelOptions<{
      models?: Array<{ name?: string; displayName?: string }>;
    }>({
      url: url.toString(),
      prefix: "gemini",
      pick: (payload) =>
        (payload.models || []).map((m) => {
          const id = m.name?.replace(/^models\//, "").trim();
          return id ? { id, label: m.displayName || id } : null;
        }),
    });
  }
}
