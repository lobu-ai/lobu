/**
 * Derived-entity ROUTING path.
 *
 * Derived ("view") entity types have no rows in `entities` — their rows come
 * from `backing_sql`. This proves the backend abstracts that away so the
 * frontend treats derived rows like stored entities:
 *   - `manage_entity` list returns derived rows in the standard entity shape,
 *     org-scoped.
 *   - `resolve_path` resolves a single derived row by slug into a read-only
 *     entity (with inferred `measure_columns`), and 404s an unknown slug.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { queryDerivedEntityView } from '../../../utils/entity-management';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient } from '../../setup/test-mcp-client';

// A derived view over events that emits id/slug/name (so its rows can be routed
// like stored entities) plus two aggregate measures.
const SPEND_VIEW_SQL = `
  SELECT
    'vendor:' || (metadata->>'vendor') AS id,
    (metadata->>'vendor') AS name,
    'vendor-' || (metadata->>'vendor') AS slug,
    SUM((metadata->>'amount')::numeric) AS total_spend,
    COUNT(*) AS purchases
  FROM events
  WHERE metadata->>'vendor' IS NOT NULL
  GROUP BY 1, 2, 3
`;

describe('derived entity routing (list + resolve_path)', () => {
  let api: TestApiClient;
  let orgAId: string;
  let orgBId: string;
  let orgSlug: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const orgA = await createTestOrganization({ name: 'Derived Routing A' });
    const orgB = await createTestOrganization({ name: 'Derived Routing B' });
    orgAId = orgA.id;
    orgBId = orgB.id;
    orgSlug = orgA.slug;
    const user = await createTestUser({ email: 'derived-routing@test.com' });
    userId = user.id;
    await addUserToOrganization(user.id, orgA.id, 'owner');
    api = await TestApiClient.for({
      organizationId: orgA.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await api.entity_schema.createType({
      slug: 'spend-vendor',
      name: 'Spend by vendor',
      backing: { sql: SPEND_VIEW_SQL },
    });

    // Org A: acme x2 (=15), globex x1 (=20). Org B: acme x1 (=99) — must not leak.
    await createTestEvent({ organization_id: orgAId, content: 'a1', metadata: { vendor: 'acme', amount: '10' } });
    await createTestEvent({ organization_id: orgAId, content: 'a2', metadata: { vendor: 'acme', amount: '5' } });
    await createTestEvent({ organization_id: orgAId, content: 'a3', metadata: { vendor: 'globex', amount: '20' } });
    await createTestEvent({ organization_id: orgBId, content: 'b1', metadata: { vendor: 'acme', amount: '99' } });

    const oauthClient = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, orgA.id, oauthClient.client_id)).token;
  });

  async function resolvePath(args: Record<string, unknown>) {
    const response = await post(`/api/${orgSlug}/resolve_path`, { body: args, token });
    if (response.status >= 400) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    return response.json();
  }

  it('lists derived rows in the standard entity shape (org-scoped)', async () => {
    const res = (await api.entities.list({ entity_type: 'spend-vendor' })) as {
      entities: Array<{
        name: string;
        slug: string;
        metadata: Record<string, unknown>;
      }>;
      metadata?: { total_count?: number };
    };
    const byName = Object.fromEntries(res.entities.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['acme', 'globex']);
    expect(byName.acme.slug).toBe('vendor-acme');
    // Org B's $99 acme event must NOT leak into org A's aggregate.
    expect(Number(byName.acme.metadata.total_spend)).toBe(15);
    expect(Number(byName.acme.metadata.purchases)).toBe(2);
  });

  it('accepts the entity table default sort without a source created_at column', async () => {
    const result = await api.entities.list({ entity_type: 'spend-vendor', sort_by: 'created_at', sort_order: 'desc' }) as { entities: Array<{ name: string }> };
    expect(result.entities.map(row => row.name).sort()).toEqual(['acme', 'globex']);
  });

  it('sorts the complete derived result before pagination in both directions', async () => {
    for (const [order, first, second] of [['asc', 'acme', 'globex'], ['desc', 'globex', 'acme']] as const) {
      const page = (offset: number) => api.entities.list({ entity_type: 'spend-vendor', sort_by: 'total_spend', sort_order: order, limit: 1, offset });
      const a = await page(0) as { entities: Array<{ name: string }>; metadata: { sort_by: string; sort_order: string } };
      const b = await page(1) as { entities: Array<{ name: string }> };
      expect(a.entities.map(row => row.name)).toEqual([first]);
      expect(b.entities.map(row => row.name)).toEqual([second]);
      expect(a.metadata).toMatchObject({ sort_by: 'total_spend', sort_order: order });
    }
    const defaultOrder = await api.entities.list({ entity_type: 'spend-vendor', sort_by: 'total_spend', limit: 1 }) as { entities: Array<{ name: string }>; metadata: { sort_order: string } };
    expect(defaultOrder.entities[0].name).toBe('globex');
    expect(defaultOrder.metadata.sort_order).toBe('desc');
    await expect(api.entities.list({ entity_type: 'spend-vendor', sort_by: 'name; DROP TABLE entities' })).rejects.toThrow(/sort_by/);
  });

  it('keeps equal sort values in canonical identity order across page boundaries', async () => {
    const sql = "SELECT * FROM (VALUES ('b', 20), ('a', 20), ('c', 10)) AS rows(slug, amount)";
    const pages = await Promise.all([0, 1, 2].map(offset => queryDerivedEntityView(sql, undefined,
      { limit: 1, offset, sort_by: 'amount', sort_order: 'desc' }, ownerToolContext(orgAId, userId))));
    expect(pages.flatMap(page => page.rows.map(row => row.slug))).toEqual(['a', 'b', 'c']);
  });

  it('entity list reports the true derived total while schema list/get/bootstrap skip the live derived count', async () => {
    // Policy: the entity LIST runs the backing SQL anyway (it needs the rows),
    // so it reports the exact total via a single-pass window count. Schema
    // list/get and the resolve_path bootstrap must NOT re-run the backing SQL
    // just for a badge count — those hot paths report 0 for derived types.
    const list = (await api.entities.list({ entity_type: 'spend-vendor' })) as {
      entities: unknown[];
      metadata?: { total_count?: number };
    };
    const listTotal = list.metadata?.total_count ?? list.entities.length;
    expect(listTotal).toBe(2);

    const types = (await api.entity_schema.listTypes()) as {
      entity_types?: Array<{ slug: string; entity_count?: number }>;
    };
    const spend = types.entity_types?.find((t) => t.slug === 'spend-vendor');
    expect(spend?.entity_count).toBe(0);

    const got = (await api.entity_schema.getType('spend-vendor')) as {
      entity_type?: { entity_count?: number; backing_sql?: string | null };
    };
    expect(got.entity_type?.backing_sql).toBeTruthy();
    expect(got.entity_type?.entity_count).toBe(0);

    const resolved = (await resolvePath({
      path: `/${orgSlug}`,
      include_bootstrap: true,
    })) as {
      bootstrap?: { entity_types?: Array<{ slug: string; entity_count: number }> };
    };
    const bootstrapType = resolved.bootstrap?.entity_types?.find(
      (type) => type.slug === 'spend-vendor'
    );
    expect(bootstrapType?.entity_count).toBe(0);
  });

  it('keeps type lists available when a connector-backed derived count fails', async () => {
    await api.entity_schema.createType({
      slug: 'missing-derived-source',
      name: 'Missing derived source',
      backing: {
        sql: 'SELECT id, name FROM missing_table',
        connection: 'missing-connection',
      },
    });

    const types = (await api.entity_schema.listTypes()) as {
      entity_types?: Array<{ slug: string; entity_count?: number }>;
    };
    const missing = types.entity_types?.find((type) => type.slug === 'missing-derived-source');
    expect(missing?.entity_count).toBe(0);

    const resolved = (await resolvePath({
      path: `/${orgSlug}`,
      include_bootstrap: true,
    })) as {
      bootstrap?: { entity_types?: Array<{ slug: string; entity_count: number }> };
    };
    const bootstrapType = resolved.bootstrap?.entity_types?.find(
      (type) => type.slug === 'missing-derived-source'
    );
    expect(bootstrapType?.entity_count).toBe(0);
  });

  it('resolve_path resolves a derived row by slug into a read-only entity', async () => {
    const result = (await resolvePath({ path: `/${orgSlug}/spend-vendor/vendor-acme` })) as {
      entity?: {
        name: string;
        slug: string;
        is_derived?: boolean;
        measure_columns?: string[];
        metadata: Record<string, unknown>;
      };
    };
    expect(result.entity?.name).toBe('acme');
    expect(result.entity?.slug).toBe('vendor-acme');
    expect(result.entity?.is_derived).toBe(true);
    expect(Number(result.entity?.metadata.total_spend)).toBe(15);
    // measure_columns is inferred from the backing SQL (same as get_type).
    expect((result.entity?.measure_columns ?? []).sort()).toEqual(['purchases', 'total_spend']);
  });

  it('resolve_path continues after a serialized-row cap shortens a derived page', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createTestEvent({
          organization_id: orgAId,
          content: `large route ${index + 1}`,
          metadata: { large_route: String(index + 1) },
        })
      )
    );
    // Distinct 4,000-character cells stay within the per-cell bound while the
    // 20-row result exceeds the aggregate 1 MiB response ceiling.
    const largeViewSql = `
      SELECT
        'large-' || (metadata->>'large_route') AS id,
        'large-' || (metadata->>'large_route') AS slug,
        'Large ' || (metadata->>'large_route') AS name,
        repeat('x', 4000) AS pad01,
        repeat('x', 4000) AS pad02,
        repeat('x', 4000) AS pad03,
        repeat('x', 4000) AS pad04,
        repeat('x', 4000) AS pad05,
        repeat('x', 4000) AS pad06,
        repeat('x', 4000) AS pad07,
        repeat('x', 4000) AS pad08,
        repeat('x', 4000) AS pad09,
        repeat('x', 4000) AS pad10,
        repeat('x', 4000) AS pad11,
        repeat('x', 4000) AS pad12,
        repeat('x', 4000) AS pad13,
        repeat('x', 4000) AS pad14,
        repeat('x', 4000) AS pad15,
        repeat('x', 4000) AS pad16
      FROM events
      WHERE metadata->>'large_route' IS NOT NULL
      ORDER BY (metadata->>'large_route')::int
    `;
    await api.entity_schema.createType({
      slug: 'large-derived-page',
      name: 'Large derived page',
      backing: { sql: largeViewSql },
    });

    const first = await queryDerivedEntityView(
      largeViewSql,
      undefined,
      { limit: 500, offset: 0 },
      ownerToolContext(orgAId, userId)
    );
    expect(first.error).toBeUndefined();
    expect(first.rows.length).toBeLessThan(20);
    expect(first.has_more).toBe(true);
    expect(first.omitted_rows).toBe(20 - first.rows.length);
    const resolverPage = await queryDerivedEntityView(
      largeViewSql,
      undefined,
      { limit: 500, offset: 0 },
      ownerToolContext(orgAId, userId),
      { preservePageRows: true }
    );
    expect(resolverPage.rows).toHaveLength(20);
    expect(resolverPage.rows.some((row) => row.slug === 'large-20')).toBe(true);
    const second = await queryDerivedEntityView(
      largeViewSql,
      undefined,
      { limit: 500, offset: first.rows.length },
      ownerToolContext(orgAId, userId)
    );
    expect(second.rows.some((row) => row.slug === 'large-20')).toBe(true);

    const listed = (await api.entities.list({
      entity_type: 'large-derived-page',
      limit: 20,
      offset: 0,
    })) as {
      entities: Array<{ slug: string }>;
      metadata?: { has_more?: boolean; total_count?: number };
    };
    expect(listed.entities).toHaveLength(20);
    expect(listed.entities.some((entity) => entity.slug === 'large-20')).toBe(true);
    expect(listed.metadata?.has_more).toBe(false);
    expect(listed.metadata?.total_count).toBe(20);

    const result = (await resolvePath({
      path: `/${orgSlug}/large-derived-page/large-20`,
    })) as { entity?: { name: string; slug: string; is_derived?: boolean } };
    expect(result.entity?.name).toBe('Large 20');
    expect(result.entity?.slug).toBe('large-20');
    expect(result.entity?.is_derived).toBe(true);
  });

  it('resolve_path 404s an unknown derived slug (no silent fallback)', async () => {
    await expect(
      resolvePath({ path: `/${orgSlug}/spend-vendor/vendor-missing` })
    ).rejects.toThrow();
  });

  it('falls back to the id column for routing when the view projects no slug', async () => {
    // A view that emits `id`/`name` but no `slug`. The row must still be
    // routable: the slug falls back to the id, in both list and resolve.
    await api.entity_schema.createType({
      slug: 'vendor-noslug',
      name: 'Vendor (no slug)',
      backing: {
        sql: `SELECT (metadata->>'vendor') AS id, (metadata->>'vendor') AS name,
                COUNT(*) AS purchases
              FROM events WHERE metadata->>'vendor' IS NOT NULL GROUP BY 1, 2`,
      },
    });

    const list = (await api.entities.list({ entity_type: 'vendor-noslug' })) as {
      entities: Array<{ slug: string; name: string }>;
    };
    const acme = list.entities.find((e) => e.name === 'acme');
    expect(acme?.slug).toBe('acme'); // slug fell back to the id column

    const resolved = (await resolvePath({
      path: `/${orgSlug}/vendor-noslug/acme`,
    })) as { entity?: { name: string; is_derived?: boolean } };
    expect(resolved.entity?.name).toBe('acme');
    expect(resolved.entity?.is_derived).toBe(true);
  });
});
