import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";
import { paginationFields } from "./pagination";

// ============================================
// Schema
// ============================================

export const ListFeedsAction = Type.Object({
  action: Type.Literal("list_feeds", {
    description: "Paginated list of feeds with filters.",
  }),
  connection_id: Type.Optional(
    Type.Number({ description: "Filter by connection ID" })
  ),
  feed_ids: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      description: "Filter to specific feed IDs",
    })
  ),
  entity_id: Type.Optional(
    Type.Number({ description: "Filter by linked entity ID" })
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("paused")], {
      description:
        "Filter by desired lifecycle status. Only 'active' and 'paused' are real feed statuses — a feed that keeps failing stays 'active' (or auto-pauses). Use `health` to find failing feeds that are still active on non-paused connections.",
    })
  ),
  health: Type.Optional(
    Type.Union([Type.Literal("healthy"), Type.Literal("failing")], {
      description:
        "Filter by runtime health for active feeds on non-paused connections; paused feeds and feeds on paused connections are excluded. 'failing' = last sync failed or the feed has one or more consecutive failures; 'healthy' = otherwise. Surfaces active-but-failing feeds the `status` filter cannot.",
    })
  ),
  ...paginationFields(50),
});

// Metadata inspection is deliberately separate from source access. Reading one
// feed never calls its connector; agents opt into source latency through
// read_feeds instead.
export const ReadFeedAction = Type.Object({
  action: Type.Literal("read_feed", {
    description:
      "Read feed metadata and recent sync runs without querying its source.",
  }),
  feed_id: Type.Number({ description: "Feed ID" }),
});

const FeedSourceRead = Type.Object({
  feed_id: Type.Integer({
    minimum: 1,
    description: "Feed ID to query at its source.",
  }),
  query: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Connector-native filter/search query. Omit for an unfiltered source read; use `sort` for ordering.",
    })
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description: "Maximum source rows for this feed (default 50).",
    })
  ),
  cursor: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Opaque continuation cursor returned by a previous read of this feed/query/sort.",
    })
  ),
  sort: Type.Optional(
    Type.Object(
      {
        column: Type.String({ minLength: 1 }),
        order: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
      },
      {
        description: "Source-native sort pushed into the connector.",
      }
    )
  ),
});

export const ReadFeedsAction = Type.Object({
  action: Type.Literal("read_feeds", {
    description:
      "Explicitly query several source-backed feeds in parallel. Each source is bounded and fails independently.",
  }),
  reads: Type.Array(FeedSourceRead, {
    minItems: 1,
    maxItems: 10,
    description: "Source reads to execute in parallel (max 10).",
  }),
  timeout_ms: Type.Optional(
    Type.Integer({
      description:
        "Per-feed timeout in milliseconds (default 10000, max 30000).",
      minimum: 1000,
      maximum: 30000,
    })
  ),
});

export const CreateFeedAction = Type.Object({
  action: Type.Literal("create_feed", {
    description: "Create a feed on a connection.",
  }),
  connection_id: Type.Number({
    description: "Connection ID this feed belongs to",
  }),
  feed_key: Type.String({
    description: "Feed key from connector definition (e.g. threads)",
  }),
  display_name: Type.Optional(
    Type.String({ description: "Human-readable name for this feed" })
  ),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), { description: "Entity IDs to tag events with" })
  ),
  config: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Feed-specific configuration",
    })
  ),
  schedule: Type.Optional(
    Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description:
        "Cron expression for automatic sync. Omit or null for manual-only (trigger_feed); no platform default cadence.",
    })
  ),
  timezone: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        "IANA timezone the schedule is evaluated in (e.g. 'Asia/Taipei'), DST-aware. Omit for server time (UTC).",
    })
  ),
});

export const UpdateFeedAction = Type.Object({
  action: Type.Literal("update_feed", {
    description: "Patch a feed (status, config, schedule).",
  }),
  feed_id: Type.Number({ description: "Feed ID" }),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("paused")], {
      description:
        "Desired feed status: active or paused. 'error' is a runtime state the system owns, not a status you set — a failing feed stays active; use the `list_feeds` action's `health: failing` filter to find failing active feeds.",
    })
  ),
  display_name: Type.Optional(Type.String()),
  entity_ids: Type.Optional(Type.Array(Type.Number())),
  config: Type.Optional(Type.Record(Type.String(), Type.Any())),
  replace_config: Type.Optional(
    Type.Boolean({
      description:
        "When true and `config` is provided, replace the stored feed config with exactly that object (declarative apply); when false/omitted, merge into the existing config (default).",
    })
  ),
  schedule: Type.Optional(
    Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description:
        "Cron expression for automatic sync. Null clears the schedule (manual-only).",
    })
  ),
  timezone: Type.Optional(
    Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()], {
      description:
        "IANA timezone the schedule is evaluated in. Null clears it (server time / UTC).",
    })
  ),
});

export const DeleteFeedAction = Type.Object({
  action: Type.Literal("delete_feed", {
    description: "Soft-delete a feed and cancel its active runs.",
  }),
  feed_id: Type.Number({ description: "Feed ID" }),
});

export const TriggerFeedAction = Type.Object({
  action: Type.Literal("trigger_feed", {
    description: "Trigger an immediate sync run for a sync-capable feed.",
  }),
  feed_id: Type.Number({ description: "Feed ID to trigger sync for" }),
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        "Execute the connector for real but persist nothing in Lobu — no events, no entities, no attachments, and the feed's checkpoint and sync state do not move. The run executes asynchronously; once it completes, a capped preview of what would have been ingested is on the run's dry_run_preview, visible via read_feed's recent_runs. Use this to test a connector whose credentials are OAuth or API-key based; those never leave the gateway, so the sync can only run server-side. Two limits worth knowing: it does not undo side effects the connector causes UPSTREAM (marking a message read, etc.), and it occupies the feed's single active-sync slot while it runs, so a scheduled sync landing mid-run is skipped until the next tick.",
      default: false,
    })
  ),
});

export const RecollectFeedAction = Type.Object({
  action: Type.Literal("recollect_feed", {
    description:
      "Clear a feed's sync cursor so its next sync re-collects from scratch. Already-collected events are kept and re-collected items dedupe on origin_id; the feed's status, schedule and failure state are unchanged, and what was already acknowledged back to the source (source_ack) is preserved. Refused while the feed has an active sync run. Does not start a sync — call trigger_feed or wait for the schedule.",
  }),
  feed_id: Type.Number({ description: "Feed ID to re-collect" }),
});

// ============================================
// Result Types
// ============================================

/**
 * Result of `manage_feeds` — discriminated union (on `action`, plus an error
 * variant). TypeBox-first: `Static<>` derives the TS type from the same schema
 * exposed as the tool's `outputSchema`. Feed rows are wide, join-driven
 * snapshots (no stable contract), so they're honestly `Record<string, unknown>`.
 */
export const ManageFeedsResultSchema = Type.Union([
  Type.Object({ error: Type.String() }),
  Type.Object({
    action: Type.Literal("list_feeds"),
    feeds: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    /**
     * Count of all feeds matching the filters, independent of this page. On a
     * non-empty page it is read from the page's `COUNT(*) OVER()` window; on an
     * offset past the last matching row (empty page) it is recovered with a
     * bare count over the same filters — so it is always the true whole-set
     * total, even for an overshot offset.
     */
    total: Type.Integer(),
    /** True when more feeds match past this page (offset + returned < total). */
    has_more: Type.Boolean(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("read_feed"),
    feed: Type.Record(Type.String(), Type.Unknown()),
    recent_runs: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    action: Type.Literal("read_feeds"),
    results: Type.Array(
      Type.Object({
        feed_id: Type.Integer(),
        ok: Type.Boolean(),
        rows: Type.Optional(
          Type.Array(Type.Record(Type.String(), Type.Unknown()))
        ),
        columns: Type.Optional(
          Type.Array(Type.Object({ name: Type.String(), type: Type.String() }))
        ),
        total: Type.Optional(Type.Integer()),
        next_cursor: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
        error_code: Type.Optional(Type.String()),
        retryable: Type.Optional(Type.Boolean()),
      })
    ),
    failures: Type.Integer(),
    timeout_ms: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("create_feed"),
    feed: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal("update_feed"),
    feed: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal("delete_feed"),
    deleted: Type.Literal(true),
    feed_id: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("trigger_feed"),
    triggered: Type.Literal(true),
    run_id: Type.Integer(),
    feed_id: Type.Integer(),
    // Present and true only for a dry run. Echoed back so a caller that passed
    // `dry_run` can confirm the run really was created dry — silently ignoring
    // the flag and persisting anyway is the one failure mode that matters here.
    dry_run: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("recollect_feed"),
    feed_id: Type.Integer(),
  }),
  // Nothing was queued. `triggered` discriminates this from the success
  // variant above: the skip used to carry only `message`, so a caller that
  // queued no run was shape-indistinguishable from one that did, and no run
  // row exists to fail or alert on either. `reason` is the machine-readable
  // cause behind the sentence (`SyncRunSkipReason`).
  Type.Object({
    action: Type.Literal("trigger_feed"),
    triggered: Type.Literal(false),
    reason: Type.String(),
    message: Type.String(),
  }),
]);
export type ManageFeedsResult = Static<typeof ManageFeedsResultSchema>;

export const ManageFeedsSchema = Type.Union([
  ListFeedsAction,
  ReadFeedAction,
  ReadFeedsAction,
  CreateFeedAction,
  UpdateFeedAction,
  DeleteFeedAction,
  TriggerFeedAction,
  RecollectFeedAction,
]);

export type ManageFeedsArgs = Static<typeof ManageFeedsSchema>;

export type FeedListInput = ActionInput<ManageFeedsArgs, "list_feeds">;
export type FeedReadInput = ActionInput<ManageFeedsArgs, "read_feed">;
export type FeedReadManyInput = ActionInput<ManageFeedsArgs, "read_feeds">;
export type FeedCreateInput = ActionInput<ManageFeedsArgs, "create_feed">;
export type FeedUpdateInput = ActionInput<ManageFeedsArgs, "update_feed">;
export type FeedDeleteInput = ActionInput<ManageFeedsArgs, "delete_feed">;
export type FeedTriggerInput = ActionInput<ManageFeedsArgs, "trigger_feed">;
export type FeedRecollectInput = ActionInput<ManageFeedsArgs, "recollect_feed">;
