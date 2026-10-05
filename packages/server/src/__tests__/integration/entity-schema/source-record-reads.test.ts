/**
 * Activity and Relationships of a source-backed record are read live from the
 * read feeds whose event kinds attribute to its type, filtered by the
 * attribution's own identity path. Nothing is written.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageEntity } from '../../../tools/admin/manage_entity';
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
  import { defineConnector } from '@lobu/connector-sdk';
  const ROWS = [
    { origin_id: 'e4', origin_type: 'role', title: 'Pat joined Acme', occurred_at: '2026-01-04T00:00:00.000Z',
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
          const matched = ROWS.filter((row) => !ctx.match || ctx.match.values.includes(String(at(row, ctx.match.path))));
          const start = ctx.cursor ? matched.findIndex((row) => row.origin_id === ctx.cursor) + 1 : 0;
          const page = matched.slice(start, start + (ctx.limit ?? 50));
          const more = start + page.length < matched.length;
          return { rows: page, ...(more ? { nextCursor: page[page.length - 1].origin_id } : {}) };
        },
      },
    },
  });
`;

describe('source-backed record reads', () => {
  let orgId: string;
  let owner: ToolContext;
  let member: ToolContext;
  let privateConnectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'SourceRecordReads' });
    orgId = org.id;
    const user = await createTestUser({ email: 'source-record-reads@test.com' });
    await addUserToOrganization(user.id, orgId, 'owner');
    owner = ownerToolContext(orgId, user.id);
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
    await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, config, created_at, updated_at)
      VALUES (${orgId}, ${privateConnectionId}, 'timeline', 'Timeline', 'active', ${sql.json({})}, NOW(), NOW())
    `;
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

  it('ends when the last page exactly fills the limit', async () => {
    const page = await getContent({ record: { type: 'company', key: 'c1' }, limit: 3 }, {} as Env, owner);
    expect(page.content.map((item) => (item as { origin_id: string }).origin_id)).toEqual(['e4', 'e2', 'e1']);
    expect(page.page.has_more).toBe(false);
    expect(page.record_cursor).toBeUndefined();
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
    const personLinks = await manageEntity(
      { action: 'list_links', record: { type: 'person', key: 'p1' } },
      {} as Env,
      owner,
    );
    expect(personLinks).toMatchObject({
      record_links: [{ relationship_type: 'works_at', direction: 'outgoing', entity_type: 'company', key: 'c1', name: 'Acme' }],
    });
  }, 60_000);

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
});
