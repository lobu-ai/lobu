/**
 * Plan-shape regression guard for identity-group event recall.
 *
 * The production helper resolves the current identity component once per query,
 * then probes events.entity_ids through its GIN index. Seed enough events for
 * the planner to prefer that index, and verify both the plan and exact recall
 * from every member. Wall-clock timing is deliberately not an assertion.
 *
 * The UNION runs behind a MATERIALIZED barrier (`entity_link_ids` CTE) so the
 * planner cannot flatten it into a hash-and-sweep over the org's history;
 * the outer query may still legitimately sweep a small events table (hashing
 * a materialized few-thousand-id CTE beats thousands of PK probes), which is
 * why the no-seq-scan assertion below targets the `e2` branch alias rather
 * than the outer query.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildEntityLinkUnion } from '../../../utils/content-search/entity-link';
import { pgBigintArray } from '../../../db/client';
import { lockIdentityOrganization, withIdentityPrivilege } from '../../../utils/relationship-validation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const N_EVENTS = Number(process.env.BENCH_EVENTS ?? 20_000);
const N_ENTITIES = 500;
const N_MEMBERS = 8;

// deterministic pseudo-spread (Math.random is banned in this harness)
const spread = (i: number, mod: number) => (i * 2654435761) % mod;

describe('identity-group recall — query plan stays index-driven', () => {
  let root: number;
  let members: number[];
  let expectedEventCount: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Identity Recall Bench Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    const entIds: number[] = [];
    for (let i = 0; i < N_ENTITIES; i++) {
      const e = await createTestEntity({
        name: `bench-ent-${i}`,
        entity_type: 'contact-record',
        organization_id: org.id,
        created_by: user.id,
      });
      entIds.push(e.id);
    }
    root = entIds[0];
    members = entIds.slice(1, 1 + N_MEMBERS);
    await sql.begin(async (tx) => {
      await lockIdentityOrganization(tx, org.id);
      const [type] = await tx`
        INSERT INTO entity_relationship_types (organization_id, slug, name, purpose)
        VALUES (${org.id}, 'same_record', 'Same record', 'identity') RETURNING id
      `;
      for (const member of members) {
        await withIdentityPrivilege(tx, () => tx`
          INSERT INTO entity_relationships (
            organization_id, from_entity_id, to_entity_id, relationship_type_id, metadata
          ) VALUES (${org.id}, ${member}, ${root}, ${type.id},
            ${tx.json({ _lobu_claims: { manual: {} }, _lobu_identity_decision: { outcome: 'accepted' } })})
        `);
      }
    });

    // ~15% of events are stamped with a member of the recall group; the
    // remaining entities provide the noise the GIN index skips.
    // Bulk-insert via UNNEST: one round-trip per chunk, entity_ids built as a
    // bigint[][] literal so postgres stores each row's single-element array.
    const hot = [root, ...members];
    const stamped: number[] = [];
    for (let i = 0; i < N_EVENTS; i++) {
      const isHot = spread(i, 100) < 15;
      stamped.push(isHot ? hot[spread(i, hot.length)] : entIds[spread(i, N_ENTITIES)]);
    }
    expectedEventCount = stamped.filter((id) => hot.includes(id)).length;
    expect(stamped.some((id) => members.includes(id))).toBe(true);
    const CHUNK = 2_000;
    for (let c = 0; c < stamped.length; c += CHUNK) {
      const slice = stamped.slice(c, c + CHUNK);
      // Each event has exactly one stamped entity. UNNEST the flat id list, then
      // wrap each scalar in a single-element ARRAY for the entity_ids column —
      // one round-trip per chunk, no per-row INSERT.
      await sql`
        INSERT INTO events (organization_id, semantic_type, entity_ids)
        SELECT ${org.id}, 'content', ARRAY[id]
        FROM UNNEST(${pgBigintArray(slice)}::bigint[]) AS id
      `;
    }
    await sql`ANALYZE events`;
    await sql`ANALYZE entities`;
  }, 120_000);

  async function planFor(predicate: string): Promise<string> {
    const sql = getTestDb();
    const out = await sql.unsafe(
      `EXPLAIN (ANALYZE, FORMAT TEXT) SELECT count(*) FROM events e WHERE ${predicate}`
    );
    return out.map((r) => (r as Record<string, string>)['QUERY PLAN']).join('\n');
  }

  it('single-record containment uses the GIN index (baseline)', async () => {
    const plan = await planFor(`e.entity_ids @> ARRAY[${root}::bigint]`);
    expect(plan).toMatch(/Bitmap Index Scan on idx_events_entity_ids/);
    expect(plan).not.toMatch(/Seq Scan on events/);
  });

  it('identity-group recall uses the GIN index without scanning all events', async () => {
    const plan = await planFor(
      buildEntityLinkUnion({ entityIdLiteral: root, scopes: [], alias: 'e', baseParamIndex: 1 }).sql
    );
    // The UNION must stay behind its MATERIALIZED barrier: flattening it lets
    // the planner hash a few ids and sweep the org's history per entity.
    expect(plan).toMatch(/CTE Scan on entity_link_ids/);
    // Every UNION branch probes its index (GIN on entity_ids for the direct
    // branch). The outer query may still sweep a small table when hashing the
    // materialized CTE is genuinely cheaper, so the no-seq-scan pin targets
    // the `e2` branch alias, not the outer `e`.
    expect(plan).toMatch(/Bitmap Index Scan on idx_events_entity_ids/);
    expect(plan).not.toMatch(/Seq Scan on events e2/);
  });

  it('resolves the identity component once instead of once per event', async () => {
    const plan = await planFor(
      buildEntityLinkUnion({ entityIdLiteral: root, scopes: [], alias: 'e', baseParamIndex: 1 }).sql
    );
    expect(plan).toMatch(/InitPlan/);
    // The seed lookup of the recursive component executes exactly once.
    const seedScan = /InitPlan[\s\S]*?on entities seed[^\n]*loops=(\d+)/.exec(plan);
    expect(seedScan).not.toBeNull();
    expect(Number(seedScan?.[1])).toBe(1);
    expect(plan).not.toMatch(/SubPlan[\s\S]*?on entities/);
  });

  it('recalls exactly the same stamped events from the root and every member', async () => {
    const sql = getTestDb();
    for (const entityId of [root, ...members]) {
      const predicate = buildEntityLinkUnion({
        entityIdLiteral: entityId, scopes: [], alias: 'e', baseParamIndex: 1,
      });
      const [row] = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM events e WHERE ${predicate.sql}`,
        predicate.params
      );
      expect(row.n).toBe(expectedEventCount);
    }
  });
});
