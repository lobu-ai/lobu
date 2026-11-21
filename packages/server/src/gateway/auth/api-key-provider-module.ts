import type { ModelOption, SdkCompat } from "@lobu/core";
import { BaseProviderModule } from "./base-provider-module.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";
import { resolveEnv } from "./mcp/string-substitution.js";
import { fetchModelOptions } from "./utils/fetch-model-options.js";

export function sameProviderDiscoveryUpstream(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

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
  /** Wire protocol (see SDK_COMPAT_PROTOCOLS). The OpenAI provider also maps OPENAI_BASE_URL. */
  sdkCompat?: SdkCompat;
  /** How the API key is presented upstream ("x-api-key" for Anthropic; Bearer otherwise). */
  apiKeyHeader?: "authorization" | "x-api-key";
  /** Default model ID when none is configured */
  defaultModel?: string;
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
 * Config-driven providers declare their protocol and picker defaults here.
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
        apiKeyHeader: config.apiKeyHeader,
      },
      config.authProfilesManager,
    );
    this.apiKeyConfig = config;
    this.sdkCompat = this.getSdkCompatForUpstream();
    this.name = `${config.providerId}-api-key`;
  }

  /** OpenAI URL overrides may only support Chat Completions; compare with the catalog URL. */
  getSdkCompatForUpstream(baseUrl?: string): SdkCompat | undefined {
    const protocol = this.apiKeyConfig.sdkCompat;
    if (this.providerId === "openai" && protocol === "openai-responses") {
      const effective = baseUrl ?? this.getUpstreamConfig()?.upstreamBaseUrl;
      if (effective?.replace(/\/+$/, "") !== this.apiKeyConfig.upstreamBaseUrl?.replace(/\/+$/, "")) {
        return "openai";
      }
    }
    return protocol;
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
      (this.apiKeyConfig.sdkCompat === "openai" ||
        this.apiKeyConfig.sdkCompat === "openai-responses") &&
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

  get defaultModel(): string | undefined {
    return this.apiKeyConfig.defaultModel;
  }

  async getModelOptions(
    agentId: string,
    userId: string,
  ): Promise<ModelOption[]> {
    const resolved = await this.resolveCredential(agentId, { userId }, { includeSystemEnv: true });
    const upstream = this.getUpstreamConfig()?.upstreamBaseUrl;
    if (!resolved || !upstream ||
        (resolved.baseUrl && !sameProviderDiscoveryUpstream(resolved.baseUrl, upstream))) {
      return [];
    }
    return this.discoverModels(resolved.credential, false) ?? [];
  }

  get supportsModelDiscovery(): boolean {
    return this.providerId === "gemini" || Boolean(this.apiKeyConfig.modelsEndpoint);
  }

  getSystemDiscoveryKey(): string | undefined {
    return resolveEnv(this.apiKeyConfig.systemEnvVarName ?? this.apiKeyConfig.envVarName);
  }

  discoverModels(
    key: string,
    strict = true,
    signal = AbortSignal.timeout(5000),
  ): Promise<ModelOption[]> | undefined {
    const upstream = this.getUpstreamConfig();
    if (!upstream) return undefined;
    if (this.providerId === "gemini") {
      return this.fetchGeminiModels(key, upstream.upstreamBaseUrl, strict, signal);
    }
    const endpoint = this.apiKeyConfig.modelsEndpoint;
    if (!endpoint) return undefined;
    return this.fetchModelsGeneric(key, upstream.upstreamBaseUrl, endpoint, strict, signal);
  }

  /**
   * Generic model fetcher using Bearer auth. Works with OpenAI-compatible
   * endpoints ({data:[{id}]}) and Ollama ({models:[{name}]}).
   */
  private async fetchModelsGeneric(
    apiKey: string,
    baseUrl: string,
    endpoint: string,
    strict: boolean,
    signal: AbortSignal,
  ): Promise<ModelOption[]> {
    return fetchModelOptions<{
      data?: Array<{ id?: string; name?: string; display_name?: string }>;
      models?: Array<{ name?: string; model?: string }>;
    }>({
      url: `${baseUrl.replace(/\/$/, "")}${endpoint}`,
      headers: this.apiKeyConfig.apiKeyHeader === "x-api-key"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${apiKey}` },
      strict,
      signal,
      prefix: this.providerId,
      pick: (payload) => {
        if (Array.isArray(payload.data)) {
          return payload.data.map((m) =>
            typeof m?.id === "string" && m.id.trim()
              ? { id: m.id.trim(), label: m.display_name ?? m.name }
              : null,
          );
        }
        if (Array.isArray(payload.models)) {
          return payload.models.map((m) => {
            const id = (m.model || m.name)?.trim();
            return id ? { id } : null;
          });
        }
        if (strict) throw new Error("Invalid model listing");
        return [];
      },
    });
  }

  private async fetchGeminiModels(
    apiKey: string,
    baseUrl: string,
    strict: boolean,
    signal: AbortSignal,
  ): Promise<ModelOption[]> {
    const url = new URL(`${baseUrl.replace(/\/+$/, "").replace(/\/openai$/, "")}/models`);
    const models = new Map<string, ModelOption>();
    // Both the time limit and the page cap apply across the entire listing.
    for (let page = 0; page < (strict ? 10 : 1); page++) {
      let nextPageToken: string | undefined;
      const options = await fetchModelOptions<{
        nextPageToken?: string;
        models?: Array<{
          name?: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
        }>;
      }>({
        url: url.toString(),
        headers: { "x-goog-api-key": apiKey },
        prefix: this.providerId,
        signal,
        strict,
        pick: (payload) => {
          if (!Array.isArray(payload.models)) {
            if (strict) throw new Error("Invalid model listing");
            return [];
          }
          nextPageToken = payload.nextPageToken;
          return payload.models.map((model) => {
            if (!model?.supportedGenerationMethods?.includes("generateContent")) return null;
            const id = model.name?.replace(/^models\//, "").trim();
            return id ? { id, label: model.displayName || id } : null;
          });
        },
      });
      for (const option of options) {
        models.set(option.value, option);
        if (models.size >= 1000) return [...models.values()];
      }
      if (!nextPageToken || nextPageToken === url.searchParams.get("pageToken")) break;
      url.searchParams.set("pageToken", nextPageToken);
    }
    return [...models.values()];
  }
}
