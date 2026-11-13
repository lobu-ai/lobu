/**
 * M0 deny-test for the metric path (query_metric → runMetric → validateAndScopeQuery).
 * runMetric compiles a declared measure over `events` and runs it through the
 * SAME buildScopedQuery seam as query_sql/client.query, so per-user connection
 * visibility must hold here too: a member charting a metric can't count another
 * user's PRIVATE-connection events.
 *
 * This guards the regression "a wrapper forgot to forward userId": runMetric is
 * a distinct input type (`userId` field) from the inline `ctx.userId` callers,
 * so it's the easiest to drop. Seeds two users with private connections + one
 * org-visible connection, all feeding identical aliased transactions, and
 * asserts the per-user COUNT through the real aggregation path.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestApiClient } from '../../setup/test-mcp-client';
import { runMetric } from '../../../metrics/run-metric';

const METRICS = {
  eventSets: {
    txns: {
      by: 'alias',
      field: "metadata->>'description'",
      against: 'aliases',
      where: "semantic_type='transaction' AND connector_key='revolut'",
    },
    // Authored SQL that would run far past any request: a measure's predicates
    // are org-written, so the statement cap is the only bound.
    slow_txns: {
      by: 'alias',
      field: "metadata->>'description'",
      against: 'aliases',
      where: "semantic_type='transaction' AND (SELECT count(*) FROM generate_series(1, 2000000000)) > 0",
    },
  },
  measures: {
    txn_count: {
      eventSet: 'txns',
      agg: 'count',
      description: 'Number of matched transactions.',
    },
    slow_count: {
      eventSet: 'slow_txns',
      agg: 'count',
      description: 'Matched transactions behind an unbounded predicate.',
    },
  },
};

describe('runMetric — per-user connection visibility (M0 deny-test)', () => {
  let orgId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Metric Visibility Org' });
    orgId = org.id;

    const userA = await createTestUser({ email: 'metric-vis-a@test.com' });
    const userB = await createTestUser({ email: 'metric-vis-b@test.com' });
    userAId = userA.id;
    userBId = userB.id;
    await addUserToOrganization(userA.id, org.id, 'owner');
    await addUserToOrganization(userB.id, org.id, 'owner');

    const owner = await TestApiClient.for({
      organizationId: org.id,
      userId: userA.id,
      memberRole: 'owner',
    });
    await owner.entity_schema.createType({
      slug: 'vendor',
      name: 'Vendor',
      metrics_config: METRICS,
    });

    const vendor = await createTestEntity({
      name: 'Acme',
      entity_type: 'vendor',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE entities SET metadata = ${sql.json({ aliases: ['Acme'] })}
      WHERE id = ${vendor.id}
    `;

    const connA = await createTestConnection({
      organization_id: orgId,
      connector_key: 'revolut',
      created_by: userA.id,
      visibility: 'private',
    });
    const connB = await createTestConnection({
      organization_id: orgId,
      connector_key: 'revolut',
      created_by: userB.id,
      visibility: 'private',
    });
    const connOrg = await createTestConnection({
      organization_id: orgId,
      connector_key: 'revolut',
      visibility: 'org',
    });

    // One identical aliased transaction per connection. Per-user filtering — not
    // the alias matcher — is what must differentiate the counts.
    const txn = (connectionId: number) =>
      createTestEvent({
        organization_id: orgId,
        connection_id: connectionId,
        content: 'charge',
        semantic_type: 'transaction',
        connector_key: 'revolut',
        metadata: { description: 'Acme', amount: 10, direction: 'out' },
      });
    await txn(connA.id);
    await txn(connB.id);
    await txn(connOrg.id);
  });

  const count = async (userId: string | null): Promise<number> => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: 'vendor',
      measure: 'txn_count',
      userId,
    });
    // No `by`, so a single aggregate row.
    return rows.length ? Number(rows[0].txn_count) : 0;
  };

  it('counts userA own-private + org, never userB private', async () => {
    expect(await count(userAId)).toBe(2);
  });

  it('counts userB own-private + org, never userA private', async () => {
    expect(await count(userBId)).toBe(2);
  });

  it('headless (no user) counts org-visible only — fails closed on private', async () => {
    expect(await count(null)).toBe(1);
  });

  it('stops an authored measure at the member SQL statement timeout', async () => {
    const started = Date.now();
    await expect(
      runMetric({ organizationId: orgId, entityType: 'vendor', measure: 'slow_count', userId: userAId })
    ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
