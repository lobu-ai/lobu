/**
 * Tool: manage_feeds
 *
 * Manage data sync feeds for connections.
 *
 * Actions:
 * - list_feeds: List feeds with optional filters
 * - read_feed: Read metadata + recent sync runs without touching the source.
 * - read_feeds: Explicitly query several source-backed feeds in parallel.
 * - create_feed: Create a new feed for a connection
 * - update_feed: Update feed settings
 * - delete_feed: Delete a feed
 * - trigger_feed: Trigger an immediate sync for a feed
 */

import {
  getErrorMessage,
  isRetryable,
  parseJsonObject,
  type ToolErrorCode,
} from '@lobu/core';
import {
  CreateFeedAction,
  DeleteFeedAction,
  ListFeedsAction,
  type ManageFeedsResult,
  ManageFeedsResultSchema,
  ManageFeedsSchema,
  ReadFeedAction,
  ReadFeedsAction,
  TriggerFeedAction,
  UpdateFeedAction,
} from '@lobu/core/contracts/tools/manage-feeds';
import type { Static } from '@sinclair/typebox';
import {
  feedLinkedEntityIdsSql,
  feedLinkedToBusinessEntitySql,
} from '../../authz/channel-about';
import { compileConnectionRowVisibility } from '../../authz/connection-visibility';
import { readSourceFeedPage, SourceCursorError } from '../../lib/source-feed-page';
import { authzScopeFromToolContext } from '../../authz/scope';
import { reconcileAtlassianMcpJiraSite } from '../../connect/atlassian-mcp-site';
import { deriveFeedHealthSemantics, feedWebhookDrivenSql } from '../../connectors/feed-health-semantics';
import { getDb, pgBigintArray } from '../../db/client';
import type { Env } from '../../index';
import {
  classifyPushdownFailure,
} from '../../lib/connector-pushdown';
import {
  ATLASSIAN_JIRA_ISSUES_FEED_KEY,
  isAtlassianMcpConfig,
  normalizeMcpProxyConfig,
} from '../../operations/atlassian-mcp-feed';
import { createSyncRun, describeSyncRunSkip } from '../../runs/queue-service';
import { getAuthProfileById } from '../../utils/auth-profiles';
import {
  type ConnectorSecretKeys,
  feedSecretKeyLookup,
  feedSecretKeysFromSchema,
  loadFeedSecretKeys,
  redactConnectionConfig,
  restoreRedactedConfig,
} from '../../utils/connection-config-redaction';
import {
  isChromeNamespaceConnectorKey,
  selectedConnectorVersionArtifactSql,
} from '../../utils/connector-execution-placement';
import {
  nextRunAt,
  validateSchedule,
  validateTimezone,
} from '../../utils/cron';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../../utils/device-liveness';
import { recordChangeEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import {
  OAUTH_SCOPE_PAUSE_LAST_ERROR,
  syncOAuthConnectionsForAuthProfile,
} from '../../utils/oauth-connection-state';
import {
  ACTIVE_RUN_STATUSES,
  runStatusLiteral,
} from '../../utils/run-statuses';
import {
  describeDeviceConnectorSetupRequired,
  findDeviceConnectorReadiness,
  loadDeviceConnectorReadiness,
} from '../../worker-api/device-connector-readiness';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';
import { recordToolConfigChange } from './helpers/config-audit';
import { assertEntityIdsInOrg, callerIsAdmin } from './helpers/db-helpers';
import {
  type FeedDefinition,
  feedOperations,
  resolveFeedDisplayName,
  validateFeedConfig,
} from './helpers/feed-helpers';

/** Feed columns safe to expose through the management API. Keep this explicit:
 * sync cursors and retired/internal physical columns must never leak through a
 * future `feeds` table addition. */
const PUBLIC_FEED_COLUMNS = [
  'id',
  'organization_id',
  'connection_id',
  'feed_key',
  'display_name',
  'status',
  'entity_ids',
  'config',
  'last_sync_at',
  'last_sync_status',
  'last_error',
  'consecutive_failures',
  'items_collected',
  'created_at',
  'updated_at',
  'pinned_version',
  'deleted_at',
  'schedule',
  'timezone',
  'next_run_at',
  'first_failure_at',
] as const;

function publicFeedColumnList(alias?: string): string {
  return PUBLIC_FEED_COLUMNS.map((column) =>
    alias ? `${alias}.${column}` : column,
  ).join(', ');
}

/**
 * Sanitize a public feed projection before it is serialized to a caller.
 * `config` is free-form jsonb, written verbatim. It is redacted on two layers, the
 *    same as connection config: the connector's own
 *    `feeds_schema[feed_key].configSchema` `format: "password"` declarations
 *    (exact), then the shared keyname/URI walk (backstop). `configSchema` is
 *    an unconstrained `Record<string, unknown>`, so a CUSTOM connector may
 *    declare a feed-scoped credential under any name — no shipped connector
 *    does today (all 27 audited, zero hits), which makes the declared layer
 *    latent rather than live, but custom definitions are a supported feature
 *    and the contract must not exempt a declaration site.
 *
 * Every metadata-returning action uses this projection, at the same exposure
 * tier as the connection list/get paths.
 */
function toPublicFeed<T extends Record<string, unknown>>(
  row: T,
  declaredSecretKeys?: ConnectorSecretKeys,
): T & { store: 'events' | 'channel_messages' } {
  const store =
    parseJsonObject(row.config).store === 'channel_messages'
      ? 'channel_messages'
      : 'events';
  if (!('config' in row)) return { ...row, store };
  return {
    ...row,
    store,
    config: redactConnectionConfig(row.config, declaredSecretKeys),
  };
}

/**
 * Batch form: sanitize a page of feed rows, resolving each one's
 * connector-declared secret keys from its own `connector_key` + `feed_key`.
 * One definition query for the whole page — a per-row lookup would reintroduce
 * an N+1 on the list path.
 */
async function toPublicFeeds<T extends Record<string, unknown>>(
  organizationId: string,
  rows: T[],
): Promise<Array<T & { store: 'events' | 'channel_messages' }>> {
  if (rows.length === 0) return [];
  const secretKeys = await loadFeedSecretKeys(organizationId, rows);
  return rows.map((row) =>
    toPublicFeed(row, secretKeys.get(feedSecretKeyLookup(row))),
  );
}

// ============================================
// Main Function (Action Router)
// ============================================

const manageFeedsTool = defineActionTool('manage_feeds', {
  list_feeds: action(ListFeedsAction, handleListFeeds),
  read_feed: action(ReadFeedAction, handleReadFeed),
  read_feeds: action(ReadFeedsAction, handleReadFeeds),
  create_feed: action(CreateFeedAction, handleCreateFeed),
  update_feed: action(UpdateFeedAction, handleUpdateFeed),
  delete_feed: action(DeleteFeedAction, handleDeleteFeed),
  trigger_feed: action(TriggerFeedAction, handleTriggerFeed),
});

export { ManageFeedsResultSchema, ManageFeedsSchema };
export const manageFeeds = manageFeedsTool.run;

const DEFAULT_BATCH_READ_TIMEOUT_MS = 10_000;
const MAX_BATCH_READ_TIMEOUT_MS = 30_000;

// ============================================
// Action Handlers
// ============================================

async function handleListFeeds(
  args: Static<typeof ListFeedsAction>,
  ctx: ToolContext,
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // Build the filtered "page" of feeds first, then compute event_count in a
  // single GROUP BY restricted to the (connection_id, feed_key) tuples on
  // that page. The previous shape ran a correlated
  // `SELECT COUNT(*) FROM current_event_records` per row — O(N feeds) ×
  // an anti-join over the entire events table — ~880ms per feed on a busy
  // connection. Batching collapses it to one scan.
  // Filter predicates built ONCE and shared between the page query and the
  // overshoot fallback count, so the two can never diverge. `where` starts with
  // a TRUE seed so every real condition appends uniformly with AND.
  let where = sql`f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`;
  if (args.connection_id) {
    where = sql`${where} AND f.connection_id = ${args.connection_id}`;
  }
  if (args.entity_id) {
    where = sql`${where} AND ${sql.unsafe(
      feedLinkedToBusinessEntitySql(
        String(args.entity_id),
        'f',
        'c',
        'f.organization_id',
      ),
    )}`;
  }
  if (args.status) {
    where = sql`${where} AND f.status = ${args.status}`;
  }
  // Runtime health applies only to feeds in the active lifecycle. A feed keeps
  // `status = 'active'` while its syncs fail — until `shouldHardPauseFeed`
  // auto-pauses it — so `status` alone cannot surface active-but-failing feeds.
  // Once the feed or its parent connection is paused, its last outcome is
  // lifecycle history rather than current health, so the guard scopes BOTH
  // branches and such a row comes back as neither failing nor healthy. This
  // mirrors the lifecycle and execution-failure portions of
  // `deriveFeedHealthSemantics`, so `healthy` never renders as paused,
  // last_attempt_failed, or overdue. Auth/device/misconfiguration attention is
  // intentionally separate from this sync-health filter.
  if (args.health) {
    where = sql`${where} AND f.status = 'active' AND c.status <> 'paused'`;
    const selectedOperations = sql`
      COALESCE((
        SELECT health_cd.feeds_schema -> f.feed_key -> 'operations'
        FROM connector_definitions health_cd
        WHERE health_cd.key = c.connector_key
          AND health_cd.organization_id = f.organization_id
          -- Same definition selection as readSourceFeed: prefer the pinned
          -- artifact, but fall back to the active definition for the key, since
          -- a device-manifest upgrade archives the row a pin still names.
          AND (
            (f.pinned_version IS NULL AND health_cd.status = 'active')
            OR (
              f.pinned_version IS NOT NULL
              AND (health_cd.version = f.pinned_version OR health_cd.status = 'active')
            )
          )
        ORDER BY (health_cd.version = f.pinned_version) DESC,
                 (health_cd.status = 'active') DESC,
                 health_cd.updated_at DESC,
                 health_cd.id DESC
        LIMIT 1
      ), '[]'::jsonb)
    `;
    const sourceOnly = sql`
      ${selectedOperations} @> '["read"]'::jsonb
      AND NOT (${selectedOperations} @> '["sync"]'::jsonb)
    `;
    const overdue = sql`
      ${selectedOperations} @> '["sync"]'::jsonb
      AND COALESCE(f.schedule, '') <> ''
      AND f.next_run_at IS NOT NULL
      AND f.next_run_at < now() - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.feed_id = f.id
          AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      )
    `;
    if (args.health === 'failing') {
      where = sql`${where}
        AND NOT (${sourceOnly})
        AND (
          f.last_sync_status = 'failed'
          OR COALESCE(f.consecutive_failures, 0) > 0
          OR (${overdue})
        )
      `;
    } else {
      where = sql`${where}
        AND (
          (${sourceOnly})
          OR (
            f.last_sync_status IS DISTINCT FROM 'failed'
            AND COALESCE(f.consecutive_failures, 0) = 0
            AND NOT (${overdue})
          )
        )
      `;
    }
  }
  if (args.feed_ids?.length) {
    where = sql`${where} AND f.id = ANY(${pgBigintArray(args.feed_ids)}::bigint[])`;
  }

  // COUNT(*) OVER() runs across the whole filtered set BEFORE LIMIT/OFFSET, so
  // `filtered_total` is the true match count on every non-empty page — not the
  // page length (the previous `rows.length` reported `total: 50` for a 71-feed
  // org and made every failing feed past page 1 invisible). It is 0 on an empty
  // page (offset past the last row); the overshoot fallback below recovers the
  // true count there.
  const pageQuery = sql`
    SELECT ${sql.unsafe(publicFeedColumnList('f'))}, c.connector_key,
           COALESCE(selected_definition.operations, '[]'::jsonb) AS operations,
           COALESCE(selected_definition.webhook_driven, false) AS webhook_driven,
           COUNT(*) OVER()::int AS filtered_total
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    -- One definition per feed, projected twice. Same selection as
    -- readSourceFeed, so the reported capabilities and the webhook
    -- declaration both come from the version a read/sync would actually run.
    LEFT JOIN LATERAL (
      SELECT definition.feeds_schema -> f.feed_key -> 'operations' AS operations,
             ${sql.unsafe(feedWebhookDrivenSql('definition', 'f'))} AS webhook_driven
      FROM connector_definitions definition
      WHERE definition.key = c.connector_key
        AND definition.organization_id = f.organization_id
        AND (
          (f.pinned_version IS NULL AND definition.status = 'active')
          OR (
            f.pinned_version IS NOT NULL
            AND (definition.version = f.pinned_version OR definition.status = 'active')
          )
        )
      ORDER BY (definition.version = f.pinned_version) DESC,
               (definition.status = 'active') DESC,
               definition.updated_at DESC, definition.id DESC
      LIMIT 1
    ) selected_definition ON true
    WHERE ${where}
    ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${offset}
  `;

  const query = sql`
    WITH page AS MATERIALIZED (
      ${pageQuery}
    ),
    event_counts AS (
      SELECT e.connection_id, e.feed_key, COUNT(*)::int AS event_count
      FROM events e
      WHERE e.organization_id = ${organizationId}
        -- ANY(ARRAY(...)) on each column lets the planner stay on
        -- per-column index scans and intersect, rather than re-scanning
        -- the connection_id index per (connection, feed_key) pair the
        -- way IN (subquery) on a tuple would. The feed_key ANY narrows
        -- the scan to the keys actually on this page; the final LEFT
        -- JOIN drops any over-count from the cross-product.
        AND e.connection_id = ANY(ARRAY(SELECT DISTINCT connection_id FROM page))
        AND e.feed_key = ANY(ARRAY(SELECT DISTINCT feed_key FROM page WHERE feed_key IS NOT NULL))
        AND e.superseded_by IS NULL
      GROUP BY e.connection_id, e.feed_key
    )
    SELECT p.*, c.connector_key, c.display_name AS connection_name,
           c.status AS connection_status,
           c.external_tenant_id AS external_tenant_id,
           c.device_worker_id,
           COALESCE(dw.user_id, (o.metadata::jsonb)->>'personal_org_for_user_id') AS device_owner_user_id,
           dw.label AS device_label,
           dw.platform AS device_platform,
           dw.last_seen_at AS device_last_seen_at,
           (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})) AS device_online,
           CASE
             WHEN c.device_worker_id IS NOT NULL
              AND NOT (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}))
             THEN 'offline'
           END AS device_status,
           cd.name AS connector_name,
           COALESCE(p.pinned_version, cd.version) AS connector_version,
           COALESCE(cv.manifest_backed, false) AS connector_manifest_backed,
           cv.artifact_hash AS connector_manifest_hash,
           ap.profile_kind AS auth_profile_kind,
           ap.status AS auth_profile_status,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.deleted_at IS NULL
               AND ent.id IN ${sql.unsafe(feedLinkedEntityIdsSql('p', 'c'))}
           ) AS entity_names,
           (SELECT COUNT(*) FROM runs r WHERE r.feed_id = p.id AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[]))::int AS active_runs,
           -- Agent targeted by this feed's channel Automation (channel feeds only), so the
           -- Automations Listen picker can hide channels already owned by another
           -- agent instead of silently reassigning the Automation when linked.
           (SELECT subscription.agent_id
             FROM automation_message_subscriptions subscription
             WHERE subscription.organization_id = p.organization_id
               AND subscription.connection_id = p.connection_id
               AND subscription.channel_id = p.feed_key
             LIMIT 1) AS target_agent_id,
           COALESCE(ec.event_count, 0)::int AS event_count
    FROM page p
    JOIN connections c ON c.id = p.connection_id
    JOIN "organization" o ON o.id = c.organization_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    LEFT JOIN LATERAL (
      SELECT name, version
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN LATERAL (
      ${selectedConnectorVersionArtifactSql(sql, {
        connectorKey: sql`c.connector_key`,
        version: sql`COALESCE(p.pinned_version, cd.version)`,
        organizationId: sql`p.organization_id`,
      })}
    ) cv ON TRUE
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    LEFT JOIN event_counts ec ON ec.connection_id = p.connection_id AND ec.feed_key = p.feed_key
    ORDER BY p.created_at DESC
  `;

  const rows = (await query) as Array<Record<string, unknown>>;
  // COUNT(*) OVER() is constant across the page. On a non-empty page it is the
  // true whole-filter count. On an empty page (offset past the last row) there
  // is no row to read it from, so recover the true count with a bare COUNT over
  // the SAME shared `where` — one extra query only on the rare overshoot path,
  // keeping `total` truthful for page-jumps rather than reporting 0.
  let total: number;
  if (rows.length > 0) {
    total = Number(rows[0].filtered_total ?? rows.length);
  } else {
    const [countRow] = (await sql`
      SELECT COUNT(*)::int AS total
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE ${where}
    `) as Array<{ total: number }>;
    total = Number(countRow?.total ?? 0);
  }
  // Strip the window-count helper column from each feed row — it is metadata
  // about the result set, not a feed field — then sanitize the row itself
  // (checkpoint out, config redacted). Attach the derived health semantics
  // (execution mode / attention) computed from the joined row fields at read
  // time — never stored.
  const feeds = await toPublicFeeds(
    organizationId,
    rows.map(({ filtered_total: _filtered_total, ...feed }) => feed),
  );
  const deviceReadiness = await loadDeviceConnectorReadiness({
    sql,
    targets: feeds.flatMap((feed) =>
      typeof feed.connector_version === 'string' &&
      feed.connector_version.length > 0 &&
      (feed.connector_manifest_backed === true ||
        isChromeNamespaceConnectorKey(feed.connector_key as string))
        ? [{
            ownerUserId: feed.device_owner_user_id as string | null,
            connectorKey: feed.connector_key as string,
            connectorVersion: feed.connector_version,
            manifestHash: feed.connector_manifest_hash as string | null,
            deviceWorkerId: feed.device_worker_id as string | null,
          }]
        : []
    ),
  });
  const feedsWithHealth = feeds.map((feed) => {
    const connectorReadiness = findDeviceConnectorReadiness(deviceReadiness, {
      ownerUserId: feed.device_owner_user_id as string | null,
      connectorKey: feed.connector_key as string,
      connectorVersion: feed.connector_version as string | null,
      manifestHash: feed.connector_manifest_hash as string | null,
      deviceWorkerId: feed.device_worker_id as string | null,
    });
    const semantics = deriveFeedHealthSemantics({
      operations: feed.operations as Array<'sync' | 'read'> | null,
      store:
        parseJsonObject(feed.config).store === 'channel_messages'
          ? 'channel_messages'
          : 'events',
      status: feed.status as string | null,
      schedule: feed.schedule as string | null,
      webhook_driven: feed.webhook_driven as boolean | null,
      last_sync_status: feed.last_sync_status as string | null,
      last_sync_at: feed.last_sync_at as Date | string | null,
      consecutive_failures: feed.consecutive_failures as number | null,
      next_run_at: feed.next_run_at as Date | string | null,
      active_runs: feed.active_runs as number | null,
      connection_status: feed.connection_status as string | null,
      auth_profile_status: feed.auth_profile_status as string | null,
      device_worker_id: feed.device_worker_id as string | null,
      device_online: feed.device_online as boolean | null,
      device_connector_readiness: connectorReadiness?.state,
    });
    const {
      device_owner_user_id: _deviceOwnerUserId,
      connector_version: _connectorVersion,
      connector_manifest_backed: _connectorManifestBacked,
      connector_manifest_hash: _connectorManifestHash,
      // Derivation input, not public surface — it is already expressed in the
      // `attention` value the caller reads.
      webhook_driven: _webhookDriven,
      ...publicFeed
    } = feed;
    return {
      ...publicFeed,
      execution_mode: semantics.executionMode,
      attention: semantics.attention,
      ...(connectorReadiness?.state === 'setup_required'
        ? { attention_reason: describeDeviceConnectorSetupRequired(connectorReadiness) }
        : {}),
    };
  });
  return {
    action: 'list_feeds',
    feeds: feedsWithHealth,
    total,
    has_more: offset + feeds.length < total,
    limit,
    offset,
  };
}

async function handleReadFeed(
  args: Static<typeof ReadFeedAction>,
  ctx: ToolContext,
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;
  // Connection-visibility gate (mirrors manage_connections crud handleList/Get):
  // read_feed is in PUBLIC_READ_ACTIONS, so feed metadata is content an
  // anonymous caller could otherwise pull by guessing a feed_id. Owners/admins
  // see all; everyone else gets the shared connection-visibility predicate
  // (anonymous → org-only).
  const visibilityFilter = (await callerIsAdmin(sql, ctx))
    ? sql``
    : sql`${sql.unsafe(compileConnectionRowVisibility(authzScopeFromToolContext(ctx), 'c'))}`;

  const rows = (await sql`
    SELECT ${sql.unsafe(publicFeedColumnList('f'))},
           c.slug,
           c.connector_key,
           c.display_name AS connection_name,
           COALESCE((
             SELECT definition.feeds_schema -> f.feed_key -> 'operations'
             FROM connector_definitions definition
             WHERE definition.key = c.connector_key
               AND definition.organization_id = f.organization_id
               -- Same definition selection as readSourceFeed, so the reported
               -- capabilities are the ones a read/sync would actually run.
               AND (
                 (f.pinned_version IS NULL AND definition.status = 'active')
                 OR (
                   f.pinned_version IS NOT NULL
                   AND (definition.version = f.pinned_version OR definition.status = 'active')
                 )
               )
             ORDER BY (definition.version = f.pinned_version) DESC,
                      (definition.status = 'active') DESC,
                      definition.updated_at DESC, definition.id DESC
             LIMIT 1
           ), '[]'::jsonb) AS operations,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.deleted_at IS NULL
               AND ent.id IN ${sql.unsafe(feedLinkedEntityIdsSql('f', 'c'))}
           ) AS entity_names
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${args.feed_id}
      AND f.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
      AND f.deleted_at IS NULL
      ${visibilityFilter}
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { error: 'Feed not found' };
  const [feed] = await toPublicFeeds(organizationId, [rows[0]]);

  const runs = await sql`
    SELECT id, status, items_collected, error_message, created_at, completed_at, checkpoint, connector_version,
           dry_run, dry_run_preview
    FROM runs
    WHERE feed_id = ${args.feed_id} AND run_type = 'sync'
    ORDER BY created_at DESC
    LIMIT 10
  `;

  return { action: 'read_feed', feed, recent_runs: runs };
}

function sourceErrorCode(err: unknown): ToolErrorCode {
  if (err instanceof SourceCursorError) return 'VALIDATION';
  return classifyPushdownFailure(err);
}

async function handleReadFeeds(
  args: Static<typeof ReadFeedsAction>,
  ctx: ToolContext,
): Promise<ManageFeedsResult> {
  const rawTimeoutMs = Number(args.timeout_ms ?? DEFAULT_BATCH_READ_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeoutMs)
    ? Math.max(
        1000,
        Math.min(MAX_BATCH_READ_TIMEOUT_MS, Math.trunc(rawTimeoutMs)),
      )
    : DEFAULT_BATCH_READ_TIMEOUT_MS;
  const results = await Promise.all(
    args.reads.slice(0, 10).map(async (read) => {
      try {
        const { window: _window, sourceRevision: _revision, ...result } =
          await readSourceFeedPage(read, timeoutMs, authzScopeFromToolContext(ctx), ctx.abortSignal);
        return result;
      } catch (err) {
        const error_code = sourceErrorCode(err);
        return {
          feed_id: read.feed_id,
          ok: false as const,
          error: getErrorMessage(err),
          error_code,
          retryable: isRetryable(error_code),
        };
      }
    }),
  );

  return {
    action: 'read_feeds',
    results,
    failures: results.filter((r) => !r.ok).length,
    timeout_ms: timeoutMs,
  };
}

async function handleCreateFeed(
  args: Static<typeof CreateFeedAction>,
  ctx: ToolContext,
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const connRows = await sql`
    SELECT c.id, c.connector_key, c.status, c.auth_profile_id, c.config,
           cd.feeds_schema, cd.mcp_config
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT feeds_schema, mcp_config
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE c.id = ${args.connection_id} AND c.organization_id = ${organizationId}
  `;

  if (connRows.length === 0) {
    return { error: 'Connection not found' };
  }

  const conn = connRows[0] as {
    id: number | string;
    connector_key: string;
    status: string;
    auth_profile_id: number | string | null;
    config: unknown;
    feeds_schema: Record<string, FeedDefinition> | null;
    mcp_config: Record<string, unknown> | null;
  };
  // Consent-only connections exist solely to hold an OAuth grant for delegation
  // (the cloud grant-holder behind a managed connector); they cannot have feeds,
  // so they never sync. This is the by-construction guarantee that a managed
  // connector's data only ever lives on the local instance — a consent-only
  // cloud connection can never get a feed, so the cloud worker never syncs it.
  const connConfig = parseJsonObject(conn.config);
  if (connConfig.consent_only === true) {
    return {
      error:
        'This connection is consent-only (holds an OAuth grant for delegation) and cannot have feeds.',
    };
  }
  // A `pending_auth` connection is OK — the feed is created `paused` (the
  // `feeds.status` CHECK only allows active|paused|error). OAuth reconciliation
  // marks that system-owned pause so a later eligible grant can resume it.
  if (conn.status !== 'active' && conn.status !== 'pending_auth') {
    return {
      error: `Connection is ${conn.status}, must be active or pending_auth to create feeds`,
    };
  }
  const feedInitialStatus = conn.status === 'active' ? 'active' : 'paused';

  const feedsSchema = conn.feeds_schema;
  if (feedsSchema && !feedsSchema[args.feed_key]) {
    return {
      error: `Invalid feed_key '${args.feed_key}'. Available: ${Object.keys(feedsSchema).join(', ')}`,
    };
  }

  const operations = feedOperations(feedsSchema, args.feed_key);
  if (operations.length === 0) {
    return {
      error: `Feed '${args.feed_key}' declares no sync or read operation`,
    };
  }
  const canSync = operations.includes('sync');

  // Resolve the concrete Atlassian site through the authenticated MCP
  // connection at this write-time chokepoint. Persisting site identity makes
  // future live reads and Jira app webhook routing exact and replica-safe.
  let effectiveFeedConfig: Record<string, unknown> = { ...(args.config ?? {}) };
  const mcpConfig = isAtlassianMcpConfig(conn.mcp_config)
    ? normalizeMcpProxyConfig(conn.mcp_config)
    : null;
  if (
    conn.status === 'active' &&
    mcpConfig &&
    args.feed_key === ATLASSIAN_JIRA_ISSUES_FEED_KEY
  ) {
    try {
      const preferredCloudId =
        typeof effectiveFeedConfig.cloud_id === 'string'
          ? effectiveFeedConfig.cloud_id.trim() || undefined
          : undefined;
      const { configPatch } = await reconcileAtlassianMcpJiraSite({
        organizationId,
        connectionId: Number(conn.id),
        connectorKey: String(conn.connector_key),
        mcpConfig,
        preferredCloudId,
      });
      effectiveFeedConfig = { ...effectiveFeedConfig, ...configPatch };
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }

  const configError = validateFeedConfig(
    feedsSchema,
    args.feed_key,
    effectiveFeedConfig,
  );
  if (configError) return { error: configError };

  // Omit / empty schedule = no cron. Source-only feeds cannot be scheduled;
  // feeds that also declare sync may be scheduled or triggered manually.
  const rawSchedule = args.schedule ?? null;
  const schedule =
    rawSchedule == null || String(rawSchedule).trim() === ''
      ? null
      : String(rawSchedule).trim();
  if (schedule) {
    if (!canSync) {
      return {
        error: `Feed '${args.feed_key}' does not support sync and cannot be scheduled`,
      };
    }
    const scheduleError = validateSchedule(schedule);
    if (scheduleError) {
      return { error: scheduleError };
    }
  }
  const timezone = args.timezone ?? null;
  if (timezone && !canSync) {
    return {
      error: `Feed '${args.feed_key}' does not support sync and cannot have a timezone`,
    };
  }
  if (timezone) {
    const tzError = validateTimezone(timezone);
    if (tzError) {
      return { error: tzError };
    }
  }

  // Don't schedule a first run for a feed whose connection is still pending auth.
  const nextRunAtVal =
    schedule && feedInitialStatus === 'active'
      ? nextRunAt(schedule, new Date(), timezone)
      : null;
  // Reject cross-org entity_ids: a feed pointing at another org's entity links
  // synced events to a non-existent in-org entity (silent data-correctness bug).
  try {
    await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
  } catch (err) {
    return { error: getErrorMessage(err) };
  }
  const entityIdsValue =
    args.entity_ids && args.entity_ids.length > 0
      ? pgBigintArray(args.entity_ids)
      : null;

  const displayName = await resolveFeedDisplayName({
    explicitName: args.display_name,
    feedKey: args.feed_key,
    config: effectiveFeedConfig,
    entityIds: args.entity_ids ?? null,
    feedsSchema,
  });

  const authProfile = Number(conn.auth_profile_id)
    ? await getAuthProfileById(organizationId, Number(conn.auth_profile_id))
    : null;
  const systemScopePaused =
    feedInitialStatus === 'paused' &&
    authProfile?.profile_kind === 'oauth_account';

  const inserted = await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name, status,
      entity_ids, config, schedule, timezone, next_run_at, last_error
    ) VALUES (
      ${organizationId}, ${args.connection_id}, ${args.feed_key}, ${displayName}, ${feedInitialStatus},
      ${entityIdsValue}::bigint[],
      ${args.config || Object.keys(effectiveFeedConfig).length > 0 ? sql.json(effectiveFeedConfig) : null},
      ${schedule}, ${timezone}, ${nextRunAtVal},
      ${systemScopePaused ? OAUTH_SCOPE_PAUSE_LAST_ERROR : null}
    )
    RETURNING ${sql.unsafe(publicFeedColumnList())}
  `;

  if (authProfile?.profile_kind === 'oauth_account') {
    await syncOAuthConnectionsForAuthProfile(organizationId, authProfile.id);
  }

  logger.info(
    {
      feed_id: inserted[0].id,
      connector_key: conn.connector_key,
      feed_key: args.feed_key,
    },
    'Feed created',
  );

  recordToolConfigChange(ctx, {
    resourceKind: 'feed',
    resourceId: inserted[0].id as number,
    op: 'created',
    summary: `Feed '${displayName}' created`,
    state: inserted[0] as Record<string, unknown>,
  });

  return {
    action: 'create_feed',
    feed: toPublicFeed(
      { ...(inserted[0] as Record<string, unknown>), operations },
      // `feedsSchema` is the connector definition already loaded above for
      // config validation — no extra lookup needed.
      feedSecretKeysFromSchema(feedsSchema, args.feed_key),
    ),
  };
}

async function handleUpdateFeed(
  args: Static<typeof UpdateFeedAction>,
  ctx: ToolContext,
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Reject cross-org entity_ids on update too (skip when clearing to []).
  if (args.entity_ids !== undefined && args.entity_ids.length > 0) {
    try {
      await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }
  const entityIdsValue =
    args.entity_ids !== undefined
      ? args.entity_ids.length > 0
        ? pgBigintArray(args.entity_ids)
        : '{}'
      : null;

  // `schedule` is tri-state: undefined = leave alone, null/"" = clear (manual),
  // string = set cron. Mirror timezone.
  const hasScheduleArg = Object.hasOwn(args, 'schedule');
  let nextSchedule: string | null | undefined;
  if (hasScheduleArg) {
    const raw = args.schedule;
    nextSchedule =
      raw == null || String(raw).trim() === '' ? null : String(raw).trim();
    if (nextSchedule) {
      const scheduleError = validateSchedule(nextSchedule);
      if (scheduleError) {
        return { error: scheduleError };
      }
    }
  }
  if (args.timezone) {
    const tzError = validateTimezone(args.timezone);
    if (tzError) {
      return { error: tzError };
    }
  }
  const hasTimezoneArg = args.timezone !== undefined;
  const touchesCadence = hasScheduleArg || hasTimezoneArg;

  // Declarative `lobu apply` passes `replace_config: true` so removed manifest
  // keys disappear remotely; default (merge) is preserved for the web UI.
  const replaceFeedConfig =
    args.replace_config === true && args.config !== undefined;
  const hasConfigArg = args.config !== undefined;
  const hasStatusArg = args.status !== undefined;

  // Row-locked read→validate→write: the stored config is read, the EFFECTIVE
  // config (merge or replace) computed and validated against the connector's
  // declared feed configSchema, and exactly that validated object persisted —
  // all under one FOR UPDATE lock, so a concurrent update cannot interleave an
  // unvalidated merge between the read and the write, and AJV coercions land
  // in what is stored. Without the schema check a patch could push the stored
  // config into a shape that only fails at sync time.
  const txResult = await sql.begin(async (tx) => {
    const existing = await tx`
      SELECT f.id, f.status, f.schedule, f.timezone, f.feed_key, f.config,
             f.pinned_version, c.auth_profile_id, cd.feeds_schema
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      LEFT JOIN LATERAL (
        SELECT feeds_schema
        FROM connector_definitions
        WHERE key = c.connector_key
          AND organization_id = ${organizationId}
          AND (
            (f.pinned_version IS NULL AND status = 'active')
            OR (
              f.pinned_version IS NOT NULL
              AND (version = f.pinned_version OR status = 'active')
            )
          )
        ORDER BY (version = f.pinned_version) DESC,
                 (status = 'active') DESC,
                 updated_at DESC,
                 id DESC
        LIMIT 1
      ) cd ON TRUE
      WHERE f.id = ${args.feed_id} AND f.organization_id = ${organizationId}
      FOR UPDATE OF f
    `;
    if (existing.length === 0) {
      return { error: 'Feed not found' } as const;
    }
    const feedRow = existing[0] as Record<string, unknown>;
    const operations = feedOperations(
      feedRow.feeds_schema as Record<string, FeedDefinition> | null,
      String(feedRow.feed_key),
    );
    const canSync = operations.includes('sync');
    if (operations.length === 0) {
      return {
        error: `Feed '${String(feedRow.feed_key)}' declares no sync or read operation`,
      } as const;
    }
    // `read_feed`/`list_feeds` redact feeds.config, so a client that reads and
    // PATCHes back would otherwise persist `__LOBU_REDACTED__` over the stored
    // value. Restore from the row (read under the same FOR UPDATE lock, so the
    // restore sees exactly what the write is based on) before merge/replace.
    const restoredConfig = hasConfigArg
      ? (restoreRedactedConfig(
          args.config,
          parseJsonObject(feedRow.config),
        ) as Record<string, unknown>)
      : undefined;
    const effectiveConfig = hasConfigArg
      ? replaceFeedConfig
        ? (restoredConfig as Record<string, unknown>)
        : { ...parseJsonObject(feedRow.config), ...restoredConfig }
      : null;
    if (effectiveConfig) {
      const configError = validateFeedConfig(
        feedRow.feeds_schema as Record<string, FeedDefinition> | null,
        String(feedRow.feed_key),
        effectiveConfig,
      );
      if (configError) return { error: configError } as const;
    }
    // Resume starts a fresh failure episode so the next hard-pause emits a new
    // feed.auto_paused delivery_id (keyed on first_failure_at) instead of
    // silently reusing the prior pause episode's Automation run.
    const resuming =
      args.status === 'active' && String(feedRow.status) !== 'active';

    // Recompute next_run_at when the cadence OR its zone changes; the effective
    // pair mixes the incoming args with the stored row for whichever side was
    // omitted, so a timezone-only update re-anchors the pending sync. Clearing
    // schedule (null) clears next_run_at — manual feeds do not auto-poll.
    // Also re-anchor on resume: hard-pause nulls next_run_at, so unpausing
    // without a schedule edit would otherwise leave the feed never scheduled.
    const effectiveSchedule = hasScheduleArg
      ? (nextSchedule ?? null)
      : (feedRow.schedule as string | null);
    const effectiveTimezone = hasTimezoneArg
      ? (args.timezone ?? null)
      : (feedRow.timezone as string | null);
    const recomputeNextRun = touchesCadence || resuming;
    if (
      !canSync &&
      recomputeNextRun &&
      (effectiveSchedule !== null || effectiveTimezone !== null)
    ) {
      return {
        error: `Feed '${String(feedRow.feed_key)}' does not support sync cadence`,
      } as const;
    }
    const nextRunAtVal =
      recomputeNextRun && effectiveSchedule
        ? nextRunAt(effectiveSchedule, new Date(), effectiveTimezone)
        : null;

    const updated = await tx`
      UPDATE feeds
      SET display_name = COALESCE(${args.display_name ?? null}::text, display_name),
          status = COALESCE(${args.status ?? null}::text, status),
          entity_ids = COALESCE(${entityIdsValue}::bigint[], entity_ids),
          config = CASE WHEN ${hasConfigArg} THEN ${tx.json(effectiveConfig ?? {})}::jsonb ELSE config END,
          schedule = CASE WHEN ${hasScheduleArg} THEN ${nextSchedule ?? null} ELSE schedule END,
          timezone = CASE WHEN ${hasTimezoneArg} THEN ${args.timezone ?? null} ELSE timezone END,
          next_run_at = CASE WHEN ${recomputeNextRun} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END,
          last_error = CASE
            WHEN ${hasStatusArg} AND last_error = ${OAUTH_SCOPE_PAUSE_LAST_ERROR} THEN NULL
            ELSE last_error
          END,
          consecutive_failures = CASE WHEN ${resuming} THEN 0 ELSE consecutive_failures END,
          first_failure_at = CASE WHEN ${resuming} THEN NULL ELSE first_failure_at END,
          updated_at = NOW()
      WHERE id = ${args.feed_id} AND organization_id = ${organizationId}
      RETURNING ${tx.unsafe(publicFeedColumnList())}
    `;
    return {
      updated,
      operations,
      authProfileId: Number(feedRow.auth_profile_id) || null,
      // Resolved here because the connector's feeds_schema is already joined
      // into this query — the response serializer below needs it to redact
      // feed-scoped `format: "password"` fields without a second lookup.
      declaredSecretKeys: feedSecretKeysFromSchema(
        feedRow.feeds_schema,
        String(feedRow.feed_key),
      ),
    };
  });
  if ('error' in txResult && txResult.error !== undefined) {
    return { error: txResult.error };
  }
  const { updated, operations, authProfileId, declaredSecretKeys } = txResult;
  if (authProfileId) {
    const authProfile = await getAuthProfileById(organizationId, authProfileId);
    if (authProfile?.profile_kind === 'oauth_account') {
      await syncOAuthConnectionsForAuthProfile(organizationId, authProfile.id);
    }
  }

  const updatedFeed = updated[0] as Record<string, unknown>;
  const changedFields = [
    ...(args.display_name !== undefined ? ['display_name'] : []),
    ...(args.status !== undefined ? ['status'] : []),
    ...(args.entity_ids !== undefined ? ['entity_ids'] : []),
    ...(args.config !== undefined ? ['config'] : []),
    ...(args.schedule !== undefined ? ['schedule'] : []),
    ...(hasTimezoneArg ? ['timezone'] : []),
  ];
  recordToolConfigChange(ctx, {
    resourceKind: 'feed',
    resourceId: args.feed_id,
    op: 'updated',
    summary: `Feed '${updatedFeed.display_name ?? updatedFeed.feed_key ?? args.feed_id}' updated`,
    state: updatedFeed,
    ...(changedFields.length > 0 ? { changedFields } : {}),
  });

  return {
    action: 'update_feed',
    feed: toPublicFeed({ ...updatedFeed, operations }, declaredSecretKeys),
  };
}

async function handleDeleteFeed(
  args: Static<typeof DeleteFeedAction>,
  ctx: ToolContext,
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Prove org ownership BEFORE any side effect: the run-cancel below is not
  // org-scoped (runs has no organization_id of its own — it's reached through
  // the feed), so cancelling runs first would let a guessed foreign feed_id
  // cancel another org's runs even though the delete then no-ops. Delete the
  // org-owned feed first and bail when nothing matched.
  const deleted = await sql`
    UPDATE feeds
    SET deleted_at = NOW(), status = 'paused', updated_at = NOW()
    WHERE id = ${args.feed_id} AND organization_id = ${organizationId} AND deleted_at IS NULL
    RETURNING id, feed_key, connection_id, entity_ids
  `;

  if (deleted.length === 0) {
    return { error: 'Feed not found or already deleted' };
  }

  // Ownership confirmed — now safe to cancel this feed's active runs.
  await sql`
    UPDATE runs SET status = 'cancelled', completed_at = NOW()
    WHERE feed_id = ${args.feed_id} AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

  // Record change event in knowledge for audit trail
  const feed = deleted[0];
  const feedEntityIds = Array.isArray(feed.entity_ids) ? feed.entity_ids : [];
  recordChangeEvent({
    entityIds: feedEntityIds.map(Number),
    organizationId,
    subject: 'feed',
    op: 'deleted',
    title: `Feed deleted: ${feed.feed_key}`,
    content: `Feed "${feed.feed_key}" (id: ${args.feed_id}) was deleted.`,
    metadata: {
      action: 'feed_deleted',
      feed_id: args.feed_id,
      feed_key: feed.feed_key,
      connection_id: feed.connection_id,
    },
  });

  recordToolConfigChange(ctx, {
    resourceKind: 'feed',
    resourceId: args.feed_id,
    op: 'deleted',
    summary: `Feed '${feed.feed_key}' deleted`,
    state: null,
  });

  return { action: 'delete_feed', deleted: true, feed_id: args.feed_id };
}

async function handleTriggerFeed(
  args: Static<typeof TriggerFeedAction>,
  ctx: ToolContext,
  env: Env,
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const feedRows = await sql`
    SELECT f.id, f.status, f.connection_id, c.connector_key
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${args.feed_id} AND f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
  `;

  if (feedRows.length === 0) {
    return { error: 'Feed not found' };
  }

  const feed = feedRows[0] as { status: string };
  const dryRun = args.dry_run === true;
  // A dry run is the safe validation lane for a paused feed: it executes the
  // connector but leaves feed state, checkpoints, and collected data untouched.
  // Persistent runs still require an active feed.
  if (feed.status !== 'active' && !(dryRun && feed.status === 'paused')) {
    return { error: `Feed is ${feed.status}, must be active to trigger sync` };
  }

  const created = await createSyncRun(args.feed_id, env, undefined, { dryRun });
  if (!created.ok) {
    if (created.reason === 'sync_unsupported') {
      return { error: 'Feed does not support sync' };
    }
    // `triggered: false` mirrors the success shape below, because the message
    // alone was indistinguishable from success: the skip result carried no
    // error and no flag, so a caller that queued nothing read as one that had.
    // No run row is written for a skip either, so there is no failed run to
    // alert on — a Cloud denial sat unnoticed behind this shape.
    return {
      action: 'trigger_feed',
      triggered: false,
      reason: created.reason,
      message: describeSyncRunSkip(created.reason),
    };
  }
  const runId = created.runId;

  // `dry_run` is echoed only when true, and only because it was honoured. A
  // caller cannot otherwise distinguish "ran dry" from "flag silently dropped
  // and everything persisted", which is the one outcome that would matter.
  return {
    action: 'trigger_feed',
    triggered: true,
    run_id: runId,
    feed_id: args.feed_id,
    ...(dryRun ? { dry_run: true } : {}),
  };
}
