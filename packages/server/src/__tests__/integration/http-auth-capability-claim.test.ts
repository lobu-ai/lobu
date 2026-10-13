import { CONNECTOR_HTTP_AUTH_CAPABILITY } from '@lobu/core/contracts/worker/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../index';
import { materializeDueFeeds, type DueFeedClaimContext } from '../../scheduled/check-due-feeds';
import * as executionContext from '../../utils/execution-context';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, seedOwnerContext } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

async function seedConnection(bound: boolean, due = false) {
  const sql = getTestDb();
  const { org, user } = await seedOwnerContext();
  const connectorKey = 'test.http-auth';
  await createTestConnectorDefinition({
    key: connectorKey, name: 'HTTP Fixture', organization_id: org.id,
  });
  const connection = await createTestConnection({
    organization_id: org.id, connector_key: connectorKey, created_by: user.id,
  });
  const [profile] = await sql`
    INSERT INTO auth_profiles (
      organization_id, connector_key, slug, display_name, profile_kind,
      status, metadata, created_by
    ) VALUES (
      ${org.id}, ${connectorKey}, 'http-fixture', 'HTTP Fixture', 'env',
      'active', ${sql.json(bound ? { http: {} } : {})}, ${user.id}
    ) RETURNING id
  `;
  await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connection.id}`;
  if (due) {
    await sql`
      UPDATE feeds SET schedule = '* * * * *', next_run_at = NOW() - INTERVAL '5 minutes'
      WHERE connection_id = ${connection.id}
    `;
  }
  return { orgId: org.id, connectionId: connection.id, connectorKey };
}

async function seedPendingRun(bound: boolean) {
  const seeded = await seedConnection(bound);
  const sql = getTestDb();
  const [run] = await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, connector_version,
      approval_status, status, created_at
    ) VALUES (
      ${seeded.orgId}, 'sync', ${seeded.connectionId}, ${seeded.connectorKey}, '1.0.0',
      'auto', 'pending', NOW()
    ) RETURNING id
  `;
  return { ...seeded, runId: Number(run.id) };
}

function poll(supportsHttpAuth: boolean) {
  return post('/api/workers/poll', {
    body: { worker_id: 'http-claim-worker', capabilities: { [CONNECTOR_HTTP_AUTH_CAPABILITY]: supportsHttpAuth } },
    token: 'http-claim-token', env: { WORKER_API_TOKEN: 'http-claim-token' },
  });
}

function fleetContext(supportsHttpAuth: boolean): DueFeedClaimContext {
  return {
    isUserScopedWorker: false, deviceWorkerId: null, workerPlatform: null,
    authorizedCapabilities: [], capabilityMatchSet: [''],
    manifestClaimAuthorizations: [], allowLegacyManifestCapabilityClaims: false,
    orgScopeIds: [''], baseOrgScopeIds: [''], workerHardensDbEgress: true,
    workerSupportsHttpAuth: supportsHttpAuth, backendCapacity: { compiled_connector: 1 },
  };
}

describe('gateway HTTP authentication capability negotiation', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    vi.spyOn(executionContext, 'resolveExecutionAuth').mockResolvedValue({
      credentials: null, connectionCredentials: { PUBLIC_URL: 'https://service.example.test' },
      sessionState: null, httpAuth: true,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps an HTTP-bound run pending for an older fleet worker', async () => {
    const { runId } = await seedPendingRun(true);
    const response = await poll(false);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run_id).toBeUndefined();
    expect(body.skipped_run_id).toBeUndefined();
    const [run] = await getTestDb()`SELECT status, claimed_by FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({ status: 'pending', claimed_by: null });
    expect(executionContext.resolveExecutionAuth).not.toHaveBeenCalled();
  });

  it('delivers only public fields and the HTTP marker to a capable fleet worker', async () => {
    const { runId } = await seedPendingRun(true);
    const response = await poll(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run_id: runId, http_auth: true, credentials: null,
      connection_credentials: { PUBLIC_URL: 'https://service.example.test' },
    });
  });

  it('still delivers an ordinary env connection to an older worker', async () => {
    vi.mocked(executionContext.resolveExecutionAuth).mockResolvedValue({
      credentials: null, connectionCredentials: { PUBLIC_URL: 'https://service.example.test' }, sessionState: null,
    });
    const { runId } = await seedPendingRun(false);
    expect(await (await poll(false)).json()).toMatchObject({ run_id: runId });
  });

  it('rechecks a binding introduced after claim selection before serializing credentials', async () => {
    // The SQL sees no binding; auth resolution observes the newly attached one.
    const { runId } = await seedPendingRun(false);
    const body = await (await poll(false)).json();
    expect(body.skipped_run_id).toBe(runId);
    expect(body.run_id).toBeUndefined();
    expect(body.connection_credentials).toBeUndefined();
    expect(body.http_auth).toBeUndefined();
    const [run] = await getTestDb()`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe('failed');
  });

  it('uses the same capability gate before materializing a scheduled feed', async () => {
    await seedConnection(true, true);
    const sql = getTestDb();
    const oldWorker = await materializeDueFeeds({} as Env, sql, { claimContext: fleetContext(false) });
    expect(oldWorker.runsCreated).toBe(0);
    const newWorker = await materializeDueFeeds({} as Env, sql, { claimContext: fleetContext(true) });
    expect(newWorker.runsCreated).toBe(1);
  });

  it('fails closed when a direct scheduling context omits the capability', async () => {
    await seedConnection(true, true);
    const context = fleetContext(false);
    Reflect.deleteProperty(context, 'workerSupportsHttpAuth');
    expect((await materializeDueFeeds({} as Env, getTestDb(), { claimContext: context })).runsCreated).toBe(0);
  });

  it('withholds HTTP-bound feeds from device lanes even when the flag is advertised', async () => {
    const { orgId, connectionId } = await seedConnection(true, true);
    const sql = getTestDb();
    await sql`
      UPDATE connector_definitions SET required_capability = 'os.shell'
      WHERE organization_id = ${orgId} AND key = 'test.http-auth'
    `;
    const context = {
      ...fleetContext(true), isUserScopedWorker: true,
      authorizedCapabilities: ['os.shell'], capabilityMatchSet: ['os.shell'],
      orgScopeIds: [orgId], baseOrgScopeIds: [orgId],
    };
    expect((await materializeDueFeeds({} as Env, sql, { claimContext: context })).runsCreated).toBe(0);
    const [count] = await sql`SELECT count(*)::int AS count FROM runs WHERE connection_id = ${connectionId}`;
    expect(count.count).toBe(0);
  });
});
