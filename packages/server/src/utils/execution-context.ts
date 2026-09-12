import { CredentialService } from '../auth/credentials';
import { resolveCloudCredential } from '../connect/cloud-credential';
import { getBuiltinProviderConfig } from '../connect/oauth-providers';
import { type DbClient, getDb } from '../db/client';
import { getAuthProfileById, normalizeAuthValues } from './auth-profiles';
import { resolveAuthCredentials } from './auth-credential-secrets';
import {
  getAppInstallationAuthMethods,
  getOAuthAuthMethods,
  normalizeConnectorAuthSchema,
} from './connector-auth';
import { createPostgresAppInstallationStore } from '../lobu/stores/app-installation-store';
import {
  InstallationTokenError,
  type MintedInstallationToken,
} from '../gateway/installation/installation-token-provider';
import { getInstallationTokenRegistry } from '../gateway/installation/registry';
import { parseJsonObject } from '@lobu/core';
import { errorMessage } from './errors';
import { insertEvent } from './insert-event';
import logger from './logger';
import { getErrorMessage } from "@lobu/core";

interface ExecutionOAuthCredentials {
  provider: string;
  accessToken: string;
  expiresAt?: string | null;
  scope?: string | null;
}

interface ResolvedExecutionAuth {
  credentials: ExecutionOAuthCredentials | null;
  connectionCredentials: Record<string, string>;
  sessionState: Record<string, unknown> | null;
}

interface ResolveExecutionAuthParams {
  organizationId: string;
  connectionId: number;
  authProfileId?: number | null;
  appAuthProfileId?: number | null;
  credentialDb: DbClient;
  logContext?: Record<string, unknown>;
  logMessage?: string;
  /**
   * The exact OAuth access token rejected upstream with a 401. Supplying the
   * value refreshes it even when its expiry looks valid, while allowing the
   * credential lock to reuse a token another replica already rotated.
   */
  rejectedAccessToken?: string;
}

export async function resolveExecutionAuth(
  params: ResolveExecutionAuthParams
): Promise<ResolvedExecutionAuth> {
  const authProfile = await getAuthProfileById(params.organizationId, params.authProfileId ?? null);
  const appAuthProfile = await getAuthProfileById(
    params.organizationId,
    params.appAuthProfileId ?? null
  );

  let credentials: ExecutionOAuthCredentials | null = null;

  // Managed-connector branch: when the LOCAL connection is `managedBy` a cloud
  // (public) org, the grant lives in the cloud — fetch a fresh access token for
  // THIS user's own cloud connection via POST /oauth/connection-token. A null
  // result means the connection uses the local credential path below, which is
  // unchanged. The managed-by descriptor comes from the trusted connection
  // `config`, never from raw auth_data keys.
  const managed = await resolveManagedByForConnection(
    params.organizationId,
    params.connectionId
  );
  if (managed) {
    const accessToken = await fetchManagedConnectionToken(managed, {
      ...params.logContext,
      connection_id: params.connectionId,
    });
    if (accessToken) {
      credentials = {
        provider: appAuthProfile?.provider ?? 'managed',
        accessToken: accessToken.access_token,
        expiresAt: accessToken.expires_at ?? null,
        scope: null,
      };
    }
    return {
      credentials,
      connectionCredentials: {},
      sessionState: null,
    };
  }

  // App-installation branch (precedence over oauth_account per design §4.5):
  // a connection backed by an `app_installation` auth method resolves a
  // tenant-scoped token by minting it gateway-side. The private key + JWT +
  // provider exchange stay here; the worker only ever receives the minted token
  // (same seam OAuth tokens flow through). Returns null credentials (no crash)
  // on any failure so the connection surfaces a credential error, not a 500.
  const installCredential = await resolveAppInstallationCredential(
    params.organizationId,
    params.connectionId,
    params.logContext
  );
  if (installCredential.handled) {
    return {
      credentials: installCredential.credentials,
      connectionCredentials: {},
      sessionState: null,
    };
  }

  if (authProfile?.profile_kind === 'oauth_account' && authProfile.account_id) {
    try {
      const credentialService = new CredentialService(params.credentialDb);
      const oauthConfig =
        appAuthProfile?.profile_kind === 'oauth_app'
          ? await resolveExecutionOAuthConfig(
              params.organizationId,
              params.connectionId,
              normalizeAuthValues(appAuthProfile.auth_data ?? {})
            )
          : undefined;
      const tokens = await credentialService.getConnectionTokens(
        params.connectionId,
        authProfile.account_id,
        oauthConfig,
        { rejectedAccessToken: params.rejectedAccessToken }
      );
      if (tokens?.provider && tokens.accessToken) {
        credentials = {
          provider: tokens.provider,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
          scope: tokens.scope,
        };
      }
    } catch (error) {
      logger.warn(
        {
          ...params.logContext,
          connection_id: params.connectionId,
          error: errorMessage(error),
        },
        params.logMessage ?? 'Failed to resolve execution credentials'
      );
    }
  }

  // `env` credentials live in `auth_data` as `secret://` refs, never as raw
  // values — resolve them here so this single seam serves BOTH execution
  // paths: the worker sync poll (worker-api/poll.ts) and source reads
  // (lib/connector-pushdown.ts). Non-ref entries (scope bookkeeping)
  // pass through untouched.
  const connectionCredentials = {
    ...(appAuthProfile
      ? await resolveAuthCredentials({
          organizationId: params.organizationId,
          authProfileId: appAuthProfile.id,
          authData: appAuthProfile.auth_data ?? {},
        })
      : {}),
    ...(authProfile?.profile_kind === 'env'
      ? await resolveAuthCredentials({
          organizationId: params.organizationId,
          authProfileId: authProfile.id,
          authData: authProfile.auth_data ?? {},
        })
      : {}),
  };
  const sessionState =
    authProfile?.profile_kind === 'browser_session' || authProfile?.profile_kind === 'interactive'
      ? ((authProfile.auth_data as Record<string, unknown>) ?? null)
      : null;

  return {
    credentials,
    connectionCredentials,
    sessionState,
  };
}

/**
 * A managed-connector descriptor resolved from a LOCAL connection's `config`.
 * When present, the connection's OAuth grant lives in a cloud (public) org: the
 * local instance fetches a fresh access token for THIS user's own cloud
 * connection at runtime, authenticating with the instance's cloud PAT.
 */
interface ManagedByDescriptor {
  /** The cloud org slug/id the managed connector lives under. */
  org: string;
  /** Stable slug of the exact caller-owned cloud connection grant. */
  connectionSlug?: string;
  /** The connector key to fetch the user's connection token for. */
  connectorKey: string;
  /** Cloud base URL (no trailing `/oauth/connection-token`). */
  baseUrl: string;
  /**
   * The cloud bearer credential — the user's OWN device-login access token
   * (`lobu login`, carrying `connections:token`), or the headless/CI fallback
   * `LOBU_CLOUD_PAT`. Resolved by `resolveCloudCredential`.
   */
  token: string;
}

/**
 * Resolve the {@link ManagedByDescriptor} for a connection, or `null` when the
 * connection is NOT managed (i.e. it uses the local/unchanged credential path).
 *
 * A connection opts into the managed path by carrying `config.managedBy = {
 * org, connectionSlug }` (set via `defineConnection({ connector, managedBy })`).
 * `connectionSlug` is optional only for legacy single-grant configs. The cloud
 * bearer credential AND the cloud base URL are sourced ONLY from the local
 * instance's own login (`resolveCloudCredential`: the stored `lobu login`
 * device credential, falling back to `LOBU_CLOUD_PAT`/`LOBU_CLOUD_URL` for
 * headless/CI). The connection config supplies ONLY the `org`; it CANNOT
 * influence where the credential is sent (a connection-controlled URL would let
 * a malicious config exfiltrate the cloud credential). Returns `null` (so the
 * connection falls through to the local path) when the descriptor or the cloud
 * credential is missing.
 */
async function resolveManagedByForConnection(
  organizationId: string,
  connectionId: number
): Promise<ManagedByDescriptor | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT connector_key, config
    FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
    connector_key: string;
    config: Record<string, unknown> | null;
  }>;
  if (rows.length === 0) return null;

  const config = parseJsonObject(rows[0].config);
  const managedByRaw = config.managedBy;
  if (!managedByRaw || typeof managedByRaw !== 'object' || Array.isArray(managedByRaw)) {
    return null;
  }
  const managedBy = managedByRaw as Record<string, unknown>;
  const org = typeof managedBy.org === 'string' ? managedBy.org.trim() : '';
  if (!org) return null;
  const connectionSlug =
    typeof managedBy.connectionSlug === 'string' && managedBy.connectionSlug.trim()
      ? managedBy.connectionSlug.trim()
      : undefined;

  // The credential + base URL come from the local instance's OWN login (or the
  // env fallback), never from the connection config — so a malicious config
  // can't redirect where the credential is sent.
  const cloud = await resolveCloudCredential();
  if (!cloud) return null;

  return {
    org,
    connectionSlug,
    connectorKey: rows[0].connector_key,
    baseUrl: cloud.baseUrl,
    token: cloud.token,
  };
}

/**
 * Fetch a fresh access token for a managed connection from the cloud via POST
 * /oauth/connection-token. The cloud holds the managed grant + secret and
 * refreshes server-side; we only ever receive `{ access_token, expires_at }`.
 * Returns null on any failure so the connection resolves without credentials
 * (fail-soft, like the local path).
 *
 * Deliberately uncached: this resolves once per worker run / feed sync (not per
 * message), so a fresh fetch is cheap — and skipping a process-shared token
 * cache means one caller's cloud token can never be served to another.
 */
async function fetchManagedConnectionToken(
  managed: ManagedByDescriptor,
  logContext: Record<string, unknown>
): Promise<{ access_token: string; expires_at: string | null } | null> {
  let tokenUrl: string;
  try {
    tokenUrl = new URL(`${managed.baseUrl}/oauth/connection-token`).toString();
  } catch {
    logger.warn({ ...logContext }, 'Managed connection cloud URL is not a valid absolute URL');
    return null;
  }

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managed.token}`,
      },
      body: JSON.stringify({
        org: managed.org,
        connector_key: managed.connectorKey,
        ...(managed.connectionSlug ? { connection_slug: managed.connectionSlug } : {}),
      }),
    });
    if (!response.ok) {
      logger.warn(
        { ...logContext, status: response.status },
        'Managed connection token fetch failed'
      );
      return null;
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_at?: string | null;
    };
    if (!body.access_token) return null;
    return { access_token: body.access_token, expires_at: body.expires_at ?? null };
  } catch (error) {
    logger.warn(
      { ...logContext, error: errorMessage(error) },
      'Managed connection token fetch error'
    );
    return null;
  }
}

/**
 * Result of the app-installation credential branch. `handled: true` means this
 * connection is App-backed and resolution is authoritative (success OR a
 * surfaced failure) — the caller returns immediately and does NOT fall through
 * to the OAuth/env paths. `handled: false` means the connection is not
 * App-backed; the caller continues with the unchanged credential resolution.
 */
interface AppInstallationCredentialResult {
  handled: boolean;
  credentials: ExecutionOAuthCredentials | null;
}

const NOT_APP_INSTALLATION: AppInstallationCredentialResult = {
  handled: false,
  credentials: null,
};

/**
 * Best-effort security audit for a rejected app-installation reference. A
 * connection trying to resolve an install it doesn't own (cross-tenant) or one
 * whose provider/instance doesn't match its connector method is a tenancy
 * signal worth surfacing beyond the log line — operators can review these the
 * same way they review `guardrail-trip` rows.
 *
 * Mirrors the guardrail-trip audit shape (`semantic_type='guardrail-trip'`,
 * `guardrail` discriminator in metadata) so existing audit tooling/queries pick
 * it up. Append-only: one `events` row per rejection.
 *
 * Fire-and-forget and never throws — resolution must NOT crash because the
 * audit write failed; a dropped row is logged so the gap is still visible.
 */
function recordAppInstallationTenancyTrip(params: {
  organizationId: string;
  connectionId: number;
  installId: number;
  reason: 'cross_tenant_org' | 'provider_instance_mismatch' | 'install_not_active';
  details: Record<string, unknown>;
}): void {
  const originId = `app_installation_tenancy_trip_${params.reason}_${params.connectionId}_${params.installId}_${Date.now()}`;
  void insertEvent({
    entityIds: [],
    organizationId: params.organizationId,
    originId,
    title: `App-installation reference rejected (${params.reason})`,
    semanticType: 'guardrail-trip',
    originType: 'guardrail-app-installation',
    metadata: {
      guardrail: 'app-installation-tenancy',
      stage: 'pre-tool',
      reason: params.reason,
      connection_id: params.connectionId,
      install_id: params.installId,
      ...params.details,
    },
  }).catch((err) => {
    logger.warn(
      {
        err: getErrorMessage(err),
        connection_id: params.connectionId,
        install_id: params.installId,
        reason: params.reason,
      },
      'Failed to record app-installation tenancy audit event (security log gap)'
    );
  });
}

/**
 * Resolve a tenant-scoped credential for an App-installation-backed connection.
 *
 * Wiring contract:
 *  - The connection's connector must declare an `app_installation` auth method
 *    (provider + appIdKey/privateKeyKey), and the connection `config` must carry
 *    `installation_ref` = the `app_installations.id` it was bound to (written by
 *    the install/connect flow — PR5). Absent either, this is not an App-backed
 *    connection and we hand back to the normal resolver.
 *  - The active install row is loaded by id; the connector method's
 *    `appIdKey`/`privateKeyKey` are stamped into the row metadata so the GitHub
 *    provider reads the right gateway env vars. The token is minted via the
 *    per-pod {@link getInstallationTokenRegistry} (App JWT + provider exchange,
 *    gateway-side only).
 *
 * Worker-creds invariant: the minted token is returned as `credentials`
 * (provider/accessToken/expiresAt), the existing channel a connector reads its
 * token from — identical to OAuth. The App private key, the signed App JWT, and
 * the GitHub `/access_tokens` exchange never leave the gateway, and the token
 * itself stops at the worker HOST: the isolate lane hands connector code a
 * per-run `lobu_secret_<uuid>` placeholder and swaps the value back into the
 * request header at `fetch` (`CredentialVault` in the connector worker's
 * `egress/credentials.ts`, minting the secret proxy's grammar).
 *
 * Lifecycle: a missing/inactive install, a cross-tenant or wrong-provider
 * install reference, or a mint failure all resolve to
 * `{ handled: true, credentials: null }` — the connection runs without a
 * credential and the connector's own auth check fails cleanly, never a crash.
 *
 * Tenancy: the loaded install row MUST belong to the connection's org and match
 * the connector method's declared provider/providerInstance; a mismatch returns
 * null creds WITHOUT minting (a cross-tenant `installation_ref` must never yield
 * another org's token).
 */
async function resolveAppInstallationCredential(
  organizationId: string,
  connectionId: number,
  logContext?: Record<string, unknown>
): Promise<AppInstallationCredentialResult> {
  const sql = getDb();
  const rows = (await sql`
    SELECT c.connector_key, c.config, cd.auth_schema
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.organization_id = c.organization_id
     AND cd.status = 'active'
    WHERE c.id = ${connectionId}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
    connector_key: string;
    config: Record<string, unknown> | null;
    auth_schema: unknown;
  }>;
  if (rows.length === 0) return NOT_APP_INSTALLATION;

  const authSchema = normalizeConnectorAuthSchema(rows[0].auth_schema);
  const method = getAppInstallationAuthMethods(authSchema)[0];
  if (!method) return NOT_APP_INSTALLATION;

  const config = parseJsonObject(rows[0].config);
  const installRef = config.installation_ref;
  const installId =
    typeof installRef === 'number'
      ? installRef
      : typeof installRef === 'string' && installRef.trim()
        ? Number(installRef)
        : null;
  if (installId == null || !Number.isFinite(installId)) {
    // Connector supports App installs, but this connection isn't bound to one —
    // fall through to the configured fallback method (PAT/env) per §4.5.
    return NOT_APP_INSTALLATION;
  }

  const store = createPostgresAppInstallationStore();
  const install = await store.getById(installId);
  if (!install) {
    logger.warn(
      { ...logContext, connection_id: connectionId, install_id: installId },
      'App-installation connection references a missing install row'
    );
    return { handled: true, credentials: null };
  }

  // Tenancy guard: the install MUST belong to the connection's org. Without this,
  // a connection in org A could set `config.installation_ref` to org B's install
  // id and receive org B's minted token (cross-tenant credential leak). Reject
  // the mismatch — return null creds, never mint — and log it as a tenancy
  // violation signal.
  if (install.organizationId !== organizationId) {
    logger.warn(
      {
        ...logContext,
        connection_id: connectionId,
        install_id: installId,
        connection_org: organizationId,
        install_org: install.organizationId,
      },
      'Cross-tenant app-installation reference rejected: install org does not match connection org'
    );
    recordAppInstallationTenancyTrip({
      organizationId,
      connectionId,
      installId,
      reason: 'cross_tenant_org',
      details: { connection_org: organizationId, install_org: install.organizationId },
    });
    return { handled: true, credentials: null };
  }

  // Connector-shape guard: the install MUST match the connector method's declared
  // app_installation provider and providerInstance. An omitted method
  // providerInstance defaults to 'cloud' (NOT a wildcard) — otherwise a method
  // that doesn't pin an instance would accept an install from any instance
  // (e.g. a self-hosted GHES host), which is a tenancy/scope hole.
  if (
    install.provider !== method.provider ||
    install.providerInstance !== (method.providerInstance ?? "cloud")
  ) {
    logger.warn(
      {
        ...logContext,
        connection_id: connectionId,
        install_id: installId,
        install_provider: install.provider,
        method_provider: method.provider,
        install_provider_instance: install.providerInstance,
        method_provider_instance: method.providerInstance,
      },
      'App-installation reference rejected: install provider/instance does not match connector method'
    );
    recordAppInstallationTenancyTrip({
      organizationId,
      connectionId,
      installId,
      reason: 'provider_instance_mismatch',
      details: {
        install_provider: install.provider,
        method_provider: method.provider,
        install_provider_instance: install.providerInstance,
        method_provider_instance: method.providerInstance ?? 'cloud',
      },
    });
    return { handled: true, credentials: null };
  }

  // Status guard: only an ACTIVE install may mint. After a cross-org TRANSFER the
  // store demotes the losing org's row to 'suspended' (and a 'revoked' row is a
  // hard uninstall), but the losing org's connection still points its
  // installation_ref at that row. Without this check a suspended/revoked install
  // would keep minting GitHub tokens for the new owner's repos — a cross-tenant
  // leak. Reject any non-active status: null creds, never mint.
  if (install.status !== 'active') {
    logger.warn(
      {
        ...logContext,
        connection_id: connectionId,
        install_id: installId,
        install_status: install.status,
      },
      'App-installation reference rejected: install is not active (transferred/suspended/revoked)'
    );
    recordAppInstallationTenancyTrip({
      organizationId,
      connectionId,
      installId,
      reason: 'install_not_active',
      details: { install_status: install.status },
    });
    return { handled: true, credentials: null };
  }

  // Stamp the connector method's env-var names onto the row metadata so the
  // provider reads the correct gateway env vars (the row itself never holds the
  // App id or private key — only their env-var NAMES, resolved gateway-side).
  const installWithKeys = {
    ...install,
    metadata: {
      ...install.metadata,
      ...(method.appIdKey ? { appIdKey: method.appIdKey } : {}),
      ...(method.privateKeyKey ? { privateKeyKey: method.privateKeyKey } : {}),
    },
  };

  let minted: MintedInstallationToken;
  try {
    minted = await getInstallationTokenRegistry().mintFor(installWithKeys);
  } catch (error) {
    const reason =
      error instanceof InstallationTokenError ? error.reason : 'unknown';
    logger.warn(
      {
        ...logContext,
        connection_id: connectionId,
        install_id: installId,
        provider: install.provider,
        reason,
        error: errorMessage(error),
      },
      'Failed to mint app-installation token'
    );
    return { handled: true, credentials: null };
  }

  return {
    handled: true,
    credentials: {
      provider: install.provider,
      accessToken: minted.token,
      expiresAt: minted.expiresAt,
      scope: null,
    },
  };
}

async function resolveExecutionOAuthConfig(
  organizationId: string,
  connectionId: number,
  appAuthValues: Record<string, string>
): Promise<
  | {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
      resource?: string;
    }
  | undefined
> {
  const sql = getDb();
  const rows = await sql`
    SELECT c.connector_key, cd.auth_schema, cd.mcp_config
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.organization_id = c.organization_id
     AND cd.status = 'active'
    WHERE c.id = ${connectionId}
      AND c.organization_id = ${organizationId}
    LIMIT 1
  `;

  if (rows.length === 0) return undefined;

  const row = rows[0] as {
    connector_key: string;
    auth_schema: unknown;
    mcp_config: unknown;
  };
  const authSchema = normalizeConnectorAuthSchema(row.auth_schema);
  const oauthMethod = getOAuthAuthMethods(authSchema)[0];
  if (!oauthMethod) return undefined;

  const builtin = getBuiltinProviderConfig(oauthMethod.provider);
  const tokenUrl = oauthMethod.tokenUrl ?? builtin?.tokenUrl;
  if (!tokenUrl) return undefined;

  const providerUpper = oauthMethod.provider.toUpperCase();
  const clientIdKey = oauthMethod.clientIdKey || `${providerUpper}_CLIENT_ID`;
  const clientSecretKey = oauthMethod.clientSecretKey || `${providerUpper}_CLIENT_SECRET`;
  const clientId = appAuthValues[clientIdKey];
  if (!clientId) return undefined;

  const clientSecret = appAuthValues[clientSecretKey];
  const authMethod = oauthMethod.tokenEndpointAuthMethod ?? builtin?.tokenEndpointAuthMethod;
  const mcpConfig =
    row.mcp_config && typeof row.mcp_config === 'object'
      ? (row.mcp_config as Record<string, unknown>)
      : null;
  return {
    tokenUrl,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(authMethod ? { authMethod } : {}),
    ...(typeof mcpConfig?.upstream_url === 'string'
      ? { resource: mcpConfig.upstream_url }
      : {}),
  };
}

export function mergeExecutionConfig(...configs: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    Object.assign(merged, parseJsonObject(config));
  }
  return merged;
}
