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
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

let organizationId: string;
let userId: string;
let otherEventId: number;
let otherEntityId: number;

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
    otherEntityId = Number((await createTestEntity({ name: 'Other org secret', organization_id: other.id })).id);
    await createTestEvent({ organization_id: mine.id, content: 'Home event', title: 'Home event' });
    otherEventId = Number(
      (await createTestEvent({ organization_id: other.id, content: 'Other org payroll', title: 'Other org payroll' })).id
    );
  });

  it('scoped reads see only the caller org', async () => {
    const result = await run('SELECT name FROM entities');
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.rows)).not.toContain('Other org secret');
    const events = await run('SELECT title FROM events');
    expect(events.error).toBeUndefined();
    expect(events.rows).toEqual([{ title: 'Home event' }]);
  });

  it('every relation member SQL may read is fenced by row-level security', async () => {
    const relations = await getTestDb()<Array<{ relname: string; relkind: string; fenced: boolean }>>`
      SELECT c.relname, c.relkind::text AS relkind,
        CASE c.relkind
          WHEN 'v' THEN coalesce('security_invoker=true' = ANY(c.reloptions), false)
          ELSE c.relrowsecurity AND EXISTS (
            SELECT 1 FROM pg_policy p
            WHERE p.polrelid = c.oid AND NOT p.polpermissive
              AND p.polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'lobu_member_sql')]
          )
        END AS fenced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND has_table_privilege('lobu_member_sql', c.oid, 'SELECT')
    `;
    expect(relations.map((r) => r.relname)).toContain('events');
    expect(relations.filter((r) => !r.fenced)).toEqual([]);
  });

  it.each([
    "SELECT query_to_xml('SELECT name FROM public.entities', true, false, '')::text AS x",
    "SELECT name FROM entities WHERE query_to_xml('SELECT name FROM public.entities', true, false, '')::text LIKE '%Other org secret%'",
    "SELECT table_to_xml('public.entities'::regclass, true, false, '')::text AS x",
    // A Unicode-escaped identifier spells a forbidden name without its letters.
    `SELECT 1 AS u, U&"query\\005Fto\\005Fxml"('SELECT name FROM public.entities', true, false, '')::text AS x`,
    `SELECT 1 AS u, U&"set\\005Fconfig"('statement_timeout', '0', true) AS v`,
  ])('rejects %s without reading the other org', async (sqlText) => {
    const result = await run(sqlText);
    expect(result.error).toMatch(/not allowed/i);
    expect(JSON.stringify(result)).not.toContain('Other org secret');
  });

  // Scope CTEs are inlined, so the planner may evaluate a caller predicate on a
  // row before the scope predicate removes it. An error raised by that row's
  // value is a one-bit answer about another workspace's data, even with the
  // error text withheld: guess right and the query fails, guess wrong and it
  // returns nothing. Both guesses must look the same.
  it.each([
    ['events', () => otherEventId, (guess: string) => `1/(CASE WHEN title LIKE '${guess}%' THEN 0 ELSE 1 END) = 1`],
    ['events', () => otherEventId, (guess: string) => `1/(CASE WHEN title = '${guess}' THEN 0 ELSE 1 END) = 1`],
    ['entities', () => otherEntityId, (guess: string) => `1/(CASE WHEN name LIKE '${guess}%' THEN 0 ELSE 1 END) = 1`],
  ])("a predicate on another workspace's %s row answers nothing", async (table, id, predicate) => {
    const right = table === 'events' ? 'Other org payroll' : 'Other org secret';
    const probe = (guess: string) => run(`SELECT 1 AS x FROM ${table} WHERE id = ${id()} AND ${predicate(guess)}`);
    const hit = await probe(right);
    const miss = await probe('no match');
    expect({ error: hit.error, rows: hit.rows }).toEqual({ error: undefined, rows: [] });
    expect({ error: miss.error, rows: miss.rows }).toEqual({ error: undefined, rows: [] });
  });

  it("a cast on another workspace's event row raises nothing", async () => {
    const result = await run(`SELECT 1 AS x FROM events WHERE id = ${otherEventId} AND title::int = 1`);
    expect(result.error).toBeUndefined();
    expect(result.rows).toEqual([]);
  });
});
