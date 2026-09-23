/**
 * completeWorkerJob status-guard reproducer.
 *
 * Bug: completeWorkerJob finalized a run with a bare `WHERE id = run_id`
 * UPDATE — no `status = 'running'` / `claimed_by` guard. So a worker that
 * reports in AFTER the gateway already reaped the run on timeout
 * (status -> 'timeout') would:
 *   1. resurrect the run (overwrite the terminal 'timeout' with 'completed'/
 *      'failed'), and
 *   2. re-run the feed/auth bookkeeping a SECOND time — double-incrementing
 *      consecutive_failures / items_collected and rewriting next_run_at,
 *      even though the timeout path already accounted for the run.
 *
 * The fix mirrors completeActionRun: the terminal UPDATE carries
 * `AND status = 'running' AND claimed_by = worker_id` + RETURNING, and on a
 * 0-row match we short-circuit with an idempotent `already_finalized`
 * response BEFORE touching feeds/auth.
 *
 * Red (pre-fix): the late completion flips status away from 'timeout' AND
 * bumps the feed counters. Green (post-fix): status stays 'timeout', feed
 * counters are untouched, handler returns { success: false,
 * reason: 'already_finalized' }.
 *
 * This drives the REAL exported completeWorkerJob handler against the
 * embedded DB via a minimal Hono Context (same approach as
 * embedding-model-swap-e2e.test.ts). The mock context has no
 * workerAuthMode, so authorizeRunForWorker is a no-op — which isolates the
 * guard under test to completeWorkerJob's own UPDATE, exactly as the
 * timeout race would in production (the status flips AFTER
 * authorizeRunForWorker's read, in the TOCTOU window before the UPDATE).
 */

import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { completeWorkerJob } from '../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const WORKER_ID = 'worker-late';

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

async function insertConnection(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, created_at, updated_at)
    VALUES
      (${organizationId}, 'chrome', 'active', 'org', 'chrome-guard-test', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertFeed(organizationId: string, connectionId: number): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, schedule,
       consecutive_failures, items_collected, last_sync_status, created_at, updated_at)
    VALUES
      (${organizationId}, ${connectionId}, 'chrome-feed', 'active', '0 */6 * * *',
       3, 10, 'failed', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

/**
 * Seed a run that has ALREADY been reaped on timeout: status='timeout',
 * but still bears the claim (`claimed_by`) of the worker that's about to
 * report in late. This is the exact shape of a run when the gateway's
 * timeout reaper flipped the status while the worker was still running.
 */
async function insertReapedRun(
  organizationId: string,
  connectionId: number,
  feedId: number
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, feed_id, connection_id, connector_key,
       connector_version, status, claimed_by, claimed_at, completed_at,
       error_message, created_at)
    VALUES
      (${organizationId}, 'sync', ${feedId}, ${connectionId}, 'chrome', '0.2.0',
       'timeout', ${WORKER_ID}, NOW(), NOW(), 'reaped-on-timeout', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

describe('completeWorkerJob status guard (late-completion-after-timeout)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does NOT resurrect a reaped run or double-apply feed bookkeeping on late failed completion', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId);
    const runId = await insertReapedRun(org.id, connId, feedId);

    const sql = getTestDb();
    const before = (await sql`
      SELECT consecutive_failures, items_collected, last_sync_status
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      consecutive_failures: number;
      items_collected: number | string;
      last_sync_status: string | null;
    }>;
    expect(Number(before[0].consecutive_failures)).toBe(3);

    // Worker reports in LATE with a failed verdict.
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      items_collected: 0,
      error_message: 'too late',
    });
    await completeWorkerJob(ctx);

    // Handler must report the no-op idempotently.
    expect(result().body).toEqual({ success: false, reason: 'already_finalized' });

    // Run stays terminal/timeout — NOT resurrected to 'failed'.
    const runAfter = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string | null }>;
    expect(runAfter[0].status).toBe('timeout');
    expect(runAfter[0].error_message).toBe('reaped-on-timeout');

    // Feed bookkeeping is UNTOUCHED — no second failure increment.
    const after = (await sql`
      SELECT consecutive_failures, items_collected, last_sync_status, last_sync_at
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      consecutive_failures: number;
      items_collected: number | string;
      last_sync_status: string | null;
      last_sync_at: Date | string | null;
    }>;
    expect(Number(after[0].consecutive_failures)).toBe(3); // not 4
    expect(Number(after[0].items_collected)).toBe(10); // unchanged
    expect(after[0].last_sync_at).toBeNull(); // bookkeeping never ran
  });

  it('does NOT resurrect a reaped run or double-count items on late success completion', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId);
    const runId = await insertReapedRun(org.id, connId, feedId);

    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 99,
    });
    await completeWorkerJob(ctx);

    expect(result().body).toEqual({ success: false, reason: 'already_finalized' });

    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('timeout'); // not 'completed'

    const after = (await sql`
      SELECT consecutive_failures, items_collected, last_sync_at
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      consecutive_failures: number;
      items_collected: number | string;
      last_sync_at: Date | string | null;
    }>;
    expect(Number(after[0].items_collected)).toBe(10); // not 10 + 99
    expect(Number(after[0].consecutive_failures)).toBe(3); // success would have reset to 0
    expect(after[0].last_sync_at).toBeNull();
  });

  it('still finalizes a genuinely running run + applies feed bookkeeping once', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId);

    const sql = getTestDb();
    // A live, claimed, running run — the happy path.
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, feed_id, connection_id, connector_key,
         connector_version, status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'sync', ${feedId}, ${connId}, 'chrome', '0.2.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 7,
    });
    await completeWorkerJob(ctx);

    expect(result().body).toEqual({ success: true });

    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('completed');

    const after = (await sql`
      SELECT consecutive_failures, items_collected, last_sync_status, last_sync_at
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      consecutive_failures: number;
      items_collected: number | string;
      last_sync_status: string | null;
      last_sync_at: Date | string | null;
    }>;
    expect(Number(after[0].consecutive_failures)).toBe(0); // success reset
    expect(Number(after[0].items_collected)).toBe(10 + 7); // applied once
    expect(after[0].last_sync_status).toBe('success');
    expect(after[0].last_sync_at).not.toBeNull();
  });

  it('rolls the run transition back when feed bookkeeping fails', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId);
    const sql = getTestDb();
    await sql`
      UPDATE feeds
      SET consecutive_failures = 2147483647
      WHERE id = ${feedId}
    `;
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO runs
        (organization_id, run_type, feed_id, connection_id, connector_key,
         connector_version, status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'sync', ${feedId}, ${connId}, 'chrome', '0.2.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `;
    const { ctx, result } = mockWorkerCtx({
      run_id: run.id,
      worker_id: WORKER_ID,
      status: 'failed',
      error_message: 'expected failure',
    });

    await completeWorkerJob(ctx);

    expect(result().status).toBe(500);
    const [after] = await sql<{
      status: string;
      completed_at: Date | null;
      error_message: string | null;
    }[]>`
      SELECT status, completed_at, error_message
      FROM runs WHERE id = ${run.id}
    `;
    expect(after).toEqual({
      status: 'running',
      completed_at: null,
      error_message: null,
    });
  });

  it('does not commit a new checkpoint when a running stream later fails', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId);
    const sql = getTestDb();
    const previousCheckpoint = { cursor: 'previous' };
    await sql`
      UPDATE feeds SET checkpoint = ${sql.json(previousCheckpoint)} WHERE id = ${feedId}
    `;
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, feed_id, connection_id, connector_key,
         connector_version, status, claimed_by, claimed_at, checkpoint, dry_run, created_at)
      VALUES
        (${org.id}, 'sync', ${feedId}, ${connId}, 'chrome', '0.2.0',
         'running', ${WORKER_ID}, NOW(), ${sql.json(previousCheckpoint)}, false, NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      items_collected: 1,
      checkpoint: { cursor: 'failed-stream' },
      error_message: 'stream delivery failed',
    });
    await completeWorkerJob(ctx);

    expect(result().body).toEqual({ success: true });
    const after = (await sql`
      SELECT r.status, r.checkpoint AS run_checkpoint, f.checkpoint AS feed_checkpoint
      FROM runs r JOIN feeds f ON f.id = r.feed_id
      WHERE r.id = ${runId}
    `) as Array<{
      status: string;
      run_checkpoint: unknown;
      feed_checkpoint: unknown;
    }>;
    expect(after[0].status).toBe('failed');
    expect(after[0].run_checkpoint).toEqual(previousCheckpoint);
    expect(after[0].feed_checkpoint).toEqual(previousCheckpoint);
  });

  it('rejects a late completion from a DIFFERENT worker than the claimant', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId);

    const sql = getTestDb();
    // Run is genuinely running, claimed by WORKER_ID.
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, feed_id, connection_id, connector_key,
         connector_version, status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'sync', ${feedId}, ${connId}, 'chrome', '0.2.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    // A different worker tries to finalize it.
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: 'some-other-worker',
      status: 'success',
      items_collected: 50,
    });
    await completeWorkerJob(ctx);

    expect(result().body).toEqual({ success: false, reason: 'already_finalized' });

    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('running'); // untouched

    const after = (await sql`
      SELECT items_collected, last_sync_at FROM feeds WHERE id = ${feedId}
    `) as Array<{ items_collected: number | string; last_sync_at: Date | string | null }>;
    expect(Number(after[0].items_collected)).toBe(10); // not bumped
    expect(after[0].last_sync_at).toBeNull();
  });

  it('strips NUL bytes from the run output tail and error message', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId);

    const sql = getTestDb();
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, feed_id, connection_id, connector_key,
         connector_version, status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'sync', ${feedId}, ${connId}, 'chrome', '0.2.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    // Pre-fix, Postgres rejects the NUL in either text column with
    // "invalid byte sequence for encoding UTF8: 0x00" and the handler 500s.
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      items_collected: 0,
      error_message: 'spawn\u0000 ENOENT',
      output_tail: 'line one\u0000line two',
      exit_code: 1,
      exit_reason: 'crash',
    });
    await completeWorkerJob(ctx);

    expect(result().body).toEqual({ success: true });

    const runAfter = (await sql`
      SELECT status, error_message, output_tail FROM runs WHERE id = ${runId}
    `) as Array<{
      status: string;
      error_message: string | null;
      output_tail: string | null;
    }>;
    expect(runAfter[0].status).toBe('failed');
    expect(runAfter[0].error_message).toBe('spawn ENOENT');
    expect(runAfter[0].output_tail).toBe('line oneline two');
  });
});
