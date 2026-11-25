import { createLogger } from "@lobu/core";
import type {
  ModelListingCredential,
  ProviderModel,
} from "../../modules/module-system.js";
import { BaseProviderModule } from "../base-provider-module.js";
import { resolveEnv } from "../mcp/string-substitution.js";
import type { OAuthCredentials } from "../oauth/credentials.js";
import {
  type AuthProfilesManager,
  createAuthProfileLabel,
} from "../settings/auth-profiles-manager.js";
import { fetchProviderModels } from "../utils/fetch-provider-models.js";

const logger = createLogger("claude-oauth-module");

/**
 * Claude OAuth Module - Handles credential injection and live model listing for Claude.
 * OAuth login/logout is handled by the generic settings web page routes.
 */
export class ClaudeOAuthModule extends BaseProviderModule {
  constructor(authProfilesManager: AuthProfilesManager, modelsDevId?: string) {
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
        modelsDevId,
        // Claude speaks the Anthropic Messages protocol, so an org Claude
        // provider routes via the anthropic-messages adapter.
        sdkCompat: "anthropic",
      },
      authProfilesManager
    );
    // Preserve existing module name
    this.name = "claude-oauth";
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

    return envVars;
  }

  /**
   * Anthropic's live model listing. An OAuth sign-in rides Bearer; an API key
   * rides `x-api-key`. No credential → `null` (connect one to list).
   */
  async listModels(
    credential: ModelListingCredential | null,
    signal: AbortSignal
  ): Promise<ProviderModel[] | null> {
    if (!credential) return null;
    const upstream = this.getUpstreamConfig();
    if (!upstream) return [];
    return fetchProviderModels<{
      data?: Array<{ id?: string; display_name?: string }>;
    }>({
      url: `${upstream.upstreamBaseUrl.replace(/\/+$/, "")}/v1/models?limit=1000`,
      headers: {
        "anthropic-version": "2023-06-01",
        ...(credential.kind === "oauth"
          ? { Authorization: `Bearer ${credential.value}` }
          : { "x-api-key": credential.value }),
      },
      signal,
      pick: (payload) => {
        if (!Array.isArray(payload.data)) throw new Error("Invalid model listing");
        return payload.data.map((item) => {
          const id = item?.id?.trim();
          return id ? { id, label: item.display_name } : null;
        });
      },
    });
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
}
