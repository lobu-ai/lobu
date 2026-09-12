/**
 * Auth-related action handlers: reauthenticate, test.
 */

import { getErrorMessage, isRetryable, type ToolErrorCode } from '@lobu/core';
import { probeSlackConnectionIdentity } from '../../../../gateway/connections/chat-connection-service';
import { getDb } from '../../../../db/client';
import {
  DEVICE_ONLINE_WINDOW_SECONDS,
  describeDeviceLastSeen,
} from '../../../../utils/device-liveness';
import {
  getAuthProfileById,
  normalizeAuthValues,
  summarizeBrowserSessionAuthData,
} from '../../../../utils/auth-profiles';
import { createAuthRun } from '../../../../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../../../../utils/run-statuses';
import type { ToolContext } from '../../../registry';
import type { ManageConnectionsResult, ConnectionsArgs } from '../schemas';
import { callerIsAdmin as resolveCallerIsAdmin } from '../../helpers/db-helpers';
import { issueOAuthReconnectLink } from '../../helpers/connection-helpers';

// ============================================
// handleReauthenticate
// ============================================

export async function handleReauthenticate(
  args: Extract<ConnectionsArgs, { action: 'reauthenticate' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  if (!ctx.userId) {
    return { error: 'Authentication required to re-authenticate a connection' };
  }

  const rows = await sql`
    SELECT
      c.id,
      c.status AS connection_status,
      c.connector_key,
      c.auth_profile_id,
      c.created_by AS connection_created_by,
      ap.profile_kind,
      ap.status AS auth_profile_status
    FROM connections c
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
    LIMIT 1
  `;

  if (rows.length === 0) {
    return { error: 'Connection not found' };
  }

  const row = rows[0] as {
    id: number;
    connection_status: string;
    connector_key: string;
    auth_profile_id: number | null;
    connection_created_by: string | null;
    profile_kind: string | null;
    auth_profile_status: string | null;
  };

  // Starting either auth family must be limited to the connection owner or an
  // admin/owner. Otherwise any org member could disrupt or hijack another
  // member's personal credential flow.
  const callerIsAdmin = await resolveCallerIsAdmin(sql, { organizationId, userId: ctx.userId });
  if (!callerIsAdmin && row.connection_created_by !== ctx.userId) {
    return { error: 'You can only re-authenticate connections you created.' };
  }

  if (!row.auth_profile_id) {
    return { error: 'Connection does not have an auth profile' };
  }

  if (row.profile_kind === 'oauth_account') {
    const authProfile = await getAuthProfileById(organizationId, row.auth_profile_id);
    if (!authProfile) return { error: 'Connection auth profile not found' };
    const reconnect = await issueOAuthReconnectLink({ authProfile, ctx, connectionId: row.id, requestedScopes: args.requested_scopes });
    if ('error' in reconnect) return reconnect;
    return {
      action: 'reauthenticate',
      connection_id: row.id,
      auth_profile_slug: reconnect.authProfile.slug,
      connect_url: reconnect.connectUrl,
      expires_at: reconnect.expiresAt,
    };
  }

  if (row.profile_kind !== 'interactive') {
    return {
      error: `Connection auth profile kind '${row.profile_kind ?? 'unknown'}' cannot be reauthenticated`,
    };
  }

  const activeRuns = await sql`
    SELECT id, created_by_user_id
    FROM runs
    WHERE auth_profile_id = ${row.auth_profile_id}
      AND run_type = 'auth'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (activeRuns.length > 0) {
    const existing = activeRuns[0] as { id: unknown; created_by_user_id: string | null };
    if (existing.created_by_user_id && existing.created_by_user_id !== ctx.userId) {
      return {
        error: 'An authentication flow is already in progress for this profile by another user.',
      };
    }
    return {
      action: 'reauthenticate',
      connection_id: row.id,
      auth_run_id: Number(existing.id),
    };
  }

  if (row.auth_profile_status !== 'pending_auth') {
    await sql`
      UPDATE auth_profiles
      SET status = 'pending_auth', updated_at = NOW()
      WHERE id = ${row.auth_profile_id}
    `;
  }

  if (row.connection_status !== 'pending_auth') {
    await sql`
      UPDATE connections
      SET status = 'pending_auth', updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }

  const authRunId = await createAuthRun({
    organizationId,
    connectorKey: row.connector_key,
    authProfileId: row.auth_profile_id,
    createdByUserId: ctx.userId,
  });

  return {
    action: 'reauthenticate',
    connection_id: row.id,
    auth_run_id: authRunId,
  };
}

// ============================================
// handleTest
// ============================================

export async function handleTest(
  args: Extract<ConnectionsArgs, { action: 'test' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const rows = await sql`
    SELECT c.connector_key,
           c.slug,
           c.credential_mode,
           c.external_tenant_id,
           c.config,
           c.auth_profile_id,
           c.app_auth_profile_id,
           c.status,
           c.device_worker_id,
           dw.label AS device_label,
           dw.last_seen_at AS device_last_seen_at,
           COALESCE(dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}), false) AS device_online,
           cd.auth_schema
    FROM connections c
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    LEFT JOIN LATERAL (
      SELECT auth_schema
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE c.id = ${args.connection_id} AND c.organization_id = ${organizationId}
  `;

  if (rows.length === 0) {
    return { error: 'Connection not found' };
  }

  const conn = rows[0] as any;
  const withDeviceHealth = (result: ConnectionTestResult): ConnectionTestResult =>
    applySelectedDeviceHealth(conn, result);

  if (conn.connector_key === 'slack' && conn.credential_mode) {
    try {
      const identity = await probeSlackConnectionIdentity(
        organizationId,
        Number(args.connection_id)
      );
      const mismatch = slackIdentityMismatch(conn, identity);
      if (mismatch) {
        return withDeviceHealth({
          action: 'test',
          status: 'error',
          message: `Slack auth.test identity mismatch: ${mismatch}`,
          ...testErrorFields('AUTH_INVALID'),
        });
      }
      // `slackIdentityMismatch` has already proven the shape: an `E…` team id
      // here is an org-wide install whose enterprise id is present and equal.
      const scope = SLACK_ENTERPRISE_ID.test(identity.teamId)
        ? `org-wide enterprise ${identity.teamId}, no separate concrete workspace`
        : `workspace ${identity.teamId}, ${identity.enterpriseId ? `enterprise ${identity.enterpriseId}` : 'no enterprise'}`;
      return withDeviceHealth({
        action: 'test',
        status: 'ok',
        message: `Slack auth.test succeeded: ${scope}, enterprise_install=${identity.isEnterpriseInstall}`,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const authFailure = /invalid_auth|token_(?:expired|revoked)|account_inactive/i.test(
        message
      );
      return withDeviceHealth({
        action: 'test',
        status: 'error',
        message: `Slack auth.test failed: ${message}`,
        ...testErrorFields(authFailure ? 'AUTH_INVALID' : 'NETWORK'),
      });
    }
  }

  const authProfile = await getAuthProfileById(
    organizationId,
    Number(conn.auth_profile_id) || null
  );
  const appAuthProfile = await getAuthProfileById(
    organizationId,
    Number(conn.app_auth_profile_id) || null
  );

  if (authProfile?.profile_kind === 'oauth_account' && authProfile.account_id) {
    const accountRows = await sql`
      SELECT "accessToken" IS NOT NULL AS has_token,
             "accessTokenExpiresAt",
             "refreshToken" IS NOT NULL AS has_refresh
      FROM "account"
      WHERE id = ${authProfile.account_id}
    `;

    if (accountRows.length === 0) {
      return withDeviceHealth({
        action: 'test',
        status: 'error',
        message: 'Linked OAuth account not found',
        ...testErrorFields('NOT_FOUND'),
      });
    }

    const account = accountRows[0] as any;
    if (!account.has_token) {
      return withDeviceHealth({
        action: 'test',
        status: 'error',
        message: 'No access token available. Re-authenticate.',
        ...testErrorFields('AUTH_MISSING'),
      });
    }

    const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt) : null;
    const isExpired = expiresAt && expiresAt.getTime() < Date.now();
    const hardExpired = isExpired && !account.has_refresh;

    return withDeviceHealth({
      action: 'test',
      status: hardExpired ? 'error' : 'ok',
      message: isExpired
        ? account.has_refresh
          ? 'Token expired but refresh token available'
          : 'Token expired and no refresh token'
        : 'Credentials valid',
      has_token: account.has_token,
      has_refresh: account.has_refresh,
      expires_at: expiresAt?.toISOString() ?? null,
      ...(hardExpired ? testErrorFields('AUTH_INVALID') : {}),
    });
  }

  const profileToTest =
    authProfile?.profile_kind === 'env'
      ? authProfile
      : appAuthProfile?.profile_kind === 'oauth_app'
        ? appAuthProfile
        : null;

  if (profileToTest) {
    const creds = normalizeAuthValues(profileToTest.auth_data);
    const label = profileToTest.profile_kind === 'oauth_app' ? 'App auth' : 'Auth';
    const hasKeys = Object.keys(creds).length > 0;
    return withDeviceHealth({
      action: 'test',
      status: hasKeys ? 'ok' : 'warning',
      message: hasKeys
        ? `${label} profile '${profileToTest.slug}' configured`
        : `${label} profile '${profileToTest.slug}' has no credentials`,
      ...(hasKeys ? {} : testErrorFields('AUTH_MISSING')),
    });
  }

  if (authProfile?.profile_kind === 'browser_session') {
    const summary = summarizeBrowserSessionAuthData(authProfile.auth_data, conn.connector_key);
    if (summary.cookie_count === 0) {
      return withDeviceHealth({
        action: 'test',
        status: 'warning',
        message: `Browser auth profile '${authProfile.slug}' has no cookies`,
        expires_at: summary.expires_at,
        ...testErrorFields('AUTH_MISSING'),
      });
    }
    if (!summary.auth_cookie_name) {
      return withDeviceHealth({
        action: 'test',
        status: 'warning',
        message: `Browser auth profile '${authProfile.slug}' has no likely auth cookie`,
        expires_at: summary.expires_at,
        ...testErrorFields('AUTH_MISSING'),
      });
    }
    return withDeviceHealth({
      action: 'test',
      status: summary.is_expired ? 'error' : 'ok',
      message: summary.is_expired
        ? `${summary.auth_cookie_name} expired`
        : `${summary.auth_cookie_name} valid`,
      expires_at: summary.expires_at,
      ...(summary.is_expired ? testErrorFields('AUTH_INVALID') : {}),
    });
  }

  // Auth-free device connections such as apple.computer_use run on a paired
  // device, not an auth profile — so a null profile is expected. Report whether
  // the paired device is online instead of the misleading "No auth profile
  // configured" warning. The DEVICE_ONLINE_WINDOW_SECONDS freshness window
  // mirrors the readiness rule used across operations/feeds listings.
  //
  // This must precede the no-auth check: device connectors like apple.computer_use
  // declare `auth_schema.methods: [{ type: 'none' }]`, so testing no-auth first would
  // mask an offline device behind a generic "requires no auth profile" ok.
  if (conn.device_worker_id) {
    const deviceName = conn.device_label || 'paired device';
    return conn.device_online
      ? {
          action: 'test',
          status: 'ok',
          message: `Device '${deviceName}' is online`,
          device_online: true,
        }
      : {
          action: 'test',
          status: 'warning',
          // Offline is transient — the device may reconnect — so this is
          // retryable because the paired browser can reconnect.
          message: `Device '${deviceName}' is offline (${describeDeviceLastSeen(
            conn.device_last_seen_at
          )}) — bring it online to execute`,
          device_online: false,
          ...testErrorFields('NETWORK'),
        };
  }

  // Auth-free connectors (e.g. RSS/Atom) declare `authSchema.methods: [{ type: 'none' }]`
  // and legitimately have no auth profile. Reporting "No auth profile configured" for
  // them is a false warning on a perfectly valid connection (#2051). If the connector
  // supports the `none` auth method, an absent profile is expected — report ok.
  if (connectorSupportsNoAuth(conn.auth_schema)) {
    return {
      action: 'test',
      status: 'ok',
      message: 'Connector requires no auth profile',
    };
  }

  return {
    action: 'test',
    status: 'warning',
    message: 'No auth profile configured',
    ...testErrorFields('AUTH_MISSING'),
  };
}

type ConnectionTestResult = Extract<ManageConnectionsResult, { action: 'test' }>;

/**
 * A credential-backed connection may still require its selected device to
 * execute (for example X OAuth plus browser-backed feeds). Credential validity
 * and execution availability are conjunctive: a successful auth probe cannot
 * turn an offline required device into an overall `ok` result.
 */
function applySelectedDeviceHealth(
  conn: {
    device_worker_id?: unknown;
    device_online?: unknown;
    device_label?: unknown;
    device_last_seen_at?: Date | string | null;
  },
  result: ConnectionTestResult
): ConnectionTestResult {
  if (!conn.device_worker_id) return result;
  if (conn.device_online === true) {
    return { ...result, device_online: true };
  }

  const deviceName =
    typeof conn.device_label === 'string' && conn.device_label.trim()
      ? conn.device_label
      : 'paired device';
  const deviceMessage = `Device '${deviceName}' is offline (${describeDeviceLastSeen(
    conn.device_last_seen_at
  )}) — bring it online to execute`;

  // An auth finding the probe already made is the more actionable one and must
  // survive: overwriting e.g. a non-retryable AUTH_MISSING with NETWORK would
  // tell the caller to retry a connection only a human re-auth can fix. Only an
  // otherwise-clean result takes the device's retryable NETWORK classification.
  const deviceErrorFields = result.error_code
    ? {}
    : testErrorFields('NETWORK');

  return {
    ...result,
    status: result.status === 'error' ? 'error' : 'warning',
    message: `${result.message}; ${deviceMessage}`,
    device_online: false,
    ...deviceErrorFields,
  };
}

/**
 * Structured error fields for a connection-test error/warning result (lobu#2051
 * Item 2). `retryable` comes from the catalog so it can't drift from the code.
 */
function testErrorFields(code: ToolErrorCode): { error_code: ToolErrorCode; retryable: boolean } {
  return { error_code: code, retryable: isRetryable(code) };
}

/**
 * True when the connector's auth schema offers the `none` method — i.e. it can
 * run without an auth profile. `authSchema` is stored as JSON on
 * `connector_definitions.auth_schema`; it may be null/undefined for legacy rows.
 */
function connectorSupportsNoAuth(authSchema: unknown): boolean {
  const methods = (authSchema as { methods?: Array<{ type?: string }> } | null)?.methods;
  return Array.isArray(methods) && methods.some((m) => m?.type === 'none');
}

/** Slack workspace ids are `T…`; enterprise ids are `E…`. Never interchangeable. */
const SLACK_WORKSPACE_ID = /^T[A-Z0-9]+$/i;
const SLACK_ENTERPRISE_ID = /^E[A-Z0-9]+$/i;

function slackIdentityMismatch(
  conn: {
    external_tenant_id?: unknown;
    config?: unknown;
  },
  upstream: {
    teamId: string;
    enterpriseId: string | null;
    isEnterpriseInstall: boolean;
  }
): string | null {
  const config =
    conn.config && typeof conn.config === 'object'
      ? (conn.config as Record<string, unknown>)
      : {};
  const metadata =
    config.chatMetadata && typeof config.chatMetadata === 'object'
      ? (config.chatMetadata as Record<string, unknown>)
      : {};
  const storedTenantId =
    typeof conn.external_tenant_id === 'string' ? conn.external_tenant_id : null;
  // An ORG-WIDE Grid install is keyed on its `E…` enterprise id, so both
  // `external_tenant_id` and `chatMetadata.teamId` hold an `E…` there. Only a
  // `T…` value names a concrete workspace worth comparing against `auth.test`.
  const storedTeamId = [metadata.teamId, storedTenantId].find(
    (value): value is string =>
      typeof value === 'string' && SLACK_WORKSPACE_ID.test(value)
  );
  const storedEnterpriseId =
    typeof metadata.enterpriseId === 'string' &&
    SLACK_ENTERPRISE_ID.test(metadata.enterpriseId)
      ? metadata.enterpriseId
      : storedTenantId && SLACK_ENTERPRISE_ID.test(storedTenantId)
        ? storedTenantId
        : null;
  const storedEnterpriseInstall = metadata.isEnterpriseInstall === true;

  // An ORG-WIDE Grid install has no concrete workspace, so `auth.test` reports
  // the `E…` enterprise id in `team_id` — the same identity key the OAuth
  // install path persists (`slack-web.ts` falls back to `enterprise.id` when
  // `oauth.v2.access` returns no `team`). Validate that shape on its own terms
  // instead of failing it as a malformed `T…`.
  if (SLACK_ENTERPRISE_ID.test(upstream.teamId)) {
    if (!upstream.isEnterpriseInstall) {
      return `upstream reports workspace-scoped install but named enterprise '${upstream.teamId}' as its workspace`;
    }
    if (!storedEnterpriseInstall) {
      return 'upstream credential is org-wide but stored connection is workspace-scoped';
    }
    if (!upstream.enterpriseId || !SLACK_ENTERPRISE_ID.test(upstream.enterpriseId)) {
      return `upstream enterprise '${upstream.enterpriseId ?? 'none'}' is not a Slack E id`;
    }
    if (upstream.teamId !== upstream.enterpriseId) {
      return `upstream org-wide identity '${upstream.teamId}' does not match upstream enterprise '${upstream.enterpriseId}'`;
    }
    if (upstream.enterpriseId !== storedEnterpriseId) {
      return `upstream enterprise '${upstream.enterpriseId}' does not match stored enterprise '${storedEnterpriseId ?? 'none'}'`;
    }
    return null;
  }

  if (!SLACK_WORKSPACE_ID.test(upstream.teamId)) {
    return `upstream workspace id '${upstream.teamId}' is not a Slack T id`;
  }
  if (upstream.isEnterpriseInstall) {
    if (!storedEnterpriseInstall) {
      return 'upstream credential is org-wide but stored connection is workspace-scoped';
    }
    if (!upstream.enterpriseId || !SLACK_ENTERPRISE_ID.test(upstream.enterpriseId)) {
      return `upstream enterprise '${upstream.enterpriseId ?? 'none'}' is not a Slack E id`;
    }
    if (upstream.enterpriseId !== storedEnterpriseId) {
      return `upstream enterprise '${upstream.enterpriseId ?? 'none'}' does not match stored enterprise '${storedEnterpriseId ?? 'none'}'`;
    }
    return null;
  }
  if (storedEnterpriseInstall) {
    return 'stored connection is org-wide but upstream credential is workspace-scoped';
  }
  if (!storedTeamId || upstream.teamId !== storedTeamId) {
    return `upstream workspace '${upstream.teamId}' does not match stored workspace '${storedTeamId ?? 'none'}'`;
  }
  if (storedEnterpriseId && upstream.enterpriseId !== storedEnterpriseId) {
    return `upstream enterprise '${upstream.enterpriseId ?? 'none'}' does not match stored enterprise '${storedEnterpriseId}'`;
  }
  return null;
}
