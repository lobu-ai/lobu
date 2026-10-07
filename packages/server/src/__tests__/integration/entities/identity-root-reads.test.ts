import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { TestWorkspace } from '../../setup/test-mcp-client';
import { countEntitiesOfType, countStoredEntitiesOfType, getEntityCountsByTypes } from '../../../utils/entity-management';

async function graph() {
  const workspace = await TestWorkspace.create({ name: 'Canonical root reads' });
  const human = await workspace.withAuth({ tokenType: 'session' });
  await human.entity_schema.createType({ slug: 'contact-record', name: 'Contact record' });
  await human.entity_schema.createRelType({ slug: 'same_record', name: 'Same record', purpose: 'identity' });
  const ids: number[] = [];
  for (const name of ['Alpha 100%', 'Bravo', 'Charlie']) {
    const result = await human.entities.create({ type: 'contact-record', name, metadata: { domain: `${name.toLowerCase().replace(/ /g, '-')}.example.test` } });
    ids.push(Number(result.entity.id));
  }
  const link = (from: number, to: number) => human.entities.link({ from_entity_id: from, to_entity_id: to, relationship_type_slug: 'same_record' });
  const list = (args = {}) => human.entities.list({ entity_type: 'contact-record', ...args });
  return { workspace, human, ids, link, list };
}

describe('canonical identity root list/search/count', () => {
  beforeEach(cleanupTestDatabase);

  it('paginates roots, not retained member rows, for plain and computed sorts', async () => {
    const { ids: [a, b, c], link, list } = await graph();
    await link(a, b);
    for (const sort_by of ['name', 'total_content']) {
      const first = await list({ limit: 1, sort_by, sort_order: 'asc' });
      const second = await list({ limit: 1, offset: 1, sort_by, sort_order: 'asc' });
      expect(first.metadata.total_count).toBe(2);
      expect(second.metadata.total_count).toBe(2);
      expect(first.metadata.has_more).toBe(true);
      expect(second.metadata.has_more).toBe(false);
      expect(new Set([...first.entities, ...second.entities].map(row => Number(row.id)))).toEqual(new Set([b, c]));
      const beyond = await list({ offset: 20, sort_by });
      expect(beyond.entities).toEqual([]);
      expect(beyond.metadata.total_count).toBe(2);
    }
  });

  it('searches transitive member names/domains and returns the root once without changing its metadata', async () => {
    const { ids: [a, b, c], link, list } = await graph();
    await link(a, b);
    await link(b, c);
    for (const search of ['Alpha', '%', 'alpha-100%.example.test', 'Bravo', 'Charlie']) {
      const result = await list({ search });
      expect(result.entities.map(row => Number(row.id))).toEqual([c]);
      expect(result.entities[0].name).toBe('Charlie');
      expect(result.entities[0].metadata.domain).toBe('charlie.example.test');
      expect(result.metadata.total_count).toBe(1);
    }
    expect((await list({ search: 'missing' })).entities).toEqual([]);
  });

  it('display counts agree with roots while physical counts keep all source records', async () => {
    const { workspace, ids: [a, b], link } = await graph();
    await link(a, b);
    const [type] = await getTestDb()`SELECT id, slug FROM entity_types WHERE organization_id = ${workspace.org.id} AND slug = 'contact-record'`;
    const input = { id: Number(type.id), slug: String(type.slug) };
    const ctx = { organizationId: workspace.org.id } as Parameters<typeof countEntitiesOfType>[1];
    expect(await countEntitiesOfType(input, ctx)).toBe(2);
    expect((await getEntityCountsByTypes([input], ctx)).get(input.id)).toBe(2);
    expect(await countStoredEntitiesOfType(input.id, ctx.organizationId)).toBe(3);
  });

  it('unlink restores member visibility and ordinary relationships do not collapse rows', async () => {
    const { human, ids: [a, b], link, list } = await graph();
    const result = await link(a, b);
    await human.entities.unlink({ relationship_id: Number(result.relationship.id) });
    expect((await list()).metadata.total_count).toBe(3);
    expect((await list({ search: 'Alpha' })).entities.map(row => Number(row.id))).toEqual([a]);
    await human.entity_schema.createRelType({ slug: 'knows', name: 'Knows' });
    await human.entities.link({ from_entity_id: a, to_entity_id: b, relationship_type_slug: 'knows' });
    expect((await list()).metadata.total_count).toBe(3);
  });
  it('does not pull names from another workspace and keeps filters on the root', async () => {
    const { human, ids: [a, b, c], link, list } = await graph();
    await human.entities.update({ entity_id: a, metadata: { category: 'member-only', main_market: 'member-only', market: 'member-only' } });
    await human.entities.update({ entity_id: b, parent_id: c, metadata: { category: 'root-only', main_market: 'root-only', market: 'root-only' } });
    await link(a, b);
    const other = await TestWorkspace.create({ name: 'Other root workspace' });
    await other.owner.entity_schema.createType({ slug: 'contact-record', name: 'Contact record' });
    await other.owner.entities.create({ type: 'contact-record', name: 'Private foreign name' });
    expect((await list({ search: 'Private foreign name' })).entities).toEqual([]);
    expect((await human.entities.list({ search: 'Alpha' })).entities.map(row => Number(row.id))).toEqual([b]);
    expect((await list({ search: 'Alpha', parent_id: c })).metadata.total_count).toBe(1);
    expect((await list({ search: 'Alpha', parent_id: null })).metadata.total_count).toBe(0);
    for (const filter of ['category', 'main_market', 'market']) {
      expect((await list({ search: 'Alpha', [filter]: 'root-only' })).entities.map(row => Number(row.id))).toEqual([b]);
      expect((await list({ search: 'Alpha', [filter]: 'member-only' })).metadata.total_count).toBe(0);
    }
  });

  it.each(['member', 'root'] as const)('excludes a deleted %s after unlink while retaining the live endpoint', async (endpoint) => {
    const { human, ids: [a, b, c], link, list } = await graph();
    const result = await link(a, b);
    await human.entities.unlink({ relationship_id: Number(result.relationship.id) });
    const deleted = endpoint === 'member' ? a : b;
    const survivor = endpoint === 'member' ? b : a;
    // Identity guards require unlink before deletion; its retired edge remains.
    await getTestDb()`UPDATE entities SET deleted_at = NOW() WHERE id = ${deleted}`;
    const remaining = await list();
    expect(new Set(remaining.entities.map(row => Number(row.id)))).toEqual(new Set([survivor, c]));
    expect(remaining.metadata.total_count).toBe(2);
    expect((await list({ search: endpoint === 'member' ? 'Alpha' : 'Bravo' })).entities).toEqual([]);
  });

  it('keeps a denied type denied even when searching a linked member', async () => {
    const { workspace, ids: [a, b], link } = await graph();
    await link(a, b);
    const row = await createTestAgent({ organizationId: workspace.org.id, ownerUserId: workspace.users.owner.id });
    await upsertEntityApprovalPolicy(workspace.org.id, {
      principalKind: 'agent', principalId: row.agentId,
      entityTypeSlug: 'contact-record', effects: { read: 'deny' },
    });
    const agent = workspace.withAuth({ agentId: row.agentId });
    await expect(agent.entities.list({ entity_type: 'contact-record', search: 'Alpha' })).rejects.toThrow();
    expect((await agent.entities.list({ search: 'Alpha' })).entities).toEqual([]);
  });

});
