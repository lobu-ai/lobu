/**
 * completeAuthRun claimant-guard reproducer.
 *
 * Bug: completeAuthRun finalized an auth run with a bare `WHERE id = run_id`
 * UPDATE and never called authorizeRunForWorker. So any worker (a leaked
 * WORKER_API_TOKEN, or a slow worker reporting after a gateway reap) could
 * finalize an ARBITRARY auth run by id — flipping it terminal AND injecting
 * attacker-supplied credentials into the linked auth_profiles row (then
 * reactivating the linked connections/feeds).
 *
 * The fix mirrors the sibling /complete endpoints: an authorizeRunForWorker
 * gate plus `AND status = 'running' AND claimed_by = worker_id` on both
 * terminal UPDATEs, so a non-claimant's update matches 0 rows and the
 * credential write is skipped (authProfileId stays null).
 *
 * Red (pre-fix): a worker that is NOT the claimant writes credentials and
 * activates the profile. Green (post-fix): the profile is untouched and the
 * run stays 'running'; the real claimant can still complete it normally.
 *
 * Drives the REAL exported completeAuthRun handler against the embedded DB
 * via a minimal Hono Context (same approach as
 * complete-worker-job-status-guard.test.ts). The mock context has no
 * workerAuthMode, so authorizeRunForWorker is a no-op — isolating the
 * claimant guard on completeAuthRun's own UPDATE, exactly as a token-auth
 * (non-'user') cloud worker would hit it in production.
 */

import { parseSecretRef } from '@lobu/core';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { feedBackoff } from '../../connectors/feed-backoff';
import type { Env } from '../../index';
import { resolveAuthCredentials } from '../../utils/auth-credential-secrets';
import { completeAuthRun } from '../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestOrganization } from '../setup/test-fixtures';

const CLAIMANT = 'worker-legit';
const ATTACKER = 'worker-attacker';

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

async function insertAuthProfile(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO auth_profiles
      (organization_id, slug, display_name, connector_key, profile_kind,
       status, auth_data, metadata, created_at, updated_at)
    VALUES
      (${organizationId}, 'gh-auth-guard', 'GitHub', 'github', 'oauth_account',
       'pending_auth', '{}'::jsonb, '{}'::jsonb, NOW(), NOW())
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
      (${organizationId}, 'auth', 'running', ${CLAIMANT}, NOW(),
       ${authProfileId}, NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

describe('completeAuthRun claimant guard', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does NOT let a non-claimant worker finalize the run or inject credentials', async () => {
    const org = await createTestOrganization();
    const profileId = await insertAuthProfile(org.id);
    const runId = await insertRunningAuthRun(org.id, profileId);
    const sql = getTestDb();

    const { ctx } = mockWorkerCtx({
      run_id: runId,
      worker_id: ATTACKER,
      status: 'success',
      credentials: { api_key: 'stolen-token' },
      metadata: { injected: true },
    });
    await completeAuthRun(ctx);

    // Profile must be untouched — no stolen credentials, still pending.
    const profile = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profile[0].status).toBe('pending_auth');
    expect(profile[0].auth_data).toEqual({});

    // Run is NOT finalized by a non-claimant.
    const run = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(run[0].status).toBe('running');
  });

  it('lets the real claimant complete the run and write credentials (happy path)', async () => {
    const org = await createTestOrganization();
    const profileId = await insertAuthProfile(org.id);
    const runId = await insertRunningAuthRun(org.id, profileId);
    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: CLAIMANT,
      status: 'success',
      credentials: { api_key: 'real-token' },
      metadata: { ok: true },
    });
    await completeAuthRun(ctx);

    expect(result().body).toEqual({ success: true });

    const profile = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profile[0].status).toBe('active');
    // Credentials persist as encrypted secret:// refs, never plaintext, and
    // resolve back to the real value at connect time.
    expect(JSON.stringify(profile[0].auth_data)).not.toContain('real-token');
    expect(parseSecretRef(String(profile[0].auth_data.api_key))?.scheme).toBe(
      'secret'
    );
    const resolved = await resolveAuthCredentials({
      organizationId: org.id,
      authProfileId: profileId,
      authData: profile[0].auth_data,
    });
    expect(resolved).toEqual({ api_key: 'real-token' });

    const run = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(run[0].status).toBe('completed');
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
    const profileId = await insertAuthProfile(org.id);
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
      worker_id: CLAIMANT,
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
