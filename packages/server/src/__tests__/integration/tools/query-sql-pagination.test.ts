/**
 * query_sql internal-path pagination contract.
 *
 * The internal path runs the scoped subquery ONCE and carries the total via a
 * `COUNT(*) OVER ()` window column instead of a second full COUNT pass (the
 * scoped subquery can be expensive — derived views aggregate large event
 * ranges). Two fallbacks keep the legacy contract exact, and this file pins
 * them:
 *
 *  1. Empty / out-of-range pages carry no row to bear the window count, so an
 *     explicit COUNT runs for them — `total_count` must stay exact (and
 *     `has_more` false), never collapse to 0.
 *  2. If the caller's own query projects a column named like the internal
 *     window alias (`__lobu_total_count__`), the tool falls back to the plain
 *     two-query shape — the caller's column survives untouched, exactly once,
 *     and `total_count` is still exact.
 *
 * It also pins the plan shape of the org-scoping CTEs: Postgres materializes a
 * CTE referenced more than once, so a caller self-join (`... NOT EXISTS (SELECT
 * 1 FROM events s ...)`) used to copy every visible row of the organization
 * before applying the caller's own `id IN (...)`, and timed out at 5s on a
 * large workspace. Every scope CTE over a large table must be inlined into each
 * reference. The small config tables whose scope predicate a caller predicate
 * could outrank are materialized instead, and a failed read never echoes a
 * database error that can quote a row outside the caller's scope.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import { querySql } from '../../../tools/admin/query_sql';
import { validateAndScopeQuery } from '../../../utils/execute-data-sources';
import { QUERYABLE_TABLE_NAMES, SAFE_COLUMN_DEFS } from '../../../utils/table-schema';
import logger from '../../../utils/logger';
import type { ToolContext } from '../../../tools/registry';
import { QUERY_SQL_RESULT_MAX_BYTES } from '../../../utils/content-read-bounds';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('query_sql internal-path pagination contract', () => {
  let orgId: string;
  let orgSlug: string;
  let ownerCtx: ToolContext;
  let ownerId: string;
  const eventIds: number[] = [];

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'QuerySqlPagination' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'qsql-page@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerCtx = ownerToolContext(orgId, user.id);
    ownerId = user.id;

    for (let i = 0; i < 5; i++) {
      const event = await createTestEvent({
        organization_id: orgId,
        content: `pagination event ${i}`,
        title: `pagination event ${i}`,
      });
      eventIds.push(event.id);
    }
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('reports exact total_count and has_more across in-range pages', async () => {
    const res = await querySql({ sql: 'SELECT id FROM events', limit: 2, offset: 0 }, {}, ownerCtx);
    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(2);
    expect(res.total_count).toBe(5);
    expect(res.has_more).toBe(true);
    expect(res.omitted_rows).toBeUndefined();
    // A successful query carries no error taxonomy.
    expect(res.error_code).toBeUndefined();
    expect(res.retryable).toBeUndefined();
    // The internal window column must never leak into rows or columns.
    expect(res.columns.map((c) => c.name)).not.toContain('__lobu_total_count__');
    expect(Object.keys(res.rows[0])).not.toContain('__lobu_total_count__');
  });

  it('does not bind an unused organization parameter for table-free reads', async () => {
    const res = await querySql(
      { sql: 'SELECT generate_series(1, 25) AS row_number', limit: 50 },
      {},
      ownerCtx
    );

    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(25);
    expect(res.total_count).toBe(25);
    expect(res.rows[0]).toEqual({ row_number: 1 });
    expect(res.rows[24]).toEqual({ row_number: 25 });
  });

  it('caps the serialized dynamic row list and reports omitted rows as more data', async () => {
    const res = await querySql(
      {
        sql: "SELECT generate_series(1, 500) AS id, repeat('x', 8000) AS body",
        limit: 500,
      },
      {},
      ownerCtx
    );

    expect(res.error).toBeUndefined();
    expect(res.total_count).toBe(500);
    expect(res.rows.length).toBeLessThan(500);
    expect(res.omitted_rows).toBe(500 - res.rows.length);
    expect(res.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('rejects incompatible caller-projected truncation sidecars', async () => {
    const res = await querySql(
      {
        sql: `SELECT repeat('x', 5000) AS payload_text,
          false AS payload_truncated, 7 AS content_length`,
        limit: 1,
      },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.retryable).toBe(false);
    expect(res.error).toContain('content_length, payload_truncated');
  });

  it('fails closed when one bounded row cannot fit under the hard ceiling', async () => {
    const wideColumns = Array.from(
      { length: 280 },
      (_, index) => `repeat('x', 4000) AS pad_${index}`
    ).join(', ');
    const res = await querySql(
      { sql: `SELECT ${wideColumns}`, limit: 1 },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.total_count).toBe(1);
    expect(res.has_more).toBe(false);
    expect(res.omitted_rows).toBe(1);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.retryable).toBe(false);
    expect(res.error).toContain('Select fewer or narrower columns');
  });

  it('counts the response envelope when deciding whether one bounded row fits', async () => {
    const wideColumns = Array.from(
      { length: 260 },
      (_, index) => `repeat('x', 4000) AS pad_${index}`
    ).join(', ');
    const res = await querySql(
      { title: 'W'.repeat(200), sql: `SELECT ${wideColumns}`, limit: 1 },
      {},
      ownerCtx
    );

    expect(res.error_code).toBe('VALIDATION');
    expect(res.sql).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('fails closed within the ceiling when an empty result has an oversized echoed SQL envelope', async () => {
    const oversizedComment = 'x'.repeat(QUERY_SQL_RESULT_MAX_BYTES);
    const res = await querySql(
      {
        title: 'T'.repeat(200),
        sql: `/* ${oversizedComment} */ SELECT 1 AS id WHERE false`,
        limit: 1,
      },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.error).toContain('response envelope exceeds');
    expect(res.sql).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('routes oversized early validation errors through the same response ceiling', async () => {
    const res = await querySql(
      {
        sql: 'SELECT 1 AS id',
        sort_by: `${'x'.repeat(QUERY_SQL_RESULT_MAX_BYTES)}-`,
      },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.error).toContain('response envelope exceeds');
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('keeps total_count exact on an out-of-range offset (empty page fallback)', async () => {
    const res = await querySql(
      { sql: 'SELECT id FROM events', limit: 2, offset: 100 },
      {},
      ownerCtx
    );
    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(0);
    // No row carries the window count here — the explicit COUNT fallback must
    // still report the true total, not 0.
    expect(res.total_count).toBe(5);
    expect(res.has_more).toBe(false);
  });

  it('reports total_count 0 when nothing matches', async () => {
    const res = await querySql(
      { sql: "SELECT id FROM events WHERE title = 'no such title anywhere'", limit: 2 },
      {},
      ownerCtx
    );
    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(0);
    expect(res.total_count).toBe(0);
    expect(res.has_more).toBe(false);
  });

  it('preserves a caller-projected __lobu_total_count__ column (alias collision fallback)', async () => {
    const res = await querySql(
      { sql: 'SELECT id, 42 AS "__lobu_total_count__" FROM events', limit: 2, offset: 0 },
      {},
      ownerCtx
    );
    expect(res.error).toBeUndefined();
    // The caller's column survives untouched, exactly once.
    const colNames = res.columns.map((c) => c.name);
    expect(colNames.filter((n) => n === '__lobu_total_count__')).toHaveLength(1);
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) {
      expect(row.__lobu_total_count__).toBe(42);
    }
    // And the real total is still exact via the fallback COUNT.
    expect(res.total_count).toBe(5);
    expect(res.has_more).toBe(true);
  });

  describe('org-scoping CTEs over large tables are inlined', () => {
    /** Plan node types of the scoped statement query_sql executes. */
    async function planNodeTypes(query: string): Promise<string[]> {
      const scoped = validateAndScopeQuery(query, orgId, {
        safeColumns: SAFE_COLUMN_DEFS,
        userId: ownerId,
      });
      const [row] = await getTestDb().unsafe(
        `EXPLAIN (FORMAT JSON) SELECT * FROM (${scoped.sql}) AS _t LIMIT 50`,
        scoped.params as never
      );
      const types: string[] = [];
      const walk = (node: Record<string, unknown>) => {
        types.push(String(node['Node Type']));
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
      };
      walk((row['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0].Plan);
      return types;
    }

    it('materializes only the small config tables scoped through another relation', async () => {
      const materialized: string[] = [];
      for (const table of [...QUERYABLE_TABLE_NAMES].sort()) {
        const types = await planNodeTypes(`SELECT 1 FROM "${table}" a, "${table}" b LIMIT 1`);
        if (types.includes('CTE Scan')) materialized.push(table);
      }
      expect(materialized).toEqual([
        'automation_versions',
        'connections',
        'entity_relationship_types',
        'feeds',
        'user',
      ]);
    });

    it('answers an events self-join by id through the scope', async () => {
      const wanted = eventIds.slice(0, 2);
      const query = `SELECT e.id FROM events e WHERE e.id IN (${wanted.join(', ')})
        AND NOT EXISTS (SELECT 1 FROM events s WHERE s.supersedes_event_id = e.id)`;
      expect(await planNodeTypes(query)).not.toContain('CTE Scan');

      const res = await querySql({ sql: query, sort_by: 'id' }, {}, ownerCtx);
      expect(res.error).toBeUndefined();
      expect(res.rows.map((row) => Number(row.id))).toEqual(wanted);
      expect(res.total_count).toBe(2);
    });
  });

  describe('error taxonomy (lobu#2051 item 2)', () => {
    it('tags a data-modifying CTE (read-only violation) as VALIDATION, not retryable', async () => {
      const res = await querySql(
        { sql: 'WITH x AS (DELETE FROM events RETURNING id) SELECT count(*) AS n FROM x' },
        {},
        ownerCtx
      );
      expect(res.error).toBeTruthy();
      expect(res.error_code).toBe('VALIDATION');
      expect(res.retryable).toBe(false);
    });

    it('tags a disallowed table reference as a non-retryable code', async () => {
      const res = await querySql({ sql: 'SELECT access_token FROM oauth_tokens LIMIT 1' }, {}, ownerCtx);
      expect(res.error).toBeTruthy();
      expect(res.error_code).toBeTruthy();
      expect(res.retryable).toBe(false);
    });

    it('marks an unknown-table result as an MCP error and renders the cause', async () => {
      const user = await createTestUser({ email: 'qsql-mcp@test.com' });
      await addUserToOrganization(user.id, orgId, 'owner');
      const client = await createTestOAuthClient();
      const { token } = await createTestAccessToken(user.id, orgId, client.client_id, {
        scope: 'mcp:read profile:read',
      });
      const path = `/mcp/${orgSlug}`;
      const init = await post(path, {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'lobu-test', version: '1.0' },
          },
        },
        token,
      });
      const sessionId = init.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      await post(path, {
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
        headers: { 'mcp-session-id': sessionId! },
        token,
      });

      const response = await post(path, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'query_sql', arguments: { sql: 'SELECT platform FROM conversations' } },
        },
        headers: { 'mcp-session-id': sessionId! },
        token,
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain('conversations');
      expect(body.result?.content?.[0]?.text).toMatch(/queryable tables/i);
      expect(body.result?.content?.[0]?.text).not.toContain('SQL Query Results');
    });
  });

  describe('view read guardrails (`useQuery` calls query_sql with limit 500)', () => {
    let memberCtx: ToolContext;

    beforeAll(async () => {
      const member = await createTestUser({ email: 'qsql-view-member@test.com' });
      await addUserToOrganization(member.id, orgId, 'member');
      memberCtx = {
        organizationId: orgId,
        userId: member.id,
        memberRole: 'member',
        agentId: null,
        isAuthenticated: true,
        clientId: null,
        scopes: ['mcp:read'],
        tokenType: 'oauth',
        scopedToOrg: true,
        allowCrossOrg: false,
      } as unknown as ToolContext;
    });

    it('caps a large result at 500 rows and reports the rest as has_more', async () => {
      const res = await querySql({ sql: 'SELECT generate_series(1, 1200) AS n', limit: 500 }, {}, memberCtx);
      expect(res.error).toBeUndefined();
      expect(res.rows).toHaveLength(500);
      expect(res.has_more).toBe(true);
      expect(res.total_count).toBe(1200);
    });

    it('stops an unbounded statement at the timeout with a typed retryable code', async () => {
      // The returned failure is the tool span's to report; an error-level log
      // of the same timeout would open a second issue under another scope.
      const errorLog = vi.spyOn(logger, 'error');
      const started = Date.now();
      const res = await querySql(
        {
          sql: 'SELECT count(*) AS n FROM generate_series(1, 1000000) a CROSS JOIN generate_series(1, 1000000) b',
          limit: 500,
        },
        {},
        memberCtx
      );
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(res.rows).toEqual([]);
      expect(res.error_code).toBe('UPSTREAM_TIMEOUT');
      expect(res.retryable).toBe(true);
      expect(errorLog).not.toHaveBeenCalled();
      errorLog.mockRestore();
    }, 30_000);
  });

  describe('a failed read never echoes rows outside the caller scope', () => {
    // Synthetic values another organization (or another member) stores. An
    // inlined scope CTE lets a cheap caller predicate run on a row before the
    // scope predicate removes it, so a database error raised from that row's
    // value must never reach the caller.
    const OTHER_ORG_EVENT_MARKER = 'synthetic_other_org_event_marker_5d1e';
    const OTHER_ORG_PROMPT_MARKER = 'synthetic_other_org_prompt_marker_9b3c';
    const PRIVATE_CONNECTION_MARKER = 'synthetic_private_connection_marker_2a7f';
    const OTHER_ORG_USER_MARKER = 'synthetic_other_org_user_marker_e48a';
    const OTHER_ORG_RELATIONSHIP_MARKER = 'synthetic_other_org_relationship_marker_31f9';
    const PRIVATE_EVENT_MARKER = 'synthetic_private_event_marker_6c0d';
    const MARKERS = [
      OTHER_ORG_EVENT_MARKER,
      OTHER_ORG_PROMPT_MARKER,
      OTHER_ORG_USER_MARKER,
      OTHER_ORG_RELATIONSHIP_MARKER,
      PRIVATE_CONNECTION_MARKER,
      PRIVATE_EVENT_MARKER,
    ];
    let otherOrgEventId: number;
    let otherOwnerId: string;
    let privateConnectionId: number;
    let privateEventId: number;
    let privateOrgMemberCtx: ToolContext;

    /** Every probe's failure text that names a value the caller cannot read. */
    const leaks = (failures: Array<{ probe: string; message: unknown }>) =>
      failures.filter(({ message }) => MARKERS.some((marker) => String(message ?? '').includes(marker)));

    beforeAll(async () => {
      const sql = getTestDb();
      const otherOrg = await createTestOrganization({ name: 'QuerySqlOtherOrg', visibility: 'private' });
      const otherOwner = await createTestUser({
        email: 'qsql-other-owner@test.com',
        name: OTHER_ORG_USER_MARKER,
      });
      otherOwnerId = otherOwner.id;
      await addUserToOrganization(otherOwner.id, otherOrg.id, 'owner');
      await sql`
        INSERT INTO entity_relationship_types (id, slug, name, description, organization_id)
        VALUES (
          (SELECT COALESCE(MAX(id), 0) + 1 FROM entity_relationship_types), 'synthetic_probe_type',
          'Probe', ${OTHER_ORG_RELATIONSHIP_MARKER}, ${otherOrg.id}
        )
      `;
      otherOrgEventId = (
        await createTestEvent({ organization_id: otherOrg.id, content: OTHER_ORG_EVENT_MARKER })
      ).id;
      // Each organization owns versions; the caller's own prompts cast cleanly,
      // so only the other organization's row can raise. The caller's org needs
      // enough Automations that the planner scans versions before the join.
      const insertAutomation = async (organizationId: string, createdBy: string, prompt: string) => {
        const [automation] = await sql`
          INSERT INTO automations (
            id, name, slug, organization_id, entity_ids, triggers, model_config, sources,
            version, status, created_by, automation_group_id
          ) VALUES (
            (SELECT COALESCE(MAX(id), 0) + 1 FROM automations), 'Probe', ${`probe-${organizationId}`},
            ${organizationId}, '{}'::bigint[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 1, 'active',
            ${createdBy}, (SELECT COALESCE(MAX(id), 0) + 1 FROM automations)
          )
          RETURNING id
        `;
        await sql`
          INSERT INTO automation_versions (
            id, automation_id, version, name, prompt, version_sources, created_by
          ) VALUES (
            (SELECT COALESCE(MAX(id), 0) + 1 FROM automation_versions), ${automation.id}, 1,
            'Probe', ${prompt}, '[]'::jsonb, ${createdBy}
          )
        `;
      };
      await insertAutomation(orgId, ownerId, '7');
      await insertAutomation(otherOrg.id, otherOwner.id, OTHER_ORG_PROMPT_MARKER);
      await sql`
        INSERT INTO automations (
          id, name, slug, organization_id, entity_ids, triggers, model_config, sources,
          version, status, created_by, automation_group_id
        )
        SELECT base.n + g, 'Probe', 'probe-bulk-' || g, ${orgId}, '{}'::bigint[], '[]'::jsonb,
          '{}'::jsonb, '[]'::jsonb, 1, 'active', ${ownerId}, base.n + g
        FROM (SELECT MAX(id) AS n FROM automations) base, generate_series(1, 300) g
      `;
      await sql`
        INSERT INTO automation_versions (id, automation_id, version, name, prompt, version_sources, created_by)
        SELECT base.n + row_number() OVER (), a.id, 1, 'Probe', '7', '[]'::jsonb, ${ownerId}
        FROM (SELECT MAX(id) AS n FROM automation_versions) base, automations a
        WHERE a.slug LIKE 'probe-bulk-%'
      `;
      await sql`ANALYZE automations`;
      await sql`ANALYZE automation_versions`;

      // Within one organization: a private connection and its events are
      // hidden from every member but the connection's creator.
      const privateOrg = await createTestOrganization({ name: 'QuerySqlPrivateConnection' });
      const creator = await createTestUser({ email: 'qsql-private-creator@test.com' });
      await addUserToOrganization(creator.id, privateOrg.id, 'owner');
      const member = await createTestUser({ email: 'qsql-private-member@test.com' });
      await addUserToOrganization(member.id, privateOrg.id, 'member');
      const connection = await createTestConnection({
        organization_id: privateOrg.id,
        connector_key: 'test',
        display_name: PRIVATE_CONNECTION_MARKER,
        created_by: creator.id,
        visibility: 'private',
      });
      privateConnectionId = connection.id;
      privateEventId = (
        await createTestEvent({
          organization_id: privateOrg.id,
          connection_id: connection.id,
          content: PRIVATE_EVENT_MARKER,
        })
      ).id;
      privateOrgMemberCtx = {
        ...ownerToolContext(privateOrg.id, member.id),
        memberRole: 'member',
        scopes: ['mcp:read'],
      } as ToolContext;
    });

    const otherOrgProbes = () => [
      `SELECT id FROM events WHERE id = ${otherOrgEventId} AND timezone(payload_text, now()) IS NULL`,
      `SELECT id FROM events WHERE id = ${otherOrgEventId} AND payload_text::regclass IS NULL`,
      'SELECT id FROM automation_versions WHERE prompt::int = 1',
      `SELECT a.id FROM events a JOIN events b ON b.id = a.id
        WHERE a.id = ${otherOrgEventId} AND timezone(a.payload_text, now()) IS NULL`,
      `SELECT a.id FROM automation_versions a JOIN automation_versions b ON b.id = a.id
        WHERE a.prompt::int = 1`,
      `SELECT id FROM "user" WHERE id = '${otherOwnerId}' AND name::regclass IS NULL`,
      `SELECT id FROM entity_relationship_types
        WHERE slug = 'synthetic_probe_type' AND description::regclass IS NULL`,
    ];

    it('query_sql does not echo another organization’s values', async () => {
      const failures = [];
      for (const probe of otherOrgProbes()) {
        const res = await querySql({ sql: probe }, {}, ownerCtx);
        expect(res.rows).toEqual([]);
        failures.push({ probe, message: res.error });
      }
      expect(leaks(failures)).toEqual([]);
    });

    it('client.query does not echo another organization’s values', async () => {
      const sdk = buildClientSDK(ownerCtx, {} as Env, { mode: 'read' });
      const failures = [];
      for (const probe of otherOrgProbes()) {
        const message = await sdk.query(probe).then(
          (rows) => JSON.stringify(rows),
          (error: Error) => error.message
        );
        failures.push({ probe, message });
      }
      expect(leaks(failures)).toEqual([]);
    });

    it('query_sql does not echo a value a member cannot see in their own organization', async () => {
      const failures = [];
      for (const probe of [
        `SELECT id FROM connections WHERE id = ${privateConnectionId} AND display_name::regclass IS NULL`,
        `SELECT id FROM events WHERE id = ${privateEventId} AND timezone(payload_text, now()) IS NULL`,
      ]) {
        const res = await querySql({ sql: probe }, {}, privateOrgMemberCtx);
        expect(res.rows).toEqual([]);
        failures.push({ probe, message: res.error });
      }
      expect(leaks(failures)).toEqual([]);
    });

    it('keeps the SQLSTATE and retryability of a data error the caller raised', async () => {
      const res = await querySql({ sql: "SELECT ('x' || id)::int AS v FROM events" }, {}, ownerCtx);
      expect(res.error).toContain('22P02');
      expect(res.error_code).toBe('VALIDATION');
      expect(res.retryable).toBe(false);
    });

    it('keeps a parse error that names only the caller’s own statement', async () => {
      const res = await querySql({ sql: 'SELECT id FROM events WHERE id = now()' }, {}, ownerCtx);
      expect(res.error).toContain('operator does not exist');
      expect(res.error_code).toBe('VALIDATION');
    });

    it('filters a join-scoped config table to the organization before any caller predicate', async () => {
      // A clean result, not merely a clean message: the caller predicate never
      // sees another organization's version row, so it cannot raise on one.
      const res = await querySql(
        {
          sql: `SELECT id FROM automation_versions
            WHERE (CASE WHEN prompt = '${OTHER_ORG_PROMPT_MARKER}' THEN 1 / (id - id) ELSE 0 END) = 0`,
        },
        {},
        ownerCtx
      );
      expect(res.error).toBeUndefined();
      expect(res.rows.length).toBeGreaterThan(0);
    });
  });
});
