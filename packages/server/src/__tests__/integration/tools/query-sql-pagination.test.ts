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
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { QUERY_SQL_RESULT_MAX_BYTES } from '../../../utils/content-read-bounds';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
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

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'QuerySqlPagination' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'qsql-page@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerCtx = ownerToolContext(orgId, user.id);

    for (let i = 0; i < 5; i++) {
      await createTestEvent({
        organization_id: orgId,
        content: `pagination event ${i}`,
        title: `pagination event ${i}`,
      });
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
    }, 30_000);
  });
});
