import { fetchUserInfoWithRaw } from '../connect/oauth-providers';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { splitConfigByFeedScope } from '../tools/admin/helpers/feed-helpers';
import {
  createAuthProfile,
  getPrimaryAuthProfileForKind,
  updateAuthProfile,
} from '../utils/auth-profiles';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from '../utils/connector-auth';
import logger from '../utils/logger';
import { syncOAuthConnectionsForAuthProfile } from '../utils/oauth-connection-state';
import { hasAllScopes, mergeOAuthScopeAuthData, normalizeScopeList } from './oauth/scopes';
import { createProvisionedConnection } from '../utils/provisioned-connection';
import { resolveRequestOrganizationId } from './config';

interface BetterAuthAccountLike {
  id: string;
  userId: string;
  providerId: string;
  accessToken?: string | null;
  scope?: string | null;
}

export async function provisionConnectorFromSocialLogin(params: {
  env: Env;
  request?: Request | null;
  account: BetterAuthAccountLike;
}): Promise<void> {
  const organizationId = await resolveRequestOrganizationId(params.request ?? undefined);
  if (!organizationId) return;

  const provider = params.account.providerId?.trim().toLowerCase();
  if (!provider || !params.account.userId) return;

  const sql = getDb();
  const connectorRows = await sql`
    SELECT key, name, auth_schema, feeds_schema, default_connection_config
    FROM connector_definitions
    WHERE organization_id = ${organizationId}
      AND status = 'active'
    ORDER BY updated_at DESC
  `;

  for (const row of connectorRows as Array<{
    key: string;
    name: string;
    auth_schema: unknown;
    feeds_schema: Record<string, unknown> | null;
    default_connection_config: Record<string, unknown> | null;
  }>) {
    const authSchema = normalizeConnectorAuthSchema(row.auth_schema);
    const oauthMethod = getOAuthAuthMethods(authSchema).find(
      (method) => method.provider.toLowerCase() === provider
    );
    if (!oauthMethod?.loginProvisioning?.autoCreateConnection) continue;

    const accessToken = params.account.accessToken ?? null;
    const { raw: rawUserInfo, normalized: userInfo } = accessToken
      ? await fetchUserInfoWithRaw({
          provider,
          accessToken,
          userinfoUrl: oauthMethod.userinfoUrl,
        })
      : { raw: null, normalized: null };

    const displayLabel = userInfo?.name ?? userInfo?.email ?? params.account.id;
    // Social-login grants are shared by provider. Attribute only this
    // connector's scopes so reconnect cannot request a sibling's permissions.
    const declaredFeedScopes =
      row.feeds_schema && typeof row.feeds_schema === 'object' && !Array.isArray(row.feeds_schema)
        ? Object.values(row.feeds_schema as Record<string, unknown>).flatMap((feed) =>
            normalizeScopeList(
              (feed as Record<string, unknown> | null | undefined)?.requiredScopes
            )
          )
        : [];
    const declaredScopes = normalizeScopeList([
      ...(oauthMethod.loginScopes ?? []),
      ...(oauthMethod.requiredScopes ?? []),
      ...(oauthMethod.optionalScopes ?? []),
      ...declaredFeedScopes,
    ]);
    const filterToDeclared = (scopes: string[]) =>
      scopes.filter((scope) => hasAllScopes(declaredScopes, [scope]));
    const requestedScopes = filterToDeclared(
      normalizeScopeList(
        params.account.scope ?? oauthMethod.loginScopes ?? oauthMethod.requiredScopes
      )
    );
    const grantedScopes = filterToDeclared(normalizeScopeList(params.account.scope));

    const existingProfileRows = await sql`
      SELECT id, slug, auth_data, status, account_id, provider
      FROM auth_profiles
      WHERE organization_id = ${organizationId}
        AND connector_key = ${row.key}
        AND profile_kind = 'oauth_account'
        AND account_id = ${params.account.id}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;

    const existingProfile = existingProfileRows[0] as
      | {
          id: number;
          slug: string;
          auth_data: Record<string, unknown>;
          status: 'active' | 'pending_auth' | 'error' | 'revoked';
          account_id: string | null;
          provider: string | null;
        }
      | undefined;

    const authData = mergeOAuthScopeAuthData(existingProfile?.auth_data ?? {}, {
      requestedScopes,
      grantedScopes,
      identity: rawUserInfo,
    });

    const authProfile = existingProfile
      ? await updateAuthProfile({
          organizationId,
          slug: existingProfile.slug,
          authData,
          accountId: params.account.id,
          provider,
          status: 'active',
        })
      : await createAuthProfile({
          organizationId,
          connectorKey: row.key,
          displayName: `${row.name} (${displayLabel})`,
          slug: `${row.key}-${provider}-account-${displayLabel}`,
          profileKind: 'oauth_account',
          authData,
          accountId: params.account.id,
          provider,
          status: 'active',
          createdBy: params.account.userId,
        });

    if (!authProfile) continue;

    const appAuthProfile = await getPrimaryAuthProfileForKind({
      organizationId,
      connectorKey: row.key,
      profileKind: 'oauth_app',
      provider,
    });

    // Reuse an existing live connection for this connector + OAuth account
    // instead of minting a new one on every login/link event. Dedupe on the
    // STABLE account identity, not just the auth-profile row: the same Google
    // account can surface as several oauth_account profiles over time
    // (re-links, duplicate profile rows), and auto-provisioned connections can
    // carry a null auth_profile_id — so keying on auth_profile_id alone has
    // historically created a duplicate connection per profile. The account
    // identity is matched via the profile link AND the materialized
    // `connections.account_id` (which syncOAuthConnectionsForAuthProfile
    // stamps), so a null-profile row is still found.
    const existingConnectionRows = await sql`
      SELECT c.id, c.auth_profile_id
      FROM connections c
      LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
      WHERE c.organization_id = ${organizationId}
        AND c.connector_key = ${row.key}
        AND c.deleted_at IS NULL
        AND (
          c.auth_profile_id = ${authProfile.id}
          OR ap.account_id = ${params.account.id}
          OR c.account_id = ${params.account.id}
        )
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT 1
    `;

    const existingConnection = existingConnectionRows[0] as
      | { id: number; auth_profile_id: number | null }
      | undefined;

    if (existingConnection) {
      // Reconcile the reused connection: an account match can land on a
      // connection linked to a duplicate/older auth profile (or none). Rebind
      // it to the resolved profile so the final
      // syncOAuthConnectionsForAuthProfile below actually covers it — otherwise
      // the older profile's connection stays stranded/pending while the sync
      // targets the newer profile. A personal-credential (oauth_account)
      // connection must be private, so floor visibility in the same UPDATE:
      // a null-profile row may legally be org-visible, and the trigger rejects
      // attaching an oauth_account profile without flooring it.
      if (existingConnection.auth_profile_id !== authProfile.id) {
        await sql`
          UPDATE connections
          SET auth_profile_id = ${authProfile.id},
              visibility = 'private',
              updated_at = NOW()
          WHERE id = ${existingConnection.id} AND deleted_at IS NULL
        `;
      }
    } else if (appAuthProfile) {
      const mergedConfig = {
        ...((row.default_connection_config as Record<string, unknown> | null) ?? {}),
        __auto_provisioned_login: true,
      };
      const splitConfig = splitConfigByFeedScope(
        mergedConfig,
        row.feeds_schema as Record<string, any> | null
      );

      const createResult = await createProvisionedConnection({
        organizationId,
        connectorKey: row.key,
        displayName: `${row.name} (${displayLabel})`,
        authProfileSlug: authProfile.slug,
        appAuthProfileSlug: appAuthProfile.slug,
        config: splitConfig.connectionConfig ?? {},
        userId: params.account.userId,
        env: params.env,
        requestUrl: params.request?.url,
      });

      if (createResult.error) {
        logger.warn(
          {
            organizationId,
            connectorKey: row.key,
            provider,
            error: createResult.error,
          },
          'Failed to auto-provision connector connection from social login'
        );
      }
    }

    await syncOAuthConnectionsForAuthProfile(organizationId, authProfile.id);
  }
}
