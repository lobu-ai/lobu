import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { get, postForm } from '../../__tests__/setup/test-helpers';
import { clearAuthCacheForTests } from '../index';
import {
  verifySettingsSessionOrToken,
  verifySettingsToken,
} from '../../gateway/routes/public/settings-auth';

// Two deep-link entry points, two postures:
//   - GET /exchange-token: first-party tab (CLI/menu-bar) → Lax session cookie.
//   - POST /extension-session: the Owletto extension's cross-site iframe
//     (top-level chrome-extension://) can't depend on a cookie, so it gets the
//     raw Better Auth session token in the body and sends it as Bearer.
// See auth/routes.ts.
describe('deep-link token exchange', () => {
  beforeEach(async () => {
    clearAuthCacheForTests();
    await cleanupTestDatabase();
  });
  afterEach(() => clearAuthCacheForTests());

  async function patForNewUser(
    slug: string,
    email: string
  ): Promise<{ token: string; orgId: string }> {
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token } = await createTestPAT(user.id, org.id, { scope: 'profile:read' });
    return { token, orgId: org.id };
  }

  /** The minted session's active org, read back through Better Auth itself. */
  async function activeOrgOf(sessionToken: string): Promise<string | null | undefined> {
    const res = await get('/api/auth/get-session', { token: sessionToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session?: { activeOrganizationId?: string | null };
    };
    return body.session?.activeOrganizationId;
  }

  it('POST /extension-session returns a session token for Bearer use (extension iframe)', async () => {
    const { token, orgId } = await patForNewUser('xt-post-org', 'xt-post@test.example.com');
    const res = await postForm('/api/extension-session', { token });

    expect(res.status).toBe(200);
    // No cookie is set — the iframe authenticates via the returned token.
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = (await res.json()) as { session_token?: string };
    expect(typeof body.session_token).toBe('string');
    const sessionToken = body.session_token ?? '';
    expect(sessionToken.length).toBeGreaterThan(0);
    // The PAT's org becomes the session's active org — the sidebar reads it.
    expect(await activeOrgOf(sessionToken)).toBe(orgId);

    // Third credential shape: exchanging that Better Auth session token itself
    // must carry the active org forward too (menu-bar/local-init hold one).
    const rePaired = await postForm('/api/extension-session', { token: sessionToken });
    expect(rePaired.status).toBe(200);
    const reBody = (await rePaired.json()) as { session_token?: string };
    expect(await activeOrgOf(reBody.session_token ?? '')).toBe(orgId);
  });

  it('POST /extension-session resolves an OAuth device-code access token (cloud pairing path)', async () => {
    // The extension's cloud (OAuth device-code) pairing stores an oauth_tokens
    // access token, NOT an owl_pat_ PAT — the endpoint must resolve it or the
    // cloud iframe 401s and renders signed-out.
    const org = await createTestOrganization({ slug: 'xt-oauth-org' });
    const user = await createTestUser({ email: 'xt-oauth@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'profile:read',
    });
    expect(token.startsWith('owl_pat_')).toBe(false); // genuinely an OAuth access token

    const res = await postForm('/api/extension-session', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token?: string };
    const sessionToken = body.session_token ?? '';
    expect(sessionToken.length).toBeGreaterThan(0);
    expect(await activeOrgOf(sessionToken)).toBe(org.id);
  });

  it('GET /exchange-token keeps a first-party Lax cookie — never Partitioned/None (CLI/menu-bar)', async () => {
    const { token } = await patForNewUser('xt-get-org', 'xt-get@test.example.com');
    const res = await get(`/api/exchange-token?token=${encodeURIComponent(token)}&next=/`);

    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Partitioned/i);
    expect(cookie).not.toMatch(/SameSite=None/i);
  });

  it.each(['development', 'production'])('minted cookie authenticates under %s Node settings on loopback HTTP', async (nodeEnv) => {
    const { token } = await patForNewUser(`cookie-${nodeEnv}`, `cookie-${nodeEnv}@test.example.com`);
    clearAuthCacheForTests();
    try {
      const env = { NODE_ENV: nodeEnv };
      const minted = await get(`/api/exchange-token?token=${encodeURIComponent(token)}&next=/`, { env });
      expect(minted.status).toBe(302);
      const cookie = minted.headers.getSetCookie()
        .filter((value) => !value.includes('Max-Age=0'))
        .map((value) => value.split(';')[0]).join('; ');
      const resolved = await get('/api/auth/get-session', { env, cookie });
      expect(resolved.status).toBe(200);
      expect((await resolved.json())?.user?.email).toBe(`cookie-${nodeEnv}@test.example.com`);
      if (nodeEnv === 'production') {
        expect(cookie.startsWith('__Secure-better-auth.session_token=')).toBe(true);
        expect(minted.headers.get('set-cookie')).toContain('Secure');
      }
    } finally {
      clearAuthCacheForTests();
    }
  });

  // The deep-link cookie must land at the SAME scope Better Auth uses; a
  // host-only twin here locks the user out for good once it goes stale.
  // Why: auth/session-cookie-scope.ts.
  it('GET /exchange-token scopes the cookie to the zone and expires the host-only twin', async () => {
    const previous = process.env.AUTH_COOKIE_DOMAIN;
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    try {
      const { token } = await patForNewUser('xt-zone-org', 'xt-zone@test.example.com');
      const res = await get(`/api/exchange-token?token=${encodeURIComponent(token)}&next=/`);
      expect(res.status).toBe(302);

      const cookies = res.headers.getSetCookie();
      const name = 'better-auth.session_token';
      const setter = cookies.find((c) => c.includes(`${name}=`) && !c.includes('Max-Age=0'));
      const expiry = cookies.find((c) => c.includes(`${name}=;`) && c.includes('Max-Age=0'));

      expect(setter).toBeDefined();
      expect(setter).toContain('Domain=.lobu.ai');
      // The twin-killer must carry NO Domain, or it would delete the real cookie.
      expect(expiry).toBeDefined();
      expect(expiry).not.toMatch(/Domain=/i);
    } finally {
      if (previous === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
      else process.env.AUTH_COOKIE_DOMAIN = previous;
    }
  });

  it('rejects a missing or invalid token', async () => {
    expect((await postForm('/api/extension-session', {})).status).toBe(400);
    expect((await postForm('/api/extension-session', { token: 'owl_pat_nope' })).status).toBe(401);
  });

  it('serves the in-iframe bootstrap page (exchanges the token, strips the fragment)', async () => {
    const res = await get('/api/extension-bootstrap');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/i);
    const html = await res.text();
    expect(html).toContain('/api/extension-session');
    expect(html).toContain('color-scheme');
    expect(html).toContain('#0a0a0a');
    expect(html).toContain('sessionStorage');
    expect(html).toContain('location.hash');
    expect(html).toContain('replaceState');
    // Browser-handoff deep links (sidepanel → conversation or Memory run).
    expect(html).toContain('h.get("run")');
    expect(html).toContain('/#run=');
    expect(html).toContain('h.get("agent")');
    expect(html).toContain('h.get("thread")');
    expect(html).toContain('/#agent=');
    expect(html).toContain('&thread=');
    expect(html).toContain('&message=');
    // Conversation handoff must win over bare run when both are present.
    const agentBranch = html.indexOf('if (agent && thread)');
    const runBranch = html.indexOf('else if (run)');
    expect(agentBranch).toBeGreaterThan(-1);
    expect(runBranch).toBeGreaterThan(agentBranch);
  });

  // The load-bearing claim: the session token from /extension-session, sent as
  // `Authorization: Bearer`, authenticates the user on a real protected route
  // via the same `getSession({ headers })` path the cloud auth bridge uses (the
  // bearer() plugin honours the header). This is what makes the embedded iframe
  // work without a cookie.
  it('Bearer session token authenticates the user on a protected API route (e2e)', async () => {
    const slug = 'xt-bearer-org';
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email: 'xt-bearer@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id, { scope: 'profile:read' });

    // Exchange the extension's deep-link token for a session token.
    const exchange = await postForm('/api/extension-session', { token: pat });
    expect(exchange.status).toBe(200);
    const { session_token: sessionToken } = (await exchange.json()) as {
      session_token: string;
    };
    expect(sessionToken.length).toBeGreaterThan(0);

    // Sent as Bearer, it resolves the user — the org they belong to is returned.
    const authed = await get('/api/organizations', { token: sessionToken });
    expect(authed.status).toBe(200);
    const authedSlugs = ((await authed.json()).organizations as Array<{ slug: string }>).map(
      (o) => o.slug
    );
    expect(authedSlugs).toContain(slug);

    // Without it, the same user-scoped org is not resolved.
    const anon = await get('/api/organizations');
    const anonSlugs = ((await anon.json()).organizations as Array<{ slug: string }>).map(
      (o) => o.slug
    );
    expect(anonSlugs).not.toContain(slug);
  });
});

// EventSource can't send Authorization, so the embedded panel's SSE streams
// authenticate with a short-lived ?token= ticket from /api/sse-ticket. The
// ticket decrypts to the same SettingsSession shape the cookie path yields, so
// the agent-ownership check (verifySettingsSessionOrToken) accepts it.
describe('SSE ticket (/api/sse-ticket)', () => {
  beforeEach(async () => {
    clearAuthCacheForTests();
    await cleanupTestDatabase();
  });
  afterEach(() => clearAuthCacheForTests());

  async function sessionTokenForNewUser(slug: string, email: string): Promise<string> {
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id, { scope: 'profile:read' });
    const exchange = await postForm('/api/extension-session', { token: pat });
    return ((await exchange.json()) as { session_token: string }).session_token;
  }

  it('requires a Bearer token', async () => {
    expect((await get('/api/sse-ticket')).status).toBe(401);
    expect((await get('/api/sse-ticket', { token: 'garbage' })).status).toBe(401);
  });

  it('mints a ticket that decrypts to the user as a first-party-shaped settings session', async () => {
    const sessionToken = await sessionTokenForNewUser(
      'sse-ticket-org',
      'sse-ticket@test.example.com'
    );

    const res = await get('/api/sse-ticket', { token: sessionToken });
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    expect(ticket.length).toBeGreaterThan(0);
    // The ticket never carries the raw session token.
    expect(ticket).not.toContain(sessionToken);

    // It decrypts to the user with platform 'external' — the shape
    // verifyOwnedAgentAccess keys on for the web/cookie path, so the agent
    // stream authorizes the same owner.
    const payload = await verifySettingsToken(ticket);
    expect(payload?.platform).toBe('external');
    expect((payload?.userId ?? '').length).toBeGreaterThan(0);
  });

  it('the ticket authenticates through the gate the agent SSE route uses', async () => {
    const sessionToken = await sessionTokenForNewUser(
      'sse-gate-org',
      'sse-gate@test.example.com'
    );
    const { ticket } = (await (
      await get('/api/sse-ticket', { token: sessionToken })
    ).json()) as { ticket: string };

    // Mirror the agent-events ownership gate verbatim: verifySettingsSessionOrToken(c,'token').
    const probe = new Hono();
    probe.get('/probe', async (c) => {
      const s = await verifySettingsSessionOrToken(c, 'token');
      return c.json({ userId: s?.userId ?? null, platform: s?.platform ?? null });
    });

    const withTicket = (await (
      await probe.fetch(
        new Request(`http://localhost/probe?token=${encodeURIComponent(ticket)}`)
      )
    ).json()) as { userId: string | null; platform: string | null };
    expect(withTicket.userId).toBeTruthy();
    expect(withTicket.platform).toBe('external');

    // No ?token → the gate resolves no session (would deny ownership).
    const without = (await (
      await probe.fetch(new Request('http://localhost/probe'))
    ).json()) as { userId: string | null };
    expect(without.userId).toBeNull();
  });

  it('serves the bootstrap page with retry-on-failure handling (no silent redirect)', async () => {
    const res = await get('/api/extension-bootstrap');
    const html = await res.text();
    // On exchange failure it surfaces an error + Retry instead of redirecting
    // to a token-less app (which would just hang on a spinner).
    expect(html).toContain('owl-retry');
    expect(html).toContain('function fail');
  });
});
