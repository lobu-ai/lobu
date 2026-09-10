import { createLogger, type ModelOption } from "@lobu/core";
import type { ProviderCredentialContext } from "../../embedded.js";
import type { ProviderModelMetadata } from "../../modules/module-system.js";
import { BaseProviderModule } from "../base-provider-module.js";
import { extractJwtAccountId } from "../oauth/client.js";
import type { AuthProfilesManager } from "../settings/auth-profiles-manager.js";
import { fetchModelOptions } from "../utils/fetch-model-options.js";

const logger = createLogger("chatgpt-oauth-module");
// The Codex catalog endpoint negotiates on the CLIENT's version, not Lobu's:
// it is the Codex CLI release whose response shape this reader parses.
const CODEX_CATALOG_CLIENT_VERSION = "0.154.0";

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

  /**
   * Capabilities for a model the bundled registry has never heard of, read
   * from the account's own Codex catalog. Answers `undefined` for every
   * failure — no credential, no account identity, an unreachable or
   * unparseable catalog — so the caller keeps its registry defaults.
   */
  async getModelMetadata(
    agentId: string,
    modelId: string,
    context: ProviderCredentialContext
  ): Promise<ProviderModelMetadata | undefined> {
    const token = await this.getCredential(agentId, context);
    if (!token) return undefined;
    const accountId = extractJwtAccountId(token);
    if (!accountId) return undefined;
    try {
      const response = await fetch(
        `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "ChatGPT-Account-Id": accountId,
            originator: "codex_cli_rs",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        }
      );
      if (!response.ok) {
        logger.warn({ status: response.status }, "Codex model catalog unavailable");
        return undefined;
      }
      const payload = await response.json() as { models?: Array<Record<string, unknown>> };
      if (!Array.isArray(payload.models)) return undefined;
      const model = payload.models.find(candidate => candidate?.slug === modelId);
      if (!model) return undefined;
      const metadata: ProviderModelMetadata = {};
      if (typeof model.context_window === "number" && Number.isSafeInteger(model.context_window) && model.context_window > 0) {
        metadata.contextWindow = model.context_window;
      }
      // An EMPTY level list is no answer, not "no reasoning": asserting
      // `false` there makes the guest reject an effort the caller configured
      // for a model that may well support it. Leave the field absent instead.
      if (Array.isArray(model.supported_reasoning_levels) && model.supported_reasoning_levels.length > 0 && model.supported_reasoning_levels.every(level =>
        level && typeof level === "object" && "effort" in level && typeof level.effort === "string"
      )) {
        metadata.reasoning = model.supported_reasoning_levels.some(level =>
          level.effort !== "none" && level.effort !== "off"
        );
      }
      if (Array.isArray(model.input_modalities)) {
        const input = model.input_modalities.filter((value): value is "text" | "image" => value === "text" || value === "image");
        if (input.length) metadata.input = input;
      }
      return metadata;
    } catch (error) {
      logger.warn(
        // JSON parse errors can quote upstream body fragments; do not log
        // arbitrary response or transport text from an authenticated request.
        { category: error instanceof SyntaxError ? "invalid_json" : "transport" },
        "Codex model catalog lookup failed; retaining registry defaults"
      );
      return undefined;
    }
  }
}
