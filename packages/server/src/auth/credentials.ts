/**
 * Credential Service — OAuth token resolution and refresh
 *
 * Used by execution-context.ts and mcp-proxy/credential-resolver.ts to
 * resolve and auto-refresh OAuth tokens for upstream API calls.
 */

import type { DbClient } from '../db/client';
import { scrubSentryValue } from '@lobu/core';
import { fetchCredentialedPublicUrl } from '@lobu/connector-worker/egress';
import { cancelResponseBody } from '../utils/bounded-response';
import {
  readConnectorOAuthResponse,
  withConnectorOAuthDeadline,
} from '../utils/connector-oauth-http';
import { buildRefreshRequest, parseTokenRefreshResponse } from './oauth/token-refresh';
import logger from '../utils/logger';

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

export class CredentialService {
  constructor(private sql: DbClient) {}

  /**
   * Get OAuth tokens for a connection (V1 integration platform).
   * Reads from auth_profiles.account_id -> account table.
   * Optionally accepts oauthConfig for generic token refresh (non-Google providers).
   */
  async getConnectionTokens(
    _connectionId: number,
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
        a.scope
      FROM "account" a
      WHERE a.id = ${accountId}
    `;

    if (result.length === 0) return null;

    const tokens = result[0] as unknown as CredentialTokens;

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
  ): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string } | null> {
    return this.sql.begin(async (tx) => {
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

      const result = await this.refreshTokenGeneric({
        ...oauthConfig,
        refreshToken: current.refreshToken,
      });
      if (!result) return null;

      await this.persistAccountTokens(accountId, result, tx);
      return result;
    });
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
  async refreshTokenGeneric(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    resource?: string;
  }): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string } | null> {
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
        // Failure bodies are unused. Cancel them so a read error cannot hide
        // the HTTP status or turn an expected rejection into error telemetry.
        if (!response.ok) {
          await cancelResponseBody(response);
          return { response, text: '' };
        }
        const text = await readConnectorOAuthResponse(response);
        return { response, text };
      });

      if (!result.response.ok) {
        const details = { token_origin: tokenOrigin, status: result.response.status };
        // Rejected/expired grants and rate limits are expected client outcomes.
        if (result.response.status >= 400 && result.response.status < 500) {
          logger.warn(details, '[Credentials] Generic token refresh failed');
        } else {
          logger.error(details, '[Credentials] Generic token refresh failed');
        }
        return null;
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
        { err: scrubSentryValue(error), token_origin: tokenOrigin },
        '[Credentials] Generic token refresh error'
      );
      return null;
    }
  }
}
