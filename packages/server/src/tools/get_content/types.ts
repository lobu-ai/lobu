/**
 * Tool: read_knowledge — result/row type definitions and small parse helpers.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { ContentItem } from '@lobu/connector-sdk';

// ============================================
// Type Definitions
// ============================================

export type { ContentItem };

/** Classifier configuration returned for automation mode (for worker embedding generation) */
export interface ClassifierConfig {
  slug: string;
  extraction_config: Record<string, unknown> | null;
  attribute_values: Record<
    string,
    {
      description?: string;
      examples?: string[];
      embedding?: number[] | null;
    }
  >;
}

/**
 * Result of `read_knowledge`. TypeBox-first and the SINGLE source of truth:
 * `GetContentResult` is `Static<>`-derived from this schema, which is also the
 * tool's `outputSchema`. `ContentItem` (a 90-field type in
 * `@lobu/connector-sdk`, a published package) and the automation-mode
 * `ClassifierConfig`/`UnprocessedRange` payloads are modeled as `unknown`
 * inline — they're opaque over the wire, and mirroring them here would be a
 * brittle second source that drifts from the SDK. The envelope (content list,
 * total, pagination, automation-mode flags) is precise.
 */
export const GetContentResultSchema = Type.Object({
  content: Type.Array(Type.Unknown()),
  total: Type.Integer(),
  /**
   * content_ids reads only. `total` counts returned rows (a supersede chain
   * expands to all its rows); `chain_total` counts the distinct lineages those
   * rows collapse into — i.e. how many of the requested ids resolved to a thing.
   */
  chain_total: Type.Optional(Type.Integer()),
  page: Type.Object({
    limit: Type.Integer(),
    offset: Type.Integer(),
    has_more: Type.Boolean(),
    has_older: Type.Optional(Type.Boolean()),
    has_newer: Type.Optional(Type.Boolean()),
    next_cursor: Type.Optional(
      Type.Object({ occurred_at: Type.String(), id: Type.Integer() })
    ),
  }),
  classification_stats: Type.Optional(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer()))
  ),
  /**
   * Permalink for the entity-scoped events listing in the public web app.
   * LLM agents calling `read_knowledge` over MCP read this from the response
   * and format it into chat replies; there is no programmatic consumer in
   * this repo, but removing the field breaks that user-facing contract.
   */
  view_url: Type.Optional(Type.String()),
  // Automation-mode fields (only present when automation_id is provided)
  window_token: Type.Optional(Type.String()),
  window_start: Type.Optional(Type.String()),
  window_end: Type.Optional(Type.String()),
  /**
   * Which timestamp on an event the window bounds select.
   *
   * Always `created_at` — when Lobu stored the row, not when the content is
   * dated. A run that assumes the calendar axis will mis-describe its own
   * output ("yesterday's messages" for a 6-year-old archive row that arrived
   * yesterday), so the axis travels with the bounds.
   */
  window_axis: Type.Optional(Type.Literal('created_at')),
  /**
   * What this read leaves unclaimed, and how far behind the Automation is.
   *
   * `window_start` alone cannot tell a run whether it is current: a stale window
   * and a fresh one look identical from inside the run. Prod Automation 2 drafted
   * replies to month-dead Hacker News threads for weeks because nothing said so.
   *
   * Raw facts, deliberately — no staleness flag. An ordinary read starts at the
   * Automation's arrival mark and leaves nothing behind, so the `unclaimed_*`
   * pair is null for it; only an explicitly requested later range sets them.
   */
  window_lag: Type.Optional(
    Type.Object({
      /** Start of the newest arrival range this Automation has actually completed. */
      last_window_start: Type.Union([Type.String(), Type.Null()]),
      /**
       * The Automation's arrival mark, when this read starts after it. Rows
       * stored in `[unclaimed_from, unclaimed_to)` are NOT in this response and
       * stay unclaimed: completing this range does not move the mark past them,
       * so an ordinary claim still returns them.
       */
      unclaimed_from: Type.Union([Type.String(), Type.Null()]),
      /** Exclusive end of that gap — this read's `window_start`. */
      unclaimed_to: Type.Union([Type.String(), Type.Null()]),
      /**
       * The gap in words, present only when there is one. Automation runs read
       * this response as JSON through `run_sdk`, so the affordance to recover
       * the skipped arrivals has to travel in the payload.
       */
      guidance: Type.Optional(Type.String()),
    })
  ),
  extraction_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sources: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Unknown()))),
  /**
   * Per-source page state, keyed by source name. Every SQL-backed source is
   * capped at the request's `limit`; this is how a caller distinguishes a
   * fully-read source from a truncated one. Only the primary event source
   * carries an event cursor (see `page.next_cursor`); live sources carry their own next_cursor.
   */
  sources_page: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        returned: Type.Integer(),
        limit: Type.Integer(),
        has_more: Type.Boolean(),
        next_cursor: Type.Optional(Type.String()),
        window_axis: Type.Optional(Type.String()),
        feed_id: Type.Optional(Type.Integer()),
      })
    )
  ),
  /**
   * Automation-bound entities as structured rows (id, name, type, metadata,
   * field_controls). field_controls marks human-owned field values the agent
   * must not overwrite without new evidence.
   */
  entities: Type.Optional(Type.Array(Type.Unknown())),
  classifiers: Type.Optional(Type.Array(Type.Unknown())),
  unprocessed_ranges: Type.Optional(Type.Array(Type.Unknown())),
  reactions_guidance: Type.Optional(Type.String()),
  /** Summary of this Automation's recent reactions (self-learning context). */
  past_reactions: Type.Optional(Type.String()),
  /** Summary of recent human feedback on this Automation's output. */
  past_feedback: Type.Optional(Type.String()),
  available_operations: Type.Optional(
    Type.Array(
      Type.Object({
        connection_id: Type.Integer(),
        operation_key: Type.String(),
        name: Type.String(),
        kind: Type.Union([Type.Literal('read'), Type.Literal('write')]),
        requires_approval: Type.Boolean(),
      })
    )
  ),
  total_count: Type.Optional(Type.Integer()),
  total_count_chars: Type.Optional(Type.Integer()),
  estimated_tokens: Type.Optional(Type.Integer()),
  token_warning: Type.Optional(Type.String()),
  entity_summary: Type.Optional(
    Type.Array(
      Type.Object({
        entity_id: Type.Integer(),
        name: Type.String(),
        entity_type: Type.String(),
        result_count: Type.Integer(),
      })
    )
  ),
  hints: Type.Optional(Type.Array(Type.String())),
});
export type GetContentResult = Static<typeof GetContentResultSchema>;

// ============================================
// Database Row Types (for query result typing)
// ============================================

/** Simple row with just an id field */
export interface IdRow {
  id: number;
}

/** Row type for classification stats aggregation */
export interface ClassificationStatsRow {
  classifier_slug: string;
  value: string;
  count: string | number;
}

/** Row type for raw content query results (union of all possible sources) */
export interface ContentRow {
  id: number;
  entity_ids: number[] | string; // string from some query sources
  platform: string;
  origin_id?: string | null;
  semantic_type: string;
  origin_type?: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty' | null;
  payload_text?: string | null;
  payload_truncated?: boolean | null;
  content_length?: number | string | null;
  payload_data?: Record<string, unknown> | null;
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
  attachments_truncated?: boolean | null;
  attachments_bytes?: number | string | null;
  author_name?: string | null;
  title: string | null;
  source_url?: string | null;
  score: number;
  metadata: Record<string, unknown> | null;
  classifications: Record<string, unknown> | null;
  created_at: string;
  occurred_at?: string | null;
  similarity?: number | null;
  text_rank?: number | null;
  combined_score?: number | null;
  score_breakdown?: Record<string, unknown> | null;
  origin_parent_id?: string | null;
  root_origin_id?: string;
  depth?: number;
  interaction_type?: 'none' | 'approval' | null;
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;
  superseded_by?: number | string | null;
  run_id?: number | string | null;
  parent_context?: Record<string, unknown> | null;
  root_context?: Record<string, unknown> | null;
  client_id?: string | null;
  client_name?: string | null;
  connection_id?: number | null;
  connection_name?: string | null;
  feed_id?: number | null;
  feed_key?: string | null;
  feed_name?: string | null;
  automation_id?: number | null;
  automation_name?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  device_worker_id?: string | null;
  device_label?: string | null;
  device_platform?: string | null;
}

export function parseJson(value: unknown): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function toNumberOrUndefined(value: unknown): number | undefined {
  return value != null ? Number(value) : undefined;
}

export function parseRecordArray(value: unknown): Record<string, unknown>[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item)
  );
}
