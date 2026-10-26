/**
 * Standard parameter-building helpers for the listing path:
 * buildStandardParams, buildStandardWhereSql, RUN_JOIN_SQL.
 */

import { buildEventResourceFilterClause } from './resource-filter';
import { pgTextArray } from '../../db/client';
import { INTERNAL_OPS_EXCLUSION_SQL, operationalTrailExclusionSql } from './sql-fragments';
import type { ContentSearchOptions } from './types';

/**
 * `notification` is a virtual Activity kind: notification identity comes from
 * notification_targets, while the event's semantic_type may be its content
 * kind (for example `funnel_digest`). Expand only that sentinel to the
 * authoritative row-presence check. Mixed selections remain an OR.
 */
export function buildSemanticTypeFilterSql(alias: string, paramSql: string): string {
  return `((${paramSql}::text[] @> ARRAY['notification']::text[]
            AND EXISTS (
              SELECT 1 FROM notification_targets nt
              WHERE nt.event_id = ${alias}.id
            ))
           OR ${alias}.semantic_type = ANY(array_remove(${paramSql}::text[], 'notification')))`;
}

export function buildStandardParams(
  options: ContentSearchOptions & { offset?: number },
  extra: {
    sinceDate: Date | null;
    untilDate: Date | null;
  }
): any[] {
  return [
    options.entity_id ?? null,
    options.platform ?? null,
    extra.sinceDate?.toISOString() ?? null,
    extra.untilDate?.toISOString() ?? null,
    options.run_id ?? null,
    options.engagement_min ?? null,
    options.engagement_max ?? null,
    options.classification_source ?? null,
    // Slot $9 binds a Postgres `text[]` literal (e.g. `'{note,summary}'`); the
    // standard WHERE template uses `= ANY($9::text[])`, covering single- and
    // multi-type callers with one predicate. We hand-format the literal because
    // `sql.unsafe(...)` binding doesn't auto-cast JS arrays.
    options.semantic_type
      ? pgTextArray(
          Array.isArray(options.semantic_type) ? options.semantic_type : [options.semantic_type]
        )
      : null,
    options.interaction_status ?? null,
    // Slot $11 — per-agent memory scope. WHERE template uses
    // `($11::text IS NULL OR f.metadata->>'agent_id' = $11::text)`.
    options.agent_id ?? null,
    // Slot $12 — per-OAuth-client scope. Always an array (a client that
    // re-registers has several ids under one name), so the predicate is a
    // single `= ANY(...)` for both the one-id and many-id cases. pgTextArray
    // because `sql.unsafe(...)` does not auto-cast JS arrays — see the
    // semantic_type slot above.
    options.client_id
      ? pgTextArray(Array.isArray(options.client_id) ? options.client_id : [options.client_id])
      : null,
    // Slot $13 — exact MCP conversation transport scope. Unlike ordinary
    // optional arrays, an empty array is load-bearing: it must match nothing.
    options.mcp_session_ids !== undefined ? pgTextArray(options.mcp_session_ids) : null,
  ];
}

/**
 * Build the shared `WHERE` skeleton used by `listContentInternal` for both
 * its count and list queries.
 *
 * `entityLinkSql` is the per-request fragment for "which events belong to
 * this entity" — see `buildEntityLinkUnion`. Pre-computing it once and
 * passing it in avoids re-emitting (and re-planning) the 7-branch generic
 * UNION for every query.
 */
export function buildStandardWhereSql(
  entityLinkSql: string,
  opts?: { entityScoped?: boolean },
): string {
  // Keep entity-scoped subqueries outside an OR so the planner can use a
  // semi-join. Retain a typed $1 reference: the link inlines the entity id,
  // but PostgreSQL still needs a type for every supplied parameter slot.
  const linkExpr = opts?.entityScoped
    ? `${entityLinkSql} AND ($1::bigint IS NOT NULL)`
    : `($1::bigint IS NULL OR ${entityLinkSql})`;
  return `${linkExpr}
          AND ($2::text IS NULL OR f.connector_key = $2::text)
          AND ($3::timestamptz IS NULL OR f.occurred_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR f.occurred_at <= $4::timestamptz)
          AND ($5::int IS NULL OR iwf.run_id = $5::int)
          AND ($6::numeric IS NULL OR f.score >= $6::numeric)
          AND ($7::numeric IS NULL OR f.score <= $7::numeric)
          AND ($8::text IS NULL OR EXISTS (
            SELECT 1 FROM event_classifications lc_source
            WHERE lc_source.event_id = f.id
              AND lc_source.source = $8::text
          ))
          AND ($9::text[] IS NULL OR ${buildSemanticTypeFilterSql('f', '$9')})
          AND ($10::text IS NULL OR f.interaction_status = $10::text)
          AND ($11::text IS NULL OR f.metadata->>'agent_id' = $11::text)
          AND ($12::text[] IS NULL OR f.client_id = ANY($12::text[]))
          AND ($13::text[] IS NULL OR f.metadata->>'mcp_session_id' = ANY($13::text[]))`;
}

/**
 * The feed's recency key, spelled exactly as idx_events_live_org_effective_date
 * indexes it. A `since`/`until` bound on `f.occurred_at` alone is the filter's
 * meaning; the same bound restated on this expression is implied by it (a
 * non-NULL occurred_at is its own COALESCE) and is what lets the index bound
 * the ordered scan to the window instead of filtering the org's whole history.
 */
const EFFECTIVE_AT_SQL = 'COALESCE(f.occurred_at, f.created_at)';

/**
 * The redundant `since`/`until` restatement on EFFECTIVE_AT_SQL, for the date
 * feed's direct-org arm only (see buildDateCandidateSetSql). Each param is a
 * `$N::timestamptz` slot that may bind NULL, or null when the caller has none.
 */
export function buildEffectiveAtRangeSql(
  sinceParam: string | null,
  untilParam: string | null
): string {
  const parts: string[] = [];
  if (sinceParam) parts.push(`AND (${sinceParam} IS NULL OR ${EFFECTIVE_AT_SQL} >= ${sinceParam})`);
  if (untilParam) parts.push(`AND (${untilParam} IS NULL OR ${EFFECTIVE_AT_SQL} <= ${untilParam})`);
  return parts.join(' ');
}

export const RUN_JOIN_SQL = `LEFT JOIN automation_run_events iwf
          ON iwf.event_id = f.id
          AND ($5::int IS NOT NULL)
          AND iwf.run_id = $5::int`;

/**
 * Per-request event filters that every `read_knowledge` builder must apply
 * identically: platform, occurred_at window, run, engagement, semantic type,
 * interaction status, agent/client/conversation scope, and the workspace-audit
 * / internal-ops discovery filters.
 *
 * Dynamic parameter appending: each bound value is pushed onto `params` and
 * its fragment references `$${params.length}`, so callers never track a
 * fixed positional slot by hand and two builders cannot drift a `$N` apart.
 * `sinceDate`/`untilDate` are pre-parsed Dates (callers own the date-alias
 * parsing). The events table is always aliased `f`: INTERNAL_OPS_EXCLUSION_SQL
 * is `f`-bound, and every `read_knowledge` builder that needs these filters
 * already reads `current_event_records f`.
 *
 * Entity-link, org scope, classification EXISTS, automation
 * analyzed/produced/excluded, visibility, and entity-types clauses stay with
 * their dedicated builders — they need arm-splitting or cross-table joins
 * this helper must not hide.
 */
export function appendStandardEventFilters(
  conditions: string[],
  params: any[],
  filters: Pick<
    ContentSearchOptions,
    | 'platform'
    | 'run_id'
    | 'engagement_min'
    | 'engagement_max'
    | 'semantic_type'
    | 'event_category'
    | 'resource_kind'
    | 'resource_id'
    | 'interaction_status'
    | 'agent_id'
    | 'client_id'
    | 'mcp_session_ids'
    | 'exclude_workspace_audit'
    | 'exclude_operational_trail'
    | 'exclude_internal_ops'
  > & { sinceDate?: Date | null; untilDate?: Date | null }
): { sinceParam: string | null; untilParam: string | null } {
  const alias = 'f';
  let sinceParam: string | null = null;
  let untilParam: string | null = null;
  if (filters.platform) {
    params.push(filters.platform);
    conditions.push(`${alias}.connector_key = $${params.length}`);
  }
  if (filters.sinceDate) {
    params.push(filters.sinceDate.toISOString());
    conditions.push(`${alias}.occurred_at >= $${params.length}`);
    sinceParam = `$${params.length}::timestamptz`;
  }
  if (filters.untilDate) {
    params.push(filters.untilDate.toISOString());
    conditions.push(`${alias}.occurred_at <= $${params.length}`);
    untilParam = `$${params.length}::timestamptz`;
  }
  if (filters.run_id != null) {
    params.push(filters.run_id);
    conditions.push(
      `EXISTS (SELECT 1 FROM automation_run_events iwf WHERE iwf.event_id = ${alias}.id AND iwf.run_id = $${params.length})`
    );
  }
  if (filters.engagement_min != null) {
    params.push(filters.engagement_min);
    conditions.push(`${alias}.score >= $${params.length}`);
  }
  if (filters.engagement_max != null) {
    params.push(filters.engagement_max);
    conditions.push(`${alias}.score <= $${params.length}`);
  }
  if (filters.semantic_type) {
    // Match any of the requested types — single-string callers get wrapped
    // into a one-element Postgres array literal so the same predicate fits.
    const types = Array.isArray(filters.semantic_type)
      ? filters.semantic_type
      : [filters.semantic_type];
    params.push(pgTextArray(types));
    conditions.push(buildSemanticTypeFilterSql(alias, `$${params.length}`));
  }
  if (filters.exclude_workspace_audit) {
    conditions.push(`NOT (${alias}.metadata ? '_lobu_workspace_audit')`);
  }
  if (filters.exclude_operational_trail) {
    conditions.push(operationalTrailExclusionSql(alias));
  }
  // Internal-ops discovery filter. An explicit semantic_type filter wins: a
  // caller asking for 'audit' rows is reading the ops trail on purpose.
  if (filters.exclude_internal_ops && !filters.semantic_type) {
    conditions.push(INTERNAL_OPS_EXCLUSION_SQL);
  }
  if (filters.interaction_status) {
    params.push(filters.interaction_status);
    conditions.push(`${alias}.interaction_status = $${params.length}`);
  }
  if (filters.agent_id) {
    params.push(filters.agent_id);
    conditions.push(`${alias}.metadata->>'agent_id' = $${params.length}`);
  }
  if (filters.client_id) {
    // `events.client_id` is a real indexed column, not a metadata field — a
    // plain column predicate. Always ANY() so one id and a re-registered
    // client's many ids share a single shape.
    const clientIds = Array.isArray(filters.client_id) ? filters.client_id : [filters.client_id];
    params.push(pgTextArray(clientIds));
    conditions.push(`${alias}.client_id = ANY($${params.length}::text[])`);
  }
  if (filters.mcp_session_ids !== undefined) {
    params.push(pgTextArray(filters.mcp_session_ids));
    conditions.push(`${alias}.metadata->>'mcp_session_id' = ANY($${params.length}::text[])`);
  }
  const resource = buildEventResourceFilterClause(filters, params.length + 1);
  conditions.push(...resource.conditions);
  params.push(...resource.params);
  return { sinceParam, untilParam };
}
