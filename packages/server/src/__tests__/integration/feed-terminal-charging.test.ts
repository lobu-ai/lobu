/**
 * Every terminal outcome of a CLAIMED sync run lands on its feed.
 *
 * The claim CTE (worker-api/poll.ts) stamps the feed `last_sync_status =
 * 'pending'` and clears `last_error`; from then on the feed reads "a sync is
 * in flight" until something records how that sync ended. The failure budget
 * (connectors/feed-backoff.ts) applies to exactly these claimed runs. These
 * tests drive the real claim, completion and reaper paths and assert the feed
 * never keeps describing a sync that is already over:
 *
 *  - a claimed run the reaper times out is charged to the feed, so a worker
 *    that keeps dying mid-sync backs off and auto-pauses instead of re-queueing
 *    a fresh retry forever;
 *  - the reaper never queues a retry for a feed that is paused or deleted;
 *  - a gateway-side compile failure fails the run and charges the feed in one
 *    transaction;
 *  - a dependency-unavailable completion restores the last real source-health
 *    result instead of leaving the claim's 'pending' stamp.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { reapStaleRuns } from '../../scheduled/check-stalled-executions';
import { completeWorkerJob } from '../../worker-api';
import { pollWorkerJob } from '../../worker-api/poll';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
} from '../setup/test-fixtures';

const WORKER_ID = 'worker-terminal-charging';
const PAUSE_THRESHOLD = 3;

beforeAll(() => {
  process.env.FEED_BACKOFF_BASE_MS = '1000';
  process.env.FEED_BACKOFF_MAX_MS = '60000';
  process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = String(PAUSE_THRESHOLD);
});

afterAll(() => {
  delete process.env.FEED_BACKOFF_BASE_MS;
  delete process.env.FEED_BACKOFF_MAX_MS;
  delete process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES;
});

interface FeedRow {
  status: string;
  deleted_at: Date | string | null;
  last_sync_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

async function readFeed(feedId: number): Promise<FeedRow> {
  const [feed] = (await getTestDb()`
    SELECT status, deleted_at, last_sync_status, last_error, consecutive_failures
    FROM feeds WHERE id = ${feedId}
  `) as unknown as FeedRow[];
  return { ...feed, consecutive_failures: Number(feed.consecutive_failures) };
}

async function activeSyncRuns(feedId: number): Promise<Array<{ id: number; status: string }>> {
  return (await getTestDb()`
    SELECT id, status FROM runs
    WHERE feed_id = ${feedId}
      AND run_type = 'sync'
      AND status IN ('pending', 'claimed', 'running')
    ORDER BY id
  `) as unknown as Array<{ id: number; status: string }>;
}

function pollApp(orgId: string): () => Promise<Record<string, unknown>> {
  const app = new Hono();
  app.post(
    '/api/workers/poll',
    async (c, next) => {
      c.set('workerAuthMode' as never, 'trusted' as never);
      c.set('workerOrgIds' as never, [orgId] as never);
      c.set('organizationId' as never, orgId as never);
      c.set('mcpAuthInfo' as never, { scopes: ['device_worker:run'] } as never);
      await next();
    },
    (c) => pollWorkerJob(c as never)
  );
  return async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/workers/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_id: WORKER_ID, capabilities: {} }),
      }),
      {} as never
    );
    return { __status: response.status, ...((await response.json()) as object) };
  };
}

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (b: unknown, status?: number) => {
      captured = { body: b, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

/** A scheduled feed whose next cron slot is far away, so a poll only ever
 *  claims the run the test queued and never materializes a new one. */
async function seedFeed(options: {
  connectorKey: string;
  lastSyncStatus: string | null;
  consecutiveFailures: number;
}): Promise<{ orgId: string; feedId: number; connectionId: number }> {
  const org = await createTestOrganization();
  await createTestConnectorDefinition({
    key: options.connectorKey,
    name: options.connectorKey,
    feeds_schema: { items: { description: 'Items', operations: ['sync'] } },
    organization_id: org.id,
  });
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: options.connectorKey,
    createDefaultFeed: false,
  } as never);
  const [feed] = (await getTestDb()`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status, schedule, next_run_at,
      last_sync_status, last_sync_at, consecutive_failures, first_failure_at,
      items_collected, created_at, updated_at
    ) VALUES (
      ${org.id}, ${connection.id}, 'items', 'active', '0 0 1 1 *',
      current_timestamp + INTERVAL '1 day',
      ${options.lastSyncStatus},
      ${options.lastSyncStatus === null ? null : new Date(Date.now() - 3_600_000)},
      ${options.consecutiveFailures},
      ${options.consecutiveFailures > 0 ? new Date(Date.now() - 3_600_000) : null},
      0, NOW(), NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return { orgId: org.id, feedId: Number(feed.id), connectionId: connection.id };
}

async function queueSyncRun(
  orgId: string,
  feedId: number,
  connectionId: number,
  connectorKey: string
): Promise<number> {
  const [run] = (await getTestDb()`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id, connector_key,
      connector_version, status, approval_status, created_at
    ) VALUES (
      ${orgId}, 'sync', ${feedId}, ${connectionId}, ${connectorKey},
      '1.0.0', 'pending', 'auto', NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(run.id);
}

/** The worker that claimed `runId` went silent: its heartbeat is past the
 *  reaper's staleness threshold. */
async function loseHeartbeat(runId: number): Promise<void> {
  await getTestDb()`
    UPDATE runs
    SET claimed_at = current_timestamp - INTERVAL '1 hour',
        last_heartbeat_at = current_timestamp - INTERVAL '1 hour'
    WHERE id = ${runId}
  `;
}

describe('terminal outcomes of a claimed sync run are charged to its feed', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('charges a claimed run the reaper times out for a lost heartbeat', async () => {
    const key = 'test.reaper-charge';
    const { orgId, feedId, connectionId } = await seedFeed({
      connectorKey: key,
      lastSyncStatus: 'success',
      consecutiveFailures: 0,
    });
    const runId = await queueSyncRun(orgId, feedId, connectionId, key);
    const claim = await pollApp(orgId)();
    expect(claim.run_id).toBe(runId);
    expect((await readFeed(feedId)).last_sync_status).toBe('pending');

    await loseHeartbeat(runId);
    const reaped = await reapStaleRuns();
    expect(reaped.reaped).toBe(1);

    const [run] = await getTestDb()`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe('timeout');
    expect(await readFeed(feedId)).toMatchObject({
      status: 'active',
      last_sync_status: 'failed',
      last_error: 'worker_heartbeat_lost',
      consecutive_failures: 1,
    });
    // Below the threshold, the claimed run still gets its one fresh retry.
    expect(await activeSyncRuns(feedId)).toMatchObject([{ status: 'pending' }]);
  });

  it('bounds the reaper retry chain by the auto-pause threshold', async () => {
    const key = 'test.reaper-chain';
    const { orgId, feedId, connectionId } = await seedFeed({
      connectorKey: key,
      lastSyncStatus: 'success',
      consecutiveFailures: 0,
    });
    await queueSyncRun(orgId, feedId, connectionId, key);
    const poll = pollApp(orgId);

    // A worker that dies mid-sync every time. Each retry the reaper queues is
    // claimed and lost again; the chain has to end at the pause threshold.
    let claims = 0;
    for (let i = 0; i < PAUSE_THRESHOLD + 3; i += 1) {
      const claim = await poll();
      if (claim.run_id === undefined) break;
      claims += 1;
      await loseHeartbeat(Number(claim.run_id));
      await reapStaleRuns();
    }

    expect(claims).toBe(PAUSE_THRESHOLD);
    expect(await readFeed(feedId)).toMatchObject({
      status: 'paused',
      last_sync_status: 'failed',
      consecutive_failures: PAUSE_THRESHOLD,
    });
    expect(await activeSyncRuns(feedId)).toEqual([]);
  });

  it.each([
    ['paused by an operator', `status = 'paused'`],
    ['deleted', `deleted_at = current_timestamp`],
  ])('queues no reaper retry for a feed %s mid-sync', async (_label, change) => {
    const key = `test.reaper-inactive-${change.startsWith('status') ? 'paused' : 'deleted'}`;
    const { orgId, feedId, connectionId } = await seedFeed({
      connectorKey: key,
      lastSyncStatus: 'success',
      consecutiveFailures: 0,
    });
    const runId = await queueSyncRun(orgId, feedId, connectionId, key);
    expect((await pollApp(orgId)()).run_id).toBe(runId);
    await getTestDb().unsafe(`UPDATE feeds SET ${change} WHERE id = $1`, [feedId]);

    await loseHeartbeat(runId);
    const reaped = await reapStaleRuns();
    expect(reaped.reaped).toBe(1);
    expect(reaped.retriesCreated).toBe(0);
    expect(await activeSyncRuns(feedId)).toEqual([]);
  });

  it('fails a gateway-side compile failure and charges its feed atomically', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const [conn] = (await sql`
      INSERT INTO connections
        (organization_id, connector_key, status, visibility, slug, created_at, updated_at)
      VALUES
        (${org.id}, 'test.uncompilable-atomic', 'active', 'org', 'uncompilable-atomic', NOW(), NOW())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const [feed] = (await sql`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, status, schedule, next_run_at,
         consecutive_failures, items_collected, created_at, updated_at)
      VALUES
        (${org.id}, ${conn.id}, 'pages', 'active', '0 0 1 1 *',
         current_timestamp + INTERVAL '1 day', 0, 0, NOW(), NOW())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const feedId = Number(feed.id);
    const runId = await queueSyncRun(org.id, feedId, conn.id, 'test.uncompilable-atomic');

    // The feed charge fails after the run's terminal write. Committed apart,
    // the run is durably 'failed' while the feed still reads a sync in flight.
    await sql.unsafe(`
      CREATE FUNCTION pg_temp_reject_feed_charge() RETURNS trigger AS $$
      BEGIN
        IF NEW.last_sync_status = 'failed' THEN
          RAISE EXCEPTION 'injected feed charge failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await sql.unsafe(`
      CREATE TRIGGER reject_feed_charge BEFORE UPDATE ON feeds
      FOR EACH ROW WHEN (NEW.id = ${feedId})
      EXECUTE FUNCTION pg_temp_reject_feed_charge()
    `);
    try {
      await pollApp(org.id)().catch(() => undefined);
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS reject_feed_charge ON feeds');
      await sql.unsafe('DROP FUNCTION IF EXISTS pg_temp_reject_feed_charge()');
    }

    const [run] = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string }>;
    const after = await readFeed(feedId);
    // Neither half committed: the run is still the claimed one, left for the
    // reaper, and the feed still reads the claim.
    expect(run.status).toBe('running');
    expect(after.last_sync_status).toBe('pending');
    expect(after.consecutive_failures).toBe(0);
  });

  it.each([
    ['success', 0],
    ['failed', 2],
    [null, 0],
  ] as const)(
    'restores last_sync_status=%s after a dependency-unavailable completion',
    async (lastSyncStatus, consecutiveFailures) => {
      const key = `test.dependency-unavailable-${lastSyncStatus ?? 'never'}`;
      const { orgId, feedId, connectionId } = await seedFeed({
        connectorKey: key,
        lastSyncStatus,
        consecutiveFailures,
      });
      const runId = await queueSyncRun(orgId, feedId, connectionId, key);
      expect((await pollApp(orgId)()).run_id).toBe(runId);
      expect((await readFeed(feedId)).last_sync_status).toBe('pending');

      const { ctx, result } = mockWorkerCtx({
        run_id: runId,
        worker_id: WORKER_ID,
        status: 'failed',
        items_collected: 0,
        error_message:
          '[lobu:dependency_unavailable:browser_offline] The selected browser is offline.',
      });
      await completeWorkerJob(ctx);
      expect(result().body).toEqual({ success: true });

      expect(await readFeed(feedId)).toMatchObject({
        status: 'active',
        last_sync_status: lastSyncStatus,
        last_error: 'The selected browser is offline.',
        consecutive_failures: consecutiveFailures,
      });
    }
  );
});
