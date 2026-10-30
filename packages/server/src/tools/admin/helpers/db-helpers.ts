/**
 * Shared database helpers for admin tools.
 *
 * Provides reusable "check exists or throw" patterns used across
 * manage_automations, manage_entity_schema, manage_classifiers, etc.
 */

import { type DbClient, pgBigintArray } from '../../../db/client';
import { ToolUserError } from '../../../utils/errors';
import { getWorkspaceRole } from '../../../utils/organization-access';
import { isAdminOrOwnerRole } from '../../access-control';

/**
 * Resolve whether the caller holds admin-tier (admin/owner) access in their
 * bound org. Anonymous / userless callers (`userId == null`) are never admin,
 * so we skip the membership lookup and return false — matching the hand-rolled
 * `ctx.userId ? getWorkspaceRole(...) : null` + `isAdminOrOwnerRole(role)`
 * pattern these handlers previously inlined.
 *
 * Takes an explicit `sql` so callers inside a transaction pass their tx client
 * (admin gating must see uncommitted rows in the same tx).
 */
export async function callerIsAdmin(
  sql: DbClient,
  ctx: { organizationId: string; userId: string | null }
): Promise<boolean> {
  if (!ctx.userId) return false;
  const role = await getWorkspaceRole(sql, ctx.organizationId, ctx.userId);
  return isAdminOrOwnerRole(role);
}

/**
 * Valid tables for requireExists. Uses a whitelist so we can safely
 * interpolate the table name into sql.unsafe() while keeping the id parameterized.
 */
const VALID_TABLES = [
  'automations',
  'entities',
  'connections',
  'feeds',
  'classify_facet',
  'entity_types',
  'entity_relationship_types',
  'runs',
] as const;

type ValidTable = (typeof VALID_TABLES)[number];

/**
 * Verify a record exists in the given table (by numeric id). Throws if not found.
 *
 * @param sql - Database client (or use getDb() default)
 * @param table - Table name (must be in VALID_TABLES whitelist)
 * @param id - Record id (number or numeric string)
 * @param label - Human-readable label for error messages (e.g. "Automation")
 */
export async function requireExists(
  sql: DbClient,
  table: ValidTable,
  id: number | string,
  label?: string
): Promise<void> {
  if (!VALID_TABLES.includes(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const rows = await sql.unsafe(`SELECT id FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  if (rows.length === 0) {
    const displayLabel = label ?? table.replace(/_/g, ' ');
    throw new ToolUserError(`${displayLabel} ${id} not found`, 404, 'NOT_FOUND');
  }
}

/**
 * Validate that every entity id in `entityIds` belongs to `organizationId`.
 *
 * Feeds and automations carry an `entity_ids` array used to link synced events to
 * in-org entities. A cross-org entity id (e.g. a feed in org A pointing at an
 * entity owned by org B) means synced events never link to a valid in-org
 * entity — a silent data-correctness bug. We reject it at create/update time.
 *
 * Returns the deduped list of ids that ARE in the org (empty/undefined input
 * returns `[]`). Throws an Error naming the offending ids when any id is
 * missing or belongs to another org. `entities` has no soft-delete column, so
 * a row simply present + org-scoped is sufficient.
 */
export async function assertEntityIdsInOrg(
  sql: DbClient,
  organizationId: string,
  entityIds: number[] | null | undefined
): Promise<number[]> {
  const requested = [...new Set((entityIds ?? []).map(Number).filter(Number.isFinite))];
  if (requested.length === 0) return [];

  const rows = await sql<{ id: number }>`
    SELECT id FROM entities
    WHERE organization_id = ${organizationId}
      AND id = ANY(${pgBigintArray(requested)}::bigint[])
  `;
  const found = new Set(rows.map((r) => Number(r.id)));
  const invalid = requested.filter((id) => !found.has(id));
  if (invalid.length > 0) {
    throw new ToolUserError(
      `entity_ids do not belong to this organization (or do not exist): ${invalid.join(', ')}`,
      400,
      'VALIDATION'
    );
  }
  return requested;
}

/**
 * Tables whose `id` column is allocated via SELECT MAX(id) + 1. Whitelisted so
 * the table name can be safely interpolated into sql.unsafe().
 */
const NUMERIC_ID_TABLES = ['automations', 'automation_run_events', 'automation_versions'] as const;

type NumericIdTable = (typeof NUMERIC_ID_TABLES)[number];

/**
 * Allocate the next numeric id for a whitelisted table (`COALESCE(MAX(id), 0) + 1`).
 *
 * Race-free across concurrent transactions via a per-table Postgres advisory
 * lock keyed on `hashtext('<table>_id_alloc')`. The lock is acquired with
 * `pg_advisory_xact_lock`, so it's released automatically when the calling
 * transaction commits or rolls back. To get serialization across the
 * subsequent INSERT, the caller MUST invoke this from within a transaction
 * (otherwise each statement is its own implicit tx and the lock releases
 * before the INSERT executes — same race as without the lock).
 *
 * Without the advisory lock, two concurrent completions on DIFFERENT rows
 * (e.g. two device workers completing two different automation runs) can both
 * compute the same `MAX(id)+1` and one will fail on the target table's PK
 * conflict. With the lock + caller-side tx, the second caller blocks until
 * the first commits (and thus sees the first INSERT in its `MAX(id)`).
 */
export async function getNextNumericId(sql: DbClient, table: NumericIdTable): Promise<number> {
  if (!NUMERIC_ID_TABLES.includes(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  // Per-table key: `hashtext` returns a stable int4 derived from the string.
  // Same table → same key → serialized allocation; different tables → distinct
  // keys → no false sharing.
  await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}_id_alloc`]);
  const rows = await sql.unsafe<{ next_id: number }>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ${table}`
  );
  return Number(rows[0]?.next_id ?? 1);
}
