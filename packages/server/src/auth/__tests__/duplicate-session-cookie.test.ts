import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { get } from '../../__tests__/setup/test-helpers';
import { clearAuthCacheForTests } from '../index';

/**
 * End-to-end cover for the session-cookie login-brick class: a duplicated jar
 * must authenticate on merit, while a single correctly signed cookie whose DB
 * row is gone must be expired on the wire. Mechanisms: Better Auth's
 * get-session handler plus ../resolve-session.ts and ../session-cookie-scope.ts.
 *
 * Runs through the real app stack, so it also pins that the middleware, the
 * route and Better Auth agree — which a unit test cannot show.
 */
describe('duplicate session cookies', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  /**
   * Mint a real, correctly-signed session cookie the way a browser would get
   * one, and return both the cookie name and its signed value. Called twice
   * with the same PAT it mints two independent sessions.
   *
   * The name comes back off the wire rather than from a literal: this harness
   * speaks plain HTTP, so Better Auth drops the `__Secure-` prefix that prod
   * carries, and a hardcoded spelling would pin the wrong one. See
   * docs/GOTCHAS.md, Testing.
   */
  async function exchangeForSessionCookie(pat: string): Promise<{ name: string; value: string }> {
    const res = await get(`/api/exchange-token?token=${encodeURIComponent(pat)}&next=/`);
    expect(res.status).toBe(302);

    const setCookie = res.headers
      .getSetCookie()
      .find((c) => /^(?:__Secure-)?better-auth\.session_token=[^;]/.test(c));
    expect(setCookie, 'exchange-token must set a session cookie').toBeTruthy();

    const [pair] = (setCookie as string).split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  }

  /** Provision an org, an owner and a PAT, then exchange it for a cookie. */
  async function realSessionCookie(
    slug: string,
    email: string
  ): Promise<{ name: string; value: string }> {
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id, { scope: 'mcp:admin profile:read' });

    return await exchangeForSessionCookie(pat);
  }

  async function orgSlugsFor(cookie: string): Promise<string[]> {
    const res = await get('/api/organizations', { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: Array<{ slug: string }> };
    return body.organizations.map((o) => o.slug);
  }

  function rawSessionToken(signedCookieValue: string): string {
    // Split on the LAST dot, the way better-call itself does: the signed value
    // is `<token>.<signature>`, so splitting on the first would truncate any
    // token that happens to contain one.
    const signed = decodeURIComponent(signedCookieValue);
    return signed.slice(0, signed.lastIndexOf('.'));
  }

  async function getSession(cookie?: string): Promise<{
    body: unknown;
    setCookies: string[];
  }> {
    const res = await get('/api/auth/get-session', cookie ? { cookie } : undefined);
    expect(res.status).toBe(200);
    return { body: await res.json(), setCookies: res.headers.getSetCookie() };
  }

  function sessionExpiries(setCookies: string[], name: string): string[] {
    return setCookies.filter(
      (cookie) => cookie.startsWith(`${name}=;`) && /Max-Age=0/i.test(cookie)
    );
  }

  // Garbage values that are syntactically plausible signed cookies — a 44-char
  // base64 signature, which is the shape better-call checks before it verifies
  // anything — but cannot pass the HMAC. Exactly what a stale twin looks like
  // once its session is revoked. Both must fail on the signature, not on shape,
  // or "every candidate is dead" would prove nothing about verification.
  const DEAD = 'deadbeefdeadbeef.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbmE=';
  const ALSO_DEAD = 'f00df00df00df00d.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbmE=';

  it('authenticates when the live cookie is FIRST in the jar', async () => {
    const slug = 'dup-good-first';
    const { name, value } = await realSessionCookie(slug, 'dup-good-first@test.example.com');

    // Control: this direction has always worked, and proves the fixture is sound.
    expect(await orgSlugsFor(`${name}=${value}; ${name}=${DEAD}`)).toContain(slug);
  });

  it('authenticates when a DEAD twin is first — the permanent-brick case', async () => {
    const slug = 'dup-dead-first';
    const { name, value } = await realSessionCookie(slug, 'dup-dead-first@test.example.com');

    // The brick. Same two cookies, opposite order, and order is decided by the
    // browser's creation timestamps — not by anything we control. Before the
    // fix this resolved the dead cookie, returned no session, and no amount of
    // signing in again could recover it.
    expect(await orgSlugsFor(`${name}=${DEAD}; ${name}=${value}`)).toContain(slug);
  });

  it('stays unauthenticated when every candidate is dead', async () => {
    const slug = 'dup-all-dead';
    const { name } = await realSessionCookie(slug, 'dup-all-dead@test.example.com');

    // Resolving candidates must not become "authenticate on anything". With no
    // live token in the jar the answer is still no session.
    expect(await orgSlugsFor(`${name}=${DEAD}; ${name}=${ALSO_DEAD}`)).not.toContain(slug);
  });

  it('resolves past a VALIDLY SIGNED twin whose session row is gone', async () => {
    // The tests above kill their twin by breaking the HMAC, which better-call
    // rejects in getSignedCookie before the database is ever consulted. A real
    // stale twin is nothing like that: it is correctly signed, and dies on the
    // session lookup instead. Two different rejection paths inside getSession,
    // and only this one matches what a poisoned browser actually carries.
    const slug = 'dup-revoked-first';
    const org = await createTestOrganization({ slug });
    const user = await createTestUser({ email: 'dup-revoked@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const { token: pat } = await createTestPAT(user.id, org.id, { scope: 'mcp:admin profile:read' });

    const doomed = await exchangeForSessionCookie(pat);
    const live = await exchangeForSessionCookie(pat);
    expect(doomed.value).not.toBe(live.value);

    // Revoke the first session at the source, leaving its signature intact.
    const token = rawSessionToken(doomed.value);
    const deleted = await getTestDb()`DELETE FROM "session" WHERE token = ${token} RETURNING id`;
    expect(deleted.length, 'the doomed session must actually be revoked').toBe(1);

    const name = live.name;
    // Signed, revoked, and FIRST — the exact shape of the production brick.
    expect(await orgSlugsFor(`${name}=${doomed.value}; ${name}=${live.value}`)).toContain(slug);
    const resolved = await getSession(`${name}=${doomed.value}; ${name}=${live.value}`);
    expect(resolved.body).toMatchObject({ user: { id: user.id } });
    expect(sessionExpiries(resolved.setCookies, name)).toEqual([]);
    // And it is genuinely dead on its own, or the assertion above proves nothing.
    expect(await orgSlugsFor(`${name}=${doomed.value}`)).not.toContain(slug);
  });

  it('is unchanged for the ordinary single-cookie jar', async () => {
    const slug = 'dup-single';
    const { name, value } = await realSessionCookie(slug, 'dup-single@test.example.com');

    expect(await orgSlugsFor(`${name}=${value}`)).toContain(slug);
    const resolved = await getSession(`${name}=${value}`);
    expect(resolved.body).toMatchObject({ user: { email: 'dup-single@test.example.com' } });
    expect(sessionExpiries(resolved.setCookies, name)).toEqual([]);
  });

  it('does not invent cookie deletions for a no-cookie request', async () => {
    const result = await getSession();
    expect(result.body).toBeNull();
    expect(result.setCookies).toEqual([]);
  });

  it('clears a single VALIDLY SIGNED cookie whose session row is gone', async () => {
    const stale = await realSessionCookie(
      'single-stale-session',
      'single-stale-session@test.example.com'
    );
    const deleted = await getTestDb()`
      DELETE FROM "session"
      WHERE token = ${rawSessionToken(stale.value)}
      RETURNING id
    `;
    expect(deleted.length, 'the stale session must actually be revoked').toBe(1);

    const result = await getSession(`${stale.name}=${stale.value}`);
    expect(result.body).toBeNull();
    const expiries = sessionExpiries(result.setCookies, stale.name);
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).not.toMatch(/Domain=/i);
  });

  it('clears both configured-domain and host-only scopes for a stale cookie', async () => {
    const previousDomain = process.env.AUTH_COOKIE_DOMAIN;
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    clearAuthCacheForTests();
    try {
      const stale = await realSessionCookie(
        'domain-stale-session',
        'domain-stale-session@test.example.com'
      );
      const deleted = await getTestDb()`
        DELETE FROM "session"
        WHERE token = ${rawSessionToken(stale.value)}
        RETURNING id
      `;
      expect(deleted.length, 'the stale session must actually be revoked').toBe(1);

      const result = await getSession(`${stale.name}=${stale.value}`);
      expect(result.body).toBeNull();
      const expiries = sessionExpiries(result.setCookies, stale.name);
      expect(expiries).toHaveLength(2);
      expect(expiries.filter((cookie) => /Domain=\.lobu\.ai/i.test(cookie))).toHaveLength(1);
      expect(expiries.filter((cookie) => !/Domain=/i.test(cookie))).toHaveLength(1);
    } finally {
      if (previousDomain === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
      else process.env.AUTH_COOKIE_DOMAIN = previousDomain;
      clearAuthCacheForTests();
    }
  });
});
