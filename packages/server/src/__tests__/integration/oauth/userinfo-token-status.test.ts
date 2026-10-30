/**
 * `/oauth/userinfo` distinguishes invalid credentials (401) from valid
 * credentials that lack `profile:read` (403).
 */

import { APIError } from 'better-auth';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../../auth/index';
import { OAuthClientsStore } from '../../../auth/oauth/clients';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { hashToken } from '../../../auth/oauth/utils';
import { PersonalAccessTokenService } from '../../../auth/tokens';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

async function userinfo(
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', oauthRoutes);
  const headers: Record<string, string> = { ...extraHeaders };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  return app.fetch(
    new Request('http://localhost/oauth/userinfo', { headers }),
    TEST_ENV
  );
}

async function markPersonalOrg(orgId: string, userId: string): Promise<void> {
  const sql = getDb();
  const metadata = JSON.stringify({ personal_org_for_user_id: userId });
  await sql`
    UPDATE "organization"
    SET metadata = ${metadata}
    WHERE id = ${orgId}
  `;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

describe('/oauth/userinfo token status', () => {
  let personalOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let teamOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const sql = getDb();
    personalOrg = await createTestOrganization({ name: 'Alpha Personal Org' });
    teamOrg = await createTestOrganization({ name: 'Beta Team Org' });
    user = await createTestUser({ name: 'Userinfo Status User' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    await addUserToOrganization(user.id, teamOrg.id, 'member');
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
        ${id}, 'access', ${hashToken(id)}, ${client.client_id}, ${user.id}, ${personalOrg.id},
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

  it('returns the bound personal workspace for a PAT carrying mcp:* and profile:read', async () => {
    const sql = getDb();
    const pat = await new PersonalAccessTokenService(sql).create(
      user.id,
      personalOrg.id,
      'local-init',
      { scope: 'device_worker:run mcp:read mcp:write mcp:admin profile:read' }
    );

    const res = await userinfo(pat.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sub: string;
      organization_slug: string | null;
      personal_org_slug: string | null;
      organizations: Array<{ id: string; slug: string; name: string; personal: boolean }>;
    };
    expect(body.sub).toBe(user.id);
    expect(body.organization_slug).toBe(personalOrg.slug);
    expect(body.personal_org_slug).toBe(personalOrg.slug);
    expect(body.organizations).toEqual([
      {
        id: personalOrg.id,
        slug: personalOrg.slug,
        name: personalOrg.name,
        personal: true,
      },
    ]);
  });

  it('scopes PAT userinfo to its bound team workspace and omits ungranted personal_org_slug', async () => {
    const sql = getDb();
    const pat = await new PersonalAccessTokenService(sql).create(
      user.id,
      teamOrg.id,
      'team-pat',
      { scope: 'mcp:read profile:read' }
    );

    const res = await userinfo(pat.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organization_slug: string | null;
      personal_org_slug: string | null;
      organizations: Array<{ id: string; slug: string; name: string; personal: boolean }>;
    };
    expect(body.organization_slug).toBe(teamOrg.slug);
    expect(body.personal_org_slug).toBeNull();
    expect(body.organizations).toEqual([
      {
        id: teamOrg.id,
        slug: teamOrg.slug,
        name: teamOrg.name,
        personal: false,
      },
    ]);
  });

  it('scopes PAT userinfo to its bound team workspace even without mcp:* scopes', async () => {
    const sql = getDb();
    const pat = await new PersonalAccessTokenService(sql).create(
      user.id,
      teamOrg.id,
      'team-profile-only-pat',
      { scope: 'profile:read' }
    );

    const res = await userinfo(pat.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organization_slug: string | null;
      personal_org_slug: string | null;
      organizations: Array<{ id: string; slug: string; name: string; personal: boolean }>;
    };
    expect(body.organization_slug).toBe(teamOrg.slug);
    expect(body.personal_org_slug).toBeNull();
    expect(body.organizations).toEqual([
      {
        id: teamOrg.id,
        slug: teamOrg.slug,
        name: teamOrg.name,
        personal: false,
      },
    ]);
  });

  it('drops the bound PAT workspace when the user is no longer a live member', async () => {
    const sql = getDb();
    const pat = await new PersonalAccessTokenService(sql).create(
      user.id,
      teamOrg.id,
      'former-member-pat',
      { scope: 'mcp:read profile:read' }
    );
    await sql`
      DELETE FROM "member"
      WHERE "userId" = ${user.id} AND "organizationId" = ${teamOrg.id}
    `;

    const res = await userinfo(pat.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organization_slug: string | null;
      personal_org_slug: string | null;
      organizations: unknown[];
    };
    expect(body.organization_slug).toBeNull();
    expect(body.personal_org_slug).toBeNull();
    expect(body.organizations).toEqual([]);
  });

  it('accepts a Better Auth bearer session token and lists live member workspaces', async () => {
    const session = await createTestSession(user.id);

    const res = await userinfo(session.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sub: string;
      email: string;
      organization_slug: string | null;
      personal_org_slug: string | null;
      organizations: Array<{ id: string; slug: string; name: string; personal: boolean }>;
    };
    expect(body.sub).toBe(user.id);
    expect(body.email).toBe(user.email);
    expect(body.organization_slug).toBe(personalOrg.slug);
    expect(body.personal_org_slug).toBe(personalOrg.slug);
    expect(body.organizations).toEqual([
      {
        id: personalOrg.id,
        slug: personalOrg.slug,
        name: personalOrg.name,
        personal: true,
      },
      {
        id: teamOrg.id,
        slug: teamOrg.slug,
        name: teamOrg.name,
        personal: false,
      },
    ]);
  });

  it.each([401, 500] as const)('preserves session lookup error status %s', async (status) => {
    const auth = await createAuth(TEST_ENV);
    const getSession = vi.spyOn(auth.api, 'getSession').mockRejectedValueOnce(
      new APIError(status, { message: 'Synthetic session lookup failure' })
    );
    try {
      const res = await userinfo('session-lookup-failure');
      expect(res.status).toBe(status);
    } finally {
      getSession.mockRestore();
    }
  });

  it('rejects an expired Better Auth bearer session token and never falls back to Cookie auth', async () => {
    const sql = getDb();
    const liveSession = await createTestSession(user.id);
    const expiredSession = await createTestSession(user.id);
    await sql`
      UPDATE "session"
      SET "expiresAt" = NOW() - INTERVAL '1 minute'
      WHERE id = ${expiredSession.sessionId}
    `;

    const expiredRes = await userinfo(expiredSession.token);
    expect(expiredRes.status).toBe(401);
    expect(((await expiredRes.json()) as { error: string }).error).toBe('invalid_token');

    const cookieOnlyRes = await userinfo(undefined, { Cookie: liveSession.cookieHeader });
    expect(cookieOnlyRes.status).toBe(401);
    expect(((await cookieOnlyRes.json()) as { error: string }).error).toBe('invalid_request');

    const cookiePlusBadBearer = await userinfo('userinfo-never-issued', {
      Cookie: liveSession.cookieHeader,
    });
    expect(cookiePlusBadBearer.status).toBe(401);
    expect(((await cookiePlusBadBearer.json()) as { error: string }).error).toBe('invalid_token');
  });
});
