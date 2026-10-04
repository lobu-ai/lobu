/**
 * Golden test for the metric compiler (alias resolver). Seeds Revolut-style
 * charges + a "company" entity with aliases, then runs the declared
 * `company.spend` measure end-to-end (compile → org-scope → execute) and asserts
 * the DEDUPED, outflow-only, per-currency sum. This is the correctness gate:
 * it covers alias matching, dedupe, segment filtering, the currency dimension,
 * and SUM — the exact pipeline that must not silently over/under-count.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { getTestDb } from '../../setup/test-db';
import { cleanupTestDatabase } from '../../setup/test-db';
import { TestApiClient } from '../../setup/test-mcp-client';
import { IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY } from '../../../identity/scope-projection';
import { compileMetricSql } from '../../../metrics/compiler';
import { runMetric } from '../../../metrics/run-metric';

const METRICS = {
  eventSets: {
    charges: {
      by: 'alias',
      field: "metadata->>'description'",
      against: 'aliases',
      where: "semantic_type='transaction' AND connector_key='revolut'",
      dedupeKey: ["metadata->>'date'", "metadata->>'amount'", "metadata->>'description'"],
    },
  },
  segments: {
    outflow: {
      description: 'Money leaving the account.',
      where: "metadata->>'direction'='out'",
      on: 'event',
      appliedBefore: 'dedupe',
    },
  },
  measures: {
    spend: {
      eventSet: 'charges',
      agg: 'sum',
      expr: "(metadata->>'amount')::numeric",
      segments: ['outflow'],
      description: 'Total outflow to this company, by currency.',
    },
    charges: {
      eventSet: 'charges',
      agg: 'count',
      segments: ['outflow'],
      description: 'Number of distinct outflow charges.',
    },
  },
  dimensions: {
    currency: { expr: "metadata->>'currency'", description: 'Charge currency.' },
  },
};

const TENANT_IDENTITY_METRICS = {
  eventSets: {
    customers: {
      by: 'alias',
      field: "metadata->>'erp_customer'",
      against: 'aliases',
      where: "semantic_type='customer_activity' AND connector_key='erp'",
    },
  },
  measures: {
    activities: {
      eventSet: 'customers',
      agg: 'count',
      description: 'Count customer activity events within one tenant identity scope.',
    },
  },
};

// A synthetic type whose segment filters the RESOLVED entity, not the event:
// `tier` lives on the entity's metadata and on no event.
const ENTITY_SEGMENT_METRICS = {
  eventSets: {
    orders: {
      by: 'alias',
      field: "metadata->>'vendor'",
      against: 'aliases',
      where: "connector_key='synthetic-orders'",
    },
  },
  segments: {
    gold_tier: {
      description: 'Vendors on the gold tier.',
      where: "metadata->>'tier' = 'gold'",
      on: 'entity',
    },
  },
  measures: {
    orders: { eventSet: 'orders', agg: 'count', description: 'Orders per vendor.' },
  },
};

describe('metric compiler — alias resolver golden', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Metric Golden Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'metric-golden@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    // The declared metric layer for "company".
    await owner.entity_schema.createType({
      slug: 'company',
      name: 'Company',
      metrics_config: METRICS,
    });
    await owner.entity_schema.createType({
      slug: 'tenant-company',
      name: 'Tenant company',
      metrics_config: TENANT_IDENTITY_METRICS,
    });

    // The Anthropic company with its aliases (what the resolver matches on).
    const company = await createTestEntity({
      name: 'Anthropic',
      entity_type: 'company',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE entities SET metadata = ${sql.json({ aliases: ['Claude.ai', 'Anthropic'] })}
      WHERE id = ${company.id}
    `;

    // Seed charges. Expected GBP spend = 78.35 + 20.00 = 98.35:
    const charge = (m: Record<string, unknown>) =>
      createTestEvent({
        organization_id: orgId,
        content: 'charge',
        semantic_type: 'transaction',
        connector_key: 'revolut',
        metadata: m,
      });
    await charge({ date: '2025-10-08', amount: 78.35, currency: 'GBP', direction: 'out', description: 'Claude.ai' });
    await charge({ date: '2025-11-01', amount: 20.0, currency: 'GBP', direction: 'out', description: 'Anthropic' });
    // exact duplicate (Revolut double-ingest) → deduped away by dedupeKey
    await charge({ date: '2025-11-01', amount: 20.0, currency: 'GBP', direction: 'out', description: 'Anthropic' });
    // refund (direction in) → excluded by the outflow segment
    await charge({ date: '2025-11-05', amount: 99.0, currency: 'GBP', direction: 'in', description: 'Claude.ai' });
    // USD charge → its own currency row
    await charge({ date: '2026-03-14', amount: 23.93, currency: 'USD', direction: 'out', description: 'Claude.ai' });
    // a non-Anthropic vendor → not matched by aliases
    await charge({ date: '2025-11-10', amount: 5.0, currency: 'GBP', direction: 'out', description: 'Spotify' });
  });

  it('sums deduped outflow by currency, matching only aliased charges', async () => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: 'company',
      measure: 'spend',
      by: ['currency'],
    });
    const byCur = Object.fromEntries(rows.map((r) => [r.currency as string, Number(r.spend)]));
    expect(byCur.GBP).toBeCloseTo(98.35, 2); // dup collapsed, refund + Spotify excluded
    expect(byCur.USD).toBeCloseTo(23.93, 2);
  });

  it('counts deduped outflow charges', async () => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: 'company',
      measure: 'charges',
      by: ['currency'],
    });
    const byCur = Object.fromEntries(rows.map((r) => [r.currency as string, Number(r.charges)]));
    expect(byCur.GBP).toBe(2); // Claude.ai 78.35 + Anthropic 20.00 (dup collapsed)
    expect(byCur.USD).toBe(1);
  });

  it('applies an on:"entity" segment to the resolved entity, not the events', async () => {
    const owner = await TestApiClient.for({
      organizationId: orgId,
      userId: (await createTestUser({ email: 'metric-entity-seg@test.com' })).id,
      memberRole: 'owner',
    });
    await owner.entity_schema.createType({
      slug: 'synthetic-vendor',
      name: 'Synthetic vendor',
      metrics_config: ENTITY_SEGMENT_METRICS,
    });
    const sql = getTestDb();
    const vendor = async (name: string, tier: string) => {
      const created = await createTestEntity({
        name,
        entity_type: 'synthetic-vendor',
        organization_id: orgId,
      });
      await sql`
        UPDATE entities SET metadata = ${sql.json({ aliases: [name], tier })}
        WHERE id = ${created.id}
      `;
      return created;
    };
    const gold = await vendor('vendor-gold', 'gold');
    const silver = await vendor('vendor-silver', 'silver');
    const order = (name: string) =>
      createTestEvent({
        organization_id: orgId,
        content: 'order',
        connector_key: 'synthetic-orders',
        metadata: { vendor: name },
      });
    await order('vendor-gold');
    await order('vendor-gold');
    await order('vendor-silver');

    const all = await runMetric({
      organizationId: orgId,
      entityType: 'synthetic-vendor',
      measure: 'orders',
      excludeMemberEntities: false,
    });
    expect(Object.fromEntries(all.map((r) => [Number(r.entity_id), Number(r.orders)]))).toEqual({
      [gold.id]: 2,
      [silver.id]: 1,
    });

    const goldOnly = await runMetric({
      organizationId: orgId,
      entityType: 'synthetic-vendor',
      measure: 'orders',
      segment: 'gold_tier',
      excludeMemberEntities: false,
    });
    expect(Object.fromEntries(goldOnly.map((r) => [Number(r.entity_id), Number(r.orders)]))).toEqual({
      [gold.id]: 2,
    });
  });

  it('places an event segment before or after dedupe per appliedBefore', () => {
    const compile = (appliedBefore: 'dedupe' | 'aggregate' | undefined) =>
      compileMetricSql({
        entityTypeId: 1,
        metrics: {
          ...METRICS,
          segments: { outflow: { ...METRICS.segments.outflow, appliedBefore } },
        } as never,
        measure: 'spend',
      });
    const outflow = "metadata->>'direction'='out'";
    // The pre-dedupe filter is the WHERE of the events relation the DISTINCT reads.
    const eventsWhere = (sqlText: string) =>
      sqlText.match(/FROM events WHERE ([\s\S]*?)\) evt/)?.[1] ?? '';

    const beforeDedupe = compile('dedupe');
    expect(eventsWhere(beforeDedupe)).toContain(outflow);
    expect(beforeDedupe).not.toContain('__seg0');

    for (const sqlText of [compile('aggregate'), compile(undefined)]) {
      expect(eventsWhere(sqlText)).not.toContain(outflow);
      expect(sqlText).toContain(`(${outflow}) AS __seg0`);
      expect(sqlText).toMatch(/\) resolved\s+WHERE resolved\.__seg0\s+GROUP BY/);
    }

    // No dedupeKey ⇒ no dedupe step: the default stays in the events WHERE, so
    // a dedupe-free measure compiles exactly as before.
    const noDedupe = compileMetricSql({
      entityTypeId: 1,
      metrics: {
        ...METRICS,
        eventSets: { charges: { ...METRICS.eventSets.charges, dedupeKey: undefined } },
        segments: { outflow: { ...METRICS.segments.outflow, appliedBefore: undefined } },
      } as never,
      measure: 'spend',
    });
    expect(eventsWhere(noDedupe)).toContain(outflow);
    expect(noDedupe).not.toContain('__seg0');
  });

  it('sums the same deduped outflow when the segment applies after dedupe', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE entity_types
      SET metrics_config = jsonb_set(metrics_config, '{segments,outflow,appliedBefore}', '"aggregate"')
      WHERE slug = 'company' AND organization_id = ${orgId}
    `;
    try {
      const rows = await runMetric({
        organizationId: orgId,
        entityType: 'company',
        measure: 'spend',
        by: ['currency'],
        excludeMemberEntities: false,
      });
      const byCur = Object.fromEntries(rows.map((r) => [r.currency as string, Number(r.spend)]));
      expect(byCur.GBP).toBeCloseTo(98.35, 2);
      expect(byCur.USD).toBeCloseTo(23.93, 2);
    } finally {
      await sql`
        UPDATE entity_types
        SET metrics_config = jsonb_set(metrics_config, '{segments,outflow,appliedBefore}', '"dedupe"')
        WHERE slug = 'company' AND organization_id = ${orgId}
      `;
    }
  });

  it('matches equal identifiers only within the event tenant scope', async () => {
    const tenantA = await createTestEntity({
      name: 'Tenant A customer',
      entity_type: 'tenant-company',
      organization_id: orgId,
    });
    const tenantB = await createTestEntity({
      name: 'Tenant B customer',
      entity_type: 'tenant-company',
      organization_id: orgId,
    });
    const legacyOrganization = await createTestEntity({
      name: 'Legacy organization customer',
      entity_type: 'tenant-company',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector, scope_key
      ) VALUES
        (${orgId}, ${tenantA.id}, 'erp_customer', 'C-1', 'connector:erp', 'tenant-a'),
        (${orgId}, ${tenantB.id}, 'erp_customer', 'C-1', 'connector:erp', 'tenant-b'),
        (${orgId}, ${legacyOrganization.id}, 'erp_customer', 'C-legacy', 'connector:erp', NULL)
    `;
    await sql`
      UPDATE entities
      SET metadata = ${sql.json({ aliases: ['C-legacy'] })}
      WHERE id = ${legacyOrganization.id}
    `;
    await createTestEvent({
      organization_id: orgId,
      content: 'tenant A activity',
      semantic_type: 'customer_activity',
      connector_key: 'erp',
      metadata: {
        erp_customer: 'C-1',
        [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { erp_customer: 'tenant-a' },
      },
    });
    await createTestEvent({
      organization_id: orgId,
      content: 'tenant B activity',
      semantic_type: 'customer_activity',
      connector_key: 'erp',
      metadata: {
        erp_customer: 'C-1',
        [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { erp_customer: 'tenant-b' },
      },
    });
    await createTestEvent({
      organization_id: orgId,
      content: 'legacy organization activity',
      semantic_type: 'customer_activity',
      connector_key: 'erp',
      metadata: { erp_customer: 'C-legacy' },
    });

    const rows = await runMetric({
      organizationId: orgId,
      entityType: 'tenant-company',
      measure: 'activities',
    });
    const byEntity = Object.fromEntries(
      rows.map((row) => [Number(row.entity_id), Number(row.activities)])
    );
    expect(byEntity).toEqual({
      [tenantA.id]: 1,
      [tenantB.id]: 1,
      [legacyOrganization.id]: 1,
    });
  });
});
