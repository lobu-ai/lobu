/**
 * Shared types for config-driven LLM providers.
 * Loaded from the bundled provider registry config.
 */

import type { SdkCompat } from "./sdk-compat";

/**
 * Subscription-login OAuth wire config (data only). Nested under a
 * {@link ProviderConfigEntry} in `config/providers.json`. The gateway loads
 * these at boot — no provider ids are hard-coded in OAuth client code.
 *
 * `id` / display name come from the parent provider entry.
 */
export type ProviderOAuthGrantKind =
  | "authorization-code"
  | "device-code"
  | "openai-device-auth";

export interface ProviderOAuthConfig {
  clientId: string;
  clientSecret?: string;
  /** Authorization-code only. */
  authUrl?: string;
  tokenUrl: string;
  /** Authorization-code + OpenAI device code exchange. */
  redirectUri?: string;
  /** Space-separated scopes. */
  scope: string;
  responseType?: string;
  grantType?: string;
  customHeaders?: Record<string, string>;
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_post"
    | "client_secret_basic";
  requireRefreshToken?: boolean;
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string | number>;
  /** Default `json`. Claude requires `form`. */
  tokenRequestFormat?: "json" | "form";
  /**
   * - `authorization-code` — redirect + paste code#state
   * - `device-code` — RFC 8628 form device code
   * - `openai-device-auth` — OpenAI proprietary JSON device-auth
   */
  grant: ProviderOAuthGrantKind;
  /** Persisted profile authType. Default `oauth`. */
  authType?: "oauth" | "device-code";
  deviceCodeUrl?: string;
  /** OpenAI device-auth poll URL only. */
  deviceTokenUrl?: string;
  deviceRedirectUri?: string;
  defaultVerificationUrl?: string;
  /**
   * When set (e.g. `"user_code"` for xAI), append this query param to the base
   * verification URL with the device user code so the approval page can prefill.
   * When omitted, leave the base URL alone unless the provider returned RFC
   * `verification_uri_complete`. ChatGPT's codex page does not document prefill.
   */
  verificationUserCodeParam?: string;
  pendingStatusCodes?: number[];
  includeScopeInRefresh?: boolean;
  accountIdClaimPath?: string;
  scopeEnvVar?: string;
  userAgent?: string;
}

export interface ProviderConfigEntry {
  /** Display name in settings page (e.g. "Groq") */
  displayName: string;
  /** Provider icon URL */
  iconUrl: string;
  /** Env var name for API key (e.g. "GROQ_API_KEY") */
  envVarName: string;
  /** Provider's API base URL (e.g. "https://api.groq.com/openai") */
  upstreamBaseUrl: string;
  /** HTML help text for the settings page API key input */
  apiKeyInstructions: string;
  /** Placeholder text for the API key input */
  apiKeyPlaceholder: string;
  /**
   * Optional subscription OAuth (Claude / ChatGPT / SuperGrok, etc.).
   * When set, the org inference-providers UI offers "Sign in" for this provider.
   */
  oauth?: ProviderOAuthConfig;
  /**
   * Wire protocol this provider speaks (see SDK_COMPAT_PROTOCOLS). "openai" for
   * OpenAI-compatible providers; "anthropic"/"google"/etc. for others. Omitted ⇒
   * not routable as a config-driven model.
   */
  sdkCompat?: SdkCompat;
  /**
   * Modalities this provider actually serves. Omitted ⇒ text only.
   * Gates which per-modality overrides are offered and (for STT) whether the
   * provider is a transcription candidate at all — an OpenAI-compatible chat
   * provider like Cerebras does NOT do speech-to-text, so it must not be listed
   * for `stt`. STT is enabled only when this list includes `"stt"` OR an
   * explicit `stt` block enables it (`enabled !== false`); there is no
   * "default on for openai-compatible" fallback. `image`/`tts` remain
   * additionally gated by their service allowlists; this list is the source of
   * truth for the UI + STT eligibility.
   */
  modalities?: ("text" | "image" | "stt" | "tts")[];
  /** Default model ID when none is configured */
  defaultModel?: string;
  /** Relative path to fetch model list (e.g. "/v1/models") */
  modelsEndpoint?: string;
  /**
   * Static fallback model IDs for the model picker, used when a provider has no
   * live `modelsEndpoint` (e.g. OAuth providers like Anthropic) or the live
   * fetch is empty/fails. Curated in `config/providers.json`; the live list
   * takes precedence when available, so this only needs to be roughly current.
   */
  models?: string[];
  /** Whether to show in "Add Provider" catalog (default: true) */
  catalogVisible?: boolean;
  /**
   * Optional speech-to-text configuration.
   * An enabled block declares STT even when `modalities` omits it. Without a
   * block, `modalities` must include `"stt"` to enable the default
   * endpoint/model.
   */
  stt?: {
    /** Set false to disable STT even when this block exists. */
    enabled?: boolean;
    /** STT protocol compatibility; currently only OpenAI-compatible is supported here. */
    sdkCompat?: "openai";
    /** Optional upstream base URL override for STT requests. */
    baseUrl?: string;
    /** Relative or absolute transcription endpoint path/URL. */
    transcriptionPath?: string;
    /** STT model ID (for OpenAI-compatible endpoints). */
    model?: string;
  };
}
