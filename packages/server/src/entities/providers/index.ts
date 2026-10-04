/**
 * Record providers: one seam that says where a record of an entity type lives.
 *
 * - `stored`: rows in `entities` (the default). Features keep their stored paths.
 * - `remote`: the type is a SQL view (`backing_sql`). A connection-backed view
 *   is read live from its source by exact key. Ref-based activity and
 *   relationships read the source plus Lobu events pointing at the record
 *   through `events.entity_refs`, without materializing source rows.
 *
 * Features ask {@link getRecordProvider} instead of branching on `backing_sql`.
 */

import { type EntityRef, parseEntityRef } from '@lobu/core/contracts/entity-ref';
import { getErrorMessage, isRetryable, type ToolErrorCode } from '@lobu/core';
import { type DbClient, getDb } from '../../db/client';
import { querySqlImpl } from '../../tools/admin/query_sql';
import type { ToolContext } from '../../tools/registry';
import { ToolUserError } from '../../utils/errors';
import { getWorkspaceRole } from '../../utils/organization-access';

export interface RecordTypeRow {
  id: number;
  slug: string;
  backing_sql: string | null;
  backing_source: string | null;
  backing_activity_sql: string | null;
}

type RecordProvider =
  | { kind: 'stored'; type: RecordTypeRow }
  | { kind: 'remote'; type: RecordTypeRow; connectionBacked: boolean };

export function getRecordProvider(type: RecordTypeRow): RecordProvider {
  return type.backing_sql
    ? { kind: 'remote', type, connectionBacked: Boolean(type.backing_source) }
    : { kind: 'stored', type };
}

/** An entity type of the caller's OWN org (never the public catalog). */
export async function loadOwnEntityType(
  orgId: string,
  slug: string,
  sql: DbClient = getDb()
): Promise<RecordTypeRow | null> {
  const rows = await sql<RecordTypeRow>`
    SELECT id, slug, backing_sql, backing_source, backing_activity_sql
    FROM entity_types
    WHERE organization_id = ${orgId}
      AND slug = ${slug}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
}

export interface ResolvedRemoteRef {
  ref: string;
  parsed: EntityRef;
  type: RecordTypeRow;
}

/**
 * Validate a `<type>:<key>` ref against the caller's org: well formed, an
 * org-owned type, and that type is connection-backed. A stored type is refused
 * with a pointer to its id-keyed surface.
 */
export async function resolveRemoteRef(
  value: string,
  ctx: ToolContext,
  field = 'entity'
): Promise<ResolvedRemoteRef> {
  const parsed = parseEntityRef(value);
  if (!parsed) {
    throw new ToolUserError(`${field} must be a '<type>:<key>' ref (got '${value}')`, 400);
  }
  if (!ctx.organizationId) {
    throw new ToolUserError(`${field} requires a workspace`, 400);
  }
  const sql = getDb();
  if (ctx.userId) {
    const role = await getWorkspaceRole(sql, ctx.organizationId, ctx.userId);
    if (role === null) throw new ToolUserError('You do not have access to this workspace', 403);
  }
  const type = await loadOwnEntityType(ctx.organizationId, parsed.type, sql);
  if (!type) {
    throw new ToolUserError(`Entity type '${parsed.type}' not found in this workspace`, 404);
  }
  const provider = getRecordProvider(type);
  if (provider.kind !== 'remote' || !provider.connectionBacked) {
    throw new ToolUserError(
      `Entity type '${parsed.type}' is not connection-backed; address its records by entity id`,
      400
    );
  }
  return { ref: value, parsed, type };
}

/** A backed relationship type whose rules name a given entity type. */
export interface BackedRelationshipType {
  id: number;
  slug: string;
  backing_sql: string;
  backing_source: string;
  /** Counterpart types of edges leaving the record (rules with it as source). */
  targets: string[];
  /** Counterpart types of edges arriving at the record (rules with it as target). */
  sources: string[];
}

export async function listBackedRelationshipTypes(
  orgId: string,
  typeSlug: string,
  sql: DbClient = getDb()
): Promise<BackedRelationshipType[]> {
  const rows = await sql<{
    id: number;
    slug: string;
    backing_sql: string;
    backing_source: string;
    source_entity_type_slug: string;
    target_entity_type_slug: string;
  }>`
    SELECT rt.id, rt.slug, rt.backing_sql, rt.backing_source,
      r.source_entity_type_slug, r.target_entity_type_slug
    FROM entity_relationship_types rt
    JOIN entity_relationship_type_rules r
      ON r.relationship_type_id = rt.id AND r.deleted_at IS NULL
    WHERE rt.organization_id = ${orgId}
      AND rt.deleted_at IS NULL
      AND rt.status = 'active'
      AND rt.backing_sql IS NOT NULL
      AND (r.source_entity_type_slug = ${typeSlug} OR r.target_entity_type_slug = ${typeSlug})
    ORDER BY rt.slug, r.id
  `;
  const byId = new Map<number, BackedRelationshipType>();
  for (const row of rows) {
    const id = Number(row.id);
    let entry = byId.get(id);
    if (!entry) {
      entry = {
        id,
        slug: row.slug,
        backing_sql: row.backing_sql,
        backing_source: row.backing_source,
        targets: [],
        sources: [],
      };
      byId.set(id, entry);
    }
    if (row.source_entity_type_slug === typeSlug && !entry.targets.includes(row.target_entity_type_slug)) {
      entry.targets.push(row.target_entity_type_slug);
    }
    if (row.target_entity_type_slug === typeSlug && !entry.sources.includes(row.source_entity_type_slug)) {
      entry.sources.push(row.source_entity_type_slug);
    }
  }
  return [...byId.values()];
}

/** What a remote record supports, for the record page. */
export async function remoteCapabilities(
  orgId: string,
  type: RecordTypeRow
): Promise<{ activity: boolean; relationships: boolean }> {
  if (!type.backing_source) return { activity: false, relationships: false };
  const backed = await listBackedRelationshipTypes(orgId, type.slug);
  return { activity: Boolean(type.backing_activity_sql), relationships: backed.length > 0 };
}

type RemoteReadResult =
  | { ok: true; rows: Record<string, unknown>[]; hasMore: boolean }
  | { ok: false; error: string; error_code: ToolErrorCode; retryable: boolean };

/**
 * The one remote read: backing SQL on a connection plus an exact match on a key
 * column, through the same `querySqlImpl` → `runConnectorQuery` pushdown every
 * source read uses. Failures come back as values so a caller can report one
 * stream's failure next to another stream's rows; they are never an empty
 * success.
 */
export async function readRemoteByKey(
  params: {
    sql: string;
    connection: string;
    keyColumn: string;
    key: string;
    limit: number;
    offset: number;
    sort: { column: string; order: 'asc' | 'desc' };
  },
  ctx: ToolContext
): Promise<RemoteReadResult> {
  try {
    const result = await querySqlImpl(
      {
        sql: params.sql,
        connection: params.connection,
        limit: params.limit,
        offset: params.offset,
        sort_by: params.sort.column,
        sort_order: params.sort.order,
      },
      undefined,
      ctx,
      {
        // Offsets count rows, so a byte-capped page would skip its tail.
        maxSerializedResultBytes: Number.POSITIVE_INFINITY,
        exactMatch: { columns: [params.keyColumn], value: params.key },
      }
    );
    if (result.error) {
      const code = result.error_code ?? 'VALIDATION';
      return { ok: false, error: result.error, error_code: code, retryable: isRetryable(code) };
    }
    return { ok: true, rows: result.rows, hasMore: result.has_more };
  } catch (err) {
    const code: ToolErrorCode =
      err instanceof ToolUserError && err.code ? err.code : 'INTERNAL';
    return { ok: false, error: getErrorMessage(err), error_code: code, retryable: isRetryable(code) };
  }
}
