import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../oauth/utils';
import { PersonalAccessTokenService } from '../tokens';
import { getTestDb, cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { post } from '../../__tests__/setup/test-helpers';

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
