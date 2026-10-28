import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestSession,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { get, post, postForm } from '../../__tests__/setup/test-helpers';
import { clearAuthCacheForTests } from '../index';
import { HUMAN_MINTED_PAT_SCOPES } from '../oauth/scopes';

// A token-holder can turn an `mcp:admin` PAT or device-code grant into a web
// session (`canMintWebSession`). That session must not then mint a scope only a
// person may grant, or an agent holding the token escalates past the human
// gate on POST /api/:org/tokens. A person's own sign-in still can.
describe('human-minted PAT scopes require an interactive web session', () => {
  beforeEach(async () => {
    clearAuthCacheForTests();
    await cleanupTestDatabase();
  });
  afterEach(() => clearAuthCacheForTests());

  type Owner = { userId: string; orgId: string; slug: string };

  async function seedOwner(slug: string): Promise<Owner> {
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email: `${slug}@test.example.com` });
    await addUserToOrganization(user.id, org.id, 'owner');
    return { userId: user.id, orgId: org.id, slug: org.slug };
  }

  async function adminPat(owner: Owner): Promise<string> {
    return (await createTestPAT(owner.userId, owner.orgId, { scope: 'mcp:admin profile:read' })).token;
  }

  async function adminDeviceGrant(owner: Owner): Promise<string> {
    const client = await createTestOAuthClient();
    // A private scope makes the fixture record this as a device_code grant.
    return (
      await createTestAccessToken(owner.userId, owner.orgId, client.client_id, {
        scope: 'mcp:admin device_worker:run profile:read',
        grantedOrganizationIds: [owner.orgId],
      })
    ).token;
  }

  async function bearerSession(token: string): Promise<{ token: string }> {
    const res = await postForm('/api/extension-session', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token?: string };
    expect(body.session_token).toBeTruthy();
    return { token: body.session_token ?? '' };
  }

  async function cookieSession(token: string): Promise<{ cookie: string }> {
    const res = await get(`/api/exchange-token?token=${encodeURIComponent(token)}&next=/`);
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';', 1)[0] ?? '';
    expect(cookie).toContain('session_token=');
    return { cookie };
  }

  async function chromeSiblingSession(owner: Owner): Promise<{ token: string }> {
    // The child mint lands in the device's home workspace: the personal org.
    await getTestDb()`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: owner.userId })}
      WHERE id = ${owner.orgId}
    `;
    const res = await post('/api/me/devices/mint-child-token', {
      token: await adminDeviceGrant(owner),
      body: { platform: 'chrome-extension', label: 'synthetic-chrome' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token?: string | null };
    expect(body.session_token).toBeTruthy();
    return { token: body.session_token ?? '' };
  }

  function mintPat(owner: Owner, auth: { token: string } | { cookie: string }, scope: string) {
    return post(`/api/${owner.slug}/tokens`, {
      ...auth,
      body: { name: `synthetic ${scope}`, scope },
    });
  }

  const tokenDerivedSessions: Array<[string, (owner: Owner) => Promise<{ token: string } | { cookie: string }>]> = [
    ['an mcp:admin PAT exchanged at /extension-session', async (o) => bearerSession(await adminPat(o))],
    ['an mcp:admin device-code grant exchanged at /extension-session', async (o) => bearerSession(await adminDeviceGrant(o))],
    ['an mcp:admin PAT exchanged at /exchange-token', async (o) => cookieSession(await adminPat(o))],
    [
      'a token-derived session re-exchanged at /exchange-token',
      async (o) => cookieSession((await bearerSession(await adminPat(o))).token),
    ],
    ['the Chrome sibling session from /me/devices/mint-child-token', chromeSiblingSession],
  ];

  describe.each(HUMAN_MINTED_PAT_SCOPES.map((scope) => [scope]))('%s', (scope) => {
    it.each(tokenDerivedSessions)('refuses a session derived from %s', async (_label, derive) => {
      const owner = await seedOwner('hm-derived');
      const auth = await derive(owner);

      const refused = await mintPat(owner, auth, scope);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error?: string }).error).toContain(scope);
      const rows = await getTestDb()`
        SELECT 1 FROM personal_access_tokens WHERE user_id = ${owner.userId} AND ${scope} = ANY(string_to_array(scope, ' '))
      `;
      expect(rows).toHaveLength(0);

      // The session is still a working web session for everything else.
      const ordinary = await mintPat(owner, auth, 'mcp:read');
      expect(ordinary.status).toBe(201);
    });

    it('lets an interactive sign-in mint it, directly and after a deep-link hop', async () => {
      const owner = await seedOwner('hm-human');
      const signedIn = await createTestSession(owner.userId);

      const direct = await mintPat(owner, { cookie: signedIn.cookieHeader }, scope);
      expect(direct.status).toBe(201);
      const minted = (await direct.json()) as { token?: { scope?: string } };
      expect(minted.token?.scope).toBe(scope);

      // Re-exchanging a person's own session token keeps it a person's session.
      const hopped = await cookieSession(signedIn.token);
      expect((await mintPat(owner, hopped, scope)).status).toBe(201);
    });
  });
});
