/**
 * Tool contract: `read_knowledge`.
 *
 * Lives in core because it crosses package boundaries: the server validates
 * against it, and `@lobu/connector-sdk` derives the input type it publishes to
 * reaction authors. Both derive from this one declaration so neither can drift
 * from the schema the handler actually enforces.
 *
 * Typebox only — no `node:` imports and nothing from core's root index, so the
 * connector isolate lane can bundle it (`packages/connector-sdk/AGENTS.md`).
 */

import { type Static, Type } from "@sinclair/typebox";

export const GetContentSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Search query text (min 3 characters). If provided, performs semantic/full-text search. If omitted, lists content ordered by date.",
      minLength: 3,
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description:
        "Entity ID to filter by. Required unless automation_id is provided.",
    })
  ),
  automation_id: Type.Optional(
    Type.Number({
      description:
        "Persisted Automation ID (`automation_id`) to fetch content for. With run_id, uses that run's queued version/window; otherwise computes the Automation's pending window. Returns window_token for complete_window action.",
    })
  ),
  template_version_id: Type.Optional(
    Type.Number({
      description:
        "Pin an interactive or legacy Automation read to a persisted version. When run_id is present, the run's snapshotted version is authoritative and a conflicting value is rejected. Without run_id, omission defaults to the Automation's current version.",
    })
  ),
  connection_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Connection IDs to filter by",
    })
  ),
  feed_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Feed IDs to filter by (events.feed_id)",
    })
  ),
  run_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Run IDs to filter by (events.run_id — the run that produced the event)",
    })
  ),
  agent_id: Type.Optional(
    Type.String({
      description:
        "Limit results to memory written by this agent. Filters events where metadata.agent_id matches.",
    })
  ),
  client_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "OAuth client IDs to filter by (events.client_id — the connected client that produced the event, e.g. a ChatGPT or CLI registration). Pass several ids to cover one client that registered more than once.",
    })
  ),
  mcp_activity_id: Type.Optional(
    Type.String({
      maxLength: 512,
      description:
        "Internal Connected App filter: exact materialized MCP conversation or transport-session activity id. Requires client_ids.",
    })
  ),
  platforms: Type.Optional(
    Type.Array(Type.String(), {
      description: "Platform types to filter by (reddit, trustpilot, etc.)",
    })
  ),
  run_id: Type.Optional(
    Type.Number({
      description:
        "Run ID. With automation_id, binds the Automation read to that run's queued version, window, and trigger inputs. Without automation_id, filters to content analyzed in this run.",
    })
  ),
  analyzed_by_automation_id: Type.Optional(
    Type.Number({
      description:
        "Limit results to events this Automation has analyzed in any run. Distinct from automation_id, which enters Automation read mode.",
    })
  ),
  produced_by_automation_id: Type.Optional(
    Type.Number({
      description:
        "Limit results to events this Automation WROTE — its outputs, entity change sets, and notifications. The counterpart to analyzed_by_automation_id, which returns what it READ; the two are not interchangeable.",
    })
  ),
  since: Type.Optional(
    Type.String({
      description:
        'Filter events published since this date. Supports: ISO 8601 ("2025-01-01"), named aliases ("yesterday", "last_week"), or relative ("7d", "30d", "1m", "1y"). When used with automation_id, also sets window_start in the generated token.',
    })
  ),
  until: Type.Optional(
    Type.String({
      description:
        'Filter events published until this date. Supports: ISO 8601 ("2025-01-31"), named aliases ("today", "yesterday"), or relative ("7d", "30d", "1m", "1y"). When used with automation_id, also sets window_end in the generated token.',
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description:
        "Minimum vector similarity threshold for semantic search (0.0-1.0, default: 0.6). Only used when query is provided.",
      minimum: 0.0,
      maximum: 1.0,
      default: 0.6,
    })
  ),
  vector_weight: Type.Optional(
    Type.Number({
      description:
        "Weight of vector similarity vs text rank in combined_score (0.0-1.0, default: 0.6). Higher values favor semantic match over keyword overlap. Only applies when a query and embeddings are both present.",
      minimum: 0.0,
      maximum: 1.0,
    })
  ),
  classification_filters: Type.Optional(
    Type.Record(Type.String(), Type.Array(Type.String()), {
      description:
        'Filter by classification values, e.g. {"sentiment": ["positive", "neutral"], "bug-severity": ["critical"]}',
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Number of results to return (default: 50, max: 2000)",
      default: 50,
    })
  ),
  offset: Type.Optional(
    Type.Number({
      description: "Number of results to skip for pagination (default: 0)",
      default: 0,
    })
  ),
  source_name: Type.Optional(
    Type.String({
      description:
        "Automation source name to continue; pair with source_cursor and the same run_id.",
    })
  ),
  source_cursor: Type.Optional(
    Type.String({
      description:
        "Signed window_token from the preceding page of this source. Retain every returned window_token for completeWindow.",
    })
  ),
  before_occurred_at: Type.Optional(
    Type.String({
      description:
        "Chronological cursor anchor for older results. Pair with before_id. Only used when sort_by=date and sort_order=desc.",
    })
  ),
  before_id: Type.Optional(
    Type.Number({
      description:
        "Stable tie-breaker for before_occurred_at. Only used when sort_by=date and sort_order=desc.",
      minimum: 1,
    })
  ),
  after_occurred_at: Type.Optional(
    Type.String({
      description:
        "Chronological cursor anchor for newer results. Pair with after_id. Only used when sort_by=date and sort_order=desc.",
    })
  ),
  after_id: Type.Optional(
    Type.Number({
      description:
        "Stable tie-breaker for after_occurred_at. Only used when sort_by=date and sort_order=desc.",
      minimum: 1,
    })
  ),
  include_classification: Type.Optional(
    Type.String({
      description:
        'Include classification data. Use "summary" to include aggregated classification stats for filter UI.',
    })
  ),
  engagement_min: Type.Optional(
    Type.Number({
      description: "Minimum engagement score (0-100)",
      minimum: 0,
      maximum: 100,
    })
  ),
  engagement_max: Type.Optional(
    Type.Number({
      description: "Maximum engagement score (0-100)",
      minimum: 0,
      maximum: 100,
    })
  ),
  sort_by: Type.Optional(
    Type.Union([Type.Literal("date"), Type.Literal("score")], {
      description:
        "Sort content by: date (newest first) or score (cross-platform smart ranking). Search queries respect date sorting for chronological feed browsing; score sorting remains relevance-weighted. Default: score",
      default: "score",
    })
  ),
  sort_order: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description:
        "Sort order: asc (ascending) or desc (descending). Default: desc",
      default: "desc",
    })
  ),
  include_superseded: Type.Optional(
    Type.Boolean({
      description:
        "When true and listing entity content without a query, include superseded historical events in addition to current records. Useful for explicit historical lookups such as original or previous values.",
      default: false,
    })
  ),
  classification_source: Type.Optional(
    Type.Union(
      [Type.Literal("user"), Type.Literal("embedding"), Type.Literal("llm")],
      {
        description:
          "Filter content by classification source: user (manual), embedding (system), or llm (AI-generated)",
      }
    )
  ),
  content_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Filter to specific content IDs. This is the full-fidelity read: list and Automation reads return a bounded payload_text head (payload_truncated: true, with the full character count in content_length) and drop oversized attachments (attachments_truncated: true), so re-read those ids here to get the complete payload. With automation_id, these exact durable rows are added to the Automation read and signed into its window token in addition to authored sources; this is how workspace-sourced event activations pass bounded event pointers without copying payloads.",
    })
  ),
  exclude_automation_id: Type.Optional(
    Type.Number({
      description:
        "Exclude content already analyzed by any run of this Automation. Returns only unprocessed content for client-driven Automation generation.",
    })
  ),
  semantic_type: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
      description:
        'Filter by semantic type. Pass a single value (e.g. "note") or an array (e.g. ["note","summary"]) to match any. The reserved "notification" value matches events with notification targets, including kind-backed notifications whose stored semantic_type is their content kind.',
    })
  ),
  entity_types: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Org-wide filter: limit to events linked to entities whose type slug is in this list. Ignored when entity_id is set.",
    })
  ),
  interaction_status: Type.Optional(
    Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("approved"),
        Type.Literal("rejected"),
        Type.Literal("completed"),
        Type.Literal("failed"),
      ],
      {
        description:
          'Filter by interaction status (e.g. "pending" for pending approvals)',
      }
    )
  ),
});

/**
 * Accepted at the REST/tool boundary but NOT an MCP or SDK discovery
 * affordance. The Connected App UI receives this exact pair from an
 * authenticated internal endpoint; external callers have no route that
 * constructs it.
 *
 * The server stamps these onto the schema for its argument validator
 * (`markAcceptedInternalFields`); that call belongs to the runtime validator
 * and stays in the server. The field NAMES are contract data and belong here,
 * so every consumer subtracts the same set.
 */
export const GET_CONTENT_INTERNAL_FIELDS = ["mcp_activity_id"] as const;

export const PublicGetContentSchema = Type.Object(
  Object.fromEntries(
    Object.entries(GetContentSchema.properties).filter(
      ([key]) =>
        !(GET_CONTENT_INTERNAL_FIELDS as readonly string[]).includes(key)
    )
  )
);

export type GetContentArgs = Static<typeof GetContentSchema>;

/**
 * The `read_knowledge` input an external caller may actually construct: every
 * declared filter minus the accepted-but-unadvertised internal fields. SDK
 * surfaces that forward straight to `getContent` derive their input type from
 * this so the declared shape cannot drift from the enforced schema.
 */
export type PublicGetContentArgs = Omit<
  GetContentArgs,
  (typeof GET_CONTENT_INTERNAL_FIELDS)[number]
>;
