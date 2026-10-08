/**
 * Derived-entity READ path.
 *
 * A derived entity type stores a `backing_sql` view but no rows of its own.
 * The read path reuses the existing `query_sql` tool: fetch the view SQL via
 * `get_type`, run it through `query_sql`, which org-scopes every referenced
 * table (here `events`) via `validateAndScopeQuery`. This test proves that
 * round-trip works AND that the scoping isolates orgs — a sibling org's events
 * never leak into the aggregate.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('derived entity read path (reuse query_sql)', () => {
  let owner: TestApiClient;
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const orgA = await createTestOrganization({ name: 'Derived Query A' });
    const orgB = await createTestOrganization({ name: 'Derived Query B' });
    orgAId = orgA.id;
    orgBId = orgB.id;
    const user = await createTestUser({ email: 'derived-query@test.com' });
    await addUserToOrganization(user.id, orgA.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: orgA.id,
      userId: user.id,
      memberRole: 'owner',
    });
  });

  it('a stored derived backing_sql (metadata jsonb) is queryable + org-scoped via query_sql', async () => {
    // Realistic derived view: business data lives in events.metadata (jsonb),
    // not in fixed columns. Extraction + cast + aggregate must survive the
    // parse → validate → org-scope path (now powered by @polyglot-sql/sdk).
    const sql =
      "SELECT (metadata->>'vendor') AS vendor, SUM((metadata->>'amount')::numeric) AS total_spend, COUNT(*) AS purchases FROM events GROUP BY 1";
    await owner.entity_schema.createType({
      slug: 'spend-by-vendor',
      name: 'Spend by vendor',
      backing: { sql },
    });

    // Measure columns are classified ON READ: the SUM + COUNT(*) are measures,
    // the jsonb-extracted `vendor` is a dimension.
    const got = (await owner.entity_schema.getType('spend-by-vendor')) as {
      entity_type?: { backing_sql?: string | null; measure_columns?: string[] };
    };
    expect((got.entity_type?.measure_columns ?? []).sort()).toEqual(['purchases', 'total_spend']);

    // 2 purchases in org A + 1 in org B (same vendor). Org B must be excluded.
    await createTestEvent({ organization_id: orgAId, content: 'a1', metadata: { vendor: 'acme', amount: '10' } });
    await createTestEvent({ organization_id: orgAId, content: 'a2', metadata: { vendor: 'acme', amount: '5' } });
    await createTestEvent({ organization_id: orgBId, content: 'b1', metadata: { vendor: 'acme', amount: '99' } });

    const ctxA: ToolContext = {
      organizationId: orgAId,
      userId: 'u',
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: false,
    };
    const res = await querySql(
      { sql: got.entity_type?.backing_sql as string, sort_by: 'vendor' },
      {},
      ctxA
    );

    expect(res.error).toBeUndefined();
    const acme = res.rows.find((r) => r.vendor === 'acme');
    // Org-scoped: only org A's 2 events aggregate — org B's $99 never leaks in.
    expect(Number(acme?.purchases)).toBe(2);
    expect(Number(acme?.total_spend)).toBe(15);
  });

  it('rejects creating a stored row on a derived (view) entity type', async () => {
    await owner.entity_schema.createType({
      slug: 'orders-view',
      name: 'Orders view',
      backing: { sql: 'SELECT semantic_type, COUNT(*) AS n FROM events GROUP BY 1' },
    });
    // The view has no stored rows; inserting one would be silently ignored.
    await expect(
      owner.entities.create({ entity_type: 'orders-view', name: 'nope' })
    ).rejects.toThrow(/derived|view|no stored rows/i);
  });

  it('rejects converting a populated stored type into a derived view', async () => {
    await owner.entity_schema.createType({ slug: 'people', name: 'People' });
    await owner.entities.create({ entity_type: 'people', name: 'Ada' });
    // Would orphan Ada (the view ignores stored rows) — must be rejected.
    await expect(
      owner.entity_schema.updateType({
        slug: 'people',
        backing: { sql: 'SELECT 1 AS x FROM events' },
      })
    ).rejects.toThrow(/stored entit|delete them first/i);
  });

  it('a DB trigger rejects a direct row insert on a derived type (invariant backstop)', async () => {
    await owner.entity_schema.createType({
      slug: 'metrics-view',
      name: 'Metrics',
      backing: { sql: 'SELECT 1 AS x FROM events' },
    });
    const db = getTestDb();
    const [row] = await db`
      SELECT id FROM entity_types WHERE slug = 'metrics-view' AND organization_id = ${orgAId} LIMIT 1
    `;
    // Bypass the app guards entirely — the trigger is the safety net.
    await expect(
      db`INSERT INTO entities (entity_type_id, name, organization_id) VALUES (${row.id}, 'x', ${orgAId})`
    ).rejects.toThrow(/derived|cannot have stored rows/i);
  });

  // query_sql is member-accessible; these are the parser-bypass leaks the
  // bug-hunt confirmed (member reads the admin-only oauth_tokens via a parser
  // hole). They must error through the real tool, not just validateAndScopeQuery.
  const memberCtx = (): ToolContext => ({
    organizationId: orgAId,
    userId: 'member-u',
    memberRole: 'member',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
  });

  it('member query_sql rejects the `TABLE oauth_tokens` shorthand', async () => {
    const res = await querySql({ sql: 'TABLE oauth_tokens' }, {}, memberCtx());
    expect(res.rows).toHaveLength(0);
    expect(res.error).toMatch(/SELECT \/ WITH/i);
  });

  it('member query_sql blocks oauth_tokens nested in a CASE subquery', async () => {
    const res = await querySql(
      {
        sql: "SELECT id, (CASE WHEN true THEN (SELECT access_token FROM oauth_tokens LIMIT 1) ELSE 'x' END) AS leak FROM entities",
      },
      {},
      memberCtx()
    );
    expect(res.rows).toHaveLength(0);
    expect(res.error).toMatch(/admin access/i);
  });

  it('DB trigger rejects re-pointing a stored row at a derived type (UPDATE)', async () => {
    await owner.entity_schema.createType({ slug: 'animals', name: 'Animals' });
    await owner.entity_schema.createType({
      slug: 'animal-counts',
      name: 'Animal counts',
      backing: { sql: 'SELECT 1 AS x FROM events' },
    });
    await owner.entities.create({ entity_type: 'animals', name: 'Cat' });
    const db = getTestDb();
    const [cat] = await db`
      SELECT id FROM entities WHERE name = 'Cat' AND organization_id = ${orgAId} LIMIT 1
    `;
    const [derived] = await db`
      SELECT id FROM entity_types WHERE slug = 'animal-counts' AND organization_id = ${orgAId} LIMIT 1
    `;
    // Re-pointing the row's entity_type_id to the derived type would orphan it.
    await expect(
      db`UPDATE entities SET entity_type_id = ${derived.id} WHERE id = ${cat.id}`
    ).rejects.toThrow(/derived|cannot have stored rows/i);
  });

  it('DB trigger rejects setting backing_sql on a populated stored type (UPDATE)', async () => {
    await owner.entity_schema.createType({ slug: 'plants', name: 'Plants' });
    await owner.entities.create({ entity_type: 'plants', name: 'Fern' });
    const db = getTestDb();
    // Direct DB convert-to-derived while rows exist must be rejected.
    await expect(
      db`UPDATE entity_types SET backing_sql = 'SELECT 1 AS x FROM events'
         WHERE slug = 'plants' AND organization_id = ${orgAId}`
    ).rejects.toThrow(/derived view while stored rows exist|delete them first/i);
  });

  it('allows converting to derived when all rows are soft-deleted (matches app live-row count)', async () => {
    await owner.entity_schema.createType({ slug: 'fish', name: 'Fish' });
    await owner.entities.create({ entity_type: 'fish', name: 'Nemo' });
    const db = getTestDb();
    // Soft-delete the only row — the app's convert-guard counts WHERE deleted_at
    // IS NULL, so conversion is allowed; the DB trigger must agree (not block on
    // a tombstoned row).
    await db`UPDATE entities e SET deleted_at = NOW()
             FROM entity_types et
             WHERE e.entity_type_id = et.id AND et.slug = 'fish' AND e.organization_id = ${orgAId}`;
    await expect(
      owner.entity_schema.updateType({ slug: 'fish', backing: { sql: 'SELECT 1 AS x FROM events' } })
    ).resolves.toBeDefined();
  });
});
