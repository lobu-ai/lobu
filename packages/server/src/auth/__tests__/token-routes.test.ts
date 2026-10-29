import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../oauth/utils';
import { PersonalAccessTokenService } from '../tokens';
import { getTestDb, cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestSession,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { del, get, post, postForm } from '../../__tests__/setup/test-helpers';
import { clearAuthCacheForTests } from '../index';

describe('org-scoped token creation route', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('lets an org owner with OAuth mcp:admin create a server PAT', async () => {
    const org = await createTestOrganization({ slug: 'token-route-org' });
    const user = await createTestUser({ email: 'token-owner@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token: oauthToken } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin profile:read',
    });

    const response = await post(`/api/${org.slug}/tokens`, {
      token: oauthToken,
      body: {
        name: 'prod-server',
        description: 'server token created from CLI OAuth login',
        scope: 'mcp:read mcp:write',
        expiresInDays: 30,
      },
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.token.token).toMatch(/^owl_pat_/);
    expect(body.token.name).toBe('prod-server');
    expect(body.token.scope).toBe('mcp:read mcp:write');
    expect(body.token.expires_at).toBeTruthy();

    const verified = await new PersonalAccessTokenService(getTestDb()).verify(body.token.token);
    expect(verified?.userId).toBe(user.id);
    expect(verified?.organizationId).toBe(org.id);
    expect(verified?.scopes).toEqual(['mcp:read', 'mcp:write']);
  });

  it('defaults an unscoped PAT to mcp scopes without connections:token and audits the mint', async () => {
    // connections:token mints managed-connector tokens; a broad PAT created
    // without an explicit scope must never carry it.
    const org = await createTestOrganization({ slug: 'token-default-scope' });
    const user = await createTestUser({ email: 'token-default@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token: oauthToken } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    const response = await post(`/api/${org.slug}/tokens`, {
      token: oauthToken,
      body: { name: 'default-scope-pat' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: { id: number; token: string; scope: string | null };
    };
    expect((body.token.scope ?? '').split(' ')).not.toContain('connections:token');

    // The STORED scope is what the connection-token endpoint introspects.
    const sql = getTestDb();
    const [row] = await sql<{ scope: string | null }[]>`
      SELECT scope FROM personal_access_tokens
      WHERE token_hash = ${hashToken(body.token.token)}
    `;
    const storedScopes = (row?.scope ?? '').split(' ').filter(Boolean);
    expect(storedScopes).not.toContain('connections:token');
    expect(storedScopes).toEqual(expect.arrayContaining(['mcp:read', 'mcp:write']));

    // The mint lands in the workspace audit trail, attributed to its creator.
    let audit: Array<{ organization_id: string; created_by: string | null }> = [];
    for (let i = 0; i < 60 && audit.length === 0; i++) {
      audit = (await sql`
        SELECT organization_id, created_by FROM events
        WHERE origin_type = 'access_token_created'
          AND metadata->>'entity_id' = ${String(body.token.id)}
      `) as unknown as typeof audit;
      if (audit.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(audit).toEqual([{ organization_id: org.id, created_by: user.id }]);
  });

  it('lets an org owner mint a connections:token PAT (managed-connector token fetch)', async () => {
    const org = await createTestOrganization({ slug: 'token-conn-scope' });
    const user = await createTestUser({ email: 'token-conn@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token: oauthToken } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin profile:read',
    });

    const response = await post(`/api/${org.slug}/tokens`, {
      token: oauthToken,
      body: { name: 'cloud-pat', scope: 'connections:token' },
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.token.scope).toBe('connections:token');
    const verified = await new PersonalAccessTokenService(getTestDb()).verify(body.token.token);
    expect(verified?.scopes).toEqual(['connections:token']);
  });

  it('rejects OAuth tokens without mcp:admin scope', async () => {
    const org = await createTestOrganization({ slug: 'token-no-admin-scope' });
    const user = await createTestUser({ email: 'token-no-admin@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token: oauthToken } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write profile:read',
    });

    const response = await post(`/api/${org.slug}/tokens`, {
      token: oauthToken,
      body: { name: 'should-not-create' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Token creation requires mcp:admin scope',
    });
  });

  it('rejects creating a PAT from an existing PAT', async () => {
    const org = await createTestOrganization({ slug: 'token-from-pat' });
    const user = await createTestUser({ email: 'token-pat@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id);

    const response = await post(`/api/${org.slug}/tokens`, {
      token: pat,
      body: { name: 'should-not-create' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Use `lobu login` with OAuth or a web session to create server tokens',
    });
  });
});

describe('org-scoped token list and revoke routes', () => {
  beforeEach(async () => {
    clearAuthCacheForTests();
    await cleanupTestDatabase();
  });
  afterEach(() => clearAuthCacheForTests());

  type Member = { userId: string; cookie: string };
  type Workspace = { orgId: string; slug: string; owner: Member; admin: Member; member: Member };

  async function seedMember(orgId: string, slug: string, role: string): Promise<Member> {
    const user = await createTestUser({ email: `${slug}-${role}@test.example.com` });
    await addUserToOrganization(user.id, orgId, role);
    const session = await createTestSession(user.id);
    return { userId: user.id, cookie: session.cookieHeader };
  }

  async function seedWorkspace(slug: string): Promise<Workspace> {
    const org = await createTestOrganization({ slug });
    return {
      orgId: org.id,
      slug: org.slug,
      owner: await seedMember(org.id, slug, 'owner'),
      admin: await seedMember(org.id, slug, 'admin'),
      member: await seedMember(org.id, slug, 'member'),
    };
  }

  async function mint(userId: string, orgId: string, name: string, scope = 'mcp:read') {
    const created = await new PersonalAccessTokenService(getTestDb()).create(userId, orgId, name, {
      description: `${name} description`,
      scope,
    });
    return { id: String(created.id), token: created.token };
  }

  async function revokedAt(id: string): Promise<Date | null> {
    const rows = await getTestDb()`SELECT revoked_at FROM personal_access_tokens WHERE id = ${id}`;
    return (rows[0]?.revoked_at as Date | null) ?? null;
  }

  async function revokedAuditRows(id: string): Promise<Array<{ created_by: string | null }>> {
    // The lifecycle write is fire-and-forget; give it a moment to land.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = (await getTestDb()`
        SELECT created_by FROM events
        WHERE origin_type = 'access_token_deleted' AND metadata->>'entity_id' = ${id}
      `) as unknown as Array<{ created_by: string | null }>;
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [];
  }

  it('lists only the caller\'s own unrevoked tokens in this org, without the secret', async () => {
    const ws = await seedWorkspace('pat-list-ws');
    const other = await createTestOrganization({ slug: 'pat-list-other' });
    await addUserToOrganization(ws.member.userId, other.id, 'member');

    const mine = await mint(ws.member.userId, ws.orgId, 'mine');
    const gone = await mint(ws.member.userId, ws.orgId, 'gone');
    await getTestDb()`UPDATE personal_access_tokens SET revoked_at = NOW() WHERE id = ${gone.id}`;
    await mint(ws.member.userId, other.id, 'other-org');
    await mint(ws.admin.userId, ws.orgId, 'someone-else');

    const res = await get(`/api/${ws.slug}/tokens`, { cookie: ws.member.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    expect(body.tokens.map((t) => String(t.id))).toEqual([mine.id]);
    expect(Object.keys(body.tokens[0] ?? {}).sort()).toEqual(
      [
        'created_at',
        'description',
        'expires_at',
        'id',
        'last_used_at',
        'name',
        'scope',
        'token_prefix',
      ].sort()
    );
    expect(body.tokens[0]).toMatchObject({ name: 'mine', scope: 'mcp:read' });
    expect(JSON.stringify(body)).not.toContain(mine.token);

    // A bearer lists the same set.
    const viaBearer = await get(`/api/${ws.slug}/tokens`, { token: mine.token });
    expect(viaBearer.status).toBe(200);
    const bearerBody = (await viaBearer.json()) as { tokens: Array<{ id: unknown }> };
    expect(bearerBody.tokens.map((t) => String(t.id))).toEqual([mine.id]);
  });

  it('omits expired tokens from the list but keeps never-expiring and future-expiring ones', async () => {
    const ws = await seedWorkspace('pat-list-expiry');
    const never = await mint(ws.member.userId, ws.orgId, 'never');
    const future = await mint(ws.member.userId, ws.orgId, 'future');
    const expired = await mint(ws.member.userId, ws.orgId, 'expired');
    const sql = getTestDb();
    await sql`UPDATE personal_access_tokens SET expires_at = NOW() + INTERVAL '1 day' WHERE id = ${future.id}`;
    await sql`UPDATE personal_access_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${expired.id}`;

    const res = await get(`/api/${ws.slug}/tokens`, { cookie: ws.member.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<{ id: unknown; expires_at: unknown }> };
    const byId = new Map(body.tokens.map((t) => [String(t.id), t]));
    expect([...byId.keys()].sort()).toEqual([never.id, future.id].sort());
    expect(byId.get(never.id)?.expires_at).toBeNull();
    expect(byId.get(future.id)?.expires_at).toBeTruthy();
  });

  it('still revokes an expired, unrevoked token by id', async () => {
    const ws = await seedWorkspace('pat-revoke-expired');
    const expired = await mint(ws.member.userId, ws.orgId, 'expired');
    await getTestDb()`UPDATE personal_access_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${expired.id}`;

    const res = await del(`/api/${ws.slug}/tokens/${expired.id}`, { cookie: ws.member.cookie });
    expect(res.status).toBe(200);
    expect(await revokedAt(expired.id)).not.toBeNull();
  });

  it('lets the owner revoke their own token with a web session, and the token then gets 401', async () => {
    const ws = await seedWorkspace('pat-revoke-session');
    const pat = await mint(ws.member.userId, ws.orgId, 'cli');
    expect((await get(`/api/${ws.slug}/tokens`, { token: pat.token })).status).toBe(200);

    const res = await del(`/api/${ws.slug}/tokens/${pat.id}`, { cookie: ws.member.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean; id: unknown };
    expect(body.revoked).toBe(true);
    expect(String(body.id)).toBe(pat.id);
    expect(await revokedAt(pat.id)).not.toBeNull();
    expect(await revokedAuditRows(pat.id)).toEqual([{ created_by: ws.member.userId }]);

    expect((await get(`/api/${ws.slug}/tokens`, { token: pat.token })).status).toBe(401);
  });

  it('lets the owner revoke a token with any of their own bearer tokens, including itself', async () => {
    const ws = await seedWorkspace('pat-revoke-bearer');
    const keep = await mint(ws.member.userId, ws.orgId, 'keep');
    const drop = await mint(ws.member.userId, ws.orgId, 'drop');

    const viaOther = await del(`/api/${ws.slug}/tokens/${drop.id}`, { token: keep.token });
    expect(viaOther.status).toBe(200);
    expect(await revokedAt(drop.id)).not.toBeNull();

    const viaSelf = await del(`/api/${ws.slug}/tokens/${keep.id}`, { token: keep.token });
    expect(viaSelf.status).toBe(200);
    expect(await revokedAt(keep.id)).not.toBeNull();
    expect((await get(`/api/${ws.slug}/tokens`, { token: keep.token })).status).toBe(401);
  });

  it.each(['owner', 'admin'] as const)(
    'lets an org %s web session revoke a member\'s token',
    async (role) => {
      const ws = await seedWorkspace(`pat-revoke-${role}`);
      const pat = await mint(ws.member.userId, ws.orgId, 'member-token');

      const res = await del(`/api/${ws.slug}/tokens/${pat.id}`, { cookie: ws[role].cookie });
      expect(res.status).toBe(200);
      expect(await revokedAt(pat.id)).not.toBeNull();
      expect(await revokedAuditRows(pat.id)).toEqual([{ created_by: ws[role].userId }]);
      expect((await get(`/api/${ws.slug}/tokens`, { token: pat.token })).status).toBe(401);
    }
  );

  it('refuses a member revoking someone else\'s token', async () => {
    const ws = await seedWorkspace('pat-revoke-peer');
    const peer = await seedMember(ws.orgId, 'pat-revoke-peer-2', 'member');
    const pat = await mint(peer.userId, ws.orgId, 'peer-token');

    const res = await del(`/api/${ws.slug}/tokens/${pat.id}`, { cookie: ws.member.cookie });
    expect(res.status).toBe(403);
    expect(await revokedAt(pat.id)).toBeNull();
  });

  it('never treats an admin\'s bearer or token-derived session as an admin web session', async () => {
    const ws = await seedWorkspace('pat-revoke-derived');
    const target = await mint(ws.member.userId, ws.orgId, 'member-token');
    const adminPat = await mint(ws.admin.userId, ws.orgId, 'admin-pat', 'mcp:admin profile:read');

    const viaBearer = await del(`/api/${ws.slug}/tokens/${target.id}`, { token: adminPat.token });
    expect(viaBearer.status).toBe(403);

    const exchanged = await postForm('/api/extension-session', { token: adminPat.token });
    expect(exchanged.status).toBe(200);
    const sessionToken = ((await exchanged.json()) as { session_token?: string }).session_token;
    expect(sessionToken).toBeTruthy();
    const viaDerived = await del(`/api/${ws.slug}/tokens/${target.id}`, { token: sessionToken });
    expect(viaDerived.status).toBe(403);

    expect(await revokedAt(target.id)).toBeNull();

    // The derived session still counts as the admin's own: it may revoke their token.
    const own = await del(`/api/${ws.slug}/tokens/${adminPat.id}`, { token: sessionToken });
    expect(own.status).toBe(200);
  });

  it('answers 404 for a token in another org, an unknown id, and a second revoke', async () => {
    const ws = await seedWorkspace('pat-revoke-404');
    const other = await createTestOrganization({ slug: 'pat-revoke-404-other' });
    await addUserToOrganization(ws.owner.userId, other.id, 'owner');
    const elsewhere = await mint(ws.owner.userId, other.id, 'elsewhere');

    const crossOrg = await del(`/api/${ws.slug}/tokens/${elsewhere.id}`, { cookie: ws.owner.cookie });
    expect(crossOrg.status).toBe(404);
    expect(await revokedAt(elsewhere.id)).toBeNull();

    expect((await del(`/api/${ws.slug}/tokens/999999999`, { cookie: ws.owner.cookie })).status).toBe(404);
    expect((await del(`/api/${ws.slug}/tokens/not-a-number`, { cookie: ws.owner.cookie })).status).toBe(404);

    const pat = await mint(ws.owner.userId, ws.orgId, 'twice');
    expect((await del(`/api/${ws.slug}/tokens/${pat.id}`, { cookie: ws.owner.cookie })).status).toBe(200);
    expect((await del(`/api/${ws.slug}/tokens/${pat.id}`, { cookie: ws.owner.cookie })).status).toBe(404);
    expect(await revokedAuditRows(pat.id)).toHaveLength(1);
  });
});
