/**
 * `/oauth/userinfo` distinguishes invalid credentials (401) from valid
 * credentials that lack `profile:read` (403).
 */

import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OAuthClientsStore } from '../../../auth/oauth/clients';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { hashToken } from '../../../auth/oauth/utils';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

async function userinfo(token: string): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', oauthRoutes);
  return app.fetch(
    new Request('http://localhost/oauth/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    TEST_ENV
  );
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

describe('/oauth/userinfo token status', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    const sql = getDb();
    const org = await createTestOrganization({ name: 'Userinfo Status Org' });
    const user = await createTestUser({ name: 'Userinfo Status User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await new OAuthClientsStore(sql).registerClient({
      client_name: 'Userinfo Status Client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    const hour = 60 * 60 * 1000;
    const token = (id: string, scope: string, expiresAt: Date, revokedAt: Date | null) => sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        authorization_grant_type, scope, expires_at, revoked_at
      ) VALUES (
        ${id}, 'access', ${hashToken(id)}, ${client.client_id}, ${user.id}, ${org.id},
        'authorization_code', ${scope}, ${expiresAt}, ${revokedAt}
      )
    `;
    const later = new Date(Date.now() + hour);
    await token('userinfo-valid', 'mcp:read profile:read', later, null);
    await token('userinfo-expired', 'mcp:read profile:read', new Date(Date.now() - 60_000), null);
    await token('userinfo-revoked', 'mcp:read profile:read', later, new Date());
    await token('userinfo-no-profile', 'mcp:read', later, null);
  });

  it('returns the profile for a live token with profile:read', async () => {
    const res = await userinfo('userinfo-valid');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBeTruthy();
  });

  it.each([
    ['expired', 'userinfo-expired'],
    ['revoked', 'userinfo-revoked'],
    ['unknown', 'userinfo-never-issued'],
  ])('returns 401 invalid_token for a %s token', async (_kind, token) => {
    const res = await userinfo(token);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
  });

  it('returns 403 insufficient_scope for a live token without profile:read', async () => {
    const res = await userinfo('userinfo-no-profile');
    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="profile:read"'
    );
    expect(((await res.json()) as { error: string }).error).toBe('insufficient_scope');
  });
});
