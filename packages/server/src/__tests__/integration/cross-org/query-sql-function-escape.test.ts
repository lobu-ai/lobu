/**
 * query_sql must not reach another organization through a function that reads
 * a relation by name or runs a query given as text. Org scoping shadows table
 * NAMES with org-filtered CTEs; `query_to_xml('SELECT … FROM public.entities')`
 * carries its table inside a string, so the scoping never sees it and the
 * inner query reads every organization's rows.
 *
 * Drives the real handler against real Postgres, as a member of one org with a
 * second org's entity in the same database. The unit sibling
 * (scoped-query-schema-rejection.test.ts) covers each function's parse shape.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
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
    scopes: ['mcp:read', 'mcp:write'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as unknown as ToolContext;
}

async function run(sqlText: string) {
  return (await querySql({ sql: sqlText }, {} as never, memberCtx())) as {
    rows?: Array<Record<string, unknown>>;
    error?: string;
  };
}

describe('query_sql function escape', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const mine = await createTestOrganization({ name: 'Escape Home Org' });
    const other = await createTestOrganization({ name: 'Escape Other Org' });
    const user = await createTestUser({ email: 'escape-member@test.example.com' });
    await addUserToOrganization(user.id, mine.id, 'member');
    organizationId = mine.id;
    userId = user.id;
    await createTestEntity({ name: 'Home record', organization_id: mine.id });
    await createTestEntity({ name: 'Other org secret', organization_id: other.id });
  });

  it('scoped reads see only the caller org', async () => {
    const result = await run('SELECT name FROM entities');
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.rows)).not.toContain('Other org secret');
  });

  it.each([
    "SELECT query_to_xml('SELECT name FROM public.entities', true, false, '')::text AS x",
    "SELECT name FROM entities WHERE query_to_xml('SELECT name FROM public.entities', true, false, '')::text LIKE '%Other org secret%'",
    "SELECT table_to_xml('public.entities'::regclass, true, false, '')::text AS x",
  ])('rejects %s without reading the other org', async (sqlText) => {
    const result = await run(sqlText);
    expect(result.error).toMatch(/not allowed/i);
    expect(JSON.stringify(result)).not.toContain('Other org secret');
  });
});
