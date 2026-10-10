import type { UnifiedSearchResult } from '../../../tools/search';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestConnection, createTestConnectorDefinition, createTestEvent } from '../../setup/test-fixtures';
import { IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY } from '../../../identity/scope-projection';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { TestWorkspace } from '../../setup/test-mcp-client';
import { countEntitiesOfType, countStoredEntitiesOfType, getEntityCountsByTypes } from '../../../utils/entity-management';

async function graph() {
  const workspace = await TestWorkspace.create({ name: 'Canonical root reads' });
  const human = await workspace.withAuth({ tokenType: 'session' });
  await human.entity_schema.createType({ slug: 'contact-record', name: 'Contact record', metadata_schema: {
    type: 'object', properties: { domain: { type: 'string' }, category: { type: 'string' }, main_market: { type: 'string' }, market: { type: 'string' } },
  }, metrics_config: { segments: { member_only: { on: 'entity', where: "metadata->>'category' = 'member-only'" } } } });
  await human.entity_schema.createRelType({ slug: 'same_record', name: 'Same record', purpose: 'identity' });
  const ids: number[] = [];
  for (const name of ['Alpha 100%', 'Bravo', 'Charlie']) {
    const result = await human.entities.create({ entity_type: 'contact-record', name, metadata: { domain: `${name.toLowerCase().replace(/ /g, '-')}.example.test` } });
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

  it('searches transitive member names and returns the root once without changing its metadata', async () => {
    const { ids: [a, b, c], link, list } = await graph();
    await link(a, b);
    await link(b, c);
    for (const search of ['Alpha', '%', 'Bravo', 'Charlie']) {
      const result = await list({ search });
      expect(result.entities.map(row => Number(row.id))).toEqual([c]);
      expect(result.entities[0].name).toBe('Charlie');
      expect(result.entities[0].metadata.domain).toBe('charlie.example.test');
      expect(result.metadata.total_count).toBe(1);
    }
    expect((await list({ search: 'missing' })).entities).toEqual([]);
    expect((await list({ filters: [{ field: 'domain', op: 'eq', value: 'alpha-100%.example.test' }] })).entities.map(row => Number(row.id))).toEqual([c]);
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
  it('does not pull names from another workspace and matches all filters on the same member', async () => {
    const { human, ids: [a, b, c], link, list } = await graph();
    await human.entities.update({ entity_id: a, metadata: { category: 'member-only', main_market: 'member-only', market: 'member-only' } });
    await human.entities.update({ entity_id: b, parent_id: c, metadata: { category: 'root-only', main_market: 'root-only', market: 'root-only' } });
    await link(a, b);
    const other = await TestWorkspace.create({ name: 'Other root workspace' });
    await other.owner.entity_schema.createType({ slug: 'contact-record', name: 'Contact record' });
    await other.owner.entities.create({ entity_type: 'contact-record', name: 'Private foreign name' });
    expect((await list({ search: 'Private foreign name' })).entities).toEqual([]);
    expect((await human.entities.list({ search: 'Alpha' })).entities.map(row => Number(row.id))).toEqual([b]);
    expect((await list({ search: 'Alpha', parent_id: c })).metadata.total_count).toBe(0);
    expect((await list({ search: 'Alpha', parent_id: null })).metadata.total_count).toBe(1);
    expect((await list({ search: 'Alpha', segment: 'member_only' })).metadata.total_count).toBe(1);
    expect((await list({ search: 'Bravo', segment: 'member_only' })).metadata.total_count).toBe(0);
    for (const filter of ['category', 'main_market', 'market']) {
      expect((await list({ search: 'Alpha', filters: [{ field: filter, op: 'eq', value: 'root-only' }] })).metadata.total_count).toBe(0);
      expect((await list({ search: 'Alpha', filters: [{ field: filter, op: 'eq', value: 'member-only' }] })).entities.map(row => Number(row.id))).toEqual([b]);
      expect((await list({ search: 'Alpha', filters: [{ field: filter, op: 'eq', value: 'member-only' }] })).metadata.total_count).toBe(1);
    }
  });

  it('returns the exact record and current identity membership through joins and subtree splits', async () => {
    const { human, ids: [a, b, c], link, list } = await graph();
    expect((await human.entities.get({ entity_id: a })).entity.identity).toEqual({ root_id: a, member_ids: [a] });
    await link(a, b);
    const outer = await link(b, c);
    for (const id of [a, b, c]) {
      const result = await human.entities.get({ entity_id: id });
      expect(Number(result.entity.id)).toBe(id);
      expect(result.entity.identity).toEqual({ root_id: c, member_ids: [a, b, c] });
    }
    expect((await list()).entities[0].identity).toEqual({ root_id: c, member_ids: [a, b, c] });
    await human.entities.update({ entity_id: a, metadata: { category: 'exact-member' } });
    expect((await human.entities.get({ entity_id: a })).entity.metadata.category).toBe('exact-member');
    expect((await human.entities.get({ entity_id: c })).entity.metadata.category).toBeUndefined();
    await human.entities.unlink({ relationship_id: Number(outer.relationship.id) });
    expect((await human.entities.get({ entity_id: a })).entity.identity).toEqual({ root_id: b, member_ids: [a, b] });
    expect((await human.entities.get({ entity_id: c })).entity.identity).toEqual({ root_id: c, member_ids: [c] });
  });

  it('searches the best matching member once per group before applying the limit', async () => {
    const { human, ids: [a, b, c], link } = await graph();
    await human.entities.update({ entity_id: a, name: 'Needle' });
    await human.entities.update({ entity_id: b, name: 'Needle copy' });
    await human.entities.update({ entity_id: c, name: 'Needle separate' });
    const edge = await link(a, b);
    const result = await human.knowledge.search({ query: 'Needle', limit: 2 }) as UnifiedSearchResult;
    expect(result.matches.map(row => row.id)).toEqual([a, c]);
    expect(result.matches[0].identity).toEqual({ root_id: b, member_ids: [a, b] });
    await human.entities.unlink({ relationship_id: Number(edge.relationship.id) });
    expect((await human.knowledge.search({ query: 'Needle', limit: 3 }) as UnifiedSearchResult).matches).toHaveLength(3);
  });

  it('recalls group history and counts without widening source visibility or identity scope', async () => {
    const { workspace, human, ids: [a, b, c], link, list } = await graph();
    await createTestConnectorDefinition({ key: 'identity-read-fixture', name: 'Identity read fixture', organization_id: workspace.org.id });
    const privateConnection = await createTestConnection({
      organization_id: workspace.org.id, connector_key: 'identity-read-fixture',
      created_by: workspace.users.admin.id, visibility: 'private',
    });
    const failedConnection = await createTestConnection({
      organization_id: workspace.org.id, connector_key: 'identity-read-fixture', visibility: 'org',
    });
    await getTestDb()`INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
      VALUES (${workspace.org.id}, ${String(failedConnection.id)}, 'full', 'failed', NOW())`;
    const event = (entity_id: number, extra = {}) => createTestEvent({
      organization_id: workspace.org.id, entity_id, content: 'group history fixture', ...extra,
    });
    const direct = await event(a);
    const root = await event(c);
    const hidden = await event(b, { connection_id: privateConnection.id });
    const failedSource = await event(b, { connection_id: failedConnection.id });
    await getTestDb()`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key)
      VALUES (${workspace.org.id}, ${b}, 'email', 'group@example.test', 'source-a')`;
    const scoped = await event(b, { entity_ids: [], metadata: {
      email: 'group@example.test', [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { email: 'source-a' },
    } });
    const wrongScope = await event(b, { entity_ids: [], metadata: {
      email: 'group@example.test', [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { email: 'source-b' },
    } });
    const directAndScoped = await event(b, { metadata: {
      email: 'group@example.test', [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { email: 'source-a' },
    } });
    const hiddenScoped = await event(b, { entity_ids: [], connection_id: privateConnection.id, metadata: {
      email: 'group@example.test', [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { email: 'source-a' },
    } });
    await getTestDb()`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key)
      VALUES (${workspace.org.id}, ${c}, 'email', 'root@example.test', NULL)`;
    const rootScoped = await event(c, { entity_ids: [], metadata: { email: 'root@example.test' } });

    // Separate roots exercise multiple batched count arms, including an
    // edgeless direct-only root and scoped/unscoped identity claims.
    for (const sort_by of ['name', 'created_at', 'domain', 'total_content']) {
      const page = await list({ sort_by });
      for (const id of [a, b, c]) {
        const history = await human.knowledge.read({ entity_id: id, limit: 100 });
        expect(Number(page.entities.find(row => Number(row.id) === id)?.total_content)).toBe(history.content.length);
      }
    }
    await link(a, b);
    const outer = await link(b, c);
    const relevant = new Set([direct.id, root.id, hidden.id, failedSource.id, scoped.id, wrongScope.id, directAndScoped.id, hiddenScoped.id, rootScoped.id]);
    let visibleCount = 0;
    for (const id of [a, b, c]) {
      for (const query of [undefined, 'group history fixture']) {
        const history = await human.knowledge.read({ entity_id: id, query, limit: 100 }) as { content: Array<{ id: number }> };
        if (query === undefined) visibleCount = history.content.length;
        expect(new Set(history.content.map(row => Number(row.id)).filter(id => relevant.has(id))))
          .toEqual(new Set([direct.id, root.id, scoped.id, directAndScoped.id, rootScoped.id]));
      }
    }
    for (const sort_by of ['name', 'created_at', 'domain', 'total_content']) {
      expect(Number((await list({ sort_by })).entities[0].total_content)).toBe(visibleCount);
    }
    const searched = await human.knowledge.search({ query: 'Bravo' }) as UnifiedSearchResult;
    expect(searched.matches[0].stats.content_count).toBe(visibleCount);
    await human.entities.unlink({ relationship_id: Number(outer.relationship.id) });
    const split = await list();
    for (const id of [b, c]) {
      const history = await human.knowledge.read({ entity_id: id, limit: 100 }) as { content: Array<{ id: number }> };
      expect(Number(split.entities.find(row => Number(row.id) === id)?.total_content)).toBe(history.content.length);
      expect(history.content.map(row => Number(row.id))).not.toContain(id === c ? direct.id : root.id);
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
