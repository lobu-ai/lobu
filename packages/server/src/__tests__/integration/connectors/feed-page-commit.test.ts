/**
 * A feed page commits as one unit: every event it carries and the checkpoint
 * that says those events were consumed become durable together, and only
 * while the run that wrote them still holds its lease.
 *
 * Each case is written as a property of the stored state, checked against an
 * oracle built from the batch the test sent — never against what the handler
 * reported. A handler that returned 200 and silently dropped an item, or that
 * advanced the cursor past a page it only half stored, is exactly the failure
 * this file exists to catch, and its own response would not reveal either.
 */

import type { Context } from 'hono';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { insertEvent, lockEventDedupIdentity } from '../../../utils/insert-event';
import { streamContent } from '../../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const WORKER_ID = 'worker-page-commit';
const OLD_CHECKPOINT = { cursor: 'page-0' };

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

async function seedConnection(slug: string) {
  const sql = getTestDb();
  const org = await createTestOrganization();
  const [conn] = await sql<{ id: number }[]>`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, created_at, updated_at)
    VALUES (${org.id}, 'rss', 'active', 'org', ${slug}, NOW(), NOW())
    RETURNING id
  `;
  return { orgId: org.id, connectionId: Number(conn.id) };
}

async function seedRun(orgId: string, connectionId: number, feedKey: string) {
  const sql = getTestDb();
  const [feed] = await sql<{ id: number }[]>`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, schedule, checkpoint,
       last_sync_status, created_at, updated_at)
    VALUES (${orgId}, ${connectionId}, ${feedKey}, 'active', '0 */6 * * *',
            ${sql.json(OLD_CHECKPOINT)}, 'success', NOW(), NOW())
    RETURNING id
  `;
  const [run] = await sql<{ id: number }[]>`
    INSERT INTO runs
      (organization_id, run_type, feed_id, connection_id, connector_key,
       connector_version, status, claimed_by, created_at)
    VALUES (${orgId}, 'sync', ${feed.id}, ${connectionId}, 'rss', '1.0.0',
            'running', ${WORKER_ID}, NOW())
    RETURNING id
  `;
  return { feedId: Number(feed.id), runId: Number(run.id) };
}

async function seed(slug = 'rss-page-commit') {
  const { orgId, connectionId } = await seedConnection(slug);
  const { feedId, runId } = await seedRun(orgId, connectionId, 'items');
  return { orgId, connectionId, feedId, runId };
}

function item(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Item ${id}`,
    payload_text: `body of ${id}`,
    payload_type: 'text',
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

/** The stored, CURRENT (not superseded) origin ids for one connection. */
async function currentOriginIds(connectionId: number): Promise<string[]> {
  const sql = getTestDb();
  const rows = await sql<{ origin_id: string }[]>`
    SELECT e.origin_id FROM events e
    WHERE e.connection_id = ${connectionId}
      AND e.superseded_by IS NULL
    ORDER BY e.origin_id
  `;
  return rows.map((row) => row.origin_id);
}

async function feedCheckpoint(feedId: number): Promise<unknown> {
  const [row] = await getTestDb()<{ checkpoint: unknown }[]>`
    SELECT checkpoint FROM feeds WHERE id = ${feedId}
  `;
  return row?.checkpoint;
}

/** Poll until some backend is blocked by `tx`'s session; throw on a deadline. */
async function waitUntilBlockedBy(tx: postgres.TransactionSql): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await tx<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_stat_activity
      WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
    `;
    if ((row?.c ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const activity = await tx`
    SELECT pid, state, wait_event_type, wait_event, left(query, 80) AS query
    FROM pg_stat_activity WHERE datname = current_database()
  `;
  throw new Error(`No backend blocked on the held lock: ${JSON.stringify(activity)}`);
}

describe('feed page commit', () => {
  const extraClients: postgres.Sql[] = [];

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    await Promise.all(extraClients.splice(0).map((client) => client.end({ timeout: 5 })));
  });

  it('stores an item that has neither text nor a title instead of dropping it under an advanced cursor', async () => {
    const { connectionId, feedId, runId } = await seed();
    const batch = {
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'page-1' },
      items: [
        item('with-text'),
        // A structured-only item: its content lives in payload_data.
        item('structured-only', {
          title: null,
          payload_text: null,
          payload_type: 'empty',
          payload_data: { amount: 42 },
        }),
      ],
    };

    const { ctx, result } = mockWorkerCtx(batch);
    await streamContent(ctx);

    expect(result().status).toBe(200);
    expect(await currentOriginIds(connectionId)).toEqual(
      batch.items.map((i) => i.id).sort()
    );
    expect(await feedCheckpoint(feedId)).toEqual({ cursor: 'page-1' });
  });

  it('stores none of a page and keeps the old cursor when one of its items fails to insert', async () => {
    const { connectionId, feedId, runId } = await seed();
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'page-1' },
      items: [
        item('first'),
        // Fails to insert after `first` was already written in this page.
        item('second', { occurred_at: 'not-a-timestamp' }),
        item('third'),
      ],
    });

    await streamContent(ctx);

    expect(result().status).toBe(500);
    expect(await currentOriginIds(connectionId)).toEqual([]);
    expect(await feedCheckpoint(feedId)).toEqual(OLD_CHECKPOINT);
  });

  it('commits nothing for a run whose lease was lost after the request was authorized', async () => {
    const { connectionId, feedId, runId } = await seed();
    const blocker = postgres(process.env.DATABASE_URL as string, { max: 1 });
    const reaper = postgres(process.env.DATABASE_URL as string, { max: 1 });
    extraClients.push(blocker, reaper);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'page-1' },
      items: [item('late-item')],
    });

    // Park the batch after it was authorized and before it writes: hold the
    // connection row the way deletion does, and the item's dedup identity the
    // way a concurrent ingest does, so the handler blocks on whichever of the
    // two it reaches first. While it waits, the reaper takes the run away.
    const { streaming } = await blocker.begin(async (tx) => {
      await tx`SELECT id FROM connections WHERE id = ${connectionId} FOR UPDATE`;
      await lockEventDedupIdentity(tx as unknown as DbClient, connectionId, 'late-item');
      const streaming = streamContent(ctx);
      await waitUntilBlockedBy(tx);
      await reaper`
        UPDATE runs SET status = 'timeout', completed_at = NOW() WHERE id = ${runId}
      `;
      return { streaming };
    });
    await streaming;

    expect(result().status).toBe(409);
    expect(await currentOriginIds(connectionId)).toEqual([]);
    expect(await feedCheckpoint(feedId)).toEqual(OLD_CHECKPOINT);
    const [run] = await getTestDb()<{ checkpoint: unknown }[]>`
      SELECT checkpoint FROM runs WHERE id = ${runId}
    `;
    expect(run?.checkpoint).toBeNull();
  }, 30_000);

  it('commits nothing after its feed is deleted even before run cancellation lands', async () => {
    const { connectionId, feedId, runId } = await seed();
    await getTestDb()`
      UPDATE feeds
      SET deleted_at = NOW(), status = 'paused'
      WHERE id = ${feedId}
    `;
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'page-1' },
      items: [item('after-delete')],
    });

    await streamContent(ctx);

    expect(result().status).toBe(409);
    expect(await currentOriginIds(connectionId)).toEqual([]);
    expect(await feedCheckpoint(feedId)).toEqual(OLD_CHECKPOINT);
  });

  it('keeps one current row when two transactions write the same source identity', async () => {
    const { orgId, connectionId } = await seed();
    const first = postgres(process.env.DATABASE_URL as string, { max: 1 });
    const second = postgres(process.env.DATABASE_URL as string, { max: 1 });
    extraClients.push(first, second);

    const write = (db: postgres.TransactionSql, content: string) =>
      insertEvent(
        {
          entityIds: [],
          organizationId: orgId,
          connectionId,
          originId: 'shared-identity',
          title: 'Shared identity',
          content,
          semanticType: 'content',
          occurredAt: new Date(),
        },
        { onConflictUpdate: true, sql: db as unknown as DbClient }
      );

    // The first writer inserts and holds its transaction open; the second
    // starts inside that window. Without the dedup lock inside a caller-owned
    // transaction the second cannot see the first's uncommitted row and
    // inserts a second current row for the same identity.
    const { racing } = await first.begin(async (tx) => {
      await write(tx, 'first version');
      const racing = second.begin((tx2) => write(tx2, 'second version'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { racing };
    });
    await racing;

    expect(await currentOriginIds(connectionId)).toEqual(['shared-identity']);
  }, 30_000);

  it('commits a maximum-sized worker page within the transaction timeout', async () => {
    // A page's events are stamped `created_at` when its transaction starts and
    // become visible only at commit, so the whole page transaction is the
    // exposure Automation windows budget for (events-insert-sites.test.ts).
    // The isolate streams pages of at most this many events.
    const PAGE_SIZE = 100;
    const { connectionId, runId } = await seed();
    const ids = Array.from({ length: PAGE_SIZE }, (_, i) => `page-${String(i).padStart(3, '0')}`);
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'page-1' },
      items: ids.map((id) => item(id)),
    });

    await streamContent(ctx);

    expect(result().status).toBe(200);
    expect(await currentOriginIds(connectionId)).toEqual(ids);
  }, 30_000);

  it('serializes two pages that share items in opposite order without a deadlock or a duplicate', async () => {
    const { orgId, connectionId, runId } = await seed();
    const other = await seedRun(orgId, connectionId, 'mirror');
    const ids = Array.from({ length: 20 }, (_, i) => `shared-${String(i).padStart(2, '0')}`);

    const forward = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'forward' },
      items: ids.map((id) => item(id)),
    });
    const backward = mockWorkerCtx({
      run_id: other.runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'backward' },
      items: [...ids].reverse().map((id) => item(id, { payload_text: `mirror ${id}` })),
    });

    await Promise.all([streamContent(forward.ctx), streamContent(backward.ctx)]);

    expect(forward.result().status).toBe(200);
    expect(backward.result().status).toBe(200);
    expect(await currentOriginIds(connectionId)).toEqual(ids);
  }, 30_000);
});
