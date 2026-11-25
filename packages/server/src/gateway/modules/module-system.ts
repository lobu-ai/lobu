import type { SdkCompat } from "@lobu/core";
import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import { resolveEnv } from "../auth/mcp/string-substitution.js";
import type { ProviderCredentialContext } from "../embedded.js";

interface OrchestratorModule extends ModuleInterface {
  buildEnvVars(
    agentId: string,
    baseEnv: Record<string, string>,
    context?: ProviderCredentialContext
  ): Promise<Record<string, string>>;
}

export interface ProviderUpstreamConfig {
  slug: string;
  upstreamBaseUrl: string;
  /**
   * Header used to present an API-KEY credential to this upstream. Anthropic
   * requires `x-api-key` and 401s ("invalid bearer token") when an `sk-ant`
   * key is sent as `Authorization: Bearer` — which is the OpenAI-compatible
   * default every other provider uses. OAuth credentials always use
   * `Authorization: Bearer` regardless of this setting. Omit for Bearer.
   */
  apiKeyHeader?: "authorization" | "x-api-key";
}

/**
 * What a provider's own catalog says about one model. Every field is optional:
 * the module answers only what its catalog carries, and each is validated at
 * the consumer before it can overwrite a registry value.
 */
export interface ProviderModelMetadata {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

/** One model in a provider's own live listing, id WITHOUT a provider prefix. */
export interface ProviderModel {
  id: string;
  label: string;
}

/**
 * The credential a model listing is fetched with. `kind` decides how it is
 * presented upstream: an `oauth` token always rides `Authorization: Bearer`,
 * an `api-key` uses the provider's API-key header.
 */
export interface ModelListingCredential {
  value: string;
  kind: "api-key" | "oauth";
}

export interface ModelProviderModule extends OrchestratorModule {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl?: string;
  authType?: "oauth" | "device-code" | "api-key";
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions?: string;
  apiKeyPlaceholder?: string;
  catalogDescription?: string;
  catalogVisible?: boolean;
  /**
   * This provider's id in the models.dev catalog, used to drop deprecated and
   * non-text models from its live listing. Omitted ⇒ listing is unfiltered.
   */
  modelsDevId?: string;
  /**
   * Wire protocol this provider speaks (see SDK_COMPAT_PROTOCOLS). Lets the
   * catalog know a module's protocol uniformly — including OAuth modules like
   * Claude (anthropic) that aren't config-driven. Omitted ⇒ unknown/openai.
   */
  sdkCompat?: SdkCompat;
  getSecretEnvVarNames(): string[];
  getCredentialEnvVarName(): string;
  /**
   * Subset of `getSecretEnvVarNames()` whose values are Bearer/OAuth-style
   * tokens (e.g. `CLAUDE_CODE_OAUTH_TOKEN`) rather than API keys. Lets the
   * system-key resolver classify a resolved env credential as `"oauth"` so the
   * secret proxy presents it as `Authorization: Bearer`. Default: none.
   */
  getBearerCredentialEnvVarNames?(): string[];
  getUpstreamConfig?(): ProviderUpstreamConfig | null;
  hasCredentials(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<boolean>;
  hasSystemKey(): boolean;
  getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string,
    context?: ProviderCredentialContext
  ): Record<string, string>;
  injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string>;
  getApp?(): any;
  /**
   * The provider's own live model listing, fetched with `credential`. Resolves
   * `null` when listing needs a credential and none was given; throws when the
   * upstream fails. Only server-configured upstreams are ever contacted.
   */
  listModels?(
    credential: ModelListingCredential | null,
    signal: AbortSignal
  ): Promise<ProviderModel[] | null>;
  /**
   * The credential this module would list models with for an agent: the same
   * resolution chain as egress (profile → org key → system env when allowed).
   * Answers `null` when the org points the provider at a tenant upstream, since
   * a listing only ever contacts the server-configured one.
   */
  resolveModelListingCredential?(
    agentId: string,
    context: ProviderCredentialContext | undefined,
    opts: { includeSystemEnv: boolean }
  ): Promise<ModelListingCredential | null>;
  /**
   * Gateway-only capability lookup, consulted ONLY for a model the bundled
   * registry does not carry — a provider that shipped a new model since this
   * release. Never on the happy path: a registry hit answers without leaving
   * the process.
   */
  getModelMetadata?(
    agentId: string,
    modelId: string,
    context: ProviderCredentialContext
  ): Promise<ProviderModelMetadata | undefined>;
  buildCredentialPlaceholder?(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<string> | string;
}

export abstract class BaseModule implements OrchestratorModule {
  abstract name: string;
  abstract isEnabled(): boolean;

  async init(): Promise<void> {
    // no-op
  }

  registerEndpoints(_app: any): void {
    // no-op
  }

  async buildEnvVars(
    _agentId: string,
    baseEnv: Record<string, string>,
    _context?: ProviderCredentialContext
  ): Promise<Record<string, string>> {
    return baseEnv;
  }
}

/**
 * The deployment's system credential for a provider module, or undefined.
 *
 * Uses the module's `injectSystemKeyFallback`, which may inject into a
 * different env var than `credentialEnvVarName` (e.g. Claude injects
 * ANTHROPIC_API_KEY, not CLAUDE_CODE_OAUTH_TOKEN), so every secret env var
 * name is checked. The kind is classified by the SOURCE env var, not the
 * destination: a fallback may re-home a Bearer/OAuth token into an api-key var
 * (Claude copies ANTHROPIC_AUTH_TOKEN into ANTHROPIC_API_KEY), so the resolved
 * value is matched back to a declared bearer var to keep presenting it as
 * Bearer rather than x-api-key.
 */
export function resolveSystemCredential(
  mod: ModelProviderModule
): ModelListingCredential | undefined {
  const testEnv: Record<string, string> = {};
  mod.injectSystemKeyFallback(testEnv);
  const value =
    mod
      .getSecretEnvVarNames()
      .map((v) => testEnv[v])
      .find(Boolean) ?? testEnv[mod.getCredentialEnvVarName()];
  if (!value) return undefined;
  const isBearer = (mod.getBearerCredentialEnvVarNames?.() ?? []).some((v) => {
    const raw = resolveEnv(v);
    return !!raw && raw === value;
  });
  return { value, kind: isBearer ? "oauth" : "api-key" };
}

export function getOrchestratorModules(): OrchestratorModule[] {
  return moduleRegistry
    .getModules()
    .filter((m): m is OrchestratorModule => "buildEnvVars" in m);
}

export function getModelProviderModules(): ModelProviderModule[] {
  return moduleRegistry
    .getModules()
    .filter(
      (m): m is ModelProviderModule =>
        "providerId" in m && "getSecretEnvVarNames" in m
    );
}
