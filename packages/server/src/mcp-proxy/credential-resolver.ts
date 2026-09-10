/**
 * MCP Proxy Credential Resolver
 *
 * Resolves OAuth credentials for upstream MCP server calls.
 * Uses the same execution-auth seam as feeds and connector actions so local,
 * managed Cloud, and future credential leases cannot drift apart.
 */

import { getDb } from '../db/client';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from '../utils/connector-auth';
import { resolveExecutionAuth } from '../utils/execution-context';

export interface ResolvedCredentials {
  accessToken: string;
  tokenType: string;
}

/**
 * Resolve OAuth credentials for a specific connection by ID.
 * Used for multi-account support when the caller specifies which connection to use.
 *
 * `rejectedAccessToken` triggers a refresh when that exact stored token was
 * rejected with a 401. Passing the value, rather than a boolean, lets the
 * account lock reuse a token another replica already rotated.
 */
export async function resolveCredentialsByConnectionId(
  connectionId: number,
  organizationId: string,
  opts?: { rejectedAccessToken?: string }
): Promise<ResolvedCredentials | null> {
  const sql = getDb();

  const connections = await sql`
    SELECT
      c.auth_profile_id,
      c.app_auth_profile_id,
      c.config,
      cd.auth_schema
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.organization_id = c.organization_id
     AND cd.status = 'active'
    WHERE c.id = ${connectionId}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
      AND c.status = 'active'
    ORDER BY cd.updated_at DESC
    LIMIT 1
  `;

  if (connections.length === 0) {
    throw new Error(`MCP connection ${connectionId} is not active or does not exist`);
  }

  const connection = connections[0] as ConnectionRow;
  const resolved = await resolveExecutionAuth({
    organizationId,
    connectionId,
    authProfileId: connection.auth_profile_id,
    appAuthProfileId: connection.app_auth_profile_id,
    credentialDb: sql,
    logContext: { connection_id: connectionId },
    logMessage: 'Failed to resolve MCP execution credentials',
    rejectedAccessToken: opts?.rejectedAccessToken,
  });
  if (resolved.credentials?.accessToken) {
    return {
      accessToken: resolved.credentials.accessToken,
      tokenType: 'Bearer',
    };
  }

  const authSchema = normalizeConnectorAuthSchema(connection.auth_schema);
  const requiresOAuth = getOAuthAuthMethods(authSchema).some((method) => method.required === true);
  const expectedCredentials =
    requiresOAuth ||
    connection.auth_profile_id !== null ||
    connection.app_auth_profile_id !== null ||
    hasManagedBy(connection.config);
  if (expectedCredentials) {
    throw new Error(`MCP credentials are unavailable for connection ${connectionId}`);
  }
  return null;
}

interface ConnectionRow {
  auth_profile_id: number | null;
  app_auth_profile_id: number | null;
  config: unknown;
  auth_schema: unknown;
}

function hasManagedBy(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const managedBy = (config as Record<string, unknown>).managedBy;
  return Boolean(managedBy && typeof managedBy === 'object' && !Array.isArray(managedBy));
}
