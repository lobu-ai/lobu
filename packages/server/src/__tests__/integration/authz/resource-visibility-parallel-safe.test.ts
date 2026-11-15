/**
 * Resource-visibility gate: plan shape and result equivalence.
 *
 * Every events read seam (query_sql's `events` CTE, Automation sources,
 * read_knowledge, search recall) composes `compileResourceVisibility`. A
 * correlated per-row subquery in its all-required envelope test makes the
 * whole WHERE clause parallel-restricted, so a large organization's history
 * scan runs in one process and can exceed the 5s query_sql budget.
 *
 * The plan test forces the cheapest parallel plan and checks that the events
 * scan stays parallel-aware with the production predicate composed. The
 * equivalence test pins the gate's row-level answer against an independent
 * oracle for every envelope shape.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { pgBigintArray } from '../../../db/client';
import type { DbClient } from '../../../db/client';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { search } from '../../../tools/search';
import { ensureRelationshipType, upsertEdges } from '../../../utils/edge-writes';
import { buildConnectionVisibilityClause } from '../../../utils/content-search/visibility';
import {
  MANUAL_RELATIONSHIP_CLAIM_KEY,
  RELATIONSHIP_CLAIMS_METADATA_KEY,
} from '../../../utils/relationship-claims';
import { withAclEdgeWrite } from '../../../utils/relationship-validation';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Parallel Aware'?: boolean;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

let orgId = '';
let readerId = '';
let outsiderId = '';
let withheldEventId = 0;
let memberOfTypeId = 0;
let grantedResourceId = 0;
let grantedEventId = 0;
let plainEventId = 0;
/** Event id → whether an org member WITH the reader's grants may see it. */
const expectedForReader = new Map<number, boolean>();
/** Event id → whether an org member with NO grants may see it. */
const expectedForOutsider = new Map<number, boolean>();

async function insertEvent(opts: {
  entityIds: number[] | null;
  interactionType?: string;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql.unsafe<{ id: string }[]>(
    `INSERT INTO events (organization_id, origin_id, title, payload_text, semantic_type,
       interaction_type, entity_ids, occurred_at, created_at)
     VALUES ($1, gen_random_uuid()::text, 'gate-probe', 'gate-probe ' || gen_random_uuid()::text, 'content', $2,
       ${opts.entityIds === null ? 'NULL' : `$3::bigint[]`}, now(), now())
     RETURNING id`,
    (opts.entityIds === null
      ? [orgId, opts.interactionType ?? 'none']
      : [orgId, opts.interactionType ?? 'none', pgBigintArray(opts.entityIds)]) as never[],
  );
  return Number(row.id);
}

function gatedQuery(userId: string, select: string): { query: string; params: unknown[] } {
  const visibility = buildConnectionVisibilityClause(
    { organizationId: orgId, userId, baseParamIndex: 2 },
    'f',
  );
  return {
    query: `SELECT ${select} FROM public.current_event_records f
      WHERE f.organization_id = $1 ${visibility.sql}`,
    params: [orgId, ...visibility.params],
  };
}

describe('resource visibility gate', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    await initWorkspaceProvider();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Gate plan shape' });
    orgId = org.id;
    const reader = await createTestUser();
    const outsider = await createTestUser();
    readerId = reader.id;
    outsiderId = outsider.id;
    await addUserToOrganization(reader.id, org.id, 'member');
    await addUserToOrganization(outsider.id, org.id, 'member');

    const readerMember = await createTestEntity({
      name: 'reader-member',
      entity_type: '$member',
      organization_id: org.id,
      created_by: reader.id,
    });
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${readerMember.id}, 'auth_user_id', ${reader.id}, 'auth:signup')
    `;
    const granted = await createTestEntity({ name: 'granted-repo', entity_type: '$resource', organization_id: org.id });
    grantedResourceId = granted.id;
    const withheld = await createTestEntity({ name: 'withheld-repo', entity_type: '$resource', organization_id: org.id });
    const plain = await createTestEntity({ name: 'plain-company', organization_id: org.id });
    memberOfTypeId = await ensureRelationshipType({
      organizationId: org.id,
      slug: 'member_of',
      name: 'Member of',
      description: 'test manual membership',
    });
    await withAclEdgeWrite(sql, (tx) =>
      upsertEdges({
        db: tx,
        organizationId: org.id,
        relationshipTypeId: memberOfTypeId,
        pairs: [{ fromEntityId: readerMember.id, toEntityId: granted.id }],
        source: 'manual',
        confidence: 1.0,
        createdBy: reader.id,
        claimKey: MANUAL_RELATIONSHIP_CLAIM_KEY,
        onConflict: 'ignore',
      }),
    );

    // [entity_ids, interaction_type, reader may see, outsider may see]
    const cases: Array<[number[] | null, string, boolean, boolean]> = [
      [null, 'none', true, true],
      [[], 'none', true, true],
      [[plain.id], 'none', true, true],
      [[999_999_999], 'none', true, true],
      [[granted.id], 'none', true, false],
      [[withheld.id], 'none', false, false],
      [[granted.id, withheld.id], 'none', false, false],
      [[granted.id, plain.id], 'none', true, false],
      [[granted.id, granted.id], 'none', true, false],
      [[withheld.id], 'approval', true, true],
    ];
    for (const [entityIds, interactionType, reader_, outsider_] of cases) {
      const id = await insertEvent({ entityIds, interactionType });
      if (interactionType === 'none' && entityIds?.length === 1) {
        if (entityIds[0] === granted.id) grantedEventId = id;
        if (entityIds[0] === plain.id) plainEventId = id;
      }
      if (interactionType === 'none' && entityIds?.length === 1 && entityIds[0] === withheld.id) {
        withheldEventId = id;
      }
      expectedForReader.set(id, reader_);
      expectedForOutsider.set(id, outsider_);
    }
    // Another organization's history pushes `events` past the default
    // `min_parallel_table_scan_size`, so the planner may consider a parallel
    // scan of it at all.
    const filler = await createTestOrganization({ name: 'Gate plan filler' });
    await sql.unsafe(
      `INSERT INTO events (organization_id, origin_id, title, payload_text, semantic_type, occurred_at, created_at)
       SELECT $1, 'filler-' || g, 'filler', repeat('x', 200), 'content', now(), now()
       FROM generate_series(1, 50000) AS g`,
      [filler.id],
    );
    await sql.unsafe('ANALYZE events');
  });

  it('answers every envelope shape like the all-required oracle', async () => {
    const sql = getTestDb();
    for (const [userId, expected] of [
      [readerId, expectedForReader],
      [outsiderId, expectedForOutsider],
    ] as const) {
      const { query, params } = gatedQuery(userId, 'f.id');
      const rows = await sql.unsafe<{ id: string }[]>(query, params as never[]);
      const visible = new Set(rows.map((r) => Number(r.id)));
      const want = new Set([...expected].filter(([, ok]) => ok).map(([id]) => id));
      expect(visible).toEqual(want);
    }
  });

  it.each(['recall', 'exact read', 'SQL'] as const)(
    'keeps retired resources restricted through %s and restores only their audience',
    async (readPath) => {
      const sql = getTestDb();
      const read = async (userId: string) => {
        const ctx = { organizationId: orgId, userId, memberRole: 'member',
          tokenType: 'oauth', isAuthenticated: true, scopedToOrg: true,
          allowCrossOrg: false, scopes: ['mcp:read'] } as ToolContext;
        if (readPath === 'SQL') {
          const result = await querySql({ sql: `SELECT id FROM events WHERE id IN (${grantedEventId}, ${plainEventId})` }, {} as never, ctx);
          return result.rows.map((row) => Number(row.id));
        }
        if (readPath === 'exact read') {
          const ids: number[] = [];
          for (const id of [grantedEventId, plainEventId]) {
            const result = await search({ query: `memory ${id}`, include_content: true }, {} as never, ctx);
            ids.push(...(result.content ?? []).map((row) => row.id));
          }
          return ids;
        }
        const result = await search({ query: 'gate-probe', include_content: true,
          include_public_catalogs: false, content_limit: 50 }, {} as never, ctx);
        return (result.content ?? []).map((row) => row.id);
      };

      expect(await read(readerId)).toEqual(expect.arrayContaining([grantedEventId, plainEventId]));
      expect(await read(outsiderId)).not.toContain(grantedEventId);
      await sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${grantedResourceId}`;
      try {
        // Retirement is not publication, even if a prior membership edge remains.
        for (const userId of [readerId, outsiderId]) {
          const ids = await read(userId);
          expect(ids).not.toContain(grantedEventId);
          expect(ids).toContain(plainEventId);
        }
      } finally {
        await sql`UPDATE entities SET deleted_at = NULL WHERE id = ${grantedResourceId}`;
      }
      expect(await read(readerId)).toContain(grantedEventId);
      expect(await read(outsiderId)).not.toContain(grantedEventId);
    },
  );

  it('fails closed for a reader whose only grant is a federated member_of edge', async () => {
    const sql = getTestDb();
    const fedReader = await createTestUser();
    await addUserToOrganization(fedReader.id, orgId, 'member');
    const fedMember = await createTestEntity({
      name: 'federated-member',
      entity_type: '$member',
      organization_id: orgId,
      created_by: fedReader.id,
    });
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${orgId}, ${fedMember.id}, 'auth_user_id', ${fedReader.id}, 'auth:signup')
    `;
    const [sourceType] = await sql<{ id: string }[]>`
      SELECT id FROM entity_types WHERE organization_id = ${orgId} AND slug = '$resource'
    `;
    // A live, manually claimed member_of edge whose target is a source
    // endpoint, so `to_entity_id` is NULL. Unlike `NOT (x IN (...))`, the
    // gate must not read a NULL in the caller's satisfied set as a grant.
    const insertFederatedEdge = (tx: DbClient) =>
      tx.unsafe(
        `INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_id,
           to_entity_type_id, to_source_key, relationship_type_id, metadata, source, confidence, created_by)
         VALUES ($1, $2, NULL, $3, 'federated-repo', $4,
           jsonb_build_object($5::text, jsonb_build_object($6::text, true)), 'manual', 1, $7)`,
        [
          orgId,
          fedMember.id,
          Number(sourceType.id),
          memberOfTypeId,
          RELATIONSHIP_CLAIMS_METADATA_KEY,
          MANUAL_RELATIONSHIP_CLAIM_KEY,
          fedReader.id,
        ] as never[],
      );

    // The schema refuses the edge: authorization associations need stored endpoints.
    await expect(
      withAclEdgeWrite(sql as unknown as DbClient, insertFederatedEdge),
    ).rejects.toThrow('Authorization and identity associations require stored endpoints');

    // Defense in depth: if one ever lands, the read gate still fails closed.
    await withAclEdgeWrite(sql as unknown as DbClient, async (tx) => {
      await tx.unsafe('ALTER TABLE entity_relationships DISABLE TRIGGER lobu_guard_source_relationships');
      await insertFederatedEdge(tx);
      await tx.unsafe('ALTER TABLE entity_relationships ENABLE TRIGGER lobu_guard_source_relationships');
    });

    const { query, params } = gatedQuery(fedReader.id, 'f.id');
    const rows = await sql.unsafe<{ id: string }[]>(query, params as never[]);
    const visible = new Set(rows.map((r) => Number(r.id)));
    const ungrantedReaderView = new Set(
      [...expectedForOutsider].filter(([, ok]) => ok).map(([id]) => id),
    );
    expect(withheldEventId).toBeGreaterThan(0);
    expect(visible.has(withheldEventId)).toBe(false);
    expect(visible).toEqual(ungrantedReaderView);
  });

  it('keeps an events scan with the composed gate parallel-capable', async () => {
    const sql = getTestDb() as unknown as DbClient;
    const { query, params } = gatedQuery(readerId, 'count(*)');
    const plan = await sql.begin(async (tx: DbClient) => {
      // Make a parallel events scan the cheapest plan whenever the predicate
      // allows one. `min_parallel_table_scan_size` stays at its default so
      // only the filler-sized `events` table qualifies; the gate's small
      // lookup tables keep their serial plans, as they do in production.
      await tx.unsafe('SET LOCAL parallel_setup_cost = 0');
      await tx.unsafe('SET LOCAL parallel_tuple_cost = 0');
      await tx.unsafe('SET LOCAL max_parallel_workers_per_gather = 2');
      await tx.unsafe('SET LOCAL enable_indexscan = off');
      await tx.unsafe('SET LOCAL enable_bitmapscan = off');
      return tx.unsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        `EXPLAIN (FORMAT JSON) ${query}`,
        params as never[],
      );
    });
    const nodes = flatten(plan[0]['QUERY PLAN'][0].Plan);
    const eventScans = nodes.filter((n) => n['Relation Name'] === 'events');
    expect(eventScans.length).toBeGreaterThan(0);
    expect(eventScans.every((n) => n['Parallel Aware'] === true)).toBe(true);
  });

  it('uses type indexes for live and retired requirements in a large workspace', async () => {
    const sql = getTestDb() as unknown as DbClient;
    const indexes = await sql.begin(async (tx: DbClient) => {
      // Both live and retired non-resource entities must be large enough that
      // scanning the workspace is more expensive than finding its resources.
      await tx.unsafe(`INSERT INTO entities
        (name, slug, entity_type_id, organization_id, created_by, deleted_at)
        SELECT 'plan filler', 'plan-filler-' || g, et.id, $1, $2,
          CASE WHEN g % 2 = 0 THEN now() ELSE NULL END
        FROM entity_types et CROSS JOIN generate_series(1, 20000) g
        WHERE et.organization_id = $1 AND et.slug = 'brand'`, [orgId, readerId]);
      await tx.unsafe('UPDATE entities SET deleted_at = now() WHERE id = $1', [grantedResourceId]);
      await tx.unsafe('ANALYZE entities');
      await tx.unsafe('ANALYZE entity_types');
      const { query, params } = gatedQuery(readerId, 'f.id');
      const plan = await tx.unsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        `EXPLAIN (FORMAT JSON) ${query}`, params as never[],
      );
      await tx.unsafe('UPDATE entities SET deleted_at = NULL WHERE id = $1', [grantedResourceId]);
      return flatten(plan[0]['QUERY PLAN'][0].Plan).map((node) => node['Index Name']);
    });
    expect(indexes).toContain('idx_entities_entity_type_id');
    expect(indexes).toContain('idx_entities_retired_type_id');
  });
});
