/**
 * Derived CONNECTION-health semantics.
 *
 * The connection-level counterpart to `deriveFeedHealthSemantics`, and it
 * follows the same rule: DERIVED from the stored connection/feed columns at
 * read time, never stored. See that module's header for why — storing a
 * classification duplicates state that already lives on the row and drifts when
 * the source columns move.
 *
 * ## Why this exists
 *
 * `connections.status` records OPERATOR INTENT: `active` is written once at
 * INSERT and means "nobody has paused or deleted this". It has never meant
 * "this works". Nothing anywhere recorded observed reality, so a connection
 * that cannot collect anything was indistinguishable from one collecting
 * thousands of events an hour.
 *
 * Measured on prod 2026-09-15, three shapes this module exists to separate, all
 * of them `status='active'` and all reported healthy beforehand:
 *   - a browser-backed connection with 0 feeds and 0 runs, created and
 *     abandoned mid-setup;
 *   - one with 14 feeds, every one paused with no schedule for two months;
 *   - one genuinely collecting, ~1 event per push.
 * `connector-health.ts` classified all three the same way: healthy. Across the
 * whole estate it read 124 connections as fine; this module finds 66 of them
 * wanting attention.
 *
 * ## The fold
 *
 * A connection verdict is a FOLD of its feeds' verdicts plus the zero-feed
 * case. It deliberately does not re-derive anything a feed already decides —
 * the caller passes `deriveFeedHealthSemantics` output straight in, so the two
 * surfaces cannot disagree about the same feed. Only collector feeds
 * (`scheduled` / `no_schedule`) are folded; `streaming` and `source_only` have
 * no sync lifecycle to roll up, exactly as `classifyFeed` already excludes them
 * from its expected set.
 *
 * Reading the feed set is O(feeds-per-connection) over a bounded config table,
 * which is the allowed shape. This module must never reach into `runs` or
 * `events` — those grow without bound and the answer would not.
 *
 * ## `never_collected` folds the feed-level `never_run`, it does not re-derive
 *
 * A connection has never worked when every collector feed reports `never_run`.
 * That reuses the feed module's own definition rather than inventing a second
 * one, so the two can never disagree about the same row.
 *
 * Cumulative `feeds.items_collected` is deliberately NOT consulted, in either
 * direction. Zero is not a defect: a mailbox label with no mail syncs cleanly
 * and collects zero forever. Non-zero is not health either — a prod feed
 * measured 2026-09-15 had collected 74 items across 27 runs and had never once
 * completed a successful sync, so an item count would have called it healthy
 * while it sat stuck.
 * `connector-health.ts` keys its own never-started rule the same way.
 *
 * ## There are deliberately no grace periods here
 *
 * `MIN_CONNECTION_AGE_HOURS` and the old `ZERO_FEEDS_GRACE_HOURS` are paging
 * decisions, and this module does not make those — same boundary the feed-level
 * header draws around `incidentEligible`. "This connection has no feeds" is
 * true the instant it is true, and a UI should say so immediately rather than
 * 48 hours later. Whether it is worth waking someone lives in
 * `connectors/connector-health.ts`, the one place that acts on it.
 */

import {
  type FeedHealthSemantics,
  deriveFeedHealthSemantics,
} from './feed-health-semantics';

/**
 * What a human/UI should be told about a connection right now, ordered so the
 * most actionable state wins.
 *
 * - `needs_auth` — the connection itself is unusable until someone signs in.
 * - `misconfigured` — the connection is in an error state.
 * - `no_feeds` — a collector connection with NO feed rows at all. Setup stopped
 *   after the connection row was written. A connection whose only feeds are
 *   streaming or source-only is not this: it has feeds, just nothing to roll up.
 * - `no_trigger` — every collector feed has a dispatch path of none. Ranked
 *   above `never_collected` for the reason the feed-level module ranks
 *   `no_trigger` above `never_run`: this states the cause, that states the
 *   symptom.
 * - `never_collected` — collector feeds exist and can be dispatched, but not one
 *   of them has ever completed a sync.
 * - `degraded` — some, but not all, collector feeds need attention.
 * - `paused` — every collector feed is paused. Not running until resumed.
 * - `healthy` — everything else.
 */
export type ConnectionAttentionState =
  | "healthy"
  | "paused"
  | "needs_auth"
  | "no_feeds"
  | "no_trigger"
  | "never_collected"
  | "degraded"
  | "misconfigured";

export interface ConnectionHealthSemanticsInput {
  /** `connections.status` — 'active' | 'paused' | 'error' | 'revoked' | 'pending_auth'. */
  status?: string | null;
  /**
   * `connections.credential_mode` — non-null marks a chat transport row. Chat
   * connections are transports, not collectors, so the collector-only verdicts
   * (`no_feeds`, `never_collected`) must never fire for one. Mirrors the guard
   * `connector-health.ts` already applies before its zero-feed rule.
   */
  credential_mode?: string | null;
  /**
   * `connections.config.consent_only` — the connection holds an OAuth grant for
   * cloud-delegated token fetch and MUST have no feeds: the member's data lives
   * only on their local instance, and `manage_feeds` refuses feeds on one. Zero
   * feeds is the designed state here, never an install problem.
   */
  consent_only?: boolean | null;
  /**
   * Whether the selected connector definition declares any auto-syncable feed.
   * Operation-only, source-only and user-managed-only connectors legitimately
   * have no collector rows, and `no_feeds` is meaningless for them. Left
   * undefined the check fails CLOSED (treated as "should have feeds"), so an
   * install problem surfaces rather than hides.
   */
  connector_has_auto_syncable_feeds?: boolean | null;
  /**
   * Every non-deleted feed on this connection, each already run through
   * `deriveFeedHealthSemantics` — never a hand-built verdict.
   */
  feeds: readonly FeedHealthSemantics[];
}

/**
 * Collector feeds only. `streaming` (chat transcripts) and `source_only`
 * (read-on-demand) have no sync lifecycle, so folding them would dilute every
 * ratio below — the same reason `classifyFeed` keeps them out of its expected
 * set.
 */
function isCollector(feed: FeedHealthSemantics): boolean {
  return (
    feed.executionMode === "scheduled" || feed.executionMode === "no_schedule"
  );
}

/**
 * Does this feed's verdict count against its connection?
 *
 * Everything except `healthy` does, with ONE exception. `overdue` is derived
 * from `active_runs`, which this rollup cannot supply: counting active runs per
 * feed means aggregating `runs` — unbounded history — on a list request path.
 * `list_feeds` does supply it and suppresses `overdue` while a sync is in
 * flight, so folding it here would let a connection report `degraded` about the
 * very feed the feed page reports healthy. Ignored instead, which keeps this
 * module's omissions one-directional: like the `device_connector_readiness`
 * omission below, it can understate a feed's attention and can never invent
 * one. A feed that has genuinely stalled still reaches a human through
 * `connector-health.ts`'s `no_recent_sync` rule, which reads `last_sync_at` and
 * needs no run count.
 *
 * Stated as an explicit exception rather than a listed set of bad states so a
 * state added to `FeedAttentionState` cannot silently read as healthy here.
 */
function contributesAttention(feed: FeedHealthSemantics): boolean {
  return feed.attention !== "healthy" && feed.attention !== "overdue";
}

/**
 * Fold a connection's feed verdicts into one connection verdict. Pure: the
 * caller supplies the connection row fields and its already-derived feed
 * semantics. Order of checks fixes precedence (most actionable wins).
 */
export function deriveConnectionHealthSemantics(
  input: ConnectionHealthSemanticsInput
): ConnectionAttentionState {
  const collectors = input.feeds.filter(isCollector);
  const expectedFeedCount = collectors.length;
  const attentionFeedCount = collectors.filter(contributesAttention).length;

  // Connection-level blockers outrank anything a feed can say: no feed can
  // collect while the connection itself cannot authenticate.
  if (input.status === "pending_auth" || input.status === "revoked") {
    return "needs_auth";
  }
  if (input.status === "error") {
    return "misconfigured";
  }
  // Operator intent, same as the two above. Without this a paused connection
  // reports its zero-feed shape as `no_feeds` while a paused connection that
  // HAS feeds reports `paused` (every feed derives paused from
  // connection_status), so the same intent read two different ways.
  if (input.status === "paused") {
    return "paused";
  }

  // A chat transport carries no collector feeds by design, a consent-only
  // connection is forbidden from having any, and a connector that declares none
  // legitimately has nothing to roll up. None of the three is a defect.
  const isCollectorConnection =
    input.credential_mode == null &&
    input.consent_only !== true &&
    input.connector_has_auto_syncable_feeds !== false;

  if (expectedFeedCount === 0) {
    // Two different zero cases, and only the first is a problem:
    //
    //  - NO feed rows at all on a collector connection — setup stopped after
    //    the connection was written, and nothing will ever run. `no_feeds`.
    //  - Feed rows exist but none is a collector: a chat connection's channels
    //    are feed rows too, and a source-only feed is evaluated on demand.
    //    There is simply nothing to roll up, which is not a defect.
    //
    // `connector-health.ts` draws the same line — its zero-feed rule requires
    // feedCount === 0, while "expected feeds = 0" returns healthy separately.
    // Collapsing the two here would flag every working chat connection.
    const hasNoFeedsAtAll = input.feeds.length === 0;
    return isCollectorConnection && hasNoFeedsAtAll ? "no_feeds" : "healthy";
  }

  const allPaused = collectors.every((feed) => feed.attention === "paused");
  const allNoTrigger = collectors.every(
    (feed) => feed.attention === "no_trigger"
  );

  // Cause before symptom: a feed with no dispatch path has also never run, and
  // saying "never collected" would describe the consequence while hiding the
  // reason. Same ranking the feed-level module applies to no_trigger/never_run.
  if (allNoTrigger) return "no_trigger";
  if (allPaused) return "paused";
  // An auth profile can go revoked while `connections.status` still reads
  // 'active' — the status column records intent and nothing rewrites it. Every
  // feed then derives needs_auth, and reporting the connection as merely
  // `degraded` would bury the one state a human can actually act on.
  if (collectors.every((feed) => feed.attention === "needs_auth")) {
    return "needs_auth";
  }
  if (collectors.every((feed) => feed.attention === "never_run")) {
    return "never_collected";
  }
  if (attentionFeedCount > 0) return "degraded";

  return "healthy";
}

/**
 * SQL body of the per-connection feed lateral: the feed counts the facets need
 * and the per-feed columns `deriveConnectionHealthFromRow` reads, in ONE pass
 * over `feeds`.
 *
 * Shared rather than copied because `list` and `get` must not disagree about
 * one connection, and a projection that exists in only one of them is exactly
 * how they drift — the jsonb keys built here have to stay in lockstep with
 * `FeedHealthJsonRow` on the reading side, and there is no typecheck across
 * that boundary.
 *
 * `feeds` is a bounded config table keyed by connection_id, so unlike an
 * aggregate over `events` or `runs` this answer does not grow with history.
 *
 * KNOWN LIMIT: the caller resolves ONE definition per connection (the active
 * one), while `list_feeds` resolves one per feed and honours `feeds.pinned_version`.
 * A feed pinned to an older version whose `feeds_schema` declared different
 * operations would therefore read differently here than on the feed page. No
 * feed is pinned in prod today (279 live feeds, 0 pinned, measured 2026-09-15),
 * so this is latent rather than live; if pinning ships, this lateral has to
 * resolve the definition per feed the way `manage_feeds` already does.
 */
export function connectionFeedHealthLateralSql(
  definitionAlias: string,
  connectionAlias: string,
  webhookDrivenSql: string
): string {
  return `SELECT
        COUNT(*)::int AS feed_count,
        COUNT(*) FILTER (
          WHERE COALESCE(f.config ->> 'store', '') <> 'channel_messages'
        )::int AS data_feed_count,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'operations', COALESCE(${definitionAlias}.feeds_schema -> f.feed_key -> 'operations', '[]'::jsonb),
              'store', COALESCE(f.config ->> 'store', 'events'),
              'status', f.status,
              'schedule', f.schedule,
              'webhook_driven', ${webhookDrivenSql},
              'last_sync_status', f.last_sync_status,
              'last_sync_at', f.last_sync_at,
              'consecutive_failures', f.consecutive_failures,
              'next_run_at', f.next_run_at
            )
          ),
          '[]'::jsonb
        ) AS feed_health
      FROM feeds f
      WHERE f.connection_id = ${connectionAlias}.id AND f.deleted_at IS NULL`;
}

/**
 * SQL predicate: does this connector definition declare a feed the PRODUCT can
 * provision on its own?
 *
 * A `userManaged` feed needs per-instance configuration nobody can supply
 * automatically (a database table, a folder id), so a connection carrying none
 * of those is not missing anything and `no_feeds` would be a false positive for
 * it. Operation-only and source-only connectors declare no `sync` feed at all
 * and fall out the same way.
 *
 * Exported as a fragment rather than reimplemented per call site because the
 * alerter and both read paths must agree about which connections are even
 * eligible for a zero-feed verdict; three copies of this would be three chances
 * to drift. `definitionAlias` is a table alias, never user input.
 */
export function connectorHasAutoSyncableFeedsSql(definitionAlias: string): string {
  return `EXISTS (
            SELECT 1
            FROM jsonb_each(COALESCE(${definitionAlias}.feeds_schema, '{}'::jsonb))
              AS declared(feed_key, config)
            WHERE COALESCE(declared.config -> 'operations', '[]'::jsonb) @> '["sync"]'::jsonb
              AND COALESCE((declared.config ->> 'userManaged')::boolean, false) = false
          )`;
}

/**
 * One feed as the `feed_health` jsonb aggregate carries it out of Postgres.
 * Every field is the stored column under the same name; see
 * `FeedHealthSemanticsInput` for what each one means.
 */
interface FeedHealthJsonRow {
  operations?: unknown;
  store?: unknown;
  status?: unknown;
  schedule?: unknown;
  webhook_driven?: unknown;
  last_sync_status?: unknown;
  last_sync_at?: unknown;
  consecutive_failures?: unknown;
  next_run_at?: unknown;
}

/** A connection row carrying the `feed_health` aggregate. */
export interface ConnectionHealthRow {
  status?: string | null;
  credential_mode?: string | null;
  auth_profile_status?: string | null;
  device_worker_id?: string | null;
  device_online?: boolean | null;
  consent_only?: boolean | null;
  connector_has_auto_syncable_feeds?: boolean | null;
  feed_health?: unknown;
}

const FEED_OPERATIONS = new Set(['sync', 'read']);

function parseOperations(value: unknown): Array<'sync' | 'read'> | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (operation): operation is 'sync' | 'read' =>
      typeof operation === 'string' && FEED_OPERATIONS.has(operation)
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Adapter from a connection row to the verdict, so `list` and `get` reach the
 * fold through ONE path and cannot drift apart. Kept beside the fold rather
 * than in a handler because it is the only place that knows how the stored
 * columns map onto the two derivations, and it stays pure — no database, no
 * clock beyond what the feed derivation already reads.
 *
 * `device_connector_readiness` is deliberately not supplied. It is a manifest
 * and capability projection `list_feeds` assembles from device state, and it
 * only ever refines a feed from healthy toward `setup_required` — so omitting
 * it can understate one feed's attention but can never invent a connection
 * problem that is not there. A connection-wide scan must not pay a per-device
 * lookup for that refinement; `list_feeds` is where it belongs.
 */
export function deriveConnectionHealthFromRow(
  row: ConnectionHealthRow
): ConnectionAttentionState {
  const rawFeeds = Array.isArray(row.feed_health) ? row.feed_health : [];
  const feeds: FeedHealthSemantics[] = rawFeeds.map((entry) => {
    const feed = (entry ?? {}) as FeedHealthJsonRow;
    return deriveFeedHealthSemantics({
      operations: parseOperations(feed.operations),
      store: feed.store === 'channel_messages' ? 'channel_messages' : 'events',
      status: stringOrNull(feed.status),
      schedule: stringOrNull(feed.schedule),
      webhook_driven: feed.webhook_driven === true,
      last_sync_status: stringOrNull(feed.last_sync_status),
      last_sync_at: stringOrNull(feed.last_sync_at),
      consecutive_failures: Number(feed.consecutive_failures ?? 0),
      next_run_at: stringOrNull(feed.next_run_at),
      connection_status: row.status ?? null,
      auth_profile_status: row.auth_profile_status ?? null,
      device_worker_id: row.device_worker_id ?? null,
      device_online: row.device_online ?? null,
    });
  });

  return deriveConnectionHealthSemantics({
    status: row.status,
    credential_mode: row.credential_mode,
    consent_only: row.consent_only,
    connector_has_auto_syncable_feeds: row.connector_has_auto_syncable_feeds,
    feeds,
  });
}
