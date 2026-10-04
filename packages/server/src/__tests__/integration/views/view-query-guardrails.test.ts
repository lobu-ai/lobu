/**
 * The guardrails a view's `useQuery(sql`…`)` read runs under. `@lobu/views`
 * calls `query_sql` with `limit: 500` on every render; this drives the real
 * handler against real Postgres with that exact argument shape and pins the
 * two bounds the view runtime surfaces: the 500-row page cap is reported as
 * `has_more` (the guest's `truncated`), and the statement timeout comes back
 * as the typed `UPSTREAM_TIMEOUT` code (the guest's `errorCode`), never as a
 * hang or a success-shaped empty result.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

let organizationId: string;
let userId: string;

function memberCtx(): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'member',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as unknown as ToolContext;
}

/** The exact call `useQuery(sql`…`)` makes. */
async function viewRead(sqlText: string) {
  return (await querySql({ sql: sqlText, limit: 500 }, {} as never, memberCtx())) as {
    rows: Array<Record<string, unknown>>;
    has_more: boolean;
    total_count: number;
    error?: string;
    error_code?: string;
    retryable?: boolean;
  };
}

describe('view query guardrails (query_sql as a view calls it)', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'View Guardrails Org' });
    const user = await createTestUser({ email: 'view-guardrails@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'member');
    organizationId = org.id;
    userId = user.id;
  });

  it('caps a large result at 500 rows and reports the rest as has_more', async () => {
    const result = await viewRead('SELECT generate_series(1, 1200) AS n');
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(500);
    expect(result.has_more).toBe(true);
    expect(result.total_count).toBe(1200);
  });

  it('a result under the cap is complete', async () => {
    const result = await viewRead('SELECT generate_series(1, 3) AS n');
    expect(result.rows).toHaveLength(3);
    expect(result.has_more).toBe(false);
  });

  it('stops an unbounded statement at the timeout with a typed code', async () => {
    const started = Date.now();
    const result = await viewRead(
      'SELECT count(*) AS n FROM generate_series(1, 1000000) a CROSS JOIN generate_series(1, 1000000) b'
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.rows).toEqual([]);
    expect(result.error_code).toBe('UPSTREAM_TIMEOUT');
    expect(result.retryable).toBe(true);
  }, 30_000);
});
