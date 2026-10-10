import type { EntityIdentity } from '@lobu/core/contracts/tools/manage-entity';
import { type DbClient, pgBigintArray } from '../db/client';
import { ToolUserError } from './errors';

/** One edge predicate for every identity read; ordinary and ACL edges never group records. */
function identityEdgesSql(entityAlias: string): string {
  return `SELECT ir.from_entity_id, ir.to_entity_id
    FROM entity_relationships ir
    JOIN entity_relationship_types it ON it.id = ir.relationship_type_id
    JOIN entities source ON source.id = ir.from_entity_id
    JOIN entities target ON target.id = ir.to_entity_id
    WHERE ir.organization_id = ${entityAlias}.organization_id AND ir.deleted_at IS NULL
      AND it.organization_id = ${entityAlias}.organization_id AND it.purpose = 'identity'
      AND it.deleted_at IS NULL AND it.status = 'active'
      AND source.organization_id = ${entityAlias}.organization_id AND target.organization_id = ${entityAlias}.organization_id
      AND source.entity_type_id = ${entityAlias}.entity_type_id AND target.entity_type_id = ${entityAlias}.entity_type_id
      AND source.deleted_at IS NULL AND target.deleted_at IS NULL`;
}

export function identityRootSql(entityAlias: string): string {
  return `NOT EXISTS (${identityEdgesSql(entityAlias)} AND ir.from_entity_id = ${entityAlias}.id)`;
}

/** Trusted SQL reference only. The database bounds live identity components to 26 records. */
export function identityMemberIdsSql(entityRef: string): string {
  return `WITH RECURSIVE identity_members(id, organization_id, entity_type_id) AS (
    ${identityMembersCteBody(entityRef)}
  ) SELECT id FROM identity_members`;
}

/**
 * The recursive body behind {@link identityMemberIdsSql}, without the
 * surrounding WITH clause, so attribution branches can share one traversal.
 * The CTE must be named `identity_members` — the body self-references it.
 */
export function identityMembersCteBody(seedRef: string): string {
  return `SELECT seed.id, seed.organization_id, seed.entity_type_id FROM entities seed
    WHERE seed.id = ${seedRef}
    UNION
    SELECT next.id, next.organization_id, next.entity_type_id
    FROM identity_members member
    JOIN LATERAL (${identityEdgesSql('member')}) edge
      ON member.id IN (edge.from_entity_id, edge.to_entity_id)
    JOIN entities next ON next.id = CASE WHEN edge.from_entity_id = member.id
      THEN edge.to_entity_id ELSE edge.from_entity_id END`;
}

export function identityRootIdSql(entityRef: string): string {
  return `(SELECT root.id FROM entities root
    WHERE root.id IN (${identityMemberIdsSql(entityRef)}) AND ${identityRootSql('root')})`;
}

/** Enrich read candidates; callers retain their existing entity read-policy checks. */
export async function attachEntityIdentities<T extends { id: number }>(db: DbClient, rows: T[]): Promise<Array<T & { identity?: EntityIdentity }>> {
  if (rows.length === 0) return rows;
  const identities = await db<{ id: number; identity: EntityIdentity }>`
    SELECT e.id, jsonb_build_object(
      'root_id', ${db.unsafe(identityRootIdSql('e.id'))},
      'member_ids', ARRAY(SELECT id FROM (${db.unsafe(identityMemberIdsSql('e.id'))}) members ORDER BY id)
    ) AS identity
    FROM entities e JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(rows.map(row => Number(row.id)))}::bigint[])
      AND e.deleted_at IS NULL AND et.deleted_at IS NULL
      AND left(et.slug, 1) <> '$' AND et.backing_sql IS NULL AND et.backing_source IS NULL
      AND EXISTS (SELECT 1 FROM entity_relationship_types rt
        WHERE rt.organization_id = e.organization_id AND rt.purpose = 'identity'
          AND rt.status = 'active' AND rt.deleted_at IS NULL
          AND (NOT EXISTS (SELECT 1 FROM entity_relationship_type_rules rule
              WHERE rule.relationship_type_id = rt.id AND rule.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM entity_relationship_type_rules rule
              WHERE rule.relationship_type_id = rt.id AND rule.deleted_at IS NULL
                AND rule.source_entity_type_slug = et.slug AND rule.target_entity_type_slug = et.slug)))
  `;
  const byId = new Map(identities.map(row => [Number(row.id), row.identity]));
  return rows.map(row => {
    const identity = byId.get(Number(row.id));
    return identity ? { ...row, identity } : row;
  });
}

/** Identity semantics come from workspace declarations, never an entity key. */
export async function configuredIdentityRelationship(db: DbClient, organizationId: string, entityType: string): Promise<{ id: number; slug: string }> {
  const rows = await db<{ id: number; slug: string }>`SELECT t.id, t.slug FROM entity_relationship_types t
    WHERE t.organization_id = ${organizationId} AND t.purpose = 'identity' AND t.status = 'active' AND t.deleted_at IS NULL
      AND (NOT EXISTS (SELECT 1 FROM entity_relationship_type_rules r WHERE r.relationship_type_id = t.id AND r.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM entity_relationship_type_rules r WHERE r.relationship_type_id = t.id AND r.deleted_at IS NULL
          AND r.source_entity_type_slug = ${entityType} AND r.target_entity_type_slug = ${entityType})) ORDER BY t.id LIMIT 2`;
  if (rows.length !== 1) throw new ToolUserError(rows.length === 0
    ? 'Configure an active relationship with purpose identity for this entity type before discovering duplicates'
    : 'Duplicate discovery requires exactly one applicable active identity relationship type', 409);
  return { id: Number(rows[0].id), slug: rows[0].slug };
}
