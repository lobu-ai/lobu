/**
 * Tool: manage_auth_profiles
 *
 * Manage reusable auth profiles for connector authentication.
 *
 * Actions:
 * - list_auth_profiles: List reusable auth profiles
 * - get_auth_profile: Get a reusable auth profile
 * - test_auth_profile: Test a reusable auth profile
 * - create_auth_profile: Create a reusable auth profile
 * - update_auth_profile: Update a reusable auth profile
 * - delete_auth_profile: Delete a reusable auth profile
 */

import { type Static } from '@sinclair/typebox';
import {
  CreateAuthProfileAction,
  DeleteAuthProfileAction,
  GetAuthProfileAction,
  ListAuthProfilesAction,
  ManageAuthProfilesResultSchema,
  ManageAuthProfilesSchema,
  SetDefaultAuthProfileAction,
  TestAuthProfileAction,
  UpdateAuthProfileAction,
  type ManageAuthProfilesResult,
} from '@lobu/core/contracts/tools/manage-auth-profiles';
import { oauthAccountOwnershipError } from '../../authz/oauth-account-ownership';
import { getDb } from '../../db/client';
import {
  type AuthProfileKind,
  type AuthProfileStatus,
  createAuthProfile,
  deleteAuthProfile,
  findPendingAuthProfile,
  getAuthProfileBySlug,
  getBrowserSessionReadiness,
  listAuthProfiles,
  normalizeAuthProfileSlug,
  normalizeAuthValues,
  PendingAuthConflictError,
  revokeOAuthAppProfileAtomic,
  setDefaultAuthProfileForConnector,
  summarizeBrowserSessionAuthData,
  updateAuthProfile,
} from '../../utils/auth-profiles';
import { recordToolConfigChange } from "./helpers/config-audit";
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';
import { getScopedConnectorDefinition } from "../../catalog/connector-definitions";
import { ensureConnectorInstalled } from '../../utils/ensure-connector-installed';
import { callerIsAdmin } from './helpers/db-helpers';
import {
  getEnvKeyMethods,
  getOAuthCredentialKeys,
  getOAuthMethods,
  issueOAuthReconnectLink,
  resolveRequestedOAuthScopes,
  resolveOAuthProfileApp,
  serializeAuthProfile,
} from './helpers/connection-helpers';

// ============================================
// Helpers
// ============================================

/**
 * Centralizes the message that four handlers (get / test / delete / set_default)
 * previously repeated verbatim after a `getAuthProfileBySlug` miss. Returns the
 * `{ error }` shape (not a throw) to preserve the existing 200-with-error-body
 * response.
 */
function authProfileNotFound(slug: string): { error: string } {
  return { error: `Auth profile '${slug}' not found` };
}

/**
 * Config-audit emission for auth-profile mutations. `state` is the
 * serializeAuthProfile shape — the sanitized snapshot already used for tool
 * responses (no raw credentials/auth_data) — and the writer redacts again on
 * top of that.
 */
function recordAuthProfileConfigChange(
  ctx: ToolContext,
  params: {
    resourceId: string | number;
    op: 'created' | 'updated' | 'deleted';
    summary: string;
    state: Record<string, unknown> | null;
    changedFields?: string[];
  }
): void {
  recordToolConfigChange(ctx, {
    resourceKind: 'auth-profile',
    ...params,
  });
}

// ============================================
// Main Function (Action Router)
// ============================================

const manageAuthProfilesTool = defineActionTool('manage_auth_profiles', {
  list_auth_profiles: action(ListAuthProfilesAction, handleListAuthProfiles),
  get_auth_profile: action(GetAuthProfileAction, handleGetAuthProfile),
  test_auth_profile: action(TestAuthProfileAction, handleTestAuthProfile),
  create_auth_profile: action(CreateAuthProfileAction, handleCreateAuthProfile),
  update_auth_profile: action(UpdateAuthProfileAction, handleUpdateAuthProfile),
  delete_auth_profile: action(DeleteAuthProfileAction, handleDeleteAuthProfile),
  set_default_auth_profile: action(SetDefaultAuthProfileAction, handleSetDefaultAuthProfile),
});

export { ManageAuthProfilesResultSchema, ManageAuthProfilesSchema };
export const manageAuthProfiles = manageAuthProfilesTool.run;

// ============================================
// Action Handlers
// ============================================

async function handleListAuthProfiles(
  args: Static<typeof ListAuthProfilesAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const authProfiles = await listAuthProfiles({
    organizationId: ctx.organizationId,
    connectorKey: args.connector_key ?? null,
    profileKind: (args.profile_kind as AuthProfileKind | undefined) ?? null,
    provider: args.provider ?? null,
  });

  return {
    action: 'list_auth_profiles',
    auth_profiles: authProfiles.map(serializeAuthProfile),
  };
}

async function handleGetAuthProfile(
  args: Static<typeof GetAuthProfileAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const authProfile = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
  if (!authProfile) {
    return authProfileNotFound(args.auth_profile_slug);
  }

  return {
    action: 'get_auth_profile',
    auth_profile: serializeAuthProfile(authProfile),
  };
}

async function handleTestAuthProfile(
  args: Static<typeof TestAuthProfileAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const authProfile = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
  if (!authProfile) {
    return authProfileNotFound(args.auth_profile_slug);
  }

  if (authProfile.profile_kind === 'browser_session') {
    const summary = summarizeBrowserSessionAuthData(
      authProfile.auth_data,
      authProfile.connector_key
    );
    if (summary.cookie_count === 0) {
      return {
        action: 'test_auth_profile',
        status: 'warning',
        message: `Browser session profile '${authProfile.slug}' has no cookies`,
        ...summary,
      };
    }
    if (!summary.auth_cookie_name) {
      return {
        action: 'test_auth_profile',
        status: 'warning',
        message: `Browser session profile '${authProfile.slug}' has cookies but no likely auth cookie`,
        ...summary,
      };
    }
    return {
      action: 'test_auth_profile',
      status: summary.is_expired ? 'error' : 'ok',
      message: summary.is_expired
        ? `${summary.auth_cookie_name} expired`
        : `${summary.auth_cookie_name} valid`,
      ...summary,
    };
  }

  if (authProfile.profile_kind === 'oauth_account') {
    const sql = getDb();
    if (!authProfile.account_id) {
      return {
        action: 'test_auth_profile',
        status: 'warning',
        message: `OAuth account profile '${authProfile.slug}' is not linked yet`,
      };
    }

    const rows = await sql`
      SELECT "accessToken" IS NOT NULL AS has_token,
             "accessTokenExpiresAt",
             "refreshToken" IS NOT NULL AS has_refresh
      FROM "account"
      WHERE id = ${authProfile.account_id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return {
        action: 'test_auth_profile',
        status: 'error',
        message: `OAuth account profile '${authProfile.slug}' is linked to a missing account`,
      };
    }

    const account = rows[0] as {
      has_token: boolean;
      accessTokenExpiresAt: string | null;
      has_refresh: boolean;
    };
    if (!account.has_token) {
      return {
        action: 'test_auth_profile',
        status: 'error',
        message: `OAuth account profile '${authProfile.slug}' has no access token`,
      };
    }

    const expiresAt = account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt).toISOString()
      : null;
    const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
    return {
      action: 'test_auth_profile',
      status: isExpired && !account.has_refresh ? 'error' : 'ok',
      message: isExpired
        ? account.has_refresh
          ? 'Token expired but refresh token available'
          : 'Token expired and no refresh token'
        : 'Credentials valid',
      expires_at: expiresAt,
    };
  }

  const authValues = normalizeAuthValues(authProfile.auth_data);
  const hasKeys = Object.keys(authValues).length > 0;
  return {
    action: 'test_auth_profile',
    status: hasKeys ? 'ok' : 'warning',
    message: hasKeys
      ? `Auth profile '${authProfile.slug}' configured`
      : `Auth profile '${authProfile.slug}' has no credentials`,
  };
}

/**
 * When an oauth_app profile is revoked/errored, any connection that mints
 * tokens against it can no longer authenticate. Flip those connections to
 * pending_auth so the UI surfaces the breakage; the admin re-pins or rotates
 * the app, then operators re-authorize the connection.
 */
async function syncConnectionsForOAuthAppProfile(
  organizationId: string,
  authProfileId: number,
  active: boolean
): Promise<void> {
  const sql = getDb();
  const nextConnectionStatus = active ? 'active' : 'pending_auth';

  await sql`
    UPDATE connections
    SET status = ${nextConnectionStatus},
        updated_at = NOW()
    WHERE organization_id = ${organizationId}
      AND app_auth_profile_id = ${authProfileId}
      AND deleted_at IS NULL
  `;
}

async function syncConnectionsForBrowserAuthProfile(
  organizationId: string,
  authProfileId: number,
  active: boolean
): Promise<void> {
  const sql = getDb();
  const nextConnectionStatus = active ? 'active' : 'pending_auth';
  const nextFeedStatus = active ? 'active' : 'paused';
  const nextRunAtValue = active ? sql`NOW()` : sql`NULL`;

  await sql`
    UPDATE connections
    SET status = ${nextConnectionStatus},
        updated_at = NOW()
    WHERE organization_id = ${organizationId}
      AND auth_profile_id = ${authProfileId}
  `;

  await sql`
    UPDATE feeds f
    SET status = ${nextFeedStatus},
        next_run_at = ${nextRunAtValue},
        updated_at = NOW()
    FROM connections c
    WHERE f.connection_id = c.id
      AND c.organization_id = ${organizationId}
      AND c.auth_profile_id = ${authProfileId}
  `;
}

async function handleCreateAuthProfile(
  args: Static<typeof CreateAuthProfileAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  // Only oauth_account profiles are user-personal; every other kind is an
  // org-shared credential (env keys, OAuth app client_id/secret, browser
  // session, interactive). Gate non-personal kinds on admin role.
  if (args.profile_kind !== 'oauth_account') {
    if (!(await callerIsAdmin(getDb(), ctx))) {
      return {
        error: `Only admins can create ${args.profile_kind} auth profiles. Ask an organization owner or admin to configure these credentials.`,
      };
    }
  }

  // Auto-install the connector from the bundled catalog if the org hasn't
  // installed it yet — parity with `manage_connections create`. Without this,
  // seeding a fresh org hits a chicken/egg: an auth profile needs the connector
  // installed, but the only other installer is creating a connection, which
  // needs the auth profile. A no-op when already installed or not bundled.
  if (args.connector_key) {
    await ensureConnectorInstalled({
      organizationId: ctx.organizationId,
      connectorKey: args.connector_key,
    });
  }

  // browser_session profiles are device-scoped; connector_key is optional
  // for sessions shared by multiple connectors. Other kinds remain
  // per-connector and require it.
  const connector = args.connector_key
    ? await getScopedConnectorDefinition({
        organizationId: ctx.organizationId,
        connectorKey: args.connector_key,
      })
    : null;

  if (args.connector_key && !connector) {
    return { error: `Connector '${args.connector_key}' not found or not active` };
  }

  // Handle browser_session up front — it's the only kind that may skip
  // connector_key entirely. Everything below assumes a connector context.
  if (args.profile_kind === 'browser_session') {
    return handleCreateBrowserSessionProfile(args, ctx);
  }

  if (!args.connector_key || !connector) {
    return { error: `connector_key is required for ${args.profile_kind} auth profiles` };
  }
  const connectorKey: string = args.connector_key;

  if (args.profile_kind === 'oauth_account') {
    const oauthMethod = getOAuthMethods(connector.auth_schema)[0];
    if (!oauthMethod) {
      return { error: `Connector '${connectorKey}' does not support OAuth account profiles` };
    }

    const displayName =
      args.display_name || `${connector.name} ${oauthMethod.provider} Account`;
    // Idempotent: if a profile with this slug already exists, reuse it (issue a
    // fresh connect token if it still needs auth). This lets a connection
    // reference `auth_profile_slug = <slug>` in the *same* `lobu apply` —
    // previously this branch never persisted a row, so the slug didn't resolve.
    let existing = args.slug
      ? await getAuthProfileBySlug(ctx.organizationId, normalizeAuthProfileSlug(args.slug, displayName))
      : null;
    // When no slug was provided, repeat clicks from the UI ("create OAuth
    // account") would otherwise hit the partial unique index
    // `auth_profiles_pending_oauth_account_unique` and leak a raw PG error
    // to the user. Reuse any existing pending row this caller already owns
    // for the (connector, provider) tuple instead — same semantics as the
    // slug-keyed branch. The index is keyed per-user, so two members can
    // still run parallel OAuth flows for the same connector.
    if (!existing && !args.slug) {
      existing = await findPendingAuthProfile({
        organizationId: ctx.organizationId,
        connectorKey,
        profileKind: 'oauth_account',
        provider: oauthMethod.provider,
        createdBy: ctx.userId ?? null,
      });
    }
    const appSelection = await resolveOAuthProfileApp({ ctx, connectorKey, method: oauthMethod,
      appAuthProfileSlug: args.app_auth_profile_slug, authProfile: existing ?? undefined });
    if ('error' in appSelection) return appSelection;
    if (existing) {
      if (existing.profile_kind !== 'oauth_account' || existing.connector_key !== connectorKey) {
        return {
          error: `Auth profile '${existing.slug}' already exists with a different kind/connector (${existing.profile_kind} / ${existing.connector_key}) — use a new slug`,
        };
      }
      // Callers reusing an existing oauth_account slug must own it —
      // otherwise a caller who knows another member's pending profile slug
      // could mint a fresh connect token for it and complete OAuth into a
      // profile already referenced by someone else's connections.
      if (oauthAccountOwnershipError(existing, ctx.userId)) {
        return {
          error: `Auth profile '${existing.slug}' belongs to another user. Choose a different slug.`,
        };
      }
      if (existing.status === 'active') {
        return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(existing) };
      }
      const reconnect = await issueOAuthReconnectLink({ authProfile: existing, ctx,
        requestedScopes: args.requested_scopes, appAuthProfileSlug: args.app_auth_profile_slug });
      if ('error' in reconnect) return reconnect;
      return {
        action: 'create_auth_profile',
        auth_profile: serializeAuthProfile(existing),
        connect_url: reconnect.connectUrl,
        connect_token: reconnect.connectToken,
      };
    }

    // Create a real `pending_auth` row up front so downstream
    // `auth_profile_slug` lookups (connection create, etc.) resolve. The OAuth
    // callback flips it to `active` once the user finishes authorization.
    // The `findPendingAuthProfile` lookup above is the happy-path dedup; the
    // try/catch here closes the race window between that SELECT and this
    // INSERT (and surfaces an explicit slug collision with a friendly error
    // instead of the raw PG constraint name).
    let authProfile: Awaited<ReturnType<typeof createAuthProfile>>;
    try {
      authProfile = await createAuthProfile({
        organizationId: ctx.organizationId,
        connectorKey,
        displayName,
        slug: args.slug,
        profileKind: 'oauth_account',
        authData: {},
        provider: oauthMethod.provider.toLowerCase(),
        status: 'pending_auth',
        createdBy: ctx.userId ?? 'api',
      });
    } catch (err) {
      if (err instanceof PendingAuthConflictError) {
        return { error: err.message };
      }
      throw err;
    }

    let reconnect: Awaited<ReturnType<typeof issueOAuthReconnectLink>>;
    try {
      reconnect = await issueOAuthReconnectLink({ authProfile, ctx,
        requestedScopes: args.requested_scopes, appAuthProfileSlug: args.app_auth_profile_slug });
      if ('error' in reconnect) {
        await deleteAuthProfile(ctx.organizationId, authProfile.slug);
        return reconnect;
      }
    } catch (err) {
      await deleteAuthProfile(ctx.organizationId, authProfile.slug).catch(() => undefined);
      throw err;
    }

    recordAuthProfileConfigChange(ctx, {
      resourceId: authProfile.slug,
      op: 'created',
      summary: `Auth profile '${authProfile.display_name ?? authProfile.slug}' created`,
      state: serializeAuthProfile(authProfile),
    });

    return {
      action: 'create_auth_profile',
      auth_profile: serializeAuthProfile(authProfile),
      connect_url: reconnect.connectUrl,
      connect_token: reconnect.connectToken,
    };
  }

  const credentials = normalizeAuthValues(args.credentials ?? {});
  if (Object.keys(credentials).length === 0) {
    const expectedKeys: string[] = [];
    if (args.profile_kind === 'oauth_app') {
      const oauthMethod = getOAuthMethods(connector.auth_schema)[0];
      if (oauthMethod) {
        const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(oauthMethod);
        expectedKeys.push(clientIdKey, clientSecretKey);
      }
    } else {
      const envMethod = getEnvKeyMethods(connector.auth_schema)[0];
      if (envMethod?.fields) {
        for (const field of envMethod.fields) {
          if (field.required !== false) expectedKeys.push(field.key);
        }
      }
    }
    const hint = expectedKeys.length > 0 ? ` Expected keys: ${expectedKeys.join(', ')}` : '';
    return { error: `Credentials are required for ${args.profile_kind} auth profiles.${hint}` };
  }

  const provider =
    args.profile_kind === 'oauth_app'
      ? (getOAuthMethods(connector.auth_schema)[0]?.provider ?? null)
      : null;

  const authProfile = await createAuthProfile({
    organizationId: ctx.organizationId,
    connectorKey,
    displayName: args.display_name,
    slug: args.slug,
    profileKind: args.profile_kind,
    authData: credentials,
    provider,
    createdBy: ctx.userId ?? 'api',
  });

  recordAuthProfileConfigChange(ctx, {
    resourceId: authProfile.slug,
    op: 'created',
    summary: `Auth profile '${authProfile.display_name ?? authProfile.slug}' created`,
    state: serializeAuthProfile(authProfile),
  });

  return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
}

async function handleCreateBrowserSessionProfile(
  args: Static<typeof CreateAuthProfileAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const authData = (args.auth_data as Record<string, unknown> | undefined) ?? {};
  const browserSessionReady = (await getBrowserSessionReadiness(authData)).usable;
  const authProfile = await createAuthProfile({
    organizationId: ctx.organizationId,
    connectorKey: null,
    displayName: args.display_name,
    slug: args.slug,
    profileKind: 'browser_session',
    authData,
    status: browserSessionReady ? 'active' : 'pending_auth',
    createdBy: ctx.userId ?? 'api',
  });

  recordAuthProfileConfigChange(ctx, {
    resourceId: authProfile.slug,
    op: 'created',
    summary: `Auth profile '${authProfile.display_name ?? authProfile.slug}' created`,
    state: serializeAuthProfile(authProfile),
  });

  return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
}

async function handleUpdateAuthProfile(
  args: Static<typeof UpdateAuthProfileAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  // Mirror create gating: only oauth_account profiles are member-editable.
  // env / oauth_app / browser_session are org-shared credentials — admin only.
  // Personal OAuth grants remain owner-only even for workspace administrators.
  const existingForRoleCheck = await getAuthProfileBySlug(
    ctx.organizationId,
    args.auth_profile_slug
  );
  if (existingForRoleCheck) {
    const isAdmin = await callerIsAdmin(getDb(), ctx);
    if (existingForRoleCheck.profile_kind !== 'oauth_account' && !isAdmin) {
      return {
        error: `Only admins can modify ${existingForRoleCheck.profile_kind} auth profiles.`,
      };
    }
    const ownershipError = oauthAccountOwnershipError(existingForRoleCheck, ctx.userId);
    if (ownershipError) return { error: ownershipError };

  }

  if (args.reconnect && existingForRoleCheck?.connector_key) {
    const connector = await getScopedConnectorDefinition({ organizationId: ctx.organizationId, connectorKey: existingForRoleCheck.connector_key });
    const method = connector && getOAuthMethods(connector.auth_schema).find(method => method.provider.toLowerCase() === existingForRoleCheck.provider?.toLowerCase());
    if (method) {
      const selection = await resolveOAuthProfileApp({ ctx, connectorKey: existingForRoleCheck.connector_key,
        method, appAuthProfileSlug: args.app_auth_profile_slug, authProfile: existingForRoleCheck });
      if ('error' in selection) return selection;
    }
  }

  // The payload that will actually be persisted: an explicit `auth_data` wins,
  // else `credentials` (normalized to a string map), else undefined (leave the
  // existing auth_data as-is).
  const updateAuthDataPayload: Record<string, unknown> | undefined =
    args.auth_data !== undefined
      ? { ...(args.auth_data as Record<string, unknown>) }
      : args.credentials
        ? normalizeAuthValues(args.credentials)
        : undefined;

  // The grant's identity and app binding are callback-owned, including raw profile patches.
  if (updateAuthDataPayload && existingForRoleCheck?.profile_kind === 'oauth_account') {
    delete updateAuthDataPayload.identity;
    if (existingForRoleCheck.auth_data?.identity !== undefined) {
      updateAuthDataPayload.identity = existingForRoleCheck.auth_data.identity;
    }
    delete updateAuthDataPayload.app_auth_profile_id;
    if (existingForRoleCheck.auth_data?.app_auth_profile_id !== undefined) {
      updateAuthDataPayload.app_auth_profile_id = existingForRoleCheck.auth_data.app_auth_profile_id;
    }
  }
  if (args.app_auth_profile_slug && !args.reconnect) {
    return { error: 'app_auth_profile_slug selects an app for reconnect=true; it cannot rebind a saved account grant.' };
  }

  let authProfile = await updateAuthProfile({
    organizationId: ctx.organizationId,
    slug: args.auth_profile_slug,
    displayName: args.display_name,
    nextSlug: args.slug,
    authData: updateAuthDataPayload,
    status: args.status as AuthProfileStatus | undefined,
  });

  if (!authProfile) {
    return { error: `Auth profile '${args.auth_profile_slug}' not found` };
  }

  const updateChangedFields = [
    ...(args.display_name !== undefined ? ['display_name'] : []),
    ...(args.slug !== undefined ? ['slug'] : []),
    ...(updateAuthDataPayload !== undefined ? ['credentials'] : []),
    ...(args.requested_scopes !== undefined ? ['requested_scopes'] : []),
    ...(args.status !== undefined ? ['status'] : []),
  ];
  const emitUpdateConfigChange = (profile: NonNullable<typeof authProfile>) =>
    recordAuthProfileConfigChange(ctx, {
      resourceId: profile.slug,
      op: 'updated',
      summary: `Auth profile '${profile.display_name ?? profile.slug}' updated`,
      state: serializeAuthProfile(profile),
      ...(updateChangedFields.length > 0 ? { changedFields: updateChangedFields } : {}),
    });

  const authProfileProvider = authProfile.provider;

  if (
    authProfile.profile_kind === 'oauth_account' &&
    authProfileProvider &&
    !args.reconnect &&
    args.requested_scopes &&
    authProfile.connector_key
  ) {
    const profileConnectorKey = authProfile.connector_key;
    const connector = await getScopedConnectorDefinition({
      organizationId: ctx.organizationId,
      connectorKey: profileConnectorKey,
    });
    const oauthMethod = connector
      ? getOAuthMethods(connector.auth_schema).find((m) => m.provider === authProfileProvider)
      : undefined;

    if (oauthMethod) {
      const requestedScopes = resolveRequestedOAuthScopes(oauthMethod, args.requested_scopes);
      authProfile =
        (await updateAuthProfile({
          organizationId: ctx.organizationId,
          slug: authProfile.slug,
          authData: {
            ...(authProfile.auth_data ?? {}),
            requested_scopes: requestedScopes,
          },
        })) ?? authProfile;
    }
  }

  if (args.reconnect) {
    const reconnect = await issueOAuthReconnectLink({
      authProfile,
      ctx,
      requestedScopes: args.requested_scopes,
      appAuthProfileSlug: args.app_auth_profile_slug,
    });
    if ('error' in reconnect) return reconnect;

    authProfile = reconnect.authProfile;
    emitUpdateConfigChange(authProfile);

    return {
      action: 'update_auth_profile',
      auth_profile: serializeAuthProfile(authProfile),
      connect_url: reconnect.connectUrl,
      expires_at: reconnect.expiresAt,
    };
  }

  if (authProfile.profile_kind === 'browser_session') {
    const browserSessionReady = await getBrowserSessionReadiness(
      authProfile.auth_data,
      authProfile.connector_key
    );
    const nextStatus = browserSessionReady.usable ? 'active' : 'pending_auth';
    if (authProfile.status !== nextStatus) {
      authProfile =
        (await updateAuthProfile({
          organizationId: ctx.organizationId,
          slug: authProfile.slug,
          status: nextStatus,
        })) ?? authProfile;
    }
    await syncConnectionsForBrowserAuthProfile(
      ctx.organizationId,
      authProfile.id,
      browserSessionReady.usable
    );
  }

  // Cascade for oauth_app: admins flipping an app profile to revoked/error
  // need dependent connections to surface as broken (instead of silently
  // continuing to point at a profile whose creds the gateway can no longer
  // resolve). For the revoke/error case we re-do the status flip inside a
  // transaction together with the cascade + default-clear so there's no
  // window where connections still reference the revoked profile (the prior
  // updateAuthProfile call above already wrote status, but its tx is now
  // closed — this overwrite is idempotent and lands the full state change
  // atomically).
  if (authProfile.profile_kind === 'oauth_app') {
    if (authProfile.status === 'revoked' || authProfile.status === 'error') {
      const atomic = await revokeOAuthAppProfileAtomic({
        organizationId: ctx.organizationId,
        profileId: authProfile.id,
        nextStatus: authProfile.status,
      });
      if (atomic) authProfile = atomic;
    } else if (authProfile.status === 'active') {
      await syncConnectionsForOAuthAppProfile(ctx.organizationId, authProfile.id, true);
    }
  }

  emitUpdateConfigChange(authProfile);

  return { action: 'update_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
}

async function handleDeleteAuthProfile(
  args: Static<typeof DeleteAuthProfileAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const sql = getDb();
  const existing = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
  if (!existing) {
    return authProfileNotFound(args.auth_profile_slug);
  }

  const ownershipError = oauthAccountOwnershipError(existing, ctx.userId);
  if (ownershipError) return { error: ownershipError };

  // Check if active connections reference this profile
  const usageRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM connections
    WHERE organization_id = ${ctx.organizationId}
      AND (auth_profile_id = ${existing.id} OR app_auth_profile_id = ${existing.id})
      AND status != 'revoked'
      AND deleted_at IS NULL
  `;
  const usageCount = (usageRows[0] as { count: number }).count;
  if (usageCount > 0 && !args.force) {
    return {
      error: `Auth profile '${args.auth_profile_slug}' is used by ${usageCount} active connection(s). Pass force: true to delete anyway.`,
    };
  }

  // Sync + delete must happen atomically: between flipping dependent
  // connections to `pending_auth` and the DELETE, a concurrent
  // `manage_connections.create` could insert a new connection referencing
  // this profile. The FK `ON DELETE SET NULL` would then leave that
  // connection active with `app_auth_profile_id = NULL`. Lock the profile
  // row up front (`FOR UPDATE` conflicts with the FK insert's FOR KEY SHARE
  // lock, so concurrent inserts block until we commit and then fail FK).
  const deleted = await sql.begin(async (tx) => {
    const lockRows = await tx`
      SELECT id FROM auth_profiles
      WHERE organization_id = ${ctx.organizationId}
        AND id = ${existing.id}
      FOR UPDATE
    `;
    if (lockRows.length === 0) return null;

    await tx`
      UPDATE connect_tokens
      SET auth_profile_id = NULL
      WHERE auth_profile_id = ${existing.id}
    `;

    if (existing.profile_kind === 'browser_session') {
      // Pause dependent connections + their feeds (mirrors
      // syncConnectionsForBrowserAuthProfile, inlined for tx locality).
      await tx`
        UPDATE connections
        SET status = 'pending_auth', updated_at = NOW()
        WHERE organization_id = ${ctx.organizationId}
          AND auth_profile_id = ${existing.id}
      `;
      await tx`
        UPDATE feeds f
        SET status = 'paused',
            next_run_at = NULL,
            updated_at = NOW()
        FROM connections c
        WHERE f.connection_id = c.id
          AND c.organization_id = ${ctx.organizationId}
          AND c.auth_profile_id = ${existing.id}
      `;
    }

    if (existing.profile_kind === 'oauth_app') {
      await tx`
        UPDATE connections
        SET status = 'pending_auth', updated_at = NOW()
        WHERE organization_id = ${ctx.organizationId}
          AND app_auth_profile_id = ${existing.id}
          AND deleted_at IS NULL
      `;
    }

    // Explicitly null the FK columns before delete. The FK is composite
    // `(organization_id, *_auth_profile_id) ON DELETE SET NULL`; without a
    // SET NULL column list, Postgres would attempt to null organization_id
    // too (NOT NULL → constraint violation). Setting only the profile-id
    // column here avoids that and matches the intended semantic.
    await tx`
      UPDATE connections
      SET auth_profile_id = NULL, updated_at = NOW()
      WHERE organization_id = ${ctx.organizationId}
        AND auth_profile_id = ${existing.id}
    `;
    await tx`
      UPDATE connections
      SET app_auth_profile_id = NULL, updated_at = NOW()
      WHERE organization_id = ${ctx.organizationId}
        AND app_auth_profile_id = ${existing.id}
    `;

    const deletedRows = await tx`
      DELETE FROM auth_profiles
      WHERE organization_id = ${ctx.organizationId}
        AND id = ${existing.id}
      RETURNING id
    `;
    return deletedRows.length > 0 ? deletedRows[0] : null;
  });
  if (!deleted) {
    return { error: `Failed to delete auth profile '${args.auth_profile_slug}'` };
  }

  recordAuthProfileConfigChange(ctx, {
    resourceId: args.auth_profile_slug,
    op: 'deleted',
    summary: `Auth profile '${existing.display_name ?? args.auth_profile_slug}' deleted`,
    state: null,
  });

  return {
    action: 'delete_auth_profile',
    deleted: true,
    auth_profile_slug: args.auth_profile_slug,
  };
}

async function handleSetDefaultAuthProfile(
  args: Static<typeof SetDefaultAuthProfileAction>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  if (args.auth_profile_slug !== null) {
    const target = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
    if (!target) {
      return authProfileNotFound(args.auth_profile_slug);
    }
    if (target.profile_kind !== 'oauth_app') {
      return {
        error: `Auth profile '${args.auth_profile_slug}' is a ${target.profile_kind} profile; only oauth_app profiles can be pinned as connector defaults.`,
      };
    }
    if (target.connector_key !== args.connector_key) {
      return {
        error: `Auth profile '${args.auth_profile_slug}' is bound to connector '${target.connector_key}', not '${args.connector_key}'.`,
      };
    }
    if (target.status !== 'active') {
      return {
        error: `Auth profile '${args.auth_profile_slug}' is ${target.status}; only active profiles can be pinned as the default.`,
      };
    }
  }

  const pinned = await setDefaultAuthProfileForConnector({
    organizationId: ctx.organizationId,
    connectorKey: args.connector_key,
    slug: args.auth_profile_slug,
  });

  recordAuthProfileConfigChange(ctx, {
    resourceId: args.auth_profile_slug ?? args.connector_key,
    op: 'updated',
    summary: args.auth_profile_slug
      ? `Auth profile '${args.auth_profile_slug}' pinned as default for connector '${args.connector_key}'`
      : `Default auth profile cleared for connector '${args.connector_key}'`,
    state: pinned
      ? serializeAuthProfile(pinned)
      : { connector_key: args.connector_key, default_cleared: true },
    changedFields: ['is_default_for_connector'],
  });

  return {
    action: 'set_default_auth_profile',
    connector_key: args.connector_key,
    auth_profile: pinned ? serializeAuthProfile(pinned) : null,
  };
}
