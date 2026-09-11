/**
 * Connect Token Utilities
 *
 * Manages connect tokens for the Connect Link flow.
 * Tokens are short-lived (1h default) and authorize unauthenticated
 * users to complete OAuth or env_keys auth for a pending connection.
 */

import { randomBytes } from 'node:crypto';
import { getDb, pgTextArray, type DbClient } from '../db/client';
import logger from './logger';
import { lockOAuthAppBinding } from './oauth-connection-state';

/**
 * Stamped on a connection whose connect token lapsed unused. `connections.connect`
 * matches on it to reissue authorization for that same connection instead of
 * leaving a dead row behind, so the two sites must agree.
 */
export const CONNECT_TOKEN_EXPIRED_ERROR =
  'Connect token expired before authentication was completed';

export interface ConnectTokenRow {
  id: number;
  token: string;
  connection_id: number | null;
  auth_profile_id: number | null;
  organization_id: string;
  connector_key: string;
  auth_type: 'oauth' | 'env_keys';
  auth_config: Record<string, unknown> | null;
  status: 'pending' | 'completed' | 'expired';
  created_by: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
}

interface CreateConnectTokenParams {
  connectionId?: number | null;
  authProfileId?: number | null;
  organizationId: string;
  connectorKey: string;
  authType: 'oauth' | 'env_keys';
  authConfig?: Record<string, unknown>;
  createdBy?: string | null;
  ttlSeconds?: number;
}

/**
 * Generate a cryptographically secure URL-safe token
 */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Create a new connect token for a pending connection
 */
export async function createConnectToken(
  params: CreateConnectTokenParams,
  transaction?: DbClient,
): Promise<ConnectTokenRow> {
  const sql = getDb();
  const token = generateToken();
  const ttlSeconds = params.ttlSeconds ?? 3600; // 1 hour default
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const insert = async (tx: DbClient) => {
    if (params.authType === 'oauth' && params.authProfileId) {
      const selectedAppId = params.authConfig?.appAuthProfileId;
      if (!(await lockOAuthAppBinding(tx, params.organizationId, params.authProfileId,
        typeof selectedAppId === 'number' ? selectedAppId : null, true))) {
        throw new Error('This account is already bound to a different OAuth app. Use a separate account profile for another app.');
      }
    }
    return tx`
    INSERT INTO connect_tokens (
      token, connection_id, auth_profile_id, organization_id, connector_key,
      auth_type, auth_config, created_by, expires_at
    ) VALUES (
      ${token}, ${params.connectionId ?? null}, ${params.authProfileId ?? null},
      ${params.organizationId}, ${params.connectorKey},
      ${params.authType}, ${params.authConfig ? tx.json(params.authConfig) : null},
      ${params.createdBy ?? null},
      ${expiresAt}
    )
    RETURNING *
    `;
  };
  const rows = transaction ? await insert(transaction) : await sql.begin(insert);

  logger.info(
    {
      connection_id: params.connectionId ?? null,
      auth_profile_id: params.authProfileId ?? null,
      connector_key: params.connectorKey,
    },
    'Connect token created'
  );

  return rows[0] as unknown as ConnectTokenRow;
}

/**
 * Look up a pending, non-expired connect token
 */
export async function resolveConnectToken(token: string): Promise<ConnectTokenRow | null> {
  const sql = getDb();

  const rows = await sql`
    SELECT ct.*, cd.name AS connector_name
    FROM connect_tokens ct
    LEFT JOIN connector_definitions cd ON cd.key = ct.connector_key AND cd.status = 'active'
    WHERE ct.token = ${token}
      AND ct.status = 'pending'
      AND ct.expires_at > NOW()
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  return rows[0] as unknown as ConnectTokenRow;
}

/**
 * Expire all pending tokens that have passed their TTL,
 * and mark associated pending_auth connections as revoked.
 */
export async function expireStaleConnectTokens(): Promise<number> {
  const sql = getDb();

  // Expire tokens
  const expired = await sql`
    UPDATE connect_tokens
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at <= NOW()
    RETURNING connection_id
  `;

  if (expired.length === 0) return 0;

  // Revoke connections that no longer have any pending tokens
  const connectionIds = expired
    .map((r: any) => r.connection_id)
    .filter((id: unknown): id is number => Number.isFinite(Number(id)))
    .map((id) => String(id));

  if (connectionIds.length > 0) {
    await sql`
      UPDATE connections
      SET status = 'revoked',
          error_message = ${CONNECT_TOKEN_EXPIRED_ERROR},
          updated_at = NOW()
      WHERE id = ANY(${pgTextArray(connectionIds)}::bigint[])
        AND status = 'pending_auth'
        AND NOT EXISTS (
          SELECT 1 FROM connect_tokens
          WHERE connect_tokens.connection_id = connections.id
            AND connect_tokens.status = 'pending'
        )
    `;
  }

  logger.info(`[ConnectTokens] Expired ${expired.length} stale connect tokens`);
  return expired.length;
}
