/**
 * Auth-driven feed re-arm reproducer.
 *
 * #3694 made a failure pause sticky against device reconcile: a feed the
 * failure policy paused (`consecutive_failures >= feedBackoff.pauseThreshold`)
 * resumes only through an explicit, counter-resetting resume. Other
 * writers still re-armed feeds:
 *
 *  1. A successful sync that reports `auth_update` for a `browser_session`
 *     profile (cookie rotation, which happens on routine syncs) set EVERY feed
 *     on the profile to `status='active'` and stamped `next_run_at` on feeds
 *     with no schedule. It undid failure pauses and manual pauses of sibling
 *     feeds, and gave unscheduled feeds a run after every sibling sync.
 *  2. Auth-run completion (`reactivateProfileCascade`) resumed paused feeds
 *     on connections that were not re-authenticated (manually paused or
 *     deleted) and stamped a run on feeds with no cron. #3700 separately
 *     keeps failure-paused feeds paused there.
 *  3. `manage_auth_profiles` update of a usable browser_session profile and
 *     any `manage_connections` update of its connection (even a rename)
 *     re-applied the same "set every feed active" cascade.
 *
 * Found by model-checking the feed pause/resume writers (every `UPDATE feeds`
 * that can set `status='active'`) against "a failure pause only ends through
 * an explicit resume".
 */

import type { Context } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { feedBackoff } from '../../connectors/feed-backoff';
import { applyFeedSyncFailure } from '../../connectors/feed-sync-failure';
import type { DbClient } from '../../db/client';
import type { Env } from '../../index';
import { manageAuthProfiles } from '../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../tools/admin/manage_connections';
import { completeAuthRun, completeWorkerJob } from '../../worker-api';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, seedOwnerContext } from '../setup/test-fixtures';

const WORKER_ID = 'worker-auth-rearm';
const USABLE_SESSION = {
  cookies: [{ name: 'session_token', value: 'synthetic', expires: 4_102_444_800 }],
};

function ctxFor(body: unknown): Context<{ Bindings: Env }> {
  return {
    req: { json: async () => body },
    var: {},
    json: (b: unknown, status?: number) =>
      ({ body: b, status: status ?? 200 }) as unknown as Response,
  } as unknown as Context<{ Bindings: Env }>;
}

type FeedRow = {
  status: string;
  next_run_at: Date | null;
  consecutive_failures: number;
  first_failure_at: Date | null;
};

async function readFeed(feedId: number): Promise<FeedRow> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status, next_run_at, consecutive_failures, first_failure_at
    FROM feeds WHERE id = ${feedId}
  `) as FeedRow[];
  return { ...row, consecutive_failures: Number(row.consecutive_failures) };
}

async function readConnectionStatus(connectionId: number): Promise<string> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status FROM connections WHERE id = ${connectionId}
  `) as Array<{ status: string }>;
  return row.status;
}

async function waitForConnectionAudits(
  organizationId: string,
  connectionId: number,
  minCount: number
): Promise<void> {
  const sql = getTestDb();
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await sql`
      SELECT id FROM events
      WHERE organization_id = ${organizationId}
        AND metadata->>'category' = 'config'
        AND metadata->>'resource_kind' = 'connection'
        AND metadata->>'resource_id' = ${String(connectionId)}
    `;
    if (rows.length >= minCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${minCount} connection audit event(s)`);
}

async function seedProfile(
  organizationId: string,
  profileKind: 'browser_session' | 'oauth_account',
  status: 'active' | 'pending_auth'
): Promise<{ profileId: number; connectionId: number }> {
  const sql = getTestDb();
  const [profile] = (await sql`
    INSERT INTO auth_profiles
      (organization_id, slug, display_name, connector_key, profile_kind,
       status, auth_data, metadata, created_at, updated_at)
    VALUES
      (${organizationId}, 'auth-rearm', 'Auth rearm', 'browser-test', ${profileKind},
       ${status}, ${sql.json(profileKind === 'browser_session' ? USABLE_SESSION : {})},
       '{}'::jsonb, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  const [connection] = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, auth_profile_id,
       created_at, updated_at)
    VALUES
      (${organizationId}, 'browser-test', ${status === 'active' ? 'active' : 'pending_auth'},
       'private', 'auth-rearm', ${profile.id}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return { profileId: profile.id, connectionId: connection.id };
}

async function seedFeed(
  organizationId: string,
  connectionId: number,
  feedKey: string,
  opts: { status?: string; schedule?: string | null } = {}
): Promise<number> {
  const sql = getTestDb();
  const schedule = opts.schedule === undefined ? '*/5 * * * *' : opts.schedule;
  const [row] = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, schedule, next_run_at,
       created_at, updated_at)
    VALUES
      (${organizationId}, ${connectionId}, ${feedKey}, ${opts.status ?? 'active'},
       ${schedule}, ${schedule && (opts.status ?? 'active') === 'active' ? new Date() : null},
       NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return row.id;
}

async function failUntilPaused(feedId: number): Promise<void> {
  const sql = getTestDb();
  for (let i = 0; i < feedBackoff.pauseThreshold; i++) {
    await applyFeedSyncFailure(sql as unknown as DbClient, {
      feedId,
      errorMessage: 'Request failed with status 422',
      runId: 910_001 + i,
    });
  }
  const paused = await readFeed(feedId);
  expect(paused.status).toBe('paused');
  expect(paused.next_run_at).toBeNull();
}

/** A claimed sync run for `feedId` that reports success with a usable browser session. */
async function completeSyncWithAuthUpdate(
  organizationId: string,
  connectionId: number,
  feedId: number,
  beforeComplete?: () => Promise<void>
): Promise<void> {
  const sql = getTestDb();
  const [run] = (await sql`
    INSERT INTO runs
      (organization_id, run_type, feed_id, connection_id, connector_key,
       connector_version, status, claimed_by, claimed_at, created_at)
    VALUES
      (${organizationId}, 'sync', ${feedId}, ${connectionId}, 'browser-test', '1.0.0',
       'running', ${WORKER_ID}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  await beforeComplete?.();
  await completeWorkerJob(
    ctxFor({
      run_id: run.id,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 0,
      auth_update: USABLE_SESSION,
    })
  );
  const [done] = (await sql`SELECT status FROM runs WHERE id = ${run.id}`) as Array<{
    status: string;
  }>;
  expect(done.status).toBe('completed');
}

async function completeFreshAuthRun(organizationId: string, profileId: number): Promise<void> {
  const sql = getTestDb();
  const [run] = (await sql`
    INSERT INTO runs (organization_id, run_type, status, claimed_by, claimed_at,
                      auth_profile_id, created_at)
    VALUES (${organizationId}, 'auth', 'running', ${WORKER_ID}, NOW(), ${profileId}, NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  await completeAuthRun(
    ctxFor({
      run_id: run.id,
      worker_id: WORKER_ID,
      status: 'success',
      credentials: { api_key: 'synthetic' },
      metadata: {},
    })
  );
}

describe('auth-driven feed re-arm', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  describe('browser_session auth_update on a routine sync', () => {
    it('does not resume a failure-paused sibling feed', async () => {
      const org = await createTestOrganization();
      const { connectionId } = await seedProfile(org.id, 'browser_session', 'active');
      const syncing = await seedFeed(org.id, connectionId, 'posts');
      const broken = await seedFeed(org.id, connectionId, 'messages');
      await failUntilPaused(broken);

      await completeSyncWithAuthUpdate(org.id, connectionId, syncing);

      const after = await readFeed(broken);
      expect(after.status).toBe('paused');
      expect(after.next_run_at).toBeNull();
    });

    it('does not resume a manually paused sibling feed', async () => {
      const org = await createTestOrganization();
      const { connectionId } = await seedProfile(org.id, 'browser_session', 'active');
      const syncing = await seedFeed(org.id, connectionId, 'posts');
      const manual = await seedFeed(org.id, connectionId, 'messages', { status: 'paused' });

      await completeSyncWithAuthUpdate(org.id, connectionId, syncing);

      const after = await readFeed(manual);
      expect(after.status).toBe('paused');
      expect(after.next_run_at).toBeNull();
    });

    it('does not resume a connection paused while the sync was in flight', async () => {
      const org = await createTestOrganization();
      const { connectionId } = await seedProfile(org.id, 'browser_session', 'active');
      const syncing = await seedFeed(org.id, connectionId, 'posts');

      await completeSyncWithAuthUpdate(org.id, connectionId, syncing, async () => {
        const sql = getTestDb();
        await sql`UPDATE connections SET status = 'paused' WHERE id = ${connectionId}`;
      });

      expect(await readConnectionStatus(connectionId)).toBe('paused');
    });

    it('does not invent a run for an unscheduled sibling feed', async () => {
      const org = await createTestOrganization();
      const { connectionId } = await seedProfile(org.id, 'browser_session', 'active');
      const syncing = await seedFeed(org.id, connectionId, 'posts');
      const unscheduled = await seedFeed(org.id, connectionId, 'profile', { schedule: null });

      await completeSyncWithAuthUpdate(org.id, connectionId, syncing);

      const after = await readFeed(unscheduled);
      expect(after.status).toBe('active');
      expect(after.next_run_at).toBeNull();
    });

    it('still resumes feeds paused by an expired session once the session is usable again', async () => {
      const org = await createTestOrganization();
      const { connectionId } = await seedProfile(org.id, 'browser_session', 'pending_auth');
      const syncing = await seedFeed(org.id, connectionId, 'posts', { status: 'paused' });
      const sibling = await seedFeed(org.id, connectionId, 'messages', { status: 'paused' });

      await completeSyncWithAuthUpdate(org.id, connectionId, syncing);

      for (const feedId of [syncing, sibling]) {
        const after = await readFeed(feedId);
        expect(after.status).toBe('active');
        expect(after.next_run_at).not.toBeNull();
      }
    });
  });

  describe('edits that leave a usable browser session usable', () => {
    async function seedPausedSiblings(
      organizationId: string
    ): Promise<{ connectionId: number; broken: number; manual: number }> {
      const { connectionId } = await seedProfile(organizationId, 'browser_session', 'active');
      await seedFeed(organizationId, connectionId, 'posts');
      const broken = await seedFeed(organizationId, connectionId, 'messages');
      await failUntilPaused(broken);
      const manual = await seedFeed(organizationId, connectionId, 'profile', { status: 'paused' });
      return { connectionId, broken, manual };
    }

    async function expectStillPaused(feedIds: number[]): Promise<void> {
      for (const feedId of feedIds) {
        const after = await readFeed(feedId);
        expect(after.status).toBe('paused');
        expect(after.next_run_at).toBeNull();
      }
    }

    it('manage_auth_profiles update does not resume paused feeds', async () => {
      const { org, ctx } = await seedOwnerContext();
      const { broken, manual } = await seedPausedSiblings(org.id);

      const result = await manageAuthProfiles(
        { action: 'update_auth_profile', auth_profile_slug: 'auth-rearm', display_name: 'Renamed' },
        {} as Env,
        ctx
      );
      expect('error' in result).toBe(false);

      await expectStillPaused([broken, manual]);
    });

    it('manage_connections rename does not resume paused feeds', async () => {
      const { org, ctx } = await seedOwnerContext();
      const { connectionId, broken, manual } = await seedPausedSiblings(org.id);

      const result = (await manageConnections(
        { action: 'update', connection_id: connectionId, display_name: 'Renamed' },
        {} as Env,
        ctx
      )) as Record<string, unknown>;
      expect(result.error).toBeUndefined();

      await expectStillPaused([broken, manual]);
      await waitForConnectionAudits(org.id, connectionId, 1);
    });

    it('manage_connections rename does not resume a manually paused connection', async () => {
      const { org, ctx } = await seedOwnerContext();
      const { connectionId, broken, manual } = await seedPausedSiblings(org.id);

      const paused = (await manageConnections(
        { action: 'update', connection_id: connectionId, status: 'paused' },
        {} as Env,
        ctx
      )) as Record<string, unknown>;
      expect(paused.error).toBeUndefined();

      const renamed = (await manageConnections(
        { action: 'update', connection_id: connectionId, display_name: 'Renamed' },
        {} as Env,
        ctx
      )) as Record<string, unknown>;
      expect(renamed.error).toBeUndefined();

      expect(await readConnectionStatus(connectionId)).toBe('paused');
      await expectStillPaused([broken, manual]);
      await waitForConnectionAudits(org.id, connectionId, 2);
    });

    it('manage_connections resume preserves a failure-paused feed', async () => {
      const { org, ctx } = await seedOwnerContext();
      const { connectionId, broken, manual } = await seedPausedSiblings(org.id);

      const resumed = (await manageConnections(
        { action: 'update', connection_id: connectionId, status: 'active' },
        {} as Env,
        ctx
      )) as Record<string, unknown>;
      expect(resumed.error).toBeUndefined();

      expect(await readConnectionStatus(connectionId)).toBe('active');
      await expectStillPaused([broken]);
      expect((await readFeed(manual)).status).toBe('active');
      await waitForConnectionAudits(org.id, connectionId, 1);
    });
  });

  describe('auth run completion', () => {
    it('does not invent a run for a paused feed with no schedule', async () => {
      const org = await createTestOrganization();
      const { profileId, connectionId } = await seedProfile(org.id, 'oauth_account', 'active');
      const feedId = await seedFeed(org.id, connectionId, 'default', {
        status: 'paused',
        schedule: null,
      });

      await completeFreshAuthRun(org.id, profileId);

      const after = await readFeed(feedId);
      expect(after.status).toBe('active');
      expect(after.next_run_at).toBeNull();
    });

    it('does not reactivate a deleted feed', async () => {
      const org = await createTestOrganization();
      const { profileId, connectionId } = await seedProfile(org.id, 'oauth_account', 'active');
      const feedId = await seedFeed(org.id, connectionId, 'default', { status: 'paused' });

      const sql = getTestDb();
      await sql`UPDATE feeds SET deleted_at = NOW() WHERE id = ${feedId}`;
      await completeFreshAuthRun(org.id, profileId);

      expect((await readFeed(feedId)).status).toBe('paused');
    });

    it('does not reactivate feeds on a manually paused connection', async () => {
      const org = await createTestOrganization();
      const { profileId, connectionId } = await seedProfile(org.id, 'oauth_account', 'active');
      const feedId = await seedFeed(org.id, connectionId, 'default', { status: 'paused' });

      const sql = getTestDb();
      await sql`UPDATE connections SET status = 'paused' WHERE id = ${connectionId}`;
      await completeFreshAuthRun(org.id, profileId);

      expect(await readConnectionStatus(connectionId)).toBe('paused');
      expect((await readFeed(feedId)).status).toBe('paused');
    });
  });
});
