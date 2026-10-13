/**
 * Plan-shape regression guard for the org-wide activity feed, its count,
 * exact text search, and substring recall.
 *
 * The date feed's direct arm must use the ordered organization index; counts
 * and searches may use any organization-keyed index. The linked arm must use
 * the live linked-org GIN. Combining the scopes in one OR can prevent an
 * ordered org-bounded scan and lead to filtering every live event. The SQL
 * under test is captured from the production builders, not restated here.
 *
 * Another organization holds most of the seeded history, so a scan that is not
 * org-bounded is visibly the wrong plan. Wall-clock timing is deliberately not
 * an assertion.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { listContentInternal } from '../../../utils/content-search/list-path';
import { searchContentBySingleQuery } from '../../../utils/content-search/search-path';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const FEED_EVENTS = 3_000;
const OTHER_EVENTS = 60_000;
const LINKED_EVENTS = 200;

interface CapturedQuery {
  query: string;
  params: unknown[];
}

/** Delegate to the real client while recording every `unsafe` statement. */
function capturingClient(inner: ReturnType<typeof getTestDb>, captured: CapturedQuery[]): DbClient {
  const wrap = (client: DbClient): DbClient =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'unsafe') {
          return (query: string, params: unknown[] = [], options?: unknown) => {
            captured.push({ query, params });
            return target.unsafe(query, params, options);
          };
        }
        if (prop === 'begin') {
          return <T>(fn: (tx: DbClient) => Promise<T>) => target.begin((tx) => fn(wrap(tx)));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  return wrap(inner as unknown as DbClient);
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Recheck Cond'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}

async function planOf({ query, params }: CapturedQuery, analyze = false): Promise<PlanNode[]> {
  const sql = getTestDb() as unknown as DbClient;
  const rows = await sql.unsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
    `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, TIMING OFF, ' : ''}FORMAT JSON) ${query}`,
    params
  );
  const nodes: PlanNode[] = [];
  const visit = (node: PlanNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(rows[0]['QUERY PLAN'][0].Plan);
  return nodes;
}

function expectIndexConditions(plan: PlanNode[], indexName: string, condition: RegExp): void {
  const scans = plan.filter((node) => node['Index Name'] === indexName);
  expect(scans.length).toBeGreaterThan(0);
  for (const scan of scans) expect(scan['Index Cond'] ?? '').toMatch(condition);
}

function expectOrgBounded(plan: PlanNode[]): void {
  expect(
    plan.filter((node) => node['Relation Name'] === 'events' && node['Node Type'] === 'Seq Scan')
  ).toEqual([]);
  expect(
    plan.some((node) =>
      (node['Relation Name'] === 'events' || node['Index Name']?.includes('events')) &&
      /organization_id =/.test(node['Index Cond'] ?? '')
    )
  ).toBe(true);
  expectIndexConditions(plan, 'idx_events_live_linked_org_ids', /linked_org_ids @>/);
}

describe('activity feed queries stay organization-bounded', () => {
  let feedOrgId: string;
  const previousFlag = process.env.LOBU_LINKED_ORG_SCOPE;

  beforeAll(async () => {
    process.env.LOBU_LINKED_ORG_SCOPE = '1';
    await cleanupTestDatabase();
    const sql = getTestDb();
    const feedOrg = await createTestOrganization({ name: 'Feed Plan Org' });
    const otherOrg = await createTestOrganization({ name: 'Feed Plan Other Org' });
    feedOrgId = feedOrg.id;

    const seed = (orgId: string, count: number, linkedTo: string | null, substringRows: number) => sql`
      INSERT INTO events (organization_id, semantic_type, payload_text, occurred_at, linked_org_ids, origin_id)
      SELECT ${orgId}, 'content', 'feed plan row ' || g || ' plan-marker'
               || CASE WHEN g <= ${substringRows} THEN ' xrarecorpz' ELSE '' END,
             now() - (g * interval '1 minute'),
             CASE WHEN ${linkedTo}::text IS NULL THEN '{}'::text[] ELSE ARRAY[${linkedTo}::text] END,
             CASE WHEN ${linkedTo}::text IS NULL THEN 'direct-' ELSE 'linked-' END || g
      FROM generate_series(1, ${count}) AS g
    `;
    await seed(feedOrg.id, FEED_EVENTS, null, 4);
    await seed(otherOrg.id, LINKED_EVENTS, feedOrg.id, 1);
    // The substring is common globally but rare in the caller's scope. The
    // eligible hits have lower ids than the unrelated history, so a backwards
    // primary-key scan must walk all of that history to find fewer than its cap.
    await seed(otherOrg.id, OTHER_EVENTS, null, OTHER_EVENTS);
    await sql`ANALYZE events`;
  }, 120_000);

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.LOBU_LINKED_ORG_SCOPE;
    else process.env.LOBU_LINKED_ORG_SCOPE = previousFlag;
    await cleanupTestDatabase();
  });

  async function captureFeed(): Promise<{ list: CapturedQuery; count: CapturedQuery }> {
    const captured: CapturedQuery[] = [];
    const page = await listContentInternal(
      capturingClient(getTestDb(), captured),
      { organization_id: feedOrgId, sort_by: 'date', sort_order: 'desc' },
      30,
      0
    );
    // The page itself must include linked rows, or the linked arm is untested.
    expect(page.total).toBe(FEED_EVENTS + LINKED_EVENTS);
    expect(page.content).toHaveLength(30);
    expect(page.content.some((row) => row.origin_id.startsWith('linked-'))).toBe(true);
    expect(page.content.some((row) => row.origin_id.startsWith('direct-'))).toBe(true);
    const count = captured.find((c) => /^\s*SELECT\s*\(SELECT COUNT\(\*\)/.test(c.query));
    const list = captured.find((c) => /candidate_set AS/.test(c.query));
    if (!count || !list) {
      throw new Error(
        `feed did not issue a count and a list query: ${captured.map((c) => c.query.trim().slice(0, 60)).join(' | ')}`
      );
    }
    return { list, count };
  }

  it('the feed page reads each org-scope arm off its own index', async () => {
    const plan = await planOf((await captureFeed()).list);
    expectOrgBounded(plan);
    expectIndexConditions(plan, 'idx_events_live_org_effective_date', /organization_id =/);
    // ANDing in a predicate-only scan of the live btree reads every live entry.
    expect(plan.some((node) => node['Node Type'] === 'BitmapAnd')).toBe(false);
  });

  it('the feed count reads each org-scope arm off its own index', async () => {
    const plan = await planOf((await captureFeed()).count);
    // Any organization-keyed index bounds the count; order does not matter here.
    expectOrgBounded(plan);
    expect(plan.some((node) => node['Node Type'] === 'BitmapAnd')).toBe(false);
  });

  it('exact text search reads the direct arm by organization', async () => {
    const captured: CapturedQuery[] = [];
    const result = await searchContentBySingleQuery(
      capturingClient(getTestDb(), captured),
      'plan-marker',
      { organization_id: feedOrgId, sort_by: 'score', limit: 30 }
    );
    expect(result.total).toBe(FEED_EVENTS + LINKED_EVENTS);
    const search = captured.find((c) => /filtered_ids AS/.test(c.query));
    if (!search) throw new Error('search did not issue a filtered_ids query');
    const plan = await planOf(search);
    expectOrgBounded(plan);
    expect(plan.some((node) => node['Node Type'] === 'BitmapOr')).toBe(false);
  });

  it('substring recall bounds scanned history when a globally common term is rare in scope', async () => {
    const captured: CapturedQuery[] = [];
    const result = await searchContentBySingleQuery(
      capturingClient(getTestDb(), captured),
      'corp',
      {
        organization_id: feedOrgId,
        sort_by: 'score',
        limit: 30,
        include_total: false,
        approximate_candidate_search: true,
        query_embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0),
      }
    );
    // 'corp' occurs inside a lexeme, so only substring recall can find these
    // rows. Keep both direct and linked hits without admitting foreign rows.
    expect(result.content.map((row) => row.origin_id).sort()).toEqual([
      'direct-1', 'direct-2', 'direct-3', 'direct-4', 'linked-1',
    ]);
    const search = captured.find((c) => /search_candidates AS/.test(c.query));
    if (!search) throw new Error('search did not issue a candidate query');
    const plan = await planOf(search, true);
    const substringScans = plan.filter((node) =>
      node['Relation Name'] === 'events' &&
      `${node.Filter ?? ''} ${node['Recheck Cond'] ?? ''} ${node['Index Cond'] ?? ''}`.includes('~~*')
    );
    expect(substringScans.length).toBeGreaterThan(0);
    for (const scan of substringScans) {
      const loops = scan['Actual Loops'] ?? 0;
      // Per-loop row averages are rounded; many mostly-empty probes can
      // report zero rows. Bound probe count as well as rows, including rechecks.
      expect(loops).toBeLessThanOrEqual(FEED_EVENTS + LINKED_EVENTS);
      const examined = ((scan['Actual Rows'] ?? 0) + (scan['Rows Removed by Filter'] ?? 0)
        + (scan['Rows Removed by Index Recheck'] ?? 0)) * loops;
      expect(examined).toBeLessThanOrEqual(FEED_EVENTS + LINKED_EVENTS);
    }
  });
});
