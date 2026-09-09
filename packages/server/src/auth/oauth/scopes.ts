/**
 * OAuth Scope Constants and Helpers
 *
 * Single source of truth for OAuth scope definitions and the helper utilities
 * that normalize, compare, and persist scope lists across auth_data records.
 */

/** All available scopes (including device-flow-only grants). */
export const AVAILABLE_SCOPES = [
  'mcp:read',
  'mcp:write',
  'mcp:admin',
  'profile:read',
  'device_worker:run',
  // Least-privilege scope for the managed-connector runtime token fetch
  // (POST /oauth/connection-token). Deliberately NOT in DEFAULT_SCOPES so a
  // broad member PAT cannot mint managed-connection access tokens — the local
  // instance's LOBU_CLOUD_PAT must be minted explicitly with this scope
  // (`lobu token create --scope connections:token`).
  'connections:token',
] as const;

/**
 * Scopes that must not appear in AS/PRM `scopes_supported` and must never be
 * granted on the authorization-code consent path.
 *
 * Third-party MCP clients (Slack, Claude Desktop, Cursor, …) often request
 * every scope listed in discovery. Advertising these device-flow-only scopes there
 * caused Slack to ask for `device_worker:run`, which the auth-code consent
 * handler correctly refused.
 *
 * These are high-privilege, explicitly user-consented device-code scopes. DCR
 * does not authenticate an app as first-party, so the issuing grant type—not
 * client-supplied name/software metadata—is the enforceable boundary.
 *
 * - `device_worker:run` — personal device workers only (device-code grant).
 * - `connections:token` — device-code grant or an explicitly minted PAT;
 *   never authorization-code tokens.
 */
export const NON_PUBLIC_OAUTH_SCOPES = ['device_worker:run', 'connections:token'] as const;

/**
 * Scopes advertised via OAuth discovery (RFC 8414 / RFC 9728).
 * Subset of AVAILABLE_SCOPES that third-party auth-code clients may receive.
 */
export const DISCOVERY_SCOPES = AVAILABLE_SCOPES.filter(
  (scope) => !(NON_PUBLIC_OAUTH_SCOPES as readonly string[]).includes(scope)
) as readonly string[];

/** Default scopes for MCP access */
export const DEFAULT_SCOPES = ['mcp:read', 'mcp:write'] as const;

/**
 * Scopes a Personal Access Token may be minted with (POST /api/:orgSlug/tokens).
 *
 * `device_worker:run` is deliberately excluded — it is only granted via the
 * device-flow consent. `connections:token` lets a PAT call
 * POST /oauth/connection-token to fetch a managed connector's access token
 * (the local instance's LOBU_CLOUD_PAT is minted with it); mintable here, but
 * NOT a default scope.
 */
export const AVAILABLE_PAT_SCOPES = [
  'mcp:read',
  'mcp:write',
  'mcp:admin',
  'profile:read',
  'connections:token',
] as const;

/**
 * The least-privilege scope a token must carry to fetch a managed connector's
 * access token via POST /oauth/connection-token.
 *
 * It is granted ONLY on an explicitly approved device-code grant, and
 * only when that grant EXPLICITLY REQUESTS it (the CLI now includes
 * `connections:token` in the scope it sends to the device-authorization
 * endpoint; see `packages/cli/src/internal/oauth.ts`). The device-approve
 * handler grants exactly the requested scope — it is NOT auto-appended.
 *
 * It is NEVER granted on the generic authorization-code consent path (the one
 * arbitrary third-party MCP clients use — Claude Desktop, Cursor, …), and it is
 * never silently widened onto any device client that did not request it. A
 * non-interactive PAT (`lobu token create`) likewise does NOT get it by
 * default; it must be requested explicitly (`--scope connections:token`). This
 * keeps a broad `mcp` CI PAT — or any DCR-registered device client — from
 * minting managed-connection tokens, so the endpoint gate stays meaningful.
 */
export const CONNECTIONS_TOKEN_SCOPE = 'connections:token';

/**
 * The scopes an MCP host should ask for when it connects.
 *
 * A host may call /oauth/userinfo before it initializes MCP, so identity has
 * to ride the connection request. Not every host builds that request from
 * discovery — some ask only for what the resource states it needs — so
 * `profile:read` is advertised on the bearer challenge and on published tool
 * metadata too, not just in `scopes_supported`.
 *
 * This shapes the REQUEST only: consent and issuance still grant exactly the
 * permissions that were explicitly requested, and no existing token is widened.
 */
export function getMcpConnectionScopes(scopes: readonly string[]): string[] {
  return [...new Set([...scopes, 'profile:read'])];
}

/** Default scopes as a space-separated string (for OAuth params) */
export const DEFAULT_SCOPES_STRING = DEFAULT_SCOPES.join(' ');

const MCP_SCOPE_RANK = new Map<string, number>([
  ['mcp:read', 0],
  ['mcp:write', 1],
  ['mcp:admin', 2],
]);

/**
 * Normalize a requested scope string and reject unknown values at the OAuth
 * boundary. Unknown scopes used to survive storage and disappear only when a
 * token was used, which made consent promise access the token did not carry.
 */
export function normalizeOAuthScopeRequest(
  scope: string | undefined | null,
  allowedScopes: readonly string[] = AVAILABLE_SCOPES
): string | null {
  const normalized = normalizeScopeList(scope);
  if (normalized.length === 0) return null;
  const allowed = new Set(allowedScopes);
  if (normalized.some((value) => !allowed.has(value))) return null;
  return normalized.join(' ');
}

/**
 * True when a consent-time scope choice is no more powerful than the original
 * request. MCP scopes are hierarchical: admin includes write and read, while
 * write includes read. Non-MCP capabilities must be exact requested members.
 */
export function isOAuthScopeGrantWithinRequest(
  requestedScope: string | undefined | null,
  grantedScope: string | undefined | null
): boolean {
  const requested = normalizeScopeList(requestedScope);
  const granted = normalizeScopeList(grantedScope);
  if (requested.length === 0 || granted.length === 0) return false;

  const available = new Set<string>(AVAILABLE_SCOPES);
  if (requested.some((scope) => !available.has(scope))) return false;
  if (granted.some((scope) => !available.has(scope))) return false;

  const highestMcpRank = (scopes: readonly string[]) => {
    let rank = -1;
    for (const scope of scopes) {
      const candidate = MCP_SCOPE_RANK.get(scope);
      if (candidate !== undefined && candidate > rank) rank = candidate;
    }
    return rank;
  };

  if (highestMcpRank(granted) > highestMcpRank(requested)) return false;
  const requestedSet = new Set(requested);
  return granted.every((scope) => MCP_SCOPE_RANK.has(scope) || requestedSet.has(scope));
}

/** Persist MCP grants in the same explicit hierarchy the UI displays. */
export function canonicalizeOAuthScopeGrant(scope: string): string {
  const normalized = normalizeScopeList(scope);
  const highestMcpRank = normalized.reduce((rank, value) => {
    const candidate = MCP_SCOPE_RANK.get(value);
    return candidate === undefined ? rank : Math.max(rank, candidate);
  }, -1);
  const mcpScopes = [
    ...(highestMcpRank >= 0 ? ['mcp:read'] : []),
    ...(highestMcpRank >= 1 ? ['mcp:write'] : []),
    ...(highestMcpRank >= 2 ? ['mcp:admin'] : []),
  ];
  const nonMcpScopes = normalized.filter((value) => !MCP_SCOPE_RANK.has(value));
  return [...mcpScopes, ...nonMcpScopes].join(' ');
}

/**
 * Drop device-flow-only scopes from an authorization-code request.
 *
 * MCP clients that already cached a broad `scopes_supported` list may still
 * request `device_worker:run` / `connections:token`. Stripping (rather than
 * rejecting) lets them complete consent with the scopes they actually need.
 */
export function stripNonPublicOAuthScopes(scope: string | undefined | null): string {
  return (scope || '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((s) => !(NON_PUBLIC_OAUTH_SCOPES as readonly string[]).includes(s))
    .join(' ');
}

/**
 * Narrow an UNTRUSTED client's requested scope to what it may receive,
 * dropping anything else. The tolerant counterpart to
 * {@link normalizeOAuthScopeRequest}, and deliberately the same shape so the
 * choice between them is the only difference at a call site.
 *
 * Unknown scopes are IGNORED, not rejected. RFC 6749 §3.3 permits either, but
 * the clients on these endpoints are strangers: registration is open (DCR),
 * and Slack, Claude Desktop and Cursor all append standard OIDC scopes
 * (`openid`, `email`, `profile`, `offline_access`) that Lobu has never issued.
 * Failing a whole authorization over one unrecognized value breaks the
 * integration outright, where narrowing it just grants less. Dropping a scope
 * is never a privilege risk — the user still consents to what remains.
 *
 * Reject instead for scope strings WE generate (the consent form), where an
 * unknown value is a real error rather than someone else's dialect.
 *
 * Returns null only when nothing requested is grantable, a genuine
 * `invalid_scope`.
 */
export function filterRequestedScopes(
  scope: string | undefined | null,
  allowedScopes: readonly string[] = AVAILABLE_SCOPES
): string | null {
  const requested = normalizeScopeList(scope);
  if (requested.length === 0) return null;
  const allowed = new Set<string>(allowedScopes);
  const kept = requested.filter((value) => allowed.has(value));
  return kept.length > 0 ? kept.join(' ') : null;
}

/**
 * Strip `mcp:admin` from a requested scope string when the user is not an
 * owner/admin of the target org. The runtime tool-access checks reject
 * admin-tier actions for non-admins anyway, so filtering at consent makes
 * the stored token scope match the user's actual privileges and avoids
 * a confusing "reconnect with admin access" error after grant.
 *
 * Returns `null` when the caller requested at least one scope but role-based
 * filtering removed all of them. The caller must reject the request with
 * `invalid_scope` (RFC 6749 §4.1.2.1) — silently persisting an empty grant
 * is unsafe because downstream parsing treats null/empty stored scope as the
 * default scope set, which would unintentionally widen privileges.
 */
export function filterScopeByRole(
  scope: string | undefined | null,
  memberRole: string | null
): string | null {
  const requested = (scope || '')
    .split(' ')
    .map((value) => value.trim())
    .filter(Boolean);
  const isAdmin = memberRole === 'owner' || memberRole === 'admin';
  const granted = isAdmin ? requested : requested.filter((s) => s !== 'mcp:admin');
  if (requested.length > 0 && granted.length === 0) {
    return null;
  }
  return granted.join(' ');
}

export function normalizeScopeList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(/[\s,]+/)
          .map((part) => part.trim())
          .filter(Boolean)
      : [];

  return Array.from(
    new Set(raw.filter((scope): scope is string => typeof scope === 'string').map((s) => s.trim()))
  ).filter(Boolean);
}

function equivalentScopes(scope: string): string[] {
  switch (scope) {
    case 'email':
    case 'https://www.googleapis.com/auth/userinfo.email':
      return ['email', 'https://www.googleapis.com/auth/userinfo.email'];
    case 'profile':
    case 'https://www.googleapis.com/auth/userinfo.profile':
      return ['profile', 'https://www.googleapis.com/auth/userinfo.profile'];
    default:
      return [scope];
  }
}

export function hasAllScopes(granted: Iterable<string>, required: Iterable<string>): boolean {
  const grantedSet = new Set<string>();
  for (const scope of granted) {
    const normalized = scope.trim();
    if (!normalized) continue;
    for (const equivalent of equivalentScopes(normalized)) {
      grantedSet.add(equivalent);
    }
  }
  for (const scope of required) {
    const normalized = scope.trim();
    if (!normalized) continue;
    if (!grantedSet.has(normalized)) return false;
  }
  return true;
}

export function readRequestedScopesFromAuthData(
  authData: Record<string, unknown> | null | undefined
): string[] {
  return normalizeScopeList(authData?.requested_scopes);
}

export function readGrantedScopesFromAuthData(
  authData: Record<string, unknown> | null | undefined
): string[] {
  return normalizeScopeList(authData?.granted_scopes);
}

export function mergeOAuthScopeAuthData(
  authData: Record<string, unknown> | null | undefined,
  params: {
    requestedScopes?: string[] | null;
    grantedScopes?: string[] | null;
    identity?: Record<string, unknown> | null;
  }
): Record<string, unknown> {
  return {
    ...(authData ?? {}),
    ...(params.requestedScopes
      ? { requested_scopes: normalizeScopeList(params.requestedScopes) }
      : {}),
    ...(params.grantedScopes ? { granted_scopes: normalizeScopeList(params.grantedScopes) } : {}),
    ...(params.identity ? { identity: params.identity } : {}),
  };
}

export function getFeedRequiredScopes(
  feedsSchema: Record<string, unknown> | null | undefined,
  feedKey: string
): string[] {
  if (!feedsSchema || typeof feedsSchema !== 'object' || Array.isArray(feedsSchema)) return [];
  const byKey = (feedsSchema as Record<string, Record<string, unknown>>)[feedKey];
  if (byKey && typeof byKey === 'object') {
    return normalizeScopeList(byKey.requiredScopes);
  }

  for (const value of Object.values(feedsSchema as Record<string, Record<string, unknown>>)) {
    if (value && typeof value === 'object' && value.key === feedKey) {
      return normalizeScopeList((value as Record<string, unknown>).requiredScopes);
    }
  }

  return [];
}
