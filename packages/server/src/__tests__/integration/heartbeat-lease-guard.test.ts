/**
 * heartbeat lease-guard reproducer.
 *
 * Bug: `heartbeat` stamped `last_heartbeat_at` — and, when the worker reports
 * an `agent_session`, the `run_metadata.device_agent_session` checkpoint —
 * with a bare `WHERE id = run_id`. So a worker reporting in AFTER the gateway
 * reaped the run, or after another device re-claimed it, would:
 *   1. resurrect the run's liveness clock, keeping a dead run off the reaper's
 *      next sweep, and
 *   2. pin ITS OWN `device_agent_session` onto a run it no longer owns —
 *      which is what a later poll reads to decide where to resume the agent
 *      session, so the resume lands on the wrong machine.
 *
 * The fix mirrors completeWorkerJob and completeAuthRun: the UPDATE carries
 * `AND status = 'running' AND claimed_by = worker_id` + RETURNING, and a
 * 0-row match answers 409 without writing.
 *
 * `authorizeRunForWorker` checks the same two things, but only in
 * `workerAuthMode === 'user'` — it returns null immediately for every other
 * mode. A token-auth cloud worker therefore reaches the UPDATE with NO prior
 * ownership check at all, and the guard on the statement is the only one. It
 * also closes the TOCTOU window for user-mode workers, where the status flips
 * between authorizeRunForWorker's read and the UPDATE.
 *
 * Drives the REAL exported `heartbeat` handler against the embedded DB via a
 * minimal Hono Context, the same approach as
 * complete-worker-job-status-guard.test.ts: the mock context has no
 * workerAuthMode, so authorizeRunForWorker is a no-op and the guard under test
 * is isolated — exactly the shared-token cloud worker's path in production.
 */

import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { heartbeat } from '../../worker-api/run-lifecycle';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const CLAIMANT = 'worker-legit';
const OTHER = 'worker-other';

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

async function insertRun(
  organizationId: string,
  status: string,
  claimedBy: string | null
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, status, claimed_by, claimed_at,
       last_heartbeat_at, created_at)
    VALUES
      (${organizationId}, 'automation', ${status}, ${claimedBy}, NOW(),
       NULL, NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function readRun(runId: number) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT status, claimed_by, last_heartbeat_at, run_metadata
    FROM runs WHERE id = ${runId}
  `) as Array<{
    status: string;
    claimed_by: string | null;
    last_heartbeat_at: Date | null;
    run_metadata: { device_agent_session?: { worker_id?: string } } | null;
  }>;
  return rows[0];
}

const AGENT_SESSION = {
  protocol: 'acp',
  agent_kind: 'opencode',
  session_id: 'session-from-the-wrong-device',
};

describe('heartbeat lease guard', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does NOT let a reaped run be resurrected by its own late worker', async () => {
    const org = await createTestOrganization();
    const runId = await insertRun(org.id, 'timeout', CLAIMANT);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: CLAIMANT,
      agent_session: AGENT_SESSION,
    });
    await heartbeat(ctx);

    expect(result().status).toBe(409);
    const run = await readRun(runId);
    expect(String(run.status)).toBe('timeout');
    expect(run.last_heartbeat_at).toBeNull();
    expect(run.run_metadata?.device_agent_session).toBeUndefined();
  });

  // The gateway cannot address a fleet worker that already holds a run, so the
  // heartbeat's response is its only way to tell a turn in flight to stop. A
  // cancelled run fails the lease fence exactly like a lost lease does (the
  // fence requires status='running'), and the worker has to tell them apart:
  // on a cancel it still owns the run and must finish through its normal
  // completion path so the client still gets an answer; on a lost lease
  // another worker owns the run and this one must not touch it.
  it('tells the run\'s own worker to stop when a human cancelled it', async () => {
    const org = await createTestOrganization();
    const runId = await insertRun(org.id, 'cancelled', CLAIMANT);

    const { ctx, result } = mockWorkerCtx({ run_id: runId, worker_id: CLAIMANT });
    await heartbeat(ctx);

    expect(result().status).toBe(200);
    expect(result().body).toEqual({ continue: false, stop_reason: 'cancelled' });
    // Still a refusal to write: the cancelled run's liveness clock stays clear,
    // so this answer cannot keep a dead run off the reaper's next sweep.
    const run = await readRun(runId);
    expect(String(run.status)).toBe('cancelled');
    expect(run.last_heartbeat_at).toBeNull();
  });

  it('does NOT report cancellation to a worker that no longer owns the run', async () => {
    const org = await createTestOrganization();
    const runId = await insertRun(org.id, 'cancelled', CLAIMANT);

    const { ctx, result } = mockWorkerCtx({ run_id: runId, worker_id: OTHER });
    await heartbeat(ctx);

    // OTHER is not the claimant, so it learns nothing about this run beyond
    // "not yours" — the ownership fence gates the cancel signal too.
    expect(result().status).toBe(409);
  });

  it('keeps answering continue:true while the run is healthy', async () => {
    const org = await createTestOrganization();
    const runId = await insertRun(org.id, 'running', CLAIMANT);

    const { ctx, result } = mockWorkerCtx({ run_id: runId, worker_id: CLAIMANT });
    await heartbeat(ctx);

    expect(result().status).toBe(200);
    expect(result().body).toEqual({ continue: true });
    const run = await readRun(runId);
    expect(run.last_heartbeat_at).not.toBeNull();
  });

  it('does NOT let a non-claimant pin its agent session onto a running run', async () => {
    const org = await createTestOrganization();
    const runId = await insertRun(org.id, 'running', CLAIMANT);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: OTHER,
      agent_session: AGENT_SESSION,
    });
    await heartbeat(ctx);

    expect(result().status).toBe(409);
    const run = await readRun(runId);
    // The rightful claimant keeps the run, and poll will not be told to resume
    // the session on `OTHER`'s machine.
    expect(run.claimed_by).toBe(CLAIMANT);
    expect(run.last_heartbeat_at).toBeNull();
    expect(run.run_metadata?.device_agent_session).toBeUndefined();
  });

  it('still checkpoints the claimant of a running run', async () => {
    const org = await createTestOrganization();
    const runId = await insertRun(org.id, 'running', CLAIMANT);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: CLAIMANT,
      agent_session: AGENT_SESSION,
    });
    await heartbeat(ctx);

    expect(result().status).toBe(200);
    expect(result().body).toEqual({ continue: true });
    const run = await readRun(runId);
    expect(run.last_heartbeat_at).not.toBeNull();
    expect(run.run_metadata?.device_agent_session?.worker_id).toBe(CLAIMANT);
  });
});
