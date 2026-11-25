/**
 * A connected app's login is widened by its owner from the Lobu web app, not
 * by reconnecting: a denial the person could lift carries a link to the
 * login's page (`fix.url`), and `POST /api/me/logins/:clientId/grant` adds a
 * workspace or raises the level on the live token rows, so the app's next
 * call with the same bearer (and its next refresh) carries it.
 *
 * Driven over a real OAuth MCP session and the real HTTP routes.
 */
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
import { get, mcpRequest, post } from '../../setup/test-helpers';

const MULTI = { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' };

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

  it('links an ungranted workspace to the login page, and the grant reaches the same bearer and its refresh', async () => {
    const { sql, other, client, token, cookie } = await seedLogin();

    const denied = await searchIn(token, other.slug);
    expect(denied.result?.isError).toBe(true);
    expect(denied.fix).toMatchObject({ action: 'grant_workspace', who: 'you', workspace: other.slug });
    expect(denied.fix?.url).toContain(`/${other.slug}/agents/connected/${client.client_id}?grant=1`);
    expect(denied.text).toContain(denied.fix?.url);

    const granted = await post(`/api/me/logins/${client.client_id}/grant`, {
      cookie,
      body: { workspace: other.slug },
      env: MULTI,
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ workspace: other.slug, level: 'write', updated_tokens: 2 });

    const allowed = await searchIn(token, other.slug);
    expect(allowed.result?.isError).toBeFalsy();

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
    expect(after.fix).toBeUndefined();
    expect(after.text).not.toContain('needs admin access');
  });
});
