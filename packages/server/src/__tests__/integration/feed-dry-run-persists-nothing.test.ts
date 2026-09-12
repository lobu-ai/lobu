/**
 * `runs.dry_run` — the connector executes for real, the server persists nothing.
 *
 * Why this test is shaped as a NEGATIVE assertion.
 *
 * The value of a dry run is entirely in what it does NOT do, and every one of
 * those writes lives in `streamContent`, on a path that already worked. A test
 * that only asserted "the preview came back" would pass just as happily against
 * a build that also wrote every event — which is the one outcome that makes the
 * feature worse than useless, because an operator would be told "nothing was
 * persisted" while their workspace filled up.
 *
 * So the assertions are: after a dry batch, `events` is empty, the feed's
 * `checkpoint` is byte-identical to what it was, and the feed's schedule state
 * (`next_run_at`, `last_sync_status`) has not moved. The positive assertion —
 * the preview exists and counts correctly — is secondary.
 *
 * The control cases are what make the dry ones meaningful: the SAME batch /
 * completion through a NON-dry run must persist, or the tests would pass on a
 * build where streamContent silently dropped everything.
 *
 * Both halves of the run lifecycle are covered, because the writes are split
 * across them: streamContent owns events / entities / attachments / mid-run
 * checkpoints, while completeWorkerJob owns the feed's sync bookkeeping —
 * last_sync_status, consecutive_failures, next_run_at, and the FINAL
 * checkpoint advance. Guarding only the stream half would still let a dry
 * run's completion move the cursor.
 */

import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { completeWorkerJob, streamContent } from '../../worker-api';
import {
  IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY,
} from '../../identity/scope-projection';
import { clearEntityLinkRulesCache } from '../../utils/entity-link-upsert';
import { ensureMemberEntityType } from '../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

const WORKER_ID = 'worker-dry';
const FEED_CHECKPOINT = { cursor: 'original-cursor' };

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

async function seed(dryRun: boolean): Promise<{
  orgId: string;
  feedId: number;
  runId: number;
}> {
  const sql = getTestDb();
  const org = await createTestOrganization();

  const conn = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, created_at, updated_at)
    VALUES
      (${org.id}, 'rss', 'active', 'org', ${`rss-dry-${dryRun}`}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;

  const feed = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, schedule, checkpoint,
       last_sync_status, next_run_at, created_at, updated_at)
    VALUES
      (${org.id}, ${conn[0].id}, 'items', 'active', '0 */6 * * *',
       ${sql.json(FEED_CHECKPOINT)}, 'success', '2099-01-01T00:00:00Z', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;

  const run = (await sql`
    INSERT INTO runs
      (organization_id, run_type, feed_id, connection_id, connector_key,
       connector_version, status, claimed_by, dry_run, created_at)
    VALUES
      (${org.id}, 'sync', ${feed[0].id}, ${conn[0].id}, 'rss', '1.0.0',
       'running', ${WORKER_ID}, ${dryRun}, NOW())
    RETURNING id
  `) as Array<{ id: number }>;

  return { orgId: org.id, feedId: feed[0].id, runId: run[0].id };
}

function batchFor(runId: number) {
  return {
    run_id: runId,
    worker_id: WORKER_ID,
    // A checkpoint IS supplied. That matters: the dry path must decline to
    // advance it even though the connector offered a new one.
    checkpoint: { cursor: 'advanced-cursor' },
    items: [
      {
        id: 'dry-item-1',
        title: 'First item',
        payload_text: 'body one',
        payload_type: 'text',
        occurred_at: new Date().toISOString(),
      },
      {
        id: 'dry-item-2',
        title: 'Second item',
        payload_text: 'body two',
        payload_type: 'text',
        occurred_at: new Date().toISOString(),
      },
    ],
  };
}

describe('feed dry run persists nothing', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('writes no events, does not advance the checkpoint, and leaves feed schedule state untouched', async () => {
    const sql = getTestDb();
    const { orgId, feedId, runId } = await seed(true);

    const before = (await sql`
      SELECT checkpoint, next_run_at, last_sync_status FROM feeds WHERE id = ${feedId}
    `) as Array<Record<string, unknown>>;

    const { ctx, result } = mockWorkerCtx(batchFor(runId));
    await streamContent(ctx);

    expect(result().status).toBe(200);
    expect((result().body as { dry_run?: boolean }).dry_run).toBe(true);
    // The items were seen and counted — the connector really did run.
    expect((result().body as { total_items: number }).total_items).toBe(2);

    // THE assertion: nothing landed in the append-only table.
    const events = (await sql`
      SELECT id FROM events WHERE organization_id = ${orgId}
    `) as Array<{ id: number }>;
    expect(events).toHaveLength(0);

    // The checkpoint did not move, even though the batch offered a new one.
    // If it had, the rows this dry run previewed would be skipped by the next
    // REAL sync — silently losing data the operator was only inspecting.
    const after = (await sql`
      SELECT checkpoint, next_run_at, last_sync_status FROM feeds WHERE id = ${feedId}
    `) as Array<Record<string, unknown>>;
    expect(after[0].checkpoint).toEqual(FEED_CHECKPOINT);
    expect(after[0].checkpoint).toEqual(before[0].checkpoint);
    expect(after[0].next_run_at).toEqual(before[0].next_run_at);
    expect(after[0].last_sync_status).toEqual(before[0].last_sync_status);

    // The run's own checkpoint column is likewise untouched.
    const runRow = (await sql`
      SELECT checkpoint, dry_run_preview FROM runs WHERE id = ${runId}
    `) as Array<{ checkpoint: unknown; dry_run_preview: Record<string, unknown> }>;
    expect(runRow[0].checkpoint).toBeNull();

    // Secondary: the preview describes what WOULD have been ingested.
    const preview = runRow[0].dry_run_preview;
    expect(preview.total).toBe(2);
    expect(preview.truncated).toBe(false);
    expect((preview.items as Array<{ origin_id: string }>).map((i) => i.origin_id)).toEqual([
      'dry-item-1',
      'dry-item-2',
    ]);
  });

  it('caps the stored preview across batches while total keeps counting', async () => {
    const sql = getTestDb();
    const { runId } = await seed(true);

    const itemsOf = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${prefix}-${i}`,
        title: `Item ${prefix}-${i}`,
        payload_text: 'body',
        payload_type: 'text',
        occurred_at: new Date().toISOString(),
      }));

    // Two batches of 30 against a 50-item cap. The JS-side cap only bounds one
    // request's payload, so without the SQL-side re-cap the stored array would
    // grow to 60 here — and by up to 50 per batch on a long sync.
    for (const prefix of ['b1', 'b2']) {
      const { ctx, result } = mockWorkerCtx({
        run_id: runId,
        worker_id: WORKER_ID,
        items: itemsOf(prefix, 30),
      });
      await streamContent(ctx);
      expect(result().status).toBe(200);
    }

    const rows = (await sql`
      SELECT dry_run_preview FROM runs WHERE id = ${runId}
    `) as Array<{
      dry_run_preview: { items: Array<{ origin_id: string }>; total: number; truncated: boolean };
    }>;
    const preview = rows[0].dry_run_preview;
    expect(preview.items).toHaveLength(50);
    // Earliest-first: the cap keeps the head of the stream, not the tail.
    expect(preview.items[0].origin_id).toBe('b1-0');
    expect(preview.items[49].origin_id).toBe('b2-19');
    expect(preview.total).toBe(60);
    expect(preview.truncated).toBe(true);
  });

  it('does not release the active run before its feed checkpoint commits', async () => {
    const sql = getTestDb();
    const { feedId, runId } = await seed(false);
    const checkpoint = { source_ack: { binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', records: [{ id: 'source-item', revision: 1 }] } };
    await sql.unsafe(`
      CREATE FUNCTION synthetic_reject_feed_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.checkpoint ? 'source_ack' THEN RAISE EXCEPTION 'synthetic checkpoint failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER synthetic_reject_feed_checkpoint BEFORE UPDATE ON feeds
      FOR EACH ROW EXECUTE FUNCTION synthetic_reject_feed_checkpoint();
    `);
    try {
      const completion = mockWorkerCtx({ run_id: runId, worker_id: WORKER_ID, status: 'success', checkpoint });
      await completeWorkerJob(completion.ctx);
      expect(completion.result().status).toBe(500);
      expect((await sql`SELECT status FROM runs WHERE id = ${runId}`)[0].status).toBe('running');
      expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${feedId}`)[0].checkpoint).toEqual(FEED_CHECKPOINT);
    } finally {
      await sql.unsafe('DROP TRIGGER synthetic_reject_feed_checkpoint ON feeds; DROP FUNCTION synthetic_reject_feed_checkpoint();');
    }
    const retry = mockWorkerCtx({ run_id: runId, worker_id: WORKER_ID, status: 'success', checkpoint });
    await completeWorkerJob(retry.ctx);
    expect(retry.result().status).toBe(200);
    expect((await sql`SELECT status FROM runs WHERE id = ${runId}`)[0].status).toBe('completed');
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${feedId}`)[0].checkpoint).toEqual(checkpoint);
  });

  it('keeps source acknowledgments at the last successful completion during streaming and failure', async () => {
    const sql = getTestDb();
    const { feedId, runId } = await seed(false);
    const savedAck = { binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', records: [{ id: 'source-item', revision: 1 }] };
    const offeredAck = { ...savedAck, records: [{ id: 'source-item', revision: 2 }] };
    await sql`UPDATE feeds SET checkpoint = ${sql.json({ ...FEED_CHECKPOINT, source_ack: savedAck })} WHERE id = ${feedId}`;
    const batch = { ...batchFor(runId), checkpoint: { cursor: 'streamed', source_ack: offeredAck } };
    const streaming = mockWorkerCtx(batch);
    await streamContent(streaming.ctx);
    expect(streaming.result().status).toBe(200);
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${feedId}`)[0].checkpoint).toEqual({ cursor: 'streamed', source_ack: savedAck });
    const failed = mockWorkerCtx({ run_id: runId, worker_id: WORKER_ID, status: 'failed', error: 'synthetic failure after streaming', checkpoint: batch.checkpoint });
    await completeWorkerJob(failed.ctx);
    expect(failed.result().status).toBe(200);
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${feedId}`)[0].checkpoint.source_ack).toEqual(savedAck);
  });

  it('CONTROL: the same batch on a non-dry run does persist', async () => {
    const sql = getTestDb();
    const { orgId, feedId, runId } = await seed(false);

    const { ctx } = mockWorkerCtx(batchFor(runId));
    await streamContent(ctx);

    // Without this case the test above would pass on a build where
    // streamContent dropped every batch on the floor.
    const events = (await sql`
      SELECT id FROM events WHERE organization_id = ${orgId}
    `) as Array<{ id: number }>;
    expect(events.length).toBeGreaterThan(0);

    const after = (await sql`
      SELECT checkpoint FROM feeds WHERE id = ${feedId}
    `) as Array<{ checkpoint: Record<string, unknown> }>;
    expect(after[0].checkpoint).toEqual({ cursor: 'advanced-cursor' });

    const runRow = (await sql`
      SELECT dry_run_preview FROM runs WHERE id = ${runId}
    `) as Array<{ dry_run_preview: unknown }>;
    expect(runRow[0].dry_run_preview).toBeNull();
  });

  it('validates strict connector metadata before adding identity projections', async () => {
    const sql = getTestDb();
    const { orgId, runId } = await seed(false);
    const user = await createTestUser();
    await addUserToOrganization(user.id, orgId, 'owner');
    await ensureMemberEntityType(orgId);
    await createTestConnectorDefinition({
      key: 'rss',
      name: 'Strict attributed feed',
      organization_id: orgId,
      feeds_schema: {
        items: {
          eventKinds: {
            message: {
              metadataSchema: {
                type: 'object',
                properties: {
                  actor_id: { type: 'string' },
                  tenant_id: { type: 'string' },
                },
                required: ['actor_id', 'tenant_id'],
                additionalProperties: false,
              },
              attributions: [
                {
                  role: 'authored_by',
                  autoCreate: true,
                  target: {
                    entityType: '$member',
                    identities: [
                      {
                        namespace: 'strict_actor_id',
                        eventPath: 'metadata.actor_id',
                        scope: 'tenant',
                        scopeKeyPath: 'metadata.tenant_id',
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
    clearEntityLinkRulesCache();
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      items: [
        {
          id: 'strict-attributed-item',
          title: 'Strict attributed item',
          payload_text: 'body',
          payload_type: 'text',
          origin_type: 'message',
          metadata: { actor_id: 'actor-1', tenant_id: 'tenant-a' },
        },
      ],
    });

    await streamContent(ctx);

    expect(result().status).toBe(200);
    expect(result().body).toMatchObject({ total_items: 1 });
    expect(result().body).not.toHaveProperty('rejected_items');
    const [event] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM events
      WHERE organization_id = ${orgId} AND origin_id = 'strict-attributed-item'
    `;
    expect(event?.metadata).toMatchObject({
      actor_id: 'actor-1',
      tenant_id: 'tenant-a',
      strict_actor_id: 'actor-1',
      [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { strict_actor_id: 'tenant-a' },
    });
  });

  const feedSyncState = (feedId: number) => {
    const sql = getTestDb();
    return sql`
      SELECT checkpoint, next_run_at, last_sync_status, last_sync_at,
             last_error, consecutive_failures, items_collected, status
      FROM feeds WHERE id = ${feedId}
    ` as Promise<Array<Record<string, unknown>>>;
  };

  it('completing a dry run finalizes the run but stamps no feed sync state and no checkpoint', async () => {
    const sql = getTestDb();
    const { feedId, runId } = await seed(true);

    const before = await feedSyncState(feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 2,
      // A final checkpoint IS offered — the dry path must decline it.
      checkpoint: { cursor: 'advanced-cursor' },
    });
    await completeWorkerJob(ctx);
    expect((result().body as { success: boolean }).success).toBe(true);

    // The run row itself is real working state: it finalizes normally...
    const run = (await sql`
      SELECT status, checkpoint FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; checkpoint: unknown }>;
    expect(run[0].status).toBe('completed');
    // ...but never records the would-be cursor, matching the stream-time guard.
    expect(run[0].checkpoint).toBeNull();

    // Feed sync state is byte-identical: no checkpoint advance, no
    // last_sync_* stamp, no next_run_at move.
    const after = await feedSyncState(feedId);
    expect(after[0]).toEqual(before[0]);
  });

  it('a FAILED dry run does not touch failure bookkeeping (consecutive_failures, backoff, pause)', async () => {
    const { feedId, runId } = await seed(true);

    const before = await feedSyncState(feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      error_message: 'connector blew up',
    });
    await completeWorkerJob(ctx);
    expect((result().body as { success: boolean }).success).toBe(true);

    // A dry run's failure is the operator's information, not the feed's
    // history: no consecutive_failures increment, no last_error, no backoff
    // or auto-pause that would degrade the REAL schedule.
    const after = await feedSyncState(feedId);
    expect(after[0]).toEqual(before[0]);
  });

  it('CONTROL: completing a non-dry run does stamp feed sync state', async () => {
    const { feedId, runId } = await seed(false);

    const { ctx } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 2,
      checkpoint: { cursor: 'advanced-cursor' },
    });
    await completeWorkerJob(ctx);

    // Without this the dry cases above would pass on a build where
    // completeWorkerJob stopped writing feed state for everyone.
    const after = await feedSyncState(feedId);
    expect(after[0].checkpoint).toEqual({ cursor: 'advanced-cursor' });
    expect(after[0].last_sync_at).not.toBeNull();
    expect(after[0].last_sync_status).toBe('success');
  });
});

/**
 * The reason the dry path runs the REAL inserts against a rolled-back
 * transaction rather than skipping them.
 *
 * A dry run exists to answer "would this sync work?". An implementation that
 * validated the items and then declined to insert them would answer that
 * question by not asking it: anything the database itself rejects — a
 * constraint, a trigger, a NOT NULL, a bad cast — would be invisible, and the
 * operator would be told "2 items would be ingested" about data that can never
 * land. These tests pin the property that makes the answer trustworthy.
 */
describe('dry run exercises the real write path', () => {
  it('surfaces a database-level failure instead of reporting success', async () => {
    const { runId } = await seed(true);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      items: [
        {
          id: 'bad-item',
          title: 'Unpersistable',
          payload_text: 'body',
          payload_type: 'text',
          // Not a timestamp. The real path fails on this at INSERT time; a dry
          // run must fail identically rather than cheerfully previewing it.
          occurred_at: 'definitely-not-a-timestamp',
        },
      ],
    });
    await streamContent(ctx);

    expect(result().status).toBe(500);
    expect((result().body as { dry_run?: boolean }).dry_run).toBeUndefined();
  });

});
