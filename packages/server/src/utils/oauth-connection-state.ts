import { getDb } from '../db/client';
import { getAuthProfileById, updateAuthProfile } from './auth-profiles';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from './connector-auth';
import {
  getFeedRequiredScopes,
  hasAllScopes,
  normalizeScopeList,
} from '../auth/oauth/scopes';
import {
  feedOperations,
  type FeedDefinition,
} from '../tools/admin/helpers/feed-helpers';

export const OAUTH_SCOPE_PAUSE_LAST_ERROR =
  'Required OAuth scopes are missing; reconnect the connection to grant access.';

export async function syncOAuthConnectionsForAuthProfile(
  organizationId: string,
  authProfileId: number
): Promise<void> {
  const sql = getDb();
  const authProfile = await getAuthProfileById(organizationId, authProfileId);
  if (!authProfile || authProfile.profile_kind !== 'oauth_account') return;

  if (!authProfile.account_id) {
    await sql`
      UPDATE connections
      SET status = 'pending_auth', account_id = NULL, updated_at = NOW()
      WHERE organization_id = ${organizationId}
        AND auth_profile_id = ${authProfileId}
        AND deleted_at IS NULL
    `;
    await sql`
      UPDATE feeds f
      SET status = 'paused',
          next_run_at = NULL,
          last_error = CASE
            WHEN f.status = 'active'
              THEN ${OAUTH_SCOPE_PAUSE_LAST_ERROR}
            ELSE f.last_error
          END,
          updated_at = NOW()
      FROM connections c
      WHERE f.connection_id = c.id
        AND c.organization_id = ${organizationId}
        AND c.auth_profile_id = ${authProfileId}
        AND c.deleted_at IS NULL
        AND f.deleted_at IS NULL
    `;
    return;
  }

  const [accountRow] = await sql`
    SELECT scope
    FROM "account"
    WHERE id = ${authProfile.account_id}
    LIMIT 1
  `;
  const grantedScopes = normalizeScopeList(
    (accountRow as { scope?: string | null } | undefined)?.scope
  );

  const [connectorRow] = await sql`
    SELECT auth_schema, feeds_schema
    FROM connector_definitions
    WHERE organization_id = ${organizationId}
      AND key = ${authProfile.connector_key}
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  const authSchema = normalizeConnectorAuthSchema(
    (connectorRow as { auth_schema?: unknown } | undefined)?.auth_schema ?? null
  );
  const oauthMethod = getOAuthAuthMethods(authSchema).find(
    (method) => method.provider.toLowerCase() === (authProfile.provider ?? '').toLowerCase()
  );
  // Optional permissions affect the capabilities that declare them, not the
  // health of every operation/feed backed by this account.
  const connectorScopesOk = hasAllScopes(
    grantedScopes,
    normalizeScopeList(oauthMethod?.requiredScopes)
  );

  const currentGrantedScopes = normalizeScopeList(authProfile.auth_data?.granted_scopes);
  const nextProfileStatus = connectorScopesOk ? 'active' : 'pending_auth';
  if (
    authProfile.status !== nextProfileStatus ||
    currentGrantedScopes.join(' ') !== grantedScopes.join(' ')
  ) {
    await updateAuthProfile({
      organizationId,
      slug: authProfile.slug,
      authData: {
        ...(authProfile.auth_data ?? {}),
        granted_scopes: grantedScopes,
      },
      status: nextProfileStatus,
      accountId: authProfile.account_id,
      provider: authProfile.provider,
    });
  }

  const feedRows = await sql`
    SELECT f.id, f.feed_key, f.status, f.last_error, c.id AS connection_id
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE c.organization_id = ${organizationId}
      AND c.auth_profile_id = ${authProfileId}
      AND c.deleted_at IS NULL
      AND f.deleted_at IS NULL
  `;

  const feedsSchema =
    (connectorRow as { feeds_schema?: Record<string, unknown> } | undefined)?.feeds_schema ?? null;

  for (const row of feedRows as Array<{
    id: number;
    feed_key: string;
    status: string;
    last_error: string | null;
    connection_id: number;
  }>) {
    const feedScopesOk = hasAllScopes(
      grantedScopes,
      getFeedRequiredScopes(feedsSchema, row.feed_key)
    );
    const feedEligible = connectorScopesOk && feedScopesOk;
    const canSync = feedOperations(
      feedsSchema as Record<string, FeedDefinition> | null,
      row.feed_key
    ).includes('sync');
    const scopePaused = row.last_error === OAUTH_SCOPE_PAUSE_LAST_ERROR;
    if (row.status === 'active' && !feedEligible) {
      await sql`
        UPDATE feeds
        SET status = 'paused',
            next_run_at = NULL,
            last_error = ${OAUTH_SCOPE_PAUSE_LAST_ERROR},
            updated_at = NOW()
        WHERE id = ${row.id}
          AND status = 'active'
      `;
    } else if (row.status === 'paused' && feedEligible && scopePaused) {
      await sql`
        UPDATE feeds
        SET status = 'active',
            next_run_at = CASE
              WHEN ${canSync} AND schedule IS NOT NULL THEN NOW()
              ELSE NULL
            END,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = ${row.id}
          AND status = 'paused'
          AND last_error = ${OAUTH_SCOPE_PAUSE_LAST_ERROR}
      `;
    } else if (row.status === 'active' && feedEligible && scopePaused) {
      await sql`
        UPDATE feeds
        SET last_error = NULL,
            updated_at = NOW()
        WHERE id = ${row.id}
          AND status = 'active'
          AND last_error = ${OAUTH_SCOPE_PAUSE_LAST_ERROR}
      `;
    }
  }

  const connectionRows = await sql`
    SELECT id, status
    FROM connections
    WHERE organization_id = ${organizationId}
      AND auth_profile_id = ${authProfileId}
      AND deleted_at IS NULL
  `;

  for (const row of connectionRows as Array<{ id: number; status: string }>) {
    // A paused connection was stopped for a lifecycle reason (uninstall,
    // unpair, channel removal), not a credential one — renewing the grant must
    // not silently restart it. 'revoked' IS a credential failure, so a fresh
    // grant is exactly what recovers it.
    if (row.status === 'paused') continue;
    const nextConnectionStatus = connectorScopesOk ? 'active' : 'pending_auth';
    await sql`
      UPDATE connections
      SET status = ${nextConnectionStatus},
          account_id = ${authProfile.account_id},
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }
}
