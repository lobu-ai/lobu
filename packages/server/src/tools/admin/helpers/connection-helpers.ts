/**
 * Shared helpers for connection-related admin tools.
 *
 * Used by manage_connections, manage_feeds, and manage_auth_profiles.
 */

import { getScopedConnectorDefinition } from '../../../catalog/connector-definitions';
import { oauthAccountOwnershipError } from '../../../authz/oauth-account-ownership';
import { getDb } from '../../../db/client';
import {
  type AuthProfileKind,
  type AuthProfileRow,
  browserSessionIsUsable,
  createAuthProfile,
  getAuthProfileBySlug,
  getAuthProfileById,
  getPrimaryAuthProfileForKind,
  normalizeAuthProfileSlug,
  normalizeAuthValues,
  resolveAuthProfileSlugToId,
  summarizeBrowserSessionAuthData,
  updateAuthProfile,
} from '../../../utils/auth-profiles';
import { createConnectToken } from '../../../utils/connect-tokens';
import { getConfiguredPublicGatewayUrl } from '../../../utils/public-origin';
import {
  readGrantedScopesFromAuthData,
  readRequestedScopesFromAuthData,
} from '../../../auth/oauth/scopes';
import { getWorkspaceRole } from '../../../utils/organization-access';
import { callerIsAdmin } from './db-helpers';
import { buildConnectionsUrl } from '../../../utils/url-builder';
import type { ToolContext } from '../../registry';
import { getOrgUrlContext } from '../../view-urls';
import { isAdminOrOwnerRole } from '../../access-control';
import { registerMcpOAuthClient } from '../../../mcp-proxy/client';
import type { McpOAuthMetadata } from '../../../mcp-proxy/types';

// ============================================
// Auth Schema Types
// ============================================

type OAuthAuthMethod = {
  type: 'oauth';
  provider: string;
  requiredScopes?: string[];
  optionalScopes?: string[];
  resource?: string;
  loginScopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  usePkce?: boolean;
  clientIdKey?: string;
  clientSecretKey?: string;
  setupInstructions?: string;
  loginProvisioning?: {
    autoCreateConnection?: boolean;
  };
};

type EnvKeyAuthMethod = {
  type: 'env_keys';
  required?: boolean;
  fields?: Array<{
    key: string;
    label?: string;
    description?: string;
    secret?: boolean;
    required?: boolean;
    example?: string;
  }>;
};

type BrowserAuthMethod = {
  type: 'browser';
  required?: boolean;
  description?: string;
};

type InteractiveAuthMethod = {
  type: 'interactive';
  required?: boolean;
  scope?: 'connection' | 'org';
  expectedArtifact?: 'qr' | 'code' | 'redirect' | 'prompt';
  timeoutSec?: number;
  description?: string;
};

type AuthSchema =
  | { methods?: Array<Record<string, unknown>> }
  | Record<string, unknown>
  | null
  | undefined;

// ============================================
// Auth Schema Helpers
// ============================================

function getAuthMethods(authSchema: AuthSchema): Array<Record<string, unknown>> {
  const methods = (authSchema as { methods?: unknown } | null)?.methods;
  return Array.isArray(methods) ? methods : [];
}

export function getOAuthMethods(authSchema: AuthSchema): OAuthAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is OAuthAuthMethod =>
      method.type === 'oauth' && typeof method.provider === 'string'
  );
}

export function getEnvKeyMethods(authSchema: AuthSchema): EnvKeyAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is EnvKeyAuthMethod => method.type === 'env_keys'
  );
}

export function getBrowserMethods(authSchema: AuthSchema): BrowserAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is BrowserAuthMethod => method.type === 'browser'
  );
}

export function getInteractiveMethods(authSchema: AuthSchema): InteractiveAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is InteractiveAuthMethod => method.type === 'interactive'
  );
}

export function getOAuthCredentialKeys(method: OAuthAuthMethod): {
  clientIdKey: string;
  clientSecretKey: string;
} {
  const providerUpper = method.provider.toUpperCase();
  return {
    clientIdKey:
      typeof method.clientIdKey === 'string' && method.clientIdKey.trim().length > 0
        ? method.clientIdKey
        : `${providerUpper}_CLIENT_ID`,
    clientSecretKey:
      typeof method.clientSecretKey === 'string' && method.clientSecretKey.trim().length > 0
        ? method.clientSecretKey
        : `${providerUpper}_CLIENT_SECRET`,
  };
}

/**
 * A selected app is authoritative: filling missing fields from deployment
 * credentials could substitute another client or pair one app's ID with
 * another app's secret. Use environment credentials only without an app profile.
 */
export function resolveOAuthAppClientCredentials(params: {
  appProfileAuthData: unknown;
  provider: string;
  clientIdKey?: string;
  clientSecretKey?: string;
}): { clientId: string | null; clientSecret: string | null } {
  const providerUpper = params.provider.toUpperCase();
  const clientIdKey =
    typeof params.clientIdKey === 'string' && params.clientIdKey.trim().length > 0
      ? params.clientIdKey
      : `${providerUpper}_CLIENT_ID`;
  const clientSecretKey =
    typeof params.clientSecretKey === 'string' && params.clientSecretKey.trim().length > 0
      ? params.clientSecretKey
      : `${providerUpper}_CLIENT_SECRET`;

  const authValues = normalizeAuthValues(params.appProfileAuthData ?? {
    [clientIdKey]: process.env[clientIdKey],
    [clientSecretKey]: process.env[clientSecretKey],
  });
  const clientId = authValues[clientIdKey] || null;
  const clientSecret = authValues[clientSecretKey] || null;
  return { clientId, clientSecret };
}

/**
 * Auto-provision an env-backed `oauth_app` profile from deployment env vars,
 * mirroring how GLOBAL LOGIN resolves its client (auth/config.ts
 * `resolveLoginProviderCredentials`: `process.env[clientIdKey]` fallback). The
 * connector OAuth-CONNECT path previously required a hand-created app profile
 * even when `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` were configured (the same
 * vars login already uses), failing with "Select or create an … app profile
 * first". This closes that gap: when the connector's `clientIdKey` /
 * `clientSecretKey` (defaulting to `${PROVIDER}_CLIENT_ID/_SECRET`) are present
 * in the environment AND no `oauth_app` profile exists for this connector, we
 * persist one so the existing connect + callback flow resolves the client with
 * zero manual entry.
 *
 * Idempotent + multi-replica safe: the profile is a Postgres row (upserted by
 * slug); a concurrent racer just upserts the same values. Returns the profile
 * when it resolved/created one, else null (env vars absent → caller falls back
 * to the original "create an app profile" message).
 */
export async function ensureEnvBackedOAuthAppProfile(params: {
  organizationId: string;
  connectorKey: string;
  connectorName: string;
  method: OAuthAuthMethod;
  createdBy?: string | null;
}): Promise<AuthProfileRow | null> {
  const { organizationId, connectorKey, method } = params;
  const provider = method.provider;

  // Already have an active app profile? Honor it (manual entry wins).
  const existingActive = await getPrimaryAuthProfileForKind({
    organizationId,
    connectorKey,
    profileKind: 'oauth_app',
    provider,
  });
  if (existingActive?.status === 'active') return existingActive;

  const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(method);
  const clientId = process.env[clientIdKey];
  const clientSecret = process.env[clientSecretKey];
  if (!clientId || !clientSecret) return null;

  const credentials = { [clientIdKey]: clientId, [clientSecretKey]: clientSecret };
  const slug = normalizeAuthProfileSlug(`${connectorKey}-${provider}-app`);
  const displayName = `${params.connectorName} ${provider[0]?.toUpperCase() ?? ''}${provider.slice(1)} App`;

  const existing = await getAuthProfileBySlug(organizationId, slug);
  if (existing) {
    await updateAuthProfile({
      organizationId,
      slug,
      displayName,
      authData: credentials,
      status: 'active',
      provider,
    });
    return getAuthProfileBySlug(organizationId, slug);
  }

  return createAuthProfile({
    organizationId,
    connectorKey,
    displayName,
    slug,
    profileKind: 'oauth_app',
    authData: credentials,
    provider,
    createdBy: params.createdBy ?? 'env',
  });
}

export function resolveRequestedOAuthScopes(
  method: OAuthAuthMethod,
  requestedScopes?: string[] | null
): string[] {
  const loginScopes = Array.isArray(method.loginScopes)
    ? method.loginScopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  const requiredScopes = Array.isArray(method.requiredScopes)
    ? method.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  const optionalScopes = new Set(
    Array.isArray(method.optionalScopes)
      ? method.optionalScopes.filter((scope): scope is string => typeof scope === 'string')
      : []
  );
  const requestedOptionalScopes = (requestedScopes ?? []).filter(
    (scope): scope is string => typeof scope === 'string' && optionalScopes.has(scope)
  );
  return Array.from(new Set([...loginScopes, ...requiredScopes, ...requestedOptionalScopes]));
}

export function buildOAuthConnectConfig(
  method: OAuthAuthMethod,
  requestedScopes?: string[] | null
): Record<string, unknown> {
  const authParams =
    method.authParams && typeof method.authParams === 'object'
      ? Object.fromEntries(
          Object.entries(method.authParams).filter(([, value]) => typeof value === 'string')
        )
      : undefined;

  return {
    provider: method.provider,
    scopes: resolveRequestedOAuthScopes(method, requestedScopes),
    ...getOAuthCredentialKeys(method),
    ...(typeof method.authorizationUrl === 'string'
      ? { authorizationUrl: method.authorizationUrl }
      : {}),
    ...(typeof method.tokenUrl === 'string' ? { tokenUrl: method.tokenUrl } : {}),
    ...(typeof method.userinfoUrl === 'string' ? { userinfoUrl: method.userinfoUrl } : {}),
    ...(authParams && Object.keys(authParams).length > 0 ? { authParams } : {}),
    ...(method.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: method.tokenEndpointAuthMethod }
      : {}),
    ...(typeof method.usePkce === 'boolean' ? { usePkce: method.usePkce } : {}),
    ...(typeof method.resource === 'string' ? { resource: method.resource } : {}),
  };
}

function splitAuthValuesBySchema(
  authSchema: AuthSchema,
  authValues: Record<string, string>
): {
  envValues: Record<string, string>;
  oauthAppProfiles: Array<{ provider: string; credentials: Record<string, string> }>;
} {
  const oauthProfiles: Array<{ provider: string; credentials: Record<string, string> }> = [];
  const claimedKeys = new Set<string>();

  for (const method of getOAuthMethods(authSchema)) {
    const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(method);
    const credentials: Record<string, string> = {};

    if (authValues[clientIdKey]) {
      credentials[clientIdKey] = authValues[clientIdKey];
      claimedKeys.add(clientIdKey);
    }
    if (authValues[clientSecretKey]) {
      credentials[clientSecretKey] = authValues[clientSecretKey];
      claimedKeys.add(clientSecretKey);
    }

    if (Object.keys(credentials).length > 0) {
      oauthProfiles.push({ provider: method.provider.toLowerCase(), credentials });
    }
  }

  const envValues = Object.fromEntries(
    Object.entries(authValues).filter(([key]) => !claimedKeys.has(key))
  );

  return { envValues, oauthAppProfiles: oauthProfiles };
}

// ============================================
// upsertConnectorAuthProfiles
// ============================================

export async function upsertConnectorAuthProfiles(params: {
  organizationId: string;
  connectorKey: string;
  connectorName: string;
  authSchema: AuthSchema;
  authValues: Record<string, string>;
  createdBy: string;
}): Promise<string[]> {
  const keysUpdated = new Set<string>();
  const { envValues, oauthAppProfiles } = splitAuthValuesBySchema(
    params.authSchema,
    params.authValues
  );

  for (const profile of oauthAppProfiles) {
    const profileSlug = normalizeAuthProfileSlug(`${params.connectorKey}-${profile.provider}-app`);
    const existing = await getAuthProfileBySlug(params.organizationId, profileSlug);
    if (existing) {
      await updateAuthProfile({
        organizationId: params.organizationId,
        slug: profileSlug,
        displayName: `${params.connectorName} ${profile.provider[0]?.toUpperCase() ?? ''}${profile.provider.slice(1)} App`,
        authData: profile.credentials,
        status: 'active',
        provider: profile.provider,
      });
    } else {
      await createAuthProfile({
        organizationId: params.organizationId,
        connectorKey: params.connectorKey,
        displayName: `${params.connectorName} ${profile.provider[0]?.toUpperCase() ?? ''}${profile.provider.slice(1)} App`,
        slug: profileSlug,
        profileKind: 'oauth_app',
        authData: profile.credentials,
        provider: profile.provider,
        createdBy: params.createdBy,
      });
    }
    for (const key of Object.keys(profile.credentials)) {
      keysUpdated.add(key);
    }
  }

  if (Object.keys(envValues).length > 0) {
    const profileSlug = normalizeAuthProfileSlug(`${params.connectorKey}-default`);
    const existing = await getAuthProfileBySlug(params.organizationId, profileSlug);
    if (existing) {
      await updateAuthProfile({
        organizationId: params.organizationId,
        slug: profileSlug,
        displayName: `${params.connectorName} Default`,
        authData: envValues,
        status: 'active',
      });
    } else {
      await createAuthProfile({
        organizationId: params.organizationId,
        connectorKey: params.connectorKey,
        displayName: `${params.connectorName} Default`,
        slug: profileSlug,
        profileKind: 'env',
        authData: envValues,
        createdBy: params.createdBy,
      });
    }
    for (const key of Object.keys(envValues)) {
      keysUpdated.add(key);
    }
  }

  return Array.from(keysUpdated);
}

// ============================================
// Shared Helpers
// ============================================

export function mapConnectionStatusToFeedStatus(status: string): 'active' | 'paused' {
  return status === 'active' ? 'active' : 'paused';
}

export function enrichWithAuthProfiles(
  row: Record<string, unknown>,
  authProfile: AuthProfileRow | null,
  appAuthProfile: AuthProfileRow | null
): Record<string, unknown> {
  return {
    ...row,
    auth_profile_slug: authProfile?.slug ?? null,
    auth_profile_name: authProfile?.display_name ?? null,
    auth_profile_status: authProfile?.status ?? null,
    app_auth_profile_slug: appAuthProfile?.slug ?? null,
    app_auth_profile_name: appAuthProfile?.display_name ?? null,
    app_auth_profile_status: appAuthProfile?.status ?? null,
  };
}

export function getConnectBaseUrl(ctx: ToolContext): string {
  const contextBase = ctx.baseUrl?.trim().replace(/\/+$/, '');
  if (contextBase) {
    try {
      const path = new URL(contextBase).pathname.replace(/\/+$/, '');
      if (path && path !== '/') return contextBase;
    } catch {
      return contextBase;
    }
  }

  const appBase = contextBase ?? (ctx.requestUrl ? new URL(ctx.requestUrl).origin : '');
  if (appBase) return new URL(appBase).origin.replace(/\/+$/, '');

  const configuredGateway = getConfiguredPublicGatewayUrl();
  return configuredGateway ? new URL(configuredGateway).origin.replace(/\/+$/, '') : '';
}

export function getGatewayBaseUrl(ctx: ToolContext): string {
  const contextBase = ctx.baseUrl?.trim().replace(/\/+$/, '');
  if (contextBase) {
    try {
      const path = new URL(contextBase).pathname.replace(/\/+$/, '');
      if (path && path !== '/') return contextBase;
    } catch {
      return contextBase;
    }
  }

  return (
    getConfiguredPublicGatewayUrl() ??
    contextBase ??
    (ctx.requestUrl ? new URL(ctx.requestUrl).origin : '')
  ).replace(/\/+$/, '');
}

/** Both connection edits and consent issuance must respect legacy grant bindings. */
async function oauthAppBindings(profile: AuthProfileRow): Promise<Set<number>> {
  const sql = getDb();
  const linked = await sql`
    SELECT app_auth_profile_id FROM connections
    WHERE organization_id = ${profile.organization_id} AND auth_profile_id = ${profile.id}
      AND deleted_at IS NULL AND app_auth_profile_id IS NOT NULL
  `;
  const ids = new Set(linked.map(row => Number(row.app_auth_profile_id)));
  const stored = profile.auth_data?.app_auth_profile_id;
  if (typeof stored === 'number') ids.add(stored);
  return ids;
}

/** Resolve account authorization without changing the app behind an existing grant. */
export async function resolveOAuthProfileApp(params: {
  ctx: ToolContext;
  connectorKey: string;
  method: OAuthAuthMethod;
  appAuthProfileSlug?: string;
  authProfile?: AuthProfileRow;
  /** The server has verified a public managed-auth offer for this connector. */
  allowManagedApp?: boolean;
}): Promise<{ appAuthProfile: AuthProfileRow | null } | { error: string }> {
  const { ctx, connectorKey, method, authProfile } = params;
  const sql = getDb();
  const appIds = authProfile ? await oauthAppBindings(authProfile) : new Set<number>();
  if (appIds.size > 1) {
    return { error: 'This account is linked to different OAuth apps. Use a separate account profile for each app before reconnecting.' };
  }
  const boundId = appIds.values().next().value;
  const selected = params.appAuthProfileSlug
    ? await getAuthProfileBySlug(ctx.organizationId, params.appAuthProfileSlug)
    : null;
  if (params.appAuthProfileSlug && !selected) return { error: 'The selected OAuth app was not found in this workspace.' };
  if (boundId && selected && selected.id !== boundId) {
    return { error: 'This account is already bound to a different OAuth app. Create a separate account profile to use another app; existing access has not changed.' };
  }
  let app = boundId ? await getAuthProfileById(ctx.organizationId, boundId) : selected;
  if (!app && !boundId) {
    const apps = await sql<AuthProfileRow>`
      SELECT * FROM auth_profiles
      WHERE organization_id = ${ctx.organizationId}
        AND profile_kind = 'oauth_app' AND status = 'active' AND LOWER(provider) = ${method.provider.toLowerCase()}
    `;
    const workspaceDefault = apps.find(row => row.is_default_for_connector && row.connector_key === connectorKey);
    app = workspaceDefault ?? (apps.length === 1 ? apps[0]! : null);
    if (!app && params.allowManagedApp) {
      app = await getPrimaryAuthProfileForKind({
        organizationId: ctx.organizationId,
        connectorKey,
        profileKind: 'oauth_app',
        provider: method.provider,
      });
    }
    if (!app && apps.length > 1) {
      return { error: 'Multiple OAuth apps are available. Choose app_auth_profile_slug explicitly or ask an administrator to set the workspace default.' };
    }
  }
  if (boundId || app) {
    if (!app || app.profile_kind !== 'oauth_app' || app.status !== 'active' ||
        app.provider?.toLowerCase() !== method.provider.toLowerCase()) {
      return { error: 'The selected OAuth app is unavailable. Ask an administrator to restore that app configuration before reconnecting.' };
    }
    if (
      !boundId &&
      !params.allowManagedApp &&
      (!app.is_default_for_connector || app.connector_key !== connectorKey) &&
      !(await callerIsAdmin(sql, ctx))
    ) {
      return { error: 'Members must use the workspace-default OAuth app. Ask an administrator to set the default before connecting your account.' };
    }
  }
  return { appAuthProfile: app };
}

export async function issueOAuthReconnectLink(params: {
  authProfile: AuthProfileRow;
  ctx: ToolContext;
  requestedScopes?: string[];
  connectionId?: number;
  appAuthProfileSlug?: string;
}): Promise<
  | { error: string }
  | {
      authProfile: AuthProfileRow;
      connectUrl: string;
      connectToken: string;
      expiresAt: string;
    }
> {
  const { authProfile, ctx } = params;
  const ownershipError = oauthAccountOwnershipError(authProfile, ctx.userId);
  if (ownershipError) return { error: ownershipError };
  if (
    authProfile.profile_kind !== 'oauth_account' ||
    !authProfile.provider ||
    !authProfile.connector_key
  ) {
    return {
      error: `Auth profile '${authProfile.slug}' is not a reconnectable OAuth account profile`,
    };
  }

  const connector = await getScopedConnectorDefinition({
    organizationId: ctx.organizationId,
    connectorKey: authProfile.connector_key,
  });
  if (!connector) {
    return {
      error: `Connector '${authProfile.connector_key}' not found or not active`,
    };
  }

  const provider = authProfile.provider.toLowerCase();
  const oauthMethod = getOAuthMethods(connector.auth_schema).find(
    (method) => method.provider.toLowerCase() === provider
  );
  if (!oauthMethod) {
    return {
      error: `Connector '${authProfile.connector_key}' no longer supports OAuth provider '${authProfile.provider}'`,
    };
  }

  const sql = getDb();
  if (params.connectionId) {
    const owned = await sql`
      SELECT 1 FROM connections
      WHERE organization_id = ${ctx.organizationId} AND id = ${params.connectionId}
        AND auth_profile_id = ${authProfile.id} AND deleted_at IS NULL
        AND created_by = ${ctx.userId}
    `;
    if (owned.length !== 1) {
      return { error: 'Connection does not use this OAuth account profile.' };
    }
  }
  const appSelection = await resolveOAuthProfileApp({ ctx, connectorKey: authProfile.connector_key,
    method: oauthMethod, appAuthProfileSlug: params.appAuthProfileSlug, authProfile });
  if ('error' in appSelection) return appSelection;
  const appAuthProfileId = appSelection.appAuthProfile?.id;
  // A pending attempt must not change the requirements of a usable grant.
  // Keep selected scopes on the token; the callback commits them with credentials.
  const requestedScopes = Array.from(new Set([
    ...readGrantedScopesFromAuthData(authProfile.auth_data),
    ...resolveRequestedOAuthScopes(oauthMethod, [
      ...readRequestedScopesFromAuthData(authProfile.auth_data),
      ...(params.requestedScopes ?? []),
    ]),
  ]));

  const connectToken = await createConnectToken({
    organizationId: ctx.organizationId,
    authProfileId: authProfile.id,
    connectionId: params.connectionId,
    connectorKey: authProfile.connector_key,
    authType: 'oauth',
    authConfig: {
      ...buildOAuthConnectConfig(oauthMethod, requestedScopes),
      // Ask for every scope the account already holds, including ones the
      // connector no longer declares — `resolveRequestedOAuthScopes` filters
      // those out, and consenting without them would downgrade the grant.
      scopes: requestedScopes,
      requestedScopes,
      ...(appAuthProfileId ? { appAuthProfileId } : {}),
    },
    createdBy: ctx.userId,
  });

  return {
    authProfile,
    connectUrl: `${getConnectBaseUrl(ctx)}/connect/${connectToken.token}/oauth/start`,
    connectToken: connectToken.token,
    expiresAt: new Date(connectToken.expires_at).toISOString(),
  };
}

export async function buildViewUrl(
  ctx: ToolContext,
  connectorKey?: string | null
): Promise<string | undefined> {
  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  if (!ownerSlug || !baseUrl) return undefined;
  return buildConnectionsUrl(ownerSlug, baseUrl, connectorKey);
}

/**
 * Default visibility for a newly created connection.
 *
 * A connection reads through ONE org-level credential (its auth profile's
 * token), not a per-reader credential — so an `org`-visible connection lets
 * EVERY org member read live through the connection owner's token. For a
 * personal login (`profile_kind === 'oauth_account'` — a user's own Gmail /
 * calendar / etc.) that means org-visible = the owner's private inbox exposed to
 * the whole org. So a personal-credential connection defaults to `private`
 * regardless of the creator's role — the credential being personal is a stronger
 * fact than "an admin made it". Every other credential kind (env secrets,
 * oauth_app client creds, service accounts, browser sessions) backs a genuinely
 * shared source, so it keeps the role-based default (admins/owners → `org`,
 * members → `private`).
 */
export async function resolveConnectionVisibility(
  organizationId: string,
  userId?: string | null,
  profileKind?: string | null
): Promise<'org' | 'private'> {
  // Personal login → private, whatever the role. Checked BEFORE the role gate so
  // an admin attaching their own Gmail still defaults private.
  if (isPersonalCredentialKind(profileKind)) return 'private';
  if (!userId) return 'org';
  const sql = getDb();
  const role = await getWorkspaceRole(sql, organizationId, userId);
  return isAdminOrOwnerRole(role) ? 'org' : 'private';
}

/**
 * Is this auth-profile kind a PERSONAL credential — a single user's own login
 * whose token is not something the whole org should read through? Today only
 * `oauth_account` (a user's own Gmail/calendar/etc. grant). Every other kind
 * (env secrets, oauth_app client creds, service accounts, browser sessions)
 * backs a genuinely shared source.
 *
 * A connection reads through ONE org-level credential, so an `org`-visible
 * connection on a personal credential exposes that user's private data to every
 * org member. This predicate is the single source of truth for "personal
 * credential ⇒ must default private", used at create AND at every later point a
 * connection can become personal-credential-backed (OAuth callback attach,
 * update re-point).
 */
export function isPersonalCredentialKind(profileKind?: string | null): boolean {
  return profileKind === 'oauth_account';
}

/**
 * Explain the agent-ownership boundary of a personal connection.
 *
 * Chat-triggered runs resolve connections as the AGENT OWNER, never the message
 * sender (`workspace/multi-tenant.ts` selects `owner_user_id FROM agents`), and
 * a private connection is visible only via `created_by = principal`
 * (`authz/connection-visibility.ts`). So when a member connects their own
 * Gmail/calendar and then DMs an agent someone ELSE owns, the credential
 * lookup returns ZERO ROWS — not an error. The agent simply behaves as if the
 * connection does not exist, which is indistinguishable from "the agent chose
 * not to use it".
 *
 * Forcing personal credentials to `private` is correct and is NOT changed here
 * (org-visible would expose that user's inbox org-wide). This only makes the
 * consequence legible at connect time instead of silent at run time.
 */
export function personalConnectionScopeWarning(params: {
  visibility: 'org' | 'private';
  profileKind?: string | null;
}): string | undefined {
  if (params.visibility !== 'private') return undefined;
  if (!isPersonalCredentialKind(params.profileKind)) return undefined;
  return (
    'This personal connection is private to you. Agent runs resolve connections as ' +
    'the AGENT OWNER, not the person who sent the message — so only agents YOU own ' +
    'can use it. When you message an agent owned by another member, the lookup ' +
    'returns nothing and the agent behaves as if this connection does not exist.'
  );
}

/** The message the DB guard trigger raises when a personal-credential connection
 * is written with visibility='org'. Matched to translate the raw DB exception
 * into a clean tool error. Kept in sync with the migration
 * `20260703200000_connection_personal_cred_private_guard.sql`. */
export const PERSONAL_CRED_ORG_VISIBILITY_ERROR =
  'A personal-credential (oauth_account) connection cannot be org-visible — set its visibility to private.';

/** Does this DB error come from the personal-credential visibility guard trigger?
 * The trigger raises the distinctive substring under the check_violation SQLSTATE
 * (23514). We require BOTH the code AND the substring: 23514 alone is shared by
 * every real CHECK constraint (too broad), and the substring pins it to this
 * trigger. Lets any write path surface a friendly 400 instead of a raw 500. */
export function isPersonalCredVisibilityViolation(err: unknown): boolean {
  const e = err as { message?: string; code?: string };
  return e?.code === '23514' && (e?.message ?? '').includes('cannot be org-visible');
}

export async function resolveConnectionDisplayName(params: {
  explicitName?: string | null;
  connectorName: string;
  username?: string | null;
}): Promise<string> {
  if (params.explicitName?.trim()) return params.explicitName.trim();

  if (params.username) return `${params.connectorName} (${params.username})`;
  return params.connectorName;
}

// ============================================
// Auth Selection
// ============================================

interface AuthSelectionResult {
  selectedKind: 'none' | AuthProfileKind;
  authProfile: AuthProfileRow | null;
  appAuthProfile: AuthProfileRow | null;
  oauthMethod: OAuthAuthMethod | null;
  envMethod: EnvKeyAuthMethod | null;
  browserMethod: BrowserAuthMethod | null;
  preferredMethodType: 'none' | 'oauth' | 'env_keys' | 'browser';
}

function getPreferredAuthMethodType(
  authSchema: AuthSchema
): AuthSelectionResult['preferredMethodType'] {
  for (const method of getAuthMethods(authSchema)) {
    if (method.type === 'oauth' || method.type === 'env_keys' || method.type === 'browser') {
      return method.type;
    }
  }
  return 'none';
}

const EMPTY_SELECTION = (params: {
  oauthMethod: OAuthAuthMethod | null;
  envMethod: EnvKeyAuthMethod | null;
  browserMethod: BrowserAuthMethod | null;
  preferredMethodType?: AuthSelectionResult['preferredMethodType'];
}): AuthSelectionResult => ({
  selectedKind: 'none',
  authProfile: null,
  appAuthProfile: null,
  oauthMethod: params.oauthMethod,
  envMethod: params.envMethod,
  browserMethod: params.browserMethod,
  preferredMethodType: params.preferredMethodType ?? 'none',
});

export async function resolveConnectionAuthSelection(params: {
  organizationId: string;
  connectorKey: string;
  authSchema:
    | { methods?: Array<Record<string, unknown>> }
    | Record<string, unknown>
    | null
    | undefined;
  authProfileSlug?: string | null;
  appAuthProfileSlug?: string | null;
  deviceWorkerId?: string | null;
  oauthAccountCreatedBy?: string | null;
  /** Updates retaining no account must not select an unrelated primary profile. */
  autoSelectAuthProfile?: boolean;
}): Promise<AuthSelectionResult> {
  const { organizationId, connectorKey } = params;
  const oauthMethod = getOAuthMethods(params.authSchema)[0] ?? null;
  const envMethod = getEnvKeyMethods(params.authSchema)[0] ?? null;
  const browserMethod = getBrowserMethods(params.authSchema)[0] ?? null;
  const preferredMethodType = getPreferredAuthMethodType(params.authSchema);

  // 0. An explicit app profile slug points at an `oauth_app` (local client
  //    credentials). Resolve it once so it can be honored as the oauth_account
  //    app profile (step 2).
  const explicitAppProfile = params.appAuthProfileSlug
    ? await resolveAuthProfileSlugToId({
        organizationId,
        slug: params.appAuthProfileSlug,
        connectorKey,
      })
    : null;

  if (params.appAuthProfileSlug && explicitAppProfile?.profile_kind !== 'oauth_app') {
    throw new Error('The selected OAuth app was not found for this connector.');
  }

  // 1. Resolve explicitly selected auth profile, or auto-select the primary
  //    auth profile for the connector's preferred auth method.
  const authProfile =
    (await resolveAuthProfileSlugToId({
      organizationId,
      slug: params.authProfileSlug,
      connectorKey,
    })) ??
    (params.autoSelectAuthProfile !== false && preferredMethodType === 'env_keys' && envMethod
      ? await getPrimaryAuthProfileForKind({ organizationId, connectorKey, profileKind: 'env' })
      : null) ??
    (params.autoSelectAuthProfile !== false && preferredMethodType === 'browser' && browserMethod
      ? await getPrimaryAuthProfileForKind({
          organizationId,
          connectorKey,
          profileKind: 'browser_session',
          deviceWorkerId: params.deviceWorkerId ?? null,
        })
      : null) ??
    (params.autoSelectAuthProfile !== false && preferredMethodType === 'oauth' && oauthMethod
      ? await getPrimaryAuthProfileForKind({
          organizationId,
          connectorKey,
          profileKind: 'oauth_account',
          provider: oauthMethod.provider,
          createdBy: params.oauthAccountCreatedBy,
        })
      : null);

  if (!authProfile) {
    return {
      ...EMPTY_SELECTION({ oauthMethod, envMethod, browserMethod, preferredMethodType }),
      appAuthProfile: explicitAppProfile,
    };
  }

  // 2. For OAuth accounts, also resolve the app credentials profile. Step 0
  //    already rejected an explicit slug that is not an `oauth_app` (local
  //    client credentials), so it can be honored as-is here.
  const needsAppAuth = authProfile.profile_kind === 'oauth_account' || !!params.appAuthProfileSlug;
  let appAuthProfile = needsAppAuth
    ? (explicitAppProfile ??
      (oauthMethod && authProfile.profile_kind === 'oauth_account'
        ? await getPrimaryAuthProfileForKind({
            organizationId,
            connectorKey,
            profileKind: 'oauth_app',
            provider: oauthMethod.provider,
          })
        : null))
    : null;

  const boundAppIds = authProfile.profile_kind === 'oauth_account'
    ? await oauthAppBindings(authProfile) : new Set<number>();
  if (boundAppIds.size > 1) {
    throw new Error('This account is linked to different OAuth apps. Use a separate account profile for each app.');
  }
  const boundAppId = boundAppIds.values().next().value;
  if (typeof boundAppId === 'number') {
    if (explicitAppProfile && explicitAppProfile.id !== boundAppId) {
      throw new Error('This account is already bound to a different OAuth app. Use a separate account profile for another app.');
    }
    appAuthProfile = await getAuthProfileById(organizationId, boundAppId);
  }

  return {
    selectedKind: authProfile.profile_kind,
    authProfile,
    appAuthProfile,
    oauthMethod,
    envMethod,
    browserMethod,
    preferredMethodType,
  };
}

// ============================================
// Serialization
// ============================================

export function serializeAuthProfile(authProfile: AuthProfileRow): Record<string, unknown> {
  const browserSummary =
    authProfile.profile_kind === 'browser_session'
      ? summarizeBrowserSessionAuthData(authProfile.auth_data, authProfile.connector_key)
      : null;

  return {
    id: authProfile.id,
    organization_id: authProfile.organization_id,
    slug: authProfile.slug,
    display_name: authProfile.display_name,
    connector_key: authProfile.connector_key,
    profile_kind: authProfile.profile_kind,
    status: authProfile.status,
    provider: authProfile.provider,
    created_by: authProfile.created_by,
    created_at: authProfile.created_at,
    updated_at: authProfile.updated_at,
    device_worker_id: authProfile.device_worker_id,
    browser_kind: authProfile.browser_kind,
    is_default_for_connector: authProfile.is_default_for_connector,
    ...(authProfile.profile_kind === 'oauth_account'
      ? {
          requested_scopes: readRequestedScopesFromAuthData(authProfile.auth_data),
          granted_scopes: readGrantedScopesFromAuthData(authProfile.auth_data),
        }
      : {}),
    ...(browserSummary ?? {}),
    ...(authProfile.profile_kind === 'browser_session'
      ? {
          has_auth_data:
            browserSessionIsUsable(authProfile.auth_data, authProfile.connector_key),
        }
      : {}),
  };
}

// ============================================
// Post-install Auth Upsert
// ============================================

export async function maybeUpsertAuthAfterInstall(
  installed: {
    connectorKey: string;
    name: string;
    authSchema: AuthSchema;
    mcpOAuth?: McpOAuthMetadata;
  },
  authValues: Record<string, string> | undefined,
  ctx: ToolContext
): Promise<void> {
  const normalized = normalizeAuthValues(authValues ?? {});
  if (Object.keys(normalized).length > 0) {
    await upsertConnectorAuthProfiles({
      organizationId: ctx.organizationId,
      connectorKey: installed.connectorKey,
      connectorName: installed.name,
      authSchema: installed.authSchema,
      authValues: normalized,
      createdBy: ctx.userId ?? 'api',
    });
  }

  const oauthMetadata = installed.mcpOAuth;
  if (!oauthMetadata?.registrationUrl) return;

  const oauthMethod = getOAuthMethods(installed.authSchema)[0];
  if (!oauthMethod) {
    throw new Error('OAuth-protected MCP connector is missing its OAuth auth method');
  }

  const callbackBase = getConnectBaseUrl(ctx);
  if (!callbackBase) {
    throw new Error('A public Lobu callback URL is required to register the MCP OAuth client');
  }
  const redirectUri = `${callbackBase}/connect/oauth/callback`;
  const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(oauthMethod);
  const provider = oauthMethod.provider.toLowerCase();
  const sql = getDb();

  // The connector-definition row is the existing durable install chokepoint.
  // Lock it while checking/creating the one org-scoped dynamic client so two
  // replicas cannot both register separate provider clients for one connector.
  await sql.begin(async (tx) => {
    const connectorRows = await tx`
      SELECT id
      FROM connector_definitions
      WHERE organization_id = ${ctx.organizationId}
        AND key = ${installed.connectorKey}
        AND status = 'active'
      FOR UPDATE
    `;
    if (connectorRows.length === 0) {
      throw new Error(`Installed connector '${installed.connectorKey}' was not found`);
    }

    const existingRows = await tx`
      SELECT id
      FROM auth_profiles
      WHERE organization_id = ${ctx.organizationId}
        AND connector_key = ${installed.connectorKey}
        AND profile_kind = 'oauth_app'
        AND status = 'active'
        AND lower(provider) = ${provider}
      LIMIT 1
    `;
    if (existingRows.length > 0) return;

    const registration = await registerMcpOAuthClient({
      metadata: oauthMetadata,
      redirectUris: [redirectUri],
      clientName: `Lobu - ${installed.name}`,
    });
    if (!registration) return;

    await createAuthProfile(
      {
        organizationId: ctx.organizationId,
        connectorKey: installed.connectorKey,
        displayName: `${installed.name} OAuth App`,
        slug: normalizeAuthProfileSlug(`${installed.connectorKey}-${provider}-app`),
        profileKind: 'oauth_app',
        authData: {
          [clientIdKey]: registration.clientId,
          ...(registration.clientSecret
            ? { [clientSecretKey]: registration.clientSecret }
            : {}),
        },
        provider,
        createdBy: ctx.userId ?? 'api',
      },
      tx
    );
  });
}
