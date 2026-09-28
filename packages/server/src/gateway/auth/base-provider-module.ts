import { createLogger, type SdkCompat } from "@lobu/core";
import { Hono } from "hono";
import { resolveOrgId } from "../../lobu/stores/org-context.js";
import { readOrgSharedProviderApiKey } from "../../lobu/stores/provider-secrets.js";
import type { ProviderCredentialContext } from "../embedded.js";
import {
  BaseModule,
  type ModelProviderModule,
  type ProviderUpstreamConfig,
} from "../modules/module-system.js";
import { resolveUrlInvariant } from "./inference-invariant.js";
import { resolveEnv } from "./mcp/string-substitution.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";

const logger = createLogger("base-provider-module");

/**
 * Look up the org-shared API key for this provider (tier 2 of the resolution
 * chain — see provider-secrets.ts, which owns the actual lookup). The orgId
 * comes from one of two sources, in order:
 * 1. `context.organizationId` — set by the worker-spawn code path that
 *    threads the org id through `ProviderCredentialContext`.
 * 2. `tryGetOrgId()` — the AsyncLocalStorage-backed org context set by
 *    request middleware.
 *
 * Returns null when neither is set. Earlier revisions joined through
 * `agents WHERE id = agentId` to derive the org, which became ambiguous
 * once agent ids were per-org-unique.
 */
async function readOrgSharedProviderKey(
  providerId: string,
  context?: ProviderCredentialContext
): Promise<string | null> {
  const orgId = resolveOrgId(context?.organizationId);
  if (!orgId) return null;
  return readOrgSharedProviderApiKey(providerId, orgId);
}

interface BaseProviderConfig {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl: string;
  /** Env var name the SDK expects for the API credential (e.g. "ANTHROPIC_API_KEY") */
  credentialEnvVarName: string;
  /** All env vars this provider considers secrets */
  secretEnvVarNames: string[];
  /**
   * Subset of `secretEnvVarNames` holding Bearer/OAuth-style tokens (not API
   * keys). Used to classify a system-key credential's kind. Default: none.
   */
  bearerCredentialEnvVarNames?: string[];
  /** Env var to check for system key (defaults to credentialEnvVarName) */
  systemEnvVarName?: string;
  /** Provider slug for proxy path routing (e.g. "anthropic") */
  slug?: string;
  /** Upstream base URL for proxy forwarding (e.g. "https://api.anthropic.com") */
  upstreamBaseUrl?: string;
  /** Explicit base URL env var name (defaults to slug-derived name) */
  baseUrlEnvVarName?: string;
  /**
   * Header used to present an API-KEY credential to the upstream proxy.
   * `"x-api-key"` for Anthropic; omitted (Bearer) for OpenAI-compatible APIs.
   */
  apiKeyHeader?: "authorization" | "x-api-key";
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions?: string;
  apiKeyPlaceholder?: string;
  catalogDescription?: string;
  catalogVisible?: boolean;
  /** models.dev provider ID; defaults to `providerId`. */
  catalogProvider?: string;
  /** Wire protocol this provider speaks (see SDK_COMPAT_PROTOCOLS). */
  sdkCompat?: SdkCompat;
}

/**
 * Base class for model provider modules.
 * Implements shared logic: credential lookup, proxy mappings, env var injection,
 * and Hono app management. Save-key and logout routes are handled by the
 * parameterized auth router in gateway.ts.
 *
 * Subclasses provide a config object and optionally override:
 * - `setupRoutes(app)` to add provider-specific routes
 * - `getModelOptions()` for model listing
 * - `buildEnvVars()` for custom env var injection
 * - `hasSystemKey()` / `injectSystemKeyFallback()` for multi-env-var logic
 */
export abstract class BaseProviderModule
  extends BaseModule
  implements ModelProviderModule
{
  name: string;
  providerId: string;
  providerDisplayName: string;
  providerIconUrl: string;
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions?: string;
  apiKeyPlaceholder?: string;
  catalogDescription?: string;
  catalogVisible?: boolean;
  sdkCompat?: SdkCompat;
  /** models.dev provider identity; independent of the wire protocol. */
  catalogProvider?: string;

  protected readonly providerConfig: BaseProviderConfig;
  protected readonly authProfilesManager: AuthProfilesManager;
  protected readonly app: Hono;

  constructor(
    config: BaseProviderConfig,
    authProfilesManager: AuthProfilesManager
  ) {
    super();
    this.providerConfig = config;
    this.authProfilesManager = authProfilesManager;

    this.providerId = config.providerId;
    this.name = `${config.providerId}-provider`;
    this.providerDisplayName = config.providerDisplayName;
    this.providerIconUrl = config.providerIconUrl;
    this.authType = config.authType;
    this.supportedAuthTypes = config.supportedAuthTypes;
    this.apiKeyInstructions = config.apiKeyInstructions;
    this.apiKeyPlaceholder = config.apiKeyPlaceholder;
    this.catalogDescription = config.catalogDescription;
    this.catalogVisible = config.catalogVisible;
    this.catalogProvider = config.catalogProvider ?? config.providerId;
    this.sdkCompat = config.sdkCompat;

    this.app = new Hono();
    this.setupRoutes();
  }

  isEnabled(): boolean {
    return true;
  }

  getSecretEnvVarNames(): string[] {
    return this.providerConfig.secretEnvVarNames;
  }

  getBearerCredentialEnvVarNames(): string[] {
    return this.providerConfig.bearerCredentialEnvVarNames ?? [];
  }

  getCredentialEnvVarName(): string {
    return this.providerConfig.credentialEnvVarName;
  }

  getUpstreamConfig(): ProviderUpstreamConfig | null {
    const { slug, upstreamBaseUrl, baseUrlEnvVarName, apiKeyHeader } =
      this.providerConfig;
    if (!slug || !upstreamBaseUrl) return null;
    // Check env for base URL override (e.g., ANTHROPIC_BASE_URL=https://api.anthropic.com)
    const envOverride = baseUrlEnvVarName
      ? resolveEnv(baseUrlEnvVarName)
      : undefined;
    return { slug, upstreamBaseUrl: envOverride || upstreamBaseUrl, apiKeyHeader };
  }

  async hasCredentials(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<boolean> {
    // Keep this availability check aligned with resolveCredential(). An org
    // inference-provider row owns its key whether it uses the catalog URL or a
    // custom upstream; that key is intentionally absent from per-agent auth
    // profiles. Treat it as available so proxy-mode workers receive an opaque
    // credential placeholder and can reach the gateway, where the invariant
    // resolves the real key at egress. Conversely, a custom upstream with an
    // unavailable key must fail closed even when a profile exists, because
    // that profile is not consented for the custom URL.
    const invariant = await resolveUrlInvariant(
      this.providerId,
      resolveOrgId(context?.organizationId) ?? undefined
    );
    if (
      invariant.kind === "org-only" ||
      invariant.kind === "org-credential"
    ) {
      return true;
    }
    if (invariant.kind === "org-only-unavailable") return false;

    const hasProfile = await this.authProfilesManager.hasProviderProfiles(
      agentId,
      this.providerId,
      context
    );
    if (hasProfile) return true;
    // Mirror the resolution chain in `buildEnvVars`: when no per-user auth
    // profile exists, the org's inference-provider row key (written by
    // `lobu apply` / the console; row-unique vault name) is a valid credential
    // too. Without this, `lobu apply`-provisioned providers report no
    // credentials, so primary-provider detection (and thus the worker's
    // defaultProvider / model resolution) silently fails until the gateway is
    // restarted.
    return (await readOrgSharedProviderKey(this.providerId, context)) !== null;
  }

  hasSystemKey(): boolean {
    const envVar =
      this.providerConfig.systemEnvVarName ||
      this.providerConfig.credentialEnvVarName;
    return !!resolveEnv(envVar);
  }

  /**
   * Build the agent/user path suffix used for agent-scoped proxy routing.
   * Returns an empty string when no agentId is provided.
   */
  protected buildAgentScopedSuffix(
    agentId?: string,
    context?: ProviderCredentialContext
  ): string {
    if (!agentId) return "";
    const agentPath = `/a/${encodeURIComponent(agentId)}`;
    const orgPath = context?.organizationId
      ? `${agentPath}/o/${encodeURIComponent(context.organizationId)}`
      : agentPath;
    if (!context?.userId) return orgPath;
    return `${orgPath}/u/${encodeURIComponent(context.userId)}`;
  }

  protected buildAgentScopedProxyUrl(
    proxyUrl: string,
    slug: string,
    agentId?: string,
    context?: ProviderCredentialContext
  ): string {
    return `${proxyUrl}/${slug}${this.buildAgentScopedSuffix(agentId, context)}`;
  }

  getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string,
    context?: ProviderCredentialContext
  ): Record<string, string> {
    const { slug, baseUrlEnvVarName, credentialEnvVarName } =
      this.providerConfig;
    if (!slug) return {};
    const envVar =
      baseUrlEnvVarName || credentialEnvVarName.replace("_KEY", "_BASE_URL");
    return {
      [envVar]: this.buildAgentScopedProxyUrl(proxyUrl, slug, agentId, context),
    };
  }

  injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    const credVar = this.providerConfig.credentialEnvVarName;
    if (!envVars[credVar]) {
      const sysVar = this.providerConfig.systemEnvVarName || credVar;
      const systemKey = resolveEnv(sysVar);
      if (systemKey) {
        envVars[credVar] = systemKey;
      }
    }
    return envVars;
  }

  /**
   * Resolve a usable credential for the agent, applying the standard precedence:
   *   1. per-user auth profile (refreshed when a userId is in context)
   *   2. org-shared API key written by `lobu apply`
   *   3. system env var (only when `includeSystemEnv` is set)
   *
   * Returns the credential and which tier produced it, so callers can keep
   * their tier-specific logging. `buildEnvVars` omits the system-env tier (the
   * worker resolves that via `injectSystemKeyFallback`); `getCredential`
   * includes it.
   */
  private async resolveCredential(
    agentId: string,
    context: ProviderCredentialContext | undefined,
    opts: { includeSystemEnv: boolean }
  ): Promise<{
    credential: string;
    source: "profile" | "org" | "system";
  } | null> {
    // URL invariant (see inference-invariant.ts): if this org configured a
    // custom upstream for the provider, the request goes to a tenant-defined
    // URL and ONLY the org row's own key may be sent there — never a per-user
    // profile or a deployment env key. Short-circuit the normal chain.
    const invariant = await resolveUrlInvariant(
      this.providerId,
      resolveOrgId(context?.organizationId) ?? undefined
    );
    if (
      invariant.kind === "org-only" ||
      invariant.kind === "org-credential"
    ) {
      return { credential: invariant.credential, source: "org" };
    }
    if (invariant.kind === "org-only-unavailable") {
      // Custom upstream but no usable org key: fail CLOSED, do not fall through.
      return null;
    }

    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId,
      undefined,
      context
    );
    const profileCredential =
      profile && context?.userId
        ? await this.authProfilesManager.ensureFreshCredential(profile, {
            userId: context.userId,
            agentId,
          })
        : profile?.credential;
    if (profileCredential) {
      return { credential: profileCredential, source: "profile" };
    }

    const orgKey = await readOrgSharedProviderKey(this.providerId, context);
    if (orgKey) {
      return { credential: orgKey, source: "org" };
    }

    if (opts.includeSystemEnv) {
      const sysVar =
        this.providerConfig.systemEnvVarName ||
        this.providerConfig.credentialEnvVarName;
      const systemKey = process.env[sysVar];
      if (systemKey) {
        return { credential: systemKey, source: "system" };
      }
    }

    return null;
  }

  async buildEnvVars(
    agentId: string,
    envVars: Record<string, string>,
    context?: ProviderCredentialContext
  ): Promise<Record<string, string>> {
    const credVar = this.providerConfig.credentialEnvVarName;
    if (!envVars[credVar]) {
      const resolved = await this.resolveCredential(agentId, context, {
        includeSystemEnv: false,
      });
      if (resolved) {
        logger.info(
          resolved.source === "org"
            ? `Injecting ${credVar} for agent ${agentId} (${this.providerId}) from org-shared secret`
            : `Injecting ${credVar} for agent ${agentId} (${this.providerId})`
        );
        envVars[credVar] = resolved.credential;
      }
    }
    return envVars;
  }

  getApp(): Hono {
    return this.app;
  }

  protected async getCredential(
    agentId: string,
    context?: ProviderCredentialContext
  ): Promise<string | null> {
    const resolved = await this.resolveCredential(agentId, context, {
      includeSystemEnv: true,
    });
    return resolved?.credential ?? null;
  }

  /**
   * Build the proxy-mode credential placeholder. When available, use the signed
   * worker token so the egress proxy can bind the request to the worker's
   * agent/org claims instead of resolving org context from a per-org agent id.
   */
  buildCredentialPlaceholder(
    _agentId: string,
    context?: ProviderCredentialContext
  ): Promise<string> | string {
    return context?.workerToken || "lobu-proxy";
  }

  /** Override in subclasses to add provider-specific routes. */
  protected setupRoutes(): void {
    // Default: no extra routes
  }
}
