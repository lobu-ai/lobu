/**
 * `event_classifications` must be visible exactly when its event is.
 *
 * The CTE org-scoped classifications through an entity join:
 *
 *     JOIN public.entities ent ON ent.id = ANY(ev.entity_ids)
 *     WHERE ev.id = ec.event_id AND ent.organization_id = $org
 *
 * while the sibling `events` CTE 80 lines above scopes on a three-way OR —
 * direct `ev.organization_id`, OR entity, OR owning connection. Only the middle
 * disjunct was implemented here, so every classification on an event with no
 * entity link was structurally invisible: `SELECT count(*) FROM
 * event_classifications` returned a confident 0 while the event itself was
 * queryable in the same breath.
 *
 * Entity-less feed content is exactly what an Automation labels with
 * `classify`. Measured against prod on 2026-07-31: 280 rows were written, the
 * physical table held them, and query_sql returned 0 of 281 because they hung
 * off entity-less feed events.
 *
 * These tests execute the query rather than asserting on the generated SQL —
 * the string shape is not the boundary, the returned rows are.
 */

import { describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

function ctxFor(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
    scopes: ['mcp:read'],
  } as ToolContext;
}

/** Minimal classifier row; the `classify` writer path is covered elsewhere. */
async function seedClassifier(
  organizationId: string,
  createdBy: string,
  slug: string
): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by)
    VALUES (${organizationId}, ${slug}, ${slug}, ${slug}, 'active', ${createdBy})
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function classify(eventId: number, classifierId: number, value: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO event_classifications (event_id, classifier_id, "values", source, is_manual)
    VALUES (${eventId}, ${classifierId}, ARRAY[${value}]::text[], 'embedding', false)
  `;
}

async function readClassificationCount(ctx: ToolContext): Promise<number> {
  const result = await querySql(
    { sql: 'SELECT count(*)::int AS n FROM event_classifications' } as never,
    {} as never,
    ctx
  );
  // A failed query returns `rows: []` WITH an `error` field — reading that as
  // count 0 would let every hides-* assertion pass vacuously. Fail loud instead.
  const { rows = [], error } = result as { rows?: Array<{ n: number }>; error?: string };
  if (error) throw new Error(`query_sql failed: ${error}`);
  return rows.length > 0 ? Number(rows[0].n) : 0;
}

describe('event_classifications read scope', () => {
  it('returns classifications on an entity-less event, matching what `events` shows', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Entityless Org' });
    const user = await createTestUser({ email: 'entityless@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    // No entity_id: exactly the shape feed ingestion produces. The org stamp
    // is on the event row itself.
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'an entity-less feed post',
    });
    const classifierId = await seedClassifier(org.id, user.id, 'sentiment');
    await classify(Number(event.id), classifierId, 'positive');

    // Parity is the invariant: the event is visible, so its classification must
    // be too. Asserting the event side guards against the test passing because
    // BOTH went invisible.
    const events = await querySql(
      { sql: `SELECT id FROM events WHERE id = ${Number(event.id)}` } as never,
      {} as never,
      ctx
    );
    expect((events as { rows?: unknown[] }).rows ?? []).toHaveLength(1);

    expect(await readClassificationCount(ctx)).toBe(1);
  });

  it('returns classifications on a connection-scoped event with no entity link', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Connection Org' });
    const user = await createTestUser({ email: 'connection@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    // The third disjunct of the events predicate: reachable only through the
    // owning connection. Pinned so a later "simplification" to a bare
    // organization_id check does not silently drop it.
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test-connector',
      created_by: user.id,
      visibility: 'org',
    });
    const event = await createTestEvent({
      organization_id: org.id,
      connection_id: Number(connection.id),
      content: 'arrived through a connection',
    });
    const classifierId = await seedClassifier(org.id, user.id, 'sentiment');
    await classify(Number(event.id), classifierId, 'neutral');

    expect(await readClassificationCount(ctx)).toBe(1);
  });

  it('still hides another organization’s classifications', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const mine = await createTestOrganization({ name: 'Mine' });
    const theirs = await createTestOrganization({ name: 'Theirs' });
    const user = await createTestUser({ email: 'tenancy@test.example.com' });
    await addUserToOrganization(user.id, mine.id, 'owner');
    const ctx = ctxFor(mine.id, user.id);

    // Widening visibility must not trade a read bug for a tenancy leak. Both
    // events are entity-less, so the ONLY thing separating them is the org
    // stamp the fixed predicate reads.
    const foreignUser = await createTestUser({ email: 'foreign@test.example.com' });
    await addUserToOrganization(foreignUser.id, theirs.id, 'owner');
    const foreign = await createTestEvent({
      organization_id: theirs.id,
      content: 'another tenant’s post',
    });
    // Distinct slugs are a historical artifact: `classify_facet_unique_per_insight`
    // once had no organization_id, so two tenants could not hold the same
    // org-level slug. The key is org-scoped now (classifier-slug-tenancy.test.ts
    // asserts that); the distinct slugs merely keep this test about the read
    // predicate.
    const foreignClassifier = await seedClassifier(theirs.id, foreignUser.id, 'sentiment-theirs');
    await classify(Number(foreign.id), foreignClassifier, 'positive');

    expect(await readClassificationCount(ctx)).toBe(0);

    const own = await createTestEvent({ organization_id: mine.id, content: 'my post' });
    const ownClassifier = await seedClassifier(mine.id, user.id, 'sentiment');
    await classify(Number(own.id), ownClassifier, 'negative');

    expect(await readClassificationCount(ctx)).toBe(1);
  });

  it('keeps hiding classifications on another user’s private-connection event', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Private Conn Org' });
    const owner = await createTestUser({ email: 'owner@test.example.com' });
    const other = await createTestUser({ email: 'other@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(other.id, org.id, 'member');

    // `values`/`excerpts` carry verbatim source text, so per-user connection
    // visibility is the reason this CTE has an EXISTS at all. The org stamp on
    // the event must NOT become a bypass for it.
    const priv = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test-connector',
      created_by: owner.id,
      visibility: 'private',
    });
    const event = await createTestEvent({
      organization_id: org.id,
      connection_id: Number(priv.id),
      content: 'private connection content',
    });
    const classifierId = await seedClassifier(org.id, owner.id, 'sentiment');
    await classify(Number(event.id), classifierId, 'positive');

    expect(await readClassificationCount(ctxFor(org.id, owner.id))).toBe(1);
    expect(await readClassificationCount(ctxFor(org.id, other.id))).toBe(0);
  });

  it('hides classifications on a superseded event', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Supersede Org' });
    const user = await createTestUser({ email: 'supersede@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
    const sql = getTestDb();

    const superseded = await createTestEvent({ organization_id: org.id, content: 'v1' });
    const replacement = await createTestEvent({ organization_id: org.id, content: 'v2' });
    // Both directions, as production writes them.
    await sql`UPDATE events SET supersedes_event_id = ${superseded.id} WHERE id = ${replacement.id}`;
    await sql`UPDATE events SET superseded_by = ${replacement.id} WHERE id = ${superseded.id}`;

    const classifierId = await seedClassifier(org.id, user.id, 'sentiment');
    await classify(Number(superseded.id), classifierId, 'positive');

    // current_event_records parity: a tombstoned event's labels stay hidden.
    expect(await readClassificationCount(ctx)).toBe(0);
  });

  it('returns classifications reached only through entity_ids', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Entity Org' });
    const user = await createTestUser({ email: 'entity@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    const entity = await createTestEntity({ organization_id: org.id, name: 'Acme' });
    const event = await createTestEvent({
      entity_id: Number(entity.id),
      organization_id: org.id,
      content: 'linked to an entity',
    });
    const classifierId = await seedClassifier(org.id, user.id, 'sentiment');
    await classify(Number(event.id), classifierId, 'positive');

    expect(await readClassificationCount(ctx)).toBe(1);
  });
});
