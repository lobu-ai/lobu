/**
 * Entity list `segment` filter: a named `on: "entity"` segment declared in the
 * type's metrics_config narrows the stored-entity list. The predicate is
 * org-authored SQL, so it runs through the metric compiler's parse / validate /
 * org-scope pass; unknown names, event-grain segments, predicates that reach
 * beyond `entities`, and derived types are typed 400s.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { post } from '../../setup/test-helpers';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';

interface ListResult {
  entities?: Array<{ id: number; name: string }>;
  metadata?: { total_count?: number; has_more?: boolean };
}

const METRICS = {
  segments: {
    gold_tier: {
      description: 'Vendors on the gold tier.',
      where: "metadata->>'tier' = 'gold'",
      on: 'entity',
    },
    recent_orders: {
      description: 'Order events from the last week.',
      where: "occurred_at > now() - interval '7 days'",
      on: 'event',
    },
    reads_events: {
      description: 'Vendors with any event (walks history).',
      where: 'id IN (SELECT unnest(entity_ids) FROM events)',
      on: 'entity',
    },
    bad_column: {
      description: 'References a column entities does not have.',
      where: 'no_such_column = 1',
      on: 'entity',
    },
    literal_label: {
      description: 'A label containing alias placeholder text.',
      where: "metadata->>'label' = '{e}.name {et}.slug'",
      on: 'entity',
    },
    sequence_write: {
      description: 'A function with a database side effect.',
      where: "setval('entity_list_segment_probe', 100) > 0",
      on: 'entity',
    },
    member_probe: {
      description: 'A predicate reading protected member metadata.',
      where: "metadata->>'tier' = 'gold' AND EXISTS (SELECT 1 FROM entities protected WHERE protected.entity_type = '$member' AND protected.metadata->>'email' = 'private-member@test.example.com')",
      on: 'entity',
    },
  },
};

describe('entity list segment filter', () => {
  let owner: TestApiClient;
  let member: TestApiClient;
  let orgSlug: string;
  let cookie: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'EntityListSegment Org' });
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'entity-segment@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    cookie = (await createTestSession(user.id)).cookieHeader;
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    const ordinaryUser = await createTestUser({ email: 'segment-reader@test.example.com' });
    await addUserToOrganization(ordinaryUser.id, org.id, 'member');
    member = await TestApiClient.for({
      organizationId: org.id,
      userId: ordinaryUser.id,
      memberRole: 'member',
    });
    await ensureMemberEntityType(org.id);
    const protectedMember = await createTestEntity({
      organization_id: org.id,
      entity_type: '$member',
      name: 'Private member',
      created_by: user.id,
    });
    const sql = getTestDb();
    await sql`
      UPDATE entities SET metadata = ${sql.json({ email: 'private-member@test.example.com', role: 'owner' })}
      WHERE id = ${protectedMember.id}
    `;

    await owner.entity_schema.createType({
      slug: 'synthetic-vendor',
      name: 'Synthetic vendor',
      metrics_config: METRICS,
    });
    for (const [name, tier] of [
      ['vendor-a', 'gold'],
      ['vendor-b', 'silver'],
      ['vendor-c', 'gold'],
      ['vendor-d', 'bronze'],
    ]) {
      await owner.entities.create({
        entity_type: 'synthetic-vendor', name,
        metadata: { tier, label: name === 'vendor-a' ? '{e}.name {et}.slug' : '' },
      });
    }
    await owner.entity_schema.createType({
      slug: 'synthetic-derived',
      name: 'Synthetic derived',
      backing: { sql: 'SELECT semantic_type AS id, COUNT(*) AS n FROM events GROUP BY 1' },
    });

    // Same type slug and a gold vendor in another org: org scoping must hold.
    const other = await createTestOrganization({ name: 'EntityListSegment Other' });
    const otherUser = await createTestUser({ email: 'entity-segment-other@test.com' });
    await addUserToOrganization(otherUser.id, other.id, 'owner');
    const otherOwner = await TestApiClient.for({
      organizationId: other.id,
      userId: otherUser.id,
      memberRole: 'owner',
    });
    await otherOwner.entity_schema.createType({
      slug: 'synthetic-vendor',
      name: 'Synthetic vendor',
      metrics_config: METRICS,
    });
    await otherOwner.entities.create({
      entity_type: 'synthetic-vendor',
      name: 'foreign-gold',
      metadata: { tier: 'gold' },
    });
  }, 60_000);

  afterAll(cleanupTestDatabase);

  it('lists only entities matching the segment, on both page-fetch paths', async () => {
    const plain = (await owner.entities.list({
      entity_type: 'synthetic-vendor',
      segment: 'gold_tier',
      sort_by: 'name',
      sort_order: 'asc',
    })) as ListResult;
    expect(plain.metadata?.total_count).toBe(2);
    expect(plain.entities?.map((e) => e.name)).toEqual(['vendor-a', 'vendor-c']);

    const computed = (await owner.entities.list({
      entity_type: 'synthetic-vendor',
      segment: 'gold_tier',
      sort_by: 'total_content',
    })) as ListResult;
    expect(computed.metadata?.total_count).toBe(2);
    expect(new Set(computed.entities?.map((e) => e.name))).toEqual(new Set(['vendor-a', 'vendor-c']));
  });

  it('composes with the other list filters and pagination', async () => {
    const page = (await owner.entities.list({
      entity_type: 'synthetic-vendor',
      segment: 'gold_tier',
      search: 'vendor',
      sort_by: 'name',
      sort_order: 'asc',
      limit: 1,
      offset: 1,
    })) as ListResult;
    expect(page.metadata?.total_count).toBe(2);
    expect(page.metadata?.has_more).toBe(false);
    expect(page.entities?.map((e) => e.name)).toEqual(['vendor-c']);
  });

  it('applies the metric SQL member-privacy boundary inside segment predicates', async () => {
    const args = { entity_type: 'synthetic-vendor', segment: 'member_probe' };
    const privileged = (await owner.entities.list(args)) as ListResult;
    expect(privileged.metadata?.total_count).toBe(2);
    const restricted = (await member.entities.list(args)) as ListResult;
    expect(restricted.entities).toEqual([]);
    expect(restricted.metadata?.total_count).toBe(0);
  });

  it.each(['name', 'total_content'])('preserves predicate literals when sorting by %s', async (sort_by) => {
    const result = (await owner.entities.list({
      entity_type: 'synthetic-vendor', segment: 'literal_label', sort_by,
    })) as ListResult;
    expect(result.metadata?.total_count).toBe(1);
    expect(result.entities?.map((e) => e.name)).toEqual(['vendor-a']);
  });

  it('executes segment predicates in a read-only transaction', async () => {
    const sql = getTestDb();
    await sql`CREATE SEQUENCE entity_list_segment_probe START 41`;
    try {
      const { status, text } = await listOverHttp({
        entity_type: 'synthetic-vendor', segment: 'sequence_write',
      });
      expect(status).toBe(400);
      const body = JSON.parse(text) as { error?: string; code?: string };
      expect(body.code).toBe('VALIDATION');
      expect(body.error).toContain('read-only transaction');
      const [sequence] = await sql`SELECT last_value, is_called FROM entity_list_segment_probe`;
      expect(Number(sequence.last_value)).toBe(41);
      expect(sequence.is_called).toBe(false);
    } finally {
      await sql`DROP SEQUENCE entity_list_segment_probe`;
    }
  });

  async function listOverHttp(body: Record<string, unknown>) {
    const response = await post(`/api/${orgSlug}/manage_entity`, {
      cookie,
      body: { action: 'list', ...body },
    });
    return { status: response.status, text: await response.text() };
  }

  it.each([
    [{ entity_type: 'synthetic-vendor', segment: 'no_such_segment' }, 'is not declared'],
    [{ entity_type: 'synthetic-vendor', segment: 'recent_orders' }, "on: 'event'"],
    [{ entity_type: 'synthetic-vendor', segment: 'reads_events' }, 'may only filter on entities'],
    [{ entity_type: 'synthetic-vendor', segment: 'bad_column' }, 'invalid predicate'],
    [{ entity_type: 'synthetic-derived', segment: 'gold_tier' }, 'Derived entity type'],
    [{ segment: 'gold_tier' }, 'segment requires entity_type'],
  ])('rejects %o with a typed 400', async (args, message) => {
    const { status, text } = await listOverHttp(args);
    expect(status).toBe(400);
    const body = JSON.parse(text) as { error?: string; code?: string };
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toContain(message);
  });

  it('accepts the segment over HTTP', async () => {
    const { status, text } = await listOverHttp({
      entity_type: 'synthetic-vendor',
      segment: 'gold_tier',
      sort_by: 'name',
      sort_order: 'asc',
    });
    expect(status).toBe(200);
    const body = JSON.parse(text) as ListResult;
    expect(body.entities?.map((e) => e.name)).toEqual(['vendor-a', 'vendor-c']);
  });
});
