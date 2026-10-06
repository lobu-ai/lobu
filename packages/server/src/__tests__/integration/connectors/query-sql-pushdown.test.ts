/**
 * query_sql({ connection }) pushdown — the full chain end to end:
 *   query_sql → runConnectorQuery → resolveConnectorCode (compile postgres)
 *   → executeCompiledConnector (fork child) → connector.query() → external DB → rows.
 *
 * The "external" connection points back at the test DB URL, so the connector
 * opens a fresh pool and reads a throwaway table as if it were an external source.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySql, querySqlImpl } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';

describe('query_sql connection pushdown', () => {
  let ctx: ToolContext;
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Pushdown' });
    orgId = org.id;
    const user = await createTestUser({ email: 'pushdown@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = ownerToolContext(orgId, user.id);

    const db = getTestDb();
    await db`DROP TABLE IF EXISTS qsp_ext`;
    await db`CREATE TABLE qsp_ext (id bigserial primary key, name text, amount numeric, payload jsonb)`;
    await db`INSERT INTO qsp_ext (name, amount, payload) VALUES ('a', 10, '{}'::jsonb), ('b', 5, '{}'::jsonb), ('c', 7, '{}'::jsonb)`;

    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'ext db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'qsp-ext-db', 'Ext DB', 'active', ${profile.id}, 'org', ${user.id}, NOW(), NOW())
    `;
    // A PRIVATE connection owned by the org owner — a member must not reach it.
    await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'qsp-priv-db', 'Private DB', 'active', ${profile.id}, 'private', ${user.id}, NOW(), NOW())
    `;
  }, 120_000);

  const memberCtx = (): ToolContext => ({
    organizationId: orgId,
    userId: 'member-x',
    memberRole: 'member',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
  });

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS qsp_ext`;
  });

  it('runs SQL LIVE against the connection (pushdown) and returns rows', async () => {
    const res = await querySql(
      { sql: 'SELECT id, name, amount FROM qsp_ext ORDER BY id', connection: 'qsp-ext-db', limit: 10 },
      {},
      ctx
    );
    expect(res.error).toBeUndefined();
    expect(res.rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(Number(res.rows[0].amount)).toBe(10);
  }, 60_000);

  it('selects before paging and counts the same source population', async () => {
    const args = { sql: 'SELECT name, amount FROM qsp_ext', connection: 'qsp-ext-db', sort_by: 'name', limit: 1 };
    const options = { selection: { filters: [{ field: 'amount', op: 'gte' as const, value: 7 }] } };
    const first = await querySqlImpl(args, {}, ctx, options);
    expect(first.rows.map(row => row.name)).toEqual(['a']);
    expect(first.total_count).toBe(2);
    expect(first.has_more).toBe(true);
    const last = await querySqlImpl({ ...args, offset: 1 }, {}, ctx, options);
    expect(last.rows.map(row => row.name)).toEqual(['c']);
    expect(last.total_count).toBe(2);
    const beyond = await querySqlImpl({ ...args, offset: 5 }, {}, ctx, options);
    expect(beyond.rows).toEqual([]);
    expect(beyond.total_count).toBe(2);
    const literal = await querySqlImpl(args, {}, ctx, { selection: { search: '%' } });
    expect(literal.total_count).toBe(0);
    await expect(querySqlImpl(args, {}, ctx, { selection: { filters: [{ field: 'missing', op: 'eq', value: 1 }] } })).rejects.toThrow(/Unknown selection attribute/);
    await expect(querySqlImpl({ ...args, connection: 'qsp-priv-db' }, {}, memberCtx(), options)).rejects.toThrow(/not found or not accessible/i);
  }, 60_000);

  it('bounds oversized text and nested JSON on the external connection branch', async () => {
    const db = getTestDb();
    await db`
      INSERT INTO qsp_ext (name, amount, payload)
      VALUES (${'x'.repeat(8_000)}, 99, ${db.json({ body: 'p'.repeat(32 * 1024) })})
    `;
    try {
      const res = await querySql(
        {
          sql: 'SELECT id, name, payload FROM qsp_ext WHERE amount = 99',
          connection: 'qsp-ext-db',
          limit: 10,
        },
        {},
        ctx
      );

      expect(res.error).toBeUndefined();
      expect(String(res.rows[0].name)).toMatch(/… \[truncated\]$/);
      expect(res.rows[0].payload).toEqual({ _truncated: true, bytes: expect.any(Number) });
    } finally {
      await db`DELETE FROM qsp_ext WHERE amount = 99`;
    }
  }, 60_000);

  it('pushes sort + pagination down', async () => {
    const res = await querySql(
      { sql: 'SELECT id, name FROM qsp_ext', connection: 'qsp-ext-db', sort_by: 'name', sort_order: 'desc', limit: 2 },
      {},
      ctx
    );
    expect(res.error).toBeUndefined();
    expect(res.rows.map((r) => r.name)).toEqual(['c', 'b']);
  }, 60_000);

  it('reports the real total_count + has_more across pages (not the page size)', async () => {
    // page 1 of 2: 2 of 3 rows, total is the whole table, more to come.
    const p1 = await querySql(
      { sql: 'SELECT id, name FROM qsp_ext', connection: 'qsp-ext-db', sort_by: 'id', limit: 2, offset: 0 },
      {},
      ctx
    );
    expect(p1.error).toBeUndefined();
    expect(p1.rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(p1.total_count).toBe(3);
    expect(p1.has_more).toBe(true);

    // last page: the final row, total still 3, no more.
    const p2 = await querySql(
      { sql: 'SELECT id, name FROM qsp_ext', connection: 'qsp-ext-db', sort_by: 'id', limit: 2, offset: 2 },
      {},
      ctx
    );
    expect(p2.rows.map((r) => r.name)).toEqual(['c']);
    expect(p2.total_count).toBe(3);
    expect(p2.has_more).toBe(false);
  }, 60_000);

  it('rejects a top-level LIMIT in the pushed-down SQL (the connector paginates)', async () => {
    // A pushdown failure is a hard tool error, never a success-shaped empty
    // table an agent could read as "no data" (#2042).
    await expect(
      querySql({ sql: 'SELECT id, name FROM qsp_ext LIMIT 1', connection: 'qsp-ext-db' }, {}, ctx)
    ).rejects.toThrow(/top-level LIMIT/i);
  }, 60_000);

  it('rejects duplicate output column names', async () => {
    await expect(
      querySql({ sql: 'SELECT id AS dup, name AS dup FROM qsp_ext', connection: 'qsp-ext-db' }, {}, ctx)
    ).rejects.toThrow(/duplicate output column/i);
  }, 60_000);

  it('errors on a missing connection', async () => {
    await expect(querySql({ sql: 'SELECT 1', connection: 'nope' }, {}, ctx)).rejects.toThrow(
      /not found or not accessible/i
    );
  }, 60_000);

  it('errors on a write-capable query (connector read-only contract)', async () => {
    await expect(
      querySql(
        { sql: 'WITH x AS (INSERT INTO qsp_ext (name) VALUES (1) RETURNING id) SELECT * FROM x', connection: 'qsp-ext-db' },
        {},
        ctx
      )
    ).rejects.toThrow(/data-modifying/i);
    const [{ n }] = await getTestDb()`SELECT count(*)::int AS n FROM qsp_ext WHERE name = '1'`;
    expect(Number(n)).toBe(0);
  }, 60_000);

  it('a member cannot reach another user’s PRIVATE connection by slug', async () => {
    await expect(
      querySql({ sql: 'SELECT 1', connection: 'qsp-priv-db' }, {}, memberCtx())
    ).rejects.toThrow(/not found or not accessible/i);
    // …and an owner/admin still can.
    const ok = await querySql({ sql: 'SELECT count(*)::int AS n FROM qsp_ext', connection: 'qsp-priv-db' }, {}, ctx);
    expect(ok.error).toBeUndefined();
  }, 60_000);

  it('under LOBU_CLOUD_MODE the gate is open but block-private egress fails an internal host closed', async () => {
    // No per-connector cloud restriction list exists, so pushdown is no longer
    // refused up front ("not available on Lobu Cloud"). Instead the
    // injected block-private policy takes over — and the test DB is on loopback
    // (and/or sslmode=disable), so egress is rejected before any socket opens.
    // That is the cloud security boundary now. A pushdown failure surfaces as a
    // thrown hard error (#2042).
    //
    // The denial moved with the transport: it is now the isolate host's
    // `socketOpen` that refuses, not the connector-side db-egress guard, so the
    // wording changed. Match on the policy decision rather than one
    // implementation's phrasing — the assertion that matters is that loopback
    // was refused and the reason names the policy that refused it.
    process.env.LOBU_CLOUD_MODE = '1';
    try {
      const err = (await querySql({ sql: 'SELECT 1', connection: 'qsp-ext-db' }, {}, ctx).catch(
        (e) => e
      )) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toMatch(/Lobu Cloud/i);
      expect(err.message).toMatch(/EgressDenied|blocked internal\/metadata|TLS is required/i);
      expect(err.message).toMatch(/block-private|internal\/metadata|TLS is required/i);
    } finally {
      process.env.LOBU_CLOUD_MODE = undefined;
    }
  }, 60_000);
});
