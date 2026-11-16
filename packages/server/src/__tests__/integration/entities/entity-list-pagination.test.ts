/**
 * Stored entity list — pagination + sort contract for the two-stage page
 * fetch.
 *
 * Plain-column sorts (created_at, name) resolve the page ids first — filters
 * + ORDER BY only, no per-row count LATERALs — and enrich just those rows.
 * Computed-column sorts (total_content, …) need the counts for ordering and
 * keep the single-query shape. Both must return identical rows/totals; this
 * file pins that, plus has_more/offset walking and that the per-row count
 * enrichment stays correct after the prefetch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { post } from '../../setup/test-helpers';

interface ListedEntity {
  id: number;
  name: string;
  total_content?: number;
}

interface ListResult {
  entities?: ListedEntity[];
  metadata?: {
    total_count?: number;
    has_more?: boolean;
    limit?: number;
    offset?: number;
    sort_by?: string;
    sort_order?: string;
  };
}

describe('stored entity list pagination + sort (two-stage page fetch)', () => {
  let owner: TestApiClient;
  let orgId: string;

  // Created in name order a..g so created_at order == name order (ties on
  // e.created_at fall back to e.id ASC, which follows creation order too).
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'EntityListPagination Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'entity-page@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });

    for (const name of names) {
      const created = (await owner.entities.create({ entity_type: 'company', name })) as {
        entity: { id: number };
      };
      ids[name] = created.entity.id;
    }

    // alpha: 3 linked events, bravo: 1, the rest none — drives the
    // total_content assertions and the computed-sort test.
    for (let i = 0; i < 3; i++) {
      await createTestEvent({
        organization_id: orgId,
        entity_id: ids.alpha,
        content: `alpha event ${i}`,
      });
    }
    await createTestEvent({
      organization_id: orgId,
      entity_id: ids.bravo,
      content: 'bravo event 0',
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('walks pages with offset under the default created_at DESC sort', async () => {
    const page1 = (await owner.entities.list({
      entity_type: 'company',
      limit: 3,
      offset: 0,
    })) as ListResult;
    expect(page1.metadata?.total_count).toBe(7);
    expect(page1.metadata?.has_more).toBe(true);
    expect(page1.entities?.map((e) => e.name)).toEqual(['golf', 'foxtrot', 'echo']);

    const page2 = (await owner.entities.list({
      entity_type: 'company',
      limit: 3,
      offset: 3,
    })) as ListResult;
    expect(page2.metadata?.total_count).toBe(7);
    expect(page2.metadata?.has_more).toBe(true);
    expect(page2.entities?.map((e) => e.name)).toEqual(['delta', 'charlie', 'bravo']);

    const page3 = (await owner.entities.list({
      entity_type: 'company',
      limit: 3,
      offset: 6,
    })) as ListResult;
    expect(page3.metadata?.total_count).toBe(7);
    expect(page3.metadata?.has_more).toBe(false);
    expect(page3.entities?.map((e) => e.name)).toEqual(['alpha']);
  });

  it('walks pages under created_at ASC sort (prefetch path)', async () => {
    const page1 = (await owner.entities.list({
      entity_type: 'company',
      limit: 4,
      offset: 0,
      sort_by: 'created_at',
      sort_order: 'asc',
    })) as ListResult;
    expect(page1.metadata?.total_count).toBe(7);
    expect(page1.metadata?.has_more).toBe(true);
    expect(page1.entities?.map((e) => e.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);

    const page2 = (await owner.entities.list({
      entity_type: 'company',
      limit: 4,
      offset: 4,
      sort_by: 'created_at',
      sort_order: 'asc',
    })) as ListResult;
    expect(page2.metadata?.has_more).toBe(false);
    expect(page2.entities?.map((e) => e.name)).toEqual(['echo', 'foxtrot', 'golf']);
  });

  it('walks pages under name sort (prefetch path)', async () => {
    const res = (await owner.entities.list({
      entity_type: 'company',
      limit: 3,
      offset: 0,
      sort_by: 'name',
      sort_order: 'desc',
    })) as ListResult;
    expect(res.metadata?.total_count).toBe(7);
    expect(res.entities?.map((e) => e.name)).toEqual(['golf', 'foxtrot', 'echo']);
  });

  it('sorts by the computed total_content column (single-query path)', async () => {
    const res = (await owner.entities.list({
      entity_type: 'company',
      limit: 7,
      offset: 0,
      sort_by: 'total_content',
      sort_order: 'desc',
    })) as ListResult;
    expect(res.metadata?.total_count).toBe(7);
    expect(res.entities?.[0]?.name).toBe('alpha');
    expect(res.entities?.[0]?.total_content).toBe(3);
    expect(res.entities?.[1]?.name).toBe('bravo');
    expect(res.entities?.[1]?.total_content).toBe(1);
  });

  it('keeps per-row count enrichment correct after the page-id prefetch', async () => {
    const res = (await owner.entities.list({
      entity_type: 'company',
      limit: 7,
      offset: 0,
    })) as ListResult;
    const byName = Object.fromEntries((res.entities ?? []).map((e) => [e.name, e]));
    expect(byName.alpha.total_content).toBe(3);
    expect(byName.bravo.total_content).toBe(1);
    expect(byName.charlie.total_content).toBe(0);
  });

  it('filters within the prefetched page (search applies to both stages)', async () => {
    const res = (await owner.entities.list({
      entity_type: 'company',
      search: 'alph',
      limit: 3,
      offset: 0,
    })) as ListResult;
    expect(res.metadata?.total_count).toBe(1);
    expect(res.metadata?.has_more).toBe(false);
    expect(res.entities?.map((e) => e.name)).toEqual(['alpha']);
  });
});

describe('entity list parent filter over HTTP', () => {
  let orgSlug: string;
  let cookie: string;
  let parentId: number;
  let foreignParentId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization();
    orgSlug = org.slug;
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    cookie = (await createTestSession(user.id)).cookieHeader;
    const create = (name: string, parent_id?: number) => createTestEntity({
      name, parent_id, organization_id: org.id, entity_type: 'synthetic-task',
    });
    parentId = (await create('root-a')).id;
    await create('root-b');
    await create('child-a', parentId);
    await create('child-b', parentId);
    const foreign = await createTestOrganization();
    foreignParentId = (await createTestEntity({
      name: 'foreign-root', organization_id: foreign.id, entity_type: 'synthetic-task',
    })).id;
    await createTestEntity({
      name: 'foreign-child', parent_id: foreignParentId,
      organization_id: foreign.id, entity_type: 'synthetic-task',
    });
  });

  afterAll(cleanupTestDatabase);

  async function list(filter: Record<string, unknown> = {}): Promise<ListResult> {
    const response = await post(`/api/${orgSlug}/manage_entity`, {
      cookie,
      body: { action: 'list', entity_type: 'synthetic-task', sort_by: 'name', sort_order: 'asc', ...filter },
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  it('omits the parent filter to include roots and children', async () => {
    const result = await list();
    expect(result.metadata?.total_count).toBe(4);
    expect(result.entities?.map((entity) => entity.name)).toEqual(['child-a', 'child-b', 'root-a', 'root-b']);
  });

  it('accepts the UI root-count query and paginates only roots', async () => {
    const first = await list({ parent_id: null, limit: 1, offset: 0 });
    expect(first.metadata).toMatchObject({ total_count: 2, has_more: true });
    expect(first.entities?.map((entity) => entity.name)).toEqual(['root-a']);
    const second = await list({ parent_id: null, limit: 1, offset: 1 });
    expect(second.metadata).toMatchObject({ total_count: 2, has_more: false });
    expect(second.entities?.map((entity) => entity.name)).toEqual(['root-b']);
    const computedSort = await list({ parent_id: null, sort_by: 'total_content' });
    expect(computedSort.metadata?.total_count).toBe(2);
    expect(new Set(computedSort.entities?.map((entity) => entity.name))).toEqual(new Set(['root-a', 'root-b']));
  });

  it('returns only the requested parent children and never another tenant', async () => {
    const children = await list({ parent_id: parentId });
    expect(children.metadata?.total_count).toBe(2);
    expect(children.entities?.map((entity) => entity.name)).toEqual(['child-a', 'child-b']);
    const foreign = await list({ parent_id: foreignParentId });
    expect(foreign.metadata?.total_count).toBe(0);
    expect(foreign.entities).toEqual([]);
  });
});

describe('entity list sort by a declared metadata field', () => {
  let orgSlug: string;
  let ownerCookie: string;
  let memberCookie: string;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'EntityMetadataSort Org' });
    orgSlug = org.slug;
    const ownerUser = await createTestUser({ email: 'metadata-sort-owner@test.example.com' });
    const memberUser = await createTestUser({ email: 'metadata-sort-member@test.example.com' });
    await addUserToOrganization(ownerUser.id, org.id, 'owner');
    await addUserToOrganization(memberUser.id, org.id, 'member');
    ownerCookie = (await createTestSession(ownerUser.id)).cookieHeader;
    memberCookie = (await createTestSession(memberUser.id)).cookieHeader;
    const owner = await TestApiClient.for({ organizationId: org.id, userId: ownerUser.id, memberRole: 'owner' });

    await owner.entity_schema.createType({
      slug: 'synthetic-ticket',
      name: 'Synthetic ticket',
      metadata_schema: {
        type: 'object',
        properties: {
          due_at: { type: 'string', format: 'date-time' },
          due_day: { type: 'string', format: 'date' },
          points: { type: ['integer', 'null'] },
          urgent: { type: 'boolean' },
          stage: { type: 'string', enum: ['new', 'open', 'done'] },
          tier: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          extra: { type: 'object' },
        },
      },
      metrics_config: {
        segments: { not_done: { description: 'Open work.', where: "metadata->>'stage' <> 'done'", on: 'entity' } },
      },
    });
    const rows: Array<[string, Record<string, unknown>]> = [
      ['t1', { due_at: '2026-03-01T10:00:00Z', due_day: '2026-03-02', points: 5, urgent: true, stage: 'open', tier: 'a' }],
      // 12:00+05:00 is 07:00Z: earlier than t1 as an instant, later as text.
      ['t2', { due_at: '2026-03-01T12:00:00+05:00', due_day: '2026-01-15', points: 10, urgent: false, stage: 'new', tier: 'a' }],
      ['t3', { due_at: '2026-02-01T00:00:00Z', points: 5, stage: 'done', tier: 'b' }],
      ['t4', { points: -1, stage: 'done', tier: 'a' }],
      ['t5', { due_at: '2026-03-01T10:00:00Z', points: 2, stage: 'open', tier: 'a' }],
      ['t6', { stage: 'open', tier: 'a' }],
      ['t7', { stage: 'done', tier: 'b' }],
    ];
    for (const [name, metadata] of rows) {
      const created = (await owner.entities.create({ entity_type: 'synthetic-ticket', name, metadata })) as {
        entity: { id: number };
      };
      ids[name] = created.entity.id;
    }
    // Rows written before the schema typed these fields hold values that do
    // not parse as the declared type; they sort as missing, never as errors.
    const sql = getTestDb();
    await sql`UPDATE entities SET metadata = metadata || ${sql.json({ due_at: 'not a date', due_day: '2026-02-30', points: '7', urgent: 'yes' })} WHERE id = ${ids.t6}`;
    await sql`UPDATE entities SET metadata = metadata || ${sql.json({ due_at: 'now', due_day: 'today' })} WHERE id = ${ids.t7}`;

    await ensureMemberEntityType(org.id);
    for (const [name, email] of [['Zed Member', 'a-member@test.example.com'], ['Amy Member', 'z-member@test.example.com']]) {
      await createTestEntity({ name, organization_id: org.id, entity_type: '$member' });
      await sql`UPDATE entities SET metadata = ${sql.json({ email, status: 'active', role: 'member' })}
        WHERE organization_id = ${org.id} AND name = ${name}`;
    }

    await owner.entity_schema.createType({
      slug: 'synthetic-derived-ticket',
      name: 'Synthetic derived ticket',
      backing: { sql: "SELECT * FROM (VALUES ('b', 20), ('a', 10), ('c', 30)) AS rows(slug, amount)" },
    });
  }, 60_000);

  afterAll(cleanupTestDatabase);

  async function list(body: Record<string, unknown>, cookie = ownerCookie) {
    return post(`/api/${orgSlug}/manage_entity`, { cookie, body: { action: 'list', ...body } });
  }
  async function names(body: Record<string, unknown>, cookie = ownerCookie): Promise<string[]> {
    const response = await list({ entity_type: 'synthetic-ticket', limit: 50, ...body }, cookie);
    expect(response.status).toBe(200);
    return ((await response.json()) as ListResult).entities?.map((e) => e.name) ?? [];
  }

  it('orders by the schema type with missing and unparseable values last, ties by id', async () => {
    expect(await names({ sort_by: 'metadata.due_at', sort_order: 'asc' })).toEqual(['t3', 't2', 't1', 't5', 't4', 't6', 't7']);
    expect(await names({ sort_by: 'metadata.due_at', sort_order: 'desc' })).toEqual(['t1', 't5', 't2', 't3', 't4', 't6', 't7']);
    expect(await names({ sort_by: 'metadata.due_day', sort_order: 'asc' })).toEqual(['t2', 't1', 't3', 't4', 't5', 't6', 't7']);
    expect(await names({ sort_by: 'metadata.points', sort_order: 'asc' })).toEqual(['t4', 't5', 't1', 't3', 't2', 't6', 't7']);
    expect(await names({ sort_by: 'metadata.urgent', sort_order: 'desc' })).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
    expect(await names({ sort_by: 'metadata.stage', sort_order: 'asc' })).toEqual(['t3', 't4', 't7', 't2', 't1', 't5', 't6']);
  });

  it('walks offset pages in one stable order and echoes the sort key', async () => {
    const seen: string[] = [];
    for (const offset of [0, 3, 6]) {
      const response = await list({ entity_type: 'synthetic-ticket', sort_by: 'metadata.due_at', sort_order: 'desc', limit: 3, offset });
      const body = (await response.json()) as ListResult;
      expect(body.metadata).toMatchObject({ total_count: 7, has_more: offset < 6, sort_by: 'metadata.due_at', sort_order: 'desc' });
      seen.push(...(body.entities?.map((e) => e.name) ?? []));
    }
    expect(seen).toEqual(['t1', 't5', 't2', 't3', 't4', 't6', 't7']);
  });

  it('applies attribute filters and segments before ordering', async () => {
    const filters = [{ field: 'tier', op: 'eq', value: 'a' }];
    expect(await names({ sort_by: 'metadata.due_at', sort_order: 'asc', filters })).toEqual(['t2', 't1', 't5', 't4', 't6']);
    expect(await names({ sort_by: 'metadata.due_at', sort_order: 'asc', filters, segment: 'not_done', limit: 2, offset: 2 })).toEqual(['t5', 't6']);
  });

  it('rejects sort keys the list cannot honour instead of falling back to created_at', async () => {
    for (const [body, pattern] of [
      [{ entity_type: 'synthetic-ticket', sort_by: 'metadata.missing' }, /not declared/],
      [{ entity_type: 'synthetic-ticket', sort_by: 'metadata.tags' }, /scalar/],
      [{ entity_type: 'synthetic-ticket', sort_by: 'metadata.extra' }, /scalar/],
      [{ entity_type: 'synthetic-ticket', sort_by: 'updated_at' }, /sort_by/],
      [{ sort_by: 'metadata.due_at' }, /entity_type/],
    ] as const) {
      const response = await list(body);
      expect(response.status).toBe(400);
      expect(String(((await response.json()) as { error?: string }).error)).toMatch(pattern);
    }
  });

  it('sorts $member by email only for callers who can see emails', async () => {
    const forbidden = await list({ entity_type: '$member', sort_by: 'metadata.email' }, memberCookie);
    expect(forbidden.status).toBe(403);
    const byStatus = await list({ entity_type: '$member', sort_by: 'metadata.status' }, memberCookie);
    expect(byStatus.status).toBe(200);
    const owner = await list({ entity_type: '$member', sort_by: 'metadata.email', sort_order: 'asc' });
    expect(owner.status).toBe(200);
    const listed = ((await owner.json()) as ListResult).entities?.map((e) => e.name) ?? [];
    expect(listed.filter((name) => name.endsWith('Member'))).toEqual(['Zed Member', 'Amy Member']);
  });

  it('passes a metadata sort to a derived type as its projected column', async () => {
    const response = await list({ entity_type: 'synthetic-derived-ticket', sort_by: 'metadata.amount', sort_order: 'desc' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListResult & { entities: Array<{ slug: string }> };
    expect(body.entities.map((e) => e.slug)).toEqual(['c', 'b', 'a']);
    expect(body.metadata?.sort_by).toBe('metadata.amount');
  });
});
