import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';
import { createTestAgent, createTestConnection, createTestEvent } from '../../setup/test-fixtures';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { reconcileConnectorRelationshipClaims } from '../../../utils/relationship-claims';
import { lockIdentityOrganization, withIdentityPrivilege } from '../../../utils/relationship-validation';
import { pgBigintArray } from '../../../db/client';

async function graph(count = 3, policy?: 'auto_link' | 'review') {
  const workspace = await TestWorkspace.create({ name: 'Stored identity associations' });
  const human = await workspace.withAuth({ tokenType: 'session' });
  const metadataSchema = policy ? {
    type: 'object',
    'x-lobu-resolution': { rules: [{ fields: ['emails'], normalizer: 'email', onMatch: policy }] },
  } : {};
  await human.entity_schema.createType({ slug: 'contact-record', name: 'Contact record', metadata_schema: metadataSchema });
  // Exercise the public declaration, including its schema validation and persistence.
  const declaration = { slug: 'same_record', name: 'Same record', purpose: 'identity' as const };
  await human.entity_schema.createRelType(declaration);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const name = ['Alpha', 'Bravo', 'Charlie'][i] ?? `Record ${i}`;
    const result = await human.entities.create({ entity_type: 'contact-record', name,
      metadata: policy ? { emails: ['shared@example.test'] } : { retained: name } });
    ids.push(Number((result as { entity: { id: number } }).entity.id));
  }
  const link = (from: number, to: number) => human.entities.link({
    from_entity_id: from, to_entity_id: to, relationship_type_slug: 'same_record',
  });
  const agentRow = await createTestAgent({ organizationId: workspace.org.id, ownerUserId: workspace.users.owner.id });
  const agent = workspace.withAuth({ agentId: agentRow.agentId });
  const input = { from_entity_id: ids[0], to_entity_id: ids[1], relationship_type_slug: 'same_record' };
  const sql = getTestDb();
  const [type] = await sql`SELECT id FROM entity_relationship_types WHERE organization_id = ${workspace.org.id} AND slug = 'same_record'`;
  return { workspace, human, agent, agentRow, ids, link, input, typeId: Number(type.id), sql, metadataSchema };
}

function linked(result: unknown): number {
  return Number((result as { relationship: { id: number } }).relationship.id);
}

function runId(result: unknown): number {
  const id = Number((result as { approval_run_id: number }).approval_run_id);
  expect(Number.isSafeInteger(id)).toBe(true);
  return id;
}

describe('governed stored identity associations', () => {
  beforeEach(cleanupTestDatabase);

  it('can reapply redirect retirement without losing withdrawn identity decisions', async () => {
    const { sql, human, ids: [a, b], link } = await graph();
    const id = linked(await link(a, b));
    await human.entities.unlink({ relationship_id: id });
    const before = await sql`SELECT * FROM entity_relationships WHERE id = ${id}`;
    const migration = readFileSync(resolve(process.cwd(), '../../db/migrations/20261009030001_drop_physical_entity_redirect.sql'), 'utf8');
    await sql.begin(tx => tx.unsafe(migration.split('-- migrate:down')[0]));
    expect(await sql`SELECT * FROM entity_relationships WHERE id = ${id}`).toEqual(before);
  });

  it('retains the identity purpose through public create/get', async () => {
    const { workspace } = await graph();
    const result = await workspace.owner.entity_schema.getRelType('same_record');
    expect(result).toMatchObject({ relationship_type: { purpose: 'identity', is_symmetric: false } });
  });

  it.each([false, true])('deletes an unlinked scoped identity type and preserves history (archived: %s)', async (archiveFirst) => {
    const { human, sql, workspace, ids: [a, b], link, typeId } = await graph(2);
    await human.entity_schema.addRule({ slug: 'same_record', source_entity_type_slug: 'contact-record', target_entity_type_slug: 'contact-record' });
    const relationshipId = linked(await link(a, b));
    const typeBefore = await sql`SELECT * FROM entity_relationship_types WHERE id = ${typeId}`;
    await expect(human.entity_schema.deleteRelType({ slug: 'same_record' })).rejects.toThrow(/relationships of this type exist/);
    expect(await sql`SELECT * FROM entity_relationship_types WHERE id = ${typeId}`).toEqual(typeBefore);

    await human.entities.unlink({ relationship_id: relationshipId });
    if (archiveFirst) {
      expect(await human.entity_schema.updateRelType({ slug: 'same_record', status: 'archived' })).toMatchObject({ status: 'applied' });
    }
    const rulesBefore = await sql`SELECT * FROM entity_relationship_type_rules WHERE relationship_type_id = ${typeId} ORDER BY id`;
    const edgeBefore = await sql`SELECT * FROM entity_relationships WHERE id = ${relationshipId}`;
    const eventsBefore = await sql`SELECT * FROM events WHERE organization_id = ${workspace.org.id}
      AND metadata->>'relationshipId' = ${String(relationshipId)} ORDER BY id`;
    expect(rulesBefore).toHaveLength(1);
    expect(edgeBefore).toHaveLength(1);
    expect(edgeBefore[0].deleted_at).not.toBeNull();
    expect(eventsBefore.map(row => row.metadata.op).sort()).toEqual(['link', 'unlink']);

    expect(await human.entity_schema.deleteRelType({ slug: 'same_record' })).toMatchObject({ status: 'applied', success: true });
    expect(await human.entity_schema.getRelType('same_record')).toMatchObject({ relationship_type: null });
    const [retiredType] = await sql`SELECT purpose, status, deleted_at FROM entity_relationship_types WHERE id = ${typeId}`;
    expect(retiredType).toMatchObject({ purpose: 'identity', status: 'archived' });
    expect(retiredType.deleted_at).not.toBeNull();
    expect(await sql`SELECT * FROM entity_relationship_type_rules WHERE relationship_type_id = ${typeId} ORDER BY id`).toEqual(rulesBefore);
    expect(await sql`SELECT * FROM entity_relationships WHERE id = ${relationshipId}`).toEqual(edgeBefore);
    expect(await sql`SELECT * FROM events WHERE organization_id = ${workspace.org.id}
      AND metadata->>'relationshipId' = ${String(relationshipId)} ORDER BY id`).toEqual(eventsBefore);
  });

  it('still retires ordinary relationship rules when deleting their type', async () => {
    const { human, sql, workspace } = await graph(0);
    await human.entity_schema.createRelType({ slug: 'related', name: 'Related' });
    await human.entity_schema.addRule({ slug: 'related', source_entity_type_slug: 'contact-record', target_entity_type_slug: 'contact-record' });
    expect(await human.entity_schema.deleteRelType({ slug: 'related' })).toMatchObject({ status: 'applied', success: true });
    const rules = await sql`SELECT r.deleted_at FROM entity_relationship_type_rules r
      JOIN entity_relationship_types t ON t.id = r.relationship_type_id
      WHERE t.organization_id = ${workspace.org.id} AND t.slug = 'related'`;
    expect(rules).toHaveLength(1);
    expect(rules[0].deleted_at).not.toBeNull();
  });

  it('refuses a cycle without moving or deleting either stored record', async () => {
    const { workspace, ids: [a, b], link } = await graph();
    await link(a, b);
    await expect(link(b, a)).rejects.toThrow(/root|cycle|identity/i);
    const rows = await getTestDb()`
      SELECT id, name, deleted_at FROM entities
      WHERE organization_id = ${workspace.org.id} AND id IN (${a}, ${b}) ORDER BY id
    `;
    expect(rows.map(row => row.name)).toEqual(['Alpha', 'Bravo']);
    expect(rows.every(row => row.deleted_at === null)).toBe(true);
  });

  it('serializes competing outgoing joins across concurrent requests', async () => {
    const { ids: [a, b, c], link } = await graph();
    const results = await Promise.allSettled([link(a, b), link(a, c)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('serializes inverse joins, including across different identity types', async () => {
    const { human, ids: [a, b], link } = await graph();
    await human.entity_schema.createRelType({ slug: 'also_same', name: 'Also same', purpose: 'identity' });
    const results = await Promise.allSettled([link(a, b), human.entities.link({
      from_entity_id: b, to_entity_id: a, relationship_type_slug: 'also_same',
    })]);
    expect(results.map(row => row.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('joins populated components and unlinks a subtree without moving record state', async () => {
    const { sql, workspace, human, ids: [a, b, c, d], link } = await graph(4);
    await human.entity_schema.createRelType({ slug: 'related', name: 'Related' });
    const ordinary = linked(await human.entities.link({ from_entity_id: a, to_entity_id: c, relationship_type_slug: 'related' }));
    await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${workspace.org.id}, ${a}, 'reference', 'source:alpha', 'fixture')`;
    const event = await createTestEvent({ entity_id: a, content: 'Retained source event', origin_id: 'source:alpha' });
    const recordsBefore = await sql`SELECT id, name, metadata, deleted_at FROM entities WHERE id = ANY(${pgBigintArray([a, b, c, d])}::bigint[]) ORDER BY id`;
    const identityBefore = await sql`SELECT * FROM entity_identities WHERE entity_id = ${a}`;
    const eventBefore = await sql`SELECT * FROM events WHERE id = ${event.id}`;
    const ab = linked(await link(a, b));
    const cd = linked(await link(c, d));
    const bd = linked(await link(b, d));
    expect(linked(await link(b, d))).toBe(bd);
    await human.entities.unlink({ relationship_id: bd });
    const edges = await sql`SELECT id FROM entity_relationships WHERE organization_id = ${workspace.org.id} AND deleted_at IS NULL ORDER BY id`;
    expect(edges.map(row => Number(row.id)).sort((x, y) => x - y)).toEqual([ordinary, ab, cd].sort((x, y) => x - y));
    expect(await sql`SELECT id, name, metadata, deleted_at FROM entities WHERE id = ANY(${pgBigintArray([a, b, c, d])}::bigint[]) ORDER BY id`).toEqual(recordsBefore);
    expect(await sql`SELECT * FROM entity_identities WHERE entity_id = ${a}`).toEqual(identityBefore);
    expect(await sql`SELECT * FROM events WHERE id = ${event.id}`).toEqual(eventBefore);
    await human.entities.update({ entity_id: a, metadata: { retained: 'exact record edit' } });
    const [unchangedParent] = await sql`SELECT metadata FROM entities WHERE id = ${b}`;
    expect(unchangedParent.metadata).toEqual({ retained: 'Bravo' });
    expect(await human.entities.unlink({ relationship_id: bd })).toMatchObject({ success: true });
    const [audit] = await sql`SELECT count(*)::int AS n FROM events WHERE organization_id = ${workspace.org.id}
      AND metadata->>'relationshipId' = ${String(bd)} AND metadata->>'op' = 'unlink'`;
    expect(audit.n).toBe(1);
  });

  it('permits a depth-25 component and refuses its 27th member', async () => {
    const { ids, link, human } = await graph(27);
    for (let i = 0; i < 25; i++) await link(ids[i], ids[i + 1]);
    const input = { from_entity_id: ids[25], to_entity_id: ids[26], relationship_type_slug: 'same_record' };
    expect(await human.entities.link({ ...input, dry_run: true })).toMatchObject({ preview: { outcome: 'refused' } });
    await expect(human.entities.link(input)).rejects.toThrow(/26/);
  });

  it('refuses member access, foreign/deleted/different-type records and source addresses', async () => {
    const { workspace, human, input, ids, sql } = await graph();
    await expect(workspace.member.entities.link(input)).rejects.toThrow(/permission|owner|admin/i);
    await human.entity_schema.createType({ slug: 'other-record', name: 'Other record' });
    const other = await human.entities.create({ entity_type: 'other-record', name: 'Other' }) as { entity: { id: number } };
    await expect(human.entities.link({ ...input, to_entity_id: other.entity.id })).rejects.toThrow(/same.*type/i);
    const foreign = await TestWorkspace.create({ name: 'Foreign records' });
    await expect(foreign.owner.entities.link(input)).rejects.toThrow();
    await sql`UPDATE entities SET deleted_at = current_timestamp WHERE id = ${ids[1]}`;
    await expect(human.entities.link(input)).rejects.toThrow(/live/);
    await expect(human.entities.link({ from: { type: 'contact-record', key: 'a' }, to: { type: 'contact-record', key: 'b' }, relationship_type_slug: 'same_record' })).rejects.toThrow();
    await expect(human.entity_schema.manage({ schema_type: 'relationship_type', action: 'create', slug: 'access', name: 'Access', purpose: 'authorization' })).rejects.toThrow();
  });

  it('refuses symmetric identity types, reserved endpoints, and populated purpose/rule edits', async () => {
    const { human, sql, workspace, ids: [a, b], link } = await graph();
    await expect(human.entity_schema.createRelType({ slug: 'symmetric', name: 'Symmetric', purpose: 'identity', is_symmetric: true })).rejects.toThrow(/directional/);
    await human.entity_schema.addRule({ slug: 'same_record', source_entity_type_slug: 'contact-record', target_entity_type_slug: 'contact-record' });
    await link(a, b);
    await expect(human.entity_schema.addRule({ slug: 'same_record', source_entity_type_slug: 'other', target_entity_type_slug: 'other' })).rejects.toThrow(/immutable/);
    await expect(sql.begin(async tx => {
      await lockIdentityOrganization(tx, workspace.org.id);
      await tx`UPDATE entity_relationship_types SET purpose = NULL WHERE organization_id = ${workspace.org.id} AND slug = 'same_record'`;
    })).rejects.toThrow(/immutable/);
    await expect(sql`UPDATE entities SET organization_id = NULL WHERE id = ${a}`).rejects.toThrow();
    await expect(sql`UPDATE entity_types SET backing_sql = 'SELECT 1' WHERE organization_id = ${workspace.org.id} AND slug = 'contact-record'`).rejects.toThrow(/identity/i);

  });

  it('blocks updateLink, connector co-ownership and SQL writes outside the governed path', async () => {
    const { sql, workspace, human, ids: [a, b, c], link, typeId } = await graph();
    const relationshipId = linked(await link(a, b));
    await expect(human.entities.updateLink({ relationship_id: relationshipId, confidence: 0.1 })).rejects.toThrow(/updateLink|identity/);
    await expect(human.entities.link({ from_entity_id: c, to_entity_id: b, relationship_type_slug: 'same_record', metadata: { _lobu_identity_decision: {} } })).rejects.toThrow(/reserved/);
    const connection = await createTestConnection({ organization_id: workspace.org.id, connector_key: 'fixture', created_by: workspace.users.owner.id, createDefaultFeed: false });
    await expect(sql.begin(tx => reconcileConnectorRelationshipClaims(tx, { organizationId: workspace.org.id,
      connectionId: connection.id, originId: 'source:a', desired: [{ declaration: { type: 'same_record', from: 'a', to: 'b' }, fromEntityId: a, toEntityId: b }] }))).rejects.toThrow(/identity/);
    await expect(sql`UPDATE entity_relationships SET deleted_at = NOW() WHERE id = ${relationshipId}`).rejects.toThrow(/lock/);
    await expect(sql.begin(async tx => {
      await lockIdentityOrganization(tx, workspace.org.id);
      await tx`UPDATE entity_relationships SET deleted_at = NOW() WHERE id = ${relationshipId}`;
    })).rejects.toThrow(/governed/);
    await expect(sql.begin(async tx => {
      await lockIdentityOrganization(tx, workspace.org.id);
      await withIdentityPrivilege(tx, () => tx`UPDATE entity_relationships SET to_entity_id = ${c}, deleted_at = NOW() WHERE id = ${relationshipId}`);
    })).rejects.toThrow(/immutable/);
    await expect(sql.begin(async tx => {
      await lockIdentityOrganization(tx, workspace.org.id);
      await withIdentityPrivilege(tx, () => tx`INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_id, relationship_type_id, metadata)
        VALUES (${workspace.org.id}, ${b}, ${a}, ${typeId}, ${tx.json({ _lobu_claims: { manual: {} }, _lobu_identity_decision: { outcome: 'accepted' } })})`);
    })).rejects.toThrow(/root/);
  });

  it.each(['apply', 'review', 'refused'] as const)('uses the same %s decision in preview and execution', async outcome => {
    const { human, agent, input, sql, workspace } = await graph(3, outcome === 'review' ? 'review' : 'auto_link');
    if (outcome === 'refused') await upsertEntityApprovalPolicy(workspace.org.id, { updateMode: 'deny' });
    const before = await sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${workspace.org.id}`;
    expect(await agent.entities.link({ ...input, dry_run: true })).toMatchObject({ preview: { outcome } });
    expect(await sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${workspace.org.id}`).toEqual(before);
    if (outcome === 'refused') await expect(agent.entities.link(input)).rejects.toThrow(/Policy denied/);
    else {
      const result = await agent.entities.link(input);
      if (outcome === 'apply') expect(result).toHaveProperty('relationship');
      else expect(result).toMatchObject({ approval_queued: true });
      expect(result).not.toHaveProperty('preview');
      if (outcome === 'review') expect(await human.operations.approve({ run_id: runId(result) })).toMatchObject({ approved: true });
    }
  });

  it('write-policy approval overrides certain resolution and rechecks denial at approval', async () => {
    const { workspace, human, agent, input } = await graph(3, 'auto_link');
    await upsertEntityApprovalPolicy(workspace.org.id, { updateMode: 'approval' });
    expect(await agent.entities.link({ ...input, dry_run: true })).toMatchObject({ preview: { outcome: 'review' } });
    const queued = await agent.entities.link(input);
    await upsertEntityApprovalPolicy(workspace.org.id, { updateMode: 'deny' });
    await expect(human.operations.approve({ run_id: runId(queued) })).rejects.toThrow(/Policy denied/);
  });

  it('requires fresh review after topology changes, even when both named roots remain roots', async () => {
    const { human, agent, input, ids: [, b, c], link, sql, workspace } = await graph(3, 'review');
    const queued = await agent.entities.link(input);
    await link(c, b);
    await expect(human.operations.approve({ run_id: runId(queued) })).rejects.toThrow(/stale.*fresh review/);
    const fresh = await agent.entities.link(input);
    expect(runId(fresh)).not.toBe(runId(queued));
    expect(await human.operations.approve({ run_id: runId(fresh) })).toMatchObject({ approved: true });
    expect((await sql`SELECT id FROM entity_relationships WHERE organization_id = ${workspace.org.id} AND deleted_at IS NULL`)).toHaveLength(2);
  });

  it('marks approval stale when an original root acquired a parent', async () => {
    const { human, agent, input, ids: [a, , c], link } = await graph(3, 'review');
    const queued = await agent.entities.link(input);
    await link(a, c);
    await expect(human.operations.approve({ run_id: runId(queued) })).rejects.toThrow(/stale.*fresh review/);
  });

  it('requires a withdrawal verdict even from a privileged SQL caller', async () => {
    const { sql, workspace, ids: [a, b], link } = await graph();
    const id = linked(await link(a, b));
    await expect(sql.begin(async tx => {
      await lockIdentityOrganization(tx, workspace.org.id);
      await withIdentityPrivilege(tx, () => tx`UPDATE entity_relationships SET deleted_at = NOW(),
        metadata = jsonb_set(metadata, '{_lobu_identity_decision}', '{}'::jsonb) WHERE id = ${id}`);
    })).rejects.toThrow(/withdrawal decision/);
  });

  it('suppresses unchanged/subset rejection support, ignores event versions, and reviews new support', async () => {
    const { human, agent, input, sql, workspace, ids: [a, b] } = await graph(3, 'review');
    const queued = await agent.entities.link(input);
    expect(await human.operations.reject({ run_id: runId(queued) })).toMatchObject({ rejected: true });
    expect(await agent.entities.link({ ...input, dry_run: true })).toMatchObject({ preview: { outcome: 'suppressed' } });
    await createTestEvent({ entity_id: a, content: 'Resynced version', origin_id: 'stable:source:item' });
    await human.entities.update({ entity_id: a, metadata: { emails: [] } });
    expect(await agent.entities.link(input)).toMatchObject({ approval_suppressed: true });
    for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: ['new@example.test'] } });
    const fresh = await agent.entities.link(input);
    expect(fresh).toMatchObject({ approval_queued: true });
    const [run] = await sql`SELECT action_input FROM runs WHERE id = ${runId(fresh)} AND organization_id = ${workspace.org.id}`;
    expect(run.action_input.support.fingerprint).not.toBe(run.action_input.topology);
    expect(JSON.stringify(run.action_input.support)).not.toMatch(/identity_ids|events.id/);
    expect(await human.operations.approve({ run_id: runId(fresh) })).toMatchObject({ approved: true });
  });

  it('withdraws atomically with its audit, suppresses automation replay, and permits human reconsideration', async () => {
    const { human, agent, input, sql, ids: [a, b], link } = await graph(3, 'auto_link');
    const relationshipId = linked(await link(a, b));
    await sql.unsafe(`CREATE FUNCTION test_identity_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.metadata->>'_lobu_relationship_change' = 'true' AND NEW.metadata->>'op' = 'unlink' THEN RAISE EXCEPTION 'audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER test_identity_audit_failure BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION test_identity_audit_failure()`);
    try {
      await expect(human.entities.unlink({ relationship_id: relationshipId })).rejects.toThrow(/audit failure/);
      const [edge] = await sql`SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${relationshipId}`;
      expect(edge.deleted_at).toBeNull();
      expect(edge.metadata._lobu_identity_decision.outcome).toBe('accepted');
    } finally {
      await sql.unsafe('DROP TRIGGER test_identity_audit_failure ON events; DROP FUNCTION test_identity_audit_failure()');
    }
    await human.entities.unlink({ relationship_id: relationshipId });
    expect(await agent.entities.link(input)).toMatchObject({ approval_suppressed: true });
    const reconsidered = await human.entities.link(input);
    expect(reconsidered).toMatchObject({ approval_queued: true });
    const [proposal] = await sql`SELECT action_input FROM runs WHERE id = ${runId(reconsidered)}`;
    expect(proposal.action_input.reason).toContain(`withdrawal #${relationshipId}`);
    expect(await human.operations.approve({ run_id: runId(reconsidered) })).toMatchObject({ approved: true });
    const [replacement] = await sql`SELECT id FROM entity_relationships WHERE from_entity_id = ${a} AND to_entity_id = ${b} AND deleted_at IS NULL`;
    expect(Number(replacement.id)).not.toBe(relationshipId);
  });

  it('refuses deletion of linked identity members', async () => {
    const { human, sql, workspace, ids: [a, b], link } = await graph();
    await link(a, b);
    await expect(human.entities.delete({ entity_id: a })).rejects.toThrow(/identity/i);
    await expect(sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${a}`).rejects.toThrow(/Unlink identity/);
    await expect(sql`DELETE FROM organization WHERE id = ${workspace.org.id}`).rejects.toThrow(/identity/i);
    await expect(sql`DELETE FROM entity_relationship_types WHERE organization_id = ${workspace.org.id} AND slug = 'same_record'`).rejects.toThrow(/identity/i);
  });

  it.each(['reserved', 'derived'] as const)('refuses %s stored endpoints', async kind => {
    const { sql, workspace, human, input } = await graph();
    if (kind === 'reserved') await sql`UPDATE entity_types SET slug = '$identity-fixture' WHERE organization_id = ${workspace.org.id} AND slug = 'contact-record'`;
    else {
      await expect(sql`UPDATE entity_types SET backing_sql = 'SELECT 1 AS id' WHERE organization_id = ${workspace.org.id} AND slug = 'contact-record'`).rejects.toThrow(/stored rows exist/);
      await expect(human.entities.link({ from: { type: 'derived', key: 'a' }, to: { type: 'derived', key: 'b' }, relationship_type_slug: 'same_record' })).rejects.toThrow();
      return;
    }
    await expect(human.entities.link(input)).rejects.toThrow(/stored.*non-reserved/);
  });

  it('rejects the retired redirect column even when a type has no identity edges', async () => {
    const { sql, ids: [a, b] } = await graph();
    await expect(sql`UPDATE entities SET merged_into = ${b} WHERE id = ${a}`).rejects.toMatchObject({ code: '42703' });
  });

  it('keeps classification inert for ordinary relationships and refuses adopting populated edges', async () => {
    const { human, ids: [a, b] } = await graph();
    await human.entity_schema.createRelType({ slug: 'ordinary', name: 'Ordinary' });
    await human.entities.link({ from_entity_id: a, to_entity_id: b, relationship_type_slug: 'ordinary' });
    // Ordinary relationships are still arbitrary directed graphs.
    await human.entities.link({ from_entity_id: b, to_entity_id: a, relationship_type_slug: 'ordinary' });
    await expect(human.entity_schema.updateRelType({ slug: 'ordinary', purpose: 'identity' })).rejects.toThrow(/immutable/);
    expect(await human.entity_schema.getRelType('ordinary')).toMatchObject({ relationship_type: { purpose: null } });
  });

  it('rechecks row authorization for the original requester at approval', async () => {
    const { workspace, agent, human, input, sql } = await graph(3, 'review');
    const queued = await agent.entities.link(input);
    await sql`UPDATE "member" SET role = 'member' WHERE "organizationId" = ${workspace.org.id} AND "userId" = ${workspace.users.owner.id}`;
    const admin = workspace.admin.withAuth({ tokenType: 'session' });
    await expect(admin.operations.approve({ run_id: runId(queued) })).rejects.toThrow(/permission to edit/);
    await expect(human.entities.link(input)).rejects.toThrow(/permission/);
  });

  it('keeps rejection memory across successive evidence gains and later evidence loss', async () => {
    const { human, agent, input, ids: [a, b] } = await graph(3, 'review');
    const first = await agent.entities.link(input);
    await human.operations.reject({ run_id: runId(first) });
    for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: ['second@example.test'] } });
    const second = await agent.entities.link(input);
    await human.operations.reject({ run_id: runId(second) });
    for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: ['shared@example.test'] } });
    expect(await agent.entities.link(input)).toMatchObject({ approval_suppressed: true });
    await human.entity_schema.updateType({ slug: 'contact-record', metadata_schema: {
      'x-lobu-resolution': { rules: [{ fields: ['emails'], normalizer: 'email', onMatch: 'auto_link' }] },
    } });
    // A new policy permits reconsideration, but never silently undoes rejection.
    expect(await agent.entities.link(input)).toMatchObject({ approval_queued: true });
  });

  it.each([false, true])('retains both rejections when proposals overlap (reverse=%s)', async reverse => {
    const { human, agent, input, ids: [a, b] } = await graph(3, 'review');
    const first = await agent.entities.link(input);
    for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: ['second@example.test'] } });
    const second = await agent.entities.link(input);
    for (const proposal of reverse ? [second, first] : [first, second]) {
      await human.operations.reject({ run_id: runId(proposal) });
    }
    for (const email of ['shared@example.test', 'second@example.test']) {
      for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: [email] } });
      expect(await agent.entities.link({ ...input, dry_run: true })).toMatchObject({ preview: { outcome: 'suppressed' } });
    }
  });

  it('fingerprints scoped normalized source support without identity-row ids', async () => {
    const { sql, workspace, human, agent, input, ids: [a, b] } = await graph(3, 'review');
    for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: [] } });
    const connection = await createTestConnection({ organization_id: workspace.org.id, connector_key: 'fixture', created_by: workspace.users.owner.id, createDefaultFeed: false });
    for (const [id, identifier] of [[a, 'Shared@Example.test'], [b, 'shared@example.test']] as const) {
      await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key, source_connector, connection_id)
        VALUES (${workspace.org.id}, ${id}, 'emails', ${identifier}, 'fixture-scope', 'fixture', ${connection.id})`;
    }
    const first = await agent.entities.link(input);
    const [before] = await sql`SELECT action_input->'support' AS support FROM runs WHERE id = ${runId(first)}`;
    expect(before.support.keys.join(' ')).toContain('fixture-scope');
    expect(before.support.keys.join(' ')).toContain(String(connection.id));
    await human.operations.reject({ run_id: runId(first) });
    await sql`UPDATE entity_identities SET deleted_at = NOW() WHERE entity_id = ${a}`;
    await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key, source_connector, connection_id)
      VALUES (${workspace.org.id}, ${a}, 'emails', 'Shared@Example.test', 'fixture-scope', 'fixture', ${connection.id})`;
    expect(await agent.entities.link(input)).toMatchObject({ approval_suppressed: true });
    const otherConnection = await createTestConnection({ organization_id: workspace.org.id, connector_key: 'fixture', created_by: workspace.users.owner.id, createDefaultFeed: false });
    await sql`UPDATE entity_identities SET connection_id = ${otherConnection.id} WHERE entity_id = ${a} AND deleted_at IS NULL`;
    const next = await agent.entities.link(input);
    expect(next).toMatchObject({ approval_queued: true });
    const [after] = await sql`SELECT action_input->'support' AS support FROM runs WHERE id = ${runId(next)}`;
    expect(after.support.fingerprint).not.toBe(before.support.fingerprint);
  });

  it('gates unlink through the same preview and reviewed execution path', async () => {
    const { workspace, human, agent, ids: [a, b], link, sql } = await graph();
    const relationshipId = linked(await link(a, b));
    await upsertEntityApprovalPolicy(workspace.org.id, { updateMode: 'approval' });
    expect(await agent.entities.unlink({ relationship_id: relationshipId, dry_run: true })).toMatchObject({ preview: { outcome: 'review' } });
    const queued = await agent.entities.unlink({ relationship_id: relationshipId });
    expect(await human.operations.approve({ run_id: runId(queued) })).toMatchObject({ approved: true });
    const [edge] = await sql`SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${relationshipId}`;
    expect(edge.deleted_at).not.toBeNull();
    expect(edge.metadata._lobu_identity_decision.outcome).toBe('withdrawn');
  });

  it('applies an owner-approved relationship declaration under the shared lock', async () => {
    const { agent, human, workspace } = await graph();
    await upsertEntityApprovalPolicy(workspace.org.id, { resourceClass: 'entity_schema', principalKind: 'agent', effects: { create_relationship_type: 'approval' } });
    const proposal = await agent.entity_schema.createRelType({ slug: 'reviewed_identity', name: 'Reviewed identity', purpose: 'identity' }) as { run_id: number };
    expect(Number.isSafeInteger(proposal.run_id)).toBe(true);
    expect(await human.operations.approve({ run_id: proposal.run_id })).toMatchObject({ approved: true });
    expect(await human.entity_schema.getRelType('reviewed_identity')).toMatchObject({ relationship_type: { purpose: 'identity' } });
  });

  it('keeps an Automation preview of an existing edge free of reaction writes', async () => {
    const { sql, workspace, human, agentRow, input } = await graph(3, 'auto_link');
    await human.entities.link(input);
    const [automation] = await sql`INSERT INTO automations
      (organization_id, managed_agent_id, created_by, automation_group_id, name, status, min_cooldown_seconds)
      VALUES (${workspace.org.id}, ${agentRow.agentId}, ${workspace.users.owner.id}, 61001, 'Identity fixture', 'active', 0) RETURNING id`;
    const [run] = await sql`INSERT INTO runs (organization_id, automation_id, run_type, status)
      VALUES (${workspace.org.id}, ${automation.id}, 'internal', 'running') RETURNING id`;
    const actor = workspace.withAuth({ agentId: agentRow.agentId, actingAutomationId: Number(automation.id), actingRunId: Number(run.id) });
    expect(await actor.entities.link({ ...input, dry_run: true })).toMatchObject({ preview: { outcome: 'apply' } });
    expect(await sql`SELECT id FROM automation_reactions WHERE organization_id = ${workspace.org.id}`).toHaveLength(0);
  });

  it('allows ordinary deletion after explicit unlink and retains its append-only audit', async () => {
    const { human, sql, workspace, ids: [a, b], link } = await graph();
    const relationshipId = linked(await link(a, b));
    await human.entities.unlink({ relationship_id: relationshipId });
    const auditBefore = await sql`SELECT id FROM events WHERE organization_id = ${workspace.org.id} AND metadata->>'relationshipId' = ${String(relationshipId)} ORDER BY id`;
    await human.entity_schema.updateRelType({ slug: 'same_record', status: 'archived' });
    await human.entities.delete({ entity_id: a, force_delete_tree: true });
    expect(await sql`SELECT id FROM entities WHERE id = ${a}`).toHaveLength(0);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${workspace.org.id} AND metadata->>'relationshipId' = ${String(relationshipId)} ORDER BY id`).toEqual(auditBefore);
  });
  it('uses direct member evidence even when both roots lack that evidence', async () => {
    const { human, agent, ids: [a, b, c, d], link } = await graph(4, 'auto_link');
    for (const id of [b, d]) await human.entities.update({ entity_id: id, metadata: { emails: [] } });
    await link(a, b);
    await link(c, d);
    const result = await agent.entities.link({ from_entity_id: b, to_entity_id: d, relationship_type_slug: 'same_record' });
    expect(result).toMatchObject({ relationship: { from_entity_id: b, to_entity_id: d } });
    expect(result).not.toHaveProperty('approval_queued', true);
  });

  it('requires review for conflicting unique values anywhere in the joined groups', async () => {
    const { human, agent, ids: [a, b, c], link } = await graph(3, 'auto_link');
    await human.entities.update({ entity_id: a, metadata: { emails: ['conflicting@example.test'] } });
    await link(a, b);
    expect(await agent.entities.link({ from_entity_id: b, to_entity_id: c, relationship_type_slug: 'same_record' }))
      .toMatchObject({ approval_queued: true });
  });

  it.each(['link', 'unlink'] as const)('gates %s on a denied non-root member', async operation => {
    const { workspace, agent, ids: [a, b, c], link } = await graph(3, 'auto_link');
    await link(a, b);
    const relationshipId = operation === 'unlink' ? linked(await link(b, c)) : undefined;
    await upsertEntityApprovalPolicy(workspace.org.id, { entityId: a, updateMode: 'deny' });
    const result = operation === 'link'
      ? await agent.entities.link({ from_entity_id: b, to_entity_id: c, relationship_type_slug: 'same_record', dry_run: true })
      : await agent.entities.unlink({ relationship_id: relationshipId, dry_run: true });
    expect(result).toMatchObject({ dry_run: true, preview: { outcome: 'refused' } });
  });

  it('invalidates approval when unmatched normalized values change', async () => {
    const { human, agent, input, ids: [a] } = await graph(3, 'review');
    const queued = await agent.entities.link(input);
    await human.entities.update({ entity_id: a, metadata: { emails: ['shared@example.test', 'new-unmatched@example.test'] } });
    await expect(human.operations.approve({ run_id: runId(queued) })).rejects.toThrow(/stale/);
  });

  it('keeps a rejected member pair suppressed after its representative changes', async () => {
    const { human, agent, ids: [a, b, c], link } = await graph(3, 'review');
    const rejected = await agent.entities.link({ from_entity_id: a, to_entity_id: c, relationship_type_slug: 'same_record' });
    await human.operations.reject({ run_id: runId(rejected) });
    await link(a, b);
    expect(await agent.entities.link({ from_entity_id: b, to_entity_id: c, relationship_type_slug: 'same_record' }))
      .toMatchObject({ approval_suppressed: true });
  });

  it('retains accepted member support when withdrawal follows an evidence edit', async () => {
    const { human, agent, input, ids: [a, b], link } = await graph(2, 'auto_link');
    const relationshipId = linked(await link(a, b));
    for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: ['replacement@example.test'] } });
    await human.entities.unlink({ relationship_id: relationshipId });
    for (const id of [a, b]) await human.entities.update({ entity_id: id, metadata: { emails: ['shared@example.test'] } });
    expect(await agent.entities.link(input)).toMatchObject({ approval_suppressed: true });
  });

  it('does not overwrite a newer policy rejection when an older proposal is rejected last', async () => {
    const { human, agent, input } = await graph(2, 'review');
    const first = await agent.entities.link(input);
    await human.entity_schema.updateType({ slug: 'contact-record', metadata_schema: {
      'x-lobu-resolution': { rules: [
        { fields: ['emails'], normalizer: 'email', onMatch: 'review' },
        { fields: ['phone'], normalizer: 'phone', onMatch: 'review' },
      ] },
    } });
    const second = await agent.entities.link(input);
    await human.operations.reject({ run_id: runId(second) });
    await human.operations.reject({ run_id: runId(first) });
    expect(await agent.entities.link(input)).toMatchObject({ approval_suppressed: true });
  });

  it('allows fresh group review when non-root evidence grows despite unchanged empty root pairs', async () => {
    const { human, agent, ids: [a, b, c, d], link } = await graph(4, 'review');
    for (const id of [b, d]) await human.entities.update({ entity_id: id, metadata: { emails: [] } });
    await link(a, b);
    await link(c, d);
    const input = { from_entity_id: b, to_entity_id: d, relationship_type_slug: 'same_record' };
    await human.operations.reject({ run_id: runId(await agent.entities.link(input)) });
    expect(await agent.entities.link(input)).toMatchObject({ approval_suppressed: true });
    for (const id of [a, c]) await human.entities.update({ entity_id: id, metadata: { emails: ['shared@example.test', 'new@example.test'] } });
    expect(await agent.entities.link(input)).toMatchObject({ approval_queued: true });
  });

  it('does not report an unlink as applied while approval is pending', async () => {
    const { workspace, human, agent, ids: [a, b], link, sql } = await graph();
    const relationshipId = linked(await link(a, b));
    await upsertEntityApprovalPolicy(workspace.org.id, { updateMode: 'approval' });
    const queued = await agent.entities.unlink({ relationship_id: relationshipId });
    expect(queued).toMatchObject({ approval_queued: true });
    expect(queued).not.toHaveProperty('success');
    expect(queued).not.toHaveProperty('preview');
    expect((await sql`SELECT deleted_at FROM entity_relationships WHERE id = ${relationshipId}`)[0].deleted_at).toBeNull();
    await human.operations.approve({ run_id: runId(queued) });
  });

});
