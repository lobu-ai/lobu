import { serve } from '@hono/node-server';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { executeRun, WorkerClient } from '@lobu/connector-worker/daemon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { feedBackoff } from '../../../connectors/feed-backoff';
import { app, type Env } from '../../../index';
import { createAuthProfile, type AuthProfileKind } from '../../../utils/auth-profiles';
import { createConnectToken } from '../../../utils/connect-tokens';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, createTestSession, seedOwnerContext } from '../../setup/test-fixtures';

const KEY = 'synthetic.auth-refresh';
const WORKER = 'synthetic-auth-refresh-worker';
const TOKEN = 'synthetic-auth-refresh-worker-token';
const originalFetch = globalThis.fetch;
let server: ReturnType<typeof serve>;
let baseUrl: string;

beforeAll(async () => {
  await initWorkspaceProvider();
  const env = {
    ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL,
    WORKER_API_TOKEN: TOKEN, RATE_LIMIT_ENABLED: 'false',
    JWT_SECRET: 'test-jwt-secret-for-testing-only',
    BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  } as Env;
  server = serve({ hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false,
    fetch: (request) => app.fetch(request, env) });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => { await cleanupTestDatabase(); });
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await cleanupTestDatabase();
});

async function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(cookie ? { cookie } : { authorization: `Bearer ${TOKEN}` }) },
    body: JSON.stringify(body),
  });
}
async function seed(kind: AuthProfileKind = 'env', attach = true) {
  const owner = await seedOwnerContext();
  await createTestConnectorDefinition({ key: KEY, name: 'Synthetic auth refresh', organization_id: owner.org.id,
    auth_schema: { methods: [{ type: 'env_keys', fields: [{ key: 'API_KEY' }] }] },
    feeds_schema: { broken: {}, healthy: {}, manual: {} } });
  const profile = await createAuthProfile({ organizationId: owner.org.id, connectorKey: KEY,
    displayName: 'Synthetic profile', profileKind: kind, status: 'pending_auth',
    authData: {}, createdBy: owner.user.id });
  const connection = await createTestConnection({ organization_id: owner.org.id, connector_key: KEY,
    status: 'pending_auth', visibility: 'private', created_by: owner.user.id, createDefaultFeed: false });
  const sql = getTestDb();
  if (attach) await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connection.id}`;
  // Oldest feed is hard-paused: validation must choose the later healthy feed.
  const [broken] = await sql`INSERT INTO feeds
    (organization_id, connection_id, feed_key, status, schedule, consecutive_failures, first_failure_at, last_error)
    VALUES (${owner.org.id}, ${connection.id}, 'broken', 'paused', '*/5 * * * *',
      ${feedBackoff.pauseThreshold}, NOW() - INTERVAL '1 day', 'synthetic sync failure') RETURNING id`;
  const [healthy] = await sql`INSERT INTO feeds
    (organization_id, connection_id, feed_key, status, schedule)
    VALUES (${owner.org.id}, ${connection.id}, 'healthy', 'paused', '*/5 * * * *') RETURNING id`;
  const [manual] = await sql`INSERT INTO feeds
    (organization_id, connection_id, feed_key, status, schedule)
    VALUES (${owner.org.id}, ${connection.id}, 'manual', 'paused', NULL) RETURNING id`;
  const token = await createConnectToken({ organizationId: owner.org.id, connectorKey: KEY,
    connectionId: connection.id, authProfileId: profile.id, authType: 'env_keys', createdBy: owner.user.id });
  return { ...owner, connection, profile, token: token.token,
    broken: Number(broken.id), healthy: Number(healthy.id), manual: Number(manual.id) };
}
async function feed(id: number) {
  const [row] = await getTestDb()`SELECT status, next_run_at, consecutive_failures, first_failure_at, last_error
    FROM feeds WHERE id = ${id}`;
  return row;
}
async function runningRun(s: Awaited<ReturnType<typeof seed>>, runType = 'sync') {
  const [row] = await getTestDb()`INSERT INTO runs
    (organization_id, connection_id, feed_id, auth_profile_id, connector_key, connector_version,
      run_type, status, claimed_by, claimed_at)
    VALUES (${s.org.id}, ${s.connection.id}, ${runType === 'sync' ? s.healthy : null},
      ${s.profile.id}, ${KEY}, '1.0.0', ${runType}, 'running', ${WORKER}, NOW()) RETURNING id`;
  return Number(row.id);
}

describe('auth refresh preserves failure pauses over HTTP', () => {
  it('validates an eligible feed, executes its connector in an isolate, and preserves failed siblings', async () => {
    const s = await seed();
    const sql = getTestDb();
    const code = await createIsolateConnectorCompiler().compileConnectorForIsolateFromSource(`
      import { ConnectorRuntime } from '@lobu/connector-sdk';
      export default class SyntheticConnector extends ConnectorRuntime {
        definition = {
          key: '${KEY}', name: 'Synthetic auth refresh', version: '1.0.0',
          feeds: { healthy: { sync: async ctx => {
            await ctx.commit([{
              origin_id: 'synthetic-auth-refresh-event', origin_type: 'synthetic',
              title: 'Collected after auth recovery', payload_text: 'Synthetic E2E event',
              occurred_at: '2026-01-01T00:00:00.000Z',
            }], { cursor: 'synthetic-after-refresh' });
            return { status: 'complete' };
          } } },
        };
      }
    `);
    await sql`UPDATE connector_versions SET compiled_code = ${code} WHERE connector_key = ${KEY}`;
    const before = await feed(s.broken);
    const validation = await post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-key' } });
    const queued = await validation.json();
    expect(validation.status, JSON.stringify(queued)).toBe(200);
    expect(Number(queued.feed_id)).toBe(s.healthy);
    expect(await feed(s.broken)).toEqual(before);
    expect((await feed(s.manual)).next_run_at).toBeNull();

    // Use the production worker client and executor: claim, isolate execution,
    // event/checkpoint streaming, and completion all cross the HTTP listener.
    const client = new WorkerClient({ apiUrl: baseUrl, workerId: WORKER, authToken: TOKEN, capabilities: {} });
    const claimed = await client.poll(1);
    expect(Number(claimed.run_id)).toBe(Number(queued.run_id));
    const result = await executeRun(client, claimed, {}, {
      generateEmbeddings: false, timeoutMs: 10000,
    });
    expect(result).toEqual({ itemsCollected: 1 });
    expect(await sql`SELECT status, items_collected FROM runs WHERE id = ${queued.run_id}`)
      .toEqual([{ status: 'completed', items_collected: 1 }]);
    expect(await sql`SELECT origin_id, title FROM events WHERE connection_id = ${s.connection.id}`)
      .toEqual([{ origin_id: 'synthetic-auth-refresh-event', title: 'Collected after auth recovery' }]);
    const [synced] = await sql`SELECT checkpoint FROM feeds WHERE id = ${s.healthy}`;
    expect(synced.checkpoint).toMatchObject({ cursor: 'synthetic-after-refresh' });
    const connected = await post(`/connect/${s.token}/complete`, {});
    expect(connected.status, await connected.text()).toBe(200);
    expect(await feed(s.broken)).toEqual(before);
  });

  it('connect completion preserves a failure pause independently of validation', async () => {
    const s = await seed();
    const sql = getTestDb();
    await sql`UPDATE auth_profiles SET auth_data = ${sql.json({ API_KEY: 'synthetic' })} WHERE id = ${s.profile.id}`;
    const runId = await runningRun(s);
    await sql`UPDATE runs SET status = 'completed', completed_at = NOW() WHERE id = ${runId}`;
    const before = await feed(s.broken);
    const response = await post(`/connect/${s.token}/complete`, {});
    expect(response.status, await response.text()).toBe(200);
    expect(await feed(s.broken)).toEqual(before);
  });

  it('rejects validation with no eligible feed until an explicit human feed resume', async () => {
    const s = await seed();
    const sql = getTestDb();
    await sql`UPDATE feeds SET consecutive_failures = ${feedBackoff.pauseThreshold},
      first_failure_at = NOW() - INTERVAL '1 day', last_error = 'synthetic sync failure'
      WHERE connection_id = ${s.connection.id}`;
    const before = await feed(s.broken);
    const response = await post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-key' } });
    expect(response.status, await response.text()).toBe(409);
    expect(await feed(s.broken)).toEqual(before);
    expect(await sql`SELECT id FROM runs WHERE connection_id = ${s.connection.id}`).toHaveLength(0);
    const [profile] = await sql`SELECT auth_data FROM auth_profiles WHERE id = ${s.profile.id}`;
    expect(profile.auth_data).toEqual({});

    const session = await createTestSession(s.user.id);
    const resumed = await post(`/api/${s.org.slug}/manage_feeds`, {
      action: 'update_feed', feed_id: s.broken, status: 'active',
    }, session.cookieHeader);
    expect(resumed.status, await resumed.text()).toBe(200);
    expect(await feed(s.broken)).toMatchObject({ status: 'active', consecutive_failures: 0, first_failure_at: null });
    const retry = await post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-key' } });
    expect(retry.status, await retry.text()).toBe(200);
  });

  it('browser-session recovery and fresh auth completion keep the failure pause', async () => {
    const s = await seed('browser_session');
    const before = await feed(s.broken);
    const credentials = { cookies: [{ name: 'session_token', value: 'synthetic', expires: 4_102_444_800 }] };
    const response = await post('/api/workers/complete', { run_id: await runningRun(s), worker_id: WORKER,
      status: 'success', items_collected: 0, auth_update: credentials });
    expect(response.status, await response.text()).toBe(200);
    expect(await feed(s.broken)).toEqual(before);
    expect((await feed(s.healthy)).status).toBe('active');
    expect((await feed(s.manual)).next_run_at).toBeNull();
    const auth = await post('/api/workers/complete-auth', { run_id: await runningRun(s, 'auth'),
      worker_id: WORKER, status: 'success', credentials });
    expect(auth.status, await auth.text()).toBe(200);
    expect(await feed(s.broken)).toEqual(before);
  });

  it('rolls back credential rotation when validation already has an active run', async () => {
    const s = await seed();
    const sql = getTestDb();
    const initial = await post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-original' } });
    expect(initial.status, await initial.text()).toBe(200);
    const profiles = await sql`SELECT auth_data, status, updated_at FROM auth_profiles WHERE id = ${s.profile.id}`;
    const connections = await sql`SELECT status, updated_at FROM connections WHERE id = ${s.connection.id}`;
    const secrets = await sql`SELECT name, ciphertext FROM agent_secrets WHERE organization_id = ${s.org.id} ORDER BY name`;
    expect(secrets).toHaveLength(1);
    const runs = await sql`SELECT id FROM runs WHERE connection_id = ${s.connection.id}`;
    const before = await feed(s.healthy);

    const response = await post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-rotated' } });
    expect(response.status, await response.text()).toBe(409);
    expect(await sql`SELECT auth_data, status, updated_at FROM auth_profiles WHERE id = ${s.profile.id}`).toEqual(profiles);
    expect(await sql`SELECT status, updated_at FROM connections WHERE id = ${s.connection.id}`).toEqual(connections);
    expect(await sql`SELECT name, ciphertext FROM agent_secrets WHERE organization_id = ${s.org.id} ORDER BY name`).toEqual(secrets);
    expect(await sql`SELECT id FROM runs WHERE connection_id = ${s.connection.id}`).toEqual(runs);
    expect(await feed(s.healthy)).toEqual(before);
  });

  it.each(['uninstalled', 'unrunnable'])('reports an %s connector without claiming rolled-back feed retirement', async reason => {
    const s = await seed();
    const sql = getTestDb();
    if (reason === 'uninstalled') {
      await sql`DELETE FROM connector_definitions WHERE organization_id = ${s.org.id} AND key = ${KEY}`;
    } else {
      await sql`UPDATE connector_versions SET compiled_code = NULL WHERE connector_key = ${KEY}`;
    }
    const response = await post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-key' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: reason === 'uninstalled'
      ? 'The connector is no longer installed in this workspace.'
      : 'The connector version has no runnable code.' });
    expect(await sql`SELECT deleted_at FROM feeds WHERE id = ${s.healthy}`).toEqual([{ deleted_at: null }]);
    expect(await sql`SELECT id FROM runs WHERE connection_id = ${s.connection.id}`).toHaveLength(0);
    expect(await sql`SELECT name FROM agent_secrets WHERE organization_id = ${s.org.id}`).toHaveLength(0);
  });

  it('rechecks a concurrent failure pause before committing validation', async () => {
    const s = await seed();
    const sql = getTestDb();
    let pending: Promise<Response> | undefined;
    try {
      await sql.begin(async tx => {
        // The HTTP request sees the previously eligible row until it takes
        // its lock. Committing this failure must make its recheck reject.
        await tx`UPDATE feeds SET consecutive_failures = ${feedBackoff.pauseThreshold},
          first_failure_at = NOW(), last_error = 'concurrent failure'
          WHERE id = ${s.healthy}`;
        pending = post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-key' } });
        for (let attempt = 0; attempt < 100; attempt++) {
          const blocked = await sql`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%UPDATE feeds f%next_run_at%'`;
          if (blocked.length > 0) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('Validation did not wait for the feed lock');
      });
      const response = await pending!;
      expect(response.status, await response.text()).toBe(409);
      expect((await feed(s.healthy)).status).toBe('paused');
      expect(await sql`SELECT id FROM runs WHERE connection_id = ${s.connection.id}`).toHaveLength(0);
      const [profile] = await sql`SELECT auth_data FROM auth_profiles WHERE id = ${s.profile.id}`;
      expect(profile.auth_data).toEqual({});
    } finally {
      await pending;
    }
  });

  it.each([true, false])('validation and a concurrent trigger finish without deadlocking (dry_run=%s)', async dryRun => {
    const s = await seed();
    const sql = getTestDb();
    const session = await createTestSession(s.user.id);
    if (!dryRun) await sql`UPDATE feeds SET status = 'active' WHERE id = ${s.healthy}`;
    const before = await feed(s.broken);
    let validation: Promise<Response> | undefined;
    let trigger: Promise<Response> | undefined;
    let triggerFinished = false;
    try {
      await sql.begin(async tx => {
        // Hold recovery at a sibling while a competing enqueue reaches the DB.
        await tx`SELECT id FROM feeds WHERE id = ${s.manual} FOR UPDATE`;
        validation = post(`/connect/${s.token}/validate`, { credentials: { API_KEY: 'synthetic-key' } });
        await expect.poll(async () => {
          const rows = await sql`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%UPDATE feeds f%status = ''active''%'`;
          return rows.length;
        }, { timeout: 5000, interval: 20 }).toBeGreaterThan(0);
        trigger = post(`/api/${s.org.slug}/manage_feeds`, {
          action: 'trigger_feed', feed_id: s.healthy, dry_run: dryRun,
        }, session.cookieHeader).then(response => { triggerFinished = true; return response; });
        await expect.poll(async () => {
          if (triggerFinished) return true;
          const rows = await sql`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%INSERT INTO runs%'`;
          return rows.length > 0;
        }, { timeout: 5000, interval: 20 }).toBe(true);
      });
      const [validated, triggered] = await Promise.all([validation!, trigger!]);
      const triggerBody = await triggered.json();
      expect(triggered.status, JSON.stringify(triggerBody)).toBe(200);
      const validationBody = await validated.json();
      expect([200, 409], JSON.stringify(validationBody)).toContain(validated.status);
      if (validated.status === 200) {
        expect(triggerBody).toMatchObject({ triggered: false, reason: 'already_active' });
      } else {
        expect(triggerBody).toMatchObject({ triggered: true, ...(dryRun ? { dry_run: true } : {}) });
      }
      expect(await feed(s.broken)).toEqual(before);
      expect(await sql`SELECT dry_run FROM runs WHERE feed_id = ${s.healthy}`)
        .toEqual([{ dry_run: triggerBody.triggered && dryRun }]);
    } finally {
      await Promise.allSettled([validation, trigger]);
    }
  });

  it('a fresh OAuth callback activates the connection without resuming its failure-paused feed', async () => {
    const s = await seed('env', false);
    const sql = getTestDb();
    const appProfile = await createAuthProfile({ organizationId: s.org.id, connectorKey: KEY,
      displayName: 'Synthetic OAuth app', profileKind: 'oauth_app', provider: 'synthetic',
      authData: { client_id: 'synthetic-client', client_secret: 'synthetic-secret' },
      status: 'active', createdBy: s.user.id });
    const token = await createConnectToken({ organizationId: s.org.id, connectorKey: KEY,
      connectionId: s.connection.id, authType: 'oauth', createdBy: s.user.id,
      authConfig: { provider: 'synthetic', appAuthProfileId: appProfile.id,
        clientIdKey: 'client_id', clientSecretKey: 'client_secret', requestedScopes: [],
        tokenUrl: 'https://provider.example/token', userinfoUrl: 'https://provider.example/userinfo',
        pendingProfileMeta: { displayName: 'Synthetic account', slug: 'synthetic-account', connectorKey: KEY, provider: 'synthetic' } } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-account', email: 'synthetic@example.com' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const before = await feed(s.broken);
    const response = await fetch(`${baseUrl}/connect/oauth/callback?state=${token.token}&code=synthetic-code`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const [connection] = await sql`SELECT status, auth_profile_id FROM connections WHERE id = ${s.connection.id}`;
    expect(connection.status, response.headers.get('location') ?? '').toBe('active');
    expect(connection.auth_profile_id).not.toBeNull();
    expect(await feed(s.broken)).toEqual(before);
    expect((await feed(s.healthy)).status).toBe('active');
    expect((await feed(s.manual)).next_run_at).toBeNull();
  });
});
