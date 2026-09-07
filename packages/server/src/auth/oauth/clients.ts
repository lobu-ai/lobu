/**
 * OAuth Clients Store
 *
 * Manages OAuth client registration and retrieval.
 * Implements RFC 7591 Dynamic Client Registration.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DbClient } from '../../db/client';
import { pgTextArray, parsePgTextArray } from '../../db/client';
import { recordLifecycleEvent } from '../../utils/insert-event';
import type { OAuthClient, OAuthClientMetadata, StoredOAuthClient } from './types';
import { generateClientId, generateClientSecret } from './utils';

/**
 * Hash a client secret using scrypt (similar security to bcrypt)
 * Format: salt:hash (both hex encoded)
 */
export function hashClientSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a client secret against a stored hash
 */
function verifyClientSecret(secret: string, storedHash: string): boolean {
  try {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expectedHash = Buffer.from(hashHex, 'hex');
    const actualHash = scryptSync(secret, salt, 64);

    return timingSafeEqual(expectedHash, actualHash);
  } catch {
    return false;
  }
}

/**
 * OAuth Clients Store
 *
 * Handles dynamic client registration and client lookup.
 */
export class OAuthClientsStore {
  constructor(private sql: DbClient) {}

  async touchClientActivity(params: {
    clientId: string;
    organizationId?: string | null;
    userId?: string | null;
    userAgent?: string | null;
    clientInfo?: Record<string, unknown> | null;
    capabilities?: Record<string, unknown> | null;
  }): Promise<void> {
    const patch: Record<string, unknown> = {
      last_seen_at: Date.now(),
    };

    if (params.userAgent) patch.last_user_agent = params.userAgent;
    if (params.clientInfo) patch.last_client_info = params.clientInfo;
    if (params.capabilities) patch.last_capabilities = params.capabilities;

    await this.sql`
      UPDATE oauth_clients
      SET
        organization_id = COALESCE(organization_id, ${params.organizationId ?? null}),
        user_id = COALESCE(user_id, ${params.userId ?? null}),
        metadata = COALESCE(metadata, '{}'::jsonb) || ${this.sql.json(patch)}::jsonb,
        updated_at = NOW()
      WHERE id = ${params.clientId}
    `;
  }

  /**
   * Get a client by ID
   */
  async getClient(clientId: string): Promise<OAuthClient | null> {
    const result = await this.sql`
      SELECT * FROM oauth_clients WHERE id = ${clientId}
    `;

    if (result.length === 0) return null;

    const client = result[0] as StoredOAuthClient;
    return this.toOAuthClient(client);
  }

  /**
   * Register a new client (RFC 7591)
   *
   * @param metadata - Client metadata from registration request
   * @param userId - Optional user ID if client is user-owned
   * @param organizationId - Optional organization ID for scoping
   * @returns Full client info including credentials (shown once)
   */
  async registerClient(
    metadata: OAuthClientMetadata,
    userId?: string,
    organizationId?: string,
    extraMetadata?: Record<string, unknown>
  ): Promise<OAuthClient> {
    const clientId = generateClientId();
    const clientSecret = generateClientSecret();

    // Hash the client secret for storage
    const clientSecretHash = hashClientSecret(clientSecret);

    // Client secret expires in 1 year
    const clientSecretExpiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000);

    await this.sql`
      INSERT INTO oauth_clients (
        id,
        client_secret,
        client_secret_expires_at,
        redirect_uris,
        token_endpoint_auth_method,
        grant_types,
        response_types,
        client_name,
        client_uri,
        logo_uri,
        scope,
        contacts,
        tos_uri,
        policy_uri,
        software_id,
        software_version,
        user_id,
        organization_id,
        metadata
      ) VALUES (
        ${clientId},
        ${clientSecretHash},
        ${clientSecretExpiresAt},
        ${pgTextArray(metadata.redirect_uris)}::text[],
        ${metadata.token_endpoint_auth_method || 'none'},
        ${pgTextArray(metadata.grant_types || ['authorization_code', 'refresh_token'])}::text[],
        ${pgTextArray(metadata.response_types || ['code'])}::text[],
        ${metadata.client_name || null},
        ${metadata.client_uri || null},
        ${metadata.logo_uri || null},
        ${metadata.scope || null},
        ${metadata.contacts ? pgTextArray(metadata.contacts) : null}::text[],
        ${metadata.tos_uri || null},
        ${metadata.policy_uri || null},
        ${metadata.software_id || null},
        ${metadata.software_version || null},
        ${userId || null},
        ${organizationId || null},
        ${this.sql.json(extraMetadata || {})}
      )
    `;

    if (organizationId) {
      recordLifecycleEvent({
        organizationId,
        entityType: 'client',
        op: 'created',
        entityId: clientId,
        summary: `Connected app "${metadata.client_name || clientId}" registered`,
        extra: { user_id: userId ?? null },
      });
    }

    return {
      ...metadata,
      client_id: clientId,
      client_secret: clientSecret, // Return plaintext, shown only during registration
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: Math.floor(clientSecretExpiresAt.getTime() / 1000),
    };
  }

  /**
   * Verify client credentials
   *
   * @param clientId - Client ID
   * @param clientSecret - Client secret to verify
   * @returns True if credentials are valid
   */
  async verifyClientCredentials(clientId: string, clientSecret: string): Promise<boolean> {
    const result = await this.sql`
      SELECT client_secret, client_secret_expires_at
      FROM oauth_clients
      WHERE id = ${clientId}
    `;

    if (result.length === 0) return false;

    const client = result[0] as Pick<
      StoredOAuthClient,
      'client_secret' | 'client_secret_expires_at'
    >;

    // Check if secret has expired
    if (client.client_secret_expires_at && new Date(client.client_secret_expires_at) < new Date()) {
      return false;
    }

    // Public clients (no secret)
    if (!client.client_secret) {
      return clientSecret === undefined || clientSecret === '';
    }

    // Verify the secret
    return verifyClientSecret(clientSecret, client.client_secret);
  }

  /**
   * Delete a client
   */
  async deleteClient(clientId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM oauth_clients WHERE id = ${clientId}
      RETURNING id, organization_id, client_name
    `;
    if (result.length === 0) return false;
    const row = result[0] as {
      id: string;
      organization_id: string | null;
      client_name: string | null;
    };
    if (row.organization_id) {
      recordLifecycleEvent({
        organizationId: row.organization_id,
        entityType: 'client',
        op: 'deleted',
        entityId: clientId,
        summary: `Connected app "${row.client_name || clientId}" removed`,
      });
    }
    return true;
  }

  /**
   * Revoke a client's tokens and MCP sessions within one organization.
   *
   * A registration can hold grants for several people, so callers may scope
   * the operation to the owner displayed in the connected-apps inventory.
   * Omitting `userId` retains the org-wide operation used by administrative
   * cleanup paths. The registration remains intact for other organizations.
   */
  async revokeClientForOrganization(
    clientId: string,
    organizationId: string,
    userId?: string | null
  ): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      // Shared transaction mutex with auth-code/device exchange and refresh.
      // Once acquired, no token-issuing path for this registration can race
      // the grant narrowing below or re-mint a stale workspace snapshot.
      const clientLock = await tx`
        SELECT id FROM oauth_clients WHERE id = ${clientId} FOR UPDATE
      `;
      if (clientLock.length === 0) return false;

      const affectedUsers = await tx`
        SELECT DISTINCT user_id FROM (
          SELECT user_id
          FROM oauth_tokens
          WHERE client_id = ${clientId}
            AND (
              organization_id = ${organizationId}
              OR granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
            )
            ${userId ? tx`AND user_id = ${userId}` : tx``}
          UNION ALL
          SELECT user_id
          FROM oauth_authorization_codes
          WHERE client_id = ${clientId}
            AND (
              organization_id = ${organizationId}
              OR granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
            )
            ${userId ? tx`AND user_id = ${userId}` : tx``}
          UNION ALL
          SELECT user_id
          FROM oauth_device_codes
          WHERE client_id = ${clientId}
            AND (
              organization_id = ${organizationId}
              OR granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
            )
            ${userId ? tx`AND user_id = ${userId}` : tx``}
          UNION ALL
          SELECT user_id
          FROM mcp_sessions
          WHERE client_id = ${clientId}
            AND organization_id = ${organizationId}
            ${userId ? tx`AND user_id = ${userId}` : tx``}
        ) affected_grants
        WHERE user_id IS NOT NULL
      `;
      const affectedUserIds = affectedUsers.map((row) => String(row.user_id));
      if (affectedUserIds.length === 0) return false;

      // Remove exhausted grants before narrowing so unrelated account-only
      // codes with an existing empty snapshot remain valid.
      const deletedAuthorizationCodes = await tx`
        DELETE FROM oauth_authorization_codes
        WHERE client_id = ${clientId}
          AND (
            organization_id = ${organizationId}
            OR (
              granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
              AND cardinality(array_remove(granted_organization_ids, ${organizationId})) = 0
            )
          )
          ${userId ? tx`AND user_id = ${userId}` : tx``}
        RETURNING code
      `;
      const narrowedAuthorizationCodes = await tx`
        UPDATE oauth_authorization_codes
        SET granted_organization_ids = array_remove(granted_organization_ids, ${organizationId})
        WHERE client_id = ${clientId}
          AND organization_id IS DISTINCT FROM ${organizationId}
          AND granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
          ${userId ? tx`AND user_id = ${userId}` : tx``}
        RETURNING code
      `;

      const deletedDeviceCodes = await tx`
        DELETE FROM oauth_device_codes
        WHERE client_id = ${clientId}
          AND (
            organization_id = ${organizationId}
            OR (
              granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
              AND cardinality(array_remove(granted_organization_ids, ${organizationId})) = 0
            )
          )
          ${userId ? tx`AND user_id = ${userId}` : tx``}
        RETURNING device_code
      `;
      const narrowedDeviceCodes = await tx`
        UPDATE oauth_device_codes
        SET granted_organization_ids = array_remove(granted_organization_ids, ${organizationId})
        WHERE client_id = ${clientId}
          AND organization_id IS DISTINCT FROM ${organizationId}
          AND granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
          ${userId ? tx`AND user_id = ${userId}` : tx``}
        RETURNING device_code
      `;

      const revokedTokens = await tx`
        UPDATE oauth_tokens
        SET
          granted_organization_ids = CASE
            WHEN organization_id = ${organizationId} THEN granted_organization_ids
            ELSE array_remove(granted_organization_ids, ${organizationId})
          END,
          revoked_at = CASE
            WHEN organization_id = ${organizationId}
              OR cardinality(array_remove(granted_organization_ids, ${organizationId})) = 0
            THEN NOW()
            ELSE revoked_at
          END
        WHERE client_id = ${clientId}
          AND (
            organization_id = ${organizationId}
            OR granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
          )
          AND revoked_at IS NULL
          ${userId ? tx`AND user_id = ${userId}` : tx``}
        RETURNING id
      `;

      const deletedSessions = await tx`
        DELETE FROM mcp_sessions
        WHERE client_id = ${clientId}
          AND user_id = ANY(${pgTextArray(affectedUserIds)}::text[])
          -- Unscoped sessions may carry the removed workspace in their grant
          -- snapshot. Scoped sessions are pinned, so preserve a different org.
          AND (organization_id = ${organizationId} OR scoped_to_org = false)
        RETURNING session_id
      `;

      return (
        revokedTokens.length > 0 ||
        narrowedAuthorizationCodes.length > 0 ||
        deletedAuthorizationCodes.length > 0 ||
        narrowedDeviceCodes.length > 0 ||
        deletedDeviceCodes.length > 0 ||
        deletedSessions.length > 0
      );
    });
  }

  /**
   * List clients for a user
   */
  async listClientsByUser(userId: string): Promise<OAuthClient[]> {
    const result = await this.sql`
      SELECT * FROM oauth_clients
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;

    return result.map((client) => this.toOAuthClient(client as StoredOAuthClient));
  }

  /**
   * List clients for an organization with user info and active token counts.
   * Discovers clients via tokens and unexpired approved grant codes since dynamic
   * client registration (RFC 7591) happens before user auth, so clients may
   * not have organization_id set.
   */
  async listClientsByOrganization(organizationId: string): Promise<
    (OAuthClient & {
      metadata: Record<string, unknown>;
      user_name?: string;
      user_email?: string;
      owner_user_id: string | null;
      active_token_count: number;
    })[]
  > {
    const result = await this.sql`
      SELECT
        oc.*,
        COALESCE(token_owner.user_name, code_owner.user_name) AS user_name,
        COALESCE(token_owner.user_email, code_owner.user_email) AS user_email,
        COALESCE(token_owner.token_user_id, code_owner.code_user_id) AS owner_user_id,
        COALESCE(token_counts.active_token_count, 0)::int AS active_token_count
      FROM oauth_clients oc
      LEFT JOIN LATERAL (
        -- Prefer a live grant so a connected row names the person whose access
        -- the revoke action can actually remove. Fall back to the newest stale
        -- grant for disconnected registrations.
        SELECT u.name AS user_name, u.email AS user_email, ot.user_id AS token_user_id
        FROM oauth_tokens ot
        LEFT JOIN "user" u ON u.id = ot.user_id
        WHERE ot.client_id = oc.id
          AND (
            ot.organization_id = ${organizationId}
            OR ot.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
          )
        ORDER BY
          (ot.revoked_at IS NULL AND ot.expires_at > NOW()) DESC,
          ot.created_at DESC,
          ot.id DESC
        LIMIT 1
      ) token_owner ON true
      LEFT JOIN LATERAL (
        SELECT u.name AS user_name, u.email AS user_email, grant_row.user_id AS code_user_id
        FROM (
          SELECT ac.user_id, ac.created_at, ac.code AS grant_id
          FROM oauth_authorization_codes ac
          WHERE ac.client_id = oc.id
            AND ac.expires_at > NOW()
            AND (
              ac.organization_id = ${organizationId}
              OR ac.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
            )
          UNION ALL
          SELECT dc.user_id, dc.created_at, dc.device_code AS grant_id
          FROM oauth_device_codes dc
          WHERE dc.client_id = oc.id
            AND dc.user_id IS NOT NULL
            AND dc.status = 'approved'
            AND dc.expires_at > NOW()
            AND (
              dc.organization_id = ${organizationId}
              OR dc.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
            )
        ) grant_row
        LEFT JOIN "user" u ON u.id = grant_row.user_id
        ORDER BY grant_row.created_at DESC, grant_row.grant_id DESC
        LIMIT 1
      ) code_owner ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (
            WHERE ot.revoked_at IS NULL AND ot.expires_at > NOW()
          )::int AS active_token_count
        FROM oauth_tokens ot
        WHERE ot.client_id = oc.id
          AND (
            ot.organization_id = ${organizationId}
            OR ot.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
          )
      ) token_counts ON true
      WHERE oc.organization_id = ${organizationId}
         OR EXISTS (
           SELECT 1 FROM oauth_tokens ot2
           WHERE ot2.client_id = oc.id
             AND (
               ot2.organization_id = ${organizationId}
               OR ot2.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
             )
         )
         OR code_owner.code_user_id IS NOT NULL
      ORDER BY oc.created_at DESC
    `;

    return result.map((row) => {
      const client = this.toOAuthClient(row as unknown as StoredOAuthClient);
      return {
        ...client,
        user_name: (row as Record<string, unknown>).user_name as string | undefined,
        user_email: (row as Record<string, unknown>).user_email as string | undefined,
        owner_user_id:
          ((row as Record<string, unknown>).owner_user_id as string | null) ?? null,
        active_token_count: (row as Record<string, unknown>).active_token_count as number,
      };
    });
  }

  /**
   * Convert stored client to OAuthClient (without secret)
   */
  private toOAuthClient(
    stored: StoredOAuthClient
  ): OAuthClient & { metadata: Record<string, unknown> } {
    return {
      client_id: stored.id,
      // Never return the secret after registration
      client_id_issued_at: Math.floor(new Date(stored.client_id_issued_at).getTime() / 1000),
      client_secret_expires_at: stored.client_secret_expires_at
        ? Math.floor(new Date(stored.client_secret_expires_at).getTime() / 1000)
        : undefined,
      // `text[]` columns arrive as the raw literal `{a,b}` because the pool
      // runs `fetch_types: false`. Parse at this boundary — it is the single
      // read path for both getClient() and listClientsByOrganization(), and
      // callers do membership tests (`redirect_uris.includes(...)`) that
      // silently degrade to substring matching against a string.
      redirect_uris: parsePgTextArray(stored.redirect_uris),
      token_endpoint_auth_method:
        (stored.token_endpoint_auth_method as
          | 'none'
          | 'client_secret_post'
          | 'client_secret_basic') || 'none',
      grant_types: parsePgTextArray(stored.grant_types),
      response_types: parsePgTextArray(stored.response_types),
      client_name: stored.client_name || undefined,
      client_uri: stored.client_uri || undefined,
      logo_uri: stored.logo_uri || undefined,
      scope: stored.scope || undefined,
      contacts: stored.contacts ? parsePgTextArray(stored.contacts) : undefined,
      tos_uri: stored.tos_uri || undefined,
      policy_uri: stored.policy_uri || undefined,
      software_id: stored.software_id || undefined,
      software_version: stored.software_version || undefined,
      metadata: stored.metadata || {},
    };
  }
}
