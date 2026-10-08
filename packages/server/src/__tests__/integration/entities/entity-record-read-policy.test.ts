import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { countEntitiesOfType, getEntityCountsByTypes } from '../../../utils/entity-management';
import type { UnifiedSearchResult } from '../../../tools/search';
import * as entityIdentity from '../../../utils/entity-identity';

async function fixture() {
  const workspace = await TestWorkspace.create({ name: 'Record read policy' });
  const human = workspace.withAuth({ tokenType: 'session' });
  await human.entity_schema.createType({ slug: 'asset', name: 'Asset', metadata_schema: {
    'x-lobu-resolution': { rules: [{ fields: ['serial'], normalizer: 'exact', onMatch: 'review' }] },
  } });
  await human.entity_schema.createRelType({ slug: 'same_asset', name: 'Same asset', purpose: 'identity' });
  await human.entity_schema.addRule({ slug: 'same_asset', source_entity_type_slug: 'asset', target_entity_type_slug: 'asset' });
  const principal = await createTestAgent({ organizationId: workspace.org.id, ownerUserId: workspace.users.owner.id });
  const agent = workspace.withAuth({ agentId: principal.agentId });
  const create = async (name: string, serial = 'shared') => {
    const row = await createTestEntity({ name, entity_type: 'asset', organization_id: workspace.org.id });
    await getTestDb()`UPDATE entities SET metadata = ${getTestDb().json({ serial })} WHERE id = ${row.id}`;
    return row.id;
  };
  const deny = (entityId: number, extra = {}) => upsertEntityApprovalPolicy(workspace.org.id, {
    principalKind: 'agent', principalId: principal.agentId, entityId, effects: { read: 'deny' }, ...extra,
  });
  const link = (from: number, to: number) => human.entities.link({ from_entity_id: from, to_entity_id: to, relationship_type_slug: 'same_asset' });
  return { workspace, human, agent, principal, create, deny, link };
}

describe('per-record entity read envelope', () => {
  beforeEach(cleanupTestDatabase);

  it.each(['root', 'member'] as const)('withholds a group with a denied %s from get, lists, search and discovery', async denied => {
    const h = await fixture();
    const member = await h.create('Needle');
    const root = await h.create('Needle secret root');
    const first = await h.create('Needle visible A');
    const second = await h.create('Needle visible B');
    await h.link(member, root);
    await h.deny(denied === 'root' ? root : member);
    for (const entity_id of [member, root]) await expect(h.agent.entities.get({ entity_id })).rejects.toThrow(/not found|denies reading/i);
    for (const entity_type of ['asset', undefined]) {
      for (const sort_by of ['name', 'total_content']) {
        const page = await h.agent.entities.list({ entity_type, limit: 1, sort_by, sort_order: 'asc' });
        expect(page.entities).toHaveLength(1);
        expect([first, second]).toContain(Number(page.entities[0].id));
        expect(page.metadata).toMatchObject({ total_count: 2, has_more: true });
        const tail = await h.agent.entities.list({ entity_type, limit: 1, offset: 1, sort_by, sort_order: 'asc' });
        expect(tail.metadata).toMatchObject({ total_count: 2, has_more: false });
        expect(new Set([...page.entities, ...tail.entities].map(row => Number(row.id)))).toEqual(new Set([first, second]));
      }
    }
    const [type] = await getTestDb()`SELECT id, slug FROM entity_types WHERE organization_id = ${h.workspace.org.id} AND slug = 'asset'`;
    const typeInput = { id: Number(type.id), slug: String(type.slug) };
    const ctx = { organizationId: h.workspace.org.id, agentId: h.principal.agentId } as Parameters<typeof countEntitiesOfType>[1];
    expect(await countEntitiesOfType(typeInput, ctx)).toBe(2);
    expect((await getEntityCountsByTypes([typeInput], ctx)).get(typeInput.id)).toBe(2);
    const search = await h.agent.knowledge.search({ query: 'Needle', limit: 2 }) as UnifiedSearchResult;
    expect(search.matches.map(row => Number(row.id)).sort((a, b) => a - b)).toEqual([first, second]);
    const discovered = await h.agent.entities.discoverDuplicates({ entity_type: 'asset' });
    expect(discovered.candidates_scanned).toBe(2);
    expect(discovered.components[0].candidate_entity_ids).toEqual([first, second]);
    expect((await h.human.entities.get({ entity_id: root })).entity.identity?.member_ids).toEqual([member, root]);
  });

  it('applies record reads before discovery oversize accounting', async () => {
    const h = await fixture();
    const ids = [];
    for (let i = 0; i < 27; i++) ids.push(await h.create(`Candidate ${i}`));
    await h.deny(ids[0]);
    const result = await h.agent.entities.discoverDuplicates({ entity_type: 'asset' });
    expect(result.candidates_scanned).toBe(26);
    expect(result.components[0]).toMatchObject({ candidate_count: 26, oversized: false, candidate_entity_ids: ids.slice(1) });
    expect(result.components[0].decisions).toHaveLength(1);
  });

  it.each(['get', 'list', 'search'] as const)('withholds %s rows when a denied member joins after the record read', async method => {
    const h = await fixture();
    const visible = await h.create('Visible record');
    const hidden = await h.create('Hidden member');
    await h.deny(hidden);
    const attach = entityIdentity.attachEntityIdentities;
    let crossedBarrier = false;
    const barrier = vi.spyOn(entityIdentity, 'attachEntityIdentities').mockImplementation(async (db, rows) => {
      if (!crossedBarrier && rows.some(row => Number(row.id) === visible)) {
        crossedBarrier = true;
        await h.link(hidden, visible);
      }
      return attach(db, rows);
    });
    try {
      if (method === 'get') {
        await expect(h.agent.entities.get({ entity_id: visible })).rejects.toThrow(/not found|denies reading/i);
      } else if (method === 'list') {
        expect((await h.agent.entities.list({ entity_type: 'asset' })).entities).toEqual([]);
      } else {
        expect(((await h.agent.knowledge.search({ entity_id: visible })) as UnifiedSearchResult).matches).toEqual([]);
      }
      expect(crossedBarrier).toBe(true);
    } finally {
      barrier.mockRestore();
    }
  });

  it('checks the captured descriptor even if a denied member leaves before the final guard', async () => {
    const h = await fixture();
    const visible = await h.create('Visible record');
    const hidden = await h.create('Hidden member');
    await h.deny(hidden);
    const attach = entityIdentity.attachEntityIdentities;
    let crossedBarrier = false;
    const barrier = vi.spyOn(entityIdentity, 'attachEntityIdentities').mockImplementation(async (db, rows) => {
      if (crossedBarrier || !rows.some(row => Number(row.id) === visible)) return attach(db, rows);
      crossedBarrier = true;
      const linked = await h.link(hidden, visible);
      const attached = await attach(db, rows);
      expect(attached.find(row => Number(row.id) === visible)?.identity?.member_ids).toEqual([visible, hidden]);
      await h.human.entities.unlink({ relationship_id: Number(linked.relationship.id) });
      return attached;
    });
    try {
      await expect(h.agent.entities.get({ entity_id: visible })).rejects.toThrow(/not found|denies reading/i);
      expect(crossedBarrier).toBe(true);
    } finally {
      barrier.mockRestore();
    }
    expect((await h.agent.entities.get({ entity_id: visible })).entity.identity?.member_ids).toEqual([visible]);
  });

  it('keeps field-only and other-principal restrictions out of whole-record reads', async () => {
    const h = await fixture();
    const id = await h.create('Visible');
    await h.deny(id, { fieldPath: 'serial' });
    const other = await createTestAgent({ organizationId: h.workspace.org.id, ownerUserId: h.workspace.users.owner.id });
    await h.deny(id, { principalId: other.agentId });
    expect((await h.agent.entities.get({ entity_id: id })).entity.id).toBe(id);
    expect((await h.agent.entities.list({ entity_type: 'asset' })).entities.map(row => row.id)).toEqual([id]);
  });

  it('omits denied records from relationship and linked-column presentation', async () => {
    const h = await fixture();
    const visible = await h.create('Visible record');
    const hidden = await h.create('Hidden relationship target');
    await h.deny(hidden);
    await h.human.entity_schema.createRelType({ slug: 'related_asset', name: 'Related asset' });
    await h.human.entities.link({ from_entity_id: visible, to_entity_id: hidden, relationship_type_slug: 'related_asset' });
    const [target] = await getTestDb()`SELECT slug FROM entities WHERE id = ${hidden}`;
    const schema = { type: 'object', properties: { target: { type: 'string', 'x-link-entity-type': 'asset' } },
      'x-table-relationships': [{ relationship_type: 'related_asset', direction: 'outbound', label: 'Related' }] };
    await getTestDb()`UPDATE entity_types SET metadata_schema = ${getTestDb().json(schema)} WHERE organization_id = ${h.workspace.org.id} AND slug = 'asset'`;
    await getTestDb()`UPDATE entities SET metadata = ${getTestDb().json({ target: target.slug })} WHERE id = ${visible}`;
    const links = await h.agent.entities.listLinks({ entity_id: visible });
    expect(links.relationships).toEqual([]);
    expect(links.metadata.total).toBe(0);
    expect(links.counts_by_type).toEqual([]);
    const page = await h.agent.entities.list({ entity_type: 'asset' });
    expect(page.entities).toHaveLength(1);
    expect(page.entities[0].relationships ?? {}).toEqual({});
    expect(page.linked_entities?.['asset:slug'] ?? {}).toEqual({});
    const human = await h.human.entities.list({ entity_type: 'asset' });
    expect(human.entities.find(row => Number(row.id) === visible)?.relationships?.related_asset?.[0].id).toBe(hidden);
    expect(human.linked_entities?.['asset:slug']?.[String(target.slug)].name).toBe('Hidden relationship target');
  });

  it('redacts denied parents and excludes denied children from display counts', async () => {
    const h = await fixture();
    const visible = await h.create('Visible child');
    const hidden = await h.create('Hidden parent');
    const hiddenChild = await h.create('Hidden child');
    await getTestDb()`UPDATE entities SET parent_id = ${hidden} WHERE id = ${visible}`;
    await getTestDb()`UPDATE entities SET parent_id = ${visible} WHERE id = ${hiddenChild}`;
    await h.deny(hidden);
    await h.deny(hiddenChild);
    const detail = await h.agent.entities.get({ entity_id: visible });
    expect(detail.entity.parent_id).toBeNull();
    expect(detail.entity.parent_name).toBeNull();
    const page = await h.agent.entities.list({ entity_type: 'asset' });
    expect(page.entities).toHaveLength(1);
    expect(page.entities[0].parent_id).toBeNull();
    expect(page.entities[0].parent_name).toBeNull();
    expect(Number(page.entities[0].children_count)).toBe(0);
    const found = await h.agent.knowledge.search({ entity_id: visible }) as UnifiedSearchResult;
    expect(found.matches[0].parent_id).toBeNull();
    expect(found.matches[0].parent_name).toBeNull();
    expect(found.matches[0].stats.children_count).toBe(0);
    expect(found.children ?? []).toEqual([]);
    expect((await h.human.entities.get({ entity_id: visible })).entity.parent_id).toBe(hidden);
  });

  it('denies exact group history and content IDs associated with a denied group', async () => {
    const h = await fixture();
    const member = await h.create('Hidden member');
    const root = await h.create('Root');
    await h.link(member, root);
    const event = await createTestEvent({ organization_id: h.workspace.org.id, entity_id: root, content: 'private group history' });
    await h.deny(member);
    for (const entity_id of [member, root]) {
      await expect(h.agent.knowledge.read({ entity_id })).rejects.toThrow(/denies reading/i);
    }
    await expect(h.agent.knowledge.read({ content_ids: [event.id] })).rejects.toThrow(/denies reading/i);
    const human = await h.human.knowledge.read({ entity_id: root });
    expect(human.content.map(row => Number(row.id))).toContain(event.id);
  });

  it('uses current persisted policy and treats a stored read approval as denial', async () => {
    const h = await fixture();
    const id = await h.create('Visible until restricted');
    const policy = await h.deny(id);
    await getTestDb()`UPDATE write_policy_action_effects SET effect = 'approval' WHERE policy_id = ${policy.id} AND action = 'read'`;
    await expect(h.agent.entities.get({ entity_id: id })).rejects.toThrow(/not found|denies reading/i);
    await h.deny(id, { effects: { read: 'auto' } });
    expect((await h.agent.entities.get({ entity_id: id })).entity.id).toBe(id);
  });
});
