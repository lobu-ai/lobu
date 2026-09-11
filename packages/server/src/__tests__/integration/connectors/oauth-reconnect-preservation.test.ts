import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectRoutes } from '../../../connect/routes';
import type { Env } from '../../../index';
import { buildConnectionsNamespace } from '../../../sandbox/namespaces/connections';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { createAuthProfile, updateAuthProfile } from '../../../utils/auth-profiles';
import { expireStaleConnectTokens } from '../../../utils/connect-tokens';
import { syncOAuthConnectionsForAuthProfile } from '../../../utils/oauth-connection-state';
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

describe('OAuth reconnect preserves the existing connection until consent', () => {
  beforeAll(async () => { await cleanupTestDatabase(); await initWorkspaceProvider(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

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
