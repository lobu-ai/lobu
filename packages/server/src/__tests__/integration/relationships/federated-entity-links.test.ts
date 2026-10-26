import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { resolvePath } from '../../../tools/resolve_path';
import { querySqlImpl } from '../../../tools/admin/query_sql';
import { ownerToolContext } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

describe('typed references and authored source relationships', () => {
  let ws: TestWorkspace;
  let stored: number;
  const type = 'source-items';
  const sourceSql = `SELECT * FROM (VALUES ('A:1/path', 'Source A'), ('007', 'Source Seven'), ('B', 'Source B')) AS items(id, name)`;
  beforeAll(async () => {
    await cleanupTestDatabase();
    ws = await TestWorkspace.create({ name: 'Federated Link Test' });
    await ws.owner.entity_schema.createType({ slug: 'curated-item', name: 'Curated item' });
    await ws.owner.entity_schema.manage({ schema_type: 'entity_type', action: 'create', slug: type, name: 'Source items',
      backing: { sql: sourceSql }, metadata_schema: { type: 'object', 'x-lobu-record-key': 'id' } });
    await ws.owner.entity_schema.createRelType({ slug: 'related-item', name: 'Related item' });
    await ws.owner.entity_schema.manage({ schema_type: 'relationship_type', action: 'create', slug: 'peer-item', name: 'Peer item', is_symmetric: true });
    const created = await ws.owner.entities.create({ entity_type: 'curated-item', name: 'Local item' }) as { entity: { id: number } };
    stored = created.entity.id;
  });

  it('gets verbatim keys, requires their type, and never writes through to sources', async () => {
    const got = await ws.owner.entities.get({ entity_id: '007', entity_type: type }) as { entity: { id: string; name: string } };
    expect(got.entity).toMatchObject({ id: '007', name: 'Source Seven' });
    await expect(ws.owner.entities.get({ entity_id: '007' })).rejects.toThrow(/requires entity_type/);
    await expect(ws.owner.entities.get({ entity_id: 'a:1/path', entity_type: type })).rejects.toThrow(/not found/);
    await expect(ws.owner.entities.update({ entity_id: '007', entity_type: type, name: 'No copy' })).rejects.toThrow(/read.only/i);
  });

  it('uses only the declared key across list, get and path resolution, and rejects duplicate keys', async () => {
    await ws.owner.entity_schema.createType({ slug: 'custom-key-items', name: 'Custom key items',
      backing: { sql: "SELECT '007' AS catalog_key, 'unstable-id' AS id, 'unstable-slug' AS slug, 'Stable item' AS name" },
      metadata_schema: { type: 'object', 'x-lobu-record-key': 'catalog_key' } });
    const listed = await ws.owner.entities.list({ entity_type: 'custom-key-items' });
    expect(listed.entities[0]).toMatchObject({ id: '007', slug: '007' });
    const context = ownerToolContext(ws.org.id, ws.users.owner.id);
    const resolved = await resolvePath({ path: `/${ws.org.slug}/custom-key-items/007` }, {}, context);
    expect(resolved.entity).toMatchObject({ id: '007', slug: '007', is_derived: true });
    await expect(ws.owner.entities.get({ entity_id: 'unstable-id', entity_type: 'custom-key-items' })).rejects.toThrow(/not found/);
    await ws.owner.entity_schema.createType({ slug: 'duplicate-key-items', name: 'Duplicate key items',
      backing: { sql: "SELECT 'same' AS id, 'One' AS name UNION ALL SELECT 'same' AS id, 'Two' AS name" },
      metadata_schema: { type: 'object', 'x-lobu-record-key': 'id' } });
    await expect(ws.owner.entities.get({ entity_id: 'same', entity_type: 'duplicate-key-items' })).rejects.toThrow(/not unique/);
  });

  it('paginates source edges by stable cursor and binds it to the exact request', async () => {
    const edges = [];
    for (const key of ['A:1/path', 'B']) {
      const result = await ws.owner.entities.link({ from_entity_id: '007', from_entity_type: type,
        to_entity_id: key, to_entity_type: type, relationship_type_slug: 'related-item' });
      edges.push(Number(result.relationship.id));
    }
    try {
      const first = await ws.owner.entities.listLinks({ entity_id: '007', entity_type: type, limit: 1 });
      expect(first.relationships).toHaveLength(1);
      expect(first.next_cursor).toBeTruthy();
      const next = await ws.owner.entities.listLinks({ entity_id: '007', entity_type: type, limit: 1, cursor: first.next_cursor });
      expect(next.relationships).toHaveLength(1);
      expect(new Set([...first.relationships, ...next.relationships].map(r => Number(r.id)))).toEqual(new Set(edges));
      await expect(ws.owner.entities.listLinks({ entity_id: 'B', entity_type: type, cursor: first.next_cursor })).rejects.toThrow(/does not match/);
      await expect(ws.owner.entities.listLinks({ entity_id: '007', entity_type: type,
        cursor: Buffer.from('null').toString('base64url') })).rejects.toThrow(/Invalid relationship cursor/);
    } finally {
      for (const relationship_id of edges) await ws.owner.entities.unlink({ relationship_id });
    }
  });

  it('authors, reads, edits and unlinks all four pairs without source rows in PG', async () => {
    const local = await ws.owner.entities.create({ entity_type: 'curated-item', name: 'Second local' }) as { entity: { id: number } };
    for (const [from, to] of [[stored, local.entity.id], [stored, '007'], ['007', stored], ['007', 'B']] as const) {
      const address = { from_entity_id: from, to_entity_id: to, relationship_type_slug: 'related-item',
        ...(typeof from === 'string' ? { from_entity_type: type } : {}), ...(typeof to === 'string' ? { to_entity_type: type } : {}) };
      const result = await ws.owner.entities.link(address) as { relationship: { id: number; from_entity_id: number | string; to_entity_id: number | string } };
      expect(result.relationship).toMatchObject({ from_entity_id: from, to_entity_id: to });
      const listed = await ws.owner.entities.listLinks({ entity_id: from, ...(typeof from === 'string' ? { entity_type: type } : {}) }) as { relationships: { id: number }[] };
      expect(listed.relationships.map(r => Number(r.id))).toContain(Number(result.relationship.id));
      await ws.owner.entities.updateLink({ ...address, confidence: 0.75 });
      await ws.owner.entities.unlink(address);
      const rows = await getTestDb()`SELECT deleted_at FROM entity_relationships WHERE id = ${result.relationship.id}`;
      expect(rows[0].deleted_at).not.toBeNull();
    }
    expect(await getTestDb()`SELECT e.id FROM entities e JOIN entity_types et ON et.id = e.entity_type_id
      WHERE et.organization_id = ${ws.org.id} AND et.slug = ${type}`).toHaveLength(0);
  });

  it('deduplicates retries, races and symmetric reversal', async () => {
    const address = { from_entity_id: 'A:1/path', from_entity_type: type, to_entity_id: 'B', to_entity_type: type, relationship_type_slug: 'peer-item' };
    const results = await Promise.allSettled([ws.owner.entities.link(address), ws.owner.entities.link(address)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(ws.owner.entities.link({ ...address, from_entity_id: 'B', to_entity_id: 'A:1/path' })).rejects.toThrow(/already exists/);
    await ws.owner.entities.unlink({ ...address, from_entity_id: 'B', to_entity_id: 'A:1/path' });
  });

  it('guards source contracts and immutable endpoints without copying keys into audit events', async () => {
    const linked = await ws.owner.entities.link({ from_entity_id: stored, to_entity_id: 'A:1/path', to_entity_type: type, relationship_type_slug: 'related-item' }) as { relationship: { id: number } };
    await expect(ws.owner.entity_schema.updateType({ slug: type, backing: { sql: "SELECT 'different' AS id" } })).rejects.toThrow(/live relationships/);
    await expect(getTestDb()`UPDATE entity_relationships SET to_entity_id = ${stored}, to_entity_type_id = NULL, to_source_key = NULL WHERE id = ${linked.relationship.id}`).rejects.toThrow(/immutable/);
    const events = await getTestDb()`SELECT metadata, entity_ids FROM events WHERE organization_id = ${ws.org.id} AND metadata->>'relationshipId' = ${String(linked.relationship.id)}`;
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('A:1/path');
    await ws.owner.entities.unlink({ relationship_id: linked.relationship.id });
    await ws.owner.entity_schema.updateType({ slug: type, backing: { sql: sourceSql } });
  });

  it('rejects identity source edges even through SQL', async () => {
    const [t] = await getTestDb()`SELECT id FROM entity_types WHERE organization_id = ${ws.org.id} AND slug = ${type}`;
    await ws.owner.entity_schema.manage({ schema_type: 'relationship_type', action: 'create', slug: 'same-item', name: 'Same item', purpose: 'identity' });
    const [rt] = await getTestDb()`SELECT id FROM entity_relationship_types WHERE organization_id = ${ws.org.id} AND slug = 'same-item'`;
    await expect(getTestDb().begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(lobu_identity_lock_key(${ws.org.id}::text))`;
      await tx`SELECT set_config('lobu.identity_write', 'on', true)`;
      await tx`INSERT INTO entity_relationships(organization_id, from_entity_id, to_entity_type_id, to_source_key, relationship_type_id)
        VALUES (${ws.org.id}, ${stored}, ${t.id}, '007', ${rt.id})`;
    })).rejects.toThrow();
  });
  it('withholds private source keys and counts from other members and raw SQL', async () => {
    const profile = await createAuthProfile({ organizationId: ws.org.id, connectorKey: 'postgres', displayName: 'Private fixture', profileKind: 'env', authData: { DATABASE_URL: process.env.DATABASE_URL! } });
    await getTestDb()`INSERT INTO connections(organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by)
      VALUES (${ws.org.id}, 'postgres', 'private-source', 'Private source', 'active', ${profile.id}, 'private', ${ws.users.owner.id})`;
    await ws.owner.entity_schema.createType({ slug: 'private-items', name: 'Private items', backing: { sql: "SELECT 'secret-key' AS id, 'Secret item' AS name", connection: 'private-source' }, metadata_schema: { type: 'object', 'x-lobu-record-key': 'id' } });
    const edge = await ws.owner.entities.link({ from_entity_id: stored, to_entity_id: 'secret-key', to_entity_type: 'private-items', relationship_type_slug: 'related-item' });
    const other = await ws.member.entities.listLinks({ entity_id: stored });
    expect(JSON.stringify(other)).not.toContain('secret-key');
    expect(other.relationships).toHaveLength(0);
    expect(other.counts_by_type).toEqual([]);
    expect(other.relationship_failures).toEqual([]);
    const query = await querySqlImpl({ sql: 'SELECT id FROM entity_relationships' }, {}, ownerToolContext(ws.org.id, ws.users.owner.id));
    expect(query.rows?.map(row => Number(row.id))).not.toContain(Number(edge.relationship.id));
    await ws.owner.entities.unlink({ relationship_id: Number(edge.relationship.id) });
  });
  it('reports a source failure explicitly while allowing unlink without reading the source', async () => {
    const sql = getTestDb();
    await sql`CREATE VIEW federated_outage_fixture AS SELECT 'outage-key'::text AS id, 'Outage item'::text AS name`;
    const profile = await createAuthProfile({ organizationId: ws.org.id, connectorKey: 'postgres', displayName: 'Outage fixture', profileKind: 'env', authData: { DATABASE_URL: process.env.DATABASE_URL! } });
    await sql`INSERT INTO connections(organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by)
      VALUES (${ws.org.id}, 'postgres', 'outage-source', 'Outage source', 'active', ${profile.id}, 'org', ${ws.users.owner.id})`;
    await ws.owner.entity_schema.createType({ slug: 'outage-items', name: 'Outage items',
      backing: { sql: 'SELECT * FROM federated_outage_fixture', connection: 'outage-source' },
      metadata_schema: { type: 'object', 'x-lobu-record-key': 'id' } });
    const edge = await ws.owner.entities.link({ from_entity_id: stored, to_entity_id: 'outage-key', to_entity_type: 'outage-items', relationship_type_slug: 'related-item' });
    const peer = await ws.owner.entities.create({ entity_type: 'curated-item', name: 'Healthy peer' });
    const healthy = await ws.owner.entities.link({ from_entity_id: stored, to_entity_id: Number(peer.entity.id), relationship_type_slug: 'related-item' });
    await sql`DROP VIEW federated_outage_fixture`;
    const listed = await ws.owner.entities.listLinks({ entity_id: stored });
    expect(listed.relationships.map(r => Number(r.id))).toContain(Number(healthy.relationship.id));
    expect(listed.relationship_failures).toEqual([{ relationship_id: Number(edge.relationship.id), code: 'UPSTREAM_5XX' }]);
    expect(JSON.stringify(listed)).not.toContain('outage-key');
    await expect(ws.owner.entity_schema.updateType({ slug: 'outage-items', backing: { sql: "SELECT 'replacement' AS id" } }))
      .rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining(String(edge.relationship.id)) });
    await expect(ws.owner.entities.updateLink({ relationship_id: Number(edge.relationship.id), confidence: 0.5 })).rejects.toMatchObject({ code: 'UPSTREAM_5XX', httpStatus: 500 });
    await ws.owner.entities.unlink({ relationship_id: Number(edge.relationship.id) });
    await ws.owner.entity_schema.updateType({ slug: 'outage-items', backing: { sql: "SELECT 'replacement' AS id" } });
    await ws.owner.entities.unlink({ relationship_id: Number(healthy.relationship.id) });
  });

});
