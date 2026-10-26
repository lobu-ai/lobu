/**
 * Pushdown: run a read-only query LIVE against a connection's source by invoking
 * its connector in `query` mode — no copy, no events. Used by query_sql when a
 * `connection` is given.
 * The DB socket lives in the connector isolate (behind the worker egress
 * controls), never in the gateway. Feed source reads use the separate
 * per-feed `read` capability below. Reuses the same inline-run path as
 * operations.execute.
 */

import { BrowserInterruptionError } from '@lobu/core';
import { connectionBrowserGrant } from '../connectors/browser-resource';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { assertFeedReadWindow, validateFeedReadWindow, type FeedReadMatch, type FeedReadWindow, type FeedReadWindowCoverage, type QueryContext } from '@lobu/connector-sdk';
import { createHash } from 'node:crypto';
import { stableJson } from '../utils/insert-event';
import {
  classifyToolError,
  getErrorMessage,
  isRetryable,
  ToolError,
  type ToolErrorCode,
} from '@lobu/core';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import { DEVICE_ACCESS_REFUSED, DEVICE_READ_NEEDS_OWNER, decideDeviceAccess } from '../authz/device-access';
import { resolveActingPrincipal, resolveConnectorPolicy } from '../authz/entity-policy';
import { DEVICE_FEED_READ_ACTION_KEY } from './device-feed-read-protocol';
import type { AuthzScope, SourceReadScope } from '../authz/scope';
import { getDb } from '../db/client';
import { dbEgressConfig } from '../utils/cloud-mode';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import { resolveConnectorCodeForKey } from '../utils/ensure-connector-installed';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import { isMetadataOnlyDeviceConnector, readDeviceFeed } from './device-feed-read';
import { readSourceFeedFromAdapter } from './source-feed-adapters';
import { createSourceReadBridge, sourceReadDeadlineError } from './source-read-bridge';
import { sourceRecoveryHash } from './browser-recovery';
import { pinnedDeviceConnectorContractSql } from '../utils/connector-execution-placement';
import { computeCodeHash } from '../utils/compiler-core';
import { sourceFeedScopeKey, sourceFeedSubscriptions } from '../runs/source-feed-subscriptions';

interface ConnectorQueryParams {
  /** The ACL gate — tenant + principal. Its `organizationId`/`principal` drive
   * the same connection visibility as manage_connections. */
  scope: AuthzScope;
  /** Connection slug (org-scoped). */
  connectionSlug: string;
  /** Read-only SQL to push down (a derived entity's backing_sql, or a feed query). */
  query: string;
  exactMatch?: QueryContext['exactMatch'];
  selection?: QueryContext['selection'];
  /** Owner/admin callers see every connection; members only org-visible or their
   * own. A full management-tier bypass. */
  isAdmin: boolean;
  config?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
  /**
   * Wall-clock deadline for this pushdown, when the caller has one — the same
   * shape {@link ReadSourceFeedParams} already exposes on the sibling read path.
   * It can only SHORTEN the budget: {@link PUSHDOWN_QUERY_TIMEOUT_MS} still caps
   * it, and a deadline already in the past fails before anything is forked.
   */
  deadlineAt?: number;
}

interface ConnectorQueryResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total?: number;
}

/**
 * Hard wall-clock cap on ONE pushdown query. Without it `IsolateExecutor`'s
 * 600_000ms default applies, so a slow source could pin a gateway-forked
 * connector run for ten minutes per request.
 *
 * 30s matches what the request path already promises elsewhere:
 * `manage_feeds`'s batch read cap and the postgres connector's own
 * `statement_timeout_ms` default. A connector self-limit is courtesy, though —
 * the next connector need not have one — so the cap belongs here, on the
 * platform side. It is deliberately a REQUEST-path budget: a connection tuned
 * for a long sync statement does not get that long on an interactive read.
 */
export const PUSHDOWN_QUERY_TIMEOUT_MS = 30_000;

/** Pause before the one transient-failure retry; it never extends the deadline. */
const PUSHDOWN_RETRY_BACKOFF_MS = 250;

/**
 * The budget one pushdown gets: the cap, or whatever is left of the caller's
 * deadline when that is sooner. Throws when the deadline has already passed, so
 * an expired request never pays for a fork.
 */
export function resolvePushdownTimeoutMs(deadlineAt?: number): number {
  if (deadlineAt === undefined) return PUSHDOWN_QUERY_TIMEOUT_MS;
  const remaining = Math.trunc(deadlineAt - Date.now());
  if (remaining <= 0) {
    throw Object.assign(new Error('pushdown deadline expired before the query ran'), {
      exitReason: 'timeout' as const,
    });
  }
  return Math.min(PUSHDOWN_QUERY_TIMEOUT_MS, remaining);
}

export async function runConnectorQuery(p: ConnectorQueryParams): Promise<ConnectorQueryResult> {
  // Resolved before any work so an already-expired deadline costs nothing.
  const deadlineAt = Date.now() + resolvePushdownTimeoutMs(p.deadlineAt);
  const sql = getDb();
  // Resolve org-scoped + active, enforcing the same visibility as manage_connections:
  // owner/admin callers reach every connection; everyone else gets the shared
  // connection-visibility predicate.
  const visibility = p.isAdmin
    ? sql``
    : sql`${sql.unsafe(compileConnectionRowVisibility(p.scope, 'connections'))}`;
  const connRows = await sql`
    SELECT id, connector_key, auth_profile_id, app_auth_profile_id, config
    FROM connections
    WHERE organization_id = ${p.scope.organizationId}
      AND slug = ${p.connectionSlug}
      AND deleted_at IS NULL
      AND status = 'active'
      ${visibility}
    LIMIT 1
  `;
  if (connRows.length === 0) {
    throw new ToolError(
      'NOT_FOUND',
      `source connection '${p.connectionSlug}' not found or not accessible`,
    );
  }
  const conn = connRows[0] as {
    id: number;
    connector_key: string;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    config: Record<string, unknown> | null;
  };

  const compiledCode = await resolveConnectorCodeForKey(
    conn.connector_key,
    p.scope.organizationId
  );

  const authParams = {
    organizationId: p.scope.organizationId,
    connectionId: conn.id,
    authProfileId: Number(conn.auth_profile_id) || null,
    appAuthProfileId: Number(conn.app_auth_profile_id) || null,
    credentialDb: getDb(),
    logContext: { connection: p.connectionSlug },
    logMessage: 'Failed to resolve connector query credentials',
  };
  let auth = await resolveExecutionAuth(authParams);

  const execute = async (resolved: typeof auth) => {
    const { credentials, connectionCredentials, sessionState, httpAuth, onHttpFetch } = resolved;
    return executeCompiledConnector({
      compiledCode,
      job: {
        mode: 'query',
        query: p.query,
        exactMatch: p.exactMatch,
        selection: p.selection,
        // Same merge as feed-sync / worker poll: connection.config under
        // credentials + caller overrides (any connector-level config).
        // ONLY the connection's own credentials reach ctx.config — deliberately NOT
        // the gateway's process.env, so a connection missing DATABASE_URL fails
        // cleanly instead of falling back to Lobu's own DB. The egress policy is
        // the one non-credential we inject: under cloud mode a DB connector must reject
        // internal/metadata hosts (block-private); self-hosted reaches its own
        // private DB (allow-private). The egress policy rides on both config and env
        // so the isolate's socketOpen and hostFetch enforce it. Injected LAST so
        // neither caller config nor credentials can override this security control.
        config: {
          ...mergeExecutionConfig(conn.config, connectionCredentials, p.config),
          ...dbEgressConfig(),
        },
        env: dbEgressConfig(),
        sessionState,
        credentials,
        httpAuth,
        limit: p.limit,
        offset: p.offset,
        sort: p.sort,
      },
      hooks: { onHttpFetch },
      timeoutMs: resolvePushdownTimeoutMs(deadlineAt),
    });
  };

  let result: Awaited<ReturnType<typeof execute>>;
  try {
    result = await execute(auth);
  } catch (error) {
    // Only read-only queries reach this seam. A typed rejection can refresh the
    // exact token the provider refused; the credential service serializes token
    // rotation across replicas and reuses a concurrent refresh.
    const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
    if (status === 401 && auth.credentials?.accessToken) {
      const rejectedAccessToken = auth.credentials.accessToken;
      auth = await resolveExecutionAuth({ ...authParams, rejectedAccessToken });
      if (!auth.credentials?.accessToken || auth.credentials.accessToken === rejectedAccessToken) throw error;
    } else {
      // Opaque connector errors and permanent refusals are never evidence that
      // another request will help. Preserve the structured HTTP taxonomy.
      if (typeof status !== 'number' || !isRetryable(classifyToolError({ httpStatus: status }))) throw error;
      if (deadlineAt - Date.now() <= PUSHDOWN_RETRY_BACKOFF_MS) throw error;
      await new Promise(resolve => setTimeout(resolve, PUSHDOWN_RETRY_BACKOFF_MS));
    }
    // One retry, sharing the original deadline rather than a fresh 30s budget.
    if (deadlineAt <= Date.now()) throw error;
    result = await execute(auth);
  }

  if (result.mode !== 'query') {
    throw new Error(`Expected query result, got mode=${result.mode}`);
  }
  return { rows: result.rows, columns: result.columns ?? [], total: result.total };
}

/** Params for {@link readSourceFeed}. */
export interface ReadSourceFeedParams {
  /**
   * The requesting principal + tenant. The feed's backing connection is resolved
   * through the SAME connection-visibility compiler every read seam uses, so a
   * user is fenced exactly as on the SQL seam: org-visible connections, or a
   * private connection they own. A `null` principal (headless) sees org-only.
   * `chatAccess` feeds the device access rule for device-backed feeds.
   */
  scope: SourceReadScope;
  /** Trusted execution provenance, never a caller-supplied source attribution. */
  automationId?: number | null;
  /** The configured feed to read directly from its source. */
  feedId: number;
  /** One-shot recovery handoff from an interrupted, otherwise identical read. */
  recoveryId?: string;
  /** Stable caller flow; a browser tab is retained for recovery only when set. */
  flowId?: string;
  /** Optional source-native filter/search expression. */
  query?: string;
  /** Source-native continuation token recovered from the public cursor envelope. */
  cursor?: string;
  window?: FeedReadWindow;
  /** Exact-value filter on a path the feed declares in `matchPaths`. */
  match?: FeedReadMatch;
  /** A continuation may not silently read a changed feed configuration/version. */
  sourceRevision?: string;
  /** Row cap pushed down to the source (connector clamps it). */
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
  /** Caller cancellation, threaded into device, HTTP, and compiled-connector transports. */
  signal?: AbortSignal;
  /** Absolute deadline covering resolution, transport, and finalization. */
  deadlineAt: number;
}

/** Result from {@link readSourceFeed} — live rows, never persisted. */
export interface ReadSourceFeedResult {
  rows: Record<string, unknown>[];
  rowCursors?: string[];
  columns: { name: string; type: string }[];
  total?: number;
  nextCursor?: string;
  hasMore?: boolean;
  window?: FeedReadWindowCoverage;
  sourceRevision?: string;
}

function remainingReadMs(p: ReadSourceFeedParams): number {
  if (p.signal?.aborted) throw sourceReadDeadlineError(p.feedId);
  const remaining = Math.trunc(p.deadlineAt - Date.now());
  if (remaining <= 0) throw sourceReadDeadlineError(p.feedId);
  return remaining;
}

/** Classify a thrown connector/source failure using structured diagnostics first. */
export function classifyPushdownFailure(err: unknown): ToolErrorCode {
  if (err instanceof ToolError) return err.code;
  const diagnostic = err as {
    httpStatus?: unknown;
    exitReason?: unknown;
  } | null;
  const httpStatus = typeof diagnostic?.httpStatus === 'number' ? diagnostic.httpStatus : undefined;
  const exitReason =
    diagnostic?.exitReason === 'timeout' ||
    diagnostic?.exitReason === 'oom' ||
    diagnostic?.exitReason === 'crash' ||
    diagnostic?.exitReason === 'error_message'
      ? diagnostic.exitReason
      : undefined;
  const code = classifyToolError({ httpStatus, exitReason, message: getErrorMessage(err) });
  return code === 'INTERNAL' ? 'UPSTREAM_5XX' : code;
}

/**
 * Read a configured feed directly from its source. The selected connector
 * definition must declare the feed's `read` operation; the same feed may also
 * declare `sync`. Persists no events or checkpoint. Multi-replica safe: a pure
 * per-request read with all state in Postgres, runnable on any replica.
 */
export async function readSourceFeed(p: ReadSourceFeedParams): Promise<ReadSourceFeedResult> {
  if (p.window) validateFeedReadWindow(p.window);
  const timeoutMs = remainingReadMs(p);
  const controller = new AbortController();
  const onAbort = () => controller.abort(p.signal?.reason);
  p.signal?.addEventListener('abort', onAbort, { once: true });
  let browserLeased = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(browserLeased
        ? new BrowserInterruptionError('timeout', `Browser source read ${p.feedId} timed out; no recovery handoff was issued.`)
        : sourceReadDeadlineError(p.feedId));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      readSourceFeedWithinDeadline({ ...p, signal: controller.signal }, () => { browserLeased = true; }),
      deadline,
    ]);
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    p.signal?.removeEventListener('abort', onAbort);
  }
}

/** Every transport receives the one source-read deadline and cancellation signal. */
async function readSourceFeedWithinDeadline(
  p: ReadSourceFeedParams & { signal: AbortSignal },
  onBrowserLease: () => void,
): Promise<ReadSourceFeedResult> {
  const sql = getDb();
  let sourceSubscription = false;
  if (p.scope.principal === null && p.automationId != null) {
    const [subscription] = await sourceFeedSubscriptions(sql, p.scope.organizationId, p.feedId, p.automationId);
    if (subscription) {
      p = { ...p, scope: { ...p.scope, principal: subscription.principal, agentId: subscription.agentId } };
      sourceSubscription = true;
    }
  }

  // Resolve the feed + connection, fenced by the SAME visibility compiler the
  // SQL seam uses.
  const vis = compileConnectionRowVisibility(p.scope, 'c');
  const feedRows = (await sql.unsafe(
    `SELECT f.id, f.feed_key, f.config, f.pinned_version, f.status AS feed_status,
            c.id AS connection_id, c.connector_key,
            c.auth_profile_id, c.app_auth_profile_id,
            c.device_worker_id,
            COALESCE(pinned_dw.user_id, (o.metadata::jsonb)->>'personal_org_for_user_id') AS device_owner_user_id,
            COALESCE(c.config, '{}'::jsonb) AS connection_config,
            cd.version AS definition_version, cd.feed_operations, cd.read_window_axis, cd.match_paths,
            cd.mcp_config, cd.runtime, cd.required_capability,
            cd.has_compiled_code, cd.selected_artifact_hash
     FROM feeds f
     JOIN connections c ON c.id = f.connection_id
     JOIN "organization" o ON o.id = c.organization_id
     LEFT JOIN device_workers pinned_dw ON pinned_dw.id = c.device_worker_id
     LEFT JOIN LATERAL (
       SELECT selected_contract.version, cd0.mcp_config,
              COALESCE(selected_contract.manifest->'runtime', cd0.runtime) AS runtime,
              COALESCE(selected_contract.manifest->>'required_capability', cd0.required_capability) AS required_capability,
              COALESCE((CASE WHEN selected_contract.manifest IS NOT NULL THEN selected_contract.manifest->'feeds_schema' ELSE cd0.feeds_schema END) -> f.feed_key -> 'operations', '[]'::jsonb)
                AS feed_operations,
              (CASE WHEN selected_contract.manifest IS NOT NULL THEN selected_contract.manifest->'feeds_schema' ELSE cd0.feeds_schema END) -> f.feed_key ->> 'readWindowAxis' AS read_window_axis,
              COALESCE((CASE WHEN selected_contract.manifest IS NOT NULL THEN selected_contract.manifest->'feeds_schema' ELSE cd0.feeds_schema END) -> f.feed_key -> 'matchPaths', '[]'::jsonb)
                AS match_paths,
              (
                SELECT cv.compiled_code_hash
                FROM connector_versions cv
                WHERE cv.connector_key = cd0.key
                  AND cv.version = selected_contract.version
                  AND (cv.organization_id = cd0.organization_id
                       OR cv.organization_id IS NULL)
                ORDER BY cv.organization_id NULLS LAST
                LIMIT 1
              ) AS selected_artifact_hash,
              EXISTS (
                -- Does the SELECTED version ship code THIS path can execute?
                --
                -- Mirrors resolveConnectorCodeForKey's own resolution: the
                -- selected version, org artifact preferred over the shared
                -- one. source_path is deliberately NOT part of it, and that is
                -- not an oversight — resolveConnectorCode() reads only
                -- compiled_code (recompiling from source_code when the config
                -- hash moved) and otherwise falls through to the bundled file;
                -- it never loads source_path. queue-service's
                -- resolveActiveConnectorVersion DOES accept source_path, but
                -- that is a laxer readiness gate, and device manifests set it to
                -- device-manifest://... precisely as a non-executable marker.
                -- Adopting that union here would classify every device connector
                -- as having code and break this routing outright.
                SELECT 1
                FROM connector_versions cv
                WHERE cv.connector_key = cd0.key
                  -- Definition metadata may fall back to the active row when
                  -- a pinned historical definition was archived, but code
                  -- execution remains pinned. Inspect that same artifact here
                  -- so a compiled historical version never gets misrouted to
                  -- the device read lane.
                  AND cv.version = selected_contract.version
                  AND (cv.organization_id = cd0.organization_id
                       OR cv.organization_id IS NULL)
                  AND cv.compiled_code IS NOT NULL
                  AND cv.compiled_code <> ''
              ) AS has_compiled_code
       FROM connector_definitions cd0
       LEFT JOIN LATERAL (${pinnedDeviceConnectorContractSql({ connectorKey: 'c.connector_key',
         organizationId: 'c.organization_id', deviceWorkerId: 'c.device_worker_id',
         pinnedVersion: 'f.pinned_version', defaultVersion: 'cd0.version' })}) selected_contract ON TRUE
       WHERE cd0.key = c.connector_key
         AND (
           (f.pinned_version IS NULL AND cd0.status = 'active')
           OR (
             f.pinned_version IS NOT NULL
             AND (cd0.version = f.pinned_version OR cd0.status = 'active')
           )
         )
         AND cd0.organization_id = $2
       -- Prefer exact historical metadata when it exists, matching
       -- check-due-feeds. Device-manifest upgrades archive the previous
       -- definition, so a pinned artifact may have no matching row; falling back
       -- to the active definition for the same key keeps the feed's declared
       -- operations readable instead of reporting the feed as read-incapable.
       ORDER BY (cd0.version = f.pinned_version) DESC,
                (cd0.status = 'active') DESC,
                cd0.updated_at DESC,
                cd0.id DESC
       LIMIT 1
     ) cd ON TRUE
     WHERE f.id = $1
       AND f.organization_id = $2
       AND f.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND c.status = 'active'
       ${vis}
     LIMIT 1`,
    [p.feedId, p.scope.organizationId],
  )) as unknown as Array<{
    id: number;
    feed_key: string;
    config: Record<string, unknown> | null;
    pinned_version: string | null;
    feed_status: string;
    definition_version: string | null;
    feed_operations: unknown;
    read_window_axis: string | null;
    match_paths: unknown;
    connection_id: number;
    connector_key: string;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    device_worker_id: string | null;
    device_owner_user_id: string | null;
    connection_config: Record<string, unknown>;
    mcp_config: Record<string, unknown> | null;
    runtime: Record<string, unknown> | null;
    required_capability: string | null;
    has_compiled_code: boolean | null;
    selected_artifact_hash: string | null;
  }>;

  if (feedRows.length === 0) {
    throw new ToolError(
      'NOT_FOUND',
      `feed '${p.feedId}' not found or not accessible`,
    );
  }
  const feed = feedRows[0];
  if (p.automationId != null) {
    const actor = await resolveActingPrincipal(sql, { organizationId: p.scope.organizationId, sessionAutomationId: p.automationId });
    const policy = await resolveConnectorPolicy({ organizationId: p.scope.organizationId, connectionId: Number(feed.connection_id), actor,
      operation: { connector_key: feed.connector_key, operation_key: DEVICE_FEED_READ_ACTION_KEY, kind: 'read' }, sql });
    if (policy.effect !== 'auto') throw new ToolError('PERMISSION', 'Automation source read requires an Auto connector policy.');
  }
  const feedOperations = Array.isArray(feed.feed_operations) ? feed.feed_operations : [];
  const readWindowAxis = feed.read_window_axis?.trim() || undefined;
  const sourceRevision = createHash('sha256').update(stableJson({
    feedId: feed.id, feedKey: feed.feed_key, connectionId: feed.connection_id,
    connectorKey: feed.connector_key, config: feed.config,
    connectionConfig: feed.connection_config, version: feed.pinned_version ?? feed.definition_version,
    artifact: feed.selected_artifact_hash, mcpConfig: feed.mcp_config, device: feed.device_worker_id,
    authProfile: feed.auth_profile_id, appAuthProfile: feed.app_auth_profile_id,
    operations: feedOperations, readWindowAxis,
  })).digest('hex');
  if (p.sourceRevision && p.sourceRevision !== sourceRevision) {
    throw new ToolError('VALIDATION', 'Source configuration changed during the window read; restart the window.');
  }
  const finish = (result: ReadSourceFeedResult): ReadSourceFeedResult => {
    assertFeedReadWindow(result, p.window, readWindowAxis);
    return { ...result, sourceRevision };
  };
  if (!feedOperations.includes('read')) {
    throw new ToolError(
      'VALIDATION',
      `feed '${p.feedId}' does not support source reads`,
    );
  }
  if (p.match) {
    const matchPaths = Array.isArray(feed.match_paths) ? feed.match_paths : [];
    if (!matchPaths.includes(p.match.path)) {
      throw new ToolError('VALIDATION', `feed '${p.feedId}' cannot filter on '${p.match.path}'`);
    }
    if (p.match.values.length === 0) {
      throw new ToolError('VALIDATION', 'A feed match needs at least one value.');
    }
  }
  if (p.window && !readWindowAxis) {
    throw new ToolError(
      'VALIDATION',
      `feed '${p.feedId}' does not declare a source-time window axis`,
    );
  }

  const feedConfig = (feed.config ?? {}) as Record<string, unknown>;
  remainingReadMs(p);

  // Native device connectors (apple.*, os.shell, chrome.*, …) are
  // metadata-only on the server: there is no compiled bundle to run, so their
  // live reads are served natively over the device action queue. `runtime` is
  // descriptive; the absence of executable code is the deciding fact.
  // Bundled connectors may have no stored compiled_code, so include the bundle
  // catalog in that check.
  const hasConnectorCode =
    feed.has_compiled_code === true || findBundledConnectorFile(feed.connector_key) !== null;
  const metadataOnlyDeviceConnector = isMetadataOnlyDeviceConnector(
    feed.runtime,
    hasConnectorCode
  );
  // Compiled connectors can also drive a pinned browser. Gate before choosing
  // the reader; synchronous source reads cannot wait for owner approval.
  if (feed.device_worker_id !== null || metadataOnlyDeviceConnector) {
    const access = decideDeviceAccess(p.scope.chatAccess);
    if (access !== 'run') {
      throw new ToolError(
        'PERMISSION',
        access === 'refuse' ? DEVICE_ACCESS_REFUSED : DEVICE_READ_NEEDS_OWNER
      );
    }
  }
  // Preserve the existing active-only contract for ordinary source adapters.
  // A metadata-only device feed gets one exception: its canonical readiness
  // preflight may explain why reconciliation auto-paused it. It still cannot
  // dispatch while paused.
  if (feed.feed_status !== 'active' && !metadataOnlyDeviceConnector) {
    throw new ToolError('NOT_FOUND', `feed '${p.feedId}' not found or not accessible`);
  }

  if (p.match && (metadataOnlyDeviceConnector || !hasConnectorCode)) {
    throw new ToolError('VALIDATION', 'Only compiled connector feeds can filter source reads by match.');
  }

  if (p.recoveryId && !hasConnectorCode) throw new BrowserInterruptionError('recovery_unavailable', 'Recovery is only valid for its original compiled browser source read.');
  if (metadataOnlyDeviceConnector) {
    if (p.window) {
      throw new ToolError('VALIDATION', 'This device reader does not support source-time windows.');
    }
    remainingReadMs(p);
    return readDeviceFeed({
      organizationId: p.scope.organizationId,
      automationId: p.automationId,
      visibilityUserId: p.scope.principal,
      feedId: Number(feed.id),
      feedKey: feed.feed_key,
      // Same precedence as the compiled path below: connection config first,
      // feed config wins. No credentials — a device connector authenticates as
      // the logged-in desktop app, and the worker never receives secrets.
      feedConfig: mergeExecutionConfig(feed.connection_config, feedConfig),
      connectionId: Number(feed.connection_id),
      connectorKey: feed.connector_key,
      connectorVersion: feed.pinned_version ?? feed.definition_version,
      manifestHash: feed.selected_artifact_hash,
      connectorRuntime: feed.runtime,
      deviceOwnerUserId: feed.device_owner_user_id,
      deviceWorkerId: feed.device_worker_id,
      feedStatus: feed.feed_status,
      requiredCapability: feed.required_capability,
      query: p.query,
      cursor: p.cursor,
      limit: p.limit,
      offset: p.offset,
      sort: p.sort,
      signal: p.signal,
    });
  }

  const adapterResult = p.recoveryId ? null : await readSourceFeedFromAdapter({
    organizationId: p.scope.organizationId,
    connectionId: Number(feed.connection_id),
    connectorKey: feed.connector_key,
    feedKey: feed.feed_key,
    mcpConfig: feed.mcp_config,
    feedConfig,
    connectionConfig: feed.connection_config,
    query: p.query,
    cursor: p.cursor,
    window: p.window,
    limit: p.limit,
    offset: p.offset,
    sort: p.sort,
    signal: p.signal,
    deadlineAt: p.deadlineAt,
  });
  if (adapterResult) {
    return finish({ ...adapterResult, columns: adapterResult.columns ?? [] });
  }

  const compiledCode = await resolveConnectorCodeForKey(
    feed.connector_key,
    p.scope.organizationId,
    feed.pinned_version ?? feed.definition_version
  );

  const { credentials, connectionCredentials, sessionState, httpAuth, onHttpFetch } = await resolveExecutionAuth({
    organizationId: p.scope.organizationId,
    connectionId: feed.connection_id,
    authProfileId: Number(feed.auth_profile_id) || null,
    appAuthProfileId: Number(feed.app_auth_profile_id) || null,
    credentialDb: getDb(),
    logContext: { feedId: String(p.feedId) },
    logMessage: 'Failed to resolve feed source-read credentials',
  });

  // Same merge order as feed-sync / worker poll:
  // connection.config → credentials → feed config → egress.
  // Feed-level keys win so a feed can override connection-level settings.
  const config = {
    ...mergeExecutionConfig(feed.connection_config, connectionCredentials, feedConfig),
    ...dbEgressConfig(),
  };

  const timeoutMs = remainingReadMs(p);
  // Bundled cloud code can change before its catalog version is refreshed.
  // Bind the read/recovery to the exact bytes passed to the executor below.
  const artifactHash = computeCodeHash(compiledCode);
  const browser = createSourceReadBridge({ ...feed, selected_artifact_hash: artifactHash }, {
    scope: p.scope, automationId: p.automationId, feedId: p.feedId,
    deadlineAt: p.deadlineAt, flowId: p.flowId, recoveryId: p.recoveryId,
    onBrowserLease,
    requestHash: sourceRecoveryHash({ feedId: feed.id, revision: sourceRevision, artifact: artifactHash,
      query: p.query, cursor: p.cursor, limit: p.limit, offset: p.offset,
      sort: p.sort, window: p.window, match: p.match }),
    sourceSubscriptionScopeKey: sourceSubscription
      ? sourceFeedScopeKey(feed.config, feed.pinned_version ?? feed.definition_version) : undefined,
  }, p.signal);
  return browser.run(async () => {
    const result = await executeCompiledConnector({
      compiledCode,
      job: {
        mode: 'read',
        feedId: feed.id,
        feedKey: feed.feed_key,
        query: p.query,
        cursor: p.cursor,
        window: p.window,
        config,
        env: dbEgressConfig(),
        sessionState,
        browser: await connectionBrowserGrant(p.scope.organizationId, feed.connection_id, feed.pinned_version ?? feed.definition_version),
        credentials,
        httpAuth,
        limit: p.limit,
        offset: p.offset,
        sort: p.sort,
        match: p.match,
      },
      hooks: {
        onHttpFetch, signal: p.signal,
        onChromeDispatch: browser.onChromeDispatch,
      },
      timeoutMs,
    });

    if (result.mode !== 'read') {
      throw new Error(`Expected read result, got mode=${result.mode}`);
    }
    return finish({
      rows: result.rows,
      rowCursors: result.rowCursors,
      columns: result.columns ?? [],
      total: result.total,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      window: result.window,
    });
  });
}
