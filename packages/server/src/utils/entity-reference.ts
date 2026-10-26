/** One permission-aware resolver for stored IDs and typed source keys. Never materializes rows. */
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import { authzScopeFromToolContext } from '../authz/scope';
import { isAdminOrOwnerRole } from '../tools/access-control';
import { raceAbort } from './race-abort';
import { recordKey, recordKeyColumn } from '@lobu/core/contracts/entity-reference';
import { type EntityReadRestrictions, entityReadRestrictions, filterEntityReadRows } from '../authz/entity-read-policy';
import { type DbClient, getDb } from '../db/client';
import type { ToolContext } from '../tools/registry';
import { derivedRowName, queryDerivedEntityView } from './entity-management';
import { ToolUserError, toolErrorHttpStatus } from './errors';
import { normalizeEntityTypeSlug } from './reserved';

export interface EntityEndpoint {
  entityId: number | null;
  sourceTypeId: number | null;
  sourceKey: string | null;
}

export interface ResolvedEntityReference extends EntityEndpoint {
  id: number | string;
  typeId: number;
  entityType: string;
  organizationId: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
  sourceContract?: string;
}

export async function resolveEntityReference(
  id: number | string,
  entityType: string | undefined,
  ctx: ToolContext,
  options: { readSource?: boolean; restrictions?: EntityReadRestrictions } = {},
): Promise<ResolvedEntityReference> {
  const sql = getDb();
  const restrictions = options.restrictions ?? await entityReadRestrictions(sql, ctx);
  if (typeof id === 'number') {
    if (!Number.isSafeInteger(id) || id < 1) throw new ToolUserError('entity_id must be a positive integer or a typed source key', 400);
    const rows = await sql`
      SELECT e.id, e.entity_type_id, e.organization_id, e.name, e.slug, e.metadata, et.slug AS entity_type
      FROM entities e JOIN entity_types et ON et.id = e.entity_type_id
      LEFT JOIN organization o ON o.id = e.organization_id
      WHERE e.id = ${id} AND e.deleted_at IS NULL AND et.deleted_at IS NULL
        AND (e.organization_id = ${ctx.organizationId} OR o.visibility = 'public')
    `;
    const allowed = await filterEntityReadRows(sql, rows as Array<typeof rows[number] & { id: number }>, restrictions);
    const row = allowed[0];
    if (!row) throw new ToolUserError('Entity not found or not readable', 404);
    if (entityType !== undefined && normalizeEntityTypeSlug(entityType) !== row.entity_type) {
      throw new ToolUserError('entity_type does not match entity_id', 400);
    }
    return { id, entityId: id, sourceTypeId: null, sourceKey: null, typeId: Number(row.entity_type_id),
      entityType: String(row.entity_type), organizationId: String(row.organization_id), name: String(row.name),
      slug: String(row.slug), metadata: row.metadata ?? {} };
  }
  if (typeof id !== 'string' || !entityType || recordKey({ key: id }, 'key') === null) {
    throw new ToolUserError('A string entity_id requires entity_type and a non-empty source key of at most 1024 UTF-8 bytes', 400);
  }
  const type = normalizeEntityTypeSlug(entityType);
  if (type.startsWith('$')) throw new ToolUserError('System entity types do not accept source keys', 400);
  if (restrictions.some(rule => rule.entity_id === null && (rule.entity_type_slug === null || rule.entity_type_slug === type))) {
    throw new ToolUserError('Entity type is not readable', 403);
  }
  const rows = await sql`
    SELECT id, organization_id, slug, backing_sql, backing_source, metadata_schema FROM entity_types
    WHERE organization_id = ${ctx.organizationId} AND slug = ${type} AND deleted_at IS NULL
  `;
  const row = rows[0];
  if (!row) throw new ToolUserError('Entity type not found or not readable', 404);
  if (!row.backing_sql) throw new ToolUserError('String entity_id requires a source-backed entity type', 400);
  const keyColumn = recordKeyColumn(row.metadata_schema);
  if (!keyColumn) throw new ToolUserError('This type has no declared stable record key (metadata_schema.x-lobu-record-key)', 400);
  const ref: ResolvedEntityReference = { id, entityId: null, sourceTypeId: Number(row.id), sourceKey: id,
    typeId: Number(row.id), entityType: type, organizationId: String(row.organization_id), name: id, slug: id, metadata: {},
    sourceContract: JSON.stringify([row.backing_sql, row.backing_source ?? null, keyColumn]) };
  if (options.readSource === false) return ref;
  // Check connection visibility before cancellation or source errors can be
  // disclosed as a failed relationship. Row-level visibility still belongs to
  // the live exact read below; no source key is disclosed without that read.
  if (row.backing_source) {
    const visibility = isAdminOrOwnerRole(ctx.memberRole) ? sql``
      : sql`${sql.unsafe(compileConnectionRowVisibility(authzScopeFromToolContext(ctx), 'connections'))}`;
    const visible = await sql`SELECT 1 FROM connections WHERE organization_id = ${ctx.organizationId}
      AND slug = ${row.backing_source} AND deleted_at IS NULL AND status = 'active' ${visibility}`;
    if (!visible.length) throw new ToolUserError('Source connection not found or not readable', 404);
  }
  let result: Awaited<ReturnType<typeof queryDerivedEntityView>>;
  try {
    ctx.abortSignal?.throwIfAborted();
    result = await raceAbort(queryDerivedEntityView(String(row.backing_sql), row.backing_source ?? undefined,
      { limit: 2, offset: 0 }, ctx, { exactSlug: id, keyColumn, preservePageRows: true }), ctx.abortSignal);
  } catch (error) {
    if (ctx.abortSignal?.aborted) throw new ToolUserError('Source record read exceeded the deadline', 500, 'UPSTREAM_TIMEOUT');
    throw error;
  }
  if (result.error) {
    const code = result.error_code ?? 'UPSTREAM_UNAVAILABLE';
    throw new ToolUserError('Source record could not be read', toolErrorHttpStatus(code), code);
  }
  const matches = result.rows.filter(candidate => recordKey(candidate, keyColumn) === id);
  if (matches.length === 0) throw new ToolUserError('Source record not found or not readable', 404);
  if (matches.length !== 1) throw new ToolUserError('The declared record key is not unique', 409);
  return { ...ref, name: derivedRowName(matches[0], id), metadata: matches[0] };
}

/** Canonical ordering is shared by creation and endpoint-triple lookup. */
export function compareEntityEndpoints(a: EntityEndpoint, b: EntityEndpoint): number {
  if (a.entityId !== null && b.entityId !== null) return a.entityId - b.entityId;
  if (a.entityId !== null) return -1;
  if (b.entityId !== null) return 1;
  return (a.sourceTypeId! - b.sourceTypeId!) || (a.sourceKey! < b.sourceKey! ? -1 : a.sourceKey === b.sourceKey ? 0 : 1);
}

/** Lock the type contract while an edge is committed; lifecycle guards take the conflicting lock. */
export async function lockEndpointTypes(tx: DbClient, endpoints: ResolvedEntityReference[]): Promise<void> {
  for (const endpoint of [...endpoints].sort((a, b) => a.typeId - b.typeId)) {
    const rows = await tx`SELECT id, backing_sql, backing_source, metadata_schema FROM entity_types WHERE id = ${endpoint.typeId} AND deleted_at IS NULL FOR SHARE`;
    if (!rows.length) throw new ToolUserError('Entity type changed; retry the operation', 409);
    if (endpoint.sourceContract && endpoint.sourceContract !== JSON.stringify([rows[0].backing_sql, rows[0].backing_source ?? null, recordKeyColumn(rows[0].metadata_schema)])) {
      throw new ToolUserError('Source record contract changed; retry the operation', 409);
    }
  }
}
