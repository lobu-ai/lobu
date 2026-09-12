import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectRoutes } from '../../../connect/routes';
import type { Env } from '../../../index';
import { buildConnectionsNamespace } from '../../../sandbox/namespaces/connections';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { createAuthProfile, updateAuthProfile } from '../../../utils/auth-profiles';
import { expireStaleConnectTokens } from '../../../utils/connect-tokens';
import { syncOAuthConnectionsForAuthProfile } from '../../../utils/oauth-connection-state';
import { generateCodeChallenge } from '../../../utils/pkce';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestConnection, createTestConnectorDefinition, createTestUser, seedOwnerContext } from '../../setup/test-fixtures';

const KEY = 'synthetic.oauth-recovery';
const BASE = 'account.read';
const OLD = 'items.read';
const EXTRA = 'items.write';
const originalFetch = globalThis.fetch;

async function seed() {
  const sql = getTestDb();
  const { org, user, ctx } = await seedOwnerContext({ orgName: 'Synthetic OAuth Recovery' });
  ctx.baseUrl = 'https://gateway.example/lobu';
  await createTestConnectorDefinition({
    key: KEY, name: 'Synthetic OAuth', organization_id: org.id,
    auth_schema: { methods: [{ type: 'oauth', provider: 'synthetic', requiredScopes: [BASE],
      optionalScopes: [OLD, EXTRA], clientIdKey: 'client_id', clientSecretKey: 'client_secret', authorizationUrl: 'https://provider.example/authorize',
      tokenUrl: 'https://provider.example/token', userinfoUrl: 'https://provider.example/userinfo' }] },
    feeds_schema: { items: { requiredScopes: [OLD] } },
  });
  const app = await createAuthProfile({ organizationId: org.id, connectorKey: KEY,
    displayName: 'Selected app', profileKind: 'oauth_app', provider: 'synthetic',
    authData: { client_id: 'synthetic-selected-client', client_secret: 'synthetic-selected-secret' },
    status: 'active', createdBy: user.id });
  const otherApp = await createAuthProfile({ organizationId: org.id, connectorKey: KEY,
    displayName: 'Other app', profileKind: 'oauth_app', provider: 'synthetic',
    authData: { client_id: 'synthetic-other-client', client_secret: 'synthetic-other-secret' },
    status: 'active', createdBy: user.id });
  await sql`UPDATE auth_profiles SET is_default_for_connector = true WHERE id = ${otherApp.id}`;
  const accountId = `synthetic-account-${org.id}`;
  await sql`INSERT INTO account (id, "accountId", "providerId", "userId", "accessToken", scope, "createdAt", "updatedAt")
    VALUES (${accountId}, ${`lobu-connector:${org.id}:${KEY}:original`}, 'synthetic', ${user.id}, 'synthetic-original-token', ${[BASE, OLD].join(' ')}, NOW(), NOW())`;
  const profile = await createAuthProfile({ organizationId: org.id, connectorKey: KEY,
    displayName: 'Synthetic account', profileKind: 'oauth_account', provider: 'synthetic',
    accountId, authData: { requested_scopes: [BASE, OLD], granted_scopes: [BASE, OLD] },
    status: 'active', createdBy: user.id });
  const connection = await createTestConnection({ organization_id: org.id, connector_key: KEY,
    created_by: user.id, visibility: 'private', createDefaultFeed: false });
  await sql`UPDATE connections SET auth_profile_id = ${profile.id}, app_auth_profile_id = ${app.id}, account_id = ${accountId} WHERE id = ${connection.id}`;
  await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, schedule, next_run_at)
    VALUES (${org.id}, ${connection.id}, 'items', 'Synthetic items', 'active', '0 * * * *', NOW() + INTERVAL '1 hour'),
      (${org.id}, ${connection.id}, 'paused-items', 'Operator paused', 'paused', NULL, NULL)`;
  const client = buildConnectionsNamespace(ctx, {} as Env);
  return { org, user, ctx, app, otherApp, profile, connection, client };
}

async function state(connectionId: number) {
  const sql = getTestDb();
  const [connection] = await sql`SELECT c.status, c.visibility, c.created_by, c.app_auth_profile_id, c.auth_profile_id, c.account_id, ap.auth_data, a."accessToken"
    FROM connections c JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    JOIN account a ON a.id = c.account_id WHERE c.id = ${connectionId}`;
  const feeds = await sql`SELECT id, status, next_run_at FROM feeds WHERE connection_id = ${connectionId} ORDER BY id`;
  return { connection, feeds };
}

async function waitForBlockedConnectTokens(count: number): Promise<void> {
  const sql = getTestDb();
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
        AND query ILIKE '%connect_tokens%'`;
    if (rows.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${count} blocked connect-token queries`);
}

describe('OAuth reconnect preserves the existing connection until consent', () => {
  beforeAll(async () => { await cleanupTestDatabase(); await initWorkspaceProvider(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('reuses an active connection for the selected personal account on repeated connect', async () => {
    const s = await seed();
    const before = await state(s.connection.id);
    const result = await s.client.connect({ connector_key: KEY, auth_profile_slug: s.profile.slug, app_auth_profile_slug: s.app.slug }) as { connection_id: number };
    expect(result.connection_id).toBe(s.connection.id);
    expect(await state(s.connection.id)).toEqual(before);
    const [count] = await getTestDb()`SELECT COUNT(*)::int AS count FROM connections WHERE organization_id = ${s.org.id} AND deleted_at IS NULL`;
    expect(count.count).toBe(1);
  });

  it('reuses the same connection while requesting additional authorization', async () => {
    const s = await seed();
    const before = await state(s.connection.id);
    const result = await s.client.connect({ connector_key: KEY, auth_profile_slug: s.profile.slug,
      app_auth_profile_slug: s.app.slug, requested_scopes: [EXTRA] }) as { connection_id: number; connect_url: string };
    expect(result.connection_id).toBe(s.connection.id);
    expect(result.connect_url).toContain('/oauth/start');
    expect(await state(s.connection.id)).toEqual(before);
  });

  it.each(['admin', 'owner'] as const)('does not let another %s rotate or rebind a personal grant', async (role) => {
    const s = await seed();
    const other = await createTestUser({ name: 'Synthetic other administrator' });
    await addUserToOrganization(other.id, s.org.id, role);
    const ctx = { ...s.ctx, userId: other.id, memberRole: role };
    const before = await state(s.connection.id);
    const reconnect = await manageConnections({ action: 'reauthenticate', connection_id: s.connection.id }, {} as Env, ctx);
    expect(reconnect).toHaveProperty('error');
    const profileReconnect = await manageAuthProfiles({ action: 'update_auth_profile', auth_profile_slug: s.profile.slug, reconnect: true }, {} as Env, ctx);
    expect(profileReconnect).toHaveProperty('error');
    for (const patch of [{ config: { synthetic: true } }, { app_auth_profile_slug: s.otherApp.slug }, { device_worker_id: null }]) {
      expect(await manageConnections({ action: 'update', connection_id: s.connection.id, ...patch }, {} as Env, ctx)).toHaveProperty('error');
    }
    expect(await manageAuthProfiles({ action: 'delete_auth_profile', auth_profile_slug: s.profile.slug }, {} as Env, ctx)).toHaveProperty('error');
    const own = await createTestConnection({ organization_id: s.org.id, connector_key: KEY, created_by: other.id, visibility: 'private', createDefaultFeed: false });
    const rebind = await manageConnections({ action: 'update', connection_id: own.id, auth_profile_slug: s.profile.slug }, {} as Env, ctx);
    expect(rebind).toHaveProperty('error');
    const [count] = await getTestDb()`SELECT COUNT(*)::int AS count FROM connect_tokens WHERE auth_profile_id = ${s.profile.id}`;
    expect(count.count).toBe(0);
    expect(await state(s.connection.id)).toEqual(before);
  });

  it.each(['connection', 'profile', 'grant'] as const)('rejects a stale reconnect after the %s owner changes', async (target) => {
    const s = await seed();
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const token = new URL(result.connect_url).pathname.split('/').at(-3)!;
    const other = await createTestUser({ name: 'Synthetic replacement owner' });
    await addUserToOrganization(other.id, s.org.id, 'owner');
    const sql = getTestDb();
    if (target === 'connection') await sql`UPDATE connections SET created_by = ${other.id} WHERE id = ${s.connection.id}`;
    if (target === 'profile') await sql`UPDATE auth_profiles SET created_by = ${other.id} WHERE id = ${s.profile.id}`;
    if (target === 'grant') await sql`UPDATE account SET "userId" = ${other.id} WHERE id = ${s.profile.account_id}`;
    const before = await state(s.connection.id);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-stale-owner-token', scope: [BASE, OLD].join(' ') });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-provider-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const response = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-stale-code`, {}, {} as Env);
    expect(response.headers.get('location')).toContain('auth_result=failed');
    expect(await state(s.connection.id)).toEqual(before);
  });

  it('rejects a different upstream identity without replacing the existing grant', async () => {
    const s = await seed();
    const sql = getTestDb();
    await sql`UPDATE auth_profiles SET auth_data = auth_data || ${sql.json({ identity: { id: 'synthetic-original-user' } })}::jsonb WHERE id = ${s.profile.id}`;
    const before = await state(s.connection.id);
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const token = new URL(result.connect_url).pathname.split('/').at(-3)!;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-different-account-token', scope: [BASE, OLD].join(' ') });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-different-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const response = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-different-code`, {}, {} as Env);
    expect(response.headers.get('location')).toContain('auth_result=failed');
    expect(await state(s.connection.id)).toEqual(before);
  });

  it('reopening the same PKCE authorization link keeps its challenge matched to the stored verifier', async () => {
    const s = await seed();
    await getTestDb()`UPDATE connector_definitions SET auth_schema = jsonb_set(auth_schema, '{methods,0,usePkce}', 'true') WHERE organization_id = ${s.org.id} AND key = ${KEY}`;
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const path = new URL(result.connect_url).pathname.replace('/lobu/connect', '');
    const first = await connectRoutes.request(path, {}, {} as Env);
    const second = await connectRoutes.request(path, {}, {} as Env);
    const challenge = new URL(first.headers.get('location')!).searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    expect(new URL(second.headers.get('location')!).searchParams.get('code_challenge')).toBe(challenge);
  });

  it('concurrent first opens of a PKCE link use the same saved challenge', async () => {
    const s = await seed();
    await getTestDb()`UPDATE connector_definitions SET auth_schema = jsonb_set(auth_schema, '{methods,0,usePkce}', 'true') WHERE organization_id = ${s.org.id} AND key = ${KEY}`;
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const path = new URL(result.connect_url).pathname.replace('/lobu/connect', '');
    const responses = await Promise.all(Array.from({ length: 3 }, () => connectRoutes.request(path, {}, {} as Env)));
    const saved = await connectRoutes.request(path, {}, {} as Env);
    expect(saved.status).toBe(302);
    const challenge = new URL(saved.headers.get('location')!).searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    for (const response of responses) {
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location')!).searchParams.get('code_challenge')).toBe(challenge);
    }
  });

  it('preserves an open PKCE flow and cumulative scopes when pending setup is retried concurrently', async () => {
    const s = await seed();
    const sql = getTestDb();
    await sql`UPDATE connector_definitions SET auth_schema = jsonb_set(auth_schema, '{methods,0,usePkce}', 'true') WHERE organization_id = ${s.org.id} AND key = ${KEY}`;
    const user = await createTestUser({ name: 'Synthetic concurrent consent owner' });
    await addUserToOrganization(user.id, s.org.id, 'owner');
    const client = buildConnectionsNamespace({ ...s.ctx, userId: user.id }, {} as Env);
    const args = { connector_key: KEY, app_auth_profile_slug: s.app.slug };
    const initial = await client.connect(args) as { connection_id: number; connect_url: string };
    const path = new URL(initial.connect_url).pathname.replace('/lobu/connect', '');
    const token = path.split('/')[1];
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = sql.begin(async (tx: typeof sql) => {
      await tx`SELECT token FROM connect_tokens WHERE token = ${token} FOR UPDATE`;
      ready();
      await gate;
    });
    await held;
    const opening = connectRoutes.request(path, {}, {} as Env);
    const retries: Array<Promise<unknown>> = [];
    try {
      // Queue /oauth/start first. The retries read the pre-initialization
      // snapshot before start saves its verifier on the held token row.
      await waitForBlockedConnectTokens(1);
      retries.push(client.connect({ ...args, requested_scopes: [OLD] }));
      await waitForBlockedConnectTokens(2);
      retries.push(client.connect({ ...args, requested_scopes: [EXTRA] }));
      await waitForBlockedConnectTokens(3);
    } finally {
      release();
      await Promise.allSettled([holder, opening, ...retries]);
    }
    const response = await opening;
    expect(response.status).toBe(302);
    for (const retry of retries) expect(await retry).toMatchObject({ connection_id: initial.connection_id });
    const [saved] = await sql`SELECT auth_config FROM connect_tokens WHERE token = ${token}`;
    expect(saved.auth_config.pkceCodeVerifier).toEqual(expect.any(String));
    expect(saved.auth_config.redirectUri).toBeTruthy();
    expect(saved.auth_config.appAuthProfileId).toBe(s.app.id);
    expect(saved.auth_config.requestedScopes).toEqual(expect.arrayContaining([BASE, OLD, EXTRA]));
    expect(saved.auth_config.scopes).toEqual(saved.auth_config.requestedScopes);
    const authorization = new URL(response.headers.get('location')!);
    const authorizedScopes = authorization.searchParams.get('scope')!.split(' ');
    expect(authorizedScopes).toEqual([BASE]);
    const challenge = authorization.searchParams.get('code_challenge');
    expect(generateCodeChallenge(saved.auth_config.pkceCodeVerifier)).toBe(challenge);
    const reopened = await connectRoutes.request(path, {}, {} as Env);
    expect(reopened.status).toBe(302);
    const nextAuthorization = new URL(reopened.headers.get('location')!);
    expect(nextAuthorization.searchParams.get('scope')?.split(' ').sort()).toEqual([BASE, OLD, EXTRA].sort());
    expect(nextAuthorization.searchParams.get('code_challenge')).toBe(challenge);
    let exchanged = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') {
        exchanged = true;
        const verifier = new URLSearchParams(String(init?.body)).get('code_verifier');
        if (!verifier || generateCodeChallenge(verifier) !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({ access_token: 'synthetic-concurrent-token', scope: authorizedScopes.join(' ') });
      }
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-concurrent-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const callback = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-concurrent-code`, {}, {} as Env);
    expect(exchanged).toBe(true);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).not.toContain('auth_result=failed');
    const connected = await state(initial.connection_id);
    expect(connected.connection.status).toBe('active');
    expect(connected.connection.auth_data.granted_scopes).toEqual(authorizedScopes);
    expect(connected.connection.auth_data.requested_scopes).toEqual(saved.auth_config.requestedScopes);
  });

  it.each(['app', 'account', 'provider'] as const)('renews stale pending tokens after changing the selected %s', async (target) => {
    const s = await seed();
    const sql = getTestDb();
    const user = await createTestUser({ name: 'Synthetic pending owner' });
    await addUserToOrganization(user.id, s.org.id, 'owner');
    const client = buildConnectionsNamespace({ ...s.ctx, userId: user.id }, {} as Env);
    const initial = await client.connect({ connector_key: KEY, app_auth_profile_slug: s.app.slug, requested_scopes: [OLD] }) as { connection_id: number; connect_url: string };
    await connectRoutes.request(new URL(initial.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    let profileId: number | null = null;
    const app = target !== 'account' ? s.otherApp : s.app;
    const provider = target === 'provider' ? 'alternate' : 'synthetic';
    const providerOrigin = target === 'provider' ? 'https://alternate.example' : 'https://provider.example';
    if (target === 'provider') {
      await sql`UPDATE connector_definitions SET auth_schema = jsonb_set(auth_schema, '{methods}',
        (auth_schema->'methods') || ${sql.json([{ type: 'oauth', provider, requiredScopes: [BASE], optionalScopes: [OLD, EXTRA],
          clientIdKey: 'client_id', clientSecretKey: 'client_secret', authorizationUrl: `${providerOrigin}/authorize`,
          tokenUrl: `${providerOrigin}/token`, userinfoUrl: `${providerOrigin}/userinfo` }])}::jsonb)
        WHERE organization_id = ${s.org.id} AND key = ${KEY}`;
      await sql`UPDATE auth_profiles SET provider = ${provider} WHERE id = ${app.id}`;
    }
    if (target !== 'account') {
      await client.update({ connection_id: initial.connection_id, app_auth_profile_slug: app.slug });
    } else {
      const profile = await createAuthProfile({ organizationId: s.org.id, connectorKey: KEY,
        displayName: 'Replacement pending account', profileKind: 'oauth_account', provider: 'synthetic',
        authData: { app_auth_profile_id: app.id }, status: 'pending_auth', createdBy: user.id });
      profileId = profile.id;
      await client.update({ connection_id: initial.connection_id, auth_profile_slug: profile.slug });
    }
    const retried = await client.connect({ connector_key: KEY, app_auth_profile_slug: app.slug, requested_scopes: [EXTRA] }) as { connection_id: number; connect_url: string };
    expect(retried.connection_id).toBe(initial.connection_id);
    expect(retried.connect_url).not.toBe(initial.connect_url);
    expect((await connectRoutes.request(new URL(initial.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env)).status).toBe(404);
    const start = await connectRoutes.request(new URL(retried.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    const authorization = new URL(start.headers.get('location')!);
    expect(authorization.origin).toBe(providerOrigin);
    expect(authorization.searchParams.get('client_id')).toBe(target !== 'account' ? 'synthetic-other-client' : 'synthetic-selected-client');
    expect(authorization.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(target === 'provider' ? [BASE, EXTRA] : [BASE, OLD, EXTRA]));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${providerOrigin}/token`) return Response.json({ access_token: 'synthetic-rebound-token', scope: [BASE, OLD, EXTRA].join(' ') });
      if (url === `${providerOrigin}/userinfo`) return Response.json({ id: 'synthetic-rebound-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const token = authorization.searchParams.get('state');
    const callback = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-rebound-code`, {}, {} as Env);
    expect(callback.headers.get('location')).not.toContain('auth_result=failed');
    const [connection] = await sql`SELECT status, auth_profile_id, app_auth_profile_id FROM connections WHERE id = ${initial.connection_id}`;
    expect(connection.status).toBe('active');
    expect(connection.app_auth_profile_id).toBe(app.id);
    if (profileId) expect(connection.auth_profile_id).toBe(profileId);
    const [account] = await sql`SELECT ap.provider, ap.connector_key, a."providerId" FROM auth_profiles ap
      JOIN account a ON a.id = ap.account_id WHERE ap.id = ${connection.auth_profile_id}`;
    expect(account).toMatchObject({ provider, connector_key: KEY, providerId: provider });
  });

  it('does not renew a superseded token when expired setup retries queue together', async () => {
    const s = await seed();
    const sql = getTestDb();
    await sql`UPDATE connections SET status = 'pending_auth' WHERE id = ${s.connection.id}`;
    const initial = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const token = new URL(initial.connect_url).pathname.split('/').at(-3)!;
    await sql`UPDATE connect_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE token = ${token}`;
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = sql.begin(async (tx: typeof sql) => {
      await tx`SELECT token FROM connect_tokens WHERE token = ${token} FOR UPDATE`;
      ready();
      await gate;
    });
    await held;
    const first = s.client.connect({ connector_key: KEY, requested_scopes: [OLD] });
    let second: Promise<unknown> | undefined;
    try {
      await waitForBlockedConnectTokens(1);
      second = s.client.connect({ connector_key: KEY, requested_scopes: [EXTRA] });
      await waitForBlockedConnectTokens(2);
    } finally {
      release();
      await Promise.allSettled([holder, first, second]);
    }
    const renewed = await first as { connect_url: string };
    await expect(second).rejects.toThrow('Connection setup changed. Retry connecting this account.');
    const retried = await s.client.connect({ connector_key: KEY, requested_scopes: [EXTRA] }) as { connect_url: string };
    expect(retried.connect_url).toBe(renewed.connect_url);
    expect(retried.connect_url).not.toBe(initial.connect_url);
    const pending = await sql`SELECT auth_config FROM connect_tokens WHERE connection_id = ${s.connection.id} AND status = 'pending'`;
    expect(pending).toHaveLength(1);
    expect(pending[0].auth_config.requestedScopes).toEqual(expect.arrayContaining([BASE, OLD, EXTRA]));
    expect((await connectRoutes.request(new URL(initial.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env)).status).toBe(404);
  });

  it('preserves already granted scopes outside the current manifest when retrying reconnect setup', async () => {
    const s = await seed();
    const sql = getTestDb();
    const legacy = 'legacy.already-granted';
    await sql`UPDATE account SET scope = ${[BASE, OLD, legacy].join(' ')} WHERE id = ${s.profile.account_id}`;
    await sql`UPDATE connections SET status = 'pending_auth' WHERE id = ${s.connection.id}`;
    const initial = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const retry = await s.client.connect({ connector_key: KEY, requested_scopes: [EXTRA] }) as { connect_url: string };
    expect(retry.connect_url).toBe(initial.connect_url);
    const start = await connectRoutes.request(new URL(retry.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(new URL(start.headers.get('location')!).searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining([BASE, OLD, legacy, EXTRA]));
  });

  it('does not expose a different member profile-bound reconnect token through pending connect retries', async () => {
    const s = await seed();
    const sql = getTestDb();
    const member = await createTestUser({ name: 'Synthetic connection owner' });
    await addUserToOrganization(member.id, s.org.id, 'member');
    await s.client.reauthenticate(s.connection.id);
    await sql`UPDATE connections SET created_by = ${member.id}, status = 'pending_auth' WHERE id = ${s.connection.id}`;
    const before = await sql`SELECT token, status, auth_config FROM connect_tokens WHERE connection_id = ${s.connection.id}`;
    const memberClient = buildConnectionsNamespace({ ...s.ctx, userId: member.id, memberRole: 'member' }, {} as Env);
    await expect(memberClient.connect({ connector_key: KEY, requested_scopes: [EXTRA] })).rejects.toThrow('OAuth account profiles you created');
    expect(await sql`SELECT token, status, auth_config FROM connect_tokens WHERE connection_id = ${s.connection.id}`).toEqual(before);
  });

  it('keeps a connection active when its callback finishes ahead of a queued setup retry', async () => {
    const s = await seed();
    const sql = getTestDb();
    await sql`UPDATE connections SET status = 'pending_auth' WHERE id = ${s.connection.id}`;
    const initial = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const token = new URL(initial.connect_url).pathname.split('/').at(-3)!;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-completed-token', scope: [BASE, OLD].join(' ') });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-completed-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = sql.begin(async (tx: typeof sql) => {
      await tx`SELECT token FROM connect_tokens WHERE token = ${token} FOR UPDATE`;
      ready();
      await gate;
    });
    await held;
    const callback = connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-completed-code`, {}, {} as Env);
    let retry: Promise<unknown> | undefined;
    try {
      await waitForBlockedConnectTokens(1);
      retry = s.client.connect({ connector_key: KEY, requested_scopes: [EXTRA] });
      await waitForBlockedConnectTokens(2);
    } finally {
      release();
      await Promise.allSettled([holder, callback, retry]);
    }
    expect((await callback).headers.get('location')).not.toContain('auth_result=failed');
    expect(await retry).toMatchObject({ connection_id: s.connection.id, status: 'active' });
    expect(await retry).not.toHaveProperty('connect_url');
    expect((await state(s.connection.id)).connection.status).toBe('active');
    expect(await sql`SELECT status FROM connect_tokens WHERE connection_id = ${s.connection.id}`).toEqual([{ status: 'completed' }]);
  });

  it('rebuilds renewed OAuth configuration from the current connector method', async () => {
    const s = await seed();
    const sql = getTestDb();
    await sql`UPDATE connections SET status = 'pending_auth' WHERE id = ${s.connection.id}`;
    const initial = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const token = new URL(initial.connect_url).pathname.split('/').at(-3)!;
    await sql`UPDATE connect_tokens SET expires_at = NOW() - INTERVAL '1 hour',
      auth_config = auth_config || ${sql.json({ authParams: { retired_parameter: 'old' }, resource: 'https://retired.example' })}::jsonb
      WHERE token = ${token}`;
    await sql`UPDATE connector_definitions SET auth_schema = auth_schema #- '{methods,0,userinfoUrl}'
      WHERE organization_id = ${s.org.id} AND key = ${KEY}`;
    const renewed = await s.client.connect({ connector_key: KEY }) as { connect_url: string };
    const nextToken = new URL(renewed.connect_url).pathname.split('/').at(-3)!;
    const [row] = await sql`SELECT auth_config FROM connect_tokens WHERE token = ${nextToken}`;
    expect(row.auth_config).not.toHaveProperty('userinfoUrl');
    expect(row.auth_config).not.toHaveProperty('authParams');
    expect(row.auth_config).not.toHaveProperty('resource');
    expect(row.auth_config.requestedScopes).toEqual(expect.arrayContaining([BASE, OLD]));
    const start = await connectRoutes.request(new URL(renewed.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get('location')!).searchParams.has('retired_parameter')).toBe(false);
  });

  it('does not rebind a legacy grant through connection update', async () => {
    const s = await seed();
    const before = await state(s.connection.id);
    await expect(s.client.update({ connection_id: s.connection.id, app_auth_profile_slug: s.otherApp.slug })).rejects.toThrow('already bound');
    expect(await state(s.connection.id)).toEqual(before);
  });

  it('validates the retained account on app-only updates even when another account is primary', async () => {
    const s = await seed();
    const other = await createAuthProfile({ organizationId: s.org.id, connectorKey: KEY,
      displayName: 'Newer account', profileKind: 'oauth_account', provider: 'synthetic',
      authData: { app_auth_profile_id: s.otherApp.id }, status: 'active', createdBy: s.user.id });
    await getTestDb()`UPDATE auth_profiles SET updated_at = NOW() + INTERVAL '1 minute' WHERE id = ${other.id}`;
    const before = await state(s.connection.id);
    await expect(s.client.update({ connection_id: s.connection.id, app_auth_profile_slug: s.otherApp.slug })).rejects.toThrow('already bound');
    expect(await state(s.connection.id)).toEqual(before);
    await s.client.update({ connection_id: s.connection.id, app_auth_profile_slug: s.app.slug });
    expect((await state(s.connection.id)).connection.app_auth_profile_id).toBe(s.app.id);
  });

  it('preserves an unbound pending account on app-only updates instead of selecting another account', async () => {
    const s = await seed();
    const sql = getTestDb();
    const other = await createAuthProfile({ organizationId: s.org.id, connectorKey: KEY,
      displayName: 'Unrelated primary account', profileKind: 'oauth_account', provider: 'synthetic',
      authData: { app_auth_profile_id: s.otherApp.id }, status: 'active', createdBy: s.user.id });
    await sql`UPDATE auth_profiles SET updated_at = NOW() + INTERVAL '1 minute' WHERE id = ${other.id}`;
    const pending = await createTestConnection({ organization_id: s.org.id, connector_key: KEY,
      created_by: s.user.id, visibility: 'private', createDefaultFeed: false });
    await sql`UPDATE connections SET status = 'pending_auth', auth_profile_id = NULL,
      account_id = NULL, app_auth_profile_id = ${s.app.id} WHERE id = ${pending.id}`;
    for (const app of [s.app, s.otherApp]) {
      await s.client.update({ connection_id: pending.id, app_auth_profile_slug: app.slug });
      const [row] = await sql`SELECT auth_profile_id, account_id, app_auth_profile_id, status FROM connections WHERE id = ${pending.id}`;
      expect(row).toMatchObject({ auth_profile_id: null, account_id: null, app_auth_profile_id: app.id, status: 'pending_auth' });
    }
  });

  it.each([
    ['account', 'active'], ['account', 'pending_auth'], ['app', 'active'], ['app', 'pending_auth'],
    ['account', 'revoked'], ['account', 'error'], ['app', 'revoked'], ['app', 'error'],
  ] as const)('allows unrelated edits and unchanged profile round-trips with an %s in %s state', async (kind, status) => {
    const s = await seed();
    const sql = getTestDb();
    const profile = kind === 'account' ? s.profile : s.app;
    await sql`UPDATE auth_profiles SET status = ${status} WHERE id = ${profile.id}`;
    await sql`UPDATE connections SET status = ${status} WHERE id = ${s.connection.id}`;
    const before = await state(s.connection.id);
    await s.client.update({ connection_id: s.connection.id, display_name: 'Renamed synthetic account' });
    expect(await state(s.connection.id)).toEqual(before);
    const humanClient = buildConnectionsNamespace({ ...s.ctx, tokenType: 'session' }, {} as Env);
    await humanClient.update({ connection_id: s.connection.id, config: { action_modes: { inspect: 'approval' } } });
    expect(await state(s.connection.id)).toEqual(before);
    await s.client.update({ connection_id: s.connection.id,
      auth_profile_slug: s.profile.slug, app_auth_profile_slug: s.app.slug });
    expect(await state(s.connection.id)).toEqual(before);
    const [row] = await sql`SELECT display_name, config, auth_profile_id, app_auth_profile_id FROM connections WHERE id = ${s.connection.id}`;
    expect(row).toMatchObject({ display_name: 'Renamed synthetic account',
      config: { action_modes: { inspect: 'approval' } }, auth_profile_id: s.profile.id, app_auth_profile_id: s.app.id });
    expect((await sql`SELECT status FROM auth_profiles WHERE id = ${profile.id}`)[0].status).toBe(status);
  });

  it.each([
    ['account', 'revoked'], ['account', 'error'], ['app', 'revoked'], ['app', 'error'], ['app', 'pending_auth'],
  ] as const)('still rejects selecting a new %s in %s state', async (kind, status) => {
    const s = await seed();
    if (kind === 'account') {
      const profile = await createAuthProfile({ organizationId: s.org.id, connectorKey: KEY,
        displayName: 'Unusable synthetic account', profileKind: 'oauth_account', provider: 'synthetic',
        authData: { app_auth_profile_id: s.app.id }, status, createdBy: s.user.id });
      await expect(s.client.update({ connection_id: s.connection.id, auth_profile_slug: profile.slug })).rejects.toThrow('must be active or pending_auth');
    } else {
      const sql = getTestDb();
      await sql`UPDATE auth_profiles SET status = ${status} WHERE id = ${s.otherApp.id}`;
      const pending = await createTestConnection({ organization_id: s.org.id, connector_key: KEY,
        created_by: s.user.id, visibility: 'private', createDefaultFeed: false });
      await sql`UPDATE connections SET auth_profile_id = NULL, account_id = NULL, app_auth_profile_id = ${s.app.id} WHERE id = ${pending.id}`;
      await expect(s.client.update({ connection_id: pending.id, app_auth_profile_slug: s.otherApp.slug })).rejects.toThrow('must be active');
    }
  });

  it('retains the selected app when attaching a pending account before consent', async () => {
    const s = await seed();
    const created = await manageAuthProfiles({ action: 'create_auth_profile', connector_key: KEY,
      profile_kind: 'oauth_account', display_name: 'Pending selected app', app_auth_profile_slug: s.app.slug }, {} as Env, s.ctx);
    expect(created).toHaveProperty('auth_profile');
    if (!('auth_profile' in created)) throw new Error('Expected pending profile');
    const attached = await manageConnections({ action: 'create', connector_key: KEY,
      slug: 'synthetic-pending-selected-app', auth_profile_slug: created.auth_profile.slug }, {} as Env, s.ctx);
    expect(attached).not.toHaveProperty('error');
    const [row] = await getTestDb()`SELECT app_auth_profile_id FROM connections WHERE organization_id = ${s.org.id} AND slug = 'synthetic-pending-selected-app'`;
    expect(row.app_auth_profile_id).toBe(s.app.id);
    const retry = await manageAuthProfiles({ action: 'create_auth_profile', connector_key: KEY,
      profile_kind: 'oauth_account', display_name: 'Pending selected app', slug: created.auth_profile.slug, app_auth_profile_slug: s.otherApp.slug }, {} as Env, s.ctx);
    expect(retry).toHaveProperty('error', expect.stringContaining('already bound'));
  });

  it('SDK reconnect requests additional scopes, retains existing grants and uses the bound app', async () => {
    const s = await seed();
    const result = await s.client.reauthenticate(s.connection.id, { requested_scopes: [EXTRA] }) as { connect_url: string };
    expect(result.connect_url).toBeTypeOf('string');
    const response = await connectRoutes.request(new URL(result.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    expect(url.searchParams.get('client_id')).toBe('synthetic-selected-client');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining([BASE, OLD, EXTRA]));
  });

  it('rejects a stale callback for another app before replacing credentials or feeds', async () => {
    const s = await seed();
    const before = await state(s.connection.id);
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const token = new URL(result.connect_url).pathname.split('/').at(-3)!;
    // Simulate a pre-fix link issued with a conflicting app choice.
    await getTestDb()`UPDATE connect_tokens SET auth_config = auth_config || ${getTestDb().json({ appAuthProfileId: s.otherApp.id })}::jsonb WHERE token = ${token}`;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-wrong-app-token', scope: [BASE, EXTRA].join(' ') });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-provider-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const response = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-stale-code`, {}, {} as Env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('auth_result=failed');
    expect(await state(s.connection.id)).toEqual(before);
  });

  it.each(['rebound', 'deleted'] as const)('rejects a reconnect callback after its connection is %s', async (change) => {
    const s = await seed();
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const token = new URL(result.connect_url).pathname.split('/').at(-3)!;
    const sql = getTestDb();
    if (change === 'rebound') {
      const replacement = await createAuthProfile({ organizationId: s.org.id, connectorKey: KEY,
        displayName: 'Replacement account', profileKind: 'oauth_account', provider: 'synthetic',
        authData: { app_auth_profile_id: s.app.id }, status: 'active', createdBy: s.user.id });
      await sql`UPDATE connections SET auth_profile_id = ${replacement.id} WHERE id = ${s.connection.id}`;
    } else {
      await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${s.connection.id}`;
    }
    const beforeConnection = await sql`SELECT * FROM connections WHERE id = ${s.connection.id}`;
    const beforeProfile = await sql`SELECT * FROM auth_profiles WHERE id = ${s.profile.id}`;
    const beforeAccount = await sql`SELECT * FROM account WHERE id = ${s.profile.account_id}`;
    const beforeFeeds = await sql`SELECT * FROM feeds WHERE connection_id = ${s.connection.id} ORDER BY id`;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-stale-token', scope: [BASE, OLD, EXTRA].join(' ') });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-provider-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const response = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-stale-code`, {}, {} as Env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('auth_result=failed');
    expect(await sql`SELECT * FROM connections WHERE id = ${s.connection.id}`).toEqual(beforeConnection);
    expect(await sql`SELECT * FROM auth_profiles WHERE id = ${s.profile.id}`).toEqual(beforeProfile);
    expect(await sql`SELECT * FROM account WHERE id = ${s.profile.account_id}`).toEqual(beforeAccount);
    expect(await sql`SELECT * FROM feeds WHERE connection_id = ${s.connection.id} ORDER BY id`).toEqual(beforeFeeds);
  });

  it('cancelling an upgrade leaves credentials, capability state and feeds untouched', async () => {
    const s = await seed();
    const before = await state(s.connection.id);
    const result = await manageAuthProfiles({ action: 'update_auth_profile', auth_profile_slug: s.profile.slug,
      requested_scopes: [EXTRA], reconnect: true }, {} as Env, s.ctx);
    expect(result).toHaveProperty('connect_url');
    const token = new URL((result as { connect_url: string }).connect_url).pathname.split('/').at(-3)!;
    const response = await connectRoutes.request(`/oauth/callback?state=${token}&error=access_denied`, {}, {} as Env);
    expect(response.status).toBe(302);
    await syncOAuthConnectionsForAuthProfile(s.org.id, s.profile.id);
    expect(await state(s.connection.id)).toEqual(before);
  });

  it('successful return updates the same records and preserves an operator-paused feed', async () => {
    const s = await seed();
    const before = await state(s.connection.id);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-upgraded-token', refresh_token: 'synthetic-refresh', scope: [BASE, OLD, EXTRA].join(' '), expires_in: 3600 });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-provider-user', name: 'Synthetic user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const result = await s.client.reauthenticate(s.connection.id, { requested_scopes: [EXTRA] }) as { connect_url: string };
    const token = new URL(result.connect_url).pathname.split('/').at(-3)!;
    const response = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-code`, {}, {} as Env);
    expect(response.status).toBe(302);
    const after = await state(s.connection.id);
    expect(after.connection.status).toBe('active');
    expect(after.connection.auth_data.granted_scopes).toEqual([BASE, OLD, EXTRA]);
    expect(after.connection.auth_data.requested_scopes).toEqual(expect.arrayContaining([BASE, OLD, EXTRA]));
    expect(after.connection.account_id).toBe(before.connection.account_id);
    expect(after.feeds).toEqual(before.feeds);
    expect(response.headers.get('location')).toContain(`/connectors/${KEY}/${s.connection.id}`);
  });

  it('new account setup honors the explicitly selected app and optional scopes', async () => {
    const s = await seed();
    const user = await createTestUser({ name: 'Synthetic new account owner' });
    await addUserToOrganization(user.id, s.org.id, 'owner');
    const client = buildConnectionsNamespace({ ...s.ctx, userId: user.id }, {} as Env);
    const result = await client.connect({ connector_key: KEY, app_auth_profile_slug: s.app.slug, requested_scopes: [EXTRA] }) as { connection_id: number; connect_url: string };
    const response = await connectRoutes.request(new URL(result.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    const url = new URL(response.headers.get('location')!);
    expect(url.searchParams.get('client_id')).toBe('synthetic-selected-client');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining([BASE, EXTRA]));
    const again = await client.connect({ connector_key: KEY, app_auth_profile_slug: s.app.slug, requested_scopes: [EXTRA] }) as { connection_id: number };
    expect(again.connection_id).toBe(result.connection_id);
  });

  it('does not fall back to a different app when the selected app is revoked', async () => {
    const s = await seed();
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    await updateAuthProfile({ organizationId: s.org.id, slug: s.app.slug, status: 'revoked' });
    const response = await connectRoutes.request(new URL(result.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects another member and another workspace before issuing a token', async () => {
    const s = await seed();
    const member = await createTestUser({ name: 'Synthetic other member' });
    await addUserToOrganization(member.id, s.org.id, 'member');
    const memberClient = buildConnectionsNamespace({ ...s.ctx, userId: member.id, memberRole: 'member' }, {} as Env);
    await expect(memberClient.reauthenticate(s.connection.id)).rejects.toThrow('connections you created');
    const other = await seedOwnerContext({ orgName: 'Synthetic other workspace' });
    const otherClient = buildConnectionsNamespace(other.ctx, {} as Env);
    await expect(otherClient.reauthenticate(s.connection.id)).rejects.toThrow('Connection not found');
    const [row] = await getTestDb()`SELECT COUNT(*)::int AS count FROM connect_tokens WHERE auth_profile_id = ${s.profile.id}`;
    expect(row.count).toBe(0);
  });

  it('failed token exchange preserves the working grant and returns to the exact connection', async () => {
    const s = await seed();
    const before = await state(s.connection.id);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return originalFetch(input, init);
    }) as typeof fetch;
    const result = await s.client.reauthenticate(s.connection.id, { requested_scopes: [EXTRA] }) as { connect_url: string };
    const token = new URL(result.connect_url).pathname.split('/').at(-3)!;
    const response = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-failed`, {}, {} as Env);
    expect(response.headers.get('location')).toContain(`/${s.connection.id}?settings=true&auth_result=failed`);
    expect(await state(s.connection.id)).toEqual(before);
  });
  it('members connect their own account with the workspace default, without configuring an app', async () => {
    const s = await seed();
    const member = await createTestUser({ name: 'Synthetic consenting member' });
    await addUserToOrganization(member.id, s.org.id, 'member');
    const client = buildConnectionsNamespace({ ...s.ctx, userId: member.id, memberRole: 'member' }, {} as Env);
    const denied = await client.connect({ connector_key: KEY, app_auth_profile_slug: s.app.slug }) as { status: string; setup_url: string };
    expect(denied.status).toBe('setup_required');
    expect(new URL(denied.setup_url).hash).toBe('#connector-oauth-apps');
    const result = await client.connect({ connector_key: KEY, requested_scopes: [EXTRA] }) as { connection_id: number; connect_url: string };
    const response = await connectRoutes.request(new URL(result.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(new URL(response.headers.get('location')!).searchParams.get('client_id')).toBe('synthetic-other-client');
    const [row] = await getTestDb()`SELECT created_by, auth_profile_id, app_auth_profile_id, visibility FROM connections WHERE id = ${result.connection_id}`;
    expect(row.created_by).toBe(member.id);
    expect(row.auth_profile_id).toBeNull();
    expect(Number(row.app_auth_profile_id)).toBe(s.otherApp.id);
    expect(row.visibility).toBe('private');
  });

  it('multiple apps without a default require an explicit choice and create no connection', async () => {
    const s = await seed();
    await getTestDb()`UPDATE auth_profiles SET is_default_for_connector = false WHERE organization_id = ${s.org.id}`;
    const user = await createTestUser({ name: 'Synthetic choosing owner' });
    await addUserToOrganization(user.id, s.org.id, 'owner');
    const client = buildConnectionsNamespace({ ...s.ctx, userId: user.id }, {} as Env);
    const result = await client.connect({ connector_key: KEY }) as { status: string; instructions: string; setup_url: string };
    expect(result.status).toBe('setup_required');
    expect(result.instructions).toContain('Multiple OAuth apps');
    expect(new URL(result.setup_url).hash).toBe('#connector-oauth-apps');
    const [row] = await getTestDb()`SELECT COUNT(*)::int AS count FROM connections WHERE organization_id = ${s.org.id}`;
    expect(row.count).toBe(1);
  });

  it('partial consent retains connected state and reports only the missing capability scopes', async () => {
    const s = await seed();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-partial-token', scope: [BASE, OLD].join(' '), expires_in: 3600 });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-provider-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const before = await state(s.connection.id);
    const result = await s.client.reauthenticate(s.connection.id, { requested_scopes: [EXTRA] }) as { connect_url: string };
    const token = new URL(result.connect_url).pathname.split('/').at(-3)!;
    await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-partial`, {}, {} as Env);
    const after = await state(s.connection.id);
    expect(after.connection.status).toBe('active');
    expect(after.connection.auth_data.granted_scopes).toEqual([BASE, OLD]);
    expect(after.connection.visibility).toBe(before.connection.visibility);
    expect(after.connection.created_by).toBe(before.connection.created_by);
    expect(after.connection.app_auth_profile_id).toBe(before.connection.app_auth_profile_id);
    expect(after.connection.auth_profile_id).toBe(before.connection.auth_profile_id);
    expect(after.feeds).toEqual(before.feeds);
  });

  it('renews an expired new-account authorization on the same connection', async () => {
    const s = await seed();
    const member = await createTestUser({ name: 'Synthetic retry member' });
    await addUserToOrganization(member.id, s.org.id, 'member');
    const client = buildConnectionsNamespace({ ...s.ctx, userId: member.id, memberRole: 'member' }, {} as Env);
    const first = await client.connect({ connector_key: KEY }) as { connection_id: number; connect_url: string };
    await getTestDb()`UPDATE connect_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE connection_id = ${first.connection_id}`;
    await expireStaleConnectTokens();
    const next = await client.connect({ connector_key: KEY, requested_scopes: [EXTRA] }) as { connection_id: number; connect_url: string };
    expect(next.connection_id).toBe(first.connection_id);
    expect(next.connect_url).not.toBe(first.connect_url);
    const response = await connectRoutes.request(new URL(next.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(new URL(response.headers.get('location')!).searchParams.get('scope')?.split(' ')).toContain(EXTRA);
    const [row] = await getTestDb()`SELECT COUNT(*)::int AS count FROM connections WHERE organization_id = ${s.org.id} AND created_by = ${member.id}`;
    expect(row.count).toBe(1);
  });

  it('retains a provider-wide app binding when its connector differs from the account connector', async () => {
    const s = await seed();
    await createTestConnectorDefinition({ key: 'synthetic.provider-app', name: 'Synthetic app owner', organization_id: s.org.id });
    await getTestDb()`UPDATE auth_profiles SET connector_key = 'synthetic.provider-app' WHERE id = ${s.app.id}`;
    const result = await s.client.reauthenticate(s.connection.id) as { connect_url: string };
    const response = await connectRoutes.request(new URL(result.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).searchParams.get('client_id')).toBe('synthetic-selected-client');
  });

  it('standalone profile creation and reconnect honor an explicit app, without modifying an existing grant', async () => {
    const s = await seed();
    const created = await manageAuthProfiles({ action: 'create_auth_profile', connector_key: KEY,
      profile_kind: 'oauth_account', display_name: 'Synthetic standalone account', app_auth_profile_slug: s.app.slug,
      requested_scopes: [EXTRA] }, {} as Env, s.ctx) as { connect_url: string; auth_profile: { slug: string } };
    const started = await connectRoutes.request(new URL(created.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(new URL(started.headers.get('location')!).searchParams.get('client_id')).toBe('synthetic-selected-client');
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://provider.example/token') return Response.json({ access_token: 'synthetic-standalone-token', scope: [BASE, EXTRA].join(' ') });
      if (url === 'https://provider.example/userinfo') return Response.json({ id: 'synthetic-standalone-user' });
      return originalFetch(input, init);
    }) as typeof fetch;
    const token = new URL(created.connect_url).pathname.split('/').at(-3)!;
    const completed = await connectRoutes.request(`/oauth/callback?state=${token}&code=synthetic-code`, {}, {} as Env);
    expect(completed.status).toBe(302);
    const [standalone] = await getTestDb()`SELECT auth_data FROM auth_profiles WHERE organization_id = ${s.org.id} AND slug = ${created.auth_profile.slug}`;
    expect(standalone.auth_data.app_auth_profile_id).toBe(s.app.id);
    const reconnect = await manageAuthProfiles({ action: 'update_auth_profile', auth_profile_slug: created.auth_profile.slug, reconnect: true }, {} as Env, s.ctx) as { connect_url: string };
    const restarted = await connectRoutes.request(new URL(reconnect.connect_url).pathname.replace('/lobu/connect', ''), {}, {} as Env);
    expect(new URL(restarted.headers.get('location')!).searchParams.get('client_id')).toBe('synthetic-selected-client');
    const before = await state(s.connection.id);
    const rejected = await manageAuthProfiles({ action: 'update_auth_profile', auth_profile_slug: s.profile.slug,
      app_auth_profile_slug: s.otherApp.slug, requested_scopes: [EXTRA], reconnect: true }, {} as Env, s.ctx);
    expect(rejected).toHaveProperty('error', expect.stringContaining('already bound'));
    expect(await state(s.connection.id)).toEqual(before);
  });

});
