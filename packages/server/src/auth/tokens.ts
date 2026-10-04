/**
 * Personal Access Token (PAT) Service
 *
 * Manages PATs for workers, CLI tools, and MCP clients.
 * Users generate tokens from the CLI or an authenticated control-plane session
 * and use them for programmatic access.
 */

import type { DbClient } from '../db/client';
import type { AuthInfo, PATCreateResponse, PATListItem, StoredPAT } from './oauth/types';
import { AVAILABLE_SCOPES, POLICY_WRITE_SCOPE } from './oauth/scopes';
import { calculateExpiry, generatePAT, getPATPrefix, hashToken, parseScopes } from './oauth/utils';

/**
 * Personal Access Token Service
 */
export class PersonalAccessTokenService {
  constructor(private sql: DbClient) {}

  /**
   * Create a new Personal Access Token
   *
   * @param userId - User ID
   * @param organizationId - Organization ID (for scoping)
   * @param name - User-friendly name
   * @param options - Optional settings
   * @returns PAT with plaintext token (shown only once)
   */
  async create(
    userId: string,
    organizationId: string | null,
    name: string,
    options?: {
      description?: string;
      scope?: string;
      expiresInDays?: number;
      /**
       * Bind the PAT to a specific device_workers.worker_id. The
       * worker-poll handler will reject requests whose body posts a
       * different worker_id. Used by /api/me/devices/mint-child-token to
       * pin sibling-device tokens to the worker_id minted for them.
       */
      workerId?: string;
    }
  ): Promise<PATCreateResponse> {
    const token = generatePAT();
    const tokenHash = hashToken(token);
    const tokenPrefix = getPATPrefix(token);

    const expiresAt = options?.expiresInDays
      ? calculateExpiry(options.expiresInDays * 24 * 3600)
      : null; // No expiry by default

    const result = await this.sql`
      INSERT INTO personal_access_tokens (
        token_hash, token_prefix, user_id, organization_id,
        name, description, scope, expires_at, worker_id
      ) VALUES (
        ${tokenHash},
        ${tokenPrefix},
        ${userId},
        ${organizationId},
        ${name},
        ${options?.description || null},
        ${options?.scope || null},
        ${expiresAt},
        ${options?.workerId || null}
      )
      RETURNING id, created_at
    `;

    const row = result[0] as { id: number; created_at: Date };

    return {
      id: row.id,
      token, // Plaintext token, shown only once
      token_prefix: tokenPrefix,
      name,
      scope: options?.scope || null,
      expires_at: expiresAt,
      created_at: row.created_at,
    };
  }

  /**
   * Verify a PAT and return auth info
   */
  async verify(token: string): Promise<AuthInfo | null> {
    // Check if it looks like a PAT
    if (!token.startsWith('owl_pat_')) {
      return null;
    }

    const tokenHash = hashToken(token);

    const result = await this.sql`
      SELECT t.*, u.email, u.name as user_name
      FROM personal_access_tokens t
      JOIN "user" u ON t.user_id = u.id
      WHERE t.token_hash = ${tokenHash}
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > NOW())
    `;

    if (result.length === 0) return null;

    const pat = result[0] as StoredPAT & { email: string; user_name: string };

    // Update last_used_at (async, don't wait)
    this.updateLastUsed(pat.id).catch((err) => {
      console.error('[PAT] Failed to update last_used_at:', err);
    });

    return {
      userId: pat.user_id,
      organizationId: pat.organization_id,
      grantedOrganizationIds: null,
      clientId: `pat_${pat.id}`,
      scopes: parseScopes(pat.scope, [...AVAILABLE_SCOPES, POLICY_WRITE_SCOPE]),
      expiresAt: pat.expires_at
        ? Math.floor(new Date(pat.expires_at).getTime() / 1000)
        : Number.MAX_SAFE_INTEGER,
      tokenType: 'pat',
      workerId: (pat as unknown as { worker_id?: string | null }).worker_id ?? null,
    };
  }

  /**
   * Update last_used_at timestamp, at most once per five minutes: verify runs
   * on every authenticated request and each rewrite leaves a dead row behind.
   */
  private async updateLastUsed(id: number): Promise<void> {
    await this.sql`
      UPDATE personal_access_tokens
      SET last_used_at = NOW()
      WHERE id = ${id}
        AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')
    `;
  }

  /**
   * List PATs for a user (no plaintext tokens)
   */
  async list(userId: string): Promise<PATListItem[]> {
    const result = await this.sql`
      SELECT
        id, token_prefix, name, description, scope,
        expires_at, last_used_at, created_at
      FROM personal_access_tokens
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;

    return result as unknown as PATListItem[];
  }

  /**
   * Get a single PAT by ID (for user)
   */
  async get(id: number, userId: string): Promise<PATListItem | null> {
    const result = await this.sql`
      SELECT
        id, token_prefix, name, description, scope,
        expires_at, last_used_at, created_at
      FROM personal_access_tokens
      WHERE id = ${id}
        AND user_id = ${userId}
        AND revoked_at IS NULL
    `;

    return result.length > 0 ? (result[0] as PATListItem) : null;
  }

  /**
   * Revoke a PAT
   */
  async revoke(id: number, userId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE personal_access_tokens
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
        AND user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING id
    `;

    return result.length > 0;
  }

  /**
   * Revoke all PATs for a user
   */
  async revokeAll(userId: string): Promise<number> {
    const result = await this.sql`
      UPDATE personal_access_tokens
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING id
    `;

    return result.length;
  }

  /**
   * Update PAT metadata
   */
  async update(
    id: number,
    userId: string,
    updates: { name?: string; description?: string }
  ): Promise<boolean> {
    // If no updates provided, return false
    if (updates.name === undefined && updates.description === undefined) {
      return false;
    }

    // Use COALESCE to keep existing values if not provided
    const result = await this.sql`
      UPDATE personal_access_tokens
      SET
        name = COALESCE(${updates.name ?? null}, name),
        description = COALESCE(${updates.description ?? null}, description),
        updated_at = NOW()
      WHERE id = ${id}
        AND user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING id
    `;

    return result.length > 0;
  }
}
