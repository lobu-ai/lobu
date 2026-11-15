import { CONNECTOR_HTTP_AUTH_CAPABILITY } from '@lobu/core/contracts/worker/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../index';
import { materializeDueFeeds, type DueFeedClaimContext } from '../../scheduled/check-due-feeds';
import * as executionContext from '../../utils/execution-context';
import { persistAuthCredentials } from '../../utils/auth-credential-secrets';
import { createAuthProfile } from '../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, createTestPAT, seedOwnerContext } from '../setup/test-fixtures';
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
      credentials: null, connectionCredentials: {},
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
    const body = await response.json();
    expect(body).toMatchObject({
      run_id: runId, http_auth: true, credentials: null,
    });
    expect(body.connection_credentials).toBeUndefined();
  });

  it('still delivers public connection config to an older worker', async () => {
    vi.mocked(executionContext.resolveExecutionAuth).mockResolvedValue({
      credentials: null, connectionCredentials: {}, sessionState: null,
    });
    const { runId, connectionId } = await seedPendingRun(false);
    await getTestDb()`UPDATE connections SET config = ${getTestDb().json({ PUBLIC_URL: 'https://service.example.test' })}
      WHERE id = ${connectionId}`;
    expect(await (await poll(false)).json()).toMatchObject({ run_id: runId, config: { PUBLIC_URL: 'https://service.example.test' } });
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

describe('fleet credential delivery boundary', () => {
  beforeEach(async () => { await cleanupTestDatabase(); });

  it.each(['sync', 'action'] as const)('dispatches an OAuth %s token while retaining app credentials gateway-side', async (runType) => {
    const seeded = await seedPendingRun(false);
    const sql = getTestDb();
    const [connection] = await sql`SELECT created_by, auth_profile_id FROM connections WHERE id = ${seeded.connectionId}`;
    const appCredentials = { SYNTHETIC_CLIENT_ID: 'synthetic-oauth-client', SYNTHETIC_CLIENT_SECRET: 'synthetic-oauth-secret' };
    await sql`UPDATE connector_definitions SET auth_schema = ${sql.json({ methods: [{
      type: 'oauth', provider: 'synthetic', clientIdKey: 'SYNTHETIC_CLIENT_ID', clientSecretKey: 'SYNTHETIC_CLIENT_SECRET',
      tokenUrl: 'https://provider.example.test/token',
    }] })}, actions_schema = ${sql.json({ inspect: { name: 'Inspect', kind: 'read' } })}
      WHERE organization_id = ${seeded.orgId} AND key = ${seeded.connectorKey}`;
    const app = await createAuthProfile({
      organizationId: seeded.orgId, connectorKey: seeded.connectorKey, displayName: 'Synthetic OAuth app',
      profileKind: 'oauth_app', provider: 'synthetic', authData: appCredentials,
      status: 'active', createdBy: connection.created_by,
    });
    const accountId = `synthetic-oauth-account-${seeded.orgId}`;
    await sql`INSERT INTO account (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "accessTokenExpiresAt", "createdAt", "updatedAt")
      VALUES (${accountId}, ${accountId}, 'synthetic', ${connection.created_by}, 'synthetic-oauth-access', 'synthetic-oauth-refresh',
        NOW() + INTERVAL '1 hour', NOW(), NOW())`;
    await sql`UPDATE auth_profiles SET profile_kind = 'oauth_account', provider = 'synthetic', account_id = ${accountId},
      auth_data = ${sql.json({ app_auth_profile_id: app.id })} WHERE id = ${connection.auth_profile_id}`;
    await sql`UPDATE connections SET app_auth_profile_id = ${app.id}, account_id = ${accountId} WHERE id = ${seeded.connectionId}`;
    const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${seeded.connectionId} LIMIT 1`;
    await sql`UPDATE runs SET run_type = ${runType}, feed_id = ${runType === 'sync' ? feed.id : null},
      action_key = ${runType === 'action' ? 'inspect' : null},
      policy_principal_kind = 'user', policy_principal_id = ${connection.created_by}, created_by_user_id = ${connection.created_by}
      WHERE id = ${seeded.runId}`;
    if (runType === 'action') {
      const [policy] = await sql`INSERT INTO write_approval_policies (organization_id, resource_class, connector_key)
        VALUES (${seeded.orgId}, 'connector_action', ${seeded.connectorKey}) RETURNING id`;
      await sql`INSERT INTO write_policy_action_effects (policy_id, action, effect) VALUES (${policy.id}, 'execute', 'auto')`;
    }

    const response = await poll(true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ run_id: seeded.runId, run_type: runType,
      credentials: { provider: 'synthetic', accessToken: 'synthetic-oauth-access' } });
    expect(body.connection_credentials).toBeUndefined();
    expect(body.previous_credentials).toBeUndefined();
    const serialized = JSON.stringify(body);
    for (const secret of [...Object.values(appCredentials), 'synthetic-oauth-refresh']) {
      expect(serialized.includes(secret)).toBe(false);
    }
    const [storedApp] = await sql`SELECT auth_data FROM auth_profiles WHERE id = ${app.id}`;
    expect(storedApp.auth_data).toEqual(appCredentials);
    const [storedFeed] = await sql`SELECT consecutive_failures FROM feeds WHERE id = ${feed.id}`;
    expect(storedFeed.consecutive_failures).toBe(0);
  });

  async function credentialRun(kind: 'env' | 'browser_session' | 'interactive', previousOnly = false, legacy = false) {
    const seeded = await seedPendingRun(false);
    const sql = getTestDb();
    const [profile] = await sql`SELECT auth_profile_id AS id FROM connections WHERE id = ${seeded.connectionId}`;
    const sentinel = 'synthetic-durable-credential';
    const state = kind === 'env' ? { DATABASE_URL: sentinel }
      : kind === 'browser_session' ? { mode: 'cookies', cookies: [{ name: 'session', value: sentinel }] }
      : { creds: { token: sentinel } };
    await sql`UPDATE auth_profiles SET profile_kind = ${kind}, auth_data = ${sql.json(state)} WHERE id = ${profile.id}`;
    if (kind === 'env' && !legacy) {
      await persistAuthCredentials({ organizationId: seeded.orgId, authProfileId: profile.id, credentials: state });
    }
    if (previousOnly) {
      await sql`UPDATE connections SET auth_profile_id = NULL WHERE id = ${seeded.connectionId}`;
      await sql`UPDATE runs SET run_type = 'auth', auth_profile_id = ${profile.id} WHERE id = ${seeded.runId}`;
    }
    return { ...seeded, sentinel };
  }

  it.each([
    { kind: 'env' as const, previousOnly: false, legacy: false },
    { kind: 'env' as const, previousOnly: false, legacy: true },
    { kind: 'browser_session' as const, previousOnly: false, legacy: false },
    { kind: 'interactive' as const, previousOnly: false, legacy: false },
    { kind: 'env' as const, previousOnly: true, legacy: false },
  ])('refuses $kind credentials before fleet serialization (previous=$previousOnly, legacy=$legacy)', async ({ kind, previousOnly, legacy }) => {
    const seeded = await credentialRun(kind, previousOnly, legacy);
    const response = await poll(true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body).includes(seeded.sentinel)).toBe(false);
    expect(body).toMatchObject({ skipped_run_id: seeded.runId, error: expect.any(String) });
    for (const field of ['run_id', 'connection_credentials', 'session_state', 'previous_credentials']) {
      expect(body[field]).toBeUndefined();
    }
    const [run] = await getTestDb()`SELECT status FROM runs WHERE id = ${seeded.runId}`;
    expect(run.status).toBe('failed');
  });

  it('preserves resolved credentials for the explicitly pinned owner device', async () => {
    const seeded = await credentialRun('env');
    const sql = getTestDb();
    const [connection] = await sql`SELECT created_by FROM connections WHERE id = ${seeded.connectionId}`;
    const workerId = 'synthetic-pinned-credential-device';
    const [device] = await sql`INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${connection.created_by}, ${workerId}, 'macos', ${sql.json([])}, ${seeded.orgId}) RETURNING id`;
    await sql`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${seeded.connectionId}`;
    const pat = await createTestPAT(connection.created_by, seeded.orgId, { scope: 'device_worker:run' });
    const response = await post('/api/workers/poll', {
      token: pat.token, body: { worker_id: workerId, platform: 'macos', capabilities: {} },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run_id).toBe(seeded.runId);
    expect(body.connection_credentials?.DATABASE_URL === seeded.sentinel).toBe(true);
  });
});
