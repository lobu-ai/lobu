/**
 * Plan-shape regression guard for member-filtered entity lists.
 *
 * `parent_id`, `search`, attribute filters and segments hold when one member of
 * a row's identity group satisfies all of them, so the page-id statement carries a
 * correlated identity walk per candidate row. Guard against two shapes that
 * can scan unrelated entity rows during that walk:
 *  - `entities.id IN (<walk>)` flattened into a semi join of every candidate
 *    against a materialized scan of every matching entity row, re-running the
 *    walk per pair;
 *  - each walk step correlated the edge endpoints to the member's
 *    type/organization, so the planner scanned every same-type entity per
 *    member instead of probing the edge endpoint indexes.
 *
 * The fixture contains many same-type rows, each with an
 * ordinary (non-identity) edge, plus one real identity group. The test drives
 * the production list path, captures the statement it issues, and pins the
 * plan. Wall-clock timing is deliberately not an assertion.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';

const N_ENTITIES = 3_000;

describe('member-filtered entity list — identity walk avoids unrelated entity scans', () => {
  let workspace: TestWorkspace;
  let human: Awaited<ReturnType<TestWorkspace['withAuth']>>;
  let groupRoot: number;
  let groupMember: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Member filter plan org' });
    human = await workspace.withAuth({ tokenType: 'session' });
    await human.entity_schema.createType({ slug: 'contact-record', name: 'Contact record' });
    await human.entity_schema.createRelType({ slug: 'same_record', name: 'Same record', purpose: 'identity' });
    await human.entity_schema.createRelType({ slug: 'knows', name: 'Knows' });
    const created = await human.entities.create({ entity_type: 'contact-record', name: 'Seed record' });
    const sql = getTestDb();
    const [{ entity_type_id: typeId, created_by: createdBy }] = await sql`SELECT entity_type_id, created_by FROM entities WHERE id = ${Number(created.entity.id)}`;
    const ids = (await sql`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      SELECT ${workspace.org.id}, ${typeId}, 'bulk record ' || n, 'bulk-record-' || n, '{}'::jsonb, ${createdBy}
      FROM generate_series(1, ${N_ENTITIES}) AS n
      RETURNING id
    `).map((row) => Number(row.id));
    const [{ id: knowsId }] = await sql`
      SELECT id FROM entity_relationship_types WHERE organization_id = ${workspace.org.id} AND slug = 'knows'
    `;
    // Every bulk row carries an ordinary edge: an "is edgeless"
    // shortcut alone would not keep these rows off the identity walk.
    await sql`
      INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_id, relationship_type_id)
      SELECT ${workspace.org.id}, pair.a, pair.b, ${knowsId}
      FROM UNNEST(${`{${ids.slice(0, -1).join(',')}}`}::bigint[], ${`{${ids.slice(1).join(',')}}`}::bigint[]) AS pair(a, b)
    `;
    groupMember = ids[0];
    groupRoot = ids[1];
    await sql`UPDATE entities SET name = 'Needle retained member' WHERE id = ${groupMember}`;
    await human.entities.link({ from_entity_id: groupMember, to_entity_id: groupRoot, relationship_type_slug: 'same_record' });
    await sql`ANALYZE entities`;
    await sql`ANALYZE entity_relationships`;
  }, 120_000);

  afterEach(() => vi.restoreAllMocks());

  /** Run one list call and return the EXPLAIN ANALYZE of its page-id statement. */
  async function pageIdPlan(args: Record<string, unknown>): Promise<string> {
    const db = getDb();
    const issued: Array<{ query: string; params: unknown[] }> = [];
    const original = db.unsafe.bind(db);
    vi.spyOn(db, 'unsafe').mockImplementation(((query: string, params?: unknown[]) => {
      issued.push({ query, params: params ?? [] });
      return original(query, params as never);
    }) as typeof db.unsafe);
    await human.entities.list({ entity_type: 'contact-record', ...args });
    vi.restoreAllMocks();
    const page = issued.find((call) => call.query.startsWith('SELECT e2.id FROM entities e2'));
    expect(page).toBeDefined();
    const rows = await getTestDb().unsafe(`EXPLAIN (ANALYZE, FORMAT TEXT) ${page?.query}`, page?.params as never);
    return rows.map((row) => (row as Record<string, string>)['QUERY PLAN']).join('\n');
  }

  function expectNoRepeatedEntityScans(plan: string) {
    // No flattened semi join: the member probe is driven by the walk's ids.
    expect(plan).not.toMatch(/Seq Scan on entities member/);
    expect(plan).not.toMatch(/ANY \(member\.id = /);
    // Each walk step reads the member's incident edges by endpoint index and
    // probes the two endpoints by primary key: an endpoint scan repeated per
    // row may return at most one row per loop, never the org's same-type rows.
    // (The identity-root anti join materializes its edge list once: loops=1.)
    const perRowEndpointScans = plan.split('\n').flatMap((line) => {
      const match = / on entities (?:source|target)(?:_\d+)? .*actual time=[^)]* rows=([\d.]+) loops=(\d+)/.exec(line);
      return match && Number(match[2]) > 1 && Number(match[1]) > 1 ? [line.trim()] : [];
    });
    expect(perRowEndpointScans).toEqual([]);
  }

  it('parent_id: null (the root-coverage probe) avoids repeated entity scans', async () => {
    const plan = await pageIdPlan({ parent_id: null, limit: 1 });
    expectNoRepeatedEntityScans(plan);
  });

  it('a search no seed matches avoids repeated entity scans', async () => {
    const plan = await pageIdPlan({ search: 'no such record name', limit: 50 });
    expectNoRepeatedEntityScans(plan);
    // The walk actually ran for the rows (a miss forces member expansion).
    expect(plan).toMatch(/Recursive Union/);
  });

  it('member semantics hold: a group is listed when any member satisfies the filter', async () => {
    const list = (args: Record<string, unknown>) => human.entities.list({ entity_type: 'contact-record', limit: 500, ...args });
    const roots = await list({ parent_id: null });
    expect(roots.metadata.total_count).toBe(N_ENTITIES); // seed + N rows - 1 retained member
    expect(roots.entities.map((row) => Number(row.id))).not.toContain(groupMember);
    const found = await list({ search: 'Needle retained' });
    expect(found.entities.map((row) => Number(row.id))).toEqual([groupRoot]);
  });
});
