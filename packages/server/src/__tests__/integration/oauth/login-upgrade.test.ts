/**
 * A connected app's login is widened by its owner from the Lobu web app, not
 * by reconnecting: a denial the person could lift carries a link to the
 * login's page (`fix.url`), and `POST /api/me/logins/:clientId/grant` adds a
 * workspace or raises the level on the live token rows, so the app's next
 * call with the same bearer (and its next refresh) carries it.
 *
 * Driven over a real OAuth MCP session and the real HTTP routes.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OAuthProvider } from '../../../auth/oauth/provider';
import { hashToken } from '../../../auth/oauth/utils';
import { parsePgTextArray, pgTextArray } from '../../../db/client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOAuthClient,
  createTestOrganization,
  createTestSession,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get, mcpRequest, post as requestPost } from '../../setup/test-helpers';

const MULTI = { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' };

const post = (path: string, options?: Parameters<typeof requestPost>[1]) =>
  requestPost(path, { ...options, headers: { Origin: 'http://localhost', ...options?.headers } });

async function seedLogin() {
  const sql = getTestDb();
  await seedSystemEntityTypes();
  const home = await createTestOrganization({ name: 'Upgrade Home', slug: 'upgrade-home' });
  const other = await createTestOrganization({ name: 'Upgrade Other', slug: 'upgrade-other' });
  const stranger = await createTestOrganization({ name: 'Upgrade Stranger', slug: 'upgrade-stranger' });
  const owner = await createTestUser({ email: 'upgrade-owner@test.example.com' });
  await addUserToOrganization(owner.id, home.id, 'owner');
  await addUserToOrganization(owner.id, other.id, 'member');
  const client = await createTestOAuthClient({
    client_name: 'Upgrade App',
    redirect_uris: ['https://app.example.com/callback'],
  });
  // An account login: no default workspace, one granted workspace.
  const token = 'upgrade-access-token';
  await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      granted_organization_ids, authorization_grant_type, scope, expires_at
    ) VALUES
      ('upgrade-access', 'access', ${hashToken(token)}, ${client.client_id},
       ${owner.id}, NULL, ${pgTextArray([home.id])}::text[], 'authorization_code',
       'mcp:read mcp:write', NOW() + INTERVAL '1 hour'),
      ('upgrade-refresh', 'refresh', ${hashToken('upgrade-refresh-token')}, ${client.client_id},
       ${owner.id}, NULL, ${pgTextArray([home.id])}::text[], 'authorization_code',
       'mcp:read mcp:write', NOW() + INTERVAL '30 days')
  `;
  const { cookieHeader } = await createTestSession(owner.id);
  return { sql, home, other, stranger, owner, client, token, cookie: cookieHeader };
}

async function callTool(token: string, name: string, args: Record<string, unknown>, orgSlug?: string) {
  const response = await mcpRequest<any>('tools/call', { name, arguments: args }, { token, orgSlug });
  const result = response.result as any;
  return {
    result,
    // A JSON-RPC error (for example a dropped session) is not a tool result.
    rpcError: (response as any).error as { message: string } | undefined,
    text: (result?.content ?? []).map((c: any) => c.text ?? '').join('\n') as string,
    fix: result?.structuredContent?.error?.fix as
      | { action: string; url?: string; who: string; workspace: string | null }
      | undefined,
  };
}

const searchIn = (token: string, workspace: string) =>
  callTool(token, 'search_memory', { query: 'upgrade probe', workspace });

describe('login upgrade links', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each([
    {},
    { Origin: 'http://attacker.localhost' },
    { Origin: 'https://attacker.example.com' },
    { Origin: 'null' },
    { Origin: 'not a URL' },
    { Referer: 'http://attacker.localhost/page' },
    { Origin: 'http://attacker.localhost', Referer: 'http://localhost/page' },
    { Origin: 'null', Referer: 'http://localhost/page' },
  ])('rejects a browser grant with untrusted origin headers %j without changing access', async (headers) => {
    const { sql, other, client, cookie } = await seedLogin();
    const before = await sql`
      SELECT id, scope, granted_organization_ids FROM oauth_tokens
      WHERE client_id = ${client.client_id} ORDER BY id
    `;
    const response = await requestPost(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      // A simple cross-origin fetch can send JSON as text/plain, without preflight.
      rawBody: JSON.stringify({ workspace: other.slug, level: 'write' }),
      headers: { 'Content-Type': 'text/plain', ...headers } as Record<string, string>,
      env: MULTI,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'forbidden' });
    const after = await sql`
      SELECT id, scope, granted_organization_ids FROM oauth_tokens
      WHERE client_id = ${client.client_id} ORDER BY id
    `;
    expect(after).toEqual(before);
  });

  it.each<Record<string, string>>([
    { Referer: 'http://localhost/agents/connected' },
    { Origin: 'https://app.example.com', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'app.example.com' },
  ])('accepts a same-origin browser grant with headers %j', async (headers) => {
    const { other, client, cookie } = await seedLogin();
    const response = await requestPost(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: other.slug },
      headers,
      env: MULTI,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: other.slug, updated_tokens: 2 });
  });

  it('reports the older live admin bearer after a refresh narrows the newest grant', async () => {
    const { sql, home, client, cookie } = await seedLogin();
    await sql`
      UPDATE oauth_tokens SET scope = 'mcp:read mcp:write mcp:admin'
      WHERE client_id = ${client.client_id}
    `;
    const refreshed = await new OAuthProvider(sql, undefined, true).refreshAccessToken({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: 'upgrade-refresh-token',
      scope: 'mcp:read',
    });
    expect(refreshed).toMatchObject({ scope: 'mcp:read' });
    const view = await get(`/api/me/logins/${client.client_id}`, { cookie, env: MULTI });
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ level: 'admin', workspaces: [{ id: home.id }] });

    // The consumed admin refresh row is revoked; only its older bearer still carries admin.
    await sql`UPDATE oauth_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE id = 'upgrade-access'`;
    const afterExpiry = await get(`/api/me/logins/${client.client_id}`, { cookie, env: MULTI });
    expect(await afterExpiry.json()).toMatchObject({ level: 'read' });
  });

  it('reports workspaces retained by older tokens after reauthorization selects another workspace', async () => {
    const { sql, home, other, owner, client, cookie } = await seedLogin();
    const provider = new OAuthProvider(sql, 'https://lobu.test', true);
    const verifier = 'synthetic-reauthorization-code-verifier';
    const redirectUri = 'https://app.example.com/callback';
    const code = await provider.createAuthorizationCode({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'mcp:read',
    }, owner.id, null, [other.id]);
    const issued = await provider.exchangeAuthorizationCode({
      grant_type: 'authorization_code', client_id: client.client_id,
      client_secret: client.client_secret, code, code_verifier: verifier, redirect_uri: redirectUri,
    });
    expect(issued).not.toHaveProperty('error');

    const view = await get(`/api/me/logins/${client.client_id}`, { cookie, env: MULTI });
    expect(view.status).toBe(200);
    const body = await view.json();
    expect(body.level).toBe('write');
    expect(body.workspaces.map((workspace: { id: string }) => workspace.id).sort())
      .toEqual([home.id, other.id].sort());
  });

  it('lists all live workspaces when separate grants together exceed the per-grant workspace limit', async () => {
    const { sql, home, other, owner, client, cookie } = await seedLogin();
    const olderIds = [home.id];
    for (let i = 0; i < 49; i++) {
      const workspace = await createTestOrganization({ name: `Retained ${i}`, slug: `retained-${i}` });
      await addUserToOrganization(owner.id, workspace.id, 'member');
      olderIds.push(workspace.id);
    }
    await sql`
      UPDATE oauth_tokens SET granted_organization_ids = ${pgTextArray(olderIds)}::text[]
      WHERE id = 'upgrade-access'
    `;
    await sql`
      UPDATE oauth_tokens SET granted_organization_ids = ${pgTextArray([other.id])}::text[]
      WHERE id = 'upgrade-refresh'
    `;
    const view = await get(`/api/me/logins/${client.client_id}`, { cookie, env: MULTI });
    expect(view.status).toBe(200);
    const body = await view.json();
    expect(body.workspaces.map((workspace: { id: string }) => workspace.id).sort())
      .toEqual([...olderIds, other.id].sort());
  });

  it('links an ungranted workspace to the login page, and the grant reaches the same bearer and its refresh', async () => {
    const { sql, home, other, client, token, cookie } = await seedLogin();

    const denied = await searchIn(token, other.slug);
    expect(denied.result?.isError).toBe(true);
    expect(denied.fix).toMatchObject({ action: 'grant_workspace', who: 'you', workspace: other.slug });
    expect(denied.fix?.url).toContain(`/${other.slug}/agents/connected/${client.client_id}?grant=1`);
    expect(denied.text).toContain(denied.fix?.url);

    // query_sdk reaching the same workspace carries the same structured fix.
    const sdkDenied = await callTool(token, 'query_sdk', {
      script: `export default async (ctx, client) => (await client.org('${other.slug}')).organizations.current();`,
    });
    expect(sdkDenied.result?.structuredContent).toMatchObject({ success: false, error: { fix: denied.fix } });

    const granted = await post(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: other.slug },
      env: MULTI,
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ workspace: other.slug, level: 'write', updated_tokens: 2 });

    // The same MCP session carries on with the wider grant.
    const allowed = await searchIn(token, other.slug);
    expect(allowed.rpcError).toBeUndefined();
    expect(allowed.result?.isError).toBeFalsy();
    expect(allowed.result?.structuredContent).toBeDefined();

    // An older request whose token was read before the widen finishes last:
    // it acts with its own narrower grant and leaves the session in place.
    await sql`UPDATE oauth_tokens SET granted_organization_ids = ${pgTextArray([home.id])}::text[] WHERE id = 'upgrade-access'`;
    const stale = await searchIn(token, other.slug);
    expect(stale.rpcError).toBeUndefined();
    expect(stale.result?.isError).toBe(true);
    await sql`UPDATE oauth_tokens SET granted_organization_ids = ${pgTextArray([home.id, other.id])}::text[] WHERE id = 'upgrade-access'`;
    const after = await searchIn(token, other.slug);
    expect(after.rpcError).toBeUndefined();
    expect(after.result?.isError).toBeFalsy();

    const view = await get(`/api/me/logins/${client.client_id}`, { cookie, env: MULTI });
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({
      client_id: client.client_id,
      app_key: 'web:example.com',
      level: 'write',
      workspaces: [{ slug: 'upgrade-home' }, { slug: other.slug }],
      multiple_workspaces_allowed: true,
    });

    const refreshed = await new OAuthProvider(sql, undefined, true).refreshAccessToken({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: 'upgrade-refresh-token',
    });
    expect(refreshed).not.toHaveProperty('error');
    const [rotated] = await sql`
      SELECT granted_organization_ids FROM oauth_tokens
      WHERE client_id = ${client.client_id} AND token_type = 'refresh' AND revoked_at IS NULL
    `;
    expect(parsePgTextArray(rotated.granted_organization_ids)).toContain(other.id);
  });

  it('keeps one workspace per login when multiple-workspace grants are off', async () => {
    const { other, client, cookie } = await seedLogin();
    const refused = await post(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: other.slug },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'single_workspace_login' });
  });

  it('refuses a raise that would push a pending code past the workspace limit', async () => {
    const { sql, home, other, owner, client, cookie } = await seedLogin();
    const provider = new OAuthProvider(sql, 'https://lobu.test');
    const code = await provider.createAuthorizationCode({
      client_id: client.client_id,
      redirect_uri: 'https://app.example.com/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update('synthetic-pending-code-verifier').digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'mcp:read mcp:write',
    }, owner.id, null, [other.id]);

    const refused = await post(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: home.slug, level: 'admin' },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'single_workspace_login' });
    const [pending] = await sql`
      SELECT scope, granted_organization_ids FROM oauth_authorization_codes WHERE code = ${code}
    `;
    expect(pending.scope).toBe('mcp:read mcp:write');
    expect(parsePgTextArray(pending.granted_organization_ids)).toEqual([other.id]);
  });

  it.each([null, ''])('never lowers a login whose stored scope %j is the default grant', async (scope) => {
    const { sql, home, client, cookie } = await seedLogin();
    await sql`UPDATE oauth_tokens SET scope = ${scope} WHERE client_id = ${client.client_id}`;
    const raised = await post(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: home.slug, level: 'read' },
    });
    expect(raised.status).toBe(200);
    expect(await raised.json()).toMatchObject({ level: 'write' });
    const rows = await sql`SELECT scope FROM oauth_tokens WHERE client_id = ${client.client_id}`;
    expect(rows.map((row) => row.scope)).toEqual([scope, scope]);
  });

  it.each(['refresh', 'refresh_with_requested_scope', 'authorization_code'])('keeps a scope upgrade when %s issuance has already read the old grant', async (kind) => {
    const { sql, home, client, owner, cookie } = await seedLogin();
    const provider = new OAuthProvider(sql, 'https://lobu.test', true);
    const verifier = 'synthetic-login-upgrade-code-verifier';
    const redirectUri = 'https://app.example.com/callback';
    const code = kind === 'authorization_code' ? await provider.createAuthorizationCode({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'mcp:read mcp:write',
    }, owner.id, null, [home.id]) : undefined;

    const waitForIssuers = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await sql`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%SELECT id FROM oauth_clients%FOR UPDATE%'
        `;
        if (row.count >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${count} token issuers`);
    };
    let upgrade: ReturnType<typeof post> | undefined;
    let issuance: ReturnType<typeof provider.refreshAccessToken> | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM oauth_clients WHERE id = ${client.client_id} FOR UPDATE`;
        upgrade = post(`/api/me/logins/${client.client_id}/grant`, {
          cookie, body: { workspace: home.slug, level: 'admin' }, env: MULTI,
        });
        await waitForIssuers(1);
        issuance = kind !== 'authorization_code' ? provider.refreshAccessToken({
          grant_type: 'refresh_token', client_id: client.client_id,
          client_secret: client.client_secret, refresh_token: 'upgrade-refresh-token',
          ...(kind === 'refresh_with_requested_scope' ? { scope: 'mcp:read mcp:write mcp:admin' } : {}),
        }) : provider.exchangeAuthorizationCode({
          grant_type: 'authorization_code', client_id: client.client_id,
          client_secret: client.client_secret, code, code_verifier: verifier, redirect_uri: redirectUri,
        });
        await waitForIssuers(2);
      });
      expect((await upgrade!).status).toBe(200);
      const issued = await issuance!;
      expect(issued).not.toHaveProperty('error');
      expect(issued).toMatchObject({ scope: 'mcp:read mcp:write mcp:admin' });
      const live = await sql`
        SELECT scope FROM oauth_tokens WHERE client_id = ${client.client_id} AND revoked_at IS NULL
      `;
      expect(live.length).toBeGreaterThan(2);
      for (const row of live) expect(row.scope).toBe('mcp:read mcp:write mcp:admin');
    } finally {
      await Promise.allSettled([upgrade, issuance]);
    }
  });


  it('only lets the login owner widen it, from their own web session, within their role', async () => {
    const { home, other, stranger, client, token, cookie } = await seedLogin();
    const grant = (body: Record<string, unknown>, auth: { cookie?: string; token?: string }) =>
      post(`/api/me/logins/${client.client_id}/grant`, { ...auth, body, env: MULTI });

    // The app's own bearer can never widen the login it calls with.
    expect((await grant({ workspace: other.slug }, { token })).status).toBe(403);

    const someone = await createTestUser({ email: 'upgrade-someone@test.example.com' });
    await addUserToOrganization(someone.id, other.id, 'owner');
    const someoneCookie = (await createTestSession(someone.id)).cookieHeader;
    expect((await grant({ workspace: other.slug }, { cookie: someoneCookie })).status).toBe(404);

    const notMember = await grant({ workspace: stranger.slug }, { cookie });
    expect(notMember.status).toBe(403);
    expect(await notMember.json()).toMatchObject({ error: 'not_a_member' });

    const memberAdmin = await grant({ workspace: other.slug, level: 'admin' }, { cookie });
    expect(memberAdmin.status).toBe(403);
    expect(await memberAdmin.json()).toMatchObject({ error: 'admin_role_required' });

    expect((await grant({ workspace: home.slug, level: 'owner' }, { cookie })).status).toBe(400);
  });

  it('links a missing level for an owner, sends a member to an admin, and the raise reaches the same bearer', async () => {
    const { home, other, client, token, cookie } = await seedLogin();
    const installConnector = (orgSlug: string) =>
      callTool(
        token,
        'manage_connections',
        { action: 'install_connector', connector_id: '__nonexistent__' },
        orgSlug
      );

    const ownerDenied = await installConnector(home.slug);
    expect(ownerDenied.fix).toMatchObject({ action: 'raise_access', who: 'you', workspace: home.slug });
    expect(ownerDenied.fix?.url).toContain(
      `/${home.slug}/agents/connected/${client.client_id}?grant=1&level=admin`
    );
    // The REST tool surface carries the same fix beside its error message.
    const rest = await post(`/api/${home.slug}/manage_connections`, {
      token,
      body: { action: 'install_connector', connector_id: '__nonexistent__' },
    });
    const restBody = await rest.json();
    expect(rest.status, JSON.stringify(restBody)).toBe(403);
    expect(restBody.fix).toEqual(ownerDenied.fix);
    expect(restBody.error).toContain(ownerDenied.fix?.url);

    // In a workspace where the person is a member, only an admin can do it.
    await post(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: other.slug },
      env: MULTI,
    });
    const memberDenied = await installConnector(other.slug);
    expect(memberDenied.fix).toEqual({ action: 'ask_admin', who: 'workspace_admin', workspace: other.slug });

    const raised = await post(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: home.slug, level: 'admin' },
      env: MULTI,
    });
    expect(raised.status).toBe(200);
    expect(await raised.json()).toMatchObject({ level: 'admin' });

    const after = await installConnector(home.slug);
    expect(after.rpcError).toBeUndefined();
    expect(after.fix).toBeUndefined();
    expect(after.text).not.toContain('needs admin access');

    // The rotation re-reads the raised scope rather than the one it started from.
    const refreshed = await new OAuthProvider(getTestDb(), undefined, true).refreshAccessToken({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: 'upgrade-refresh-token',
    });
    expect(refreshed).toMatchObject({ scope: expect.stringContaining('mcp:admin') });
  });
});
