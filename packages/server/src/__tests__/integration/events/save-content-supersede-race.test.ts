/**
 * Integration test: save_content (save_memory) supersession robustness.
 *
 * save_content's supersede path is a read-then-insert TOCTOU:
 *   1. SELECT "is this target already superseded?" (non-atomic)
 *   2. insertEvent(..., supersedesEventId) — NO advisory lock (save_content
 *      doesn't pass the onConflictUpdate/connectionId/originId combo that
 *      insert-event.ts locks on).
 *
 * Two concurrent supersedes of the SAME target both pass the read, both
 * INSERT, and the loser hits the partial unique index
 * `idx_events_superseded_by` with a raw Postgres 23505. Because that raw error
 * is NOT a ToolUserError, it was captured to Sentry as noise (sentry.ts) even
 * though no data is lost — the unique index correctly protects the invariant.
 *
 * Pinned contract after the fix:
 *   - Concurrent supersede race: the loser gets a clean ToolUserError (409),
 *     not a raw 23505. Exactly one supersede succeeds.
 *   - A stale supersede target (already superseded, or not found in the org)
 *     throws ToolUserError — a user fault, not an infra error — so it doesn't
 *     fire a Sentry alert.
 *
 * Vitest CI gap note (mirrors neighbors): runs locally / in the CI integration
 * job against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { saveContent } from '../../../tools/save_content';
import type { ToolContext } from '../../../tools/registry';
import { ToolUserError } from '../../../utils/errors';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > supersession robustness', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Supersede Race Org' });
    user = await createTestUser({ email: 'supersede-race@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
    } as ToolContext;
  });

  it('the loser of a concurrent-supersede race gets a clean ToolUserError, not a raw 23505', async () => {
    // Seed one target event to supersede.
    const target = await createTestEvent({
      organization_id: org.id,
      title: 'Old fact',
      content: 'the original value',
      semantic_type: 'content',
    });

    // 6 concurrent supersedes of the SAME target. The non-atomic "already
    // superseded?" read lets several through; the partial unique index lets
    // exactly one win — the rest must surface as ToolUserError(409), NOT a raw
    // Postgres 23505 (which would be Sentry noise).
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        saveContent(
          {
            content: `replacement ${i}`,
            title: 'New fact',
            semantic_type: 'content',
            supersedes_event_id: target.id,
            metadata: {},
          } as never,
          {} as never,
          ctx
        )
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult[];

    // Exactly one winner.
    expect(fulfilled).toHaveLength(1);
    expect(rejected.length).toBeGreaterThan(0);

    // Every loser is a ToolUserError (409), never a raw 23505 / generic Error.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ToolUserError);
      expect((r.reason as ToolUserError).httpStatus).toBe(409);
      expect((r.reason as ToolUserError).message).toMatch(/already superseded/i);
      // A raw postgres error would carry code 23505; the clean error must not.
      expect((r.reason as { code?: string }).code).toBeUndefined();
    }

    // DB invariant intact: exactly one row supersedes the target.
    const sql = getTestDb();
    const superseders = await sql`
      SELECT id FROM events WHERE supersedes_event_id = ${target.id}
    `;
    expect(superseders).toHaveLength(1);
  });

  it('superseding an already-superseded target throws ToolUserError (stale target, not infra error)', async () => {
    const target = await createTestEvent({
      organization_id: org.id,
      title: 'Target',
      content: 'v1',
      semantic_type: 'content',
    });

    // First supersede wins.
    await saveContent(
      {
        content: 'v2',
        title: 'Target',
        semantic_type: 'content',
        supersedes_event_id: target.id,
        metadata: {},
      } as never,
      {} as never,
      ctx
    );

    // Second supersede of the SAME (now stale) target: the pre-insert read
    // catches it and throws ToolUserError (409), not a plain Error.
    const err = await saveContent(
      {
        content: 'v3',
        title: 'Target',
        semantic_type: 'content',
        supersedes_event_id: target.id,
        metadata: {},
      } as never,
      {} as never,
      ctx
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ToolUserError);
    expect((err as ToolUserError).httpStatus).toBe(409);
    expect((err as ToolUserError).message).toMatch(/already superseded/i);
  });

  it('superseding a non-existent target throws ToolUserError (404), not a plain Error', async () => {
    const err = await saveContent(
      {
        content: 'orphan',
        title: 'Orphan',
        semantic_type: 'content',
        supersedes_event_id: 999_999_999,
        metadata: {},
      } as never,
      {} as never,
      ctx
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ToolUserError);
    expect((err as ToolUserError).httpStatus).toBe(404);
    expect((err as ToolUserError).message).toMatch(/not found/i);
  });

  it('replays a superseding save after its successful response was lost', async () => {
    const target = await createTestEvent({
      organization_id: org.id,
      content: 'synthetic fact v1',
      semantic_type: 'content',
    });
    const args = {
      content: 'synthetic fact v2',
      semantic_type: 'content',
      metadata: {},
      supersedes_event_id: target.id,
      idempotency_key: 'synthetic-supersede-lost-response',
    };
    const committed = await saveContent(args as never, {} as never, ctx);
    const replayed = await saveContent(args as never, {} as never, ctx);
    expect(replayed.id).toBe(committed.id);
    const sql = getTestDb();
    const successors = await sql`
      SELECT id FROM events WHERE supersedes_event_id = ${target.id}
    `;
    expect(successors).toHaveLength(1);
  });
});
