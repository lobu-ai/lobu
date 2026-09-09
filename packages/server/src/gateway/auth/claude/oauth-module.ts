import { createLogger, type ModelOption } from "@lobu/core";
import { BaseProviderModule } from "../base-provider-module.js";
import { resolveEnv } from "../mcp/string-substitution.js";
import type { OAuthCredentials } from "../oauth/credentials.js";
import {
  type AuthProfilesManager,
  createAuthProfileLabel,
} from "../settings/auth-profiles-manager.js";
import type { ModelPreferenceStore } from "../settings/model-preference-store.js";

const logger = createLogger("claude-oauth-module");

/**
 * Claude OAuth Module - Handles credential injection and model preferences for Claude.
 * OAuth login/logout is handled by the generic settings web page routes.
 */
export class ClaudeOAuthModule extends BaseProviderModule {
  private modelPreferenceStore: ModelPreferenceStore;

  constructor(
    authProfilesManager: AuthProfilesManager,
    modelPreferenceStore: ModelPreferenceStore
  ) {
    super(
      {
        providerId: "claude",
        providerDisplayName: "Claude",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=anthropic.com&sz=128",
        credentialEnvVarName: "CLAUDE_CODE_OAUTH_TOKEN",
        secretEnvVarNames: [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        // Bearer/OAuth tokens — presented as `Authorization: Bearer`, not
        // `x-api-key`. ANTHROPIC_API_KEY (the sk-ant key) is the only x-api-key
        // credential and is intentionally absent here.
        bearerCredentialEnvVarNames: [
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        slug: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        baseUrlEnvVarName: "ANTHROPIC_BASE_URL",
        // Anthropic rejects API keys sent as `Authorization: Bearer` (401
        // "invalid bearer token") — they must ride in the `x-api-key` header.
        // OAuth tokens still use Bearer (the secret proxy checks credential
        // type before applying this scheme).
        apiKeyHeader: "x-api-key",
        authType: "oauth",
        supportedAuthTypes: ["oauth", "api-key"],
        apiKeyInstructions:
          'Enter your <a href="https://console.anthropic.com/settings/keys" target="_blank" class="text-blue-600 underline">Anthropic API key</a>:',
        apiKeyPlaceholder: "sk-ant-...",
        catalogDescription: "Anthropic's Claude AI with OAuth authentication",
        // Static shortlist for the model picker — Claude has no
        // config/providers.json entry (it's this OAuth module), so its models
        // are declared here. Current Claude 5 family + Opus 4.8.
        catalogModels: [
          "claude-opus-4-8",
          "claude-sonnet-5",
          "claude-haiku-4-5-20251001",
          "claude-fable-5",
        ],
        // Claude speaks the Anthropic Messages protocol, so an org Claude
        // provider routes via the anthropic-messages adapter.
        sdkCompat: "anthropic",
      },
      authProfilesManager
    );
    // Preserve existing module name
    this.name = "claude-oauth";
    this.modelPreferenceStore = modelPreferenceStore;
  }

  // ---- Overrides for multi-env-var logic ----

  override hasSystemKey(): boolean {
    // Recognize all three credential env vars: a plain ANTHROPIC_API_KEY (the
    // standard var most users set) is a valid system key, same as every other
    // provider's API key. Without it, an env-configured Anthropic key was
    // silently treated as "not connected" — the agent reported "No model
    // configured" even though injectSystemKeyFallback would have used the key.
    // The proxy presents it via x-api-key (see ProviderUpstreamConfig.apiKeyHeader).
    return !!(
      resolveEnv("ANTHROPIC_AUTH_TOKEN") ||
      resolveEnv("CLAUDE_CODE_OAUTH_TOKEN") ||
      resolveEnv("ANTHROPIC_API_KEY")
    );
  }

  override injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    if (!envVars.ANTHROPIC_API_KEY && !envVars.CLAUDE_CODE_OAUTH_TOKEN) {
      // Prefer ANTHROPIC_AUTH_TOKEN (explicit user config in .env) over
      // ANTHROPIC_API_KEY (which may be injected by Claude Code's shell env).
      const systemApiKey =
        resolveEnv("ANTHROPIC_AUTH_TOKEN") || resolveEnv("ANTHROPIC_API_KEY");
      const systemOAuthToken = resolveEnv("CLAUDE_CODE_OAUTH_TOKEN");

      if (systemApiKey) {
        envVars.ANTHROPIC_API_KEY = systemApiKey;
      } else if (systemOAuthToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = systemOAuthToken;
      }
    }
    return envVars;
  }

  override async buildEnvVars(
    agentId: string,
    envVars: Record<string, string>,
    context?: import("../../embedded.js").ProviderCredentialContext
  ): Promise<Record<string, string>> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId,
      undefined,
      context
    );

    if (profile?.credential) {
      logger.info(`Injecting ${profile.authType} profile for space ${agentId}`);
      if (profile.authType === "oauth") {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = profile.credential;
      } else {
        envVars.ANTHROPIC_API_KEY = profile.credential;
      }
    }

    // AGENT_DEFAULT_MODEL is now delivered dynamically via session context.
    // No longer baked into static container env vars.

    return envVars;
  }

  async getModelOptions(
    agentId: string,
    userId: string
  ): Promise<ModelOption[]> {
    const availableModels = await this.fetchClaudeModels(agentId);
    if (availableModels.length === 0) return [];

    const preferredModel =
      await this.modelPreferenceStore.getModelPreference(userId);
    logger.debug("Building Claude model options", {
      agentId,
      userId,
      preferredModel,
    });
    // No hardcoded default model: when nothing is pinned, default to the
    // provider's newest live model (Anthropic's /v1/models is newest-first).
    // This keeps the default current automatically instead of rotting to a
    // retired snapshot.
    const defaultModel =
      preferredModel ||
      process.env.AGENT_DEFAULT_MODEL ||
      availableModels[0]?.id;
    const options: ModelOption[] = [];
    const seen = new Set<string>();

    const addOption = (value: string, label: string) => {
      if (seen.has(value)) return;
      seen.add(value);
      options.push({ value, label });
    };

    const defaultEntry = availableModels.find((m) => m.id === defaultModel);
    if (defaultEntry && defaultModel) {
      addOption(defaultModel, defaultEntry.display_name || defaultModel);
    }

    for (const model of availableModels) {
      addOption(model.id, model.display_name || model.id);
    }

    return options;
  }

  async setCredentials(
    agentId: string,
    userId: string,
    credentials: unknown
  ): Promise<void> {
    await this.saveOAuthCredentials(
      agentId,
      userId,
      credentials as OAuthCredentials
    );
  }

  async deleteCredentials(agentId: string, userId: string): Promise<void> {
    await this.authProfilesManager.deleteProviderProfiles(
      agentId,
      this.providerId,
      { userId }
    );
  }

  private async saveOAuthCredentials(
    agentId: string,
    userId: string,
    credentials: OAuthCredentials
  ): Promise<void> {
    await this.authProfilesManager.upsertProfile({
      agentId,
      userId,
      provider: this.providerId,
      credential: credentials.accessToken,
      authType: "oauth",
      label: createAuthProfileLabel(
        this.providerDisplayName,
        credentials.accessToken
      ),
      metadata: {
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
      makePrimary: true,
    });
  }

  private static readonly MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly modelsCache = new Map<
    string,
    {
      at: number;
      models: Array<{ id: string; display_name: string; type: string }>;
    }
  >();

  /**
   * Fetch the live Claude model list (newest-first) for the agent's
   * credentials. Returns `[]` when the provider has no credentials yet or the
   * API call fails — callers treat empty as "no catalog / no default" rather
   * than substituting a hardcoded snapshot that can silently go stale.
   * Successful results are cached per agent for a few minutes so resolving the
   * default model doesn't hit the API on every turn.
   */
  private async fetchClaudeModels(
    agentId: string
  ): Promise<Array<{ id: string; display_name: string; type: string }>> {
    const cached = this.modelsCache.get(agentId);
    if (
      cached &&
      Date.now() - cached.at < ClaudeOAuthModule.MODELS_CACHE_TTL_MS
    ) {
      return cached.models;
    }

    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId
    );

    // A per-agent profile wins entirely; only when none exists do we fall back
    // to the system env key. Without that env fallback, an env-configured key
    // (no auth profile) produced no credential here, so getDefaultModel
    // returned undefined and an auto-mode agent got "No model configured".
    // ANTHROPIC_AUTH_TOKEN is a Bearer token (preferred, matches the secret
    // proxy); ANTHROPIC_API_KEY is presented as x-api-key.
    let oauthToken: string | undefined;
    let apiKey: string | undefined;
    if (profile?.credential) {
      if (profile.authType === "oauth") oauthToken = profile.credential;
      else apiKey = profile.credential;
    } else {
      oauthToken = resolveEnv("ANTHROPIC_AUTH_TOKEN");
      if (!oauthToken) apiKey = resolveEnv("ANTHROPIC_API_KEY");
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (oauthToken) {
      headers.Authorization = `Bearer ${oauthToken}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else {
      // No credentials → can't enumerate models. Surface empty so the model
      // picker / default resolution shows "connect a provider" instead of a
      // stale hardcoded list.
      return [];
    }

    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers,
    }).catch((err) => {
      logger.warn(
        { error: err?.message, agentId },
        "fetchClaudeModels: fetch failed"
      );
      return null;
    });

    if (!response?.ok) {
      logger.warn(
        {
          agentId,
          status: response?.status,
          hasOauth: !!oauthToken,
          hasApiKey: !!apiKey,
        },
        "fetchClaudeModels: non-ok response"
      );
      return [];
    }

    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; display_name?: string; type?: string }>;
    };

    const models = (payload.data || [])
      .map((item) => {
        const id = item.id?.trim();
        if (!id) return null;
        return {
          id,
          display_name: item.display_name || id,
          type: item.type || "model",
        };
      })
      .filter(
        (item): item is { id: string; display_name: string; type: string } =>
          Boolean(item)
      );

    if (models.length > 0) {
      this.modelsCache.set(agentId, { at: Date.now(), models });
    }
    return models;
  }
}
