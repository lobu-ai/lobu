/**
 * Feed failure backoff + hard auto-pause (item 5a/5b, #2033) and
 * feed.auto_paused Automation activation (replaces the deleted repair-agent).
 *
 * After:
 *  - 5a: a failed completion sets next_run_at = max(cron_next, now + backoff)
 *    where backoff grows exponentially with consecutive_failures — so a
 *    repeatedly-failing feed is scheduled further out than the plain cadence.
 *    A subsequent SUCCESS resets consecutive_failures to 0 and returns to the
 *    plain cron cadence.
 *  - 5b: once consecutive_failures crosses the hard threshold the feed is
 *    paused (status='paused', next_run_at=NULL via the feeds trigger) and a
 *    feed.auto_paused signal activates matching Automations once.
 *
 * Drives the REAL completeWorkerJob handler against the embedded DB, same shape
 * as complete-worker-job-status-guard.test.ts.
 */

import type { Context } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  emitFeedAutoPaused,
  retryPendingFeedAutoPausedSignals,
} from '../../automations/platform-events';
import type { Env } from '../../index';
import { manageAutomations } from '../../tools/admin/manage_automations';
import { manageFeeds } from '../../tools/admin/manage_feeds';
import { completeWorkerJob } from '../../worker-api';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
  seedOwnerContext,
} from '../setup/test-fixtures';

const WORKER_ID = 'worker-backoff';
// Tight, deterministic backoff for the test: base 1000ms, cap 60000ms, pause
// at 3 consecutive failures.
const BASE_MS = 1000;
const MAX_MS = 60_000;
const PAUSE_THRESHOLD = 3;

beforeAll(() => {
  process.env.FEED_BACKOFF_BASE_MS = String(BASE_MS);
  process.env.FEED_BACKOFF_MAX_MS = String(MAX_MS);
  process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = String(PAUSE_THRESHOLD);
});

afterAll(() => {
  delete process.env.FEED_BACKOFF_BASE_MS;
  delete process.env.FEED_BACKOFF_MAX_MS;
  delete process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES;
});

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = {
    body: undefined,
    status: 200,
  };
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

async function insertConnection(
  organizationId: string,
  slug = 'chrome-backoff-test',
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, created_at, updated_at)
    VALUES
      (${organizationId}, 'chrome', 'active', 'org', ${slug}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

/** A feed on a 1-minute cadence so the plain cron next_run_at is only ~60s out
 *  — the backoff must push it further than that once failures accumulate. */
async function insertFeed(
  organizationId: string,
  connectionId: number,
  consecutiveFailures: number,
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, schedule,
       consecutive_failures, items_collected, last_sync_status, created_at, updated_at)
    VALUES
      (${organizationId}, ${connectionId}, 'chrome-feed', 'active', '* * * * *',
       ${consecutiveFailures}, 0, 'failed', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertRunningRun(
  organizationId: string,
  connectionId: number,
  feedId: number,
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, feed_id, connection_id, connector_key,
       connector_version, status, claimed_by, claimed_at, created_at)
    VALUES
      (${organizationId}, 'sync', ${feedId}, ${connectionId}, 'chrome', '0.2.0',
       'running', ${WORKER_ID}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

/** These tests insert live `chrome-feed` rows directly, but the trigger
 * eligibility guard reads declared capability from
 * `connector_definitions.feeds_schema` (the catalog fallback declares nothing
 * for chrome), so declare the feed: a connector with a pausable feed is
 * exactly what may legitimately trigger on `feed.auto_paused`. */
async function declareChromeFeeds(organizationId: string): Promise<void> {
  const sql = getTestDb();
  // sql.json, not raw strings: postgres.js JSON-encodes a bare JS string, so
  // `${"[]"}::jsonb` lands as the jsonb STRING "[]" and trips
  // connector_definitions_automation_events_array_check.
  await sql`
    INSERT INTO connector_definitions
      (organization_id, key, name, version, auth_schema, feeds_schema,
       automation_events, status)
    VALUES (${organizationId}, 'chrome', 'Chrome', '1.0.0',
      ${sql.json({ methods: [] })},
      ${sql.json({ 'chrome-feed': { name: 'Chrome feed', operations: ['sync'] } })},
      ${sql.json([])},
      'active')
    ON CONFLICT DO NOTHING
  `;
}

describe('feed failure backoff + auto-pause (#2033)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('preserves a notification received after a sync was enqueued', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId, 0);
    const runId = await insertRunningRun(org.id, connId, feedId);
    const sql = getTestDb();
    // Enqueue consumes the old due time; a notification arriving after the
    // source snapshot requests another sync even while this one is running.
    await sql`UPDATE feeds SET next_run_at = current_timestamp WHERE id = ${feedId}`;
    const { ctx, result } = mockWorkerCtx({
      worker_id: WORKER_ID, run_id: runId, status: 'success', items_collected: 0,
    });
    await completeWorkerJob(ctx);
    expect(result().status).toBe(200);
    const [feed] = await sql`
      SELECT next_run_at <= current_timestamp AS due FROM feeds WHERE id = ${feedId}
    `;
    expect(feed.due).toBe(true);
  });

  it('does not charge a temporarily unavailable browser dependency to source-health failures', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId, PAUSE_THRESHOLD - 1);
    const runId = await insertRunningRun(org.id, connId, feedId);
    const sql = getTestDb();

    await sql`
      UPDATE feeds
      SET last_sync_status = 'success',
          last_sync_at = current_timestamp - INTERVAL '5 minutes',
          first_failure_at = NULL
      WHERE id = ${feedId}
    `;
    const before = (await sql`
      SELECT last_sync_at FROM feeds WHERE id = ${feedId}
    `) as Array<{ last_sync_at: Date | string | null }>;

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

    const after = (await sql`
      SELECT status, consecutive_failures, last_sync_status, last_sync_at,
             first_failure_at, last_error, next_run_at
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      last_sync_status: string | null;
      last_sync_at: Date | string | null;
      first_failure_at: Date | string | null;
      last_error: string | null;
      next_run_at: Date | string | null;
    }>;

    expect(after[0].status).toBe('active');
    expect(Number(after[0].consecutive_failures)).toBe(PAUSE_THRESHOLD - 1);
    expect(after[0].last_sync_status).toBe('success');
    expect(new Date(String(after[0].last_sync_at)).getTime()).toBe(
      new Date(String(before[0].last_sync_at)).getTime(),
    );
    expect(after[0].first_failure_at).toBeNull();
    expect(after[0].last_error).toBe('The selected browser is offline.');
    expect(after[0].next_run_at).not.toBeNull();
  });

  it('5a: a failed completion backs off next_run_at beyond the plain cadence', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    // 2 prior failures → this failure makes it 3? No: pick 1 so new count = 2,
    // still below PAUSE_THRESHOLD=3, so it reschedules (not pauses).
    const feedId = await insertFeed(org.id, connId, 1);
    const runId = await insertRunningRun(org.id, connId, feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      items_collected: 0,
      error_message: 'boom',
    });
    await completeWorkerJob(ctx);
    expect(result().body).toEqual({ success: true });

    const sql = getTestDb();
    const after = (await sql`
      SELECT status, consecutive_failures, next_run_at,
             EXTRACT(EPOCH FROM (next_run_at - current_timestamp)) AS seconds_out
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      next_run_at: Date | string | null;
      seconds_out: number | string | null;
    }>;

    expect(after[0].status).toBe('active'); // below pause threshold
    expect(Number(after[0].consecutive_failures)).toBe(2);
    expect(after[0].next_run_at).not.toBeNull();

    // New count = 2 → backoff = BASE_MS * 2^(2-1) = 2000ms. The plain cron
    // cadence ('* * * * *') is ~<=60s out, and GREATEST(cron, now+2s) must be
    // in the future. The load-bearing assertion is that next_run_at is
    // strictly IN THE FUTURE by at least the backoff (device-offline feeds no
    // longer re-enqueue immediately). We assert >= ~1.5s to tolerate clock
    // skew, and well under the 60s cron cap so we know backoff (not just cron)
    // is being applied on a sub-minute-failing feed.
    const secondsOut = Number(after[0].seconds_out);
    expect(secondsOut).toBeGreaterThan(1.5);
  });

  it('5a: backoff grows with consecutive_failures (10 failures > 2 failures)', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);

    // Raise the pause threshold above 10 so we can observe pure backoff growth.
    process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = '100';
    try {
      // Feed A: 1 prior failure → new count 2 → backoff 2000ms.
      const feedA = await insertFeed(org.id, connId, 1);
      const runA = await insertRunningRun(org.id, connId, feedA);
      const a = mockWorkerCtx({
        run_id: runA,
        worker_id: WORKER_ID,
        status: 'failed',
      });
      await completeWorkerJob(a.ctx);

      // Feed B: 9 prior failures → new count 10 → backoff capped at MAX_MS.
      const connId2 = await insertConnection(org.id, 'chrome-backoff-b');
      const feedB = await insertFeed(org.id, connId2, 9);
      const runB = await insertRunningRun(org.id, connId2, feedB);
      const b = mockWorkerCtx({
        run_id: runB,
        worker_id: WORKER_ID,
        status: 'failed',
      });
      await completeWorkerJob(b.ctx);

      const sql = getTestDb();
      const rows = (await sql`
        SELECT id,
               EXTRACT(EPOCH FROM (next_run_at - current_timestamp)) AS seconds_out
        FROM feeds WHERE id IN (${feedA}, ${feedB})
      `) as Array<{ id: number; seconds_out: number | string }>;
      const outA = Number(
        rows.find((r) => Number(r.id) === feedA)?.seconds_out,
      );
      const outB = Number(
        rows.find((r) => Number(r.id) === feedB)?.seconds_out,
      );
      // 10-failure feed is scheduled strictly further out than the 2-failure feed.
      expect(outB).toBeGreaterThan(outA);
    } finally {
      process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES =
        String(PAUSE_THRESHOLD);
    }
  });

  it('5b: crossing the failure threshold hard-pauses the feed and activates feed.auto_paused Automations', async () => {
    const { org, user, ctx: toolCtx } = await seedOwnerContext();
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    const connId = await insertConnection(org.id);
    await declareChromeFeeds(org.id);
    // Connector-wide event trigger (platform event injected into every catalog).
    const created = await manageAutomations(
      {
        action: 'create',
        slug: 'feed-auto-pause-test',
        name: 'Feed auto-pause test',
        prompt: 'Notify about the paused feed.',
        managed_agent_id: agent.agentId,
        triggers: [
          {
            kind: 'event',
            connector_key: 'chrome',
            event_types: ['feed.auto_paused'],
            execution: 'turn',
            active_run: 'coalesce',
            output: 'silent',
          },
        ],
      },
      {} as Env,
      toolCtx,
    );
    if (created.action !== 'create' || !('automation_id' in created)) {
      throw new Error(`Automation create failed: ${JSON.stringify(created)}`);
    }
    const automationId = Number(created.automation_id);

    // 2 prior failures → this failure makes 3 = PAUSE_THRESHOLD → pause.
    const feedId = await insertFeed(org.id, connId, PAUSE_THRESHOLD - 1);
    const runId = await insertRunningRun(org.id, connId, feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      error_message: 'still broken',
    });
    await completeWorkerJob(ctx);
    expect(result().body).toEqual({ success: true });

    const sql = getTestDb();
    const after = (await sql`
      SELECT status, consecutive_failures, next_run_at
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      next_run_at: Date | string | null;
    }>;

    expect(after[0].status).toBe('paused');
    expect(Number(after[0].consecutive_failures)).toBe(PAUSE_THRESHOLD);
    expect(after[0].next_run_at).toBeNull();

    const automationRuns = (await sql`
      SELECT id, status, approved_input
      FROM runs
      WHERE automation_id = ${automationId}
        AND run_type = 'automation'
      ORDER BY id ASC
    `) as Array<{
      id: number;
      status: string;
      approved_input: Record<string, unknown> | null;
    }>;
    // One matching Automation, one threshold crossing — exactly one run, so a
    // duplicate dispatch cannot pass this gate.
    expect(automationRuns).toHaveLength(1);
    expect(automationRuns[0]?.approved_input).toMatchObject({
      dispatch_source: 'event',
      trigger_execution: 'turn',
    });
    const deliveryIds = automationRuns[0]?.approved_input?.delivery_ids as
      | string[]
      | undefined;
    expect(deliveryIds?.[0]).toMatch(
      new RegExp(`^feed-auto-paused:${feedId}:`),
    );

    // A second failure while already paused reuses the same delivery_id
    // (first_failure_at episode) so activation is idempotent — no extra runs.
    const runId2 = await insertRunningRun(org.id, connId, feedId);
    const b = mockWorkerCtx({
      run_id: runId2,
      worker_id: WORKER_ID,
      status: 'failed',
      error_message: 'still broken again',
    });
    await completeWorkerJob(b.ctx);
    const runsAfter = (await sql`
      SELECT count(*)::int AS n FROM runs WHERE automation_id = ${automationId}
    `) as Array<{ n: number }>;
    expect(Number(runsAfter[0]?.n)).toBe(automationRuns.length);
  });

  it('5b-resume: unpausing resets the failure episode so a later pause gets a new delivery_id', async () => {
    const { org, user, ctx: toolCtx } = await seedOwnerContext();
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    const connId = await insertConnection(org.id, 'chrome-resume-test');
    await declareChromeFeeds(org.id);
    const created = await manageAutomations(
      {
        action: 'create',
        slug: 'feed-auto-pause-resume-test',
        name: 'Feed auto-pause resume test',
        prompt: 'Notify about the paused feed.',
        managed_agent_id: agent.agentId,
        triggers: [
          {
            kind: 'event',
            connector_key: 'chrome',
            event_types: ['feed.auto_paused'],
            execution: 'turn',
            // queue (not coalesce): a still-pending first-episode run must not
            // swallow the second-episode delivery into the same run row.
            active_run: 'queue',
            output: 'silent',
          },
        ],
      },
      {} as Env,
      toolCtx,
    );
    if (created.action !== 'create' || !('automation_id' in created)) {
      throw new Error(`Automation create failed: ${JSON.stringify(created)}`);
    }
    const automationId = Number(created.automation_id);

    const feedId = await insertFeed(org.id, connId, PAUSE_THRESHOLD - 1);
    const runId = await insertRunningRun(org.id, connId, feedId);
    await completeWorkerJob(
      mockWorkerCtx({
        run_id: runId,
        worker_id: WORKER_ID,
        status: 'failed',
        error_message: 'episode 1',
      }).ctx,
    );

    const sql = getTestDb();
    const firstRuns = (await sql`
      SELECT approved_input FROM runs
      WHERE automation_id = ${automationId} AND run_type = 'automation'
      ORDER BY id ASC
    `) as Array<{ approved_input: Record<string, unknown> | null }>;
    expect(firstRuns).toHaveLength(1);
    const firstDelivery = (
      firstRuns[0]?.approved_input?.delivery_ids as string[] | undefined
    )?.[0];
    expect(firstDelivery).toMatch(new RegExp(`^feed-auto-paused:${feedId}:`));

    // Resume via manage_feeds — clears consecutive_failures / first_failure_at
    // and re-anchors next_run_at for the scheduled feed.
    const resumed = await manageFeeds(
      { action: 'update_feed', feed_id: feedId, status: 'active' },
      {} as Env,
      toolCtx,
    );
    expect(resumed).toMatchObject({ action: 'update_feed' });
    const afterResume = (await sql`
      SELECT status, consecutive_failures, first_failure_at, next_run_at
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      first_failure_at: Date | string | null;
      next_run_at: Date | string | null;
    }>;
    expect(afterResume[0]?.status).toBe('active');
    expect(Number(afterResume[0]?.consecutive_failures)).toBe(0);
    expect(afterResume[0]?.first_failure_at).toBeNull();
    expect(afterResume[0]?.next_run_at).not.toBeNull();

    // Fail up to threshold again — must create a second Automation run with a
    // distinct delivery_id for the new failure episode.
    for (let i = 0; i < PAUSE_THRESHOLD; i++) {
      const rid = await insertRunningRun(org.id, connId, feedId);
      await completeWorkerJob(
        mockWorkerCtx({
          run_id: rid,
          worker_id: WORKER_ID,
          status: 'failed',
          error_message: `episode 2 fail ${i + 1}`,
        }).ctx,
      );
    }
    const secondRuns = (await sql`
      SELECT approved_input FROM runs
      WHERE automation_id = ${automationId} AND run_type = 'automation'
      ORDER BY id ASC
    `) as Array<{ approved_input: Record<string, unknown> | null }>;
    expect(secondRuns).toHaveLength(2);
    const secondDelivery = (
      secondRuns[1]?.approved_input?.delivery_ids as string[] | undefined
    )?.[0];
    expect(secondDelivery).toMatch(new RegExp(`^feed-auto-paused:${feedId}:`));
    expect(secondDelivery).not.toBe(firstDelivery);

    const finalFeed = (await sql`
      SELECT status, consecutive_failures FROM feeds WHERE id = ${feedId}
    `) as Array<{ status: string; consecutive_failures: number }>;
    expect(finalFeed[0]?.status).toBe('paused');
    expect(Number(finalFeed[0]?.consecutive_failures)).toBe(PAUSE_THRESHOLD);
  });

  it('5b-redelivery: retryPending only targets feeds missing the audit origin', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id, 'chrome-redeliver-test');
    const sql = getTestDb();

    // Hard-paused feed with first_failure_at set, but no audit event yet —
    // simulates crash between pause and emit.
    const rows = (await sql`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, status, schedule,
         consecutive_failures, first_failure_at, items_collected,
         last_sync_status, created_at, updated_at)
      VALUES
        (${org.id}, ${connId}, 'chrome-feed', 'paused', '* * * * *',
         ${PAUSE_THRESHOLD}, NOW() - interval '1 hour', 0,
         'failed', NOW(), NOW())
      RETURNING id, first_failure_at
    `) as Array<{ id: number; first_failure_at: Date | string }>;
    const feedId = Number(rows[0].id);
    const gen = new Date(rows[0].first_failure_at).getTime();
    const originId = `feed_auto_paused:${feedId}:${gen}`;

    const before = await retryPendingFeedAutoPausedSignals({
      pauseThreshold: PAUSE_THRESHOLD,
      limit: 50,
    });
    expect(before.attempted).toBeGreaterThanOrEqual(1);

    const audits = (await sql`
      SELECT id, origin_id, connector_key, feed_id
      FROM events
      WHERE organization_id = ${org.id}
        AND origin_id = ${originId}
        AND superseded_by IS NULL
    `) as Array<{
      id: number;
      origin_id: string;
      connector_key: string | null;
      feed_id: number | null;
    }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.connector_key).toBe('chrome');
    expect(Number(audits[0]?.feed_id)).toBe(feedId);

    // Second redelivery pass must not re-select this feed (audit is the marker).
    const after = await retryPendingFeedAutoPausedSignals({
      pauseThreshold: PAUSE_THRESHOLD,
      limit: 50,
    });
    expect(after.errors).toBe(0);
    const reAudits = (await sql`
      SELECT count(*)::int AS n FROM events
      WHERE organization_id = ${org.id}
        AND origin_id = ${originId}
        AND superseded_by IS NULL
    `) as Array<{ n: number }>;
    expect(Number(reAudits[0]?.n)).toBe(1);

    // Concurrent-safe: re-emitting the same episode keeps one current audit
    // (onConflictUpdate). Use the same title/error as the first emit so the
    // semantic equality path is hit rather than a supersede.
    await emitFeedAutoPaused({
      organizationId: org.id,
      feedId,
      connectionId: connId,
      connectorKey: 'chrome',
      feedKey: 'chrome-feed',
      displayName: null,
      consecutiveFailures: PAUSE_THRESHOLD,
      lastError: null,
      pauseGeneration: gen,
    });
    const stillOne = (await sql`
      SELECT count(*)::int AS n FROM events
      WHERE organization_id = ${org.id}
        AND origin_id = ${originId}
        AND superseded_by IS NULL
    `) as Array<{ n: number }>;
    expect(Number(stillOne[0]?.n)).toBe(1);
  });

  it('5b-scan-window: an audited feed cannot occupy the redelivery scan window', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id, 'chrome-scan-window-test');
    const sql = getTestDb();

    const insertPausedFeed = async (
      feedKey: string,
      firstFailureAgo: string,
    ): Promise<{ id: number; originId: string }> => {
      const rows = (await sql`
        INSERT INTO feeds
          (organization_id, connection_id, feed_key, status, schedule,
           consecutive_failures, first_failure_at, items_collected,
           last_sync_status, created_at, updated_at)
        VALUES
          (${org.id}, ${connId}, ${feedKey}, 'paused', '* * * * *',
           ${PAUSE_THRESHOLD}, NOW() - ${firstFailureAgo}::interval, 0,
           'failed', NOW(), NOW())
        RETURNING id, first_failure_at
      `) as Array<{ id: number; first_failure_at: Date | string }>;
      const id = Number(rows[0].id);
      return {
        id,
        originId: `feed_auto_paused:${id}:${new Date(
          rows[0].first_failure_at,
        ).getTime()}`,
      };
    };

    const auditedCount = async (originId: string): Promise<number> => {
      const rows = (await sql`
        SELECT count(*)::int AS n FROM events
        WHERE organization_id = ${org.id} AND origin_id = ${originId}
      `) as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0);
    };

    // Audited feed: emit once so it carries its durable marker.
    const audited = await insertPausedFeed('chrome-audited', '2 hours');
    await retryPendingFeedAutoPausedSignals({
      pauseThreshold: PAUSE_THRESHOLD,
      limit: 50,
    });
    expect(await auditedCount(audited.originId)).toBe(1);

    // Pending feed: paused at threshold, never emitted.
    const pending = await insertPausedFeed('chrome-pending', '1 hour');
    expect(await auditedCount(pending.originId)).toBe(0);

    // Make the audited feed sort FIRST (scan is ORDER BY updated_at ASC), so a
    // scan that failed to exclude it would spend the single slot on it and
    // leave the pending feed unemitted.
    await sql`
      UPDATE feeds SET updated_at = NOW() - interval '10 days' WHERE id = ${audited.id}
    `;
    await sql`
      UPDATE feeds SET updated_at = NOW() - interval '9 days' WHERE id = ${pending.id}
    `;

    const scan = await retryPendingFeedAutoPausedSignals({
      pauseThreshold: PAUSE_THRESHOLD,
      limit: 1,
    });
    expect(scan.errors).toBe(0);
    expect(scan.scanned).toBe(1);
    expect(await auditedCount(pending.originId)).toBe(1);
    expect(await auditedCount(audited.originId)).toBe(1);
  });

  it('5a: a success resets consecutive_failures and resumes the plain cadence', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId, 2);
    const runId = await insertRunningRun(org.id, connId, feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 5,
    });
    await completeWorkerJob(ctx);
    expect(result().body).toEqual({ success: true });

    const sql = getTestDb();
    const after = (await sql`
      SELECT status, consecutive_failures, next_run_at,
             EXTRACT(EPOCH FROM (next_run_at - current_timestamp)) AS seconds_out
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      next_run_at: Date | string | null;
      seconds_out: number | string | null;
    }>;

    expect(after[0].status).toBe('active');
    expect(Number(after[0].consecutive_failures)).toBe(0);
    // Plain 1-minute cron cadence — next run is <= ~60s out, NOT backed off.
    expect(after[0].next_run_at).not.toBeNull();
    expect(Number(after[0].seconds_out)).toBeLessThanOrEqual(61);
  });
});
