/**
 * MCP Proxy Credential Resolver
 *
 * Resolves OAuth credentials for upstream MCP server calls.
 * Uses the same execution-auth seam as feeds and connector actions so local,
 * managed Cloud, and future credential leases cannot drift apart.
 */

import { parseJsonObject } from '@lobu/core';
import { getDb } from '../db/client';
import {
  getOAuthAuthMethods,
  normalizeConnectorAuthSchema,
  resolveEnvHttpCredential,
} from '../utils/connector-auth';
import { resolveExecutionAuth } from '../utils/execution-context';

export interface ResolvedCredentials {
  accessToken: string;
  /** Authorization scheme, e.g. `Bearer`. */
  tokenType: string;
  /** Header that carries `<tokenType> <accessToken>`. */
  header: string;
}

/** The one header a caller sets from resolved credentials. Never log the value. */
export function credentialHeader(credentials: ResolvedCredentials): [string, string] {
  return [credentials.header, `${credentials.tokenType} ${credentials.accessToken}`];
}

/**
 * Resolve OAuth credentials for a specific connection by ID.
 * Used for multi-account support when the caller specifies which connection to use.
 *
 * `rejectedAccessToken` triggers a refresh when that exact stored token was
 * rejected with a 401. Passing the value, rather than a boolean, lets the
 * account lock reuse a token another replica already rotated.
 *
 * `requireDeclaredAnonymous` narrows the null result to connectors whose auth
 * schema offers a `none` method: any other connection without credentials
 * throws, so a caller never sends an unauthenticated request by accident.
 */
export async function resolveCredentialsByConnectionId(
  connectionId: number,
  organizationId: string,
  opts?: { rejectedAccessToken?: string; requireDeclaredAnonymous?: boolean }
): Promise<ResolvedCredentials | null> {
  const sql = getDb();

  const connections = await sql`
    SELECT
      c.auth_profile_id,
      c.app_auth_profile_id,
      c.config,
      cd.auth_schema,
      ap.profile_kind AS auth_profile_kind
    FROM connections c
    LEFT JOIN auth_profiles ap
      ON ap.id = c.auth_profile_id
     AND ap.organization_id = c.organization_id
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
      header: 'Authorization',
    };
  }

  // No App/OAuth/managed token: a connection on env auth may still carry an
  // HTTP credential when the connector declares one env field as such. The
  // value comes from the env profile's resolved secrets and is only ever set
  // as a gateway-side request header.
  if (connection.auth_profile_kind === 'env') {
    const envCredential = resolveEnvHttpCredential(connection.auth_schema);
    const value = envCredential ? resolved.connectionCredentials[envCredential.fieldKey] : undefined;
    if (envCredential && typeof value === 'string' && value.trim()) {
      return {
        accessToken: value.trim(),
        tokenType: envCredential.scheme,
        header: envCredential.header,
      };
    }
  }

  const authSchema = normalizeConnectorAuthSchema(connection.auth_schema);
  const requiresOAuth = getOAuthAuthMethods(authSchema).some((method) => method.required === true);
  const expectedCredentials =
    requiresOAuth ||
    connection.auth_profile_id !== null ||
    connection.app_auth_profile_id !== null ||
    hasManagedBy(connection.config);
  // Normalization defaults empty or malformed schemas to `none`; that is not
  // an explicit declaration allowing an unauthenticated HTTP operation.
  const declaredMethods = parseJsonObject(connection.auth_schema).methods;
  const anonymousDeclared = Array.isArray(declaredMethods) &&
    declaredMethods.some((method) => method?.type === 'none');
  if (expectedCredentials || (opts?.requireDeclaredAnonymous && !anonymousDeclared)) {
    throw new Error(`MCP credentials are unavailable for connection ${connectionId}`);
  }
  return null;
}

interface ConnectionRow {
  auth_profile_id: number | null;
  app_auth_profile_id: number | null;
  config: unknown;
  auth_schema: unknown;
  auth_profile_kind: string | null;
}

function hasManagedBy(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const managedBy = (config as Record<string, unknown>).managedBy;
  return Boolean(managedBy && typeof managedBy === 'object' && !Array.isArray(managedBy));
}
