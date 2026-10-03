/**
 * Metrics over a CONNECTION-BACKED entity type must push down to the type's
 * `backing_source` — the same `runConnectorQuery` path (and the same
 * connection-visibility decision) a derived record read takes through
 * `query_sql({ connection })` — instead of running the backing SQL against
 * Lobu's own tables.
 *
 * The bundled postgres connector is the remote source; its connection points
 * back at the test DB, so it reads a throwaway table as an external database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { runMetric } from '../../../metrics/run-metric';
import { listMetrics } from '../../../tools/admin/list_metrics';
import { queryMetric } from '../../../tools/admin/query_metric';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const BACKING_SQL =
  'SELECT region, SUM(amount) AS total_amount FROM mbs_ext GROUP BY region';

describe('metrics over a connection-backed entity type', () => {
  const env = {} as Env;
  let orgId: string;
  let ownerCtx: ToolContext;
  let memberCtx: ToolContext;
  let adminCtx: ToolContext;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Metric Backing Source' });
    orgId = org.id;
    const owner = await createTestUser({ email: 'mbs-owner@test.com' });
    const member = await createTestUser({ email: 'mbs-member@test.com' });
    await addUserToOrganization(owner.id, orgId, 'owner');
    const admin = await createTestUser({ email: 'mbs-admin@test.com' });
    await addUserToOrganization(member.id, orgId, 'member');
    await addUserToOrganization(admin.id, orgId, 'admin');
    ownerCtx = ownerToolContext(orgId, owner.id);
    memberCtx = { ...ownerToolContext(orgId, member.id), memberRole: 'member' } as ToolContext;
    adminCtx = { ...ownerToolContext(orgId, admin.id), memberRole: 'admin' } as ToolContext;

    const db = getTestDb();
    // The table exists ONLY on the remote side in spirit: it is not a
    // queryable Lobu table, so an internal execution cannot resolve it.
    await db`DROP TABLE IF EXISTS mbs_ext`;
    await db`CREATE TABLE mbs_ext (id bigserial primary key, region text, amount numeric)`;
    await db`INSERT INTO mbs_ext (region, amount) VALUES ('north', 10), ('north', 5), ('south', 7)`;

    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'mbs ext db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'mbs-org-db', 'Org DB', 'active', ${profile.id}, 'org', ${owner.id}, NOW(), NOW()),
        (${orgId}, 'postgres', 'mbs-priv-db', 'Private DB', 'active', ${profile.id}, 'private', ${owner.id}, NOW(), NOW())
    `;

    const api = await TestApiClient.for({ organizationId: orgId, userId: owner.id, memberRole: 'owner' });
    await api.entity_schema.createType({
      slug: 'mbs-region-total',
      name: 'Region Total',
      backing: { sql: BACKING_SQL, connection: 'mbs-org-db' },
    });
    await api.entity_schema.createType({
      slug: 'mbs-private-total',
      name: 'Private Region Total',
      backing: { sql: BACKING_SQL, connection: 'mbs-priv-db' },
    });
  }, 120_000);

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS mbs_ext`;
  });

  const sortByRegion = (rows: Record<string, unknown>[]) =>
    [...rows]
      .sort((a, b) => String(a.region).localeCompare(String(b.region)))
      .map((row) => ({ region: row.region, total_amount: Number(row.total_amount) }));

  it('query_metric pushes a derived measure down to backing_source', async () => {
    const res = await queryMetric(
      { entity_type: 'mbs-region-total', measure: 'total_amount', by: ['region'] },
      env,
      ownerCtx,
    );
    expect(sortByRegion(res.rows)).toEqual([
      { region: 'north', total_amount: 15 },
      { region: 'south', total_amount: 7 },
    ]);
  }, 60_000);

  it('a member reads an org-visible connection-backed metric, matching the derived read', async () => {
    const metric = await queryMetric(
      { entity_type: 'mbs-region-total', measure: 'total_amount', by: ['region'] },
      env,
      memberCtx,
    );
    const derived = await querySql(
      { sql: BACKING_SQL, connection: 'mbs-org-db' },
      env,
      memberCtx,
    );
    expect(derived.error).toBeUndefined();
    expect(sortByRegion(metric.rows)).toEqual(sortByRegion(derived.rows));
  }, 60_000);

  it('applies the derived-read visibility decision to a private backing connection', async () => {
    // Member: the derived read refuses another user's private connection, so
    // the metric must refuse it the same way.
    await expect(
      querySql({ sql: BACKING_SQL, connection: 'mbs-priv-db' }, env, memberCtx),
    ).rejects.toThrow(/not found or not accessible/i);
    await expect(
      queryMetric({ entity_type: 'mbs-private-total', measure: 'total_amount' }, env, memberCtx),
    ).rejects.toThrow(/not found or not accessible/i);

    // An admin who did NOT create the private connection: the derived read's
    // owner/admin bypass reaches it, so the metric must too.
    const derived = await querySql({ sql: BACKING_SQL, connection: 'mbs-priv-db' }, env, adminCtx);
    expect(derived.error).toBeUndefined();
    const metric = await queryMetric(
      { entity_type: 'mbs-private-total', measure: 'total_amount', by: ['region'] },
      env,
      adminCtx,
    );
    expect(sortByRegion(metric.rows)).toEqual([
      { region: 'north', total_amount: 15 },
      { region: 'south', total_amount: 7 },
    ]);
  }, 60_000);

  it('a headless runMetric caller sees org-visible backing connections only', async () => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: 'mbs-region-total',
      measure: 'total_amount',
      by: ['region'],
      userId: null,
      excludeMemberEntities: false,
    });
    expect(sortByRegion(rows)).toHaveLength(2);
    await expect(
      runMetric({
        organizationId: orgId,
        entityType: 'mbs-private-total',
        measure: 'total_amount',
        userId: null,
        excludeMemberEntities: false,
      }),
    ).rejects.toThrow(/not found or not accessible/i);
  }, 60_000);

  it('refuses a declared event measure on a connection-backed type instead of running it locally', async () => {
    const api = await TestApiClient.for({
      organizationId: orgId,
      userId: ownerCtx.userId as string,
      memberRole: 'owner',
    });
    await api.entity_schema.createType({
      slug: 'mbs-declared',
      name: 'Declared Over Connection',
      backing: { sql: BACKING_SQL, connection: 'mbs-org-db' },
      metrics_config: {
        eventSets: { rows: { by: 'alias', field: "metadata->>'region'", against: 'aliases' } },
        measures: { event_count: { eventSet: 'rows', agg: 'count', description: 'Synthetic count.' } },
      },
    });
    await expect(
      queryMetric({ entity_type: 'mbs-declared', measure: 'event_count' }, env, ownerCtx),
    ).rejects.toThrow(/backed by connection "mbs-org-db"/);
    const catalog = await listMetrics({ entity_type: 'mbs-declared' }, env, ownerCtx);
    expect(catalog.entity_types[0]?.measures.map((m) => m.name)).toEqual(['total_amount']);
  }, 60_000);

  it('list_metrics catalogs the inferred measure of a connection-backed type', async () => {
    const res = await listMetrics({ entity_type: 'mbs-region-total' }, env, ownerCtx);
    const entry = res.entity_types.find((e) => e.entity_type === 'mbs-region-total');
    expect(entry?.measures.map((m) => m.name)).toEqual(['total_amount']);
    expect(entry?.dimensions.map((d) => d.name)).toEqual(['region']);
  }, 60_000);

  it('does not advertise a rejected declared measure as an inferred measure with the same name', async () => {
    const api = await TestApiClient.for({
      organizationId: orgId,
      userId: ownerCtx.userId as string,
      memberRole: 'owner',
    });
    await api.entity_schema.createType({
      slug: 'mbs-collision',
      name: 'Colliding Measure',
      backing: { sql: BACKING_SQL, connection: 'mbs-org-db' },
      metrics_config: {
        eventSets: { rows: { by: 'alias', field: "metadata->>'region'", against: 'aliases' } },
        measures: { total_amount: { eventSet: 'rows', agg: 'count', description: 'Synthetic count.' } },
      },
    });
    await expect(
      queryMetric({ entity_type: 'mbs-collision', measure: 'total_amount' }, env, ownerCtx),
    ).rejects.toThrow(/backed by connection "mbs-org-db"/);
    const catalog = await listMetrics({ entity_type: 'mbs-collision' }, env, ownerCtx);
    expect(catalog.entity_types[0]?.measures).toEqual([]);
    const filtered = await listMetrics({ entity_type: 'mbs-collision', q: 'total amount' }, env, ownerCtx);
    expect(filtered.entity_types).toEqual([]);
  }, 60_000);

  it.each([5000, 5001])('requires a complete result for a source with %i metric rows', async (count) => {
    const api = await TestApiClient.for({
      organizationId: orgId,
      userId: ownerCtx.userId as string,
      memberRole: 'owner',
    });
    const slug = `mbs-limit-${count}`;
    await api.entity_schema.createType({
      slug,
      name: 'Row Limit',
      backing: {
        sql: `SELECT n AS region, COUNT(*) AS total_amount FROM generate_series(1, ${count}) AS n GROUP BY n`,
        connection: 'mbs-org-db',
      },
    });
    const result = queryMetric({ entity_type: slug, measure: 'total_amount', by: ['region'] }, env, ownerCtx);
    if (count === 5000) {
      expect((await result).rows).toHaveLength(count);
    } else {
      await expect(result).rejects.toMatchObject({ httpStatus: 422 });
      // Dimensions only project columns; dropping them cannot reduce the row count.
      await expect(
        queryMetric({ entity_type: slug, measure: 'total_amount' }, env, ownerCtx),
      ).rejects.toMatchObject({ httpStatus: 422 });
    }
  }, 60_000);

  it('surfaces a failed source query instead of returning an empty metric', async () => {
    const api = await TestApiClient.for({
      organizationId: orgId,
      userId: ownerCtx.userId as string,
      memberRole: 'owner',
    });
    await api.entity_schema.createType({
      slug: 'mbs-broken',
      name: 'Broken Source Query',
      backing: {
        sql: 'SELECT SUM(missing_amount) AS total_amount FROM mbs_ext',
        connection: 'mbs-org-db',
      },
    });
    await expect(
      queryMetric({ entity_type: 'mbs-broken', measure: 'total_amount' }, env, ownerCtx),
    ).rejects.toThrow(/connection pushdown failed/);
  }, 60_000);
});
