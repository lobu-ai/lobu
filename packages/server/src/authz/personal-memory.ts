import { ACL_RESOURCE_TYPE_SLUG } from '@lobu/connector-sdk';
import type { DbClient } from '../db/client';
import { PERSONAL_MEMORY_IDENTITY_SOURCE, PERSONAL_MEMORY_OWNER_NAMESPACE } from '../identity/personal-memory-identity';
import type { ToolContext } from '../tools/registry';
import { insertEntityRow, withEntityWriteTransaction } from '../utils/entity-management';
import { ToolUserError } from '../utils/errors';
import { lockIdentityOrganization, withAclPrivilege } from '../utils/relationship-validation';
import { MANUAL_RELATIONSHIP_CLAIM_KEY, RELATIONSHIP_CLAIMS_METADATA_KEY } from '../utils/relationship-claims';
import { ensureResourceEntityType } from './acl-resource-type';
import { unvalidatedEntityRowInsert } from './entity-row-validation';

const DENIED = 'A verified personal-memory audience is required for this direct-message save.';

/** Trusted DM writer only. A revoked/retired audience is never silently recreated. */
export async function resolvePersonalMemoryResource(db: DbClient, ctx: ToolContext): Promise<number> {
  const owner = ctx.personalMemoryPrincipal;
  if (!owner || owner !== ctx.userId || ctx.sourceContext?.chatAccess !== 'member' || ctx.actingAutomationId != null) {
    throw new ToolUserError(DENIED, 403, 'PERMISSION');
  }
  return withEntityWriteTransaction(db, async (tx) => {
    // Reuse the identity writer's organization lock and live unique index; no
    // replica-local authority cache or check-then-create race.
    await lockIdentityOrganization(tx, ctx.organizationId);
    const [member] = await tx<{ id: number }>`
      SELECT e.id FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id AND e.organization_id = ei.organization_id AND e.deleted_at IS NULL
      JOIN entity_types et ON et.id = e.entity_type_id AND et.organization_id = e.organization_id AND et.slug = '$member' AND et.deleted_at IS NULL
      JOIN "member" m ON m."organizationId" = ei.organization_id AND m."userId" = ei.identifier
      WHERE ei.organization_id = ${ctx.organizationId} AND ei.namespace = 'auth_user_id'
        AND ei.identifier = ${owner} AND ei.scope_key IS NULL AND ei.source_connector = 'auth:signup' AND ei.deleted_at IS NULL
      LIMIT 1
    `;
    if (!member) throw new ToolUserError(DENIED, 403, 'PERMISSION');
    const [existing] = await tx<{ entity_id: number; source_connector: string | null; slug: string; deleted_at: string | null }>`
      SELECT ei.entity_id, ei.source_connector, et.slug, e.deleted_at
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id AND e.organization_id = ei.organization_id
      JOIN entity_types et ON et.id = e.entity_type_id AND et.organization_id = e.organization_id
      WHERE ei.organization_id = ${ctx.organizationId} AND ei.namespace = ${PERSONAL_MEMORY_OWNER_NAMESPACE}
        AND ei.identifier = ${owner} AND ei.scope_key IS NULL AND ei.deleted_at IS NULL
      LIMIT 1
    `;
    if (existing) {
      if (existing.source_connector !== PERSONAL_MEMORY_IDENTITY_SOURCE || existing.slug !== ACL_RESOURCE_TYPE_SLUG || existing.deleted_at) {
        throw new ToolUserError(DENIED, 403, 'PERMISSION');
      }
      const [grant] = await tx`
        SELECT r.id FROM entity_relationships r
        JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id AND rt.organization_id = r.organization_id
        WHERE r.organization_id = ${ctx.organizationId} AND r.from_entity_id = ${member.id} AND r.to_entity_id = ${existing.entity_id}
          AND rt.slug = 'member_of' AND rt.deleted_at IS NULL AND rt.status = 'active' AND r.deleted_at IS NULL
          AND (r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) ? ${MANUAL_RELATIONSHIP_CLAIM_KEY}
        LIMIT 1
      `;
      if (!grant) throw new ToolUserError(DENIED, 403, 'PERMISSION');
      return Number(existing.entity_id);
    }
    // Tombstoning the trusted identity also revokes this audience: do not
    // mint a replacement which might be mistaken for restoring old access.
    const [retired] = await tx`
      SELECT id FROM entity_identities WHERE organization_id = ${ctx.organizationId}
        AND namespace = ${PERSONAL_MEMORY_OWNER_NAMESPACE} AND identifier = ${owner} AND scope_key IS NULL
      LIMIT 1
    `;
    if (retired) throw new ToolUserError(DENIED, 403, 'PERMISSION');
    await ensureResourceEntityType(tx, ctx.organizationId);
    const [type] = await tx<{ id: number }>`SELECT id FROM entity_types WHERE organization_id = ${ctx.organizationId}
      AND slug = ${ACL_RESOURCE_TYPE_SLUG} AND deleted_at IS NULL LIMIT 1`;
    const resource = await insertEntityRow({ tx, row: unvalidatedEntityRowInsert({
      reason: 'Platform-owned personal audience outside tenant rules',
      row: { organizationId: ctx.organizationId, entityTypeId: Number(type.id), name: 'Personal memory',
        slug: `personal-memory-${crypto.randomUUID()}`, createdBy: owner },
    }) });
    await tx`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector, scope_key)
      VALUES (${ctx.organizationId}, ${resource.id}, ${PERSONAL_MEMORY_OWNER_NAMESPACE}, ${owner}, ${PERSONAL_MEMORY_IDENTITY_SOURCE}, NULL)
    `;
    // This is the sole personal-audience grant writer, scoped to the verified
    // owner's $member. Ordinary relationship mutations cannot grant ACL edges.
    const [relationship] = await tx<{ id: number }>`
      INSERT INTO entity_relationship_types (organization_id, slug, name, description, is_symmetric, purpose)
      VALUES (${ctx.organizationId}, 'member_of', 'Member of', 'Access resource membership', false, 'authorization')
      ON CONFLICT (organization_id, slug) WHERE status = 'active'
      DO UPDATE SET purpose = 'authorization'
      RETURNING id
    `;
    await withAclPrivilege(tx, () => tx`
      INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_id, relationship_type_id, source, confidence, created_by, metadata)
      VALUES (${ctx.organizationId}, ${member.id}, ${resource.id}, ${relationship.id}, 'manual', 1, ${owner},
        ${tx.json({ [RELATIONSHIP_CLAIMS_METADATA_KEY]: { [MANUAL_RELATIONSHIP_CLAIM_KEY]: {} } })})
    `.then(() => undefined));
    return Number(resource.id);
  });
}
