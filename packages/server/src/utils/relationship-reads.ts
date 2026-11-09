/** Permission-aware reads for authored relationships and their bounded pagination. */
import type {
  ListLinksAction,
  RelationshipCountByType,
  RelationshipReadFailure,
  RelationshipRow,
} from '@lobu/core/contracts/tools/manage-entity';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  type EntityReadRestrictions,
  entityReadPolicySql,
  entityReadRestrictions,
  filterEntityReadRows,
} from '../authz/entity-read-policy';
import { sourceReadScopeFromToolContext } from '../authz/scope';
import { getDb, pgBigintArray } from '../db/client';
import { MEMBER_ENTITY_TYPE_SLUG } from '../tools/constants';
import type { ToolContext } from '../tools/registry';
import { type EntityEndpoint, type ResolvedEntityReference, resolveEntityReference } from './entity-reference';
import { ToolUserError } from './errors';
import { buildEntityViewUrl } from '../tools/view-urls';
import { canSeeMemberList } from './member-entity-type';
import { RELATIONSHIP_CLAIMS_METADATA_KEY } from './relationship-claims';
import { ACL_MANAGED_TYPE_SQL } from './relationship-validation';
import { readSourceRecordLinks } from './source-record-reads';

type ListLinksArgs = Static<typeof ListLinksAction>;
interface StoredEndpointRow {
  id: number;
  organization_id: string;
  slug: string;
  entity_type: string;
  parent_slug: string | null;
  parent_entity_type: string | null;
}
type NativeRelationshipPage = Awaited<ReturnType<typeof readSourceRecordLinks>>;

export const RELATIONSHIP_SELECT = `
  r.id,
  r.organization_id,
  COALESCE(to_jsonb(r.from_entity_id), to_jsonb(r.from_source_key)) AS from_entity_id,
  COALESCE(to_jsonb(r.to_entity_id), to_jsonb(r.to_source_key)) AS to_entity_id,
  r.relationship_type_id,
  rt.slug as relationship_type_slug,
  rt.name as relationship_type_name,
  rt.is_symmetric,
  ${ACL_MANAGED_TYPE_SQL} as acl_managed,
  COALESCE(fe.name, r.from_source_key) as from_entity_name,
  fet.slug as from_entity_type,
  fet.id as from_entity_type_id,
  COALESCE(fe.slug, r.from_source_key) as from_entity_slug,
  COALESCE(te.name, r.to_source_key) as to_entity_name,
  tet.slug as to_entity_type,
  tet.id as to_entity_type_id,
  COALESCE(te.slug, r.to_source_key) as to_entity_slug,
  NULLIF(r.metadata - '${RELATIONSHIP_CLAIMS_METADATA_KEY}', '{}'::jsonb) AS metadata,
  r.confidence,
  r.source,
  r.created_by,
  r.updated_by,
  r.created_at,
  r.updated_at,
  r.deleted_at
`;

export const RELATIONSHIP_JOINS = `
  FROM entity_relationships r
  JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
  LEFT JOIN entities fe ON r.from_entity_id = fe.id
  LEFT JOIN entity_types fet ON fet.id = COALESCE(fe.entity_type_id, r.from_entity_type_id)
  LEFT JOIN entities te ON r.to_entity_id = te.id
  LEFT JOIN entity_types tet ON tet.id = COALESCE(te.entity_type_id, r.to_entity_type_id)
`;

export function endpointPredicate(side: 'from' | 'to', endpoint: EntityEndpoint, params: unknown[]): string {
  if (endpoint.entityId !== null) {
    params.push(endpoint.entityId);
    return `r.${side}_entity_id = $${params.length}`;
  }
  params.push(endpoint.sourceTypeId, endpoint.sourceKey);
  return `(r.${side}_entity_type_id = $${params.length - 1} AND r.${side}_source_key = $${params.length})`;
}

const RelationshipCursorSchema = Type.Object({
  kind: Type.Literal('entity-links'),
  binding: Type.String(),
  after: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  localDone: Type.Boolean(),
  sourceDone: Type.Boolean(),
  sourceCursor: Type.Union([Type.String(), Type.Null()]),
});

type RelationshipCursor = Static<typeof RelationshipCursorSchema>;

export function parseRelationshipCursor(value: string | null | undefined, binding: string): RelationshipCursor {
  if (!value) {
    return { kind: 'entity-links', binding, after: 0, localDone: false, sourceDone: false, sourceCursor: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new ToolUserError('Invalid relationship cursor', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolUserError('Invalid relationship cursor', 400);
  }
  if (!Value.Check(RelationshipCursorSchema, parsed) || parsed.binding !== binding) {
    throw new ToolUserError('Relationship cursor does not match this request', 400);
  }
  return parsed;
}

/** Each stream advances independently; a failed native read retains its retry position. */
export function nextRelationshipCursor(
  previous: RelationshipCursor,
  authored: { hasMore: boolean; lastId: number },
  native: { next_cursor?: string | null; failures: NativeRelationshipPage['failures'] },
): string | undefined {
  const sourceDone = !native.next_cursor && native.failures.length === 0;
  if (!authored.hasMore && sourceDone) return undefined;
  const next: RelationshipCursor = {
    ...previous,
    after: authored.lastId,
    localDone: !authored.hasMore,
    sourceDone,
    sourceCursor: native.next_cursor ?? null,
  };
  return Buffer.from(JSON.stringify(next)).toString('base64url');
}

/** Resolve only within this request, so cached authorization cannot outlive a revocation. */
export async function readableRelationships(
  rows: RelationshipRow[],
  ctx: ToolContext,
  readRestrictions?: EntityReadRestrictions,
  failures?: RelationshipReadFailure[],
): Promise<RelationshipRow[]> {
  const sql = getDb();
  const restrictions = readRestrictions ?? await entityReadRestrictions(sql, ctx);
  const deadline = AbortSignal.timeout(20_000);
  const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, deadline]) : deadline;
  const sourceContext = { ...ctx, abortSignal: signal };
  const storedIds = new Set<number>();
  for (const row of rows) {
    if (typeof row.from_entity_id === 'number') storedIds.add(row.from_entity_id);
    if (typeof row.to_entity_id === 'number') storedIds.add(row.to_entity_id);
  }
  const stored = storedIds.size ? await sql<StoredEndpointRow>`
    SELECT e.id, e.organization_id, e.slug, et.slug AS entity_type, pe.slug AS parent_slug, pet.slug AS parent_entity_type
    FROM entities e JOIN organization o ON o.id = e.organization_id
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities pe ON pe.id = e.parent_id AND pe.deleted_at IS NULL
    LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id
    WHERE e.id = ANY(${pgBigintArray([...storedIds])}::bigint[]) AND e.deleted_at IS NULL
      AND (e.organization_id = ${ctx.organizationId} OR o.visibility = 'public')
  ` : [];
  const allowed = new Map((await filterEntityReadRows(sql, stored, restrictions)).map(row => [Number(row.id), row]));
  // Foreign endpoints link to their owner's page; same-workspace peeks are unchanged.
  const foreignUrls = new Map<string, Promise<string | undefined>>();
  function foreignUrl(endpoint: { organizationId: string; entity_type: string; slug: string;
    parent_entity_type?: string | null; parent_slug?: string | null }): Promise<string | undefined> | undefined {
    if (endpoint.organizationId === ctx.organizationId) return undefined;
    const key = JSON.stringify([endpoint.organizationId, endpoint.parent_entity_type, endpoint.parent_slug, endpoint.entity_type, endpoint.slug]);
    let url = foreignUrls.get(key);
    if (!url) {
      url = buildEntityViewUrl({ ...ctx, organizationId: endpoint.organizationId }, endpoint);
      foreignUrls.set(key, url);
    }
    return url;
  }
  function endpointUrl(id: RelationshipRow['from_entity_id'], resolved: ResolvedEntityReference | null) {
    if (resolved) return foreignUrl({ organizationId: resolved.organizationId, entity_type: resolved.entityType, slug: resolved.slug });
    const row = typeof id === 'number' ? allowed.get(id) : undefined;
    return row ? foreignUrl({ ...row, organizationId: String(row.organization_id) }) : undefined;
  }
  const pending = new Map<string, Promise<ResolvedEntityReference>>();

  function resolveSource(id: string, type: string | number | undefined) {
    const key = JSON.stringify([type, id]);
    let result = pending.get(key);
    if (!result) {
      result = resolveEntityReference(id, type, sourceContext, { restrictions });
      pending.set(key, result);
    }
    return result;
  }

  async function readRow(row: RelationshipRow): Promise<RelationshipRow | null> {
    const hiddenStoredEndpoint = [row.from_entity_id, row.to_entity_id]
      .some(id => typeof id === 'number' && !allowed.has(id));
    const touchesMember = row.from_entity_type === MEMBER_ENTITY_TYPE_SLUG || row.to_entity_type === MEMBER_ENTITY_TYPE_SLUG;
    if (hiddenStoredEndpoint || (touchesMember && !canSeeMemberList(ctx.memberRole))) return null;
    const outcomes = await Promise.allSettled([
      typeof row.from_entity_id === 'string' ? resolveSource(row.from_entity_id, row.from_entity_type_id ?? row.from_entity_type) : null,
      typeof row.to_entity_id === 'string' ? resolveSource(row.to_entity_id, row.to_entity_type_id ?? row.to_entity_type) : null,
    ]);
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    // Hidden endpoints suppress failure IDs even when another read fails first.
    if (rejected.some(({ reason }) => reason instanceof ToolUserError && (reason.httpStatus === 403 || reason.httpStatus === 404))) return null;
    if (rejected.length) {
      const fatal = rejected.find(({ reason }) => !(reason instanceof ToolUserError) || reason.httpStatus < 500);
      if (fatal) throw fatal.reason;
      const error: unknown = rejected[0].reason;
      if (failures && error instanceof ToolUserError && error.httpStatus >= 500) {
        failures.push({ relationship_id: row.id, code: error.code ?? 'UPSTREAM_UNAVAILABLE' });
        return null;
      }
      throw error;
    }
    const [from, to] = outcomes.map(outcome => outcome.status === 'fulfilled' ? outcome.value : null);
    const [fromUrl, toUrl] = await Promise.all([endpointUrl(row.from_entity_id, from), endpointUrl(row.to_entity_id, to)]);
    return {
      ...row,
      ...(from ? { from_entity_name: from.name } : {}),
      ...(to ? { to_entity_name: to.name } : {}),
      ...(fromUrl ? { from_entity_url: fromUrl } : {}),
      ...(toUrl ? { to_entity_url: toUrl } : {}),
    };
  }

  const visible: RelationshipRow[] = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    const batch = await Promise.all(rows.slice(offset, offset + 4).map(readRow));
    visible.push(...batch.filter((row): row is RelationshipRow => row !== null));
  }
  return visible;
}

export async function readAuthoredRelationshipPage(
  args: ListLinksArgs,
  endpoint: EntityEndpoint,
  ctx: ToolContext,
  restrictions: EntityReadRestrictions,
  cursor: RelationshipCursor,
) {
  const isSource = endpoint.entityId === null;
  const limit = Math.min(Math.max(args.limit ?? 100, 1), isSource ? 100 : 500);
  const offset = Math.max(args.offset ?? 0, 0);
  const params: unknown[] = [ctx.organizationId];
  const conditions = ['r.organization_id = $1'];
  // Unlinked history can outlive its source type or addressing contract. Use
  // the persisted type IDs, so slug reuse cannot retarget a historical edge.
  for (const [side, alias] of [['from', 'fet'], ['to', 'tet']]) {
    conditions.push(`(r.${side}_entity_type_id IS NULL OR (${alias}.deleted_at IS NULL
      AND ${alias}.backing_sql IS NOT NULL
      AND jsonb_typeof(${alias}.metadata_schema -> 'x-lobu-record-key') = 'string'))`);
  }
  if (!args.include_deleted) conditions.push('r.deleted_at IS NULL');
  if (args.direction === 'outbound') {
    conditions.push(endpointPredicate('from', endpoint, params));
  } else if (args.direction === 'inbound') {
    conditions.push(endpointPredicate('to', endpoint, params));
  } else {
    const from = endpointPredicate('from', endpoint, params);
    const to = endpointPredicate('to', endpoint, params);
    conditions.push(`(${from} OR ${to})`);
  }
  if (args.relationship_type_slug) {
    params.push(args.relationship_type_slug);
    conditions.push(`rt.slug = $${params.length}`);
  }
  if (args.source) {
    params.push(args.source);
    conditions.push(`r.source = $${params.length}`);
  }
  if (args.confidence_min !== undefined) {
    params.push(args.confidence_min);
    conditions.push(`r.confidence >= $${params.length}`);
  }
  if (isSource) {
    params.push(cursor.after);
    conditions.push(`r.id > $${params.length}`);
  }
  conditions.push(
    `(r.from_entity_id IS NULL OR (${entityReadPolicySql(restrictions, 'fe', params)}))`,
    `(r.to_entity_id IS NULL OR (${entityReadPolicySql(restrictions, 'te', params)}))`,
  );
  const raw = cursor.localDone ? [] : await getDb().unsafe<RelationshipRow>(`
    SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${isSource ? 'r.id ASC' : 'r.created_at DESC'}
    LIMIT ${limit + 1} OFFSET ${isSource ? 0 : offset}
  `, params);
  const candidates = raw.slice(0, limit);
  const failures: RelationshipReadFailure[] = [];
  const relationships = await readableRelationships(candidates, ctx, restrictions, failures);
  const counts = new Map<string, RelationshipCountByType>();
  for (const row of relationships) {
    const count = counts.get(row.relationship_type_slug) ?? {
      relationship_type_slug: row.relationship_type_slug,
      relationship_type_name: row.relationship_type_name,
      count: 0,
    };
    count.count++;
    counts.set(row.relationship_type_slug, count);
  }
  // Count only this visible page; global counts would authorize unbounded endpoints.
  return {
    relationships,
    failures,
    counts: [...counts.values()],
    hasMore: raw.length > limit,
    lastId: candidates.at(-1)?.id ?? cursor.after,
    limit,
    offset,
  };
}

/** The same native-link options serve legacy views and durable source references. */
export function readNativeRelationshipPage(
  args: ListLinksArgs,
  record: { type: string; key: string },
  ctx: ToolContext,
  limit: number,
  cursor?: string | null,
): Promise<NativeRelationshipPage> {
  let direction: 'outgoing' | 'incoming' | undefined;
  if (args.direction === 'outbound') direction = 'outgoing';
  if (args.direction === 'inbound') direction = 'incoming';
  return readSourceRecordLinks(sourceReadScopeFromToolContext(ctx), record, {
    limit,
    cursor,
    direction,
    relationshipType: args.relationship_type_slug,
    signal: ctx.abortSignal,
    automationId: ctx.actingAutomationId,
  });
}
