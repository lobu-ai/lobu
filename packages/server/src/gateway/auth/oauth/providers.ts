/**
 * Subscription OAuth provider registry — loaded from config at boot.
 *
 * Source of truth: optional `oauth` blocks on entries in `config/providers.json`
 * (via {@link loadOAuthProvidersFromConfigs}). Runtime code never hard-codes
 * provider ids or endpoints; it only looks up rows here.
 */

import type {
  ProviderConfigEntry,
  ProviderOAuthConfig,
  ProviderOAuthGrantKind,
} from "@lobu/core";
import { createLogger } from "@lobu/core";

export type OAuthGrantKind = ProviderOAuthGrantKind;

/** Runtime OAuth config: parent provider id/name + wire fields from JSON. */
export type OAuthProviderConfig = ProviderOAuthConfig & {
  id: string;
  name: string;
};

const logger = createLogger("oauth-provider-registry");

const VALID_GRANTS = new Set<OAuthGrantKind>([
  "authorization-code",
  "device-code",
  "openai-device-auth",
]);
const VALID_AUTH_TYPES = new Set(["oauth", "device-code"]);

/** Mutable registry filled by {@link loadOAuthProvidersFromConfigs} at boot. */
let registry: Map<string, OAuthProviderConfig> = new Map();

/**
 * Replace the OAuth registry from provider-config entries that declare `oauth`.
 * Called once during gateway boot after `providers.json` is loaded.
 * Invalid entries are skipped (logged) so one bad block cannot take down boot.
 */
export function loadOAuthProvidersFromConfigs(
  configs: Record<string, ProviderConfigEntry>,
): OAuthProviderConfig[] {
  const next = new Map<string, OAuthProviderConfig>();
  for (const [id, entry] of Object.entries(configs)) {
    const oauth = entry.oauth;
    if (!oauth) continue;
    const err = validateOAuthBlock(oauth);
    if (err) {
      logger.error(
        { providerId: id, err },
        "Skipping invalid oauth block in providers.json",
      );
      continue;
    }
    next.set(id, {
      ...oauth,
      id,
      name: entry.displayName || id,
    });
  }
  registry = next;
  return listOAuthProviders();
}

function validateOAuthBlock(oauth: ProviderOAuthConfig): string | null {
  if (!oauth.clientId?.trim()) return "missing clientId";
  if (!oauth.tokenUrl?.trim()) return "missing tokenUrl";
  if (!oauth.scope?.trim()) return "missing scope";
  if (!oauth.grant || !VALID_GRANTS.has(oauth.grant)) {
    return `invalid grant (got ${String(oauth.grant)})`;
  }
  if (oauth.authType && !VALID_AUTH_TYPES.has(oauth.authType)) {
    return `invalid authType (got ${String(oauth.authType)})`;
  }
  if (
    oauth.grant === "authorization-code" &&
    (!oauth.authUrl?.trim() || !oauth.redirectUri?.trim())
  ) {
    return "authorization-code requires authUrl and redirectUri";
  }
  if (oauth.grant === "device-code" && !oauth.deviceCodeUrl?.trim()) {
    return "device-code requires deviceCodeUrl";
  }
  if (
    oauth.grant === "openai-device-auth" &&
    (!oauth.deviceCodeUrl?.trim() || !oauth.deviceTokenUrl?.trim())
  ) {
    return "openai-device-auth requires deviceCodeUrl and deviceTokenUrl";
  }
  return null;
}

/** Test / advanced: set the registry directly. */
export function setOAuthProviderRegistry(
  providers: readonly OAuthProviderConfig[],
): void {
  registry = new Map(providers.map((p) => [p.id, p]));
}

export function clearOAuthProviderRegistry(): void {
  registry = new Map();
}

export function listOAuthProviders(): OAuthProviderConfig[] {
  return [...registry.values()];
}

export function getOAuthProviderConfig(
  id: string,
): OAuthProviderConfig | undefined {
  return registry.get(id);
}

/** id → config snapshot for route allowlists. */
export function getOAuthProviderConfigs(): Readonly<
  Record<string, OAuthProviderConfig>
> {
  return Object.fromEntries(registry);
}

export function resolveOAuthScope(config: OAuthProviderConfig): string {
  if (config.scopeEnvVar) {
    const fromEnv = process.env[config.scopeEnvVar]?.trim();
    if (fromEnv) return fromEnv;
  }
  return config.scope;
}
