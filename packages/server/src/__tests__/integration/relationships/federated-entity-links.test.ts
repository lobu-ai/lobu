import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { resolvePath } from '../../../tools/resolve_path';
import { querySqlImpl } from '../../../tools/admin/query_sql';
import { addUserToOrganization, createTestAgent, ownerToolContext } from '../../setup/test-fixtures';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { TestWorkspace } from '../../setup/test-mcp-client';
import * as entityReferences from '../../../utils/entity-reference';
import { ToolUserError } from '../../../utils/errors';

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

  it('normalizes a stored reference type consistently across get and list_links', async () => {
    const got = await ws.owner.entities.get({ entity_id: stored, entity_type: 'Curated_Item' });
    expect(got.entity.id).toBe(stored);
    await expect(ws.owner.entities.listLinks({ entity_id: stored, entity_type: 'Curated_Item' })).resolves.toMatchObject({ action: 'list_links' });
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
    await expect(resolvePath({ path: `/${ws.org.slug}/duplicate-key-items/same` }, {}, context))
      .rejects.toMatchObject({ httpStatus: 409, message: 'The declared record key is not unique' });
  });

  it.each([false, true])('round-trips verbatim keys without merging whitespace variants (external: %s)', async external => {
    const slug = external ? 'verbatim-external' : 'verbatim-internal';
    const connection = external ? 'verbatim-source' : undefined;
    if (external) {
      const profile = await createAuthProfile({ organizationId: ws.org.id, connectorKey: 'postgres', displayName: 'Verbatim fixture',
        profileKind: 'env', authData: { DATABASE_URL: process.env.DATABASE_URL! } });
      await getTestDb()`INSERT INTO connections(organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by)
        VALUES (${ws.org.id}, 'postgres', ${connection!}, 'Verbatim source', 'active', ${profile.id}, 'org', ${ws.users.owner.id})`;
    }
    await ws.owner.entity_schema.createType({ slug, name: 'Verbatim keys',
      backing: { sql: "SELECT * FROM (VALUES ('padded-key', 'Plain'), (' padded-key ', 'Spaces'), (E'\\tpadded-key\\n', 'Controls'), ('　padded-key ', 'Unicode'), (' ', 'Space only'), (repeat('x', 1025), 'Oversized ASCII'), (repeat('é', 513), 'Oversized UTF8')) AS items(id, name)", connection },
      metadata_schema: { type: 'object', 'x-lobu-record-key': 'id' } });
    const listed = await ws.owner.entities.list({ entity_type: slug });
    expect(listed.entities).toHaveLength(7);
    expect(listed.entities.filter(item => item.id === null).map(item => item.name).sort()).toEqual(['Oversized ASCII', 'Oversized UTF8']);
    for (const item of listed.entities.filter(item => item.id !== null)) {
      const got = await ws.owner.entities.get({ entity_id: String(item.id), entity_type: slug });
      expect(got.entity).toMatchObject({ id: item.id, name: item.name });
      const resolved = await resolvePath({ path: `/${ws.org.slug}/${slug}/${encodeURIComponent(String(item.id))}` }, {}, ownerToolContext(ws.org.id, ws.users.owner.id));
      expect(resolved.entity).toMatchObject({ id: item.id, name: item.name });
      const edge = await ws.owner.entities.link({ from_entity_id: stored, to_entity_id: String(item.id),
        to_entity_type: slug, relationship_type_slug: 'related-item' });
      try {
        const links = await ws.owner.entities.listLinks({ entity_id: String(item.id), entity_type: slug });
        expect(links.relationships).toMatchObject([{ id: edge.relationship.id, to_entity_id: item.id, to_entity_name: item.name }]);
      } finally {
        await ws.owner.entities.unlink({ relationship_id: Number(edge.relationship.id) });
      }
    }
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
      const result = await ws.owner.entities.link(address) as { relationship: { id: number; from_entity_id: number | string; to_entity_id: number | string; from_entity_name: string; to_entity_name: string } };
      expect(result.relationship).toMatchObject({ from_entity_id: from, to_entity_id: to });
      const listed = await ws.owner.entities.listLinks({ entity_id: from, ...(typeof from === 'string' ? { entity_type: type } : {}) }) as { relationships: { id: number }[] };
      expect(listed.relationships.map(r => Number(r.id))).toContain(Number(result.relationship.id));
      const outbound = await ws.owner.entities.listLinks({ entity_id: from, direction: 'outbound',
        ...(typeof from === 'string' ? { entity_type: type } : {}) });
      expect(outbound.relationships.map(r => Number(r.id))).toContain(Number(result.relationship.id));
      const inbound = await ws.owner.entities.listLinks({ entity_id: to, direction: 'inbound',
        ...(typeof to === 'string' ? { entity_type: type } : {}) });
      expect(inbound.relationships.map(r => Number(r.id))).toContain(Number(result.relationship.id));
      const updated = await ws.owner.entities.updateLink({ ...address, confidence: 0.75 });
      expect(updated.relationship).toMatchObject({ from_entity_name: result.relationship.from_entity_name, to_entity_name: result.relationship.to_entity_name });
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

  it.each(['deleted', 'key-removed', 'backing-removed', 'slug-reused'])('withholds obsolete source history after its type is %s', async state => {
    const slug = `history-${state}`;
    await ws.owner.entity_schema.createType({ slug, name: 'Historical source', backing: { sql: "SELECT 'historical-key' AS id" },
      metadata_schema: { type: 'object', 'x-lobu-record-key': 'id' } });
    const edge = await ws.owner.entities.link({ from_entity_id: stored, to_entity_id: 'historical-key', to_entity_type: slug, relationship_type_slug: 'related-item' });
    await ws.owner.entities.unlink({ relationship_id: Number(edge.relationship.id) });
    const peer = await ws.owner.entities.create({ entity_type: 'curated-item', name: `History peer ${state}` });
    const healthy = await ws.owner.entities.link({ from_entity_id: stored, to_entity_id: Number(peer.entity.id), relationship_type_slug: 'related-item' });
    await ws.owner.entities.unlink({ relationship_id: Number(healthy.relationship.id) });
    if (state === 'deleted' || state === 'slug-reused') {
      await ws.owner.entity_schema.manage({ schema_type: 'entity_type', action: 'delete', slug });
      await expect(ws.owner.entities.get({ entity_id: 'historical-key', entity_type: slug })).rejects.toMatchObject({ httpStatus: 404 });
      if (state === 'slug-reused') {
        await ws.owner.entity_schema.createType({ slug, name: 'Different source', backing: { sql: "SELECT 'historical-key' AS id" },
          metadata_schema: { type: 'object', 'x-lobu-record-key': 'id' } });
      }
    } else {
      await ws.owner.entity_schema.updateType({ slug, ...(state === 'key-removed' ? { metadata_schema: { type: 'object' } } : { backing: null, metadata_schema: { type: 'object' } }) });
    }
    const history = await ws.owner.entities.listLinks({ entity_id: stored, include_deleted: true });
    expect(history.relationships.map(row => Number(row.id))).toContain(Number(healthy.relationship.id));
    expect(history.relationships.map(row => Number(row.id))).not.toContain(Number(edge.relationship.id));
    expect(JSON.stringify(history)).not.toContain('historical-key');
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

  it.each([403, 404, 409].flatMap(endpointStatus => [true, false].flatMap(unavailableFirst =>
    [true, false].map(unavailableFrom => ({ endpointStatus, unavailableFirst, unavailableFrom })))))(
    'prioritizes endpoint status $endpointStatus over an outage (outage first: $unavailableFirst, from: $unavailableFrom)',
    async ({ endpointStatus, unavailableFirst, unavailableFrom }) => {
      const edge = await ws.owner.entities.link({ from_entity_id: '007', from_entity_type: type,
        to_entity_id: 'B', to_entity_type: type, relationship_type_slug: 'related-item' });
      const resolveReference = entityReferences.resolveEntityReference;
      let anchorReads = 0;
      let rejectAnchor!: (error: Error) => void;
      let rejectPeer!: (error: Error) => void;
      let started!: () => void;
      const bothStarted = new Promise<void>(resolve => { started = resolve; });
      const resolver = vi.spyOn(entityReferences, 'resolveEntityReference').mockImplementation((id, entityType, ctx, options) => {
        if ((entityType === type || typeof entityType === 'number') && (id === 'B' || (id === '007' && ++anchorReads > 1))) {
          return new Promise((_, reject) => {
            if (id === '007') rejectAnchor = reject;
            else rejectPeer = reject;
            if (rejectAnchor && rejectPeer) started();
          });
        }
        return resolveReference(id, entityType, ctx, options);
      });
      try {
        const listing = ws.member.entities.listLinks({ entity_id: '007', entity_type: type })
          .then(result => ({ result }), error => ({ error }));
        await bothStarted;
        const unavailable = new ToolUserError('Source unavailable', 500, 'UPSTREAM_5XX');
        const endpointError = new ToolUserError('Source record is hidden or has a conflicting key', endpointStatus);
        const rejectUnavailable = unavailableFrom ? rejectAnchor : rejectPeer;
        const rejectEndpoint = unavailableFrom ? rejectPeer : rejectAnchor;
        if (unavailableFirst) rejectUnavailable(unavailable);
        else rejectEndpoint(endpointError);
        await new Promise<void>(resolve => setImmediate(resolve));
        if (unavailableFirst) rejectEndpoint(endpointError);
        else rejectUnavailable(unavailable);
        const outcome = await listing;
        if (endpointStatus === 409) expect(outcome).toMatchObject({ error: { httpStatus: 409 } });
        else expect(outcome).toMatchObject({ result: { relationships: [], relationship_failures: [], counts_by_type: [] } });
        expect(anchorReads).toBe(2);
      } finally {
        resolver.mockRestore();
        await ws.owner.entities.unlink({ relationship_id: Number(edge.relationship.id) });
      }
    },
  );

});

describe('public source type identity across workspaces', () => {
  const recordKey = { type: 'object', 'x-lobu-record-key': 'id' };
  let reader: TestWorkspace;
  let stranger: TestWorkspace;
  let note: number;

  beforeAll(async () => {
    reader = await TestWorkspace.create({ name: 'Reader workspace' });
    stranger = await TestWorkspace.create({ name: 'Stranger workspace' });
    await reader.owner.entity_schema.createType({ slug: 'note', name: 'Note' });
    await reader.owner.entity_schema.createRelType({ slug: 'cites', name: 'Cites' });
    // The same slug as every catalog below, with different rows.
    await reader.owner.entity_schema.createType({ slug: 'catalog-item', name: 'Local namesake',
      backing: { sql: "SELECT 'k1' AS id, 'Local namesake' AS name" }, metadata_schema: recordKey });
    note = Number((await reader.owner.entities.create({ entity_type: 'note', name: 'Reader note' })).entity.id);
  });

  async function sourceConnection(owner: TestWorkspace, slug: string, visibility: 'org' | 'private', createdBy: string) {
    const profile = await createAuthProfile({ organizationId: owner.org.id, connectorKey: 'postgres', displayName: slug,
      profileKind: 'env', authData: { DATABASE_URL: process.env.DATABASE_URL! } });
    const [row] = await getTestDb()`INSERT INTO connections(organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by)
      VALUES (${owner.org.id}, 'postgres', ${slug}, ${slug}, 'active', ${profile.id}, ${visibility}, ${createdBy}) RETURNING id`;
    return Number(row.id);
  }

  async function catalog(label: string, backing: { sql?: string; connection?: string } = {}, existing?: TestWorkspace) {
    const owner = existing ?? await TestWorkspace.create({ name: label });
    await getTestDb()`UPDATE organization SET visibility = 'public' WHERE id = ${owner.org.id}`;
    await owner.owner.entity_schema.createType({ slug: 'catalog-item', name: `${label} items`, metadata_schema: recordKey,
      backing: { sql: backing.sql ?? `SELECT 'k1' AS id, '${label} K1' AS name`, ...(backing.connection ? { connection: backing.connection } : {}) } });
    const [row] = await getTestDb()`SELECT id FROM entity_types WHERE organization_id = ${owner.org.id} AND slug = 'catalog-item' AND deleted_at IS NULL`;
    return { owner, typeId: Number(row.id) };
  }

  const ids = (result: { relationships?: Array<{ id: number | string }> }) => (result.relationships ?? []).map(row => Number(row.id));

  it('addresses a public type by ID across colliding slugs and keeps the edge owned by its author', async () => {
    const a = await catalog('Catalog A');
    const b = await catalog('Catalog B');
    expect((await reader.member.entities.get({ entity_id: 'k1', entity_type: 'catalog-item' })).entity.name).toBe('Local namesake');
    const got = await reader.member.entities.get({ entity_id: 'k1', entity_type: a.typeId });
    expect(got.entity).toMatchObject({ id: 'k1', name: 'Catalog A K1', entity_type: 'catalog-item', entity_type_id: a.typeId });
    expect(got.entity.view_url).toContain(`/${a.owner.org.slug}/catalog-item/k1`);
    expect((await reader.member.entities.get({ entity_id: 'k1', entity_type: b.typeId })).entity.name).toBe('Catalog B K1');

    const linked = await reader.member.entities.link({ from_entity_id: note, to_entity_id: 'k1', to_entity_type: a.typeId, relationship_type_slug: 'cites' });
    const edge = Number(linked.relationship.id);
    try {
      const [row] = await getTestDb()`SELECT organization_id, to_entity_type_id, to_source_key FROM entity_relationships WHERE id = ${edge}`;
      expect(row).toMatchObject({ organization_id: reader.org.id, to_entity_type_id: a.typeId, to_source_key: 'k1' });
      const listed = await reader.owner.entities.listLinks({ entity_id: note });
      const shown = listed.relationships.find(item => Number(item.id) === edge);
      expect(shown).toMatchObject({ to_entity_name: 'Catalog A K1', to_entity_type_id: a.typeId });
      expect(shown?.to_entity_url).toContain(`/${a.owner.org.slug}/catalog-item/k1`);
      expect(shown?.from_entity_url).toBeUndefined();
      expect((await reader.owner.entities.updateLink({ relationship_id: edge, confidence: 0.8 })).relationship.confidence).toBe(0.8);
      expect(ids(await reader.owner.entities.listLinks({ entity_id: 'k1', entity_type: a.typeId }))).toContain(edge);
      expect(ids(await reader.owner.entities.listLinks({ entity_id: 'k1', entity_type: b.typeId }))).not.toContain(edge);
      expect(ids(await reader.owner.entities.listLinks({ entity_id: 'k1', entity_type: 'catalog-item' }))).not.toContain(edge);

      await expect(reader.owner.entities.get({ entity_id: note, entity_type: a.typeId })).rejects.toMatchObject({ httpStatus: 400 });
      await expect(reader.owner.entities.link({ from_entity_id: 'k1', from_entity_type: a.typeId, to_entity_id: note,
        relationship_type_slug: 'cites' })).rejects.toMatchObject({ httpStatus: 403 });

      const publisherView = await a.owner.owner.entities.listLinks({ entity_id: 'k1', entity_type: 'catalog-item' });
      expect(ids(publisherView)).not.toContain(edge);
      expect(publisherView.counts_by_type).toEqual([]);
      expect(JSON.stringify(publisherView)).not.toContain('Reader note');
      expect(ids(await stranger.owner.entities.listLinks({ entity_id: 'k1', entity_type: a.typeId }))).not.toContain(edge);
      const audits = await getTestDb()`SELECT organization_id, linked_org_ids FROM events WHERE metadata->>'relationshipId' = ${String(edge)}`;
      expect(audits.length).toBeGreaterThan(0);
      for (const audit of audits) {
        expect(audit.organization_id).toBe(reader.org.id);
        expect(audit.linked_org_ids ?? []).not.toContain(a.owner.org.id);
      }
      expect(await getTestDb()`SELECT 1 FROM entities WHERE entity_type_id = ${a.typeId}`).toHaveLength(0);
      const readerSql = await querySqlImpl({ sql: 'SELECT id FROM entity_relationships' }, {}, ownerToolContext(reader.org.id, reader.users.owner.id));
      expect(readerSql.rows?.map(item => Number(item.id))).not.toContain(edge);
      const publisherSql = await querySqlImpl({ sql: 'SELECT id FROM entity_relationships' }, {}, ownerToolContext(a.owner.org.id, a.owner.users.owner.id));
      expect(publisherSql.rows?.map(item => Number(item.id))).not.toContain(edge);
    } finally {
      await reader.owner.entities.unlink({ relationship_id: edge });
    }
  });

  it('answers a guessed or private type ID exactly like an unknown one', async () => {
    const hidden = await TestWorkspace.create({ name: 'Private catalog' });
    await hidden.owner.entity_schema.createType({ slug: 'catalog-item', name: 'Private items', metadata_schema: recordKey,
      backing: { sql: "SELECT 'k1' AS id, 'Private K1' AS name" } });
    const [row] = await getTestDb()`SELECT id FROM entity_types WHERE organization_id = ${hidden.org.id} AND slug = 'catalog-item'`;
    const [max] = await getTestDb()`SELECT max(id)::int AS id FROM entity_types`;
    for (const typeId of [Number(row.id), Number(max.id) + 1000]) {
      const notFound = { httpStatus: 404, message: 'Entity type not found or not readable' };
      await expect(reader.owner.entities.get({ entity_id: 'k1', entity_type: typeId })).rejects.toMatchObject(notFound);
      await expect(reader.owner.entities.listLinks({ entity_id: 'k1', entity_type: typeId })).rejects.toMatchObject(notFound);
      await expect(reader.owner.entities.link({ from_entity_id: note, to_entity_id: 'k1', to_entity_type: typeId,
        relationship_type_slug: 'cites' })).rejects.toMatchObject(notFound);
    }
  });

  it('reads a public source as a stranger, never with a workspace role, private connection or paired device', async () => {
    const publisher = await TestWorkspace.create({ name: 'Credentialed catalog' });
    const publisherUser = publisher.users.owner.id;
    // The publisher's owner also belongs to the reader workspace and acts from there.
    await addUserToOrganization(publisherUser, reader.org.id, 'member');
    const actor = reader.withAuth({ userId: publisherUser, memberRole: 'member' });
    await sourceConnection(publisher, 'private-source', 'private', publisherUser);
    const privateType = await catalog('Private source', { connection: 'private-source' }, publisher);
    expect((await publisher.owner.entities.get({ entity_id: 'k1', entity_type: 'catalog-item' })).entity.name).toBe('Private source K1');
    await expect(actor.entities.get({ entity_id: 'k1', entity_type: privateType.typeId })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(actor.entities.link({ from_entity_id: note, to_entity_id: 'k1', to_entity_type: privateType.typeId,
      relationship_type_slug: 'cites' })).rejects.toMatchObject({ httpStatus: 404 });

    const shared = await TestWorkspace.create({ name: 'Shared catalog' });
    const connection = await sourceConnection(shared, 'shared-source', 'org', shared.users.owner.id);
    const sharedType = await catalog('Shared source', { connection: 'shared-source' }, shared);
    expect((await actor.entities.get({ entity_id: 'k1', entity_type: sharedType.typeId })).entity.name).toBe('Shared source K1');
    const [device] = await getTestDb()`INSERT INTO device_workers (user_id, worker_id, platform, capabilities, connector_manifests, label, organization_id, last_seen_at)
      VALUES (${shared.users.owner.id}, 'federated-device-fixture', 'darwin', '[]'::jsonb, '{}'::jsonb, 'Synthetic device', ${shared.org.id}, NOW()) RETURNING id`;
    await getTestDb()`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${connection}`;
    expect((await shared.owner.entities.get({ entity_id: 'k1', entity_type: 'catalog-item' })).entity.name).toBe('Shared source K1');
    await expect(actor.entities.get({ entity_id: 'k1', entity_type: sharedType.typeId })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(reader.owner.entities.link({ from_entity_id: note, to_entity_id: 'k1', to_entity_type: sharedType.typeId,
      relationship_type_slug: 'cites' })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('lists only the caller workspace edges on a public stored record and withholds them once it turns private', async () => {
    const publisher = await catalog('Turns private');
    const org = publisher.owner;
    await org.owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    await org.owner.entity_schema.createRelType({ slug: 'cites', name: 'Cites' });
    const acme = Number((await org.owner.entities.create({ entity_type: 'company', name: 'Acme' })).entity.id);
    const peer = Number((await org.owner.entities.create({ entity_type: 'company', name: 'Peer' })).entity.id);
    const own = Number((await org.owner.entities.link({ from_entity_id: peer, to_entity_id: acme, relationship_type_slug: 'cites' })).relationship.id);
    const stored = Number((await reader.member.entities.link({ from_entity_id: note, to_entity_id: acme, relationship_type_slug: 'cites' })).relationship.id);
    const source = Number((await reader.member.entities.link({ from_entity_id: note, to_entity_id: 'k1', to_entity_type: publisher.typeId,
      relationship_type_slug: 'cites' })).relationship.id);
    try {
      const got = await reader.member.entities.get({ entity_id: acme });
      expect(got.entity.view_url).toContain(`/${org.org.slug}/company/acme`);
      expect(got.entity.entity_type_id).toEqual(expect.any(Number));
      const anchored = await reader.member.entities.listLinks({ entity_id: acme });
      expect(ids(anchored)).toEqual([stored]);
      expect(anchored.counts_by_type).toEqual([expect.objectContaining({ count: 1 })]);
      const fromNote = await reader.member.entities.listLinks({ entity_id: note });
      expect(fromNote.relationships.find(item => Number(item.id) === stored)?.to_entity_url).toContain(`/${org.org.slug}/company/acme`);
      expect(ids(await org.owner.entities.listLinks({ entity_id: acme }))).toEqual([own]);
      expect(ids(await stranger.owner.entities.listLinks({ entity_id: acme }))).toEqual([]);

      await getTestDb()`UPDATE organization SET visibility = 'private' WHERE id = ${org.org.id}`;
      const hiddenNow = await reader.member.entities.listLinks({ entity_id: note });
      expect(ids(hiddenNow)).not.toContain(stored);
      expect(ids(hiddenNow)).not.toContain(source);
      expect(hiddenNow.relationship_failures).toEqual([]);
      await expect(reader.member.entities.listLinks({ entity_id: acme })).rejects.toMatchObject({ httpStatus: 404 });
      await expect(reader.member.entities.get({ entity_id: 'k1', entity_type: publisher.typeId })).rejects.toMatchObject({ httpStatus: 404 });
      await expect(reader.member.entities.listLinks({ entity_id: 'k1', entity_type: publisher.typeId })).rejects.toMatchObject({ httpStatus: 404 });
    } finally {
      await reader.owner.entities.unlink({ relationship_id: stored });
      await reader.owner.entities.unlink({ relationship_id: source });
    }
  });

  it('lets a publisher retire or rewrite a cited source, but never re-key it in place', async () => {
    const publisher = await catalog('Lifecycle');
    const org = publisher.owner;
    await org.owner.entity_schema.createRelType({ slug: 'mentions', name: 'Mentions' });
    const edge = Number((await reader.owner.entities.link({ from_entity_id: note, to_entity_id: 'k1', to_entity_type: publisher.typeId,
      relationship_type_slug: 'mentions' })).relationship.id);
    const [mentions] = await getTestDb()`SELECT id FROM entity_relationship_types WHERE organization_id = ${org.org.id} AND slug = 'mentions'`;
    await expect(getTestDb()`UPDATE entity_relationship_types SET purpose = 'authorization' WHERE id = ${mentions.id}`)
      .rejects.toThrow(/other workspaces use this relationship type/);

    await org.owner.entity_schema.updateType({ slug: 'catalog-item', backing: { sql: "SELECT 'k1' AS id, 'Rewritten K1' AS name" } });
    expect((await reader.owner.entities.listLinks({ entity_id: note })).relationships
      .find(item => Number(item.id) === edge)?.to_entity_name).toBe('Rewritten K1');
    const rekey = org.owner.entity_schema.updateType({ slug: 'catalog-item', metadata_schema: { type: 'object', 'x-lobu-record-key': 'name' } });
    await expect(rekey).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/delete this type and create a new one/) });
    await expect(rekey).rejects.not.toMatchObject({ message: expect.stringContaining(String(edge)) });

    await org.owner.entity_schema.createType({ slug: 'review', name: 'Review' });
    const review = Number((await org.owner.entities.create({ entity_type: 'review', name: 'Own review' })).entity.id);
    const own = Number((await org.owner.entities.link({ from_entity_id: review, to_entity_id: 'k1', to_entity_type: 'catalog-item',
      relationship_type_slug: 'mentions' })).relationship.id);
    const blocked = org.owner.entity_schema.updateType({ slug: 'catalog-item', backing: { sql: "SELECT 'k1' AS id" } });
    await expect(blocked).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining(String(own)) });
    await expect(blocked).rejects.not.toMatchObject({ message: expect.stringContaining(String(edge)) });
    await org.owner.entities.unlink({ relationship_id: own });

    await org.owner.entity_schema.manage({ schema_type: 'entity_type', action: 'delete', slug: 'catalog-item' });
    const replacement = await catalog('Lifecycle', { sql: "SELECT 'k1' AS id, 'Replacement K1' AS name" }, org);
    expect(replacement.typeId).not.toBe(publisher.typeId);
    await expect(reader.owner.entities.get({ entity_id: 'k1', entity_type: publisher.typeId })).rejects.toMatchObject({ httpStatus: 404 });
    const after = await reader.owner.entities.listLinks({ entity_id: note });
    expect(ids(after)).not.toContain(edge);
    expect(JSON.stringify(after)).not.toContain('Replacement K1');
    const [retained] = await getTestDb()`SELECT to_entity_type_id, deleted_at FROM entity_relationships WHERE id = ${edge}`;
    expect(retained).toMatchObject({ to_entity_type_id: publisher.typeId, deleted_at: null });
    await reader.owner.entities.unlink({ relationship_id: edge });
  });

  it('reports a public source outage by relationship ID only and still allows unlink', async () => {
    const shared = await TestWorkspace.create({ name: 'Outage catalog' });
    await getTestDb()`CREATE VIEW public_catalog_outage_fixture AS SELECT 'outage-key'::text AS id, 'Outage item'::text AS name`;
    await sourceConnection(shared, 'outage-catalog-source', 'org', shared.users.owner.id);
    const publisher = await catalog('Outage', { sql: 'SELECT * FROM public_catalog_outage_fixture', connection: 'outage-catalog-source' }, shared);
    const edge = Number((await reader.owner.entities.link({ from_entity_id: note, to_entity_id: 'outage-key', to_entity_type: publisher.typeId,
      relationship_type_slug: 'cites' })).relationship.id);
    await getTestDb()`DROP VIEW public_catalog_outage_fixture`;
    const listed = await reader.owner.entities.listLinks({ entity_id: note });
    expect(listed.relationship_failures).toEqual([{ relationship_id: edge, code: 'UPSTREAM_5XX' }]);
    expect(JSON.stringify(listed)).not.toContain('outage-key');
    await expect(reader.owner.entities.updateLink({ relationship_id: edge, confidence: 0.5 })).rejects.toMatchObject({ code: 'UPSTREAM_5XX' });
    await reader.owner.entities.unlink({ relationship_id: edge });
    expect(ids(await reader.owner.entities.listLinks({ entity_id: note, include_deleted: true }))).not.toContain(edge);
  });

  it('keeps a bound agent in its workspace and applies its read denials to foreign type IDs', async () => {
    const publisher = await catalog('Agent catalog');
    const principal = await createTestAgent({ organizationId: reader.org.id, ownerUserId: reader.users.owner.id });
    const agent = reader.withAuth({ agentId: principal.agentId });
    expect((await agent.entities.get({ entity_id: 'k1', entity_type: publisher.typeId })).entity.name).toBe('Agent catalog K1');
    const edge = Number((await agent.entities.link({ from_entity_id: note, to_entity_id: 'k1', to_entity_type: publisher.typeId,
      relationship_type_slug: 'cites' })).relationship.id);
    const [row] = await getTestDb()`SELECT organization_id FROM entity_relationships WHERE id = ${edge}`;
    expect(row.organization_id).toBe(reader.org.id);
    await upsertEntityApprovalPolicy(reader.org.id, { principalKind: 'agent', principalId: principal.agentId,
      entityTypeSlug: 'catalog-item', effects: { read: 'deny' } });
    await expect(agent.entities.get({ entity_id: 'k1', entity_type: publisher.typeId })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(agent.entities.listLinks({ entity_id: 'k1', entity_type: publisher.typeId })).rejects.toMatchObject({ httpStatus: 403 });
    expect(ids(await agent.entities.listLinks({ entity_id: note }))).not.toContain(edge);
    await reader.owner.entities.unlink({ relationship_id: edge });
  });
});
