/**
 * Shared types, interfaces, and cursor/pagination helpers for content search.
 */

import type { ClassificationFilter } from '../content-query-filters';

/**
 * Search options for content vector search
 */
export interface ContentSearchOptions {
  // Entity filtering
  entity_id?: number;
  organization_id?: string; // Required when entity_id is omitted (org-wide mode)
  /**
   * Keep the organization fence even when entity_id is present. Direct MCP
   * search uses this for conjunctive `{ entity_id, query }` recall so a public
   * or foreign entity id can never widen content search into another tenant.
   * Other legacy readers retain their existing entity-id-only semantics unless
   * they opt in explicitly.
   */
  strict_organization_scope?: boolean;

  connection_ids?: number[]; // Array of connection IDs to filter by
  feed_ids?: number[]; // Array of feed IDs to filter by
  run_ids?: number[]; // Array of run IDs (events.run_id) to filter by
  /**
   * Connection-visibility scope. When set, the SQL WHERE clause inlines a
   * subquery that hides events from private connections the caller cannot
   * see. Replaces the older "look up excluded connection ids first, pass them
   * in as connection_ids" two-query dance that the gateway used to do.
   *
   * Authenticated callers pass their user id; unauth callers pass null.
   * Events with `connection_id IS NULL` are always visible.
   */
  visibility_scope?: { organizationId: string; userId: string | null };
  /**
   * Exclude workspace-identity audit events (`metadata.category='workspace'`).
   * These carry member emails / invitation details and are emitted for
   * authenticated workspace activity; anonymous public-workspace readers must
   * never retrieve them through the public read path.
   */
  exclude_workspace_audit?: boolean;
  /**
   * Recall-only (`search_memory`): hide internal operational rows -
   * tool-invocation audit events (semantic_type 'audit') and config/lifecycle
   * state-change rows (metadata.category 'config' | 'lifecycle'). These carry
   * no body text and no embedding, so recall can only title-match them into
   * noise: an unrelated query surfaces "query_sql completed", and one
   * Automation create shows up twice (the lifecycle and config audit streams
   * write single- vs double-quoted titles). Explicit reads are unaffected:
   * get_content and any caller passing an explicit semantic_type filter keep
   * seeing these rows, and query_sql / dashboard / feed paths never consult
   * this flag. Workspace-identity audit rows stay governed by the role-scoped
   * exclude_workspace_audit instead.
   */
  exclude_internal_ops?: boolean;
  run_id?: number; // Filter by Automation run ID
  /** Events analyzed by any run of this automation (`automation_run_events`). */
  analyzed_by_automation_id?: number;
  exclude_automation_id?: number; // Exclude content already analyzed by any run of this automation
  /** Restrict to events this Automation WROTE (events.automation_id). The
   *  counterpart to analyzed_by_automation_id, which is what it READ. */
  produced_by_automation_id?: number;
  platform?: string;
  since?: string; // ISO date or relative ("7d", "30d")
  until?: string; // ISO date
  engagement_min?: number; // Minimum engagement score (0-100)
  engagement_max?: number; // Maximum engagement score (0-100)
  min_similarity?: number; // 0.0 - 1.0, default: 0.6
  limit?: number; // default: 50, max: 100
  content_ids?: number[]; // Filter to specific content IDs
  /**
   * Filter by semantic type — single value or array (matches any). The reserved
   * `notification` value expands to notification_targets presence because a
   * kind-backed notification stores its content kind as semantic_type.
   */
  semantic_type?: string | string[];
  /** Org-wide filter: events whose entity_ids overlap entities of these type slugs. */
  entity_types?: string[];
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';

  // Per-agent memory scope. Filters events whose `metadata->>'agent_id'`
  // matches this string. Threaded through search_memory's top-level
  // `agent_id` arg; populated automatically by Lobu-owned save paths.
  // Note: `metadata.agent_id`
  // is the memory-scope axis, NOT the identity-namespace column
  // (`entity_identities.namespace`) — see identity-normalize.ts.
  agent_id?: string;

  // Per-OAuth-client scope — the `events.client_id` COLUMN (indexed,
  // FK → oauth_clients), not a metadata field. Scopes the timeline to what one
  // registered client did, typically alongside `semantic_type: 'audit'`.
  //
  // Accepts an array because a client that re-registers gets a NEW
  // oauth_clients row under the same `client_name` (prod: "Lobu CLI" has 6
  // ids), so "everything ChatGPT did" means every id for that name.
  client_id?: string | string[];

  // Exact MCP host-conversation scope resolved server-side from the existing
  // materialized conversation identity. Events retain transport ids, so one
  // host conversation can match several reconnects. `[]` is match-none.
  mcp_session_ids?: string[];

  // Classification options (only JOINs when needed)
  include_classifications?: boolean; // Include classifications in results
  classification_filters?: ClassificationFilter[]; // Filter by classifications
  classification_source?: 'user' | 'embedding' | 'llm'; // Filter by classification source

  // Sorting options
  sort_by?: 'date' | 'score'; // Sort by date or engagement score (default: date)
  sort_order?: 'asc' | 'desc'; // Sort order (default: desc)
  before_occurred_at?: string; // Chronological cursor anchor for older results
  before_id?: number; // Stable tie-breaker for before_occurred_at
  after_occurred_at?: string; // Chronological cursor anchor for newer results
  after_id?: number; // Stable tie-breaker for after_occurred_at

  // Ranking tuning. combined_score = vector_weight*cosine + (1-vector_weight)*text_rank
  // when both signals are available. Defaults to 0.6 (60% vector, 40% text) which
  // matches the prior hard-coded weighting. Raise toward 1.0 for noisy/long-form content
  // where text rank is dominated by stopword-like matches (e.g. conversational logs).
  vector_weight?: number;

  // Pre-computed embedding for the query. When provided, skips the text→embedding
  // regeneration step inside searchContentBySingleQuery — useful when the caller
  // already computed an embedding (e.g. search_memory receiving query_embedding).
  query_embedding?: number[];

  // Internal recall-only performance hint. When true, org-wide score searches may
  // use a bounded hybrid candidate set instead of the exact full match set. Do
  // not use for user-visible get_content pagination/totals.
  approximate_candidate_search?: boolean;
}

/**
 * Content search result with combined score and thread metadata
 */
export interface ContentSearchResult {
  id: number;
  entity_ids: number[];
  connection_id: number | null;
  feed_id?: number | null;
  feed_key?: string | null;
  feed_name?: string | null;
  automation_id?: number | null;
  automation_name?: string | null;
  payload_text: string;
  payload_truncated?: boolean | null;
  content_length?: number | string | null;
  title: string | null;
  author_name: string | null;
  source_url: string | null;
  occurred_at: string | null;
  semantic_type: string;
  platform: string;
  origin_id: string;
  origin_parent_id: string | null;
  origin_type?: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty' | null;
  payload_data?: Record<string, unknown> | null;
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
  attachments_truncated?: boolean | null;
  attachments_bytes?: number | string | null;
  score: number;
  interaction_type?: 'none' | 'approval' | null;
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;

  metadata: any;
  classifications: any | null; // Only populated when include_classifications=true or filters applied
  created_at: string;
  similarity?: number; // Vector similarity score (0-1)
  text_rank?: number; // Full-text rank score
  combined_score: number; // Weighted combination of both

  // Thread metadata
  root_origin_id: string; // Thread root origin_id
  depth: number; // 0 = root, 1+ = nested
  parent_context?: {
    // Only if parent not in current results
    author_name: string;
    title: string | null;
    text_content: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  root_context?: {
    // Only if root not in results AND depth > 0
    author_name: string;
    title: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  cursor_fetched_count?: number | null;
}

export interface ContentSearchPageInfo {
  limit: number;
  offset: number;
  has_more: boolean;
  has_older?: boolean;
  has_newer?: boolean;
}

export interface ContentSearchResponse {
  content: ContentSearchResult[];
  total: number;
  page: ContentSearchPageInfo;
}

interface DateCursor {
  direction: 'before' | 'after';
  occurredAtIso: string;
  id: number;
}

export function isDateFeedMode(options: ContentSearchOptions): boolean {
  return (options.sort_by ?? 'date') === 'date' && (options.sort_order ?? 'desc') === 'desc';
}

function parseCursorDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function resolveDateCursor(options: ContentSearchOptions): DateCursor | null {
  if (!isDateFeedMode(options)) return null;

  const beforeOccurredAt = parseCursorDate(options.before_occurred_at);
  if (beforeOccurredAt && options.before_id != null) {
    return {
      direction: 'before',
      occurredAtIso: beforeOccurredAt,
      id: options.before_id,
    };
  }

  const afterOccurredAt = parseCursorDate(options.after_occurred_at);
  if (afterOccurredAt && options.after_id != null) {
    return {
      direction: 'after',
      occurredAtIso: afterOccurredAt,
      id: options.after_id,
    };
  }

  return null;
}

export function buildDateCursorClause(
  cursor: DateCursor | null,
  occurredAtColumn: string,
  idColumn: string,
  baseParamIndex: number
): { sql: string; params: unknown[] } {
  if (!cursor) return { sql: '', params: [] };

  const occurredAtParam = `$${baseParamIndex}::timestamptz`;
  const idParam = `$${baseParamIndex + 1}::bigint`;

  if (cursor.direction === 'before') {
    return {
      sql: `AND (${occurredAtColumn} < ${occurredAtParam} OR (${occurredAtColumn} = ${occurredAtParam} AND ${idColumn} < ${idParam}))`,
      params: [cursor.occurredAtIso, cursor.id],
    };
  }

  return {
    sql: `AND (${occurredAtColumn} > ${occurredAtParam} OR (${occurredAtColumn} = ${occurredAtParam} AND ${idColumn} > ${idParam}))`,
    params: [cursor.occurredAtIso, cursor.id],
  };
}

export function buildDateCandidateOrderBy(cursor: DateCursor | null, tableAlias: string): string {
  // Order by the effective occurrence time — COALESCE(occurred_at, created_at)
  // — in both directions. An event whose source timestamp was never recorded
  // must rank by its record time (which is exactly what the API surfaces for
  // such rows), not sort as the newest/oldest or drop out of keyset pagination:
  // Postgres `ORDER BY occurred_at DESC` defaults to NULLS FIRST, pinning a
  // straggler NULL row to the top of a newest-first feed.
  if (cursor?.direction === 'after') {
    return `COALESCE(${tableAlias}.occurred_at, ${tableAlias}.created_at) ASC, ${tableAlias}.id ASC`;
  }
  return `COALESCE(${tableAlias}.occurred_at, ${tableAlias}.created_at) DESC, ${tableAlias}.id DESC`;
}

/**
 * Chronological-feed guard: exclude events that have not occurred yet.
 *
 * A future-dated row is a scheduled item, not "activity", so ranking it as the
 * newest would let a far-future recurring series (calendar instances expanded
 * a year ahead) monopolize the first page of the activity feed. The guard is
 * lifted only when the caller explicitly asks for a future window — an `until`
 * past now or an `after` cursor past now. NULL occurred_at rows are kept: they
 * are real activity whose source timestamp was never recorded, and the
 * COALESCE(occurred_at, created_at) ordering ranks them by record time instead
 * of pinning the top.
 *
 * The returned fragment carries a leading `AND` for appending to a WHERE body;
 * callers building a `conditions` array strip it (see fetchClassificationStats).
 */
export function buildFutureOccurredAtClause(
  untilDate: Date | null,
  cursor: DateCursor | null
): { sql: string } {
  const nowMs = Date.now();
  const asksForFuture =
    (untilDate != null && untilDate.getTime() > nowMs) ||
    (cursor?.direction === 'after' &&
      new Date(cursor.occurredAtIso).getTime() > nowMs);
  if (asksForFuture) return { sql: '' };
  return { sql: 'AND (f.occurred_at IS NULL OR f.occurred_at <= now())' };
}

export function buildPageInfo(params: {
  limit: number;
  offset: number;
  total: number;
  returnedCount: number;
  useDateFeed: boolean;
  cursor: DateCursor | null;
  fetchedCount?: number | null;
}): ContentSearchPageInfo {
  if (params.useDateFeed) {
    const fetchedCount = Number(params.fetchedCount ?? 0);
    const hasOlder = params.cursor?.direction === 'after' ? true : fetchedCount > params.limit;
    const hasNewer =
      params.cursor?.direction === 'before'
        ? true
        : params.cursor?.direction === 'after'
          ? fetchedCount > params.limit
          : false;

    return {
      limit: params.limit,
      offset: 0,
      has_more: hasOlder,
      has_older: hasOlder,
      has_newer: hasNewer,
    };
  }

  return {
    limit: params.limit,
    offset: params.offset,
    has_more: params.offset + params.returnedCount < params.total,
  };
}

/** Empty `{content, total: 0, page}` response — copy-pasted 3× in the old `listContentInternal`. */
export function emptyListResponse(args: {
  limit: number;
  effectiveOffset: number;
  useDateFeed: boolean;
  cursor: DateCursor | null;
}): ContentSearchResponse {
  return {
    content: [],
    total: 0,
    page: buildPageInfo({
      limit: args.limit,
      offset: args.effectiveOffset,
      total: 0,
      returnedCount: 0,
      useDateFeed: args.useDateFeed,
      cursor: args.cursor,
    }),
  };
}
