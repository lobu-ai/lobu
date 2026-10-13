/**
 * Shared execution for query_metric and Automation metric sources. Compiles a
 * declared or inferred measure, then reads through either the scoped local DB
 * or the backing connection's read-only query path.
 */

import type { EntityMetrics } from "@lobu/connector-sdk";
import { getErrorMessage } from "@lobu/core";
import { authzScopeFromToolContext } from "../authz/scope";
import { getDb } from "../db/client";
import { classifyPushdownFailure, runConnectorQuery } from "../lib/connector-pushdown";
import { ToolUserError, toolErrorHttpStatus } from "../utils/errors";
import { validateAndScopeQuery } from "../utils/execute-data-sources";
import { type ColumnDef, SAFE_COLUMN_DEFS } from "../utils/table-schema";
import { compileDerivedMetricSql, compileMetricSql } from "./compiler";
import { MetricNotImplementedError } from "./errors";

const METRIC_SAFE_COLUMNS = new Map<string, ColumnDef[]>(SAFE_COLUMN_DEFS);
METRIC_SAFE_COLUMNS.set("entity_identities", [
  { name: "entity_id", type: "bigint" },
  { name: "namespace", type: "text" },
  { name: "identifier", type: "text" },
  { name: "scope_key", type: "text" },
  { name: "deleted_at", type: "timestamptz" },
]);

interface RunMetricInput {
  organizationId: string;
  /** Entity type slug (e.g. "company"). */
  entityType: string;
  /** Declared measure name (e.g. "spend"). */
  measure: string;
  /** Dimension names to group by. */
  by?: string[];
  /** Extra segment name to AND in. */
  segment?: string;
  /** Restrict to one entity (entities.id). */
  entityId?: number;
  /**
   * The requesting user, threaded into the events CTE for per-user connection
   * visibility. Omit/null for headless callers (scheduled rollups, warehouse
   * jobs) — yields org-visible-only, fail-closed for private-connection data.
   */
  userId?: string | null;
  /**
   * Exclude workspace-identity audit events from the events CTE. Owner/admin
   * and trusted system callers leave this false; ordinary members / public
   * readers must set true so member/invitation lifecycle cannot move metrics.
   */
  excludeWorkspaceAudit?: boolean;
  /**
   * Exclude $member entities from the entities CTE. REQUIRED (no default):
   * ordinary members / public readers must set true so member PII cannot move
   * metrics past the manage_entity policy; owner/admin and trusted system
   * callers set false explicitly.
   */
  excludeMemberEntities: boolean;
  /**
   * Owner/admin connection bypass for a connection-backed type, decided exactly
   * as `query_sql` decides it for a derived record read
   * (`isAdminOrOwnerRole(ctx.memberRole)`). Omitted ⇒ false: the backing
   * connection must pass the shared connection-visibility predicate for
   * `userId` (a null principal sees org-visible connections only).
   */
  isAdmin?: boolean;
}

/**
 * Matches the Postgres connector's page cap. Incomplete metric results fail
 * rather than return a partial set of precomputed measures.
 */
const METRIC_PUSHDOWN_MAX_ROWS = 5000;

export async function runMetric(input: RunMetricInput): Promise<Record<string, unknown>[]> {
  const sql = getDb();
  const found = await sql`
    SELECT id, metrics_config, backing_sql, backing_source
    FROM entity_types
    WHERE slug = ${input.entityType}
      AND organization_id = ${input.organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (found.length === 0) {
    throw new Error(`entity type "${input.entityType}" not found`);
  }
  const entityTypeId = Number(found[0].id);
  const metrics = (found[0].metrics_config ?? {}) as EntityMetrics;
  const backingSql = found[0].backing_sql as string | null;
  const backingSource = (found[0].backing_source as string | null) || null;
  if (backingSource) {
    return runPushdownMetric(input, metrics, backingSql, backingSource);
  }
  const usesDerivedMetric = !metrics.measures?.[input.measure] && backingSql !== null;
  const rawSql = usesDerivedMetric
    ? compileDerivedMetricSql({
        backingSql: backingSql!,
        measure: input.measure,
        by: input.by,
        segment: input.segment,
        entityId: input.entityId,
      })
    : compileMetricSql({
        entityTypeId,
        metrics,
        measure: input.measure,
        by: input.by,
        segment: input.segment,
        entityId: input.entityId,
      });
  const scoped = validateAndScopeQuery(rawSql, input.organizationId, {
    safeColumns: usesDerivedMetric ? SAFE_COLUMN_DEFS : METRIC_SAFE_COLUMNS,
    userId: input.userId ?? null,
    excludeWorkspaceAudit: input.excludeWorkspaceAudit,
    excludeMemberEntities: input.excludeMemberEntities,
  });

  const rows = await sql.begin(async (tx: typeof sql) => {
    await tx`SET TRANSACTION READ ONLY`;
    return tx.unsafe(scoped.sql, scoped.params as unknown[]);
  });
  return rows as unknown as Record<string, unknown>[];
}

/**
 * A connection-backed type's rows live in its source, so its metric runs there:
 * the compiled projection over `backing_sql` goes through `runConnectorQuery`,
 * the same pushdown (and the same connection-visibility gate) `query_sql`
 * applies when a derived record read names `connection = backing_source`.
 */
async function runPushdownMetric(
  input: RunMetricInput,
  metrics: EntityMetrics,
  backingSql: string | null,
  backingSource: string,
): Promise<Record<string, unknown>[]> {
  if (metrics.measures?.[input.measure] || !backingSql) {
    throw new MetricNotImplementedError(
      `measure "${input.measure}" on "${input.entityType}" is declared over Lobu events, but the type is backed by connection "${backingSource}"; only measures inferred from its backing SQL can run`,
    );
  }
  const query = compileDerivedMetricSql({
    backingSql,
    measure: input.measure,
    by: input.by,
    segment: input.segment,
    entityId: input.entityId,
  });
  let result: Awaited<ReturnType<typeof runConnectorQuery>>;
  try {
    result = await runConnectorQuery({
      scope: authzScopeFromToolContext({
        organizationId: input.organizationId,
        userId: input.userId ?? null,
      }),
      isAdmin: input.isAdmin ?? false,
      connectionSlug: backingSource,
      query,
      limit: METRIC_PUSHDOWN_MAX_ROWS,
    });
  } catch (err) {
    // Same hard-error contract as query_sql's pushdown branch: a failed source
    // query is never a success-shaped empty metric.
    const code = classifyPushdownFailure(err);
    throw new ToolUserError(
      `connection pushdown failed (connection=${backingSource}): ${getErrorMessage(err)}. ` +
        "The metric did not run against the source — this is not an empty result.",
      toolErrorHttpStatus(code),
      code,
    );
  }
  const truncated =
    result.total !== undefined
      ? result.total > result.rows.length
      : result.rows.length >= METRIC_PUSHDOWN_MAX_ROWS;
  if (truncated) {
    throw new ToolUserError(
      `metric "${input.measure}" on "${input.entityType}" returned an incomplete result from connection "${backingSource}" (row limit ${METRIC_PUSHDOWN_MAX_ROWS}); reduce the rows produced by its backing SQL.`,
      422,
    );
  }
  return result.rows;
}
