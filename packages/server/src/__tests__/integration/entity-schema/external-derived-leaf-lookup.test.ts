import { beforeAll, describe, expect, it } from 'vitest';
import { derivedRowSlug, queryDerivedEntityView } from '../../../utils/entity-management';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestConnectorDefinition,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { resolvePath } from '../../../tools/resolve_path';
import { TestApiClient } from '../../setup/test-mcp-client';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { querySqlImpl } from '../../../tools/admin/query_sql';

const SOURCE_SQL = `SELECT n AS id, 'source-' || n AS slug, 'Row ' || n AS name
  FROM generate_series(1, 20001) n`;

describe('external derived record lookup', () => {
  let orgId: string;
  let orgSlug: string;
  let userId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'External Record Lookup' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'source-lookup@example.test' });
    userId = user.id;
    await addUserToOrganization(userId, orgId, 'owner');
    const db = getTestDb();
    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'Source database',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`INSERT INTO connections
      (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by)
      VALUES (${orgId}, 'postgres', 'record-source', 'Record source', 'active', ${profile.id}, 'private', ${userId})`;
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    await api.entity_schema.createType({
      slug: 'source-record', name: 'Source record',
      backing: { sql: SOURCE_SQL, connection: 'record-source' },
    });
  }, 120_000);

  function lookup(sql: string, slug: string) {
    return queryDerivedEntityView(sql, 'record-source', { limit: 1, offset: 0 }, ownerToolContext(orgId, userId), {
      preservePageRows: true, exactSlug: slug,
    });
  }

  it('pushes an exact filter through the real connector, beyond the former 20,000-row cap', async () => {
    const result = await lookup(SOURCE_SQL, 'source-20001');
    expect(result.error).toBeUndefined();
    expect(result.rows).toEqual([{ id: 20001, slug: 'source-20001', name: 'Row 20001' }]);
  });

  it('accepts the entity table default sort without a source created_at column', async () => {
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    const page = await api.entities.list({ entity_type: 'source-record', sort_by: 'created_at', sort_order: 'desc', limit: 1 }) as { entities: Array<{ slug: string }> };
    expect(page.entities.map(row => row.slug)).toEqual(['source-1']);
  });

  it('passes numeric sorting and pagination from the entity API into the source', async () => {
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    for (const [order, expected] of [['asc', 2], ['desc', 20000]] as const) {
      const page = await api.entities.list({ entity_type: 'source-record', sort_by: 'id', sort_order: order, offset: 1, limit: 1 }) as { entities: Array<{ metadata: { id: number } }> };
      expect(page.entities.map(row => row.metadata.id)).toEqual([expected]);
    }
  });

  it('resolves the native record URL without materializing an entity', async () => {
    const result = await resolvePath({ path: `/${orgSlug}/source-record/source-20001` }, {}, ownerToolContext(orgId, userId));
    expect(result.entity).toMatchObject({ slug: 'source-20001', name: 'Row 20001', is_derived: true });
    const rows = await getTestDb()`SELECT id FROM entities WHERE organization_id = ${orgId} AND slug = 'source-20001'`;
    expect(rows).toHaveLength(0);
  });

  it.each([
    ['SELECT 42 AS id', '42', [{ id: 42 }]],
    ["SELECT 42 AS id, NULL::text AS slug", '42', [{ id: 42, slug: null }]],
    ["SELECT 42 AS id, 'preferred' AS slug", '42', []],
    ["SELECT 42 AS id, '' AS slug", '42', []],
    ["SELECT 42 AS id, E'\\t padded \\n' AS slug", 'padded', [{ id: 42, slug: '\t padded \n' }]],
    ["SELECT 42 AS id, ' padded　' AS slug", 'padded', [{ id: 42, slug: ' padded　' }]],
    ["SELECT 42 AS id", 'missing', []],
    ["SELECT 'safe' AS slug", "' OR true --\\", []],
    ["SELECT 'routable' AS slug, '{\"n\":1}'::jsonb AS id", 'routable', [{ slug: 'routable', id: { n: 1 } }]],
    ["SELECT 'routable' AS slug, ARRAY[1, 2] AS id", 'routable', [{ slug: 'routable', id: [1, 2] }]],
    ["SELECT NULL::jsonb AS slug, 42 AS id", '42', [{ slug: null, id: 42 }]],
    ["SELECT 'null'::jsonb AS slug, 42 AS id", '42', [{ slug: null, id: 42 }]],
    ["SELECT ' null '::json AS slug, 42 AS id", '42', [{ slug: null, id: 42 }]],
    ["SELECT '\"preferred\"'::jsonb AS slug, 42 AS id", 'preferred', [{ slug: 'preferred', id: 42 }]],
    ["SELECT '\"preferred\"'::jsonb AS slug, 42 AS id", '42', []],
    ["SELECT '\"\"'::jsonb AS slug, 42 AS id", '42', []],
    ["SELECT NULL::integer[] AS slug, 42 AS id", '42', [{ slug: null, id: 42 }]],
    ["SELECT 'routable' AS slug, '{\"n\":1}'::jsonb AS id", 'missing', []],
    ["SELECT '{\"n\":1}'::jsonb AS slug, 42 AS id", '42', []],
    ["SELECT NULL::jsonb AS slug, 42 AS id UNION ALL SELECT '{\"n\":1}'::jsonb, 43", '42', [{ slug: null, id: 42 }]],
    ["SELECT NULL::jsonb AS slug, 42 AS id UNION ALL SELECT '{\"n\":1}'::jsonb, 43", '43', []],
  ])('honors canonical identity for %s / %s', async (sql, slug, rows) => {
    expect((await lookup(sql, slug)).rows).toEqual(rows);
  });

  it('preserves a denied source failure instead of reporting an empty result', async () => {
    const ctx = { ...ownerToolContext(orgId, 'another-member'), memberRole: 'member' as const };
    await expect(queryDerivedEntityView(SOURCE_SQL, 'record-source', { limit: 1, offset: 0 }, ctx, { exactSlug: 'source-1' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    '1e-7::float8',
    '1.2::float4',
    '1.2300::numeric',
    'true::boolean',
    "'2026-01-02'::date",
    "'2026-01-02T03:04:05Z'::timestamptz",
    "'2026-07-02 03:04:05.123456'::timestamp",
    "'2026-07-02T03:04:05.123456+05'::timestamptz",
    ...['json', 'jsonb'].flatMap((type) => ['\"route\"', '42', 'true', '\" route　\"', '1e-7', '9007199254740993', '1e-400'].map((value) => `'${value}'::${type}`)),
  ])('resolves the listed routing key for %s', async (expression) => {
    const sql = `SELECT ${expression} AS id`;
    const listed = await queryDerivedEntityView(sql, 'record-source', { limit: 1, offset: 0 }, ownerToolContext(orgId, userId));
    const result = await lookup(sql, derivedRowSlug(listed.rows[0]));
    expect(result.rows).toEqual(listed.rows);
  });

  it.each(['ARRAY[1, 2]', "decode('00', 'hex')"])(
    'explicitly rejects a nonscalar identity %s', async (expression) => {
      await expect(lookup(`SELECT ${expression} AS id`, 'not-a-scalar'))
        .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('must be a scalar') });
    }
  );

  it.each(['json', 'jsonb'])('uses driver null fallback for overflowing %s numbers', async (type) => {
    const sql = `SELECT '1e400'::${type} AS slug, 42 AS id`;
    const listed = await queryDerivedEntityView(sql, 'record-source', { limit: 1, offset: 0 }, ownerToolContext(orgId, userId));
    expect(listed.rows).toEqual([{ slug: null, id: 42 }]);
    expect((await lookup(sql, derivedRowSlug(listed.rows[0]))).rows).toEqual(listed.rows);
  });

  it.each(['float4', 'float8'].flatMap((type) => ['NaN', 'Infinity', '-Infinity'].map((value) => `'${value}'::${type}`)))(
    'uses driver null fallback for nonfinite %s', async (expression) => {
      const sql = `SELECT ${expression} AS slug, 42 AS id`;
      const listed = await queryDerivedEntityView(sql, 'record-source', { limit: 1, offset: 0 }, ownerToolContext(orgId, userId));
      expect(listed.rows).toEqual([{ slug: null, id: 42 }]);
      expect((await lookup(sql, derivedRowSlug(listed.rows[0]))).rows).toEqual(listed.rows);
    }
  );

  it.each(['date', 'timestamp', 'timestamptz'].flatMap((type) => ['infinity', '-infinity'].map((value) => `'${value}'::${type}`)))(
    'uses driver null fallback for nonfinite %s', async (expression) => {
      const sql = `SELECT ${expression} AS slug, 42 AS id`;
      const listed = await queryDerivedEntityView(sql, 'record-source', { limit: 1, offset: 0 }, ownerToolContext(orgId, userId));
      expect(listed.rows).toEqual([{ slug: null, id: 42 }]);
      expect((await lookup(sql, derivedRowSlug(listed.rows[0]))).rows).toEqual(listed.rows);
    }
  );

  it.each(['json', 'jsonb'].flatMap((type) => ['{\"n\":1}', '[1,2]'].map((value) => `'${value}'::${type}`)))(
    'does not route a JSON object or array identity %s', async (expression) => {
      const sql = `SELECT ${expression} AS id`;
      const listed = await queryDerivedEntityView(sql, 'record-source', { limit: 1, offset: 0 }, ownerToolContext(orgId, userId));
      expect((await lookup(sql, derivedRowSlug(listed.rows[0]))).rows).toEqual([]);
    }
  );

  it('preserves a failed source query instead of reporting a missing record', async () => {
    await expect(lookup('SELECT id FROM missing_source_table', '1')).rejects.toThrow(/missing_source_table/);
  });

  it('keeps source failures visible on the native record route', async () => {
    const db = getTestDb();
    await db`UPDATE entity_types SET backing_sql = 'SELECT id FROM missing_source_table'
      WHERE organization_id = ${orgId} AND slug = 'source-record'`;
    try {
      await expect(resolvePath({ path: `/${orgSlug}/source-record/source-20001` }, {}, ownerToolContext(orgId, userId)))
        .rejects.toThrow(/missing_source_table/);
    } finally {
      await db`UPDATE entity_types SET backing_sql = ${SOURCE_SQL}
        WHERE organization_id = ${orgId} AND slug = 'source-record'`;
    }
  });

  it('rejects unsupported filters before calling an old connector query handler', async () => {
    const compiledCode = await createIsolateConnectorCompiler().compileConnectorForIsolateFromSource(`
      import { defineConnector } from '@lobu/connector-sdk';
      export default defineConnector({
        key: 'unsupported_exact', name: 'Unsupported exact', version: '0.0.1',
        query: async () => { throw new Error('query handler must not run'); }
      });
    `);
    await expect(executeCompiledConnector({ compiledCode, job: {
      mode: 'query', query: 'SELECT 1', exactMatch: { columns: ['id'], value: '1' },
      config: {}, credentials: null, sessionState: null, env: {}, limit: 1,
    } })).rejects.toMatchObject({ httpStatus: 400, message: 'Connector does not support exact-match queries' });
  });

  it('functional connectors retain capability metadata and receive the exact filter', async () => {
    const compiledCode = await createIsolateConnectorCompiler().compileConnectorForIsolateFromSource(`
      import { defineConnector } from '@lobu/connector-sdk';
      export default defineConnector({
        key: 'supported_exact', name: 'Supported exact', version: '0.0.1',
        queryCapabilities: { exactMatch: true, selection: true },
        query: async (ctx) => ({ rows: [{ filter: ctx.exactMatch, selection: ctx.selection, limit: ctx.limit, offset: ctx.offset }] })
      });
    `);
    const exactMatch = { columns: ['slug', 'id'], value: 'source-id' };
    const selection = { search: 'literal %', filters: [{ field: 'seats', op: 'gte' as const, value: 100 }] };
    const result = await executeCompiledConnector({ compiledCode, job: {
      mode: 'query', query: 'SELECT 1', exactMatch, selection,
      config: {}, credentials: null, sessionState: null, env: {}, limit: 1, offset: 0,
    } });
    expect(result).toMatchObject({ mode: 'query', rows: [{ filter: exactMatch, selection, limit: 1, offset: 0 }] });
  });

  it('marks unfiltered collections for exact source totals without counting ordinary SQL reads', async () => {
    const key = 'collection-count-fixture';
    const compiledCode = await createIsolateConnectorCompiler().compileConnectorForIsolateFromSource(`
      import { defineConnector } from '@lobu/connector-sdk';
      export default defineConnector({
        key: '${key}', name: 'Collection count fixture', version: '1.0.0',
        queryCapabilities: { selection: true },
        query: async (ctx) => ({ rows: [{ slug: 'source-1', name: 'First', collection: ctx.selection !== undefined }],
          ...(ctx.selection !== undefined ? { total: 17 } : {}) })
      });
    `);
    await createTestConnectorDefinition({ key, name: 'Collection count fixture', organization_id: orgId });
    const db = getTestDb();
    await db`UPDATE connector_versions SET compiled_code = ${compiledCode} WHERE connector_key = ${key}`;
    await db`INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by)
      VALUES (${orgId}, ${key}, 'count-source', 'Count source', 'active', 'org', ${userId})`;
    const context = ownerToolContext(orgId, userId);
    const collection = await queryDerivedEntityView('SELECT 1', 'count-source', { limit: 1, offset: 0 }, context);
    expect(collection.rows).toEqual([{ slug: 'source-1', name: 'First', collection: true }]);
    expect(collection.total_count).toBe(17);
    expect(collection.has_more).toBe(true);
    const ordinary = await querySqlImpl({ sql: 'SELECT 1', connection: 'count-source', limit: 1 }, {}, context);
    expect(ordinary.rows[0].collection).toBe(false);
  });
});
