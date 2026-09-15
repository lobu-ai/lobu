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
 * Measured on prod 2026-09-15, three connections show the three shapes this
 * module exists to separate, all of them `status='active'`:
 *   - conn 623 (`whatsapp.web`) — 0 feeds, 0 runs, created and abandoned mid-setup.
 *   - conn 280 (`x`) — 14 feeds, every one paused with no schedule since July.
 *   - conn 615 (`whatsapp.web`) — genuinely healthy, ~1 event per push.
 * `connector-health.ts` classified all three the same way: healthy.
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
 * `items_collected` is carried through as INFORMATION only and is deliberately
 * not the verdict. "Syncs fine, produces nothing" reads like a defect but is
 * routine — a mailbox label with no mail syncs successfully and collects zero
 * forever. `connector-health.ts` pages on the same never-succeeded signal for
 * the same reason.
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

/** One collector feed's contribution to the fold. */
export interface ConnectionFeedRollupInput {
  /** Straight from `deriveFeedHealthSemantics` — never hand-built. */
  semantics: FeedHealthSemantics;
  /** `feeds.items_collected` — cumulative; see the header. */
  items_collected?: number | null;
}

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
  /** Every non-deleted feed on this connection, already derived. */
  feeds: readonly ConnectionFeedRollupInput[];
}

export interface ConnectionHealthSemantics {
  attention: ConnectionAttentionState;
  /** Collector feeds considered by the fold (streaming/source_only excluded). */
  expectedFeedCount: number;
  /** Collector feeds whose own attention state is something other than healthy. */
  attentionFeedCount: number;
  /**
   * Cumulative items across every collector feed. INFORMATIONAL — no verdict
   * reads it; see the header for why zero is not itself a defect.
   */
  itemsCollected: number;
}

/** Feed attention states that mean "this feed is not currently collecting". */
const FEED_NEEDS_ATTENTION = new Set([
  "paused",
  "needs_auth",
  "setup_required",
  "last_attempt_failed",
  "overdue",
  "no_trigger",
  "never_run",
  "device_offline",
  "misconfigured",
]);

/**
 * Collector feeds only. `streaming` (chat transcripts) and `source_only`
 * (read-on-demand) have no sync lifecycle, so folding them would dilute every
 * ratio below — the same reason `classifyFeed` keeps them out of its expected
 * set.
 */
function isCollector(feed: ConnectionFeedRollupInput): boolean {
  return (
    feed.semantics.executionMode === "scheduled" ||
    feed.semantics.executionMode === "no_schedule"
  );
}

/**
 * Fold a connection's feed verdicts into one connection verdict. Pure: the
 * caller supplies the connection row fields and its already-derived feed
 * semantics. Order of checks fixes precedence (most actionable wins).
 */
export function deriveConnectionHealthSemantics(
  input: ConnectionHealthSemanticsInput
): ConnectionHealthSemantics {
  const collectors = input.feeds.filter(isCollector);
  const expectedFeedCount = collectors.length;
  const itemsCollected = collectors.reduce(
    (sum, feed) => sum + Math.max(0, Number(feed.items_collected ?? 0)),
    0
  );
  const attentionFeedCount = collectors.filter((feed) =>
    FEED_NEEDS_ATTENTION.has(feed.semantics.attention)
  ).length;

  const base = { expectedFeedCount, attentionFeedCount, itemsCollected };

  // Connection-level blockers outrank anything a feed can say: no feed can
  // collect while the connection itself cannot authenticate.
  if (input.status === "pending_auth" || input.status === "revoked") {
    return { ...base, attention: "needs_auth" };
  }
  if (input.status === "error") {
    return { ...base, attention: "misconfigured" };
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
    return {
      ...base,
      attention: isCollectorConnection && hasNoFeedsAtAll ? "no_feeds" : "healthy",
    };
  }

  const allPaused = collectors.every(
    (feed) => feed.semantics.attention === "paused"
  );
  const allNoTrigger = collectors.every(
    (feed) => feed.semantics.attention === "no_trigger"
  );

  // Cause before symptom: a feed with no dispatch path has also never run, and
  // saying "never collected" would describe the consequence while hiding the
  // reason. Same ranking the feed-level module applies to no_trigger/never_run.
  if (allNoTrigger) return { ...base, attention: "no_trigger" };
  if (allPaused) return { ...base, attention: "paused" };
  if (collectors.every((feed) => feed.semantics.attention === "never_run")) {
    return { ...base, attention: "never_collected" };
  }
  if (attentionFeedCount > 0) return { ...base, attention: "degraded" };

  return { ...base, attention: "healthy" };
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
  items_collected?: unknown;
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
): ConnectionHealthSemantics {
  const rawFeeds = Array.isArray(row.feed_health) ? row.feed_health : [];
  const feeds: ConnectionFeedRollupInput[] = rawFeeds.map((entry) => {
    const feed = (entry ?? {}) as FeedHealthJsonRow;
    return {
      semantics: deriveFeedHealthSemantics({
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
      }),
      items_collected: Number(feed.items_collected ?? 0),
    };
  });

  return deriveConnectionHealthSemantics({
    status: row.status,
    credential_mode: row.credential_mode,
    consent_only: row.consent_only,
    connector_has_auto_syncable_feeds: row.connector_has_auto_syncable_feeds,
    feeds,
  });
}
