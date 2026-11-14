/**
 * Credential Service — OAuth token resolution and refresh
 *
 * Used by execution-context.ts and mcp-proxy/credential-resolver.ts to
 * resolve and auto-refresh OAuth tokens for upstream API calls.
 */

import type { DbClient } from '../db/client';
import { oauthAccountAppMismatch, oauthAccountGrantError, oauthAccountOwnershipError } from '../authz/oauth-account-ownership';
import { scrubDiagnosticValue } from '@lobu/core';
import { fetchCredentialedPublicUrl } from '@lobu/connector-worker/egress';
import { cancelResponseBody } from '../utils/bounded-response';
import {
  readConnectorOAuthResponse,
  withConnectorOAuthDeadline,
} from '../utils/connector-oauth-http';
import { buildRefreshRequest, parseTokenRefreshResponse } from './oauth/token-refresh';
import logger from '../utils/logger';
import { notifyConnectionPermissionRequest } from '../notifications/triggers';

/**
 * Credential tokens for sync execution
 */
interface CredentialTokens {
  provider: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function isTokenExpiringSoon(expiresAt: Date | string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Per-account advisory-lock tag. `pg_advisory_xact_lock(hashtext($1))` keys the
 * lock off this string and auto-releases at transaction end, serializing OAuth
 * token refresh across replicas so two workers can't both rotate the same
 * account's refresh token and clobber each other's result.
 */
function refreshLockTag(accountId: string): string {
  return `oauth_account_refresh:${accountId}`;
}

type RefreshParams = {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  resource?: string;
};
type RefreshedTokens = { accessToken: string; expiresAt: Date; refreshToken?: string };
type RejectedGrantConnection = { id: number; organization_id: string; connector_key: string };

/** The provider rejected the stored grant itself; only new consent recovers it. */
const GRANT_REJECTED = 'grant_rejected' as const;

const OAUTH_GRANT_REJECTED_ERROR =
  'The provider rejected this account authorization (expired or revoked). Reconnect the connection to restore access.';

/** The `error` code of an OAuth error response, or null. The body is never logged. */
async function readOAuthErrorCode(response: Response): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readConnectorOAuthResponse(response)) as { error?: unknown };
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Drop the rejected grant's tokens from the account, so no later call retries
 * it against the provider, and a reconnect (which stores new tokens) is
 * distinguishable from it. Runs under the account's refresh lock, on the row
 * that lock already holds.
 */
async function clearRejectedGrant(tx: DbClient, accountId: string): Promise<void> {
  await tx`
    UPDATE "account"
    SET "accessToken" = NULL, "refreshToken" = NULL, "accessTokenExpiresAt" = NULL, "updatedAt" = NOW()
    WHERE id = ${accountId}
  `;
}

/**
 * Every connection on a rejected grant fails until the account consents
 * again. Mark its account profiles revoked, which reconciliation honours on
 * every path (a status edit, a new connection, a feed edit) until a reconnect
 * sets them active, and revoke the live connections so health, the UI and
 * operations report them. Runs after the refresh commits, and locks in the
 * reconnect callback's and connection updates' order: the account profiles,
 * then their connections. The account is read only once those locks are held,
 * so a reconnect that stored new tokens while we waited is seen and left alone.
 */
function markGrantRejected(sql: DbClient, accountId: string): Promise<RejectedGrantConnection[]> {
  return sql.begin(async (tx) => {
    await tx`
      SELECT id FROM auth_profiles
      WHERE account_id = ${accountId} AND profile_kind = 'oauth_account'
      ORDER BY id
      FOR UPDATE
    `;
    const live = await tx`
      SELECT c.id
      FROM connections c
      JOIN auth_profiles ap ON ap.id = c.auth_profile_id AND ap.organization_id = c.organization_id
      WHERE ap.account_id = ${accountId} AND ap.profile_kind = 'oauth_account'
        AND c.status = 'active' AND c.deleted_at IS NULL
      ORDER BY c.id
      FOR UPDATE OF c
    `;
    const [stillRejected] = await tx`
      SELECT 1 FROM "account"
      WHERE id = ${accountId} AND "accessToken" IS NULL AND "refreshToken" IS NULL
    `;
    if (!stillRejected) return [];
    await tx`
      UPDATE auth_profiles
      SET status = 'revoked', updated_at = NOW()
      WHERE account_id = ${accountId} AND profile_kind = 'oauth_account' AND status = 'active'
    `;
    if (live.length === 0) return [];
    return tx<RejectedGrantConnection>`
      UPDATE connections c
      SET status = 'revoked', error_message = ${OAUTH_GRANT_REJECTED_ERROR}, updated_at = NOW()
      FROM auth_profiles ap
      WHERE ap.id = c.auth_profile_id AND ap.organization_id = c.organization_id
        AND ap.account_id = ${accountId} AND ap.profile_kind = 'oauth_account'
        AND c.status = 'active' AND c.deleted_at IS NULL
      RETURNING c.id, c.organization_id, c.connector_key
    `;
  });
}

/** Tell each owner after the revocation commits. Delivery is best-effort; the status is the record. */
async function notifyGrantRejected(accountId: string, connections: RejectedGrantConnection[]): Promise<void> {
  if (connections.length === 0) return;
  logger.warn(
    { account_id: accountId, connection_ids: connections.map((c) => c.id) },
    '[Credentials] OAuth grant rejected; connections need reauthorization'
  );
  for (const connection of connections) {
    try {
      await notifyConnectionPermissionRequest({ orgId: connection.organization_id,
        connectionId: Number(connection.id), connectorKey: connection.connector_key, reason: 'grant_rejected' });
    } catch (error) {
      logger.warn({ connection_id: connection.id, err: scrubDiagnosticValue(error) },
        '[Credentials] Failed to notify about a rejected OAuth grant');
    }
  }
}

export class CredentialService {
  constructor(private sql: DbClient) {}

  /**
   * Get OAuth tokens for a connection (V1 integration platform).
   * Reads from auth_profiles.account_id -> account table.
   * Optionally accepts oauthConfig for generic token refresh (non-Google providers).
   */
  async getConnectionTokens(
    connectionId: number,
    accountId: string,
    oauthConfig?: {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
      resource?: string;
    },
    opts?: { rejectedAccessToken?: string }
  ): Promise<CredentialTokens | null> {
    const result = await this.sql`
      SELECT
        a."providerId" as provider,
        a."accessToken" as "accessToken",
        a."refreshToken" as "refreshToken",
        a."accessTokenExpiresAt" as "expiresAt",
        a.scope,
        a."userId", a."providerId",
        ap.created_by, ap.provider AS profile_provider, ap.profile_kind,
        ap.auth_data->'app_auth_profile_id' AS stored_app_id,
        c.created_by AS connection_owner, c.app_auth_profile_id
      FROM "account" a
      JOIN auth_profiles ap ON ap.account_id = a.id AND ap.profile_kind = 'oauth_account'
      JOIN connections c ON c.auth_profile_id = ap.id AND c.organization_id = ap.organization_id
      WHERE a.id = ${accountId}
        AND c.id = ${connectionId} AND c.deleted_at IS NULL
    `;

    if (result.length === 0) return null;

    const row = result[0];
    const profile = { profile_kind: row.profile_kind as string, created_by: row.created_by as string | null, provider: row.profile_provider as string | null };
    if (oauthAccountOwnershipError(profile, profile.created_by, row.connection_owner) ||
      oauthAccountGrantError(profile, row as { userId: string; providerId: string }) ||
      oauthAccountAppMismatch(row.stored_app_id, row.app_auth_profile_id)) return null;
    // Keep validation metadata out of the credential object passed to callers.
    const tokens: CredentialTokens = {
      provider: row.provider, accessToken: row.accessToken, refreshToken: row.refreshToken,
      expiresAt: row.expiresAt, scope: row.scope,
    };

    // Refresh a token rejected upstream even when its stored expiry looks
    // valid. Carry the exact rejected token through the lock: if another
    // replica already replaced it, its fresh value wins and must not be
    // rotated again by every waiter that observed the same 401.
    const rejectedAccessToken = opts?.rejectedAccessToken;
    const currentTokenWasRejected =
      rejectedAccessToken !== undefined && tokens.accessToken === rejectedAccessToken;
    if (
      tokens.refreshToken &&
      oauthConfig &&
      (currentTokenWasRejected || isTokenExpiringSoon(tokens.expiresAt))
    ) {
      const newTokens = await this.refreshAccountUnderLock(accountId, oauthConfig, {
        rejectedAccessToken: currentTokenWasRejected ? rejectedAccessToken : undefined,
      });
      if (newTokens) {
        return {
          ...tokens,
          accessToken: newTokens.accessToken,
          expiresAt: newTokens.expiresAt,
        };
      }
      if (currentTokenWasRejected) return null;
    }

    return tokens;
  }

  /**
   * Public method for refreshing tokens with explicit OAuth config.
   * Used by the MCP proxy to refresh tokens using connector-specific OAuth settings.
   *
   * Serialized per account under a Postgres advisory lock with the stored
   * refresh token re-read inside the lock — so concurrent refreshes across
   * replicas can't both rotate and clobber each other's persisted token.
   */
  async refreshWithConfig(config: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    resource?: string;
    accountId: string;
  }): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string } | null> {
    return this.refreshAccountUnderLock(config.accountId, {
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authMethod: config.authMethod,
      resource: config.resource,
    });
  }

  /**
   * Refresh + persist an account's OAuth token under a per-account Postgres
   * advisory lock. The lock is held for the whole transaction; the stored
   * refresh token and expiry are RE-READ inside the lock so that if a
   * concurrent refresh (this pod or another replica) already rotated the
   * token, the loser uses the freshly-stored refresh token / no-ops on a
   * still-valid expiry instead of replaying a rotated-away token.
   */
  private async refreshAccountUnderLock(
    accountId: string,
    oauthConfig: {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
      resource?: string;
    },
    opts?: { rejectedAccessToken?: string }
  ): Promise<RefreshedTokens | null> {
    let grantRejected = false;
    const refreshed = await this.sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        refreshLockTag(accountId),
      ]);

      // Re-read under the lock: a concurrent refresh may have rotated the
      // refresh token and pushed the expiry out while we waited to acquire it.
      const rows = await tx`
        SELECT
          a."accessToken" as "accessToken",
          a."refreshToken" as "refreshToken",
          a."accessTokenExpiresAt" as "expiresAt"
        FROM "account" a
        WHERE a.id = ${accountId}
        FOR UPDATE
      `;
      const current = rows[0] as
        | { accessToken: string | null; refreshToken: string | null; expiresAt: Date | null }
        | undefined;
      if (!current?.refreshToken) return null;

      // A waiter refreshing after a 401 must compare the token it actually sent
      // with the row re-read under the lock. If they differ, another replica
      // already recovered the account; return that token instead of rotating
      // the new refresh token a second time.
      if (
        opts?.rejectedAccessToken !== undefined &&
        current.accessToken !== opts.rejectedAccessToken &&
        current.accessToken &&
        current.expiresAt
      ) {
        return {
          accessToken: current.accessToken,
          expiresAt: new Date(current.expiresAt),
        };
      }

      if (
        opts?.rejectedAccessToken === undefined &&
        current.expiresAt &&
        !isTokenExpiringSoon(current.expiresAt)
      ) {
        return current.accessToken
          ? { accessToken: current.accessToken, expiresAt: new Date(current.expiresAt) }
          : null;
      }

      const result = await this.requestTokenRefresh({
        ...oauthConfig,
        refreshToken: current.refreshToken,
      });
      if (result === GRANT_REJECTED) {
        await clearRejectedGrant(tx, accountId);
        grantRejected = true;
        return null;
      }
      if (!result) return null;

      await this.persistAccountTokens(accountId, result, tx);
      return result;
    });
    if (grantRejected) await notifyGrantRejected(accountId, await markGrantRejected(this.sql, accountId));
    return refreshed;
  }

  private async persistAccountTokens(
    accountId: string,
    tokens: { accessToken: string; expiresAt: Date; refreshToken?: string },
    sql: DbClient = this.sql
  ): Promise<void> {
    await sql`
      UPDATE "account"
      SET "accessToken" = ${tokens.accessToken},
          "accessTokenExpiresAt" = ${tokens.expiresAt.toISOString()},
          "refreshToken" = COALESCE(${tokens.refreshToken ?? null}, "refreshToken"),
          "updatedAt" = NOW()
      WHERE id = ${accountId}
    `;
  }

  /**
   * Generic OAuth token refresh supporting multiple auth methods.
   * Ported from Termos GenericOAuth2Client.refreshToken().
   */
  async refreshTokenGeneric(params: RefreshParams): Promise<RefreshedTokens | null> {
    const result = await this.requestTokenRefresh(params);
    return result === GRANT_REJECTED ? null : result;
  }

  /**
   * The refresh request, telling a rejected grant apart from every other
   * failure. Only the RFC 6749 §5.2 `invalid_grant` code means the stored grant
   * is dead and needs new consent; other rejections (a bad client, a rate
   * limit, an outage) leave it usable.
   */
  private async requestTokenRefresh(params: RefreshParams): Promise<RefreshedTokens | typeof GRANT_REJECTED | null> {
    const { headers, body } = buildRefreshRequest({
      profile: 'account-credential',
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      refreshToken: params.refreshToken,
      authMethod: params.authMethod,
      resource: params.resource,
    });

    let tokenOrigin: string | undefined;
    try {
      tokenOrigin = new URL(params.tokenUrl).origin;
      // This is the connector-account refresh path: tokenUrl is persisted from
      // connector OAuth metadata, not the operator-trusted gateway login
      // provider configuration. Pin its DNS and never redirect credentials.
      const result = await withConnectorOAuthDeadline(async (signal) => {
        const response = await fetchCredentialedPublicUrl(params.tokenUrl, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal,
        });
        // Only a 400/401 body carries the OAuth error code; cancel any other
        // failure body. A read error must not hide the HTTP status or turn an
        // expected rejection into error telemetry, and the body is never logged.
        if (!response.ok) {
          const grantRejected = (response.status === 400 || response.status === 401)
            && await readOAuthErrorCode(response) === 'invalid_grant';
          if (response.status !== 400 && response.status !== 401) await cancelResponseBody(response);
          return { response, text: '', grantRejected };
        }
        const text = await readConnectorOAuthResponse(response);
        return { response, text, grantRejected: false };
      });

      if (!result.response.ok) {
        const details = {
          token_origin: tokenOrigin,
          status: result.response.status,
          grant_rejected: result.grantRejected,
        };
        // Rejected/expired grants and rate limits are expected client outcomes.
        if (result.response.status >= 400 && result.response.status < 500) {
          logger.warn(details, '[Credentials] Generic token refresh failed');
        } else {
          logger.error(details, '[Credentials] Generic token refresh failed');
        }
        return result.grantRejected ? GRANT_REJECTED : null;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(result.text) as Record<string, unknown>;
      } catch {
        // JSON parser messages can quote provider response bodies containing
        // credentials. Record the failure without the body or parser error.
        logger.error(
          { token_origin: tokenOrigin, status: result.response.status },
          '[Credentials] Generic token refresh returned invalid JSON'
        );
        return null;
      }
      const parsed = parseTokenRefreshResponse(data);
      if (!parsed) {
        logger.error(
          { token_origin: tokenOrigin },
          '[Credentials] Generic token refresh returned no access_token'
        );
        return null;
      }

      return {
        accessToken: parsed.accessToken,
        expiresAt: new Date(parsed.expiresAtMs),
        refreshToken: parsed.refreshToken,
      };
    } catch (error) {
      logger.error(
        { err: scrubDiagnosticValue(error), token_origin: tokenOrigin },
        '[Credentials] Generic token refresh error'
      );
      return null;
    }
  }
}
