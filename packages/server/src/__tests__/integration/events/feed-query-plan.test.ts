/**
 * Plan-shape regression guard for the org-wide activity feed, its count,
 * exact text search, and substring recall.
 *
 * The date feed must use the ordered organization index; counts and searches
 * may use any organization-keyed index. The SQL under test is captured from
 * the production builders, not restated here.
 *
 * Another organization holds most of the seeded history, so a scan that is not
 * org-bounded is visibly the wrong plan. Wall-clock timing is deliberately not
 * an assertion.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { listContentInternal } from '../../../utils/content-search/list-path';
import { runBoundedRecallQuery, searchContentBySingleQuery } from '../../../utils/content-search/search-path';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const FEED_EVENTS = 8_000;
const OTHER_EVENTS = 60_000;

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
          // `begin(fn)` or `begin(mode, fn)`: the callback is always last.
          return (...args: unknown[]) => {
            const fn = args.pop() as (tx: DbClient) => Promise<unknown>;
            return (target.begin as (...a: unknown[]) => Promise<unknown>)(
              ...args,
              (tx: DbClient) => fn(wrap(tx))
            );
          };
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

async function planOf({ query, params }: CapturedQuery, analyze = false, recall = false): Promise<PlanNode[]> {
  const sql = getTestDb() as unknown as DbClient;
  const explain = `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, TIMING OFF, ' : ''}FORMAT JSON) ${query}`;
  const rows = (recall
    ? await runBoundedRecallQuery(sql, explain, params)
    : await sql.unsafe(explain, params)) as unknown as { 'QUERY PLAN': { Plan: PlanNode }[] }[];
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
}

describe('activity feed queries stay organization-bounded', () => {
  let feedOrgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();
    const feedOrg = await createTestOrganization({ name: 'Feed Plan Org' });
    const otherOrg = await createTestOrganization({ name: 'Feed Plan Other Org' });
    feedOrgId = feedOrg.id;

    const seed = (orgId: string, prefix: string, count: number, substringRows: number) => sql`
      INSERT INTO events (organization_id, semantic_type, payload_text, occurred_at, origin_id)
      SELECT ${orgId}, 'content', 'feed plan row ' || g || ' plan-marker'
               || CASE WHEN g <= ${substringRows} THEN ' xrarecorpz' ELSE '' END,
             now() - (g * interval '1 minute'),
             ${prefix} || g
      FROM generate_series(1, ${count}) AS g
    `;
    await seed(feedOrg.id, 'own-', FEED_EVENTS, 4);
    // The substring is common globally but rare in the caller's scope. The
    // eligible hits have lower ids than the unrelated history, so a backwards
    // primary-key scan must walk all of that history to find fewer than its cap.
    await seed(otherOrg.id, 'other-', OTHER_EVENTS, OTHER_EVENTS);
    await sql`ANALYZE events`;
  }, 120_000);

  afterAll(async () => {
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
    expect(page.total).toBe(FEED_EVENTS);
    expect(page.content).toHaveLength(30);
    expect(page.content.every((row) => row.origin_id.startsWith('own-'))).toBe(true);
    const count = captured.find((c) => /^\s*SELECT COUNT\(\*\) as total FROM current_event_records/.test(c.query));
    const list = captured.find((c) => /candidate_set AS/.test(c.query));
    if (!count || !list) {
      throw new Error(
        `feed did not issue a count and a list query: ${captured.map((c) => c.query.trim().slice(0, 60)).join(' | ')}`
      );
    }
    return { list, count };
  }

  it('the feed page reads the ordered organization index', async () => {
    const plan = await planOf((await captureFeed()).list);
    expectOrgBounded(plan);
    expectIndexConditions(plan, 'idx_events_live_org_effective_date', /organization_id =/);
    // ANDing in a predicate-only scan of the live btree reads every live entry.
    expect(plan.some((node) => node['Node Type'] === 'BitmapAnd')).toBe(false);
  });

  it('the feed count is bounded by an organization index', async () => {
    const plan = await planOf((await captureFeed()).count);
    // Any organization-keyed index bounds the count; order does not matter here.
    expectOrgBounded(plan);
    expect(plan.some((node) => node['Node Type'] === 'BitmapAnd')).toBe(false);
  });

  it('exact text search is bounded by an organization index', async () => {
    const captured: CapturedQuery[] = [];
    const result = await searchContentBySingleQuery(
      capturingClient(getTestDb(), captured),
      'plan-marker',
      { organization_id: feedOrgId, sort_by: 'score', limit: 30 }
    );
    expect(result.total).toBe(FEED_EVENTS);
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
    // rows. Keep the caller's hits without admitting foreign rows.
    expect(result.content.map((row) => row.origin_id).sort()).toEqual([
      'own-1', 'own-2', 'own-3', 'own-4',
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
      expect(loops).toBeLessThanOrEqual(FEED_EVENTS);
      const examined = ((scan['Actual Rows'] ?? 0) + (scan['Rows Removed by Filter'] ?? 0)
        + (scan['Rows Removed by Index Recheck'] ?? 0)) * loops;
      expect(examined).toBeLessThanOrEqual(FEED_EVENTS);
    }
  });

  it("agent-scoped recall reads the agent's rows, not the organization history", async () => {
    const sql = getTestDb();
    // A sliver of the organization carries the agent's memory scope. Recall
    // for that agent must find it without reading every live organization row.
    await sql`UPDATE events SET metadata = metadata || '{"agent_id":"plan-agent"}'::jsonb
      WHERE organization_id = ${feedOrgId} AND origin_id LIKE 'own-79__'`;
    await sql`ANALYZE events`;
    const captured: CapturedQuery[] = [];
    const result = await searchContentBySingleQuery(
      capturingClient(sql, captured),
      'plan-marker',
      {
        organization_id: feedOrgId,
        agent_id: 'plan-agent',
        sort_by: 'score',
        limit: 30,
        include_total: false,
        approximate_candidate_search: true,
        query_embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0),
      }
    );
    expect(result.content).toHaveLength(30);
    expect(result.content.every((row) => /^own-79\d\d$/.test(row.origin_id))).toBe(true);
    const search = captured.find((c) => /filtered_ids AS/.test(c.query));
    if (!search) throw new Error('agent recall did not issue a search query');
    const plan = await planOf(search, true, true);
    expectOrgBounded(plan);
    const examined = plan
      .filter((node) => node['Relation Name'] === 'events')
      .reduce((sum, node) => sum + ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)
        + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 0), 0);
    // 100 agent rows plus the final page's lookups; the organization has 8,000.
    expect(examined).toBeLessThanOrEqual(500);
  });

  it('vector recall keeps its distance index with visibility and bookkeeping filters', async () => {
    const sql = getTestDb();
    const user = await createTestUser({ email: 'vector-plan@example.com' });
    const owner = await createTestUser({ email: 'vector-plan-owner@example.com' });
    await createTestConnectorDefinition({ key: 'vector-plan-source', name: 'Vector plan source' });
    const privateConnection = await createTestConnection({
      organization_id: feedOrgId,
      connector_key: 'vector-plan-source',
      created_by: owner.id,
      visibility: 'private',
      createDefaultFeed: false,
    });
    // Vary distances independently of organization/id order. Both organizations
    // share one ANN index, as in production. Over 600 nearer own rows are either
    // private or bookkeeping: filtering after the chunk cap loses visible hits.
    await sql`
      INSERT INTO event_embeddings (event_id, embedding_model, embedding)
      SELECT id, 'Xenova/bge-base-en-v1.5',
        (CASE WHEN organization_id = ${feedOrgId} AND
            (origin_id LIKE 'own-1%' OR origin_id LIKE 'own-2%')
          THEN '[1,0,0' || repeat(',0', 765) || ']'
          ELSE '[1,' || (sin(id * 0.731) * 0.5 + 0.5)::text || ',' ||
            (cos(id * 0.137) * 0.5)::text || repeat(',0', 765) || ']'
          END)::vector
      FROM events
    `;
    await sql`UPDATE events SET semantic_type = 'audit', origin_type = 'tool_invocation'
      WHERE organization_id = ${feedOrgId} AND origin_id LIKE 'own-1%'`;
    await sql`UPDATE events SET connection_id = ${privateConnection.id}
      WHERE organization_id = ${feedOrgId} AND origin_id LIKE 'own-2%'`;
    // One visible exact match; all other exact vectors belong to the excluded
    // private/audit rows. A high similarity floor must not make ANN read every
    // lower-scoring embedding in an attempt to fill its candidate limit.
    await sql`
      UPDATE event_embeddings SET embedding = ('[1' || repeat(',0', 767) || ']')::vector
      WHERE event_id = (SELECT id FROM events
        WHERE organization_id = ${feedOrgId} AND origin_id = 'own-3')
    `;
    await sql.begin(async (tx) => {
      await tx`SET LOCAL maintenance_work_mem = '512MB'`;
      await tx`REINDEX INDEX idx_events_embedding`;
    });
    await sql`ANALYZE event_embeddings`;
    await sql`ANALYZE events`;

    const captured: CapturedQuery[] = [];
    const result = await searchContentBySingleQuery(
      capturingClient(sql, captured),
      'zz', // no text arms: every returned result must come from vector recall
      {
        organization_id: feedOrgId,
        visibility_scope: { organizationId: feedOrgId, userId: user.id },
        exclude_internal_ops: true,
        exclude_recall_bookkeeping: true,
        sort_by: 'score',
        limit: 30,
        include_total: false,
        approximate_candidate_search: true,
        query_embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0),
      }
    );
    expect(result.content).toHaveLength(30);
    expect(result.content.every((row) => row.origin_id.startsWith('own-') &&
      !row.origin_id.startsWith('own-1') && !row.origin_id.startsWith('own-2'))).toBe(true);
    const search = captured.find((c) => /search_candidates AS/.test(c.query));
    if (!search) throw new Error('search did not issue a candidate query');
    const plan = await planOf(search, true, true);
    expect(plan.some((node) => node['Index Name'] === 'idx_events_embedding')).toBe(true);
    const embeddingScans = plan.filter((node) => node['Relation Name'] === 'event_embeddings');
    expect(embeddingScans.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);

    const strictCapture: CapturedQuery[] = [];
    const strict = await searchContentBySingleQuery(capturingClient(sql, strictCapture), '', {
      organization_id: feedOrgId,
      visibility_scope: { organizationId: feedOrgId, userId: user.id },
      exclude_internal_ops: true,
      exclude_recall_bookkeeping: true,
      sort_by: 'score',
      limit: 30,
      include_total: false,
      approximate_candidate_search: true,
      query_embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0),
      min_similarity: 1,
    });
    expect(strict.content.map((row) => row.origin_id)).toEqual(['own-3']);
    const strictQuery = strictCapture.find((c) => /search_candidates AS/.test(c.query));
    if (!strictQuery) throw new Error('strict recall did not issue a candidate query');
    const strictPlan = await planOf(strictQuery, true, true);
    const strictScans = strictPlan.filter((node) => node['Index Name'] === 'idx_events_embedding');
    expect(strictScans.some((node) => (node['Actual Loops'] ?? 0) > 0)).toBe(true);
    // Every embedding has the requested model. Index candidates should only
    // be filtered by visibility, never exhaust the probe to find enough rows
    // above the similarity floor; lower distances already sort first.
    expect(strictScans.reduce((sum, node) => sum +
      (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 0), 0)).toBe(0);

    // A tiny eligible scope must not depend on landing in the nearest global
    // IVFFlat lists. Its vectors are farther away than the unrelated history.
    // Private and audit rows make the organization large, while only 24 rows
    // are eligible: the decision must use the same visibility filters as recall.
    const tinyOrg = await createTestOrganization({ name: 'Small Vector Plan Org' });
    const hiddenConnection = await createTestConnection({
      organization_id: tinyOrg.id,
      connector_key: 'vector-plan-source',
      created_by: owner.id,
      visibility: 'private',
      createDefaultFeed: false,
    });
    await sql`
      WITH inserted AS (
        INSERT INTO events (organization_id, semantic_type, origin_type, connection_id, payload_text, origin_id)
        SELECT ${tinyOrg.id}, CASE WHEN g > 6024 THEN 'audit' ELSE 'content' END,
          CASE WHEN g > 6024 THEN 'tool_invocation' ELSE NULL END,
          CASE WHEN g BETWEEN 25 AND 6024 THEN ${hiddenConnection.id}::bigint ELSE NULL END,
          'small scope row ' || g, 'small-' || g
        FROM generate_series(1, 12024) AS g
        RETURNING id, origin_id
      )
      INSERT INTO event_embeddings (event_id, embedding_model, embedding)
      SELECT id, 'Xenova/bge-base-en-v1.5',
        ('[' || (0.4 + substring(origin_id FROM 7)::int * 0.005)::text || ',1,0' || repeat(',0', 765) || ']')::vector
      FROM inserted
    `;
    const smallOptions = {
      organization_id: tinyOrg.id,
      visibility_scope: { organizationId: tinyOrg.id, userId: user.id },
      exclude_internal_ops: true,
      exclude_recall_bookkeeping: true,
      sort_by: 'score' as const,
      limit: 10,
      include_total: false,
      query_embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0),
    };
    const exact = await searchContentBySingleQuery(sql, '', smallOptions);
    const smallCapture: CapturedQuery[] = [];
    const approximate = await searchContentBySingleQuery(capturingClient(sql, smallCapture), '', {
      ...smallOptions,
      approximate_candidate_search: true,
    });
    expect(exact.content).toHaveLength(10);
    expect(approximate.content.map((row) => row.id)).toEqual(exact.content.map((row) => row.id));
    const smallQuery = smallCapture.find((c) => /search_candidates AS/.test(c.query));
    if (!smallQuery) throw new Error('small scope did not issue a recall query');
    const smallPlan = await planOf(smallQuery, true, true);
    // No global vector scan should execute for a small eligible scope.
    expect(smallPlan.filter((node) => node['Index Name'] === 'idx_events_embedding')
      .every((node) => node['Actual Loops'] === 0)).toBe(true);
  }, 120_000);
});
