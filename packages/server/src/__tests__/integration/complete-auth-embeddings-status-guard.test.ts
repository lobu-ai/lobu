/**
 * completeAuthRun / completeEmbeddings status-guard reproducer.
 *
 * Bug (F2): both handlers finalized their run with a bare `WHERE id = run_id`
 * UPDATE — no `status = 'running'` / `claimed_by = worker_id` guard, and
 * completeEmbeddings never called authorizeRunForWorker at all. So a worker
 * reporting in AFTER the gateway already reaped the run on timeout would:
 *   - resurrect the terminal run, and
 *   - re-apply the downstream side effects: completeAuthRun would flip the
 *     linked auth_profile to 'active' (re-activating a credential the timeout
 *     path had already torn down), and completeEmbeddings would write the
 *     embedding rows for a run that no longer exists logically.
 *
 * The fix mirrors completeWorkerJob/completeActionRun: the terminal UPDATE
 * carries `AND status = 'running' AND claimed_by = worker_id` + RETURNING, and
 * on a 0-row match the handler short-circuits with an idempotent
 * `already_finalized` response BEFORE touching auth_profiles / event_embeddings.
 *
 * Red (pre-fix): the late completion flips the run status away from 'timeout'
 * AND applies the side effects. Green (post-fix): status stays 'timeout', side
 * effects are untouched, handler returns { success: false,
 * reason: 'already_finalized' }.
 *
 * Also covers completeAuthRun's success side effects on the claimant path:
 * linked paused feeds reactivate only below the failure pause threshold, and an
 * `interactive` profile's structured SESSION STATE (e.g. Baileys creds) is
 * stored verbatim — only flat bearer credentials (env, oauth_account) are
 * wrapped in `secret://` refs, since secret-ref'ing session state would strip
 * its non-string values and leave unresolvable refs on the worker.
 *
 * Drives the REAL exported handlers against the embedded DB via a minimal Hono
 * Context (same approach as complete-worker-job-status-guard.test.ts). The mock
 * context has no workerAuthMode, so authorizeRunForWorker is a no-op — which
 * isolates the guard under test to each handler's own UPDATE, exactly as the
 * timeout race would in production (the status flips AFTER
 * authorizeRunForWorker's read, in the TOCTOU window before the UPDATE).
 */

import { parseSecretRef } from '@lobu/core';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { feedBackoff } from '../../connectors/feed-backoff';
import type { Env } from '../../index';
import { resolveAuthCredentials } from '../../utils/auth-credential-secrets';
import { completeAuthRun, completeEmbeddings } from '../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestOrganization } from '../setup/test-fixtures';

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

async function insertPendingAuthProfile(
  organizationId: string,
  opts: { connectorKey?: string; profileKind?: string } = {}
): Promise<number> {
  const connectorKey = opts.connectorKey ?? 'gmail';
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO auth_profiles
      (organization_id, slug, display_name, connector_key, profile_kind, status,
       created_at, updated_at)
    VALUES
      (${organizationId}, ${`${connectorKey}-guard-test`}, 'Guard Test', ${connectorKey},
       ${opts.profileKind ?? 'oauth_account'}, 'pending_auth', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertRunningAuthRun(
  organizationId: string,
  authProfileId: number
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, status, claimed_by, claimed_at,
       auth_profile_id, created_at)
    VALUES
      (${organizationId}, 'auth', 'running', ${WORKER_ID}, NOW(),
       ${authProfileId}, NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

/**
 * Seed an AUTH run already reaped on timeout (status='timeout', still bearing
 * WORKER_ID's claim) — the exact shape after the gateway's timeout reaper
 * flipped the status while the worker was still running.
 */
async function insertReapedAuthRun(
  organizationId: string,
  authProfileId: number
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, auth_profile_id, connector_key, connector_version,
       status, claimed_by, claimed_at, completed_at, error_message, created_at)
    VALUES
      (${organizationId}, 'auth', ${authProfileId}, 'gmail', '0.1.0',
       'timeout', ${WORKER_ID}, NOW(), NOW(), 'reaped-on-timeout', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertReapedEmbedRun(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, status, claimed_by, claimed_at, completed_at,
       error_message, created_at)
    VALUES
      (${organizationId}, 'embed_backfill', 'timeout', ${WORKER_ID}, NOW(), NOW(),
       'reaped-on-timeout', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertEvent(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO events
      (organization_id, payload_text, semantic_type, occurred_at, created_at)
    VALUES
      (${organizationId}, 'embed me', 'note', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

describe('completeAuthRun status guard (late-completion-after-timeout)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does NOT resurrect a reaped auth run or re-activate the auth profile on late success', async () => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id);
    const runId = await insertReapedAuthRun(org.id, profileId);
    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      credentials: { access_token: 'late-token' },
      metadata: { foo: 'bar' },
    });
    await completeAuthRun(ctx);

    // Idempotent no-op response.
    expect(result().body).toEqual({ success: false, reason: 'already_finalized' });

    // Run stays terminal/timeout — NOT resurrected to 'completed'.
    const runAfter = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string | null }>;
    expect(runAfter[0].status).toBe('timeout');
    expect(runAfter[0].error_message).toBe('reaped-on-timeout');

    // Auth profile side effects NEVER applied: still pending_auth, no creds.
    const profileAfter = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profileAfter[0].status).toBe('pending_auth');
    expect(profileAfter[0].auth_data).toEqual({});
  });

  it('rejects a late auth completion from a DIFFERENT worker than the claimant', async () => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id);
    const sql = getTestDb();
    // A genuinely running auth run claimed by WORKER_ID.
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, auth_profile_id, connector_key, connector_version,
         status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'auth', ${profileId}, 'gmail', '0.1.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: 'some-other-worker',
      status: 'success',
      credentials: { access_token: 'stolen' },
    });
    await completeAuthRun(ctx);

    expect(result().body).toEqual({ success: false, reason: 'already_finalized' });

    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('running'); // untouched

    const profileAfter = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profileAfter[0].status).toBe('pending_auth');
    expect(profileAfter[0].auth_data).toEqual({});
  });

  it('still finalizes a genuinely running auth run + activates the profile once', async () => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id);
    const sql = getTestDb();
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, auth_profile_id, connector_key, connector_version,
         status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'auth', ${profileId}, 'gmail', '0.1.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      credentials: { access_token: 'fresh' },
    });
    await completeAuthRun(ctx);

    expect(result().body).toEqual({ success: true });

    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('completed');

    const profileAfter = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profileAfter[0].status).toBe('active');
    // Credentials persist as encrypted secret:// refs, never plaintext, and
    // resolve back to the real value at connect time.
    expect(JSON.stringify(profileAfter[0].auth_data)).not.toContain('fresh');
    expect(
      parseSecretRef(String(profileAfter[0].auth_data.access_token))?.scheme
    ).toBe('secret');
    const resolved = await resolveAuthCredentials({
      organizationId: org.id,
      authProfileId: profileId,
      authData: profileAfter[0].auth_data,
    });
    expect(resolved).toEqual({ access_token: 'fresh' });
  });
});

describe('completeEmbeddings status guard (late-completion-after-timeout)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does NOT resurrect a reaped embed run, but still writes the idempotent embedding', async () => {
    const org = await createTestOrganization();
    const eventId = await insertEvent(org.id);
    const runId = await insertReapedEmbedRun(org.id);
    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      embeddings: [
        { event_id: eventId, embedding: Array.from({ length: 768 }, () => 0.1), embedding_model: 'test-model' },
      ],
    });
    await completeEmbeddings(ctx);

    // The embedding upsert is the handler's real job (idempotent, ownership-gated
    // by authorizeRunForWorker) and runs regardless of the run state — this is the
    // same path headless backfills use with run_id=-1.
    expect(result().body).toEqual({ success: true, updated: 1, failed: 0 });

    // But the run is NOT resurrected — the finalizeRun status guard leaves the
    // reaped run terminal.
    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('timeout');

    // The embedding was written for the event.
    const embRows = (await sql`
      SELECT event_id FROM event_embeddings WHERE event_id = ${eventId}
    `) as Array<{ event_id: number }>;
    expect(embRows.length).toBe(1);
  });

  it('does NOT resurrect a reaped embed run on late empty/error completion', async () => {
    const org = await createTestOrganization();
    const runId = await insertReapedEmbedRun(org.id);
    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      embeddings: [],
      error_message: 'embed failed late',
    });
    await completeEmbeddings(ctx);

    // The error response echoes the submitted message; the run transition is a
    // guarded no-op so the reaped run is NOT resurrected.
    expect(result().body).toEqual({ success: false, error: 'embed failed late' });

    const runAfter = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string | null }>;
    expect(runAfter[0].status).toBe('timeout');
    expect(runAfter[0].error_message).toBe('reaped-on-timeout');
  });

  it('still finalizes a genuinely running embed run + writes embeddings once', async () => {
    const org = await createTestOrganization();
    const eventId = await insertEvent(org.id);
    const sql = getTestDb();
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'embed_backfill', 'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      embeddings: [
        { event_id: eventId, embedding: Array.from({ length: 768 }, () => 0.2), embedding_model: 'test-model' },
      ],
    });
    await completeEmbeddings(ctx);

    expect(result().body).toEqual({ success: true, updated: 1, failed: 0 });

    const runAfter = (await sql`
      SELECT status, items_collected FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; items_collected: number | string }>;
    expect(runAfter[0].status).toBe('completed');
    expect(Number(runAfter[0].items_collected)).toBe(1);

    const embRows = (await sql`
      SELECT embedding_model FROM event_embeddings WHERE event_id = ${eventId}
    `) as Array<{ embedding_model: string }>;
    expect(embRows.length).toBe(1);
    expect(embRows[0].embedding_model).toBe('test-model');
  });
});

describe('completeAuthRun feed reactivation', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each([
    { failures: 0, expectedStatus: 'active' },
    { failures: feedBackoff.pauseThreshold - 1, expectedStatus: 'active' },
    { failures: feedBackoff.pauseThreshold, expectedStatus: 'paused' },
    { failures: feedBackoff.pauseThreshold + 1, expectedStatus: 'paused' },
  ])('leaves a paused feed with $failures failures $expectedStatus after auth succeeds', async ({ failures, expectedStatus }) => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id, { connectorKey: 'github' });
    const runId = await insertRunningAuthRun(org.id, profileId);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      status: 'paused',
      visibility: 'private',
    });
    const sql = getTestDb();
    await sql`
      UPDATE connections SET auth_profile_id = ${profileId}, status = 'pending_auth'
      WHERE id = ${connection.id}
    `;
    await sql`
      UPDATE feeds
      SET status = 'paused', schedule = '*/5 * * * *', next_run_at = NULL,
          consecutive_failures = ${failures},
          first_failure_at = ${failures > 0 ? new Date('2026-01-01T00:00:00Z') : null},
          last_error = ${failures > 0 ? 'sync failed' : null}
      WHERE connection_id = ${connection.id}
    `;
    const [before] = await sql`
      SELECT status, next_run_at, consecutive_failures, first_failure_at, last_error
      FROM feeds WHERE connection_id = ${connection.id}
    `;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      credentials: { api_key: 'test-rotated-token' },
    });
    await completeAuthRun(ctx);
    expect(result()).toEqual({ body: { success: true }, status: 200 });

    const [profile] = await sql`SELECT status FROM auth_profiles WHERE id = ${profileId}`;
    const [linkedConnection] = await sql`SELECT status FROM connections WHERE id = ${connection.id}`;
    expect(profile.status).toBe('active');
    expect(linkedConnection.status).toBe('active');

    const [after] = await sql`
      SELECT status, next_run_at, consecutive_failures, first_failure_at, last_error
      FROM feeds WHERE connection_id = ${connection.id}
    `;
    expect(after.status).toBe(expectedStatus);
    if (expectedStatus === 'paused') {
      expect(after).toEqual(before);
    } else {
      expect(after.next_run_at).not.toBeNull();
      expect(after).toEqual({ ...before, status: 'active', next_run_at: after.next_run_at });
    }
  });
});

describe('completeAuthRun session-state passthrough', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('stores interactive session state verbatim — no secret refs, nothing dropped', async () => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id, {
      connectorKey: 'whatsapp',
      profileKind: 'interactive',
    });
    const runId = await insertRunningAuthRun(org.id, profileId);
    const sql = getTestDb();

    // Baileys-style session state: nested objects + a flat string field. None
    // of this is a bearer credential the execution path resolves as a ref.
    const sessionState = {
      creds: { noiseKey: { private: 'abc', public: 'def' }, registered: true },
      account_id: '15551234567',
    };

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      credentials: sessionState,
      metadata: { paired: true },
    });
    await completeAuthRun(ctx);

    expect(result().body).toEqual({ success: true });

    const profile = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;

    // Passthrough: the whole session state survives intact (nested objects
    // preserved), and no value was converted into a secret:// ref.
    expect(profile[0].status).toBe('active');
    expect(profile[0].auth_data).toEqual(sessionState);
    expect(JSON.stringify(profile[0].auth_data)).not.toContain('secret://');
    expect(parseSecretRef(String(profile[0].auth_data.account_id))).toBeNull();
  });
});
