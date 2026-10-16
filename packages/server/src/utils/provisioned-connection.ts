/**
 * Service function for creating connections during automated provisioning flows
 * (e.g., social login auto-provisioning). Wraps manage_connections tool handler
 * with proper typing and a simplified return interface.
 */

import { SCOPE_CHECK_NOT_APPLICABLE } from '../auth/tool-access';
import type { Env } from '../index';
import { manageConnections } from '../tools/admin/manage_connections';
import logger from './logger';
import { getConfiguredPublicOrigin } from './public-origin';
import { getErrorMessage } from "@lobu/core";

interface CreateProvisionedConnectionParams {
  organizationId: string;
  connectorKey: string;
  displayName: string;
  authProfileSlug: string;
  appAuthProfileSlug: string;
  config: Record<string, unknown>;
  userId: string;
  env: Env;
  requestUrl?: string;
}

interface CreateProvisionedConnectionResult {
  connectionId: number | null;
  error: string | null;
}

export async function createProvisionedConnection(
  params: CreateProvisionedConnectionParams
): Promise<CreateProvisionedConnectionResult> {
  try {
    const result = await manageConnections(
      {
        action: 'create',
        connector_key: params.connectorKey,
        display_name: params.displayName,
        auth_profile_slug: params.authProfileSlug,
        app_auth_profile_slug: params.appAuthProfileSlug,
        config: params.config,
      } as Parameters<typeof manageConnections>[0],
      params.env,
      {
        organizationId: params.organizationId,
        // No chat turn behind this call (authz/device-access.ts).
        sourceContext: null,
        userId: params.userId,
        memberRole: null,
        isAuthenticated: true,
        tokenType: 'session',
        // Internal session-tier caller: no MCP scope dimension applies.
        scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
        scopedToOrg: true,
        allowCrossOrg: false,
        grantedOrganizationIds: null,
        directSearchFederation: false,
        requestUrl: params.requestUrl,
        baseUrl: getConfiguredPublicOrigin() ?? undefined,
      }
    );

    if ('error' in result && result.error) {
      return { connectionId: null, error: String(result.error) };
    }

    const connectionId =
      'connection' in result
        ? Number((result.connection as { id?: number } | undefined)?.id) || null
        : null;

    return { connectionId, error: null };
  } catch (err) {
    logger.error({ err, connectorKey: params.connectorKey }, 'createProvisionedConnection failed');
    return { connectionId: null, error: getErrorMessage(err) };
  }
}
