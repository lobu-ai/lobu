import type { ModelOption } from "@lobu/core";
import { BaseProviderModule } from "../base-provider-module.js";
import type { AuthProfilesManager } from "../settings/auth-profiles-manager.js";
import { fetchModelOptions } from "../utils/fetch-model-options.js";

/**
 * ChatGPT provider module — runtime credential surface for the ChatGPT
 * (subscription login) provider. The OAuth device-code FLOW lives in the
 * generic org routes; this module declares the Codex wire protocol and keeps
 * model listing. Does not require the oauth registry at construction time.
 */
export class ChatGPTOAuthModule extends BaseProviderModule {
  constructor(authProfilesManager: AuthProfilesManager) {
    super(
      {
        providerId: "chatgpt",
        sdkCompat: "openai-codex",
        providerDisplayName: "ChatGPT (subscription login)",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=128",
        credentialEnvVarName: "OPENAI_API_KEY",
        secretEnvVarNames: ["OPENAI_API_KEY"],
        slug: "openai-codex",
        upstreamBaseUrl: "https://chatgpt.com/backend-api",
        // Dedicated key — must NOT be "OPENAI_BASE_URL". The config-driven
        // `openai` provider (sdkCompat "openai", api.openai.com) also emits
        // OPENAI_BASE_URL; sharing the key let an unguarded merge clobber it so
        // an `openai/<model>` request egressed to chatgpt.com/backend-api (403
        // without a ChatGPT session). Keep this provider's base URL under its
        // own key so the two never collide.
        baseUrlEnvVarName: "OPENAI_CODEX_BASE_URL",
        authType: "device-code",
        supportedAuthTypes: ["device-code"],
        catalogDescription:
          "Sign in with your ChatGPT Plus/Pro subscription (device code). No API key; uses your subscription, not metered API billing.",
      },
      authProfilesManager,
    );
    // Preserve existing module name
    this.name = "chatgpt-oauth";
  }

  async getModelOptions(
    agentId: string,
    userId: string,
  ): Promise<ModelOption[]> {
    const token = await this.getCredential(agentId, { userId });
    if (!token) return [];

    return fetchModelOptions<{
      models?: Array<{ slug?: string; title?: string }>;
    }>({
      url: "https://chatgpt.com/backend-api/models",
      headers: { Authorization: `Bearer ${token}` },
      prefix: "openai-codex",
      pick: (payload) =>
        (payload.models || []).map((m) => {
          const id = m.slug?.trim();
          return id ? { id, label: m.title?.trim() || id } : null;
        }),
    });
  }
}
