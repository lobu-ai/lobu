/**
 * THE connection-visibility compiler.
 *
 * Every read seam that can surface connection-sourced data — the SQL
 * `buildScopedQuery` (query_sql / metrics / client.query), recall's
 * search-path/list-path, and `get_content` — produces its "which
 * connection-sourced rows may this principal see?" predicate here, so the rule
 * lives in exactly one place keyed on one {@link AuthzScope}.
 *
 * Two shapes, same rule:
 *  - {@link compileConnectionFkVisibility} — for a table that REFERENCES a
 *    connection via a `connection_id` column (events, event_classifications'
 *    underlying event, feeds). A NULL `connection_id` (system / non-connection
 *    rows) stays visible.
 *  - {@link compileConnectionRowVisibility} — for the `connections` row itself.
 *
 * Rule: a connection is visible when `visibility = 'org'` OR it is the
 * principal's own private connection (`created_by = principal`). A `null`
 * principal (headless / service) sees only org-visible connections. The FK
 * form also excludes soft-deleted connections, matching the recall/content
 * seams' two-step flow.
 */
import type { AuthzScope } from './scope';
import { aclConnectionIdSql } from './acl-observability';

/**
 * Recorded ownership for chat connections whose source permissions are unknown.
 * Agent ownership and workspace roles are not evidence of source access. The
 * runtime key is derived exactly as ACL sync derives it (including BYO slugs).
 * Parameters are bound SQL expressions supplied by the visibility compilers.
 */
export function ownedChatConnectionsSelectSql(orgParam: string, userParam: string): string {
  return `SELECT ${aclConnectionIdSql('c')} AS connection_id
    FROM public.connections c
    WHERE c.organization_id = ${orgParam}
      AND c.deleted_at IS NULL
      AND c.credential_mode IS NOT NULL
      AND c.created_by = ${userParam}`;
}

/** Quote a value as a SQL string literal (single-quote doubling). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function connectionVisibilityPredicate(tableAlias: string, principalSql: string | null): string {
  return `(${tableAlias}.visibility = 'org'${principalSql === null ? '' : ` OR ${tableAlias}.created_by = ${principalSql}`})`;
}

/** Column names must be static server-owned identifiers, never request values. */
export function compileConnectionColumnVisibility(tableAlias: string, principalColumn: string): string {
  return `AND ${connectionVisibilityPredicate(tableAlias, principalColumn)}`;
}

/**
 * Predicate for a table that references a connection via `connection_id`.
 * Binds two params from `baseParamIndex`: the org id and the principal.
 * Returns an `AND (...)` fragment (no leading space).
 */
export function compileConnectionFkVisibility(
  scope: AuthzScope,
  baseParamIndex: number,
  tableAlias: string
): { sql: string; params: Array<string | null> } {
  const orgParam = `$${baseParamIndex}::text`;
  const userParam = `$${baseParamIndex + 1}::text`;
  return {
    sql: `AND (${tableAlias}.connection_id IS NULL OR ${tableAlias}.connection_id IN (
      SELECT vc.id FROM public.connections vc
      WHERE vc.organization_id = ${orgParam}
        AND vc.deleted_at IS NULL
        AND ${connectionVisibilityPredicate('vc', userParam)}
    ))`,
    params: [scope.organizationId, scope.principal],
  };
}

/**
 * Predicate for the `connections` row itself (its own metadata / operation
 * targets). Returns an `AND (...)` fragment (no leading space) of plain SQL
 * text: the principal is a server-derived user id (never client text) embedded
 * as an escaped literal, so the ONE predicate is usable both in positional
 * `sql.unsafe(query, params)` builders and inside tagged-template queries via
 * `sql.unsafe(fragment)` — no per-caller param-index bookkeeping to drift.
 */
export function compileConnectionRowVisibility(scope: AuthzScope, tableAlias: string): string {
  return `AND ${connectionVisibilityPredicate(tableAlias, scope.principal == null ? null : sqlLiteral(scope.principal))}`;
}
