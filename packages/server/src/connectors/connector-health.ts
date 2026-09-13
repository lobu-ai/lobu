/**
 * Connector-health alerter.
 *
 * Per-feed hard auto-pause + `feed.auto_paused` covers feeds that keep failing
 * on run. It cannot catch a connector that has silently stopped scheduling
 * runs, an active connection that collects nothing, a whole connection whose
 * every feed is dead, or a connection where most feeds have been auto-paused
 * while one survivor masks them. Those failure modes used to surface to nobody
 * for weeks in prod (expired Revolut sessions, LinkedIn connection 412 dark
 * for 11 days, etc.).
 *
 * This module is a periodic, read-only scan over `connections` + `feeds` that
 * classifies each active connection as healthy or unhealthy by clear rules and
 * emits a structured `logger.error` for each NEWLY-unhealthy connection. That
 * `logger.error` is forwarded by the pino→Sentry bridge (`utils/logger.ts`) to
 * the existing Sentry→Slack alert path — no new alerting infra.
 *
 * ACL sync failures ride this same path: a connection whose ACL graph is
 * fail-closed (`authz_source_acl_state.freshness_state='failed'` — the ACL sync
 * cannot refresh membership, e.g. a dead token) is classified `acl_failed` and
 * alerts exactly once per episode under the same `unhealthy_alerted_at` claim.
 * The persisted reason (`connections.error_message`, `acl: …`) rides along as
 * `last_error`.
 *
 * Multi-replica safety: registered as a single-claimant scheduled job (one
 * claimant per tick via the runs-queue), AND the per-connection dedupe is
 * Postgres-mediated — `connections.unhealthy_alerted_at` is flipped NULL→now()
 * by an atomic conditional UPDATE, so the alert fires exactly once on the
 * transition into unhealthy (re-armed by a NULL reset on recovery). No per-pod
 * in-memory state is read or mutated across replicas.
 *
 * ## Relationship to `feed-health-semantics`
 *
 * Per-feed `execution_mode` / `attention` are DERIVED by
 * `deriveFeedHealthSemantics` at read time and surfaced by `list_feeds`. This
 * alerter consumes that module for the two classifications that are ground
 * truth on the row — which feeds can run a collector sync at all, and whether
 * the connection is waiting on human sign-in:
 *
 * - **Expected feeds** (the denominator every rule is measured against) are the
 *   feeds whose selected definition declares `sync`, excluding chat feeds
 *   stored in `channel_messages`, operator-paused-clean feeds, and feeds whose
 *   connection is waiting on auth. Counting non-sync feeds as live collector
 *   capabilities dilutes the degraded ratio and distorts `no_recent_sync`.
 * - **`needs_auth` feeds are excluded**: the user must sign in, which is not an
 *   infra incident, and the user-facing notification for that transition
 *   already fires from `worker-api/run-lifecycle` when the browser session goes
 *   unusable. The `isBrowserAuthExpiredError` fallback below still covers the
 *   other shape — a connector that fails with a session-expired error while its
 *   auth profile is still marked active.
 * - **Device liveness** is a new failing signal: a connection pinned to a device
 *   worker that has not polled for `deviceOfflineHours` is collecting nothing,
 *   which this scan previously could not see until the 7-day `no_recent_sync`
 *   rule (and only if the feed had ever succeeded).
 * - Rule C (`no_recent_sync`) measures the newest successful sync across
 *   EXPECTED feeds only, so a feed that cannot sync can no longer mask a dead
 *   capability.
 *
 * ## Why `execution_mode === 'scheduled'` is NOT the expected predicate
 *
 * `deriveFeedHealthSemantics` calls a sync-capable feed without a cron in
 * `feeds.schedule` `no_schedule`, and that label carries no dispatch meaning.
 * It is tempting to read "no cron" as "human-triggered, so a failure is
 * user-visible and never an unattended incident" — which holds for Midas but
 * does not generalise: measured on prod 2026-08-12, 196 of 215
 * active sync-capable feeds have NO `schedule`, yet many run unattended through
 * other dispatch paths (github `issue_comments`: 4551 sync runs in 14 days with
 * `schedule` and `next_run_at` both NULL; linkedin `home_feed` ~hourly; gmail
 * `threads` ~every 2.6h). Replaying both predicates over that snapshot, gating
 * this scan on `execution_mode === 'scheduled'` drops its coverage from 43
 * connections to 14 and silences the exact shape it exists for (connection 412,
 * 10 of 11 feeds failing) — so `schedule` is deliberately not read here.
 * `schedule` alone therefore cannot be this scan's predicate, and still is not.
 * (`deriveFeedHealthSemantics` used to publish an `incidentEligible` flag built
 * on that same inference. Nothing consumed it and it disagreed with this scan,
 * so it was deleted — the paging decision lives here, in the one place that
 * acts on it.)
 *
 * What HAS changed since that measurement is the signal, not the reasoning.
 * `feeds_schema[key].webhook` positively identifies the event-driven half, so
 * `attention='no_trigger'` can name a feed with no dispatch path at all
 * without inferring intent from a missing cron — see the semantics module's
 * header. It is deliberately NOT excluded from `expected` below; see the note
 * at `classifyFeed` for why that stays a separate, evidence-backed decision.
 */

import type { FeedOperation } from '@lobu/connector-sdk';
import { type DbClient, getDb, tsTimeOrNull } from '../db/client';
import { notifyBrowserAuthExpired } from '../notifications/triggers';
import logger from '../utils/logger';
import { aclConnectionIdSql, isAclErrorMessage } from '../authz/acl-observability';
import { deriveFeedHealthSemantics, feedWebhookDrivenSql } from './feed-health-semantics';

/**
 * Does this feed error look like an expired/invalid site session (the user must
 * re-login), rather than infra/transport (offline device, network, 5xx)? Used
 * to fire a user-facing "needs sign-in" notification on top of the operator
 * alert. Kept deliberately tight so device-offline ("No online paired Owletto
 * Chrome extension …") and generic failures are NOT misclassified as auth.
 */
const AUTH_EXPIRED_RE =
  /(sign[\s-]?in|\bsso\b|re-?auth|reauthenticat|session\s+(?:expired|needs|invalid|timed)|cookies?[\s\S]{0,30}expired|authentication\s+failed|unauthor|login\s+required|not\s+logged\s*in)/i;

export function isBrowserAuthExpiredError(lastError: string | null | undefined): boolean {
  return !!lastError && AUTH_EXPIRED_RE.test(lastError);
}

/**
 * A feed is "failing" if its most recent sync failed OR it has accumulated at
 * least this many consecutive failures.
 */
const FAILURE_THRESHOLD = 3;

/**
 * Don't flag a connection until it has had time to do its first sync. A
 * just-created connection with no successful sync yet is not "dying".
 */
const MIN_CONNECTION_AGE_HOURS = 24;

/**
 * An active connection with zero non-deleted feeds older than this is
 * collecting nothing and is flagged. (Consent-only / managed-grant connections
 * legitimately have no feeds, but they are not `status='active'` collectors —
 * see scoping in the query.)
 */
const ZERO_FEEDS_GRACE_HOURS = 48;

/**
 * A connection that was collecting (at least one feed has a past successful
 * sync) but whose newest successful sync across all feeds is older than this is
 * flagged as "stopped collecting".
 */
const NO_SYNC_DAYS = 7;

/**
 * Fraction of the feeds a connection is still expected to run that must be
 * PERSISTENTLY failing before the connection is "degraded" — sick even though
 * at least one feed still works.
 *
 * Why a proportion and not "any failing feed": a single transiently-failing
 * feed alongside nine healthy ones is normal operational noise, and alerting on
 * it would make the signal useless. Why 0.5: a connection collecting less than
 * half of what it is configured to collect is materially broken. Prod LinkedIn
 * connection 412 sat at 10/11 = 0.91 for eleven days while reporting fully
 * healthy.
 *
 * This ratio ALONE is not enough: it is trivially reachable on a tiny
 * connection (1 of 2 expected feeds failing is exactly 0.5 and fires), which
 * would page an operator for a single bad feed. `DEGRADED_MIN_EXPECTED_FEEDS`
 * below is what keeps that quiet — see its docstring.
 */
const DEGRADED_FAILING_RATIO = 0.5;

/**
 * Minimum number of expected feeds (feeds the operator has NOT deliberately
 * paused) a connection must have before the degraded rule may fire at all.
 *
 * A ratio is meaningless at small denominators. With 2 expected feeds, one
 * persistently-failing feed is 1/2 = 0.5 and clears `DEGRADED_FAILING_RATIO`
 * — so without this floor every 2-feed connection with one bad feed pages an
 * operator, which is exactly the alert fatigue the degraded rule exists to
 * avoid. At 3 expected feeds the cheapest way to reach the ratio is 2 of 3
 * feeds persistently failing, which is a real outage rather than one flaky
 * feed.
 *
 * The floor does NOT weaken coverage of the case this rule was built for: prod
 * LinkedIn 412 has 11 expected feeds with 10 failing. And a small connection
 * whose feeds ALL fail is still caught — by Rule A (`all_feeds_failing`), which
 * has no floor. What the floor gives up is exactly one shape: a 1-or-2-feed
 * connection that is partly (not wholly) failing. That is deliberate.
 *
 * Pinned by 'does not flag a 2-feed connection with one persistently failing
 * feed' and 'flags a 3-feed connection at the degraded ratio' in
 * `__tests__/integration/connector-health-alert.test.ts`.
 */
const DEGRADED_MIN_EXPECTED_FEEDS = 3;

/**
 * How long a connection's pinned device worker must have been silent before
 * its feeds count as failing here.
 *
 * This is deliberately NOT `DEVICE_ONLINE_WINDOW_SECONDS` (120s). That window
 * answers "can a dispatch right now be claimed" — the right question for a UI
 * chip or a dispatch guard, and the one `deriveFeedHealthSemantics` answers
 * with `attention='device_offline'`. It is the wrong question for a pager: this
 * scan runs every 15 minutes, so a 120s window would flag every device-pinned
 * connection whose owner closed their laptop, then re-flag on the next sleep.
 * Two days of silence is not a sleeping laptop — it is a device that stopped
 * collecting — and it still detects the outage days before the 7-day
 * `no_recent_sync` rule (which needs a past successful sync to fire at all).
 */
const DEVICE_OFFLINE_HOURS = 48;

export interface ConnectorHealthConfig {
  failureThreshold: number;
  minConnectionAgeHours: number;
  zeroFeedsGraceHours: number;
  noSyncDays: number;
  degradedFailingRatio: number;
  degradedMinExpectedFeeds: number;
  deviceOfflineHours: number;
}

export const DEFAULT_CONNECTOR_HEALTH_CONFIG: ConnectorHealthConfig = {
  failureThreshold: FAILURE_THRESHOLD,
  minConnectionAgeHours: MIN_CONNECTION_AGE_HOURS,
  zeroFeedsGraceHours: ZERO_FEEDS_GRACE_HOURS,
  noSyncDays: NO_SYNC_DAYS,
  degradedFailingRatio: DEGRADED_FAILING_RATIO,
  degradedMinExpectedFeeds: DEGRADED_MIN_EXPECTED_FEEDS,
  deviceOfflineHours: DEVICE_OFFLINE_HOURS,
};

export type UnhealthyReason =
  | 'all_feeds_failing'
  | 'feeds_degraded'
  | 'zero_feeds'
  | 'no_recent_sync'
  | 'acl_failed';

export interface UnhealthyConnection {
  connectionId: number;
  organizationId: string;
  connectorKey: string;
  displayName: string | null;
  reason: UnhealthyReason;
  feedCount: number;
  failingFeedCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface ConnectorHealthResult {
  scanned: number;
  unhealthy: number;
  /** Connections that transitioned into unhealthy on THIS run (alerts fired). */
  newlyAlerted: number;
  /** Connections that recovered on THIS run (marker re-armed). */
  recovered: number;
  /** Newly-unhealthy connections whose failure was an expired site session,
   * for which a user-facing "needs sign-in" notification was sent. */
  authNotified: number;
  details: UnhealthyConnection[];
}

interface HealthDeps {
  sql?: DbClient;
  config?: ConnectorHealthConfig;
  now?: () => number;
  /** Injectable for tests; defaults to the real browser-auth-expired trigger. */
  notifyAuthExpired?: typeof notifyBrowserAuthExpired;
}

/**
 * One non-deleted feed of an active connection, joined with every field
 * `deriveFeedHealthSemantics` needs plus the connection-level identifiers. A
 * connection with zero feeds still yields one row (all feed columns NULL) so
 * the `zero_feeds` rule can fire; every connection is otherwise represented by
 * one row per feed.
 */
interface FeedHealthRow {
  connection_id: string;
  organization_id: string;
  connector_key: string;
  display_name: string | null;
  connection_created_at: Date | string;
  connection_status: string | null;
  credential_mode: string | null;
  /** Whether the selected definition declares a sync operation that Lobu can
   *  create without user-supplied instance config. A zero-feed row necessarily
   *  selects the active definition. NULL means no selectable definition was
   *  found, preserving the fail-closed zero-feed alert. */
  connector_has_auto_syncable_feeds: boolean | null;
  auth_profile_status: string | null;
  /** Device pinned but silent for longer than `cfg.deviceOfflineHours`, or its
   *  worker row is gone entirely. */
  device_stale: boolean | null;
  feed_id: string | null;
  operations: FeedOperation[] | null;
  /** Connector declares a webhook route for this feed key — the dispatch path
   *  that re-arms `next_run_at` without a cron. */
  webhook_driven: boolean | null;
  store: 'events' | 'channel_messages' | null;
  feed_status: string | null;
  schedule: string | null;
  last_sync_status: string | null;
  last_sync_at: Date | string | null;
  consecutive_failures: string;
  last_error: string | null;
  acl_state_failed: boolean;
  connection_error_message: string | null;
}

/**
 * The detection query. Read-only. Returns per-feed rows for every active,
 * non-deleted connection past the min-age grace window (one row per feed, or a
 * single null-feed row for a zero-feed connection), so the JS classifier can
 * run `deriveFeedHealthSemantics` per feed and aggregate per connection.
 *
 * Chat connections share the table with collector connections. Their streaming
 * channel feeds are never expected, and a chat connection with no feeds is not
 * a zero-feed collector incident (`credential_mode` is the chat-row marker).
 */
async function loadConnectionHealthRows(
  sql: DbClient,
  cfg: ConnectorHealthConfig
): Promise<FeedHealthRow[]> {
  return (await sql`
    SELECT
      c.id AS connection_id,
      c.organization_id,
      c.connector_key,
      c.display_name,
      c.created_at AS connection_created_at,
      c.status AS connection_status,
      c.credential_mode,
      cd.has_auto_syncable_feeds AS connector_has_auto_syncable_feeds,
      ap.status AS auth_profile_status,
      -- Fails CLOSED on a missing/blank worker row: a connection pinned to a
      -- worker that is no longer there is collecting nothing either. (The FK is
      -- ON DELETE SET NULL and the reaper refuses to delete a worker a live
      -- connection references, so this is a guard, not a live path.)
      (
        c.device_worker_id IS NOT NULL
        AND (
          dw.id IS NULL
          OR dw.last_seen_at IS NULL
          OR dw.last_seen_at < now() - make_interval(hours => ${cfg.deviceOfflineHours})
        )
      ) AS device_stale,
      f.id AS feed_id,
      cd.feed_operations AS operations,
      cd.feed_webhook_driven AS webhook_driven,
      CASE WHEN f.config ->> 'store' = 'channel_messages' THEN 'channel_messages' ELSE 'events' END AS store,
      f.status AS feed_status,
      f.schedule,
      f.last_sync_status,
      f.last_sync_at,
      f.consecutive_failures,
      f.last_error,
      -- Fails CLOSED: the connection's ACL graph is fail-closed. The ACL sync
      -- stamps freshness_state='failed' on authz_source_acl_state when it cannot
      -- refresh membership (dead token, OAuth consent never completed) — a
      -- failure mode with no feed symptom. Select the connection's actual ACL
      -- id shape so a data slug cannot collide with a chat runtime id. The
      -- cleanup migration mirrors this predicate.
      -- Consent-only GITHUB grant-holders are excluded: runGithubAclSyncTick
      -- does not sweep them, so a retained failed row there is frozen history,
      -- not a live refresh failure. The row is deliberately kept -- it is what
      -- keeps any already-synced events fenced -- but it can never clear, so
      -- alerting on it would mark a healthy connection unhealthy forever with
      -- nothing an operator could do about it. Scoped to the one sweep that
      -- actually skips these rows: the Slack tick still sweeps consent-only
      -- connections, so a failure it records IS live and must still alert.
      -- Written as OR/IS DISTINCT FROM rather than NOT(... AND ...): config is
      -- nullable, and NOT (true AND NULL) evaluates to NULL, which would have
      -- dropped the alert for every connection whose config is unset.
      (
        c.connector_key <> 'github'
        OR c.config ->> 'consent_only' IS DISTINCT FROM 'true'
      )
      AND EXISTS (
        SELECT 1
        FROM public.authz_source_acl_state a
        WHERE a.organization_id = c.organization_id
          AND a.freshness_state = 'failed'
          AND a.connection_id = ${sql.unsafe(aclConnectionIdSql('c'))}
      ) AS acl_state_failed,
      c.error_message AS connection_error_message
    FROM connections c
    LEFT JOIN feeds f
      ON f.connection_id = c.id
     AND f.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(definition.feeds_schema -> f.feed_key -> 'operations', '[]'::jsonb)
          AS feed_operations,
        -- Shared with list_feeds; see feedWebhookDrivenSql for why a bare
        -- IS NOT NULL on the webhook key is not equivalent.
        ${sql.unsafe(feedWebhookDrivenSql('definition', 'f'))} AS feed_webhook_driven,
        EXISTS (
          SELECT 1
          FROM jsonb_each(COALESCE(definition.feeds_schema, '{}'::jsonb)) AS declared(feed_key, config)
          WHERE COALESCE(declared.config -> 'operations', '[]'::jsonb) @> '["sync"]'::jsonb
            AND COALESCE((declared.config ->> 'userManaged')::boolean, false) = false
        ) AS has_auto_syncable_feeds
      FROM connector_definitions definition
      WHERE definition.key = c.connector_key
        AND definition.organization_id = c.organization_id
        AND (
          (f.pinned_version IS NULL AND definition.status = 'active')
          OR (
            f.pinned_version IS NOT NULL
            AND (definition.version = f.pinned_version OR definition.status = 'active')
          )
        )
      ORDER BY (definition.version = f.pinned_version) DESC,
               (definition.status = 'active') DESC,
               definition.updated_at DESC,
               definition.id DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    WHERE c.status = 'active'
      AND c.deleted_at IS NULL
      AND c.created_at <= now() - make_interval(hours => ${cfg.minConnectionAgeHours})
    ORDER BY c.id, f.id
  `) as unknown as FeedHealthRow[];
}

/**
 * Per-feed classification consumed by the connection-level rules. WHICH feeds
 * count comes from the shared semantics module — a feed that cannot run a
 * collector sync or whose connection is waiting on
 * sign-in (`needs_auth`) is not a live capability, so it cannot be part of any
 * numerator or denominator here.
 *
 * The numeric failing/persistent thresholds stay alerter-owned. The semantics
 * module collapses operator-pause and auto-pause into a single `paused`
 * attention state, but an auto-paused feed (paused BECAUSE it kept failing) is
 * the SYMPTOM the degraded rule exists to catch, so pause intent is read from
 * the row here rather than from `attention`.
 */
interface ClassifiedFeed {
  /** A live capability: a feed that can actually sync, is not a chat store,
   *  is not operator-paused-clean, and is not waiting on human
   *  sign-in. Only these count toward the expected denominator and Rules A/C. */
  expected: boolean;
  /** Expected feed that is currently failing: last attempt failed, a failure
   *  episode is underway, OR its pinned device has been silent past
   *  `cfg.deviceOfflineHours`. */
  failing: boolean;
  /** Expected feed failing PERSISTENTLY (past the failure threshold) or on a
   *  long-silent device — the only signal that feeds the degraded ratio, so one
   *  transiently failing feed on a small connection stays quiet. */
  persistent: boolean;
}

function classifyFeed(row: FeedHealthRow, cfg: ConnectorHealthConfig): ClassifiedFeed {
  const cf = Number(row.consecutive_failures ?? 0);
  const semantics = deriveFeedHealthSemantics({
    operations: row.operations,
    store: row.store,
    status: row.feed_status,
    schedule: row.schedule,
    webhook_driven: row.webhook_driven,
    last_sync_status: row.last_sync_status,
    last_sync_at: row.last_sync_at,
    consecutive_failures: cf,
    connection_status: row.connection_status,
    auth_profile_status: row.auth_profile_status,
  });

  const operatorPausedClean = row.feed_status === 'paused' && cf === 0;
  const syncable = row.operations?.includes('sync') === true;
  // `no_trigger` is deliberately NOT excluded here, though the argument for
  // excluding it is easy to make (the feed cannot sync, so counting it lets
  // Rule C report a working connector as stale). Whether a dispatch-less feed
  // is worth paging about is a paging decision, and this file's header records
  // that such decisions are made here against prod measurements of what
  // actually fires — which this change does not have. The feed-level
  // `attention` is what surfaces the state to an operator; changing who gets
  // paged is a separate, evidence-backed change.
  const expected =
    syncable && semantics.attention !== 'needs_auth' && !operatorPausedClean;

  // A connection pinned to a device worker that has been silent for days is
  // collecting nothing, however healthy its stored sync columns look. See
  // `DEVICE_OFFLINE_HOURS` for why this is not the semantics module's
  // dispatch-grade 120s `attention='device_offline'`.
  const deviceStale = row.device_stale === true;

  // Failing: a single most-recent-run failure counts (Rule A must stay
  // sensitive to one bad run), past the persistent threshold, OR the pinned
  // device went silent. Auto-paused feeds with cf > 0 are symptoms and count.
  const failing =
    expected &&
    (row.last_sync_status === 'failed' || cf >= cfg.failureThreshold || deviceStale);

  const persistent = expected && (cf >= cfg.failureThreshold || deviceStale);

  return { expected, failing, persistent };
}

/**
 * Per-connection aggregation over the classified feeds. Returns the tripped
 * rule plus the aggregate detail an alert carries, or null if healthy. Order
 * matters: zero-feeds is checked before all-feeds-failing (which is vacuously
 * true with zero feeds).
 */
function classify(
  rows: FeedHealthRow[],
  cfg: ConnectorHealthConfig,
  nowMs: number
): {
  reason: UnhealthyReason;
  feedCount: number;
  failingFeedCount: number;
  newestSyncAt: string | null;
  lastError: string | null;
} | null {
  const feeds = rows.filter((r) => r.feed_id != null);
  const feedCount = feeds.length;

  // ACL failure has no feed symptom, so it takes precedence over feed rules.
  if (rows[0]?.acl_state_failed === true) {
    const lastError = isAclErrorMessage(rows[0].connection_error_message)
      ? rows[0].connection_error_message
      : null;
    return {
      reason: 'acl_failed',
      feedCount,
      failingFeedCount: 0,
      newestSyncAt: null,
      lastError,
    };
  }

  // Rule B: active connection that should have an automatically-created
  // collector feed but has zero non-deleted feeds after the longer zero-feed
  // grace window.
  if (feedCount === 0) {
    // Chat rows are transports, not collectors. A channel-less chat connection
    // must not trip the collector-only zero-feed rule.
    if (rows[0]?.credential_mode != null) return null;
    // Operation-only, source-only, and user-managed-only connectors
    // legitimately have no automatic collector rows. If the definition is
    // missing, keep the alert fail-closed instead of hiding an install problem.
    if (rows[0]?.connector_has_auto_syncable_feeds === false) return null;
    const createdAtMs = tsTimeOrNull(rows[0]?.connection_created_at);
    if (
      createdAtMs !== undefined &&
      nowMs - createdAtMs < cfg.zeroFeedsGraceHours * 60 * 60 * 1000
    ) {
      return null;
    }
    return {
      reason: 'zero_feeds',
      feedCount: 0,
      failingFeedCount: 0,
      newestSyncAt: null,
      lastError: null,
    };
  }

  let expectedCount = 0;
  let failingExpectedCount = 0;
  let persistentCount = 0;
  let newestSyncAtMs: number | null = null;
  let failingError: string | null = null;
  let expectedError: string | null = null;

  for (const row of feeds) {
    const feed = classifyFeed(row, cfg);
    if (!feed.expected) continue;

    expectedCount += 1;
    if (!expectedError && row.last_error) expectedError = row.last_error;
    if (feed.failing) {
      failingExpectedCount += 1;
      if (!failingError && row.last_error) failingError = row.last_error;
    }
    if (feed.persistent) persistentCount += 1;

    if (row.last_sync_status === 'success' && row.last_sync_at) {
      const syncMs = tsTimeOrNull(row.last_sync_at);
      if (syncMs !== undefined && (newestSyncAtMs === null || syncMs > newestSyncAtMs)) {
        newestSyncAtMs = syncMs;
      }
    }
  }

  const lastError = failingError ?? expectedError;

  // A connection whose only feeds are deliberately paused (cf=0), read-only,
  // streaming, or auth-waiting is NOT unhealthy — operator intent, on-demand
  // evaluation, or a sign-in the user must complete, none of which is a dead
  // collector.
  if (expectedCount === 0) return null;

  // Rule A: every feed the operator still EXPECTS to run is failing. The
  // numerator counts a single bad run so a connection whose every expected feed
  // just failed is not silent until the counters climb.
  let reason: UnhealthyReason;
  if (failingExpectedCount === expectedCount) {
    reason = 'all_feeds_failing';
  } else if (
    expectedCount >= cfg.degradedMinExpectedFeeds &&
    persistentCount / expectedCount >= cfg.degradedFailingRatio
  ) {
    // Rule D: a substantial proportion of expected feeds are failing
    // PERSISTENTLY, but at least one survivor keeps Rule A from firing (prod
    // LinkedIn 412 shape).
    reason = 'feeds_degraded';
  } else if (
    newestSyncAtMs !== null &&
    nowMs - newestSyncAtMs > cfg.noSyncDays * 24 * 60 * 60 * 1000
  ) {
    // Rule C: was collecting but stopped — newest successful sync across
    // EXPECTED feeds is older than NO_SYNC_DAYS. Scoped to expected feeds so a
    // feed that can never sync cannot keep the timestamp fresh forever.
    reason = 'no_recent_sync';
  } else {
    return null;
  }

  return {
    reason,
    feedCount,
    failingFeedCount: failingExpectedCount,
    newestSyncAt: newestSyncAtMs === null ? null : new Date(newestSyncAtMs).toISOString(),
    lastError,
  };
}

/**
 * Run one connector-health scan. Emits a `logger.error` per newly-unhealthy
 * connection (transition into unhealthy), re-arms the marker for recovered
 * connections, and is a no-op alert-wise for connections that are still
 * unhealthy from a prior run.
 */
export async function runConnectorHealthCheck(
  deps: HealthDeps = {}
): Promise<ConnectorHealthResult> {
  const sql = deps.sql ?? getDb();
  const cfg = deps.config ?? DEFAULT_CONNECTOR_HEALTH_CONFIG;
  const nowMs = (deps.now ?? (() => Date.now()))();
  const notifyAuthExpired = deps.notifyAuthExpired ?? notifyBrowserAuthExpired;

  const rows = await loadConnectionHealthRows(sql, cfg);

  const result: ConnectorHealthResult = {
    scanned: new Set(rows.map((r) => r.connection_id)).size,
    unhealthy: 0,
    newlyAlerted: 0,
    recovered: 0,
    authNotified: 0,
    details: [],
  };

  // The query returns one row per feed (or a single null-feed row for a
  // zero-feed connection). Group by connection so the classifier sees the whole
  // feed set before deciding.
  const byConnection = new Map<string, FeedHealthRow[]>();
  for (const row of rows) {
    const group = byConnection.get(row.connection_id);
    if (group) group.push(row);
    else byConnection.set(row.connection_id, [row]);
  }

  for (const [connectionIdStr, connectionRows] of byConnection) {
    const first = connectionRows[0];
    const connectionId = Number(connectionIdStr);
    const classified = classify(connectionRows, cfg, nowMs);

    if (!classified) {
      // Healthy: re-arm the alert if it was previously flagged. The conditional
      // WHERE makes this a no-op for connections that were already healthy, and
      // counts a real recovery exactly once across replicas.
      const cleared = (await sql`
        UPDATE connections
        SET unhealthy_alerted_at = NULL, updated_at = now()
        WHERE id = ${connectionId}
          AND unhealthy_alerted_at IS NOT NULL
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      if (cleared.length > 0) result.recovered += 1;
      continue;
    }

    const { reason } = classified;
    result.unhealthy += 1;

    const detail: UnhealthyConnection = {
      connectionId,
      organizationId: first.organization_id,
      connectorKey: first.connector_key,
      displayName: first.display_name,
      reason,
      feedCount: classified.feedCount,
      failingFeedCount: classified.failingFeedCount,
      lastSyncAt: classified.newestSyncAt,
      lastError: classified.lastError,
    };
    result.details.push(detail);

    // Transition claim: only the replica whose UPDATE actually flips the marker
    // NULL→now() owns the alert. Concurrent ticks on other replicas get zero
    // rows back and stay silent — Postgres-mediated, no in-memory dedupe.
    const claimed = (await sql`
      UPDATE connections
      SET unhealthy_alerted_at = now(), updated_at = now()
      WHERE id = ${connectionId}
        AND unhealthy_alerted_at IS NULL
      RETURNING id
    `) as unknown as Array<{ id: string }>;

    if (claimed.length === 0) continue; // already alerted on a prior tick

    result.newlyAlerted += 1;

    // The alert. logger.error → pino→Sentry bridge → Sentry→Slack. A stable
    // `msg` keeps Sentry grouping per reason; the structured fields carry the
    // org/connector identifiers an operator needs to act.
    logger.error(
      {
        connection_id: connectionId,
        organization_id: first.organization_id,
        connector_key: first.connector_key,
        connection_display_name: first.display_name,
        reason,
        feed_count: detail.feedCount,
        failing_feed_count: detail.failingFeedCount,
        last_successful_sync_at: detail.lastSyncAt,
        last_error: detail.lastError,
      },
      `[connector-health] connector unhealthy (${reason}): ${first.connector_key}`
    );

    // On the unhealthy transition, if the failure is an expired site session
    // (not an offline device / transport error), also notify the org's admins
    // to re-login — the operator alert above can't reach the person who has to
    // sign in. Deduped by the same unhealthy_alerted_at claim, so it fires once
    // per episode. Best-effort: a notification failure must not break the scan.
    if (reason !== 'acl_failed' && isBrowserAuthExpiredError(detail.lastError)) {
      try {
        await notifyAuthExpired({
          orgId: first.organization_id,
          connectionId,
          connectorKey: first.connector_key,
        });
        result.authNotified += 1;
      } catch (err) {
        logger.warn(
          { err, connection_id: connectionId },
          '[connector-health] failed to send browser-auth-expired notification'
        );
      }
    }
  }

  return result;
}
