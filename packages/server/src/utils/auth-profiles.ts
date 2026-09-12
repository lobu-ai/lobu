import { slugify } from '@lobu/core';
import { getDb, type DbClient } from '../db/client';
import { persistAuthCredentials } from './auth-credential-secrets';
import { ToolUserError } from './errors';
import { isUniqueViolation } from './pg-errors';

/**
 * Thrown when an INSERT into auth_profiles with status='pending_auth' collides
 * with the partial unique index `auth_profiles_pending_oauth_account_unique`
 * (one pending oauth_account profile per org+connector+provider+user).
 * Carries the existing row so callers can choose to recover (return the
 * existing profile) instead of surfacing the error.
 */
export class PendingAuthConflictError extends ToolUserError {
  readonly existing: AuthProfileRow;

  constructor(existing: AuthProfileRow) {
    super(
      `An ${existing.profile_kind} auth profile for connector '${existing.connector_key ?? ''}'${existing.provider ? ` (${existing.provider})` : ''} is already pending authorization (slug: '${existing.slug}'). Finish authorizing it or delete it before creating a new one.`,
      409
    );
    this.name = 'PendingAuthConflictError';
    this.existing = existing;
  }
}

export type AuthProfileKind =
  | 'env'
  | 'oauth_app'
  | 'oauth_account'
  | 'browser_session'
  | 'interactive';
export type AuthProfileStatus = 'active' | 'pending_auth' | 'error' | 'revoked';

export type BrowserKind = 'chrome' | 'brave' | 'arc' | 'edge';

export interface AuthProfileRow {
  id: number;
  organization_id: string;
  slug: string;
  display_name: string;
  connector_key: string | null;
  profile_kind: AuthProfileKind;
  status: AuthProfileStatus;
  auth_data: Record<string, unknown>;
  account_id: string | null;
  provider: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  device_worker_id: string | null;
  browser_kind: BrowserKind | null;
  is_default_for_connector: boolean;
}

interface BrowserSessionSummary {
  auth_mode: 'cookies' | 'empty';
  cookie_count: number;
  captured_at: string | null;
  auth_cookie_name: string | null;
  expires_at: string | null;
  is_expired: boolean;
}

interface BrowserSessionReadiness extends BrowserSessionSummary {
  usable: boolean;
}

// `auth-credential-secrets` imports `normalizeAuthValues` from this module and
// this module imports the persist helpers back. The cycle is safe (both sides
// only call across at runtime, never during module init) and keeps the
// credential-at-rest policy in one file instead of splitting it.
export function normalizeAuthValues(raw: unknown): Record<string, string> {
  if (typeof raw === 'string') {
    try {
      return normalizeAuthValues(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    normalized[key] = trimmed;
  }

  return normalized;
}

function normalizeAuthData(
  profileKind: AuthProfileKind,
  raw: unknown
): Record<string, unknown> {
  if (profileKind === 'env' || profileKind === 'oauth_app') {
    return normalizeAuthValues(raw);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return raw as Record<string, unknown>;
}

type BrowserCookie = {
  name?: string;
  expires?: number;
};

function scoreAuthCookie(cookie: BrowserCookie, connectorKey?: string | null): number {
  const name = cookie.name?.toLowerCase() ?? '';
  if (!name) return Number.NEGATIVE_INFINITY;

  if (connectorKey === 'linkedin' && name === 'li_at') return 1_000;
  if (connectorKey === 'x' && name === 'auth_token') return 1_000;

  if (/^(lang|li_theme|timezone|theme|locale|tz|visitor_id|guest_id)$/.test(name)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (/(auth|token|session|sess|sid|jwt)/.test(name)) score += 100;
  if (/_at$/.test(name)) score += 80;
  if ((cookie.expires ?? 0) > 0) score += 5;
  return score;
}

function findLikelyBrowserAuthCookie(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): BrowserCookie | null {
  const cookies = Array.isArray(authData?.cookies) ? (authData.cookies as BrowserCookie[]) : [];
  const sorted = [...cookies].sort(
    (a, b) => scoreAuthCookie(b, connectorKey) - scoreAuthCookie(a, connectorKey)
  );
  const best = sorted[0];
  return best && scoreAuthCookie(best, connectorKey) > 0 ? best : null;
}

export function summarizeBrowserSessionAuthData(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): BrowserSessionSummary {
  const cookies = Array.isArray(authData?.cookies) ? authData.cookies : [];
  const authCookie = findLikelyBrowserAuthCookie(authData, connectorKey);
  const expiresAt =
    authCookie && typeof authCookie.expires === 'number' && authCookie.expires > 0
      ? new Date(authCookie.expires * 1000).toISOString()
      : null;

  return {
    auth_mode: cookies.length > 0 ? 'cookies' : 'empty',
    cookie_count: cookies.length,
    captured_at: typeof authData?.captured_at === 'string' ? authData.captured_at : null,
    auth_cookie_name: typeof authCookie?.name === 'string' ? authCookie.name : null,
    expires_at: expiresAt,
    is_expired: expiresAt ? new Date(expiresAt).getTime() < Date.now() : false,
  };
}

export async function getBrowserSessionReadiness(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): Promise<BrowserSessionReadiness> {
  const summary = summarizeBrowserSessionAuthData(authData, connectorKey);
  return {
    ...summary,
    usable: summary.cookie_count > 0 && !!summary.auth_cookie_name && !summary.is_expired,
  };
}

export function browserSessionIsUsable(
  authData: Record<string, unknown> | null | undefined,
  connectorKey?: string | null
): boolean {
  const summary = summarizeBrowserSessionAuthData(authData, connectorKey);
  return summary.cookie_count > 0 && !!summary.auth_cookie_name && !summary.is_expired;
}

function sanitizeProfileSlug(value: string): string {
  const slug = slugify(value);
  if (!slug) {
    throw new Error('Auth profile slug must contain at least one letter or number');
  }
  if (slug.length > 80) {
    throw new Error('Auth profile slug must be at most 80 characters');
  }
  return slug;
}

export function normalizeAuthProfileSlug(value?: string | null, fallback?: string | null): string {
  const source = value?.trim() || fallback?.trim() || '';
  return sanitizeProfileSlug(source);
}

export async function ensureUniqueAuthProfileSlug(params: {
  organizationId: string;
  slug: string;
  excludeId?: number | null;
}, db: DbClient = getDb()): Promise<string> {
  const sql = db;
  const baseSlug = sanitizeProfileSlug(params.slug);
  let candidate = baseSlug;
  let suffix = 2;

  for (;;) {
    const rows = await sql`
      SELECT id
      FROM auth_profiles
      WHERE organization_id = ${params.organizationId}
        AND slug = ${candidate}
        AND (${params.excludeId ?? null}::bigint IS NULL OR id <> ${params.excludeId ?? null}::bigint)
      LIMIT 1
    `;

    if (rows.length === 0) {
      return candidate;
    }

    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

const AUTH_PROFILE_COLUMNS = `
  id, organization_id, slug, display_name, connector_key,
  profile_kind, status, auth_data, account_id, provider,
  created_by, created_at, updated_at,
  device_worker_id, browser_kind,
  is_default_for_connector
` as const;

export async function listAuthProfiles(params: {
  organizationId: string;
  connectorKey?: string | null;
  profileKind?: AuthProfileKind | null;
  provider?: string | null;
}): Promise<AuthProfileRow[]> {
  const sql = getDb();

  // oauth_app profiles are provider-scoped — include them when filtering by connector_key
  // if the connector has an OAuth provider.
  // browser_session profiles are device-scoped resources; their connector_key is
  // optional, so they always show up regardless of the connector filter.
  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${params.organizationId}
      AND (${params.profileKind ?? null}::text IS NULL OR profile_kind = ${params.profileKind ?? null})
      AND (${params.provider ?? null}::text IS NULL OR lower(provider) = lower(${params.provider ?? null}))
      AND (
        ${params.connectorKey ?? null}::text IS NULL
        OR connector_key = ${params.connectorKey ?? null}
        OR profile_kind = 'browser_session'
        OR (profile_kind = 'oauth_app' AND ${params.provider ?? null}::text IS NOT NULL AND lower(provider) = lower(${params.provider ?? null}))
      )
    ORDER BY connector_key ASC NULLS LAST, profile_kind ASC, display_name ASC, slug ASC
  `;

  return rows as unknown as AuthProfileRow[];
}

export async function getAuthProfileBySlug(
  organizationId: string,
  slug: string
): Promise<AuthProfileRow | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${organizationId}
      AND slug = ${slug}
    LIMIT 1
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function getAuthProfileById(
  organizationId: string,
  id: number | null | undefined
): Promise<AuthProfileRow | null> {
  if (!id || !Number.isFinite(id)) return null;

  const sql = getDb();
  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${organizationId}
      AND id = ${id}
    LIMIT 1
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function createAuthProfile(params: {
  organizationId: string;
  connectorKey: string | null;
  displayName: string;
  slug?: string | null;
  profileKind: AuthProfileKind;
  authData?: Record<string, unknown>;
  accountId?: string | null;
  provider?: string | null;
  status?: AuthProfileStatus;
  createdBy?: string | null;
  deviceWorkerId?: string | null;
  browserKind?: BrowserKind | null;
}, db: DbClient = getDb()): Promise<AuthProfileRow> {
  const sql = db;
  const normalizedProvider = params.provider ? params.provider.toLowerCase() : null;

  // ensureUniqueAuthProfileSlug is a non-locking SELECT loop: two concurrent
  // creates can resolve the SAME free slug and race auth_profiles_org_slug_unique.
  // ON CONFLICT (organization_id, slug) DO NOTHING makes the slug-race loser a
  // no-op (returns no row) WITHOUT aborting an enclosing transaction — a caller
  // (interactive-connection-setup) passes a `tx`, where a raw 23505 would poison
  // it (25P02). On a no-op we re-resolve to the next free suffix and retry.
  for (let attempt = 0; ; attempt++) {
    const slug = await ensureUniqueAuthProfileSlug({
      organizationId: params.organizationId,
      slug: normalizeAuthProfileSlug(params.slug, params.displayName),
    }, db);

    let rows: unknown[];
    try {
      rows = await sql`
        INSERT INTO auth_profiles (
          organization_id,
          slug,
          display_name,
          connector_key,
          profile_kind,
          status,
          auth_data,
          account_id,
          provider,
          created_by,
          device_worker_id,
          browser_kind
        ) VALUES (
          ${params.organizationId},
          ${slug},
          ${params.displayName},
          ${params.connectorKey ?? null},
          ${params.profileKind},
          ${params.status ?? 'active'},
          ${sql.json(
            params.profileKind === 'env'
              ? {}
              : normalizeAuthData(params.profileKind, params.authData ?? {})
          )},
          ${params.accountId ?? null},
          ${normalizedProvider},
          ${params.createdBy ?? null},
          ${params.deviceWorkerId ?? null},
          ${params.browserKind ?? null}
        )
        ON CONFLICT (organization_id, slug) DO NOTHING
        RETURNING ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
      `;
    } catch (err) {
      // Partial unique index `auth_profiles_pending_oauth_account_unique`
      // enforces one pending oauth_account row per (org, connector_key,
      // provider, created_by). Translate a raw 23505 into a structured error
      // carrying the existing row so callers can recover (idempotent reuse)
      // or surface a clean message instead of leaking the constraint name.
      if (isUniqueViolation(err, 'auth_profiles_pending_oauth_account_unique')) {
        if (
          params.profileKind === 'oauth_account' &&
          params.connectorKey !== null &&
          normalizedProvider !== null
        ) {
          const existing = await findPendingAuthProfile({
            organizationId: params.organizationId,
            connectorKey: params.connectorKey,
            profileKind: 'oauth_account',
            provider: normalizedProvider,
            createdBy: params.createdBy ?? null,
          });
          if (existing) throw new PendingAuthConflictError(existing);
        }
      }
      throw err;
    }

    if (rows.length === 0) {
      // Slug-race loser (ON CONFLICT DO NOTHING). Re-resolve to the next free
      // suffix and retry; each retry re-scans, so N attempts cover N concurrent
      // creators of the same base slug.
      if (attempt < 8) continue;
      throw new ToolUserError(
        'Could not allocate a unique auth profile slug under concurrent load; retry.',
        409
      );
    }

    const created = rows[0] as AuthProfileRow;

    // `env` credentials are inserted empty above (the secret name is namespaced
    // by profile id, which only exists after the INSERT), then written as
    // `secret://` refs here — so a raw credential never touches the column.
    // When the caller passed a transaction (`db !== getDb()`), secrets must
    // use that same handle so a rollback discards both. Otherwise omit `db`
    // and let persistAuthCredentials open its own transaction for the
    // put+update pair (a bare pool connection cannot hold FOR UPDATE).
    if (params.profileKind === 'env') {
      const values = normalizeAuthValues(params.authData ?? {});
      if (Object.keys(values).length > 0) {
        try {
          created.auth_data = await persistAuthCredentials({
            organizationId: params.organizationId,
            authProfileId: created.id,
            credentials: values,
            ...(db !== getDb() ? { db } : {}),
          });
        } catch (err) {
          // Default (non-transactional) path: the INSERT above already
          // committed, so a persist failure would strand an `env` profile with
          // empty auth_data (no compensating rollback). Delete the orphan row
          // before rethrowing. Transactional callers pass their own `db`; their
          // tx rolls back the INSERT (and is already aborted), so skip the
          // compensating delete for them.
          if (db === getDb()) {
            await sql`
              DELETE FROM auth_profiles
              WHERE id = ${created.id}
                AND organization_id = ${params.organizationId}
            `;
          }
          throw err;
        }
      }
    }

    return created;
  }
}

/**
 * Find the existing pending_auth profile that the partial unique index would
 * collide with. For `oauth_account`, that's keyed per-user; pass `createdBy`
 * so the lookup matches the index. Returns null when no pending row exists.
 */
export async function findPendingAuthProfile(params: {
  organizationId: string;
  connectorKey: string;
  profileKind: AuthProfileKind;
  provider: string;
  createdBy?: string | null;
}): Promise<AuthProfileRow | null> {
  const sql = getDb();
  const restrictByUser = params.profileKind === 'oauth_account';
  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${params.organizationId}
      AND connector_key = ${params.connectorKey}
      AND profile_kind = ${params.profileKind}
      AND provider = ${params.provider.toLowerCase()}
      AND status = 'pending_auth'
      ${restrictByUser ? sql`AND created_by IS NOT DISTINCT FROM ${params.createdBy ?? null}` : sql``}
    LIMIT 1
  `;
  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function updateAuthProfile(params: {
  organizationId: string;
  slug: string;
  displayName?: string;
  nextSlug?: string | null;
  authData?: Record<string, unknown>;
  status?: AuthProfileStatus;
  accountId?: string | null;
  provider?: string | null;
}): Promise<AuthProfileRow | null> {
  const existing = await getAuthProfileBySlug(params.organizationId, params.slug);
  if (!existing) return null;

  const sql = getDb();
  const nextSlug =
    params.nextSlug && params.nextSlug.trim().length > 0
      ? await ensureUniqueAuthProfileSlug({
          organizationId: params.organizationId,
          slug: normalizeAuthProfileSlug(params.nextSlug, existing.slug),
          excludeId: existing.id,
        })
      : existing.slug;

  // `env` profiles: a no-credential update (rename, status) leaves authData
  // undefined and keeps existing refs as-is. An explicit authData rewrite
  // always encrypts caller-supplied values (never trusts secret:// strings).
  if (
    existing.profile_kind === 'env' &&
    params.authData !== undefined
  ) {
    await persistAuthCredentials({
      organizationId: params.organizationId,
      authProfileId: existing.id,
      credentials: normalizeAuthData(existing.profile_kind, params.authData),
    });
  }

  const nextAuthData =
    existing.profile_kind === 'env'
      ? undefined // already written above (or left unchanged)
      : params.authData === undefined
        ? normalizeAuthData(existing.profile_kind, existing.auth_data)
        : normalizeAuthData(existing.profile_kind, params.authData);

  const rows = await sql`
    UPDATE auth_profiles
    SET slug = ${nextSlug},
        display_name = COALESCE(${params.displayName ?? null}, display_name),
        ${
          nextAuthData !== undefined
            ? sql`auth_data = ${sql.json(nextAuthData)},`
            : sql``
        }
        status = COALESCE(${params.status ?? null}, status),
        account_id = COALESCE(${params.accountId ?? null}, account_id),
        provider = COALESCE(${params.provider ?? null}, provider),
        updated_at = NOW()
    WHERE organization_id = ${params.organizationId}
      AND id = ${existing.id}
    RETURNING ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

export async function deleteAuthProfile(
  organizationId: string,
  slug: string
): Promise<AuthProfileRow | null> {
  const sql = getDb();
  // Profile row + its encrypted credential rows must leave together. Env
  // profiles write `agent_secrets` under `auth-profile/<id>/…`; leaving those
  // behind after a delete keeps decryptable bearer credentials (DSNs, API
  // keys) until manual GC. Both deletes run in one transaction so a partial
  // failure cannot orphan secrets or leave a profile without credentials.
  return await sql.begin(async (tx) => {
    const rows = await tx`
      DELETE FROM auth_profiles
      WHERE organization_id = ${organizationId}
        AND slug = ${slug}
      RETURNING ${tx.unsafe(AUTH_PROFILE_COLUMNS)}
    `;
    if (rows.length === 0) return null;
    const deleted = rows[0] as AuthProfileRow;
    // Numeric id → safe as a LIKE prefix; no caller-controlled wildcards.
    await tx`
      DELETE FROM agent_secrets
      WHERE organization_id = ${organizationId}
        AND name LIKE ${`auth-profile/${deleted.id}/%`}
    `;
    return deleted;
  });
}

export async function getPrimaryAuthProfileForKind(params: {
  organizationId: string;
  connectorKey: string;
  profileKind: AuthProfileKind;
  provider?: string | null;
  deviceWorkerId?: string | null;
  createdBy?: string | null;
}): Promise<AuthProfileRow | null> {
  const sql = getDb();

  if (params.profileKind === 'oauth_app' && params.provider) {
    // Admins pin a default via is_default_for_connector; that's the strongest
    // preference. After that, prefer a profile bound to this specific
    // connector_key over a provider-only match, then fall back to recency.
    const rows = await sql`
      SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
      FROM auth_profiles
      WHERE organization_id = ${params.organizationId}
        AND profile_kind = 'oauth_app'
        AND status = 'active'
        AND (
          connector_key = ${params.connectorKey}
          OR lower(provider) = lower(${params.provider})
        )
      ORDER BY
        CASE WHEN is_default_for_connector AND connector_key = ${params.connectorKey} THEN 0 ELSE 1 END,
        CASE WHEN connector_key = ${params.connectorKey} THEN 0 ELSE 1 END,
        updated_at DESC,
        id DESC
      LIMIT 1
    `;

    return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
  }

  // Cookie-backed sessions can be shared by connectors on the same device.
  // Preserve the stored device scope when resolving an existing profile.
  if (params.profileKind === 'browser_session') {
    const deviceWorkerId = params.deviceWorkerId ?? null;
    const rows = await sql`
      SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
      FROM auth_profiles
      WHERE organization_id = ${params.organizationId}
        AND profile_kind = 'browser_session'
        AND status = 'active'
        AND (
          ${deviceWorkerId}::uuid IS NULL
          OR device_worker_id = ${deviceWorkerId}::uuid
          OR device_worker_id IS NULL
        )
      ORDER BY
        CASE WHEN device_worker_id = ${deviceWorkerId}::uuid THEN 0 ELSE 1 END,
        CASE WHEN connector_key = ${params.connectorKey} THEN 0 ELSE 1 END,
        updated_at DESC,
        id DESC
      LIMIT 1
    `;

    return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
  }

  const rows = await sql`
    SELECT ${sql.unsafe(AUTH_PROFILE_COLUMNS)}
    FROM auth_profiles
    WHERE organization_id = ${params.organizationId}
      AND profile_kind = ${params.profileKind}
      AND connector_key = ${params.connectorKey}
      AND status = 'active'
      ${
        params.profileKind === 'oauth_account' && params.createdBy !== undefined
          ? sql`AND created_by IS NOT DISTINCT FROM ${params.createdBy ?? null}`
          : sql``
      }
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `;

  return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
}

/**
 * Atomically transition an oauth_app profile to a "broken" status (revoked or
 * error) while also flipping every connection that minted tokens against it
 * to pending_auth and clearing the connector default flag if set. Running
 * these three statements in one transaction prevents the window where a
 * connection still references a revoked profile, and is the only safe
 * substitute for the missing FK-level cascade.
 */
export async function revokeOAuthAppProfileAtomic(params: {
  organizationId: string;
  profileId: number;
  nextStatus: 'revoked' | 'error';
}): Promise<AuthProfileRow | null> {
  const sql = getDb();
  return sql.begin(async (tx) => {
    const profileRows = await tx`
      UPDATE auth_profiles
      SET status = ${params.nextStatus},
          is_default_for_connector = false,
          updated_at = NOW()
      WHERE organization_id = ${params.organizationId}
        AND id = ${params.profileId}
        AND profile_kind = 'oauth_app'
      RETURNING ${tx.unsafe(AUTH_PROFILE_COLUMNS)}
    `;

    if (profileRows.length === 0) return null;

    await tx`
      UPDATE connections
      SET status = 'pending_auth',
          updated_at = NOW()
      WHERE organization_id = ${params.organizationId}
        AND app_auth_profile_id = ${params.profileId}
        AND deleted_at IS NULL
    `;

    return profileRows[0] as AuthProfileRow;
  }) as Promise<AuthProfileRow | null>;
}

/**
 * Pin one oauth_app profile as the org default for its connector_key. Clears
 * the flag on any sibling profile for the same (org, connector_key) first so
 * the partial unique index never trips.
 *
 * Pass `slug: null` to clear the default for the connector entirely (no
 * profile pinned). Returns the row that ended up flagged, or null on clear.
 */
export async function setDefaultAuthProfileForConnector(params: {
  organizationId: string;
  connectorKey: string;
  slug: string | null;
}): Promise<AuthProfileRow | null> {
  const sql = getDb();

  return sql.begin(async (tx) => {
    await tx`
      UPDATE auth_profiles
      SET is_default_for_connector = false,
          updated_at = NOW()
      WHERE organization_id = ${params.organizationId}
        AND connector_key = ${params.connectorKey}
        AND profile_kind = 'oauth_app'
        AND is_default_for_connector
    `;

    if (params.slug === null) return null;

    const rows = await tx`
      UPDATE auth_profiles
      SET is_default_for_connector = true,
          updated_at = NOW()
      WHERE organization_id = ${params.organizationId}
        AND slug = ${params.slug}
        AND profile_kind = 'oauth_app'
      RETURNING ${tx.unsafe(AUTH_PROFILE_COLUMNS)}
    `;

    return rows.length > 0 ? (rows[0] as AuthProfileRow) : null;
  }) as Promise<AuthProfileRow | null>;
}

export async function resolveAuthProfileSlugToId(params: {
  organizationId: string;
  slug?: string | null;
  expectedKind?: AuthProfileKind | null;
  connectorKey?: string | null;
}): Promise<AuthProfileRow | null> {
  if (!params.slug || params.slug.trim().length === 0) return null;
  const profile = await getAuthProfileBySlug(params.organizationId, params.slug.trim());
  if (!profile) return null;
  if (params.expectedKind && profile.profile_kind !== params.expectedKind) return null;
  // oauth_app profiles are provider-scoped, and browser_session profiles are
  // device-scoped; both opt out of the per-connector slug check.
  if (
    params.connectorKey &&
    profile.profile_kind !== 'oauth_app' &&
    profile.profile_kind !== 'browser_session' &&
    profile.connector_key !== params.connectorKey
  )
    return null;
  return profile;
}
