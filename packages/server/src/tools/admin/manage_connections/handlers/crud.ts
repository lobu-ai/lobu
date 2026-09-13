/**
 * CRUD action handlers: list, get, create, update, delete.
 */

import { randomUUID } from "node:crypto";
import { getErrorMessage, parseJsonObject } from "@lobu/core";
import { getScopedConnectorDefinition } from "../../../../catalog/connector-definitions";
import { enrichConnectorGroupsWithCatalogDisplay } from "../../../../catalog/connector-group-display";
import {
	registerConnectorWebhook,
	unregisterConnectorWebhook,
} from "../../../../connect/webhook-registration";
import {
	getDb,
	parsePgNumberArray,
	pgBigintArray,
	pgTextArray,
	withSessionAdvisoryLock,
	type DbClient,
} from "../../../../db/client";
import { recordToolConfigChange } from "../../helpers/config-audit";
import { slugify } from "../../../../auth/personal-org-provisioning";
import {
	connectorSecretKeysFromSchemas,
	loadConnectorSecretKeys,
	redactConnectionConfig,
	redactConnectionRow,
	restoreRedactedConfig,
} from "../../../../utils/connection-config-redaction";
import {
	deleteChatConnection,
	updateChatConnection,
	upsertByoChatConnection,
} from "../../../../gateway/connections/chat-connection-service";
import { isAtlassianMcpConfig } from "../../../../operations/atlassian-mcp-feed";
import { queueApprovalNotificationCardRefresh } from "../../../../notifications/service";
import {
  EMPTY_SUMMARY,
  getOperationsSummariesByConnection,
  getOperationsSummary,
  getOperationsSummaryBatch,
} from "../../../../operations/connector-operations";
import {
  actionModesChanged,
  denyNonHumanActionModesWrite,
  hasActionModes,
} from "./action-modes-guard";
import { projectConnectionForReader } from "../public-projection";
import {
  getAuthProfileById,
  getAuthProfileBySlug,
  getBrowserSessionReadiness,
} from "../../../../utils/auth-profiles";
import { DEVICE_ONLINE_WINDOW_SECONDS } from "../../../../utils/device-liveness";
import {
	DEVICE_PIN_TOMBSTONE_MESSAGES,
	effectiveConnectionErrorMessage,
	isDevicePinTombstone,
} from "../../../../utils/device-pin-tombstones";
import { deleteConnectionAclRow } from "../../../../authz/acl-observability";
import {
  ConnectionSlugConflictError,
  connectionSlugFormatError,
  connectionSlugTaken,
  insertConnectionWithSlug,
  isConnectionDevicePinUniqueViolation,
  isConnectionSlugUniqueViolation,
  resolveNewConnectionSlug,
} from "../../../../utils/connections";
import { ensureConnectorInstalled } from "../../../../utils/ensure-connector-installed";
import {
	connectionLinkedEntityIdsSql,
	connectionLinkedToBusinessEntitySql,
} from "../../../../authz/channel-about";
import {
	recordChangeEvent,
	recordLifecycleEvent,
} from "../../../../utils/insert-event";
import {
	DEVICE_AUTOWIRE_SUPPRESSION_ERROR,
	DEVICE_AUTOWIRE_SUPPRESSION_PATCH,
	type DeviceAutowireIdentityRow,
	hasDeviceAutowireSuppressionMarker,
	IS_DEVICE_CONNECTOR_SQL,
	isDeviceAutowireIdentity,
} from "../../../../utils/device-autowire-suppression";
import logger from "../../../../utils/logger";
import { OAUTH_SCOPE_PAUSE_LAST_ERROR, syncOAuthConnectionsForAuthProfile } from "../../../../utils/oauth-connection-state";
import { CONNECT_TOKEN_EXPIRED_ERROR } from "../../../../utils/connect-tokens";
import { oauthAccountOwnershipError } from '../../../../authz/oauth-account-ownership';
import { compileConnectionRowVisibility } from "../../../../authz/connection-visibility";
import { authzScopeFromToolContext } from "../../../../authz/scope";
import { resolveUsernames } from "../../../../utils/resolve-usernames";
import {
	ACTIVE_RUN_STATUSES,
	APPROVAL_RUN_TYPES,
	runStatusLiteral,
} from "../../../../utils/run-statuses";
import type { ToolContext } from "../../../registry";
import {
	buildAppInstallationSetupUrl,
	rejectUnboundAppInstallationCreate,
} from "../../helpers/app-installation-guard";
import { buildOAuthAppProfileSetupError } from "../../helpers/connector-setup-errors";
import {
  buildViewUrl,
  enrichWithAuthProfiles,
	ensureEnvBackedOAuthAppProfile,
	getGatewayBaseUrl,
  getInteractiveMethods,
  isExplicitNoAuthSelection,
  isPersonalCredentialKind,
  isPersonalCredVisibilityViolation,
  mapConnectionStatusToFeedStatus,
  PERSONAL_CRED_ORG_VISIBILITY_ERROR,
  resolveConnectionAuthSelection,
  resolveConnectionDisplayName,
  resolveConnectionVisibility,
} from "../../helpers/connection-helpers";
import {
	assertEntityIdsInOrg,
	callerIsAdmin as resolveCallerIsAdmin,
} from "../../helpers/db-helpers";
import {
	type FeedDefinition,
	feedOperations,
	splitConfigByFeedScope,
} from "../../helpers/feed-helpers";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";
import {
	isManagedPublicOrgConnect,
	resolveDeviceBinding,
} from "./device-binding";
import {
	deriveConnectionFacets,
	deriveEffectiveCredentialMode,
} from "./facets";
import {
	activeConnectionPoll,
	appInstallationSetupContinuation,
	buildConnectionSetupContinuation,
	buildSafeConnectionResumeCall,
	oauthAppSetupContinuation,
} from "../../helpers/connect-setup-continuation";
import { createConnectionSetupBundle } from "../../helpers/interactive-connection-setup";
import { supersedeActionEvent } from "../../approval-events";
import {
	lockOrganizationForRelationshipClaims,
	retractConnectionRelationshipClaims,
} from "../../../../utils/relationship-claims";

// These Atlassian MCP config keys select a separately-consented Jira OAuth
// grant. A member must not bind an admin's Jira authorization to a connection.
const JIRA_WEBHOOK_CREDENTIAL_KEYS = [
	"jira_webhook_auth_profile_slug",
	"jira_webhook_app_profile_slug",
	"webhook_enabled",
] as const;

const JIRA_WEBHOOK_ADMIN_ONLY_ERROR =
	"Only admins can configure the secondary Jira authorization used by Atlassian webhook delivery.";

// ============================================
// handleListConnectorGroups
// ============================================

function mapConnectorGroupSummaries(raw: unknown): Array<{
  id: number;
  display_name: string | null;
  feed_count: number;
}> {
  if (!Array.isArray(raw)) return [];
  const summaries: Array<{
    id: number;
    display_name: string | null;
    feed_count: number;
  }> = [];
  for (const item of raw) {
		if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = Number(record.id);
    const displayName =
			typeof record.display_name === "string" && record.display_name.trim()
        ? record.display_name.trim()
        : null;
    const feedCount = Number(record.feed_count) || 0;
    if (!Number.isFinite(id)) continue;
    summaries.push({ id, display_name: displayName, feed_count: feedCount });
  }
  return summaries;
}

export async function handleListConnectorGroups(
	args: Extract<ConnectionsArgs, { action: "list_connector_groups" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  let query = sql`
    SELECT c.connector_key,
           MAX(cd.name) AS connector_name,
           MAX(cd.favicon_domain) AS favicon_domain,
           COUNT(*)::int AS connection_count,
           bool_or(cd.declares_chat) AS has_chat_connection,
           bool_or(fc.feed_count > 0) AS has_active_feeds,
           -- DATA-facet input: only event-store feeds count, so a chat-only
           -- group whose channel feeds use channel_messages isn't mislabeled data.
           bool_or(fc.data_feed_count > 0) AS has_active_data_feeds,
           bool_or(cd.has_feeds_schema) AS connector_has_feeds,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', c.id,
                 'display_name', NULLIF(TRIM(c.display_name), ''),
                 'feed_count', fc.feed_count
               )
               ORDER BY COALESCE(NULLIF(TRIM(c.display_name), ''), cd.name, c.connector_key), c.id
             ),
             '[]'::json
           ) AS connections
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT name, favicon_domain,
             (feeds_schema IS NOT NULL
              AND feeds_schema::text <> '{}'
              AND feeds_schema::text <> 'null') AS has_feeds_schema,
             -- chat facet is declared by the connector, not implied by having a
             -- credential: a connector is chat iff it carries the chat-platform
             -- marker in its options_schema (x-lobu-chat-platform).
             (options_schema ->> 'x-lobu-chat-platform') IS NOT NULL AS declares_chat
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS feed_count,
             COUNT(*) FILTER (WHERE COALESCE(f.config ->> 'store', '') <> 'channel_messages')::int AS data_feed_count
      FROM feeds f
      WHERE f.connection_id = c.id
        AND f.deleted_at IS NULL
    ) fc ON TRUE
    WHERE c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
  `;

  if (args.entity_id) {
    query = sql`${query} AND ${sql.unsafe(
			connectionLinkedToBusinessEntitySql(
				String(args.entity_id),
				"c",
				`'${organizationId}'`,
			),
    )}`;
  }

  if (!(await resolveCallerIsAdmin(sql, ctx))) {
    query = sql`${query} ${sql.unsafe(compileConnectionRowVisibility(authzScopeFromToolContext(ctx), "c"))}`;
  }

  query = sql`${query} GROUP BY c.connector_key ORDER BY MAX(cd.name), c.connector_key`;

  const rows = await query;
  const connectorKeys = [...new Set(rows.map((r) => String(r.connector_key)))];
  const connectionIdByKey = new Map<string, number>();
  for (const row of rows) {
    const connectorKey = String(row.connector_key);
    if (connectionIdByKey.has(connectorKey)) continue;
    const firstConnection = mapConnectorGroupSummaries(row.connections)[0];
    if (firstConnection) connectionIdByKey.set(connectorKey, firstConnection.id);
  }
	const opsSummaries = await getOperationsSummaryBatch(
		organizationId,
		connectorKeys,
		connectionIdByKey,
	);

  const groups = rows.map((row) => {
    const connectorKey = String(row.connector_key);
    const feedCount = row.has_active_data_feeds === true ? 1 : 0;
    return {
      connector_key: connectorKey,
      connector_name:
        row.connector_name != null ? String(row.connector_name) : null,
      favicon_domain:
        row.favicon_domain != null ? String(row.favicon_domain) : null,
      connection_count: Number(row.connection_count) || 0,
      connections: mapConnectorGroupSummaries(row.connections),
      facets: deriveConnectionFacets({
        connectorKey,
        isChat: row.has_chat_connection === true,
        feedCount,
        connectorHasFeeds: row.connector_has_feeds === true,
        hasOperations: (opsSummaries.get(connectorKey)?.total ?? 0) > 0,
      }),
    };
  });

  return {
		action: "list_connector_groups",
    groups: await enrichConnectorGroupsWithCatalogDisplay(groups),
  };
}

// ============================================
// handleList
// ============================================

export async function handleList(
	args: Extract<ConnectionsArgs, { action: "list" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  let query = sql`
    SELECT c.*,
           COUNT(*) OVER()::int AS filtered_total,
           cd.name AS connector_name,
           cd.has_feeds_schema,
           cd.declares_chat,
           ap.slug AS auth_profile_slug,
           ap.display_name AS auth_profile_name,
           ap.status AS auth_profile_status,
           ap.profile_kind AS auth_profile_kind,
           app.slug AS app_auth_profile_slug,
           app.display_name AS app_auth_profile_name,
           app.status AS app_auth_profile_status,
           app.profile_kind AS app_auth_profile_kind,
           dw.label AS device_label,
           dw.platform AS device_platform,
           dw.worker_id AS device_worker_handle,
           dw.last_seen_at AS device_last_seen_at,
           (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})) AS device_online,
           CASE
             WHEN c.device_worker_id IS NOT NULL
              AND NOT (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}))
             THEN 'offline'
           END AS device_status,
           -- event_count intentionally omitted from list responses: the
           -- per-row correlated count via current_event_records does a
           -- supersedes anti-join over the events table and was the dominant
           -- cost in this query (1303ms mean → 2.3ms without it; see the
           -- post-incident perf brainstorm). For the per-connection detail
           -- page, handleGet below still computes it — that path is a single
           -- row and costs ~1.2ms.
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL)::int AS feed_count,
           -- The DATA facet must not light up just because a chat connection's
           -- channels are feed rows too: exclude the channel_messages store
           -- for facet.data. feed_count stays the TOTAL
           -- (drives the feeds rail, which lists channels too).
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL AND COALESCE(f.config ->> 'store', '') <> 'channel_messages')::int AS data_feed_count,
           (SELECT ct.token FROM connect_tokens ct
            WHERE ct.connection_id = c.id AND ct.status = 'pending' AND ct.expires_at > NOW()
            ORDER BY ct.created_at DESC LIMIT 1) AS connect_token,
           -- entity_names = connection tag, feed tags, and per-channel about links.
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.deleted_at IS NULL
               AND ent.id IN ${sql.unsafe(connectionLinkedEntityIdsSql("c"))}
           ) AS entity_names
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT name,
             (feeds_schema IS NOT NULL
              AND feeds_schema::text <> '{}'
              AND feeds_schema::text <> 'null') AS has_feeds_schema,
             (options_schema ->> 'x-lobu-chat-platform') IS NOT NULL AS declares_chat
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    LEFT JOIN auth_profiles app ON app.id = c.app_auth_profile_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    WHERE c.organization_id = ${organizationId} AND c.deleted_at IS NULL
  `;

  if (args.connector_key) {
    query = sql`${query} AND c.connector_key = ${args.connector_key}`;
  }
  if (args.status) {
    query = sql`${query} AND c.status = ${args.status}`;
  }
  if (args.entity_id) {
    query = sql`${query} AND ${sql.unsafe(
			connectionLinkedToBusinessEntitySql(
				String(args.entity_id),
				"c",
				`'${organizationId}'`,
			),
    )}`;
  }
  if (args.created_by) {
    query = sql`${query} AND c.created_by = ${args.created_by}`;
  }
  if (args.connection_ids?.length) {
    query = sql`${query} AND c.id = ANY(${pgBigintArray(args.connection_ids)}::bigint[])`;
  }
  if (args.setup_attempt_id) {
    query = sql`${query} AND c.config->'setup_attempt_ids' @> ${sql.json([
			args.setup_attempt_id,
		])}::jsonb`;
  }

  // Visibility: owners/admins manage every connection; everyone else gets the
  // shared connection-visibility predicate (anonymous → org-only).
  if (!(await resolveCallerIsAdmin(sql, ctx))) {
    query = sql`${query} ${sql.unsafe(compileConnectionRowVisibility(authzScopeFromToolContext(ctx), "c"))}`;
  }

  // The window count is the true filtered total on every non-empty page. Keep
  // the complete filtered query for the rare overshoot fallback, where there
  // is no row from which to read the window value.
  const filteredQuery = query;
  query = sql`${filteredQuery} ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit} OFFSET ${offset}`;

  const rows = await query;
  let total: number;
  if (rows.length > 0) {
    total = Number(rows[0].filtered_total ?? rows.length);
  } else {
    const [countRow] = (await sql`
      SELECT COUNT(*)::int AS total FROM (${filteredQuery}) filtered
    `) as Array<{ total: number }>;
    total = Number(countRow?.total ?? 0);
  }
  const resolved = await resolveUsernames(
		(rows as unknown as Record<string, unknown>[]).map(
			({ filtered_total: _filteredTotal, ...row }) => row,
		),
		"created_by",
  );

	const connectorKeys = [
		...new Set(resolved.map((r) => String(r.connector_key))),
	];
	const summaries = await getOperationsSummariesByConnection(
		organizationId,
		resolved.map((r) => ({
			id: Number(r.id),
			connectorKey: String(r.connector_key),
		})),
	);
	// `SELECT c.*` carries the raw `config` jsonb, which is written verbatim
	// (split by feed scope, never by secrecy). Resolve each connector's
	// schema-declared secret keys ONCE for the page, then redact per row below.
	const secretKeysByConnector = await loadConnectorSecretKeys(
		organizationId,
		connectorKeys,
	);

  const connections = resolved.map((row) => {
		const operationsSummary = summaries.get(Number(row.id)) ?? {
			...EMPTY_SUMMARY,
		};
    const hasOperations = operationsSummary.total > 0;
    return {
      ...row,
      // Secrets never leave the server through a connection serializer.
      config: redactConnectionConfig(
        row.config,
        secretKeysByConnector.get(String(row.connector_key)),
      ),
      // Postgres returns bigint[] as a literal string ('{2}'); parse to number[]
      // so the API contract matches the typed entity_ids the UI picker expects.
      entity_ids: parsePgNumberArray(row.entity_ids),
			// Pin-tombstone self-heal for display: device re-paired but error_message
			// still says "Device was removed" (write paths clear on pin; this covers
			// already-stuck rows until the next reconcile).
			error_message: effectiveConnectionErrorMessage({
				error_message: row.error_message as string | null,
				device_worker_id: row.device_worker_id as string | null,
				device_last_seen_at: row.device_last_seen_at as string | null,
				device_worker_handle: row.device_worker_handle as string | null,
				device_label: row.device_label as string | null,
			}),
      operations_summary: operationsSummary,
      has_operations: hasOperations,
      facets: deriveConnectionFacets({
        connectorKey: String(row.connector_key),
        isChat: row.declares_chat === true,
        feedCount: Number(row.data_feed_count) || 0,
        connectorHasFeeds: row.has_feeds_schema === true,
        hasOperations,
      }),
      effective_credential_mode: deriveEffectiveCredentialMode({
        credentialMode: row.credential_mode as string | null,
        appAuthProfileId: row.app_auth_profile_id,
        authProfileId: row.auth_profile_id,
      }),
    };
  });

  return {
		action: "list",
    connections: connections.map((row) =>
      projectConnectionForReader(row, ctx)
    ),
    total,
    limit,
    offset,
    view_url: await buildViewUrl(ctx),
  };
}

// ============================================
// handleGet
// ============================================

export async function handleGet(
	args: Extract<ConnectionsArgs, { action: "get" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  let query = sql`
    SELECT c.*,
           cd.name AS connector_name,
           cd.feeds_schema,
           cd.auth_schema,
           -- options_schema drives schema-declared config redaction below
           -- (format:"password" properties); auth_schema covers the
           -- env_keys secret:true fields.
           cd.options_schema,
           cd.declares_chat,
           ap.slug AS auth_profile_slug,
           ap.display_name AS auth_profile_name,
           ap.status AS auth_profile_status,
           ap.profile_kind AS auth_profile_kind,
           app.slug AS app_auth_profile_slug,
           app.display_name AS app_auth_profile_name,
           app.status AS app_auth_profile_status,
           app.profile_kind AS app_auth_profile_kind,
           dw.label AS device_label,
           dw.platform AS device_platform,
           dw.worker_id AS device_worker_handle,
           dw.last_seen_at AS device_last_seen_at,
           (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})) AS device_online,
           CASE
             WHEN c.device_worker_id IS NOT NULL
              AND NOT (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}))
             THEN 'offline'
           END AS device_status,
           (SELECT COUNT(*) FROM current_event_records e WHERE e.connection_id = c.id)::int AS event_count,
           -- feed_count = TOTAL live feeds (drives the feeds rail, channels
           -- included). data_feed_count excludes streaming channels so the DATA
           -- facet stays off for a pure-chat connection (mirrors list).
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL)::int AS feed_count,
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL AND COALESCE(f.config ->> 'store', '') <> 'channel_messages')::int AS data_feed_count
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT name, feeds_schema, auth_schema, options_schema,
             (options_schema ->> 'x-lobu-chat-platform') IS NOT NULL AS declares_chat
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    LEFT JOIN auth_profiles app ON app.id = c.app_auth_profile_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
  `;

  if (!(await resolveCallerIsAdmin(sql, ctx))) {
    query = sql`${query} ${sql.unsafe(compileConnectionRowVisibility(authzScopeFromToolContext(ctx), "c"))}`;
  }

  const rows = await query;
  if (rows.length === 0) {
		return { error: "Connection not found" };
  }

	const [resolved] = await resolveUsernames(
		[rows[0] as Record<string, unknown>],
		"created_by",
	);

  const connection = rows[0] as { status: string; connector_key: string };
  const viewUrl = await buildViewUrl(ctx, connection.connector_key);

  // For pending_auth connections, include the connect token so the UI can initiate OAuth
  let connectToken: string | undefined;
	if (connection.status === "pending_auth") {
    const tokenRows = await sql`
      SELECT token
      FROM connect_tokens
      WHERE connection_id = ${args.connection_id}
        AND organization_id = ${organizationId}
        AND status = 'pending'
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (tokenRows.length > 0) {
      connectToken = (tokenRows[0] as { token: string }).token;
    }
  }

  const operationsSummary = await getOperationsSummary(
    organizationId,
		String((resolved as any).connector_key),
		args.connection_id,
  );

  const getRow = resolved as Record<string, unknown>;
  const feedsSchema = getRow.feeds_schema;
  const connectorHasFeeds =
    feedsSchema != null &&
		JSON.stringify(feedsSchema) !== "{}" &&
		JSON.stringify(feedsSchema) !== "null";
  const hasOperations = operationsSummary.total > 0;

  return {
		action: "get",
    connection: projectConnectionForReader({
      ...resolved,
			error_message: effectiveConnectionErrorMessage({
				error_message: getRow.error_message as string | null,
				device_worker_id: getRow.device_worker_id as string | null,
				device_last_seen_at: getRow.device_last_seen_at as string | null,
				device_worker_handle: getRow.device_worker_handle as string | null,
				device_label: getRow.device_label as string | null,
			}),
      ...(connectToken ? { connect_token: connectToken } : {}),
      // Secrets never leave the server through a connection serializer. The
      // connector's own schemas are already joined in above (cd.auth_schema /
      // cd.options_schema), so this needs no extra query.
      config: redactConnectionConfig(
        getRow.config,
        connectorSecretKeysFromSchemas({
          optionsSchema: getRow.options_schema,
          authSchema: getRow.auth_schema,
        }),
      ),
      operations_summary: operationsSummary,
      has_operations: hasOperations,
      facets: deriveConnectionFacets({
        connectorKey: String(getRow.connector_key),
        isChat: getRow.declares_chat === true,
        feedCount: Number(getRow.data_feed_count) || 0,
        connectorHasFeeds,
        hasOperations,
      }),
      effective_credential_mode: deriveEffectiveCredentialMode({
        credentialMode: getRow.credential_mode as string | null,
        appAuthProfileId: getRow.app_auth_profile_id,
        authProfileId: getRow.auth_profile_id,
      }),
    }, ctx),
    view_url: viewUrl,
  };
}

// ============================================
// handleCreate
// ============================================

export async function handleCreate(
	args: Extract<ConnectionsArgs, { action: "create" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
  if (hasDeviceAutowireSuppressionMarker(args.config)) {
    return { error: DEVICE_AUTOWIRE_SUPPRESSION_ERROR };
  }
  // Refuse before connector installation or any other create-path side effect.
  if (hasActionModes(args.config)) {
    const denied = denyNonHumanActionModesWrite(ctx);
    if (denied) return denied;
  }
  const sql = getDb();
  const { organizationId, userId } = ctx;
	const createResumeCall = buildSafeConnectionResumeCall(
		"connections.create",
		args,
	);

  // Resolve caller role once — we use it for created_by overrides, explicit
  // app_auth_profile picks, and member-friendly error messages downstream.
	const callerIsAdmin = await resolveCallerIsAdmin(sql, {
		organizationId,
		userId,
	});

  // Resolve effective owner — admins can create connections on behalf of other users
  let effectiveCreatedBy = userId;
  if (args.created_by && args.created_by !== userId) {
    if (!callerIsAdmin) {
			return { error: "Only admins can create connections for other users." };
    }
    effectiveCreatedBy = args.created_by;
  }

  // Non-admins must accept the org-default app profile — they can't pick or
  // bring an alternate OAuth client. If they explicitly pass a slug, it has
  // to match the admin-pinned default for the connector.
  if (!callerIsAdmin && args.app_auth_profile_slug) {
		const picked = await getAuthProfileBySlug(
			organizationId,
			args.app_auth_profile_slug,
		);
		if (!picked || picked.profile_kind !== "oauth_app") {
			return {
				error: `App auth profile '${args.app_auth_profile_slug}' not found`,
			};
    }
    const pinnedAsDefault =
			picked.is_default_for_connector &&
			picked.connector_key === args.connector_key;
    if (!pinnedAsDefault) {
      return {
        error: `Only admins can override the OAuth app profile. Ask an admin to pin '${args.app_auth_profile_slug}' as the default for this connector, or omit app_auth_profile_slug to use the org default.`,
      };
    }
  }

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
			error: `Connector '${args.connector_key}' not found or not active`,
		};
	}
	if (
		!callerIsAdmin &&
		isAtlassianMcpConfig(connector.mcp_config) &&
		JIRA_WEBHOOK_CREDENTIAL_KEYS.some((key) =>
			Object.hasOwn(args.config ?? {}, key),
		)
	) {
		return { error: JIRA_WEBHOOK_ADMIN_ONLY_ERROR };
	}
	// Schema-declared secret config keys for this connector — used to redact the
	// `RETURNING *` row before it is serialized back to the caller.
	const createSecretKeys = connectorSecretKeysFromSchemas({
		optionsSchema: connector.options_schema,
		authSchema: connector.auth_schema,
	});

	const connectionPlatform =
		connector.options_schema &&
		typeof connector.options_schema === "object" &&
		((connector.options_schema as Record<string, unknown>)[
			"x-lobu-chat-platform"
		] ??
			(connector.options_schema as Record<string, unknown>)[
				"x-lobu-adapterless-platform"
			]);
	if (connectionPlatform === args.connector_key) {
		try {
			// The slug is OPTIONAL: the connection create form has no slug input,
			// so requiring one made inbound-webhook connections impossible to
			// create from the UI. Derive a readable slug from the display name
			// with a random suffix against collisions. The embedded hyphen keeps
			// the result non-numeric even for a numeric display name — numeric
			// webhook URLs are reserved for provider connector IDs
			// (upsertByoChatConnection enforces the same rule for explicit slugs).
			const stableId =
				args.slug ||
				`${slugify(args.display_name ?? "") || "hook"}-${randomUUID()
					.replace(/-/g, "")
					.slice(0, 6)}`;
			const created = await upsertByoChatConnection({
				organizationId,
				platform: args.connector_key,
				stableId,
				displayName: args.display_name,
				config: args.config ?? {},
			});
			const read = await handleGet(
				{ action: "get", connection_id: created.connectionId },
				ctx,
			);
			if ("error" in read || read.action !== "get") return read;
			recordToolConfigChange(ctx, {
				resourceKind: "connection",
				resourceId: created.connectionId,
				op: created.created ? "created" : "updated",
				summary: `Connection '${args.display_name ?? args.connector_key}' ${created.created ? "created" : "updated"}`,
				state: read.connection as Record<string, unknown>,
			});
			return {
				action: "create",
				connection: read.connection,
				connector,
			};
		} catch (error) {
			return { error: getErrorMessage(error) };
		}
  }

  // Reject a direct create of an UNBOUND app_installation connection (no
  // installation_ref AND no other auth intent) — those are created only by the
  // App install callback. Selection-aware: a create that supplies an auth profile
  // / app profile / env creds / managedBy resolves to a different method and is
  // allowed through.
  const explicitlyNoAuth = isExplicitNoAuthSelection({
    authSchema: connector.auth_schema,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
  });
  const appInstallGuard = explicitlyNoAuth ? null : await rejectUnboundAppInstallationCreate({
    organizationId,
    authSchema: connector.auth_schema,
    config: args.config,
    connectorKey: args.connector_key,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
    gatewayBaseUrl: getGatewayBaseUrl(ctx),
    setupUrl: await buildViewUrl(ctx, args.connector_key),
  });
  if (appInstallGuard) {
		return appInstallationSetupContinuation({
			action: "create",
			connectorKey: args.connector_key,
			setup: appInstallGuard,
			setupUrl: await buildAppInstallationSetupUrl(ctx, args.connector_key),
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
				action: "create",
				connectorKey: args.connector_key,
				setupFamily: "device_bound",
				nextAction: "connect_device",
				instructions: deviceBinding.error,
				setupUrl: await buildViewUrl(ctx, args.connector_key),
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

  // No-auth connectors are limited to one connection per user — except when the
  // connection is pinned to a device worker, where the cardinality is "one per
  // (org, connector, device)" (enforced just above + by the unique index), so a
  // user's second device can back the same connector with its own connection.
  const authMethods =
		(connector.auth_schema as { methods?: Array<{ type: string }> })?.methods ??
		[];
	const isNoAuth =
		authMethods.length > 0 && authMethods.every((m) => m.type === "none");
  if (isNoAuth && !deviceBinding.deviceWorkerId) {
    const existing = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND created_by = ${effectiveCreatedBy}
        AND device_worker_id IS NULL
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (existing.length > 0) {
      return {
        error: `This user already has a ${connector.name} connection (id: ${existing[0].id}). No-auth connectors are limited to one connection per user (unless pinned to different devices).`,
      };
    }
  }

  // Detect interactive-auth connectors (e.g. WhatsApp QR). These bypass the
  // standard auth profile selection and instead drive an `authenticate()` run
  // that emits artifacts (qr/code/etc.) for the UI to render.
	const interactiveMethod =
		explicitlyNoAuth ? null : getInteractiveMethods(connector.auth_schema)[0] ?? null;
	if (interactiveMethod && !userId) {
		return { error: "Interactive pairing requires an authenticated user." };
	}

  // A `managedBy` connection's OAuth grant lives in a cloud (public) org — the
  // local instance fetches the token at runtime (execution-context.ts) and never
  // holds a LOCAL auth profile. The trusted `config.managedBy.org` signal (set by
  // `defineConnection({ managedBy })` via `lobu apply`) puts the connection on a
  // dedicated path: local auth-profile selection is skipped ENTIRELY (no binding,
  // requirement, status gating, or oauth sync), and it is created `active` with
  // null local auth profiles. An empty `org` is not a valid managed connection,
  // so it falls through to the normal auth path rather than being created
  // active+unauthenticated.
  const incomingConfig = parseJsonObject(args.config);
  const managedByOrg =
		incomingConfig.managedBy &&
		typeof incomingConfig.managedBy === "object" &&
    !Array.isArray(incomingConfig.managedBy)
      ? (incomingConfig.managedBy as Record<string, unknown>).org
      : undefined;
  const managedByRequested =
		typeof managedByOrg === "string" && managedByOrg.trim().length > 0;
  // managedBy delegates to a cloud OAuth grant, so it only applies to OAuth
  // connectors. On a non-OAuth connector (env/browser/none) treating it as
  // managed would bypass a real local auth requirement, so reject it instead of
  // creating an unauthenticated connection.
	if (managedByRequested && !authMethods.some((m) => m.type === "oauth")) {
    return {
      error:
				"managedBy is only valid for OAuth connectors (the managed grant is an OAuth token fetched from the cloud); this connector has no OAuth auth method.",
    };
  }
  const isManagedByConnection = managedByRequested;

  // Leave `authSelection` null for managed (and interactive) connections so the
  // entire auth-profile validation + binding chain below is uniformly bypassed —
  // a managed connection is created with null `auth_profile_id` /
  // `app_auth_profile_id` regardless of any local profile that happens to exist.
  const authSelection =
    interactiveMethod || isManagedByConnection
      ? null
      : await resolveConnectionAuthSelection({
          organizationId,
          connectorKey: args.connector_key,
          authSchema: connector.auth_schema,
          authProfileSlug: args.auth_profile_slug,
          appAuthProfileSlug: args.app_auth_profile_slug,
          deviceWorkerId: deviceBinding.deviceWorkerId,
          oauthAccountCreatedBy: effectiveCreatedBy,
        });

  if (authSelection) {
    const requiresAuth =
			!!authSelection.oauthMethod ||
			!!authSelection.envMethod ||
			!!authSelection.browserMethod;
    if (requiresAuth && !explicitlyNoAuth && !authSelection.authProfile) {
			const setupFamily = authSelection.browserMethod
				? "browser"
				: authSelection.envMethod
					? "env_keys"
					: "oauth";
			return buildConnectionSetupContinuation({
				action: "create",
				connectorKey: args.connector_key,
				setupFamily,
				nextAction: authSelection.browserMethod
					? "pair_browser"
					: "select_auth_profile",
				instructions: authSelection.browserMethod
					? "Select or create a browser auth profile before creating the connection."
          : authSelection.oauthMethod && authSelection.envMethod
						? "Select an auth profile for this connector before creating the connection."
            : authSelection.oauthMethod
							? "Select or create an OAuth account profile before creating the connection."
							: "Select or create an auth profile before creating the connection.",
				setupUrl: await buildViewUrl(ctx, args.connector_key),
				resumeCall: createResumeCall,
			});
    }
  }

  const browserProfileUsable =
		authSelection?.authProfile?.profile_kind === "browser_session"
			? (
					await getBrowserSessionReadiness(
						authSelection.authProfile.auth_data,
						args.connector_key,
					)
				).usable
      : false;

  // A `pending_auth` auth profile is OK on create *only* for kinds that can
  // actually become active out of band — `oauth_account` (OAuth callback) and
  // `browser_session` (already handled above). The connection is created
  // `pending_auth` and the callback flips both to `active`. This lets a
  // connection reference a freshly created oauth_account profile in the same
  // `lobu apply`. An `env`/`oauth_app` profile that's not active is an error.
  if (
    authSelection?.authProfile &&
		authSelection.authProfile.profile_kind !== "browser_session" &&
		authSelection.authProfile.status !== "active" &&
    !(
			authSelection.authProfile.status === "pending_auth" &&
			authSelection.authProfile.profile_kind === "oauth_account"
    )
  ) {
    return {
      error: `Selected auth profile '${authSelection.authProfile.slug}' is ${authSelection.authProfile.status}${
				authSelection.authProfile.profile_kind === "oauth_account"
					? " — must be active or pending_auth"
					: " — must be active"
      }.`,
    };
  }

  if (authSelection?.authProfile) {
    const ownershipError = oauthAccountOwnershipError(authSelection.authProfile, ctx.userId, effectiveCreatedBy);
    if (ownershipError) return { error: ownershipError };
  }

  // Non-admin members can only bind a connection to a runtime auth profile
  // they own. `env` profiles are admin-managed org-shared credentials —
  // members must never bind to them. `oauth_account` and `browser_session`
  // profiles are member-creatable but still per-user, so a member can't
  // hijack another member's grant by passing their slug.
  if (authSelection?.authProfile && !callerIsAdmin) {
    const profile = authSelection.authProfile;
		if (profile.profile_kind === "env") {
      return {
        error:
					"Only admins can use env-credential auth profiles. Ask an admin to install this connection.",
      };
    }
    if (
			profile.profile_kind === "browser_session" &&
      profile.created_by !== ctx.userId
    ) {
      return {
        error: `Auth profile '${profile.slug}' belongs to another user. Create your own profile (action: 'create_auth_profile') and use its slug instead.`,
      };
    }
  }

	if (authSelection?.selectedKind === "oauth_account") {
    // The ACCOUNT token (oauth_account profile) is required and already
    // resolved (it's the precondition of this branch). The APP credentials
    // (client id/secret) may instead come from deployment env vars — the same
    // fallback global login uses — so auto-provision an env-backed `oauth_app`
    // profile when none was hand-created. No-op when the env vars are absent,
    // falling through to the original "create an OAuth app profile" guidance.
    if (!authSelection.appAuthProfile && authSelection.oauthMethod) {
      authSelection.appAuthProfile = await ensureEnvBackedOAuthAppProfile({
        organizationId,
        connectorKey: args.connector_key,
        connectorName: connector.name,
        method: authSelection.oauthMethod,
        createdBy: effectiveCreatedBy,
      });
    }
    if (!authSelection.appAuthProfile) {
      if (authSelection.oauthMethod) {
				const setupError = buildOAuthAppProfileSetupError({
          connectorKey: args.connector_key,
          method: authSelection.oauthMethod,
          setupUrl: await buildViewUrl(ctx, args.connector_key),
        });
				return oauthAppSetupContinuation({
					action: "create",
					connectorKey: args.connector_key,
					setup: setupError,
					resumeCall: createResumeCall,
				});
      }
      return {
        error: callerIsAdmin
					? "Select or create an OAuth app profile before creating the connection."
					: `No OAuth app credentials configured for this connector. Ask an admin to set up the ${args.connector_key} app under the connector's Setup tab (Connectors › ${args.connector_key}) first.`,
      };
    }
		if (authSelection.appAuthProfile.status !== "active") {
      return {
        error: `Selected app auth profile '${authSelection.appAuthProfile.slug}' is not active.`,
      };
    }
    // Even when the slug is omitted, non-admins can only fall through to the
    // admin-pinned default for this exact connector. The resolver may
    // otherwise return a recency-picked provider-wide row, which would let a
    // member silently use an OAuth client the admin never blessed.
    if (
      !callerIsAdmin &&
      (!authSelection.appAuthProfile.is_default_for_connector ||
        authSelection.appAuthProfile.connector_key !== args.connector_key)
    ) {
      return {
        error: `No default OAuth app configured for this connector. Ask an admin to pin a ${authSelection.oauthMethod?.provider ?? args.connector_key} app as the default under the connector's Setup tab (Connectors › ${args.connector_key}).`,
      };
    }
  }

  const displayName = await resolveConnectionDisplayName({
    explicitName: args.display_name,
    connectorName: connector.name,
    username: effectiveCreatedBy
      ? ((
					(
						await resolveUsernames(
							[{ created_by: effectiveCreatedBy }],
							"created_by",
						)
					)[0] as {
            created_by_username?: string;
          }
        )?.created_by_username ?? null)
      : null,
  });

  const visibility = await resolveConnectionVisibility(
    organizationId,
    effectiveCreatedBy,
		authSelection?.authProfile?.profile_kind,
  );
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
    };
  }

  const explicitConfig = splitConfig.connectionConfig ?? {};
  if (explicitlyNoAuth && (explicitConfig.managedBy || explicitConfig.installation_ref || explicitConfig.consent_only)) {
    return { error: 'No-auth selection cannot be combined with delegated or app-installation credentials. Create a separate connection.' };
  }

  // Managed-connector path (mirrors handleConnect): a member creating an OAuth
  // connection for a managed connector in a PUBLIC org gets a CONSENT-ONLY
  // connection — it holds the OAuth grant for cloud-delegated token fetch but
  // has no feeds, so the cloud never syncs a copy (the member's data lives only
  // on their local instance; the manage_feeds guard refuses feeds on a
  // consent_only connection). Without this, `create` (vs `connect`) would mint a
  // non-consent-only grant-holder a member could attach feeds to, breaking the
  // "data stays local" invariant.
  //
  // Deliberately NOT marked for: a `managedBy` connection (its grant lives in
  // the cloud but it SYNCS LOCALLY — consent_only and managedBy are mutually
  // exclusive), a non-OAuth method, or any non-managed / non-public-org create.
  const isManagedCreate =
    !isManagedByConnection && authSelection?.selectedKind === 'oauth_account' && authSelection.oauthMethod
      ? await isManagedPublicOrgConnect({
          organizationId,
          connectorKey: args.connector_key,
          provider: authSelection.oauthMethod.provider,
        })
      : false;
  const connectionConfigToInsert =
    isManagedCreate || splitConfig.connectionConfig
      ? {
          ...(splitConfig.connectionConfig ?? {}),
          ...(isManagedCreate ? { consent_only: true } : {}),
        }
      : null;

  // Device-bound browser auth profiles live on a specific Mac. Pin the
  // connection there automatically; reject mismatches.
  let effectiveDeviceWorkerId = deviceBinding.deviceWorkerId;
	const profileDeviceWorkerId =
		authSelection?.authProfile?.device_worker_id ?? null;
  if (profileDeviceWorkerId) {
    if (!effectiveDeviceWorkerId) {
      effectiveDeviceWorkerId = profileDeviceWorkerId;
    } else if (effectiveDeviceWorkerId !== profileDeviceWorkerId) {
      return {
        error: `Auth profile '${authSelection!.authProfile!.slug}' lives on a different device than the one selected; pick that device or a different profile.`,
      };
    }
  }
  // Inheriting the device from the profile means we need to re-check the
  // per-device duplicate-connection guard — the earlier check ran against the
  // user's explicit `deviceWorkerId` (which may have been null). Without this
  // pass we'd skip the guard for device-bound profiles and hit the partial
  // unique index `idx_connections_org_connector_device_live` as a primary
  // exception instead of a clean error.
	if (
		effectiveDeviceWorkerId &&
		effectiveDeviceWorkerId !== deviceBinding.deviceWorkerId
	) {
    const dup = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND device_worker_id = ${effectiveDeviceWorkerId}
        AND deleted_at IS NULL
      LIMIT 1
    `) as unknown as Array<{ id: number }>;
    if (dup.length > 0) {
      return {
        error: `A ${connector.name} connection (id: ${dup[0].id}) is already assigned to that device in this org.`,
      };
    }
  }
  const connectionStatus =
    interactiveMethod ||
		(authSelection?.authProfile?.profile_kind === "browser_session" &&
      !browserProfileUsable) ||
		(authSelection?.authProfile?.status === "pending_auth")
			? "pending_auth"
			: "active";

  // Reject cross-org entity_ids: a connection tagged with another org's entity
  // would surface under a non-existent in-org entity (mirrors manage_feeds).
  try {
    await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
  } catch (err) {
    return { error: getErrorMessage(err) };
  }
  const entityIdsValue =
		args.entity_ids && args.entity_ids.length > 0
			? pgBigintArray(args.entity_ids)
			: null;

  const slugResult = await resolveNewConnectionSlug({
    organizationId,
    connectorKey: args.connector_key,
    explicitSlug: args.slug,
    displayName,
  });
	if ("error" in slugResult) return { error: slugResult.error };

	const insertConnection = (
		db: DbClient,
		authProfileId: number | null,
		useSavepoint: boolean,
	) =>
		insertConnectionWithSlug({
      organizationId,
      connectorKey: args.connector_key,
      displayName,
      initialSlug: slugResult.slug,
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
          ${displayName},
          ${connectionStatus},
            ${authProfileId ?? authSelection?.authProfile?.id ?? null},
          ${authSelection?.appAuthProfile?.id ?? null},
            ${connectionConfigToInsert ? db.json(connectionConfigToInsert) : null},
          ${effectiveCreatedBy},
          ${visibility},
          ${effectiveDeviceWorkerId},
          ${entityIdsValue}::bigint[]
        )
        RETURNING *
        `;
				return useSavepoint ? db.savepoint(insert) : insert();
			},
		});

	let inserted: Record<string, unknown>[];
	let interactiveAuthRunId: number | null;
	try {
		const bundle = await createConnectionSetupBundle({
			db: sql,
			interactive: Boolean(interactiveMethod),
			organizationId,
			connectorKey: args.connector_key,
			displayName,
			createdByUserId: effectiveCreatedBy!,
			insertConnection,
		});
		inserted = bundle.rows;
		interactiveAuthRunId = bundle.authRunId;
  } catch (err) {
		if (err instanceof ConnectionSlugConflictError)
			return { error: err.message };
		if (isPersonalCredVisibilityViolation(err))
			return { error: PERSONAL_CRED_ORG_VISIBILITY_ERROR };
    throw err;
  }

	if (authSelection?.authProfile?.profile_kind === "oauth_account") {
		await syncOAuthConnectionsForAuthProfile(
			organizationId,
			authSelection.authProfile.id,
		);
  }

	if (connectionStatus === "active" && isAtlassianMcpConfig(connector.mcp_config)) {
		await registerConnectorWebhook({
			organizationId,
			connectionId: Number(inserted[0].id),
			baseUrl: getGatewayBaseUrl(ctx),
		});
		const read = await handleGet(
			{ action: "get", connection_id: Number(inserted[0].id) },
			ctx,
		);
		if (!("error" in read) && read.action === "get") {
			inserted[0] = read.connection as Record<string, unknown>;
		}
	}

  logger.info(
    {
      connection_id: inserted[0].id,
      connector_key: args.connector_key,
      status: connectionStatus,
    },
		"Connection created",
  );

  recordLifecycleEvent({
    organizationId,
		entityType: "connection",
		op: "created",
		entityId: Number(inserted[0].id),
    summary: `Connection "${displayName}" created`,
    extra: { connector_key: args.connector_key, slug: inserted[0].slug },
  });

  recordToolConfigChange(ctx, {
		resourceKind: "connection",
		resourceId: Number(inserted[0].id),
		op: "created",
    summary: `Connection '${displayName}' created`,
    state: inserted[0] as Record<string, unknown>,
  });

	if (interactiveMethod) {
		const connectionId = Number(inserted[0].id);
		return buildConnectionSetupContinuation({
			action: "create",
			connectorKey: args.connector_key,
			setupFamily: "interactive",
			nextAction: "pair_interactive",
			instructions:
				"Connection created as pending_auth. Complete the interactive pairing run, then poll the connection until it is active.",
			setupUrl: await buildViewUrl(ctx, args.connector_key),
			connectionId,
			slug: String(inserted[0].slug),
			authRunId: interactiveAuthRunId!,
			completionCheck: activeConnectionPoll(connectionId),
		});
	}

  return {
		action: "create",
    connection: enrichWithAuthProfiles(
      // `RETURNING *` echoes back the config we just inserted — including any
      // secret the caller supplied. Redact before serializing; `connector` is
      // already loaded here, so the schema pass is free.
      redactConnectionRow(inserted[0] as Record<string, unknown>, createSecretKeys),
      authSelection?.authProfile ?? null,
			authSelection?.appAuthProfile ?? null,
    ),
    connector,
    view_url: await buildViewUrl(ctx, args.connector_key),
  };
}

export async function handleApplyChatConnection(
	args: Extract<ConnectionsArgs, { action: "apply_chat_connection" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	if (hasDeviceAutowireSuppressionMarker(args.config)) {
		return { error: DEVICE_AUTOWIRE_SUPPRESSION_ERROR };
	}
	const { organizationId } = ctx;
	if (args.agent_id) {
		const sql = getDb();
		const agents = await sql`
      SELECT 1 FROM agents
      WHERE organization_id = ${organizationId} AND id = ${args.agent_id}
      LIMIT 1
    `;
		if (agents.length === 0) return { error: "Agent not found" };
	}
	try {
		const result = await upsertByoChatConnection({
			organizationId,
			platform: args.connector_key,
			stableId: args.stable_id,
			displayName: args.display_name,
			agentId: args.agent_id,
			config: args.config,
			settings: args.settings,
		});
		const read = await handleGet(
			{ action: "get", connection_id: result.connectionId },
			ctx,
		);
		if ("error" in read || read.action !== "get") return read;
		if (result.created || result.changed) {
			recordToolConfigChange(ctx, {
				resourceKind: "connection",
				resourceId: result.connectionId,
				op: result.created ? "created" : "updated",
				summary: `Connection '${args.display_name ?? args.stable_id}' ${result.created ? "created" : "updated"}`,
				state: read.connection as Record<string, unknown>,
			});
		}
		return {
			action: "apply_chat_connection",
			connection: read.connection,
			created: result.created,
			changed: result.changed,
		};
	} catch (error) {
		return { error: getErrorMessage(error) };
	}
}

// ============================================
// handleUpdate
// ============================================

export async function handleUpdate(
	args: Extract<ConnectionsArgs, { action: "update" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
  if (hasDeviceAutowireSuppressionMarker(args.config)) {
    return { error: DEVICE_AUTOWIRE_SUPPRESSION_ERROR };
  }
  const sql = getDb();
  const { organizationId } = ctx;

  // Verify ownership
  const existingRows = await sql`
    SELECT c.id, c.connector_key, c.auth_profile_id, c.app_auth_profile_id, c.created_by,
           c.config, c.credential_mode, cd.auth_schema, cd.options_schema, cd.feeds_schema,
           cd.mcp_config
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT auth_schema, options_schema, feeds_schema, mcp_config
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
  `;
  if (existingRows.length === 0) {
		return { error: "Connection not found" };
  }

  const existing = existingRows[0] as {
    id: number;
    connector_key: string;
    auth_schema: { methods?: Array<Record<string, unknown>> } | null;
    options_schema: Record<string, unknown> | null;
    feeds_schema: Record<string, unknown> | null;
    mcp_config: Record<string, unknown> | null;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    created_by: string | null;
    config: Record<string, unknown> | null;
		credential_mode: "byo" | "managed" | null;
  };

	const hasAuthProfileArg = Object.hasOwn(args, "auth_profile_slug");
	const hasAppAuthProfileArg = Object.hasOwn(args, "app_auth_profile_slug");
	const hasDeviceWorkerArg = Object.hasOwn(args, "device_worker_id");
	const hasAgentIdArg = Object.hasOwn(args, "agent_id");

  // `update` is now member-writable so members can edit their own
  // connection. Resolve the caller's role once up front and gate every
  // member action on "I created this connection" — admins/owners are
  // allowed to manage metadata. Personal credential/configuration edits are
  // checked below against the same owner-only policy as reconnect.
  const callerIsAdmin = await resolveCallerIsAdmin(sql, {
    organizationId,
    userId: ctx.userId,
  });

  if (!callerIsAdmin) {
    if (!ctx.userId || existing.created_by !== ctx.userId) {
      return {
				error: "You can only update connections you created.",
      };
    }
  }

	// Setting/clearing the fallback agent is the same class of authority as an
	// Automation subscription (manage_automations owns the authorization policy),
	// auth/tool-access.ts): it decides which agent an unbound DM/mention runs.
	// `update` itself is member-writable, so without this gate a member could
	// point their own connection's fallback at another member's agent.
	if (hasAgentIdArg && !callerIsAdmin) {
		return {
			error:
				"Only admins can set a chat connection's fallback agent (agent_id).",
		};
	}

	if (existing.credential_mode !== null) {
		// Three explicit cases — never rely on truthiness, because `""` is a
		// falsy string that Type.String() permits: (1) null CLEARS the fallback;
		// (2) a non-empty string must resolve to a real agent in this org
		// (mirrors handleApplyChatConnection); (3) an empty string is invalid —
		// without this guard `""` would skip the existence check and then be
		// treated downstream as a destructive clear.
		if (hasAgentIdArg) {
			if (args.agent_id === "") {
				return { error: "agent_id must be a non-empty agent id or null" };
			}
			if (typeof args.agent_id === "string") {
				const agents = await sql`
          SELECT 1 FROM agents
          WHERE organization_id = ${organizationId} AND id = ${args.agent_id}
          LIMIT 1
        `;
				if (agents.length === 0) return { error: "Agent not found" };
			}
		}
		try {
			await updateChatConnection({
				organizationId,
				connectionId: args.connection_id,
				displayName: args.display_name,
				// Pass the RAW incoming config. Un-redaction deliberately does NOT
				// happen here: `existing` is the UNLOCKED snapshot read at the top
				// of this handler, and restoring from it would roll back a
				// rotation another replica committed in between — the same stale
				// -restore race fixed for the non-chat path below, and it matters
				// more here because the chat connectors are the ones declaring
				// `format: "password"` bot tokens. `updateChatConnection` re-reads
				// the row under the stable-chat lock and restores from THAT.
				config: args.config,
				status: args.status,
				...(hasAgentIdArg ? { agentId: args.agent_id ?? null } : {}),
			});
			const read = await handleGet(
				{ action: "get", connection_id: args.connection_id },
				ctx,
			);
			if ("error" in read || read.action !== "get") return read;
			recordToolConfigChange(ctx, {
				resourceKind: "connection",
				resourceId: args.connection_id,
				op: "updated",
				summary: `Connection '${args.display_name ?? args.connection_id}' updated`,
				state: read.connection as Record<string, unknown>,
				changedFields: [
					...(args.display_name !== undefined ? ["display_name"] : []),
					...(args.config !== undefined ? ["config"] : []),
					...(args.status !== undefined ? ["status"] : []),
					...(hasAgentIdArg ? ["agent_id"] : []),
				],
			});
			return { action: "update", connection: read.connection };
		} catch (error) {
			return { error: getErrorMessage(error) };
		}
	}

	// Non-chat connections have no runtime that reads connections.agent_id
	// (routing consults it only as a chat fallback after channel Automations
	// miss) — reject rather than silently writing a column nothing reads.
	if (hasAgentIdArg) {
		return {
			error:
				"agent_id applies only to chat connections (it sets the chat runtime's fallback agent); this connection has no chat runtime.",
		};
	}

  // App profile updates: non-admins may only set the connector's pinned
  // default (mirrors handleCreate's gate). Clearing the app profile is
  // admin-only — otherwise a member could strip the org default off a
  // shared connection.
  if (hasAppAuthProfileArg && !callerIsAdmin &&
    (args.app_auth_profile_slug !== null || existing.app_auth_profile_id !== null)) {
    const slug = args.app_auth_profile_slug;
    if (!slug) {
			return { error: "Only admins can clear the OAuth app profile." };
    }
    const picked = await getAuthProfileBySlug(organizationId, slug);
    const pinned =
			picked?.profile_kind === "oauth_app" &&
      picked.is_default_for_connector &&
      picked.connector_key === existing.connector_key;
    if (!pinned) {
      return {
        error: `Only admins can override the OAuth app profile. Ask an admin to pin '${slug}' as the default for this connector, or omit app_auth_profile_slug to use the org default.`,
      };
    }
  }

  // Account / runtime profile target-profile ownership is enforced after
  // `authSelection` resolves the profile metadata (below). Connection
  // ownership for the rebind itself is covered by the top-level
  // member-write gate above.

  // Resolve the new device-worker binding up front so a bad value rejects the
  // whole update.
  let nextDeviceWorkerId: string | null = null;
  if (hasDeviceWorkerArg) {
    const connectorDef = await getScopedConnectorDefinition({
      organizationId,
      connectorKey: existing.connector_key,
    });
    if (!connectorDef) {
			return {
				error: `Connector '${existing.connector_key}' not found or not active`,
			};
    }
    const binding = await resolveDeviceBinding({
      organizationId,
      userId: ctx.userId,
      connector: connectorDef,
      deviceWorkerId: args.device_worker_id,
    });
		if ("error" in binding) return binding;
    nextDeviceWorkerId = binding.deviceWorkerId;
  }

  const currentAuthProfile = await getAuthProfileById(organizationId, existing.auth_profile_id);
  if (currentAuthProfile && (hasAuthProfileArg || hasAppAuthProfileArg || hasDeviceWorkerArg || args.config !== undefined)) {
    const ownershipError = oauthAccountOwnershipError(currentAuthProfile, ctx.userId, existing.created_by);
    if (ownershipError) return { error: ownershipError };
  }
  const currentAppAuthProfile = await getAuthProfileById(organizationId, existing.app_auth_profile_id);
  const explicitlyNoAuth = isExplicitNoAuthSelection({
    authSchema: existing.auth_schema,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
  });
  const retainedConfig = parseJsonObject(existing.config);
  if (explicitlyNoAuth && (retainedConfig.managedBy || retainedConfig.installation_ref || retainedConfig.consent_only)) {
    return { error: 'Delegated and app-installation connections cannot switch to no-auth. Create a separate connection.' };
  }
  const authSelection = await resolveConnectionAuthSelection({
    organizationId,
    connectorKey: existing.connector_key,
    authSchema: existing.auth_schema,
    autoSelectAuthProfile: hasAuthProfileArg,
    authProfileSlug: hasAuthProfileArg ? args.auth_profile_slug : currentAuthProfile?.slug,
    appAuthProfileSlug: hasAppAuthProfileArg ? args.app_auth_profile_slug : currentAppAuthProfile?.slug,
    deviceWorkerId: nextDeviceWorkerId,
  });

  if (args.auth_profile_slug === null && !explicitlyNoAuth &&
    (authSelection.oauthMethod || authSelection.envMethod || authSelection.browserMethod)) {
    return { error: 'This connector requires an auth profile. Select a replacement profile, or explicitly select a declared no-auth method by clearing both profile fields.' };
  }

  if (args.auth_profile_slug && !authSelection.authProfile) {
		return {
			error: `Auth profile '${args.auth_profile_slug}' not found for this connector`,
		};
  }
  if (args.app_auth_profile_slug && !authSelection.appAuthProfile) {
    return {
      error: `App auth profile '${args.app_auth_profile_slug}' not found for this connector`,
    };
  }
  // Unhealthy retained credentials must not block name or policy edits.
  // Only a new binding needs to satisfy the selection status requirements.
  if (
    hasAuthProfileArg &&
    authSelection.authProfile &&
    authSelection.authProfile.id !== existing.auth_profile_id &&
		authSelection.authProfile.profile_kind !== "browser_session" &&
		authSelection.authProfile.status !== "active" &&
		authSelection.authProfile.status !== "pending_auth"
  ) {
    return {
      error: `Auth profile '${args.auth_profile_slug}' has status '${authSelection.authProfile.status}' — must be active or pending_auth`,
    };
  }
	if (
    hasAppAuthProfileArg &&
		authSelection.appAuthProfile &&
    authSelection.appAuthProfile.id !== existing.app_auth_profile_id &&
		authSelection.appAuthProfile.status !== "active"
	) {
    return {
      error: `App auth profile '${args.app_auth_profile_slug}' has status '${authSelection.appAuthProfile.status}' — must be active`,
    };
  }

  if (hasAuthProfileArg && authSelection.authProfile) {
    const ownershipError = oauthAccountOwnershipError(authSelection.authProfile, ctx.userId, existing.created_by);
    if (ownershipError) return { error: ownershipError };
  }

  // Non-admins may only bind to a runtime profile they own. Mirrors the
  // handleCreate target-profile guard so a member who created a connection
  // can't pivot it onto another member's credentials. `env` profiles are
  // admin-managed org-shared credentials — same rule as create.
  if (hasAuthProfileArg && !callerIsAdmin && authSelection.authProfile) {
    const profile = authSelection.authProfile;
		if (profile.profile_kind === "env") {
      return {
        error:
					"Only admins can use env-credential auth profiles. Ask an admin to rebind this connection.",
      };
    }
    if (
			profile.profile_kind === "browser_session" &&
      profile.created_by !== ctx.userId
    ) {
      return {
        error: `Auth profile '${profile.slug}' belongs to another user. Create your own profile (action: 'create_auth_profile') and use its slug instead.`,
      };
    }
  }

  const nextAuthProfileId = hasAuthProfileArg
    ? (authSelection.authProfile?.id ?? null)
    : existing.auth_profile_id;
  // Re-pointing a connection onto a PERSONAL credential (oauth_account) must
  // floor its visibility to 'private' — otherwise an existing 'org' connection
  // rebound onto a user's own Gmail would expose that inbox org-wide through the
  // owner's token. Downgrade-only: we never widen here (the CASE keeps the
  // current visibility when the new profile is not personal).
  const rebindToPersonalCred =
		hasAuthProfileArg &&
		isPersonalCredentialKind(authSelection.authProfile?.profile_kind);
  const nextAppAuthProfileId = hasAppAuthProfileArg
    ? (authSelection.appAuthProfile?.id ?? null)
    : existing.app_auth_profile_id;
  const effectiveSelectedAuthProfile = hasAuthProfileArg
    ? authSelection.authProfile
    : currentAuthProfile;

  // Device-bound browser profile auto-pins the connection's device.
	const updateProfileDeviceWorkerId =
		effectiveSelectedAuthProfile?.device_worker_id ?? null;
  if (updateProfileDeviceWorkerId) {
    if (!hasDeviceWorkerArg) {
      // Caller didn't touch device pin — adopt the profile's device.
      nextDeviceWorkerId = updateProfileDeviceWorkerId;
		} else if (
			nextDeviceWorkerId &&
			nextDeviceWorkerId !== updateProfileDeviceWorkerId
		) {
      return {
        error: `Auth profile '${effectiveSelectedAuthProfile!.slug}' lives on a different device than the one selected; pick that device or a different profile.`,
      };
    } else if (!nextDeviceWorkerId) {
      nextDeviceWorkerId = updateProfileDeviceWorkerId;
    }
  }
  const browserProfileUsable =
		effectiveSelectedAuthProfile?.profile_kind === "browser_session"
      ? (
          await getBrowserSessionReadiness(
            effectiveSelectedAuthProfile.auth_data,
						existing.connector_key,
          )
        ).usable
      : false;
  const effectiveStatus =
    args.status ??
		(effectiveSelectedAuthProfile?.profile_kind === "browser_session"
      ? browserProfileUsable
					? "active"
					: "pending_auth"
      : null);
  // Un-redact BEFORE anything reads the incoming config. Clients round-trip
  // what the (now redacted) read path gave them — the Owletto action-modes
  // editor spreads `connection.config` and PATCHes it straight back — so a
  // `__LOBU_REDACTED__` here means "unchanged", not "set the literal
  // placeholder". Without this the update would overwrite the live credential
  // with the sentinel: silent data loss, worse than the leak it came from.
  //
  // Placed ahead of splitConfigByFeedScope so the feed-scope split, the
  // consent_only computation, the merge and the replace all see real values.
  const incomingConfigForWrite =
    args.config === undefined
      ? undefined
      : (restoreRedactedConfig(
          args.config,
          parseJsonObject(existing.config),
        ) as Record<string, unknown>);

  const splitConfig = splitConfigByFeedScope(
    incomingConfigForWrite ?? null,
		(existing.feeds_schema as Record<string, FeedDefinition>) ?? null,
  );

  if (splitConfig.feedConfig) {
    return {
      error:
        'Feed-scoped config belongs on feeds. Use client.feeds.update({ feed_id, config }) for sync target settings.',
    };
  }

  // Config write mode: declarative `lobu apply` passes `replace_config: true`
  // so a removed manifest key actually disappears remotely. Default (merge)
  // is preserved for the web UI / partial updates.
	const replaceConfig =
		args.replace_config === true && args.config !== undefined;
  const connectionConfigForReplace = splitConfig.connectionConfig ?? {};

  // Consent-only is enforced BIDIRECTIONALLY: the feed-creation guard stops a
  // consent-only connection from gaining feeds, and this stops a feed-having
  // connection from becoming consent-only. Compute the consent_only flag the
  // UPDATE below would land on — replace = exactly the new config; merge =
  // existing config overlaid with the incoming keys — and reject the flip when
  // the connection still has feeds, so the "data stays local" invariant holds.
  const existingConfig = parseJsonObject(existing.config);
  const resultingConfig = replaceConfig
    ? connectionConfigForReplace
    : splitConfig.connectionConfig
      ? { ...existingConfig, ...splitConfig.connectionConfig }
      : existingConfig;
	if (
		!callerIsAdmin &&
		isAtlassianMcpConfig(existing.mcp_config) &&
		JIRA_WEBHOOK_CREDENTIAL_KEYS.some(
			(key) => resultingConfig[key] !== existingConfig[key],
		)
	) {
		return { error: JIRA_WEBHOOK_ADMIN_ONLY_ERROR };
	}
	const willBeConsentOnly =
		parseJsonObject(resultingConfig).consent_only === true;
  if (willBeConsentOnly && existingConfig.consent_only !== true) {
    const feedRows = await sql`
      SELECT 1 FROM feeds
      WHERE connection_id = ${args.connection_id}
        AND organization_id = ${organizationId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (feedRows.length > 0) {
      return {
        error:
					"This connection has feeds; a consent-only connection cannot have feeds. Remove its feeds first.",
      };
    }
  }
  // Reverse direction: a consent-only grant-holder (the cloud OAuth grant behind
  // a managed connector) must STAY consent-only. Stripping the flag would let
  // feeds be added, so the cloud would start syncing the grant-holder's data —
  // breaking the "data stays local" invariant. Reject the removal.
  if (existingConfig.consent_only === true && !willBeConsentOnly) {
    return {
      error:
				"This connection is consent-only (holds an OAuth grant for delegation); the consent-only flag cannot be removed.",
    };
  }

  // Reject cross-org entity_ids on update too (skip when clearing to []).
  if (args.entity_ids !== undefined && args.entity_ids.length > 0) {
    try {
      await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }
  // Tri-state, mirrors manage_feeds: undefined = leave unchanged (null → COALESCE
  // keeps existing), explicit [] = clear ('{}' → COALESCE picks the empty array).
  const entityIdsValue =
    args.entity_ids !== undefined
      ? args.entity_ids.length > 0
        ? pgBigintArray(args.entity_ids)
				: "{}"
      : null;

  // Slug is only ever changed when the caller passes one explicitly — a
  // display_name change never touches it (that's the whole point of a stable
  // identity for `lobu apply`). An explicit slug is validated for format and
  // rejected on collision (never auto-suffixed).
  let nextSlug: string | null = null;
  const updateExplicitSlug = args.slug?.trim();
  if (updateExplicitSlug) {
    const fmtErr = connectionSlugFormatError(updateExplicitSlug);
    if (fmtErr) return { error: fmtErr };
    if (
      await connectionSlugTaken({
        organizationId,
        slug: updateExplicitSlug,
        excludeId: args.connection_id,
      })
    ) {
			return {
				error: `Connection slug '${updateExplicitSlug}' already exists for this organization.`,
			};
    }
    nextSlug = updateExplicitSlug;
  }

	// Same pre-flight the create path runs (see the duplicate check above):
	// `idx_connections_org_connector_device_live` is UNIQUE on
	// (organization_id, connector_key, device_worker_id) for live rows, so
	// re-pointing this connection at a device another live connection already
	// holds hits the index as a raw 23505 instead of a readable error. Only
	// the create path was guarded; the update path was not.
	if (nextDeviceWorkerId) {
		const pinDup = (await sql`
        SELECT id FROM connections
        WHERE organization_id = ${organizationId}
          AND connector_key = ${existing.connector_key}
          AND device_worker_id = ${nextDeviceWorkerId}
          AND deleted_at IS NULL
          AND id <> ${args.connection_id}
        LIMIT 1
      `) as unknown as Array<{ id: number }>;
		if (pinDup.length > 0) {
			return {
				error: `A ${existing.connector_key} connection (id: ${pinDup[0].id}) is already assigned to that device in this org.`,
			};
		}
	}

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape
  let updated: any[];
  try {
    // Row-locked restore→write. The `existing` snapshot at the top of this
    // handler is read WITHOUT a lock, and many awaits (auth-profile lookups,
    // device binding, feed checks) happen between it and this write — so
    // restoring sentinels from that snapshot could roll back a rotation another
    // replica committed in the meantime: A reads, B rotates the secret, A's
    // restore fills the sentinel from its STALE copy and writes the OLD
    // plaintext back over B's new value. Silent credential rollback, invisible
    // through the API because the response is redacted either way.
    //
    // Re-reading the config FOR UPDATE inside the same transaction as the
    // UPDATE makes the restore source the row the write is actually based on.
    // Mirrors the shape manage_feeds already uses for handleUpdateFeed.
    const updateOutcome = await sql.begin(async (tx) => {
      const lockedRows = await tx`
        SELECT config, app_auth_profile_id
        FROM connections
        WHERE id = ${args.connection_id}
          AND organization_id = ${organizationId}
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (lockedRows.length === 0) return { rows: [] };
      if (hasAppAuthProfileArg && !callerIsAdmin && args.app_auth_profile_slug === null && lockedRows[0].app_auth_profile_id !== null) {
        return { denial: { error: 'Only admins can clear the OAuth app profile.' } };
      }
      const lockedConfig = parseJsonObject(
        (lockedRows[0] as { config: unknown }).config,
      );

      // Recompute the incoming config against the LOCKED row. Only the restore
      // depends on stored values, so this is the sole recomputation needed —
      // the merge itself is already atomic (`config || <incoming>` below reads
      // the live row).
      const lockedSplit =
        args.config === undefined
          ? null
          : splitConfigByFeedScope(
              restoreRedactedConfig(args.config, lockedConfig) as Record<
                string,
                unknown
              >,
              (existing.feeds_schema as Record<string, FeedDefinition>) ?? null,
            );
      const lockedConnectionConfig = lockedSplit?.connectionConfig ?? null;
      const lockedReplaceConfig = lockedConnectionConfig ?? {};

      // Compare against the locked row so a stale agent round-trip cannot
      // overwrite a concurrent human edit. This mirrors the shallow SQL merge.
      const lockedResultingConfig = replaceConfig
        ? lockedReplaceConfig
        : lockedConnectionConfig
          ? { ...lockedConfig, ...lockedConnectionConfig }
          : lockedConfig;
      if (explicitlyNoAuth && (lockedResultingConfig.managedBy || lockedResultingConfig.installation_ref || lockedResultingConfig.consent_only)) {
        return { denial: { error: 'No-auth selection cannot retain delegated or app-installation credentials. Create a separate connection.' } };
      }
      if (actionModesChanged(lockedConfig, lockedResultingConfig)) {
        const denied = denyNonHumanActionModesWrite(ctx);
        if (denied) return { denial: denied };
      }

      const rows = await tx`
        UPDATE connections
        SET display_name = COALESCE(${args.display_name ?? null}, display_name),
            slug = COALESCE(${nextSlug}, slug),
            status = CASE WHEN ${explicitlyNoAuth} AND ${args.status === undefined}
              AND (status = 'pending_auth' OR (status = 'revoked' AND error_message = ${CONNECT_TOKEN_EXPIRED_ERROR}))
              THEN 'active' ELSE COALESCE(${effectiveStatus}, status) END,
            auth_profile_id = ${nextAuthProfileId},
            app_auth_profile_id = ${nextAppAuthProfileId},
            account_id = CASE WHEN ${explicitlyNoAuth} THEN NULL ELSE account_id END,
            error_message = CASE WHEN ${explicitlyNoAuth}
              AND (status = 'pending_auth' OR (status = 'revoked' AND error_message = ${CONNECT_TOKEN_EXPIRED_ERROR}))
              THEN NULL ELSE error_message END,
            visibility = CASE WHEN ${rebindToPersonalCred} THEN 'private' ELSE visibility END,
            entity_ids = COALESCE(${entityIdsValue}::bigint[], entity_ids),
            config = ${
              replaceConfig
                ? tx`${tx.json(lockedReplaceConfig)}::jsonb`
                : tx`CASE WHEN ${lockedConnectionConfig ? tx.json(lockedConnectionConfig) : null}::jsonb IS NOT NULL THEN COALESCE(config, '{}'::jsonb) || ${lockedConnectionConfig ? tx.json(lockedConnectionConfig) : null}::jsonb ELSE config END`
            },
            updated_at = NOW()
        WHERE id = ${args.connection_id} AND organization_id = ${organizationId} AND deleted_at IS NULL
        RETURNING *
      `;
      if (explicitlyNoAuth && rows[0]?.status === 'active') {
        const feedsSchema = existing.feeds_schema as Record<string, FeedDefinition> | null;
        const syncKeys = Object.keys(feedsSchema ?? {}).filter(key => feedOperations(feedsSchema, key).includes('sync'));
        // Only OAuth's own pause marker is resumable; unmarked manual pauses stay put.
        await tx`
          UPDATE feeds SET status = 'active', last_error = NULL,
            next_run_at = CASE WHEN schedule IS NOT NULL AND feed_key = ANY(${pgTextArray(syncKeys)}::text[])
              THEN COALESCE(next_run_at, NOW()) ELSE NULL END,
            updated_at = NOW()
          WHERE organization_id = ${organizationId} AND connection_id = ${args.connection_id}
            AND deleted_at IS NULL AND status IN ('active', 'paused')
            AND last_error = ${OAUTH_SCOPE_PAUSE_LAST_ERROR}
        `;
      }
      // The device pin writes in THIS transaction, not after it. The pre-flight
      // above is an unlocked SELECT, so two replicas can both see the device as
      // free and race into `idx_connections_org_connector_device_live`; the
      // loser's violation must abort the general update too, or a combined
      // request reports failure while persisting the display_name/config/auth
      // changes it claims to have rejected.
      if (
        hasDeviceWorkerArg ||
        (updateProfileDeviceWorkerId && !hasDeviceWorkerArg)
      ) {
        await tx`
          UPDATE connections
          SET device_worker_id = ${nextDeviceWorkerId},
              error_message = CASE
                WHEN error_message = ANY(${pgTextArray([...DEVICE_PIN_TOMBSTONE_MESSAGES])}::text[])
                THEN NULL
                ELSE error_message
              END,
              status = CASE
                WHEN ${nextDeviceWorkerId != null}
                 AND status = 'paused'
                 AND error_message = ANY(${pgTextArray([...DEVICE_PIN_TOMBSTONE_MESSAGES])}::text[])
                THEN 'active'
                ELSE status
              END,
              updated_at = NOW()
          WHERE id = ${args.connection_id}
            AND organization_id = ${organizationId}
            AND deleted_at IS NULL
        `;
      }
      return { rows };
    });
    if ("denial" in updateOutcome && updateOutcome.denial) {
      return updateOutcome.denial;
    }
    updated = updateOutcome.rows;
    if (updated.length === 0) return { error: "Connection not found" };
  } catch (err) {
    if (isConnectionSlugUniqueViolation(err) && updateExplicitSlug) {
			return {
				error: `Connection slug '${updateExplicitSlug}' already exists for this organization.`,
			};
    }
		if (isPersonalCredVisibilityViolation(err))
			return { error: PERSONAL_CRED_ORG_VISIBILITY_ERROR };
		// A replica won the device between our pre-flight and this write. The
		// transaction aborted, so nothing was persisted — report the same readable
		// collision the pre-flight would have.
		if (isConnectionDevicePinUniqueViolation(err)) {
			const winner = (await sql`
        SELECT id FROM connections
        WHERE organization_id = ${organizationId}
          AND connector_key = ${existing.connector_key}
          AND device_worker_id = ${nextDeviceWorkerId}
          AND deleted_at IS NULL
        LIMIT 1
      `) as unknown as Array<{ id: number }>;
			return {
				error: winner[0]
					? `A ${existing.connector_key} connection (id: ${winner[0].id}) is already assigned to that device in this org.`
					: `That device is already assigned to another ${existing.connector_key} connection in this org.`,
			};
		}
    throw err;
  }

	let clearedDeviceTombstone = false;
	if (
		hasDeviceWorkerArg ||
		(updateProfileDeviceWorkerId && !hasDeviceWorkerArg)
	) {
		// Any change to the pin (set or clear) drops DELETE/move tombstones.
		// Re-pinning a live device also un-pauses so the connection can run again.
		const previousError = (updated[0] as Record<string, unknown>)
			.error_message as string | null;
		const pinningDevice = nextDeviceWorkerId != null;
		clearedDeviceTombstone = isDevicePinTombstone(previousError);
		(updated[0] as Record<string, unknown>).device_worker_id =
			nextDeviceWorkerId;
		if (clearedDeviceTombstone) {
			(updated[0] as Record<string, unknown>).error_message = null;
			if (
				pinningDevice &&
				(updated[0] as Record<string, unknown>).status === "paused"
			) {
				(updated[0] as Record<string, unknown>).status = "active";
			}
		}
  }

  const updatedConnection = updated[0] as {
    id: number;
    status: string;
  };

  // Metadata edits and credential detachment must preserve operator-paused feeds.
  if (args.status !== undefined || (!explicitlyNoAuth && effectiveStatus !== null)) {
    await sql`
    UPDATE feeds
    SET status = ${mapConnectionStatusToFeedStatus(updatedConnection.status)},
        next_run_at = CASE
          WHEN ${mapConnectionStatusToFeedStatus(updatedConnection.status)} = 'active'
            THEN COALESCE(next_run_at, NOW())
          ELSE next_run_at
        END,
        updated_at = NOW()
    WHERE connection_id = ${updatedConnection.id}
  `;
  }

	const effectiveAuth = hasAuthProfileArg
		? authSelection.authProfile
		: currentAuthProfile;
  const effectiveAppAuth = hasAppAuthProfileArg
    ? authSelection.appAuthProfile
    : currentAppAuthProfile;

  // Stored scopes are not fresh consent: retaining a failed account must not
  // mark it active again just because its name or policy was edited.
  if (
    effectiveAuth?.profile_kind === "oauth_account" &&
    (nextAuthProfileId !== existing.auth_profile_id || args.status !== undefined) &&
    (effectiveAuth.status === "active" || effectiveAuth.status === "pending_auth")
  ) {
    await syncOAuthConnectionsForAuthProfile(organizationId, effectiveAuth.id);
  }

	if (
		(args.config !== undefined || args.status !== undefined) &&
		isAtlassianMcpConfig(existing.mcp_config)
	) {
		try {
			await registerConnectorWebhook({
				organizationId,
				connectionId: args.connection_id,
				baseUrl: getGatewayBaseUrl(ctx),
				throwOnError: true,
			});
		} catch (error) {
			return { error: getErrorMessage(error) };
		}
	}

  const updatedRow = updated[0] as Record<string, unknown>;
  const changedFields = [
    ...(args.display_name !== undefined ? ["display_name"] : []),
    ...(updateExplicitSlug ? ["slug"] : []),
    ...(args.status !== undefined ? ["status"] : []),
    ...(hasAuthProfileArg ? ["auth_profile_id"] : []),
    ...(hasAppAuthProfileArg ? ["app_auth_profile_id"] : []),
    ...(hasDeviceWorkerArg ? ["device_worker_id"] : []),
    ...(clearedDeviceTombstone ? ["error_message"] : []),
    ...(args.entity_ids !== undefined ? ["entity_ids"] : []),
    ...(args.config !== undefined ? ["config"] : []),
  ];
  recordToolConfigChange(ctx, {
    resourceKind: "connection",
    resourceId: args.connection_id,
    op: "updated",
    summary: `Connection '${updatedRow.display_name ?? updatedRow.slug ?? args.connection_id}' updated`,
    state: updatedRow,
    ...(changedFields.length > 0 ? { changedFields } : {}),
  });

	if (args.config !== undefined || args.status !== undefined) {
		const read = await handleGet(
			{ action: "get", connection_id: args.connection_id },
			ctx,
		);
		if (!("error" in read) && read.action === "get") {
			return { action: "update", connection: read.connection };
		}
	}

  return {
		action: "update",
    connection: enrichWithAuthProfiles(
      // `RETURNING *` echoes the merged config back — redact before it is
      // serialized. Schemas came from the `existing` lookup at the top.
      redactConnectionRow(
        updated[0] as Record<string, unknown>,
        connectorSecretKeysFromSchemas({
          optionsSchema: existing.options_schema,
          authSchema: existing.auth_schema,
        }),
      ),
      effectiveAuth ?? null,
			effectiveAppAuth ?? null,
    ),
  };
}

// ============================================
// handleDelete
// ============================================

export async function handleDelete(
	args: Extract<ConnectionsArgs, { action: "delete" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;
	const targets = await sql`
		SELECT c.credential_mode, c.connector_key, c.auth_profile_id, c.app_auth_profile_id,
			NULLIF((o.metadata::jsonb)->>'personal_org_for_user_id', '') AS autowire_user_id,
			${sql.unsafe(IS_DEVICE_CONNECTOR_SQL)} AS is_device_connector
		FROM connections c
		JOIN "organization" o ON o.id = c.organization_id
		WHERE c.id = ${args.connection_id}
			AND c.organization_id = ${organizationId}
			AND c.deleted_at IS NULL
		LIMIT 1
	`;
	if (targets.length === 0) {
		return { error: "Connection not found or already deleted" };
	}
	const target = targets[0] as DeviceAutowireIdentityRow & {
		credential_mode: string | null;
		connector_key: string;
	};
	const isAutoWiredDeviceConnection = isDeviceAutowireIdentity(target);

  // Expire any undecided approval runs for this connection. Deleting a
  // connection makes its pending approvals unreviewable — the card disappears
  // from every content read (connection-visibility predicate), so approve/reject
  // would be blind. Same terminal state as the pending-approval TTL sweep
  // (scheduled/expire-pending-approvals): approval_status='expired',
  // status='cancelled'.
  const approvalExpiryReason =
    'Connection deleted before approval; approval expired.';
  const expirePendingApprovalsBeforeDelete = async (
    db: DbClient
	): Promise<number[]> => {
    // The whole batch shares one transaction. If any append-only card cannot
    // advance, every run stays pending and the caller must leave the connection
    // visible so a reviewer can still act on those cards.
    const pendingApprovals = await db<{
      id: number;
      action_key: string | null;
    }>`
      SELECT id, action_key
      FROM runs
      WHERE organization_id = ${organizationId}
        AND connection_id = ${args.connection_id}
        AND approval_status = 'pending'
        AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
      ORDER BY id
      FOR UPDATE
    `;
		const expiredRunIds: number[] = [];
    for (const pendingApproval of pendingApprovals) {
      const expired = await db<{ action_key: string | null }>`
          UPDATE runs
          SET approval_status = 'expired',
              status = 'cancelled',
              error_message = ${approvalExpiryReason},
              completed_at = NOW()
          WHERE id = ${pendingApproval.id}
            AND organization_id = ${organizationId}
            AND connection_id = ${args.connection_id}
            AND approval_status = 'pending'
            AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
          RETURNING action_key
        `;
      if (expired.length === 0) continue;

      const actionKey = expired[0].action_key ?? 'Action';
      const eventId = await supersedeActionEvent(
        pendingApproval.id,
        organizationId,
        'rejected',
        `${actionKey} — expired`,
        approvalExpiryReason,
        {
          expiry_reason: approvalExpiryReason,
          approval_status: 'expired',
        },
        null,
        db
      );
      if (eventId === undefined) {
        throw new Error(
          `Cannot expire approval run ${pendingApproval.id}: its approval card is missing`
        );
      }
			expiredRunIds.push(pendingApproval.id);
    }
		return expiredRunIds;
  };

  const performDelete = async (): Promise<ManageConnectionsResult> => {
  // Phase 1: fallible EXTERNAL teardown runs FIRST, while the connection is
  // still visible with its approvals pending. A teardown failure (e.g. the chat
  // platform rejects the removal) returns an error BEFORE any approval is
  // expired — the connection stays live and its approvals stay reviewable, so a
  // reviewer can still decide or the user can retry the delete. The chat
  // teardown is told NOT to tombstone the `connections` row: it only purges the
  // external/platform artifacts (install, secrets, history, claims). The
  // durable tombstone lands in Phase 2 with every pending run/card transition,
  // so a teardown success followed by a DB failure leaves the connection
  // visible and its approvals pending (a safe retry re-runs the idempotent
  // teardown, then the atomic phase).
  if (target.credential_mode !== null) {
    try {
      await deleteChatConnection(organizationId, args.connection_id, {
        skipConnectionTombstone: true,
      });
    } catch (error) {
      return { error: getErrorMessage(error) };
    }
  } else {
		try {
			await unregisterConnectorWebhook({
				organizationId,
				connectionId: args.connection_id,
				throwOnError: true,
				baseUrl: getGatewayBaseUrl(ctx),
			});
		} catch (error) {
			return { error: getErrorMessage(error) };
		}
  }

  // Phase 2 (atomic): the durable connection tombstone, every pending run/card
  // transition, and the active-run cancellation commit together. The tombstone
  // UPDATE below takes FOR UPDATE on the connection row, which serializes
  // against approval QUEUEING: the execute path takes FOR SHARE on the same row,
  // so no pending approval can be inserted between this expiry scan and the
  // tombstone commit.
  const deleted = await sql.begin(async (tx) => {
    // Match organization deletion's parent -> child lock order before taking
    // the connection row lock below.
    await lockOrganizationForRelationshipClaims(tx, organizationId);
    const tombstoned = await tx`
      UPDATE connections
      SET deleted_at = NOW(),
          status = 'paused',
          config = CASE
            WHEN ${isAutoWiredDeviceConnection}
              THEN COALESCE(config, '{}'::jsonb) || ${sql.json(DEVICE_AUTOWIRE_SUPPRESSION_PATCH)}::jsonb
            ELSE config
          END,
          updated_at = NOW()
      WHERE id = ${args.connection_id}
        AND organization_id = ${organizationId}
        AND deleted_at IS NULL
      RETURNING id, slug, display_name, connector_key
    `;
    if (tombstoned.length === 0) return null; // concurrently deleted

		await retractConnectionRelationshipClaims(tx, {
			organizationId,
			connectionId: args.connection_id,
		});

		const expiredApprovalRunIds = await expirePendingApprovalsBeforeDelete(tx);

    // Pause the connection's existing feeds in the same atomic lifecycle
    // transition. Keep each schedule as historical configuration, but clear its
    // queued occurrence so the retained rows no longer look runnable.
    await tx`
      UPDATE feeds
      SET status = 'paused', next_run_at = NULL, updated_at = NOW()
      WHERE connection_id = ${args.connection_id}
        AND organization_id = ${organizationId}
        AND deleted_at IS NULL
        AND (status <> 'paused' OR next_run_at IS NOT NULL)
    `;

    // Cancel runs that are active at this point in the same atomic commit.
    await tx`
      UPDATE runs SET status = 'cancelled', completed_at = NOW()
      WHERE feed_id IN (SELECT id FROM feeds WHERE connection_id = ${args.connection_id})
        AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    `;

    await deleteConnectionAclRow(tx, {
      organizationId,
      connectionId: args.connection_id,
    });

		return { tombstoned, expiredApprovalRunIds };
  });
  if (deleted === null) {
    return { error: "Connection not found or already deleted" };
  }

	queueApprovalNotificationCardRefresh(
		organizationId,
		deleted.expiredApprovalRunIds,
	);
	const conn = deleted.tombstoned[0];
  const affectedFeeds = await sql`
    SELECT DISTINCT unnest(entity_ids) AS entity_id
    FROM feeds
    WHERE connection_id = ${args.connection_id}
      AND entity_ids IS NOT NULL
      AND deleted_at IS NULL
  `;
  const entityIds = affectedFeeds
    .map((row: { entity_id: number | string | null }) => Number(row.entity_id))
    .filter((value) => Number.isFinite(value));
	const connName =
		conn.display_name || conn.connector_key || args.connection_id;
	// Record change event in knowledge for audit trail
  recordChangeEvent({
    entityIds: entityIds.map(Number),
    organizationId,
    subject: 'connection',
    op: 'deleted',
    title: `Connection deleted: ${connName}`,
    content: `Connection "${connName}" (id: ${args.connection_id}, connector: ${conn.connector_key}) was deleted.`,
    metadata: {
			action: "connection_deleted",
      connection_id: args.connection_id,
      connector_key: conn.connector_key,
      slug: conn.slug,
      display_name: conn.display_name,
    },
  });
  recordLifecycleEvent({
    organizationId,
		entityType: "connection",
		op: "deleted",
    entityId: args.connection_id,
    summary: `Connection "${connName}" deleted`,
    extra: { connector_key: conn.connector_key, slug: conn.slug },
  });

  recordToolConfigChange(ctx, {
		resourceKind: "connection",
    resourceId: args.connection_id,
		op: "deleted",
    summary: `Connection '${connName}' deleted`,
    state: null,
  });

  return {
		action: "delete",
    deleted: true,
    connection_id: args.connection_id,
    slug: conn.slug as string,
  };
  };

  if (!isAutoWiredDeviceConnection) return performDelete();

  // Same `lobu:autowire` key `ensureDeviceConnectorWired` takes per
  // (owner, connector). Held across the teardown phase AND the atomic tombstone
  // so a concurrent reconcile cannot wire a replacement in the gap between
  // them. Cheap to hold on this path: an auto-wired device connection has
  // `credential_mode` NULL and no `webhook_external_id`, so the teardown phase
  // early-returns after DB-local checks and never blocks on a provider call.
  return withSessionAdvisoryLock(
    {
      namespace: 'lobu:autowire',
      value: `${target.autowire_user_id}:${target.connector_key}`,
      hashValue: true,
    },
    performDelete
  );
}
