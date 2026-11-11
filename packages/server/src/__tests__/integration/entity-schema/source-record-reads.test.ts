/**
 * Activity and Relationships of a source-backed record are read live from the
 * read feeds whose event kinds attribute to its type, filtered by the
 * attribution's own identity path. Nothing is written.
 */

import { createServer, type Server } from 'node:http';
import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { buildEntitiesNamespace } from '../../../sandbox/namespaces/entities';
import { manageEntity } from '../../../tools/admin/manage_entity';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { compileConnectorSource, extractConnectorMetadata } from '../../../utils/connector-compiler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';

const CONNECTOR_KEY = 'record_source_test';

// Event-shaped rows, newest first. The connector filters them by ctx.match and
// pages with a keyset cursor (the last returned origin_id), as a warehouse
// connector would in SQL.
const SOURCE = `
  import { defineConnector, SourceWithheldError } from '@lobu/connector-sdk';
  const ROWS = [
    { origin_id: 'w3', origin_type: 'role', occurred_at: '2026-02-03T00:00:00.000Z',
      metadata: { company_id: ' padded-company ', person_id: ' padded-person ' } },
    { origin_id: 'w2', origin_type: 'role', occurred_at: '2026-02-02T00:00:00.000Z',
      metadata: { company_id: ' padded-company ', person_id: 'padded-person' } },
    { origin_id: 'w1', origin_type: 'role', occurred_at: '2026-02-01T00:00:00.000Z',
      metadata: { company_id: 'plain-company', person_id: ' padded-person ' } },
    { origin_id: 'e4', origin_type: 'role', title: 'Pat joined Acme', occurred_at: '2026-01-04T00:00:00.000Z',
      semantic_type: 'summary', payload_type: 'json_template', payload_data: { summary: 'Role summary' },
      payload_template: { type: 'div', children: '{{summary}}' },
      attachments: [{ url: 'https://example.test/role.pdf', mime_type: 'application/pdf' }],
      metadata: { person_id: 'p1', person_name: 'Pat', company_id: 'c1', company_name: 'Acme' } },
    { origin_id: 'e3', origin_type: 'call', title: 'Globex call', occurred_at: '2026-01-03T00:00:00.000Z',
      metadata: { company_id: 'c2' } },
    { origin_id: 'e2', origin_type: 'call', title: 'Acme renewal call', occurred_at: '2026-01-02T00:00:00.000Z',
      metadata: { company_id: 'c1' } },
    { origin_id: 'e1', origin_type: 'call', title: 'Acme intro call', occurred_at: '2026-01-01T00:00:00.000Z',
      metadata: { company_id: 'c1' } },
  ];
  const at = (row, path) => path.split('.').reduce((v, k) => v == null ? v : v[k], row);
  const company = { name: 'company', role: 'about', target: { entityType: 'company', titlePath: 'metadata.company_name',
    identities: [{ namespace: 'test_company', eventPath: 'metadata.company_id' }] } };
  const person = { name: 'person', role: 'about', target: { entityType: 'person', titlePath: 'metadata.person_name',
    identities: [{ namespace: 'test_person', eventPath: 'metadata.person_id' }] } };
  export default defineConnector({
    key: '${CONNECTOR_KEY}',
    name: 'Record source',
    version: '1.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      timeline: {
        key: 'timeline',
        name: 'Timeline',
        matchPaths: ['metadata.company_id', 'metadata.person_id'],
        eventKinds: {
          call: { attributions: [company] },
          role: { attributions: [person, company], relationships: [{ type: 'works_at', from: 'person', to: 'company' }] },
        },
        read: async (ctx) => {
          const key = ctx.match?.values[0];
          if (key === 'private-sdk') throw new SourceWithheldError('Communication details are private');
          // A connector on an older SDK opts in by the structural code alone.
          if (key === 'private-plain') throw Object.assign(new Error('Communication details are private'), { code: 'withheld' });
          if (key === 'unavailable') throw new Error('Source unavailable');
          const matched = ROWS.filter((row) => !ctx.match || ctx.match.values.includes(String(at(row, ctx.match.path))));
          const remaining = matched.filter((row) => !ctx.cursor || row.origin_id < ctx.cursor);
          const page = remaining.slice(0, ctx.limit ?? 50);
          const more = page.length < remaining.length;
          return { rows: page, rowCursors: page.map((row) => row.origin_id), ...(more ? { nextCursor: page[page.length - 1].origin_id } : {}) };
        },
      },
    },
  });
`;

// One feed whose rows live behind an upstream HTTP source. Many feed rows of it
// on one connection reproduce a record page's per-connection read fan-out; the
// upstream reports failures by numeric status (HttpStatusError), the shape a
// gateway-backed connector preserves.
const BURST_KEY = 'record_burst_test';
const BURST_SOURCE = `
  import { defineConnector, HttpStatusError } from '@lobu/connector-sdk';
  const account = { name: 'account', role: 'about', target: { entityType: 'account',
    identities: [{ namespace: 'test_account', eventPath: 'metadata.account_id' }] } };
  const contact = { name: 'contact', role: 'about', target: { entityType: 'person', titlePath: 'metadata.contact_name',
    identities: [{ namespace: 'test_person', eventPath: 'metadata.contact_id' }] } };
  export default defineConnector({
    key: '${BURST_KEY}',
    name: 'Record burst',
    version: '1.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      burst: {
        key: 'burst',
        name: 'Burst',
        matchPaths: ['metadata.account_id'],
        eventKinds: {
          touch: { attributions: [account, contact], relationships: [{ type: 'touches', from: 'account', to: 'contact' }] },
        },
        read: async (ctx) => {
          const key = ctx.match?.values[0];
          const url = ctx.config.base_url + '/read?feed=' + ctx.feedId + '&key=' + encodeURIComponent(key);
          const res = await fetch(url);
          if (!res.ok) {
            const error = new HttpStatusError({ prefix: 'Burst source', method: 'GET', url, status: res.status, statusText: res.statusText, bodyText: '' });
            // A deliberate refusal stays withheld even when it carries a transient status.
            throw key === 'private' ? Object.assign(error, { code: 'withheld' }) : error;
          }
          const rows = await res.json();
          return { rows, rowCursors: rows.map((row) => row.origin_id) };
        },
      },
    },
  });
`;

/** More streams than a page may read at once against one connection. */
const BURST_FEEDS = 12;
const READS_PER_CONNECTION = 4;

describe('source-backed record reads', () => {
  let orgId: string;
  let owner: ToolContext;
  let member: ToolContext;
  let privateConnectionId: number;
  let feedId: number;
  let ownerUserId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'SourceRecordReads' });
    orgId = org.id;
    const user = await createTestUser({ email: 'source-record-reads@test.com' });
    await addUserToOrganization(user.id, orgId, 'owner');
    owner = ownerToolContext(orgId, user.id);
    ownerUserId = user.id;
    const memberUser = await createTestUser({ email: 'source-record-member@test.com' });
    await addUserToOrganization(memberUser.id, orgId, 'member');
    member = { ...owner, userId: memberUser.id, memberRole: 'member' };

    const compiled = await compileConnectorSource(SOURCE);
    const metadata = await extractConnectorMetadata(compiled.compiledCode);
    const sql = getTestDb();
    await sql`
      INSERT INTO connector_definitions
        (key, name, version, feeds_schema, auth_schema, organization_id, status, created_at, updated_at)
      VALUES (${CONNECTOR_KEY}, 'Record source', '1.0.0', ${sql.json(metadata.feeds as object)},
        ${sql.json({ methods: [{ type: 'none' }] })}, ${orgId}, 'active', NOW(), NOW())
    `;
    await sql`
      INSERT INTO connector_versions
        (organization_id, connector_key, version, compiled_code, compiled_code_hash, compile_config_hash, source_code, created_at)
      VALUES (${orgId}, ${CONNECTOR_KEY}, '1.0.0', ${compiled.compiledCode}, ${compiled.compiledCodeHash},
        ${COMPILE_CONFIG_HASH}, ${SOURCE}, NOW())
    `;
    const [connection] = await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by, created_at, updated_at)
      VALUES (${orgId}, ${CONNECTOR_KEY}, 'record-source', 'Record source', 'active', 'private', ${user.id}, NOW(), NOW())
      RETURNING id
    `;
    privateConnectionId = Number(connection.id);
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, config, created_at, updated_at)
      VALUES (${orgId}, ${privateConnectionId}, 'timeline', 'Timeline', 'active', ${sql.json({})}, NOW(), NOW())
      RETURNING id
    `;
    feedId = Number(feed.id);
    for (const slug of ['company', 'person']) {
      await sql`
        INSERT INTO entity_types (organization_id, slug, name, backing_sql, created_at, updated_at)
        VALUES (${orgId}, ${slug}, ${slug}, ${`SELECT 'x' AS slug`}, NOW(), NOW())
      `;
    }
    await sql`INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${orgId}, 'note', 'Note', NOW(), NOW())`;
  }, 120_000);

  const counts = async () => {
    const [row] = await getTestDb()`
      SELECT (SELECT count(*) FROM events WHERE organization_id = ${orgId})::int AS events,
             (SELECT count(*) FROM entities WHERE organization_id = ${orgId})::int AS entities,
             (SELECT count(*) FROM entity_identities WHERE organization_id = ${orgId})::int AS identities,
             (SELECT count(*) FROM entity_relationships WHERE organization_id = ${orgId})::int AS links
    `;
    return row;
  };

  it("reads only the record's events, newest first, paging every row exactly once", async () => {
    const before = await counts();
    const first = await getContent({ record: { type: 'company', key: 'c1' }, limit: 2 }, {} as Env, owner);
    expect(first.content.map((item) => (item as { origin_id: string }).origin_id)).toEqual(['e4', 'e2']);
    expect(first.page.has_more).toBe(true);
    expect(first.record_failures).toBeUndefined();

    const second = await getContent(
      { record: { type: 'company', key: 'c1' }, limit: 2, record_cursor: first.record_cursor },
      {} as Env,
      owner,
    );
    expect(second.content.map((item) => (item as { origin_id: string }).origin_id)).toEqual(['e1']);
    expect(second.page.has_more).toBe(false);
    expect(await counts()).toEqual(before);
  }, 60_000);

  it.each(['private-sdk', 'private-plain'])('reports a withheld source as private and never retains it for retry (%s)', async (key) => {
    const record = { type: 'company', key };
    const activity = await getContent({ record, limit: 2 }, {} as Env, owner);
    expect(activity.content).toEqual([]);
    expect(activity.record_failures).toEqual([
      { feed_id: feedId, error: 'Communication details are private', code: 'withheld' },
    ]);
    expect(activity.page.has_more).toBe(false);
    expect(activity.record_cursor).toBeUndefined();
    const links = await manageEntity({ action: 'list_links', record, cursor: null }, {} as Env, owner);
    expect(links).toMatchObject({
      record_links: [],
      record_failures: [{ feed_id: feedId, error: 'Communication details are private', code: 'withheld' }],
      next_cursor: null,
    });
  }, 60_000);

  it('retains a failed source for an explicit retry', async () => {
    const record = { type: 'company', key: 'unavailable' };
    const activity = await getContent({ record, limit: 2 }, {} as Env, owner);
    expect(activity.record_failures).toEqual([{ feed_id: feedId, error: expect.stringContaining('Source unavailable') }]);
    expect(activity.record_cursor).toEqual(expect.any(String));
    const links = await manageEntity({ action: 'list_links', record, cursor: null }, {} as Env, owner);
    expect(links).toMatchObject({ record_failures: [{ feed_id: feedId }], next_cursor: expect.any(String) });
    expect((links as { record_failures: object[] }).record_failures[0]).not.toHaveProperty('code');
  }, 60_000);

  it('preserves the rich source envelope through the compiled connector without storing an event', async () => {
    const before = await counts();
    const page = await getContent({ record: { type: 'company', key: 'c1' }, feed_ids: [feedId], limit: 1 }, {} as Env, owner);
    expect(page.record_failures).toBeUndefined();
    expect(page.content).toHaveLength(1);
    expect(page.content[0]).toMatchObject({
      feed_id: feedId, origin_id: 'e4', semantic_type: 'summary', payload_type: 'json_template',
      payload_data: { summary: 'Role summary' }, payload_template: { type: 'div', children: '{{summary}}' },
      attachments: [{ url: 'https://example.test/role.pdf', mime_type: 'application/pdf' }],
    });
    expect(page.content[0]).not.toHaveProperty('id');
    expect(await counts()).toEqual(before);
  }, 60_000);

  it('filters the live read and its continuation by connector, connection, and feed', async () => {
    const filters = { platforms: [CONNECTOR_KEY], connection_ids: [privateConnectionId], feed_ids: [feedId] };
    const first = await getContent({ record: { type: 'company', key: 'c1' }, ...filters, limit: 2 }, {} as Env, owner);
    expect(first.content.map((item) => (item as { origin_id: string }).origin_id)).toEqual(['e4', 'e2']);
    const second = await getContent(
      { record: { type: 'company', key: 'c1' }, ...filters, limit: 2, record_cursor: first.record_cursor },
      {} as Env, owner,
    );
    expect(second.content.map((item) => (item as { origin_id: string }).origin_id)).toEqual(['e1']);
    expect(second.page.has_more).toBe(false);
    await expect(getContent(
      { record: { type: 'company', key: 'c1' }, ...filters, feed_ids: [], record_cursor: first.record_cursor },
      {} as Env, owner,
    )).rejects.toThrow(/cursor.*record or filters/i);
  }, 60_000);

  it('never widens unknown or inaccessible source selections', async () => {
    const record = { type: 'company', key: 'c1' };
    for (const filters of [
      { platforms: ['unknown_connector'], feed_ids: [feedId] },
      { connection_ids: [-1], feed_ids: [feedId] },
      { connection_ids: [privateConnectionId], feed_ids: [-1] },
    ]) {
      const read = await getContent({ record, ...filters }, {} as Env, owner);
      expect(read.content).toEqual([]);
      expect(read.record_failures).toBeUndefined();
    }
    const privateRead = await getContent(
      { record, platforms: [CONNECTOR_KEY], connection_ids: [privateConnectionId], feed_ids: [feedId] },
      {} as Env, member,
    );
    expect(privateRead.content).toEqual([]);
    expect(privateRead.record_failures).toBeUndefined();
  }, 60_000);

  it('ends when the last page exactly fills the limit', async () => {
    const page = await getContent({ record: { type: 'company', key: 'c1' }, limit: 3 }, {} as Env, owner);
    expect(page.content.map((item) => (item as { origin_id: string }).origin_id)).toEqual(['e4', 'e2', 'e1']);
    expect(page.page.has_more).toBe(false);
    expect(page.record_cursor).toBeUndefined();
  }, 60_000);

  it('keeps internal row checkpoints out of the public feed-read response', async () => {
    const result = await manageFeeds({
      action: 'read_feeds',
      reads: [{ feed_id: feedId, limit: 2, match: { path: 'metadata.company_id', values: ['c1'] } }],
    }, {} as Env, owner);
    expect(result).toMatchObject({ results: [{ ok: true, rows: [{ origin_id: 'e4' }, { origin_id: 'e2' }] }] });
    expect(result).not.toHaveProperty('results.0.row_cursors');
    expect(result).not.toHaveProperty('results.0.rowCursors');
  }, 60_000);

  it('reads relationships both ways from the declaring event kind', async () => {
    const companyLinks = await manageEntity(
      { action: 'list_links', record: { type: 'company', key: 'c1' } },
      {} as Env,
      owner,
    );
    expect(companyLinks).toMatchObject({
      record_links: [{ relationship_type: 'works_at', direction: 'incoming', entity_type: 'person', key: 'p1', name: 'Pat' }],
      record_failures: [],
    });
    expect(companyLinks).toHaveProperty('next_cursor', null);
    const personLinks = await manageEntity(
      { action: 'list_links', record: { type: 'person', key: 'p1' } },
      {} as Env,
      owner,
    );
    expect(personLinks).toMatchObject({
      record_links: [{ relationship_type: 'works_at', direction: 'outgoing', entity_type: 'company', key: 'c1', name: 'Acme' }],
    });
  }, 60_000);

  it('preserves declared anchor and peer keys through native links and their cursors', async () => {
    const sql = getTestDb();
    const before = await counts();
    const backing = "SELECT * FROM (VALUES (' padded-company '), ('plain-company'), (' padded-person '), ('padded-person')) AS records(id)";
    await sql`UPDATE entity_types SET backing_sql = ${backing}, metadata_schema = ${sql.json({ type: 'object', 'x-lobu-record-key': 'id' })}
      WHERE organization_id = ${orgId} AND slug IN ('company', 'person')`;
    try {
      const entities = buildEntitiesNamespace(owner, {} as Env);
      const first = await entities.listLinks({ entity_id: ' padded-company ', entity_type: 'company', limit: 1 });
      expect(first).toMatchObject({ record_links: [{ key: ' padded-person ' }], record_failures: [] });
      const second = await entities.listLinks({ entity_id: ' padded-company ', entity_type: 'company', limit: 1, cursor: first.next_cursor });
      expect(second).toMatchObject({ record_links: [{ key: 'padded-person' }], record_failures: [] });
      const reverse = await entities.listLinks({ entity_id: ' padded-person ', entity_type: 'person' });
      expect(reverse.record_links?.map(link => link.key)).toEqual([' padded-company ', 'plain-company']);
      const activity = await getContent({ record: { type: 'company', key: ' padded-company ' } }, {} as Env, owner);
      expect(activity.content.map(item => (item as { origin_id: string }).origin_id)).toEqual(['w3', 'w2']);
      await sql`UPDATE entity_types SET metadata_schema = '{}'::jsonb WHERE organization_id = ${orgId} AND slug = 'person'`;
      await expect(entities.listLinks({ entity_id: ' padded-company ', entity_type: 'company', limit: 1, cursor: first.next_cursor })).rejects.toThrow(/cursor/i);
      await sql`UPDATE entity_types SET metadata_schema = ${sql.json({ type: 'object', 'x-lobu-record-key': 'id' })} WHERE organization_id = ${orgId} AND slug = 'person'`;
      // Peer semantics come from the peer's declaration, independently of the anchor.
      await sql`UPDATE entity_types SET metadata_schema = '{}'::jsonb WHERE organization_id = ${orgId} AND slug = 'company'`;
      const mixed = await entities.listLinks({ record: { type: 'company', key: 'plain-company' } });
      expect(mixed).toMatchObject({ record_links: [{ key: ' padded-person ' }] });
      await sql`UPDATE entity_types SET metadata_schema = '{}'::jsonb WHERE organization_id = ${orgId} AND slug = 'person'`;
      const legacy = await entities.listLinks({ record: { type: 'company', key: 'plain-company' } });
      expect(legacy).toMatchObject({ record_links: [{ key: 'padded-person' }] });
      expect(await counts()).toEqual(before);
    } finally {
      await sql`UPDATE entity_types SET backing_sql = ${"SELECT 'x' AS slug"}, metadata_schema = '{}'::jsonb
        WHERE organization_id = ${orgId} AND slug IN ('company', 'person')`;
    }
  }, 60_000);

  it.each([undefined, null])('starts public relationship pagination with cursor %s without persisting source records', async (cursor) => {
    const before = await counts();
    const record = { type: 'company', key: 'c1' };
    const first = await buildEntitiesNamespace(owner, {} as Env).listLinks({ record, limit: 1, ...(cursor === undefined ? {} : { cursor }) }) as Awaited<ReturnType<typeof manageEntity>>;
    expect(first).toMatchObject({ record_links: [{ key: 'p1' }], next_cursor: expect.any(String) });
    if (!('next_cursor' in first)) throw new Error('Missing cursor contract');
    const second = await manageEntity({ action: 'list_links', record, limit: 1, cursor: first.next_cursor }, {} as Env, owner);
    expect(second).toMatchObject({ record_links: [], next_cursor: expect.any(String) });
    if (!('next_cursor' in second)) throw new Error('Missing cursor contract');
    const last = await manageEntity({ action: 'list_links', record, limit: 1, cursor: second.next_cursor }, {} as Env, owner);
    expect(last).toMatchObject({ record_links: [], record_failures: [], next_cursor: null });
    await expect(manageEntity({ action: 'list_links', record, cursor: first.next_cursor }, {} as Env, member)).rejects.toThrow(/cursor/i);
    const privateRead = await manageEntity({ action: 'list_links', record, cursor: null }, {} as Env, member);
    expect(privateRead).toMatchObject({ record_links: [], record_failures: [], next_cursor: null });
    expect(await counts()).toEqual(before);
  }, 60_000);

  it('rechecks source availability before continuing a relationship cursor', async () => {
    const record = { type: 'company', key: 'c1' };
    const first = await manageEntity({ action: 'list_links', record, limit: 1, cursor: null }, {} as Env, owner);
    if (!('next_cursor' in first)) throw new Error('Missing cursor contract');
    await getTestDb()`UPDATE connections SET status = 'paused' WHERE id = ${privateConnectionId}`;
    try {
      await expect(manageEntity({ action: 'list_links', record, cursor: first.next_cursor }, {} as Env, owner)).rejects.toThrow(/cursor/i);
    } finally {
      await getTestDb()`UPDATE connections SET status = 'active' WHERE id = ${privateConnectionId}`;
    }
  }, 60_000);

  it('does not reinterpret stored entity pagination as source cursors', async () => {
    await expect(manageEntity({ action: 'list_links', entity_id: 1, cursor: null }, {} as Env, owner)).rejects.toThrow(/entity_id uses limit\/offset/);
  });

  it("does not read a connection the caller cannot see", async () => {
    const read = await getContent({ record: { type: 'company', key: 'c1' } }, {} as Env, member);
    expect(read.content).toEqual([]);
    // Never attempted, rather than attempted and refused.
    expect(read.record_failures).toBeUndefined();
  }, 60_000);

  it('refuses stored types, extra filters, and a zero entity id', async () => {
    await expect(getContent({ record: { type: 'note', key: 'n1' } }, {} as Env, owner)).rejects.toThrow(/not source-backed/);
    await expect(
      getContent({ record: { type: 'company', key: 'c1' }, query: 'renewal' }, {} as Env, owner),
    ).rejects.toThrow(/cannot be combined with query/);
    await expect(getContent({ entity_id: 0 }, {} as Env, owner)).rejects.toThrow();
  }, 60_000);

  describe('bounded reads against one connection', () => {
    // What the upstream observed per record key: concurrent requests and every
    // request's feed, in arrival order.
    const upstream = new Map<string, { inFlight: number; peak: number; feeds: number[] }>();
    let server: Server;
    let burstFeeds: number[];
    let savedAllowHosts: string | undefined;
    const observed = (key: string) => {
      let entry = upstream.get(key);
      if (!entry) upstream.set(key, (entry = { inFlight: 0, peak: 0, feeds: [] }));
      return entry;
    };
    const attempts = (key: string, feed: number) => observed(key).feeds.filter((value) => value === feed).length;

    beforeAll(async () => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const key = url.searchParams.get('key') ?? '';
        const feed = Number(url.searchParams.get('feed'));
        const entry = observed(key);
        entry.inFlight += 1;
        entry.peak = Math.max(entry.peak, entry.inFlight);
        entry.feeds.push(feed);
        const attempt = attempts(key, feed);
        let open = true;
        const finish = () => {
          if (!open) return;
          open = false;
          entry.inFlight -= 1;
        };
        res.on('close', finish);
        // Long enough for reads of one page to overlap; `slow` outlasts half the page deadline.
        setTimeout(() => {
          finish();
          if (res.destroyed) return;
          if (key === 'down' || key === 'private' || (key === 'flaky' && attempt === 1)) {
            res.writeHead(503).end('unavailable');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{
            origin_id: `touch-${feed}`,
            origin_type: 'touch',
            occurred_at: new Date(Date.UTC(2026, 2, 1, 0, 0, feed % 60)).toISOString(),
            metadata: { account_id: key, contact_id: `contact-${feed}`, contact_name: `Contact ${feed}` },
          }]));
        }, key === 'slow' ? 12_000 : 150);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      // A loopback upstream is reachable only through the operator's exact exemption.
      savedAllowHosts = process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS;
      process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS = '127.0.0.1';

      const compiled = await compileConnectorSource(BURST_SOURCE);
      const metadata = await extractConnectorMetadata(compiled.compiledCode);
      const sql = getTestDb();
      await sql`
        INSERT INTO connector_definitions
          (key, name, version, feeds_schema, auth_schema, organization_id, status, created_at, updated_at)
        VALUES (${BURST_KEY}, 'Record burst', '1.0.0', ${sql.json(metadata.feeds as object)},
          ${sql.json({ methods: [{ type: 'none' }] })}, ${orgId}, 'active', NOW(), NOW())
      `;
      await sql`
        INSERT INTO connector_versions
          (organization_id, connector_key, version, compiled_code, compiled_code_hash, compile_config_hash, source_code, created_at)
        VALUES (${orgId}, ${BURST_KEY}, '1.0.0', ${compiled.compiledCode}, ${compiled.compiledCodeHash},
          ${COMPILE_CONFIG_HASH}, ${BURST_SOURCE}, NOW())
      `;
      const [connection] = await sql`
        INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, config, created_by, created_at, updated_at)
        VALUES (${orgId}, ${BURST_KEY}, 'record-burst', 'Record burst', 'active', 'private',
          ${sql.json({ base_url: `http://127.0.0.1:${port}` })}, ${ownerUserId}, NOW(), NOW())
        RETURNING id
      `;
      burstFeeds = [];
      for (let lane = 0; lane < BURST_FEEDS; lane += 1) {
        const [feed] = await sql`
          INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, config, created_at, updated_at)
          VALUES (${orgId}, ${connection.id}, 'burst', ${`Burst ${lane}`}, 'active', ${sql.json({})}, NOW(), NOW())
          RETURNING id
        `;
        burstFeeds.push(Number(feed.id));
      }
      await sql`
        INSERT INTO entity_types (organization_id, slug, name, backing_sql, created_at, updated_at)
        VALUES (${orgId}, 'account', 'Account', ${"SELECT 'x' AS slug"}, NOW(), NOW())
      `;
    }, 120_000);

    afterAll(async () => {
      if (savedAllowHosts === undefined) delete process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS;
      else process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS = savedAllowHosts;
      server?.closeAllConnections();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    });

    const originIds = (content: unknown[]) =>
      content.map((item) => (item as { origin_id: string }).origin_id).sort();
    const everyTouch = () => burstFeeds.map((feed) => `touch-${feed}`).sort();

    it('keeps at most the per-connection cap of record reads in flight', async () => {
      const page = await getContent({ record: { type: 'account', key: 'steady' } }, {} as Env, owner);
      expect(page.record_failures).toBeUndefined();
      expect(originIds(page.content)).toEqual(everyTouch());
      expect(observed('steady').feeds).toHaveLength(BURST_FEEDS);
      expect(observed('steady').peak).toBeLessThanOrEqual(READS_PER_CONNECTION);
    }, 60_000);

    it('recovers a transient upstream 503 with one retry, on activity and relationships', async () => {
      const page = await getContent({ record: { type: 'account', key: 'flaky' } }, {} as Env, owner);
      expect(page.record_failures).toBeUndefined();
      expect(page.record_cursor).toBeUndefined();
      expect(originIds(page.content)).toEqual(everyTouch());
      for (const feed of burstFeeds) expect(attempts('flaky', feed)).toBe(2);

      upstream.delete('flaky');
      const links = await manageEntity({ action: 'list_links', record: { type: 'account', key: 'flaky' }, cursor: null }, {} as Env, owner);
      expect(links).toMatchObject({ record_failures: [], next_cursor: null });
      expect((links as { record_links: Array<{ key: string }> }).record_links.map((link) => link.key).sort())
        .toEqual(burstFeeds.map((feed) => `contact-${feed}`).sort());
      expect(observed('flaky').peak).toBeLessThanOrEqual(READS_PER_CONNECTION);
    }, 60_000);

    it('reports a persistent 503 after one retry and keeps it for an explicit retry', async () => {
      const page = await getContent({ record: { type: 'account', key: 'down' } }, {} as Env, owner);
      expect(page.content).toEqual([]);
      expect(page.record_failures?.map((failure) => failure.feed_id).sort()).toEqual([...burstFeeds].sort());
      for (const failure of page.record_failures ?? []) expect(failure).not.toHaveProperty('code');
      expect(page.record_cursor).toEqual(expect.any(String));
      for (const feed of burstFeeds) expect(attempts('down', feed)).toBe(2);
    }, 60_000);

    it('never retries a withheld read, even one carrying a transient status', async () => {
      const page = await getContent({ record: { type: 'account', key: 'private' } }, {} as Env, owner);
      expect(page.record_failures).toHaveLength(BURST_FEEDS);
      for (const failure of page.record_failures ?? []) expect(failure).toHaveProperty('code', 'withheld');
      expect(page.record_cursor).toBeUndefined();
      for (const feed of burstFeeds) expect(attempts('private', feed)).toBe(1);
    }, 60_000);

    it('reports reads not started by the page deadline as retryable timeouts', async () => {
      // 12 streams, 4 at a time, 12s each: the first 4 finish, the next 4 run
      // into the 20s page deadline, and the last 4 never reach the upstream.
      const page = await getContent({ record: { type: 'account', key: 'slow' } }, {} as Env, owner);
      expect(page.content).toHaveLength(READS_PER_CONNECTION);
      expect(page.record_failures).toHaveLength(BURST_FEEDS - READS_PER_CONNECTION);
      for (const failure of page.record_failures ?? []) expect(failure).not.toHaveProperty('code');
      expect(page.record_cursor).toEqual(expect.any(String));
      expect(observed('slow').feeds).toHaveLength(2 * READS_PER_CONNECTION);
    }, 60_000);
  });
});
