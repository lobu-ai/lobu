/**
 * Connect action handler: create connection + OAuth flow in one call.
 */

import { getDb, pgBigintArray, type DbClient } from "../../../../db/client";
import { normalizeScopeList } from "../../../../auth/oauth/scopes";
import { notifyConnectionPermissionRequest } from "../../../../notifications/triggers";
import {
	getPrimaryAuthProfileForKind,
	getBrowserSessionReadiness,
} from "../../../../utils/auth-profiles";
import {
  ConnectionSlugConflictError,
  connectionSlugFormatError,
  insertConnectionWithSlug,
  resolveNewConnectionSlug,
} from "../../../../utils/connections";
import { recordLifecycleEvent } from "../../../../utils/insert-event";
import { recordToolConfigChange } from "../../helpers/config-audit";
import logger from "../../../../utils/logger";
import { ensureConnectorInstalled } from "../../../../utils/ensure-connector-installed";
import {
  buildOAuthConnectConfig,
  getOAuthMethods,
  resolveRequestedOAuthScopes,
  resolveOAuthProfileApp,
  ensureEnvBackedOAuthAppProfile,
  getConnectBaseUrl,
	getGatewayBaseUrl,
	getInteractiveMethods,
  personalConnectionScopeWarning,
  resolveConnectionAuthSelection,
  resolveConnectionDisplayName,
  resolveConnectionVisibility,
} from "../../helpers/connection-helpers";
import {
  denyNonHumanActionModesWrite,
  hasActionModes,
} from "./action-modes-guard";
import { assertEntityIdsInOrg } from "../../helpers/db-helpers";
import {
  buildAppInstallationSetupUrl,
  rejectUnboundAppInstallationCreate,
} from "../../helpers/app-installation-guard";
import { buildOAuthAppProfileSetupError } from "../../helpers/connector-setup-errors";
import {
	type FeedDefinition,
	splitConfigByFeedScope,
} from "../../helpers/feed-helpers";
import { getScopedConnectorDefinition } from "../../../../catalog/connector-definitions";
import { buildConnectionsUrl } from "../../../../utils/url-builder";
import { getOrgUrlContext } from "../../../view-urls";
import {
  CONNECT_TOKEN_EXPIRED_ERROR,
  createConnectToken,
} from "../../../../utils/connect-tokens";
import { registerConnectorWebhook } from "../../../../connect/webhook-registration";
import { resolveUsernames } from "../../../../utils/resolve-usernames";
import type { ToolContext } from "../../../registry";
import type { ManageConnectionsResult, ConnectionsArgs } from "../schemas";
import {
	resolveDeviceBinding,
	isManagedPublicOrgConnect,
} from "./device-binding";
import { getErrorMessage } from "@lobu/core";
import { callerIsAdmin } from "../../helpers/db-helpers";
import {
	activeConnectionPoll,
	appInstallationSetupContinuation,
	buildConnectionSetupContinuation,
	buildSafeConnectionResumeCall,
	oauthAppSetupContinuation,
	type ConnectionSetupFamily,
	type ConnectionSetupNextAction,
} from "../../helpers/connect-setup-continuation";
import { createConnectionSetupBundle } from "../../helpers/interactive-connection-setup";
import { buildCrossWorkspaceAppInstallResult } from "../../helpers/cross-workspace-app-install";
import {
	DEVICE_AUTOWIRE_SUPPRESSION_ERROR,
	hasDeviceAutowireSuppressionMarker,
} from "../../../../utils/device-autowire-suppression";

export async function handleConnect(
	args: Extract<ConnectionsArgs, { action: "connect" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	return handleConnectImpl(args, ctx, false);
}

export async function handleRequiredManagedConnect(
	args: Extract<ConnectionsArgs, { action: "connect" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	return handleConnectImpl(args, ctx, true);
}

async function handleConnectImpl(
	args: Extract<ConnectionsArgs, { action: "connect" }>,
	ctx: ToolContext,
	requireManaged: boolean,
): Promise<ManageConnectionsResult> {
  if (hasDeviceAutowireSuppressionMarker(args.config)) {
    return { error: DEVICE_AUTOWIRE_SUPPRESSION_ERROR };
  }
  // A new row has no stored modes to compare against.
  if (hasActionModes(args.config)) {
    const denied = denyNonHumanActionModesWrite(ctx);
    if (denied) return denied;
  }
  const sql = getDb();
  const { organizationId, userId } = ctx;
  const isAdmin = await callerIsAdmin(sql, ctx);
	const resumeCall = buildSafeConnectionResumeCall(
		"connections.connect",
		args,
	);

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  const buildSetupUrl = (opts?: { connectorKey?: string; install?: string }) =>
    ownerSlug && baseUrl
      ? buildConnectionsUrl(
          ownerSlug,
          baseUrl,
          opts?.connectorKey,
					opts?.install ? { install: opts.install } : undefined,
        )
      : undefined;

  // Ensure connector is installed from bundled catalog if needed
	await ensureConnectorInstalled({
		organizationId,
		connectorKey: args.connector_key,
	});

  // Verify connector exists
  const connector = await getScopedConnectorDefinition({
    organizationId,
    connectorKey: args.connector_key,
  });

  if (!connector) {
    return {
      error: `Connector '${args.connector_key}' not found. Install it first from the connections page.`,
      setup_url: buildSetupUrl({ install: args.connector_key }),
    };
  }

  const setupUrl = buildSetupUrl({ connectorKey: args.connector_key });

  // Reject a direct connect of an UNBOUND app_installation connection (no
  // installation_ref AND no other auth intent) — those are created only by the
  // App install callback. Selection-aware: a connect that supplies an auth
  // profile / app profile / env creds / managedBy resolves to a different method
  // and is allowed through.
  // connect_managed is already an explicit, live-validated OAuth selection.
  // A connector may prefer app_installation for ordinary bare connects while
  // still exposing OAuth as its first account-auth method; do not redirect the
  // managed route into the app-install flow.
  const appInstallGuard = requireManaged
    ? null
    : await rejectUnboundAppInstallationCreate({
        organizationId,
        authSchema: connector.auth_schema,
        config: args.config,
        connectorKey: args.connector_key,
        authProfileSlug: args.auth_profile_slug,
        appAuthProfileSlug: args.app_auth_profile_slug,
        gatewayBaseUrl: getGatewayBaseUrl(ctx),
        setupUrl,
      });
  if (appInstallGuard) {
		// Setup-required continuation: the App install callback creates the active
		// connection itself, so do NOT instruct a retry of connect. The guard's
		// ConnectorSetupError already carries the absolute install_url.
		const setupContinuation = appInstallationSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setup: appInstallGuard,
			setupUrl: await buildAppInstallationSetupUrl(ctx, args.connector_key),
		});
		return buildCrossWorkspaceAppInstallResult({
			connectorKey: args.connector_key,
			ctx,
			setup: appInstallGuard,
			setupContinuation,
			ownerSlug,
			baseUrl,
		});
  }

  const deviceBinding = await resolveDeviceBinding({
    organizationId,
    userId,
    connector,
    deviceWorkerId: args.device_worker_id,
  });
	if ("error" in deviceBinding) {
		if (connector.required_capability && !args.device_worker_id) {
			return buildConnectionSetupContinuation({
				action: "connect",
				connectorKey: args.connector_key,
				setupFamily: "device_bound",
				nextAction: "connect_device",
				instructions: deviceBinding.error,
				setupUrl,
			});
		}
		return deviceBinding;
	}
  if (deviceBinding.deviceWorkerId) {
    const dup = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND device_worker_id = ${deviceBinding.deviceWorkerId}
        AND deleted_at IS NULL
      LIMIT 1
    `) as unknown as Array<{ id: number }>;
    if (dup.length > 0) {
      return {
        error: `A ${connector.name} connection (id: ${dup[0].id}) is already assigned to that device in this org.`,
      };
    }
  }

  // Validate an explicit slug up-front (same boundary check create does).
  const explicitSlug = args.slug?.trim();
  if (explicitSlug) {
    const fmtErr = connectionSlugFormatError(explicitSlug);
    if (fmtErr) return { error: fmtErr };
  }

  // Idempotent: reuse the existing OAuth connection for the same connector/user
  // instead of stacking duplicates. A connect token that lapsed before the user
  // consented is reissued below, so a row parked at pending_auth — or revoked by
  // the token reaper — recovers on the same connection. When the caller asked
  // for a specific slug, only reuse a row whose slug matches — otherwise we'd
  // hand back a connection under the wrong stable identity, so fall through and
  // create a fresh row with the requested slug instead.
  const pendingRows = await sql`
    SELECT c.id, ct.id AS connect_token_id
    FROM connections c
    JOIN connect_tokens ct ON ct.connection_id = c.id
      AND ct.auth_type = 'oauth' AND ct.status IN ('pending', 'expired')
    WHERE c.organization_id = ${organizationId}
      AND c.connector_key = ${args.connector_key}
      AND (c.status = 'pending_auth' OR (c.status = 'revoked' AND c.auth_profile_id IS NULL
        AND c.error_message = ${CONNECT_TOKEN_EXPIRED_ERROR}))
      AND c.deleted_at IS NULL
			${requireManaged ? sql`AND c.config->>'consent_only' = 'true'` : sql``}
      ${explicitSlug ? sql`AND c.slug = ${explicitSlug}` : sql``}
      ${deviceBinding.deviceWorkerId ? sql`AND c.device_worker_id = ${deviceBinding.deviceWorkerId}` : sql``}
      ${userId ? sql`AND c.created_by = ${userId}` : sql``}
    ORDER BY ct.created_at DESC, ct.id DESC
    LIMIT 1
  `;
  if (pendingRows.length > 0) {
    const candidate = pendingRows[0] as { id: number; connect_token_id: number };
    const recovered = await sql.begin(async (tx) => {
      // Match callback lock order: token, selected account profile, connection.
      // Discovery is only a hint; authorization and renewal use these live rows.
      const [token] = await tx`SELECT * FROM connect_tokens
        WHERE id = ${candidate.connect_token_id} AND organization_id = ${organizationId} FOR UPDATE`;
      if (!token) return { error: 'Connection setup changed. Retry connecting this account.' };
      const [targetHint] = await tx`SELECT auth_profile_id FROM connections
        WHERE id = ${candidate.id} AND organization_id = ${organizationId} AND deleted_at IS NULL`;
      if (!targetHint) return { error: 'Connection not found' };
      const [profile] = targetHint.auth_profile_id ? await tx`
        SELECT ap.*, a.scope AS account_scope FROM auth_profiles ap
        LEFT JOIN account a ON a.id = ap.account_id
        WHERE ap.id = ${targetHint.auth_profile_id} AND ap.organization_id = ${organizationId}
        FOR UPDATE OF ap` : [];
      const [target] = await tx`SELECT * FROM connections
        WHERE id = ${candidate.id} AND organization_id = ${organizationId} AND deleted_at IS NULL FOR UPDATE`;
      if (!target || target.auth_profile_id !== targetHint.auth_profile_id) {
        return { error: 'Connection setup changed. Retry connecting this account.' };
      }
      if (!isAdmin && target.created_by !== userId) return { error: 'You can only re-authenticate connections you created.' };
      if (target.auth_profile_id && profile?.profile_kind !== 'oauth_account') return { error: 'The selected OAuth account profile is no longer available.' };
      if (!isAdmin && profile && profile.created_by !== userId) return { error: 'You can only re-authenticate OAuth profiles you created.' };
      if (target.status === 'active') return { active: true as const, target };
      if (token.status === 'expired') {
        // Another retry may have replaced the token while this one waited for its
        // lock. Rediscover that replacement instead of issuing a second live link.
        const [latest] = await tx`SELECT id FROM connect_tokens
          WHERE connection_id = ${target.id} AND organization_id = ${organizationId}
            AND auth_type = 'oauth' AND status IN ('pending', 'expired')
          ORDER BY created_at DESC, id DESC LIMIT 1`;
        if (latest?.id !== token.id) return { error: 'Connection setup changed. Retry connecting this account.' };
      }
      if (target.status !== 'pending_auth' && !(target.status === 'revoked' && !target.auth_profile_id &&
          !target.account_id && target.error_message === CONNECT_TOKEN_EXPIRED_ERROR)) {
        return { error: 'This connection is no longer awaiting OAuth setup. Review the connection before reconnecting.' };
      }
      const oldConfig = (token.auth_config ?? {}) as Record<string, unknown>;
      const appId = target.app_auth_profile_id ?? profile?.auth_data?.app_auth_profile_id ?? oldConfig.appAuthProfileId ?? null;
      const [app] = appId ? await tx`SELECT slug, provider FROM auth_profiles
        WHERE id = ${appId} AND organization_id = ${organizationId} AND profile_kind = 'oauth_app'` : [];
      if (args.app_auth_profile_slug && args.app_auth_profile_slug !== app?.slug) {
        return { error: 'A pending account connection uses a different OAuth app. Select that app on the connection before retrying.' };
      }
      const provider = String(profile?.provider ?? app?.provider ?? oldConfig.provider ?? '').toLowerCase();
      const method = getOAuthMethods(connector.auth_schema).find(method => method.provider.toLowerCase() === provider);
      if (!method) return { error: 'The OAuth provider is no longer available. Review this connector’s app configuration.' };
      // Previously requested/granted scopes are trusted. Only new requests are
      // filtered by today's manifest, which may no longer list an existing grant.
      const scopes = [...new Set([
        ...(String(oldConfig.provider ?? '').toLowerCase() === provider
          ? normalizeScopeList(oldConfig.requestedScopes ?? oldConfig.scopes) : []),
        ...normalizeScopeList(profile?.account_scope ?? profile?.auth_data?.granted_scopes),
        ...resolveRequestedOAuthScopes(method, args.requested_scopes),
      ])];
      const bindingsChanged = token.auth_profile_id !== target.auth_profile_id ||
        (appId !== null && oldConfig.appAuthProfileId !== appId);
      const needsRenewal = bindingsChanged || token.status !== 'pending' || new Date(token.expires_at).getTime() <= Date.now();
      if (needsRenewal) {
        // Provider endpoints and initialization belong to the current method.
        // Carry forward only deferred account metadata and the requested scopes.
        const pendingMeta = oldConfig.pendingProfileMeta as { displayName: string; slug: string } | undefined;
        const authConfig = { ...buildOAuthConnectConfig(method),
          ...(pendingMeta ? { pendingProfileMeta: { displayName: pendingMeta.displayName, slug: pendingMeta.slug,
            connectorKey: target.connector_key, provider: method.provider } } : {}),
          appAuthProfileId: appId,
          scopes, requestedScopes: scopes };
        // Invalidate the old bearer link and issue its replacement atomically.
        await tx`UPDATE connect_tokens SET status = 'expired' WHERE id = ${token.id}`;
        const fresh = await createConnectToken({ connectionId: target.id, authProfileId: target.auth_profile_id,
          organizationId, connectorKey: args.connector_key, authType: 'oauth', authConfig, createdBy: userId }, tx);
        await tx`UPDATE connections SET status = 'pending_auth', error_message = NULL, updated_at = NOW()
          WHERE id = ${target.id} AND organization_id = ${organizationId}`;
        return { token: fresh.token, expires_at: fresh.expires_at, target };
      }
      if (args.requested_scopes) {
        await tx`UPDATE connect_tokens
          SET auth_config = COALESCE(auth_config, '{}'::jsonb) || ${tx.json({ scopes, requestedScopes: scopes })}::jsonb
          WHERE id = ${token.id}`;
      }
      return { token: token.token as string, expires_at: token.expires_at as Date, target };
    });
    if (recovered.error) return { error: recovered.error, setup_url: setupUrl };
    if ('active' in recovered) return { action: 'connect', connection_id: recovered.target.id,
      slug: recovered.target.slug, status: 'active',
      message: 'This connection is already active. Check client.operations.listAvailable({ connection_id }) for the requested capabilities before resuming the original task.' };
    const pending = { ...recovered.target, token: recovered.token, expires_at: recovered.expires_at };
    const connectUrl = `${getConnectBaseUrl(ctx)}/connect/${pending.token}/oauth/start`;
    // Existing profiles were checked as oauth_account above; unlinked pending
    // rows receive that kind on consent. Preserve the personal-scope warning.
    const pendingScopeWarning = personalConnectionScopeWarning({
      visibility: pending.visibility,
      profileKind: "oauth_account",
    });
    return {
			action: "connect",
      connection_id: pending.id,
      slug: pending.slug,
			status: "pending_auth",
			auth_type: "oauth",
      connect_url: connectUrl,
      connect_token: pending.token,
      expires_at: new Date(pending.expires_at).toISOString(),
      instructions:
        "A pending connection already exists. Send the connect_url to the user to complete OAuth authorization." +
        (pendingScopeWarning ? ` ${pendingScopeWarning}` : "") +
        " Poll with client.connections.get(connection_id) via query_sdk until status='active', then check client.operations.listAvailable({ connection_id }) for the requested capabilities before resuming the original task. Reuse this connection; do not create duplicate connections or feeds.",
    };
  }

  const authSelection = await resolveConnectionAuthSelection({
    organizationId,
    connectorKey: args.connector_key,
    authSchema: connector.auth_schema,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
    deviceWorkerId: deviceBinding.deviceWorkerId,
    oauthAccountCreatedBy: userId,
  });

	const isOAuthConnect =
		authSelection.preferredMethodType === "oauth" &&
		(authSelection.selectedKind === "none" ||
			authSelection.selectedKind === "oauth_account");
  const acceptsManagedApp = isOAuthConnect && authSelection.oauthMethod
    ? await isManagedPublicOrgConnect({ organizationId, connectorKey: args.connector_key, provider: authSelection.oauthMethod.provider })
    : false;
  if (isOAuthConnect && authSelection.oauthMethod) {
    const app = await resolveOAuthProfileApp({ ctx, connectorKey: args.connector_key,
      method: authSelection.oauthMethod, appAuthProfileSlug: args.app_auth_profile_slug,
      authProfile: authSelection.authProfile ?? undefined, allowManagedApp: acceptsManagedApp });
    if ('error' in app) {
      const setup = buildOAuthAppProfileSetupError({ connectorKey: args.connector_key, method: authSelection.oauthMethod, setupUrl });
      return oauthAppSetupContinuation({ action: 'connect', connectorKey: args.connector_key, resumeCall,
        setup: { ...setup, error: app.error + ' Open setup_url to review the app configuration.' } });
    }
    authSelection.appAuthProfile = app.appAuthProfile;
  }

	// Resolve/provision the app before deriving managed-connector policy. On the
	// first env-backed connect there is no oauth_app row yet; doing this only
	// after INSERT meant that first grant missed consent_only even though every
	// later grant was managed. Persist the app first so the same durable signal
	// drives both the policy decision and OAuth token creation.
	if (isOAuthConnect && authSelection.oauthMethod && !authSelection.appAuthProfile) {
		authSelection.appAuthProfile =
			(await getPrimaryAuthProfileForKind({
				organizationId,
				connectorKey: args.connector_key,
				profileKind: "oauth_app",
				provider: authSelection.oauthMethod.provider,
			})) ??
			(isAdmin ? await ensureEnvBackedOAuthAppProfile({
				organizationId,
				connectorKey: args.connector_key,
				connectorName: connector.name,
				method: authSelection.oauthMethod,
				createdBy: userId,
			}) : null);
	}

  if (!isAdmin) {
    if (!isOAuthConnect || (authSelection.authProfile && authSelection.authProfile.created_by !== userId)) {
      return { error: 'Members can only connect their own OAuth accounts. Ask an administrator to configure shared credentials.' };
    }
    const app = authSelection.appAuthProfile;
    const appIsWorkspaceDefault = app?.is_default_for_connector && app.connector_key === args.connector_key;
    const needsWorkspaceDefault = !authSelection.authProfile && !acceptsManagedApp;
    if (!app || app.status !== 'active' || (needsWorkspaceDefault && !appIsWorkspaceDefault)) {
      const setup = buildOAuthAppProfileSetupError({ connectorKey: args.connector_key, method: authSelection.oauthMethod!, setupUrl });
      return oauthAppSetupContinuation({ action: 'connect', connectorKey: args.connector_key,
        setup: { ...setup, error: 'Ask an administrator to configure and set the workspace-default OAuth app at setup_url. Then resume this call to authorize your own account.' }, resumeCall });
    }
  }

  const hasNoAuth =
		!authSelection.oauthMethod &&
		!authSelection.envMethod &&
		!authSelection.browserMethod;
	const profileDeviceWorkerIdConnect =
		authSelection.authProfile?.device_worker_id ?? null;
	let effectiveDeviceWorkerIdConnect = deviceBinding.deviceWorkerId;
	if (profileDeviceWorkerIdConnect) {
		if (!effectiveDeviceWorkerIdConnect) {
			effectiveDeviceWorkerIdConnect = profileDeviceWorkerIdConnect;
		} else if (
			effectiveDeviceWorkerIdConnect !== profileDeviceWorkerIdConnect
		) {
			return {
				error: `Auth profile '${authSelection.authProfile!.slug}' lives on a different device than the one selected; pick that device or a different profile.`,
				setup_url: setupUrl,
			};
		}
	}
	const isDeviceBoundBrowserSessionConnect =
		authSelection.authProfile?.profile_kind === "browser_session" &&
		!!profileDeviceWorkerIdConnect;
	// Same guard as create-path: when the profile contributed a device we
	// didn't already check against, re-run the duplicate-connection check now
	// so the partial unique index never decides the outcome with a raw error.
	if (
		effectiveDeviceWorkerIdConnect &&
		effectiveDeviceWorkerIdConnect !== deviceBinding.deviceWorkerId
	) {
    const dup = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND device_worker_id = ${effectiveDeviceWorkerIdConnect}
        AND deleted_at IS NULL
      LIMIT 1
    `) as unknown as Array<{ id: number }>;
    if (dup.length > 0) {
      return {
        error: `A ${connector.name} connection (id: ${dup[0].id}) is already assigned to that device in this org.`,
        setup_url: setupUrl,
      };
    }
  }
  const browserProfileUsable =
		authSelection.authProfile?.profile_kind === "browser_session" &&
    !isDeviceBoundBrowserSessionConnect
			? (
					await getBrowserSessionReadiness(
						authSelection.authProfile.auth_data,
						args.connector_key,
					)
				).usable
      : false;
  // Device-bound browser_session profiles are "ready" by virtue of the
  // cookies being on disk on the device. `getBrowserSessionReadiness` only
  // looks at server-side auth_data, which is empty for these — without this
  // exemption the connect path rejects them with "select or create a browser
  // auth profile" even when the Mac app just created one.
  const hasReadySelection =
    !!authSelection.authProfile &&
		(authSelection.authProfile.profile_kind === "browser_session"
      ? isDeviceBoundBrowserSessionConnect || browserProfileUsable
			: authSelection.authProfile.status === "active") &&
		(authSelection.selectedKind !== "oauth_account" ||
			(authSelection.appAuthProfile?.status === "active" &&
				!!authSelection.appAuthProfile));

  const needsConnectFlow =
		authSelection.preferredMethodType === "oauth" &&
    !!authSelection.oauthMethod &&
    !hasReadySelection &&
    !args.auth_profile_slug;
  const needsBrowserAuth =
    !!authSelection.browserMethod &&
    !!authSelection.authProfile &&
		authSelection.authProfile.profile_kind === "browser_session" &&
    !isDeviceBoundBrowserSessionConnect &&
    !browserProfileUsable;
	// Interactive-auth connectors (e.g. WhatsApp QR) bypass standard auth-profile
	// selection: the connection starts pending_auth and an auth run drives the
	// interactive pairing. Without this, an interactive connector looks like
	// no-auth (oauth/env/browser methods all absent) and connect would wrongly
	// create an ACTIVE, unauthenticated connection.
	const interactiveMethod =
		getInteractiveMethods(connector.auth_schema)[0] ?? null;
	const isInteractiveConnect = !!interactiveMethod && !hasReadySelection;
	const connectionStatus =
		needsConnectFlow || needsBrowserAuth || isInteractiveConnect
			? "pending_auth"
			: "active";

	if (isInteractiveConnect && !userId) {
    return {
			error: "Interactive pairing requires an authenticated user.",
      setup_url: setupUrl,
    };
  }

	if (
		!hasNoAuth &&
		!needsConnectFlow &&
		!needsBrowserAuth &&
		!hasReadySelection &&
		!isInteractiveConnect
	) {
		// Setup-required continuation: a known auth method needs a profile/config
		// the caller hasn't supplied. Non-terminal — the caller fixes it then retries.
		const family: ConnectionSetupFamily = authSelection.browserMethod
			? "browser"
			: authSelection.envMethod
				? "env_keys"
				: "oauth";
		const nextAction: ConnectionSetupNextAction = authSelection.browserMethod
			? "pair_browser"
			: "select_auth_profile";
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: family,
			nextAction,
			instructions: authSelection.browserMethod
				? "Select or create a browser auth profile before connecting."
				: authSelection.oauthMethod &&
						authSelection.selectedKind !== "oauth_account"
					? "Select or create an OAuth account profile before connecting."
					: authSelection.envMethod
						? "Select or create an auth profile (or pass env credentials) before connecting."
						: "Selected auth profile is not ready yet.",
			setupUrl,
			resumeCall,
		});
	}

  // Create the connection
  const connectDisplayName = await resolveConnectionDisplayName({
    explicitName: args.display_name,
    connectorName: connector.name,
    username: userId
      ? ((
					(
						await resolveUsernames([{ created_by: userId }], "created_by")
					)[0] as {
            created_by_username?: string;
          }
        )?.created_by_username ?? null)
      : null,
  });

  // A newly authorized OAuth account is personal even though its profile does
  // not exist yet. Apply the private scope from creation rather than waiting
  // for the OAuth callback to downgrade it.
  const connectionProfileKind =
    authSelection.authProfile?.profile_kind ??
    (needsConnectFlow ? "oauth_account" : undefined);
  const connectVisibility = await resolveConnectionVisibility(
    organizationId,
    userId,
		connectionProfileKind,
  );
  const personalScopeWarning = personalConnectionScopeWarning({
    visibility: connectVisibility,
    profileKind: connectionProfileKind,
  });
  const connectorFeedsSchema = (connector.feeds_schema ?? null) as Record<
    string,
    FeedDefinition
  > | null;
  const mergedConfig = {
    ...((connector.default_connection_config as Record<string, unknown>) ?? {}),
    ...(args.config ?? {}),
  };
  const splitConfig = splitConfigByFeedScope(
    Object.keys(mergedConfig).length > 0 ? mergedConfig : null,
		connectorFeedsSchema,
  );

  if (splitConfig.feedConfig) {
    return {
      error:
        'Feed-scoped config belongs on feeds. Create the connection first, then use client.feeds.create({ connection_id, feed_key, config }) for sync target settings.',
      setup_url: setupUrl,
    };
  }

  // Managed-connector path: a member connecting a managed connector in a PUBLIC
  // org gets a CONSENT-ONLY connection — it holds the OAuth grant for delegation
  // but has no feeds, so the cloud never syncs a copy (the data lives only on
  // the member's local instance). The consent_only flag lives in the trusted
  // connection `config` (where managedBy lives), and the manage_feeds guard
  // already refuses to create feeds on a consent_only connection.
  const isManagedConnect = isOAuthConnect && authSelection.oauthMethod
    ? await isManagedPublicOrgConnect({
        organizationId,
        connectorKey: args.connector_key,
        provider: authSelection.oauthMethod.provider,
      })
    : false;
	if (requireManaged && !isManagedConnect) {
		return {
			error:
				"Managed OAuth is no longer available for this connector. Discover managed_auth offers again before retrying.",
		};
	}
  const connectionConfigToInsert =
    isManagedConnect || splitConfig.connectionConfig
      ? {
          ...(splitConfig.connectionConfig ?? {}),
          ...(isManagedConnect ? { consent_only: true } : {}),
        }
      : null;

  // Reject cross-org entity_ids (mirrors handleCreate / manage_feeds).
  try {
    await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
  } catch (err) {
    return { error: getErrorMessage(err), setup_url: setupUrl };
  }
  const connectEntityIdsValue =
		args.entity_ids && args.entity_ids.length > 0
			? pgBigintArray(args.entity_ids)
			: null;

  const connectSlugResult = await resolveNewConnectionSlug({
    organizationId,
    connectorKey: args.connector_key,
    explicitSlug: args.slug,
    displayName: connectDisplayName,
  });
	if ("error" in connectSlugResult)
		return { error: connectSlugResult.error, setup_url: setupUrl };

	const insertConnection = (
		db: DbClient,
		authProfileId: number | null,
		useSavepoint: boolean,
	) =>
		insertConnectionWithSlug({
      organizationId,
      connectorKey: args.connector_key,
      displayName: connectDisplayName,
      initialSlug: connectSlugResult.slug,
      explicit: !!args.slug?.trim(),
			db,
			doInsert: (slug) => {
				const insert = () => db`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status,
          auth_profile_id, app_auth_profile_id, config, created_by, visibility, device_worker_id,
          entity_ids
        ) VALUES (
          ${organizationId}, ${args.connector_key},
          ${slug},
          ${connectDisplayName},
          ${connectionStatus},
            ${authProfileId ?? authSelection.authProfile?.id ?? null},
          ${authSelection.appAuthProfile?.id ?? null},
            ${connectionConfigToInsert ? db.json(connectionConfigToInsert) : null},
          ${userId},
          ${connectVisibility},
          ${effectiveDeviceWorkerIdConnect},
          ${connectEntityIdsValue}::bigint[]
        )
        RETURNING *
        `;
				return useSavepoint ? db.savepoint(insert) : insert();
			},
    });

	// Profile, connection, and auth run are one durable unit. A failed run
	// creation rolls back both rows, so another replica can never observe an
	// orphaned pending connection that has no pairing work queued.
	let insertedConn: Record<string, unknown>[];
	let interactiveAuthRunId: number | null;
	try {
		const bundle = await createConnectionSetupBundle({
			db: sql,
			interactive: isInteractiveConnect,
			organizationId,
			connectorKey: args.connector_key,
			displayName: connectDisplayName,
			createdByUserId: userId!,
			insertConnection,
		});
		insertedConn = bundle.rows;
		interactiveAuthRunId = bundle.authRunId;
  } catch (err) {
		if (err instanceof ConnectionSlugConflictError)
			return { error: err.message, setup_url: setupUrl };
    throw err;
  }

  const connection = insertedConn[0] as {
    id: number;
    slug: string;
    status: string;
  };

  logger.info(
    {
      connection_id: connection.id,
      connector_key: args.connector_key,
      status: connectionStatus,
    },
		"Connection created via connect flow",
  );

  recordLifecycleEvent({
    organizationId,
		entityType: "connection",
		op: "created",
    entityId: connection.id,
    summary: `Connection "${connectDisplayName}" created`,
		extra: {
			connector_key: args.connector_key,
			slug: connection.slug,
			via: "connect",
		},
  });

  recordToolConfigChange(ctx, {
		resourceKind: "connection",
    resourceId: connection.id,
		op: "created",
    summary: `Connection '${connectDisplayName}' created`,
    state: insertedConn[0] as Record<string, unknown>,
  });

	// Interactive pairing: the connection is pending_auth with a fresh
	// interactive profile. Kick off the auth run (the lifecycle that emits QR /
	// code artifacts) and return a setup_required continuation. The auth run —
	// not a connect retry — completes the connection.
	if (isInteractiveConnect) {
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: "interactive",
			nextAction: "pair_interactive",
			instructions:
				"Connection created as pending_auth. Complete interactive pairing (e.g. scan the QR code) via the auth run, then poll connections.get until status=active.",
			setupUrl: buildSetupUrl({ connectorKey: args.connector_key }),
			connectionId: connection.id,
			slug: connection.slug,
			completionCheck: activeConnectionPoll(connection.id),
			authRunId: interactiveAuthRunId!,
		});
	}

  // If active immediately, return simple result
  if (!needsConnectFlow && !needsBrowserAuth) {
    // Active now with resolvable credentials (env/PAT path) — if the connector
    // declares a webhook block and a feed target is configured, subscribe with
    // the provider once. Best-effort; failures are logged, not fatal.
		await registerConnectorWebhook({
			organizationId,
			connectionId: connection.id,
		});
    return {
			action: "connect",
      connection_id: connection.id,
      slug: connection.slug,
			status: "active",
			message: personalScopeWarning
        ? `Connection created and active. Note: ${personalScopeWarning}`
        : "Connection created and active.",
      view_url: buildSetupUrl({ connectorKey: args.connector_key }),
    };
  }

  if (needsBrowserAuth) {
    return {
			action: "connect",
      connection_id: connection.id,
      slug: connection.slug,
			status: "pending_auth",
			auth_type: "browser",
      auth_profile_slug: authSelection.authProfile?.slug ?? undefined,
      instructions:
        `Complete browser auth for profile '${authSelection.authProfile?.slug}'. ` +
        `Run: lobu memory browser-auth --connector ${args.connector_key} --auth-profile-slug ${authSelection.authProfile?.slug}`,
      view_url: buildSetupUrl({ connectorKey: args.connector_key }),
    };
  }

  const rollbackConnection = async () => {
    await sql`DELETE FROM feeds WHERE connection_id = ${connection.id}`;
    await sql`DELETE FROM connections WHERE id = ${connection.id}`;
  };

  if (!authSelection.oauthMethod) {
    await rollbackConnection();
		// Reached when a non-oauth method still needs setup (e.g. browser pairing
		// whose profile wasn't ready). Surface a continuation, not a prose error.
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: authSelection.browserMethod ? "browser" : "env_keys",
			nextAction: authSelection.browserMethod
				? "pair_browser"
				: "select_auth_profile",
			instructions:
				"This connection still needs an auth profile or pairing step before it can run. Complete it, then retry connect.",
			setupUrl,
			resumeCall,
		});
  }

  const oauthMethod = authSelection.oauthMethod;
  const appAuthProfile =
    authSelection.appAuthProfile ??
    (await getPrimaryAuthProfileForKind({
      organizationId,
      connectorKey: args.connector_key,
			profileKind: "oauth_app",
      provider: oauthMethod.provider,
    })) ??
    // Auto-provision an env-backed app profile from deployment env vars
    // (GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET etc.) — the same client GitHub
    // LOGIN already uses — so connecting a connector whose OAuth app creds are
    // env-configured needs zero manual secret entry. No-op (null) when those
    // env vars are absent, falling through to the original guidance below.
    (await ensureEnvBackedOAuthAppProfile({
      organizationId,
      connectorKey: args.connector_key,
      connectorName: connector.name,
      method: oauthMethod,
      createdBy: userId,
    }));

	if (!appAuthProfile || appAuthProfile.status !== "active") {
    await rollbackConnection();

		const setupError = buildOAuthAppProfileSetupError({
      connectorKey: args.connector_key,
      method: oauthMethod,
      setupUrl,
    });
		// OAuth app credentials are a setup step, not a business error. Surface a
		// continuation so an agent can read next_action and drive the admin to
		// configure the OAuth app, then retry connect.
		return oauthAppSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setup: setupError,
			fallbackSetupUrl: setupUrl,
			resumeCall,
		});
  }

  // Link app auth profile to connection; user auth profile will be created
  // when the OAuth callback completes (avoids orphaned pending_auth profiles).
  await sql`
    UPDATE connections
    SET app_auth_profile_id = ${appAuthProfile.id},
        updated_at = NOW()
    WHERE id = ${connection.id}
  `;

  const connectToken = await createConnectToken({
    connectionId: connection.id,
    organizationId,
    connectorKey: args.connector_key,
		authType: "oauth",
    authConfig: {
      ...buildOAuthConnectConfig(oauthMethod, args.requested_scopes),
      appAuthProfileId: appAuthProfile.id,
      // Profile metadata — callback creates the real profile on success
      pendingProfileMeta: {
        displayName: `${args.display_name ?? connector.name} Account`,
        slug: `${args.connector_key}-${oauthMethod.provider}-account`,
        connectorKey: args.connector_key,
        provider: oauthMethod.provider,
      },
    },
    createdBy: userId,
  });

  const connectUrl = `${getConnectBaseUrl(ctx)}/connect/${connectToken.token}/oauth/start`;

  // Fire-and-forget notification to org admins
  notifyConnectionPermissionRequest({
    orgId: organizationId,
    connectionId: connection.id,
    connectorKey: args.connector_key,
    connectUrl,
	}).catch((err) =>
		logger.error(err, "Failed to send connection permission notification"),
	);

  return {
		action: "connect",
    connection_id: connection.id,
    slug: connection.slug,
		status: "pending_auth",
		auth_type: "oauth",
    connect_url: connectUrl,
    connect_token: connectToken.token,
    expires_at: new Date(connectToken.expires_at).toISOString(),
    instructions:
      `Open the exact connect_url to let the user authorize their account with ${oauthMethod.provider} using the selected app "${appAuthProfile.display_name}". Explain the requested permissions before the user continues.` +
      (personalScopeWarning ? ` ${personalScopeWarning}` : "") +
      " Poll with client.connections.get(connection_id) via query_sdk until status='active', then check client.operations.listAvailable({ connection_id }) for the requested capabilities before resuming the original task. Reuse this connection; do not create duplicate connections or feeds.",
  };
}
