/**
 * runMetric — the shared metric execution path. Loads an entity type's declared
 * metrics_config, compiles the requested measure to SQL (compiler.ts), org-scopes
 * it via `validateAndScopeQuery` (which rewrites `events` → current_event_records
 * + scopes both tables), and runs it read-only.
 *
 * This is the single entry point a `query_metric` MCP tool will wrap, and the
 * same aggregation/execution path a federated warehouse metric flows through —
 * only the relation differs (compiled-over-events here vs a connector's view).
 */

import type { EntityMetrics } from "@lobu/connector-sdk";
import { getDb } from "../db/client";
import { validateAndScopeQuery } from "../utils/execute-data-sources";
import { type ColumnDef, SAFE_COLUMN_DEFS } from "../utils/table-schema";
import { compileDerivedMetricSql, compileMetricSql } from "./compiler";

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
}

export async function runMetric(input: RunMetricInput): Promise<Record<string, unknown>[]> {
  const sql = getDb();
  const found = await sql`
    SELECT id, metrics_config, backing_sql
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
