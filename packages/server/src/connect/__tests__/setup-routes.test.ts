import { describe, expect, test } from 'vitest';
import { createSetupRoutes, type SetupRouteDeps } from '../setup-routes';
import { sessionCookieName } from '../../auth/session-cookie-scope';

const url = 'https://cloud.example/connect/managed?org=public-provider&connector=mail';
function fixture(overrides: Partial<SetupRouteDeps> = {}) {
  let calls = 0;
  const deps: SetupRouteDeps = {
    publicOptions: async (key) => ({
      action: 'setup_options',
      connector_key: key,
      cloud_status: 'available',
      options: [],
    }),
    resolveOffer: async () => 'public-provider',
    session: async () => ({ user: { id: 'synthetic-user' } }),
    home: async () => ({ id: 'synthetic-home' }),
    origin: () => 'https://cloud.example',
    connect: async (args, ctx) => {
      calls++;
      expect(ctx.organizationId).toBe('synthetic-home');
      expect(ctx.userId).toBe('synthetic-user');
      expect(args.managed_by_org).toBe('public-provider');
      return {
        action: 'connect',
        connection_id: 1,
        slug: 'synthetic-grant',
        status: 'active',
        message: 'Ready',
      };
    },
    ...overrides,
  };
  return { app: createSetupRoutes(deps), calls: () => calls };
}
const headers = {
  origin: 'https://cloud.example',
  cookie: `${sessionCookieName(true)}=synthetic-session`,
};

describe('managed setup browser handoff', () => {
  test('GET displays consent but never creates a grant', async () => {
    const f = fixture();
    const res = await f.app.request(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Continue to account authorization');
    expect(f.calls()).toBe(0);
  });
  test('signed-out visitor redirects to login preserving the chosen offer', async () => {
    const f = fixture({ session: async () => null });
    const res = await f.app.request(url);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('/auth/login?callbackUrl=')).toBe(true);
    // The redirect is session-dependent, so it must not be cached.
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The offer must survive the round trip, or the visitor returns to a blank handoff.
    expect(decodeURIComponent(location)).toContain(
      'https://cloud.example/connect/managed?org=public-provider&connector=mail'
    );
    expect(f.calls()).toBe(0);
  });
  test('stale offer cannot start authorization', async () => {
    const f = fixture({ resolveOffer: async () => null });
    const res = await f.app.request(url);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Connection option unavailable');
    // Offer availability is mutable per-org state; a cached 404 outlives the
    // org republishing the offer.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(f.calls()).toBe(0);
  });
  test('rejects cross-origin, missing-origin, and bearer-only submissions', async () => {
    const f = fixture();
    for (const h of [
      { ...headers, origin: 'https://evil.example' },
      { cookie: headers.cookie },
      { origin: headers.origin, authorization: 'Bearer synthetic-token' },
    ]) {
      expect((await f.app.request(url, { method: 'POST', headers: h })).status).toBe(403);
    }
    expect(f.calls()).toBe(0);
  });
  test('rejects bearer authentication paired with a fabricated session cookie', async () => {
    const f = fixture({
      session: async (request) =>
        request.headers.has('authorization') ? { user: { id: 'synthetic-user' } } : null,
    });
    const res = await f.app.request(url, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer synthetic-session' },
    });
    expect(res.status).toBe(403);
    expect(f.calls()).toBe(0);
  });
  test('rechecks session on POST and sends an expired one back through login', async () => {
    const f = fixture({ session: async () => null });
    const res = await f.app.request(url, { method: 'POST', headers });
    // A form POST is a browser navigation; JSON would strand the person on a
    // consent page whose session expired while it sat open. 303 so the method
    // change to GET is specified rather than left to browser convention.
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain(
      'https://cloud.example/connect/managed?org=public-provider&connector=mail'
    );
    expect(f.calls()).toBe(0);
  });
  test('an incomplete setup link renders a page rather than JSON', async () => {
    // Only hand-craftable: the consent form always posts back to the current
    // URL with its query intact. Still a browser navigation, so it must not
    // answer with JSON -- verified live in prod as 400 text/html.
    const f = fixture();
    const res = await f.app.request('https://cloud.example/connect/managed', {
      method: 'POST',
      headers,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('This setup link is incomplete.');
    expect(body).toContain('Return to Lobu');
    expect(f.calls()).toBe(0);
  });
  test('an oversized org or connector is refused before any grant work', async () => {
    const f = fixture();
    const long = 'x'.repeat(201);
    const res = await f.app.request(
      `https://cloud.example/connect/managed?org=${long}&connector=mail`,
      { method: 'POST', headers }
    );
    expect(res.status).toBe(400);
    expect(f.calls()).toBe(0);
  });
  test('a visitor with no personal workspace gets an actionable page, not JSON', async () => {
    const f = fixture({ home: async () => null });
    const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain('Finish setting up your account');
    expect(body).toContain('Return to Lobu');
    expect(f.calls()).toBe(0);
  });
  test('every human-facing dead end offers a way back into the product', async () => {
    const stale = fixture({ resolveOffer: async () => null });
    const failed = fixture({ connect: async () => ({ error: 'Offer withdrawn.' }) });
    for (const res of [
      await stale.app.request(url),
      await failed.app.request(url, { method: 'POST', headers }),
    ]) {
      expect(await res.text()).toContain('href="/"');
    }
  });
  test('explicit human submission uses their home workspace and returns local setup instructions', async () => {
    const f = fixture();
    const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('lobu init --from-org public-provider');
    expect(f.calls()).toBe(1);
  });
  test('redirects pending consent to the returned authorization URL', async () => {
    const f = fixture({
      connect: async () => ({
        action: 'connect',
        status: 'pending_auth',
        connection_id: 1,
        auth_type: 'oauth',
        connect_url: 'https://cloud.example/connect/synthetic-token',
        message: 'Authorize',
      }),
    });
    const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://cloud.example/connect/synthetic-token');
  });
  test('does not claim a setup-required connection is ready', async () => {
    const f = fixture({
      connect: async () => ({
        action: 'connect',
        status: 'setup_required',
        connector_key: 'mail',
        setup_family: 'device_bound',
        next_action: 'connect_device',
        instructions: 'Connect the required device first.',
      }),
    });
    const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain('Connect the required device first.');
    expect(body).toContain('Connection setup needs attention');
  });
  test('a failed grant reuses the shared OAuth error page', async () => {
    const f = fixture({ connect: async () => ({ error: 'Managed OAuth is no longer available.' }) });
    const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Managed OAuth is no longer available.');
    expect(body).toContain('Technical details');
  });
  test('public metadata does not require a browser session', async () => {
    const f = fixture({
      session: async () => {
        throw new Error('must not authenticate');
      },
    });
    expect(
      (await f.app.request('https://cloud.example/api/connection-options?connector_key=mail'))
        .status
    ).toBe(200);
  });
});
