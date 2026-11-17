import { type DbClient, pgBigintArray } from '../db/client';
import type { ToolContext } from '../tools/registry';
import { identityMemberIdsSql } from '../utils/entity-identity';
import { type ActingPrincipal, loadEntityReadRestrictions, resolveActingPrincipal } from './entity-policy';

export type EntityReadRestrictions = Awaited<ReturnType<typeof loadEntityReadRestrictions>>;

/** Request-local snapshot of bounded configuration, never cached across requests or replicas. */
export async function entityReadRestrictions(
  db: DbClient, ctx: Pick<ToolContext, 'organizationId' | 'userId' | 'agentId' | 'actingAutomationId'>, actor?: ActingPrincipal,
): Promise<EntityReadRestrictions> {
  const principal = actor ?? await resolveActingPrincipal(db, {
    organizationId: ctx.organizationId, userId: ctx.userId, agentId: ctx.agentId,
    sessionAutomationId: ctx.actingAutomationId,
  });
  return loadEntityReadRestrictions({ organizationId: ctx.organizationId, principalKind: principal.kind,
    principalId: principal.id, ownerAgentId: principal.ownerAgentId, ownerResolved: principal.ownerResolved, sql: db });
}

/** Trusted SQL alias only. Withhold a group if any member is denied: its descriptor,
 * matching evidence and aggregate counts otherwise reveal the hidden member.
 * Existing organization/public/source ACL predicates remain the caller's responsibility.
 */
export function entityReadPolicySql(restrictions: EntityReadRestrictions, entityAlias: string, params: unknown[]): string {
  if (restrictions.length === 0) return 'TRUE';
  if (restrictions.some(row => row.entity_type_slug === null && row.entity_id === null)) return 'FALSE';
  params.push(JSON.stringify(restrictions));
  // Schema-qualified: scoped SQL places this beside org-scope CTEs named `entities`.
  return `NOT EXISTS (
    SELECT 1 FROM public.entities read_member JOIN public.entity_types read_type ON read_type.id = read_member.entity_type_id
    CROSS JOIN jsonb_to_recordset($${params.length}::text::jsonb) AS read_denial(entity_type_slug text, entity_id bigint)
    WHERE read_member.id IN (${identityMemberIdsSql(`${entityAlias}.id`)})
      AND (read_denial.entity_type_slug IS NULL OR read_denial.entity_type_slug = read_type.slug)
      AND (read_denial.entity_id IS NULL OR read_denial.entity_id = read_member.id)
  )`;
}

/** Trusted bigint[] SQL expression only. True when every linked record is readable
 * under {@link entityReadPolicySql}; a row that links a withheld record is withheld too.
 */
export function linkedEntitiesReadPolicySql(restrictions: EntityReadRestrictions, entityIdsSql: string, params: unknown[]): string {
  if (restrictions.length === 0) return 'TRUE';
  return `NOT EXISTS (SELECT 1 FROM public.entities read_linked
    WHERE read_linked.id = ANY(${entityIdsSql}) AND NOT (${entityReadPolicySql(restrictions, 'read_linked', params)}))`;
}

/** Trusted SQL alias only. An event is readable when every record it links is; an
 * unlinked event falls under the workspace-wide `$member` envelope, as read_knowledge does.
 */
export function eventReadPolicySql(restrictions: EntityReadRestrictions, eventAlias: string, params: unknown[]): string {
  if (restrictions.length === 0) return 'TRUE';
  if (restrictions.some(row => row.entity_type_slug === null && row.entity_id === null)) return 'FALSE';
  const linked = linkedEntitiesReadPolicySql(restrictions, `${eventAlias}.entity_ids`, params);
  const unlinkedDenied = restrictions.some(row => row.entity_id === null && row.entity_type_slug === '$member');
  return unlinkedDenied ? `(cardinality(${eventAlias}.entity_ids) > 0 AND ${linked})` : linked;
}

/** Batch presentation guard for exact hits and linked rows, including identity descriptors. */
export async function filterEntityReadRows<T extends { id: number | string; identity?: { member_ids: number[] } }>(
  db: DbClient, rows: T[], restrictions: EntityReadRestrictions,
): Promise<T[]> {
  if (!rows.length || !restrictions.length) return rows;
  // Descriptor attachment is a separate statement from candidate selection. A
  // concurrent link/unlink can change the live group, so authorize the exact
  // captured members as well as each row's current group before presenting it.
  const memberIds = (row: T) => [Number(row.id), ...(row.identity?.member_ids ?? [])];
  const params: unknown[] = [pgBigintArray([...new Set(rows.flatMap(memberIds))])];
  const predicate = entityReadPolicySql(restrictions, 'e', params);
  const allowed = await db.unsafe<{ id: number }>(`SELECT e.id FROM entities e WHERE e.id = ANY($1::bigint[]) AND ${predicate}`, params);
  const ids = new Set(allowed.map(row => Number(row.id)));
  return rows.filter(row => memberIds(row).every(id => ids.has(id)));
}
