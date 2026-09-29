import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as httpAuth from '../../utils/http-auth';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestAccessToken, createTestConnection, createTestOAuthClient, seedOwnerContext } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const workerId = 'http-fixture-worker';
const fleetToken = 'http-fixture-fleet-token';
const request = { url: 'https://service.example.test/items', method: 'GET', headers: {} };
const result = { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: 'b2s=' };

async function seedRun(overrides: {
  runType?: string;
  status?: string;
  approvalStatus?: string;
  claimant?: string;
  stale?: boolean;
  deleted?: boolean;
  paused?: boolean;
  mismatchedOrg?: boolean;
} = {}) {
  const sql = getTestDb();
  const { org, user } = await seedOwnerContext();
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: 'test.http-fetch',
    created_by: user.id,
    createDefaultFeed: false,
  });
  if (overrides.deleted) {
    await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${connection.id}`;
  }
  if (overrides.paused) {
    await sql`UPDATE connections SET status = 'paused' WHERE id = ${connection.id}`;
  }
  const runOrg = overrides.mismatchedOrg ? (await seedOwnerContext()).org.id : org.id;
  const [run] = await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, status,
      approval_status, claimed_by, claimed_at, last_heartbeat_at, created_at
    ) VALUES (
      ${runOrg}, ${overrides.runType ?? 'sync'}, ${connection.id}, 'test.http-fetch',
      ${overrides.status ?? 'running'}, ${overrides.approvalStatus ?? 'auto'},
      ${overrides.claimant ?? workerId}, NOW(),
      NOW() - make_interval(secs => ${overrides.stale ? 3600 : 0}), NOW()
    ) RETURNING id
  `;
  return { runId: Number(run.id), connectionId: connection.id, orgId: org.id };
}

function fetchForRun(runId: number, extra: Record<string, unknown> = {}) {
  return post('/api/workers/http-fetch', {
    body: { worker_id: workerId, run_id: runId, request, ...extra },
    token: fleetToken,
    env: { WORKER_API_TOKEN: fleetToken },
  });
}

describe('gateway HTTP worker route', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    vi.spyOn(httpAuth, 'fetchConnectionHttp').mockResolvedValue(result);
  });
  afterEach(() => vi.restoreAllMocks());

  it('requires worker authentication before accessing the live run', async () => {
    const { runId } = await seedRun();
    const response = await post('/api/workers/http-fetch', {
      body: { worker_id: workerId, run_id: runId, request },
      env: { WORKER_API_TOKEN: fleetToken },
    });
    expect(response.status).toBe(401);
    expect(httpAuth.fetchConnectionHttp).not.toHaveBeenCalled();
  });

  it('rejects a valid user worker token at the middleware boundary', async () => {
    const { org, user } = await seedOwnerContext();
    const client = await createTestOAuthClient();
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'device_worker:run',
    });
    const response = await post('/api/workers/http-fetch', {
      body: { worker_id: workerId, run_id: 1, request },
      token, env: { WORKER_API_TOKEN: fleetToken },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Endpoint not available to user-scoped workers' });
    expect(httpAuth.fetchConnectionHttp).not.toHaveBeenCalled();
  });

  it.each(['sync', 'action'])('spends a live admitted %s run using its stored connection', async (runType) => {
    const { runId, connectionId, orgId } = await seedRun({ runType, approvalStatus: 'approved' });
    const response = await fetchForRun(runId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(httpAuth.fetchConnectionHttp).toHaveBeenCalledWith({
      organizationId: orgId,
      connectionId,
      request,
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    { status: 'pending' },
    { status: 'completed' },
    { status: 'cancelled' },
    { claimant: 'another-worker' },
    { stale: true },
    { approvalStatus: 'pending' },
    { approvalStatus: 'rejected' },
    { runType: 'auth' },
    { runType: 'automation' },
    { deleted: true },
    { paused: true },
    { mismatchedOrg: true },
  ])('refuses a run outside its live authorization: %j', async (overrides) => {
    const { runId } = await seedRun(overrides);
    const response = await fetchForRun(runId);
    expect(response.status).toBe(409);
    expect(httpAuth.fetchConnectionHttp).not.toHaveBeenCalled();
  });

  it('rejects caller-selected connection identity', async () => {
    const { runId } = await seedRun();
    expect((await fetchForRun(runId, { connection_id: 999 })).status).toBe(400);
    expect(httpAuth.fetchConnectionHttp).not.toHaveBeenCalled();
  });

  it('does not expose upstream diagnostics on failure', async () => {
    const { runId } = await seedRun();
    vi.mocked(httpAuth.fetchConnectionHttp).mockRejectedValue(new Error('secret-fixture-value'));
    const response = await fetchForRun(runId);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Gateway HTTP request failed' });
  });
});
