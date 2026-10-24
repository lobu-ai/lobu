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
 *   - Concurrent supersedes without a shared idempotency key: the loser gets
 *     a clean ToolUserError (409), not a raw 23505. Exactly one succeeds.
 *   - Identical keyed supersedes return the same durable event, including
 *     when a concurrent commit lands between the preflight reads.
 *   - An already-superseded target throws ToolUserError unless the key
 *     identifies its own replacement. Missing or wrong-org targets fail.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as dbClient from '../../../db/client';
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

  it.each([
    ['successor', true],
    ['successor', false],
    ['receipt', true],
    ['receipt', false],
  ] as const)(
    'reconciles a commit after the %s read (matching key: %s)',
    async (read, matchingKey) => {
      const target = await createTestEvent({
        organization_id: org.id,
        content: 'before',
        semantic_type: 'content',
      });
      const args = {
        content: 'after',
        semantic_type: 'content',
        metadata: {},
        supersedes_event_id: target.id,
        idempotency_key: `synthetic-read-race-${read}-${matchingKey}`,
      };
      let committedId: number | undefined;
      let injected = false;
      const sql = dbClient.getDb();
      const racingSql = new Proxy(sql, {
        apply(query, thisArg, parameters) {
          const result = Reflect.apply(query, thisArg, parameters);
          const text = Array.isArray(parameters[0])
            ? parameters[0].join(' ').replace(/\s+/g, ' ').trim()
            : '';
          const matchesRead = read === 'receipt'
            ? text.includes("metadata->>'_lobu_idempotency_key'")
            : text.startsWith('SELECT id FROM events WHERE supersedes_event_id');
          if (!injected && matchesRead) {
            injected = true;
            return Promise.resolve(result).then(async (rows) => {
              const committed = await saveContent({
                ...args,
                idempotency_key: matchingKey ? args.idempotency_key : `${args.idempotency_key}-other`,
              } as never, {} as never, ctx);
              committedId = committed.id;
              return rows;
            });
          }
          return result;
        },
      });
      const spy = vi.spyOn(dbClient, 'getDb').mockReturnValue(racingSql);
      try {
        const replay = saveContent(args as never, {} as never, ctx);
        if (matchingKey) {
          const result = await replay;
          expect(result.id).toBe(committedId);
          expect(result.created).toBe(false);
        } else {
          await expect(replay).rejects.toMatchObject({ httpStatus: 409 });
        }
        expect(injected).toBe(true);
        const successors = await sql`
          SELECT id FROM events WHERE supersedes_event_id = ${target.id}
        `;
        expect(successors).toHaveLength(1);
        expect(Number(successors[0].id)).toBe(committedId);
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('reconciles concurrent identical keyed supersedes to one committed event', async () => {
    const target = await createTestEvent({
      organization_id: org.id,
      content: 'before',
      semantic_type: 'content',
    });
    const args = {
      content: 'after',
      semantic_type: 'content',
      metadata: {},
      supersedes_event_id: target.id,
      idempotency_key: 'synthetic-concurrent-supersede',
    };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => saveContent(args as never, {} as never, ctx))
    );
    const saved = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(new Set(saved.map((result) => result.id)).size).toBe(1);
    expect(saved.filter((result) => result.created)).toHaveLength(1);
    const rows = await getTestDb()`
      SELECT id FROM events WHERE supersedes_event_id = ${target.id}
    `;
    expect(rows).toHaveLength(1);
  });

  it('rejects reuse of a supersede key for another target or an ordinary save', async () => {
    const target = await createTestEvent({
      organization_id: org.id, content: 'before', semantic_type: 'content',
    });
    const other = await createTestEvent({
      organization_id: org.id, content: 'other', semantic_type: 'content',
    });
    const args = {
      content: 'after',
      semantic_type: 'content',
      metadata: {},
      supersedes_event_id: target.id,
      idempotency_key: 'synthetic-target-conflict',
    };
    const saved = await saveContent(args as never, {} as never, ctx);
    for (const supersedes_event_id of [other.id, undefined]) {
      await expect(
        saveContent({ ...args, supersedes_event_id } as never, {} as never, ctx)
      ).rejects.toMatchObject({ httpStatus: 409 });
    }
    const rows = await getTestDb()`SELECT id FROM events WHERE supersedes_event_id = ${other.id}`;
    expect(rows).toHaveLength(0);
    await expect(
      saveContent({ ...args, semantic_type: 'guidance' } as never, {} as never, ctx)
    ).rejects.toMatchObject({ httpStatus: 409 });
    const replay = await saveContent(args as never, {} as never, ctx);
    expect(replay.id).toBe(saved.id);
  });

  it('rejects using an ordinary save key to supersede a target', async () => {
    const args = {
      content: 'ordinary',
      semantic_type: 'content',
      metadata: {},
      idempotency_key: 'synthetic-ordinary-key',
    };
    await saveContent(args as never, {} as never, ctx);
    const target = await createTestEvent({
      organization_id: org.id, content: 'before', semantic_type: 'content',
    });
    await expect(
      saveContent({ ...args, supersedes_event_id: target.id } as never, {} as never, ctx)
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('rechecks current write scope and guidance removal permission on replay', async () => {
    const target = await saveContent(
      { content: 'instructions', semantic_type: 'guidance', metadata: {} } as never,
      {} as never,
      ctx
    );
    const args = {
      content: 'replacement',
      semantic_type: 'content',
      metadata: {},
      supersedes_event_id: target.id,
      idempotency_key: 'synthetic-authorized-replay',
    };
    await saveContent(args as never, {} as never, ctx);
    await expect(
      saveContent(args as never, {} as never, { ...ctx, scopes: ['mcp:read'] })
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(
      saveContent(args as never, {} as never, { ...ctx, memberRole: 'member' })
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('returns the original receipt even when its replacement was later superseded', async () => {
    const target = await createTestEvent({
      organization_id: org.id, content: 'v1', semantic_type: 'content',
    });
    const args = {
      content: 'v2',
      semantic_type: 'content',
      metadata: {},
      supersedes_event_id: target.id,
      idempotency_key: 'synthetic-later-version',
    };
    const original = await saveContent(args as never, {} as never, ctx);
    await saveContent({
      content: 'v3',
      semantic_type: 'content',
      metadata: {},
      supersedes_event_id: original.id,
    } as never, {} as never, ctx);
    const replay = await saveContent(args as never, {} as never, ctx);
    expect(replay.id).toBe(original.id);
    expect(replay.created).toBe(false);
  });
});
