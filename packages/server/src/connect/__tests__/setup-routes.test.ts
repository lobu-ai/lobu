import { describe, expect, test } from 'vitest';
import { createSetupRoutes, type SetupRouteDeps } from '../setup-routes';
import { sessionCookieName } from '../../auth/session-cookie-scope';

const url = 'https://cloud.example/connect/managed?org=public-provider&connector=mail';
function fixture(overrides: Partial<SetupRouteDeps> = {}) {
  let calls = 0;
  const deps: SetupRouteDeps = {
    publicOptions: async key => ({ action: 'setup_options', connector_key: key, cloud_status: 'available', options: [] }),
    resolveOffer: async () => 'public-provider', session: async () => ({ user: { id: 'synthetic-user' } }),
    home: async () => ({ id: 'synthetic-home' }), origin: () => 'https://cloud.example',
    connect: async (args, ctx) => { calls++; expect(ctx.organizationId).toBe('synthetic-home'); expect(ctx.userId).toBe('synthetic-user'); expect(args.managed_by_org).toBe('public-provider'); return { action: 'connect', connection_id: 1, slug: 'synthetic-grant', status: 'active', message: 'Ready' }; },
    ...overrides,
  };
  return { app: createSetupRoutes(deps), calls: () => calls };
}
const headers = { origin: 'https://cloud.example', cookie: `${sessionCookieName(true)}=synthetic-session` };

describe('managed setup browser handoff', () => {
  test('GET displays consent but never creates a grant', async () => {
    const f = fixture(); const res = await f.app.request(url);
    expect(res.status).toBe(200); expect(await res.text()).toContain('Continue to account authorization'); expect(f.calls()).toBe(0);
  });
  test('signed-out visitor gets a login continuation preserving the chosen offer', async () => {
    const f = fixture({ session: async () => null }); const body = await (await f.app.request(url)).text();
    expect(body).toContain('callbackUrl='); expect(body).toContain('Sign in to continue'); expect(f.calls()).toBe(0);
  });
  test('stale offer cannot start authorization', async () => {
    const f = fixture({ resolveOffer: async () => null }); expect((await f.app.request(url)).status).toBe(404); expect(f.calls()).toBe(0);
  });
  test('rejects cross-origin, missing-origin, and bearer-only submissions', async () => {
    const f = fixture();
    for (const h of [{ ...headers, origin: 'https://evil.example' }, { cookie: headers.cookie }, { origin: headers.origin, authorization: 'Bearer synthetic-token' }]) {
      expect((await f.app.request(url, { method: 'POST', headers: h })).status).toBe(403);
    }
    expect(f.calls()).toBe(0);
  });
  test('rejects bearer authentication paired with a fabricated session cookie', async () => {
    const f = fixture({ session: async request => request.headers.has('authorization') ? { user: { id: 'synthetic-user' } } : null });
    const res = await f.app.request(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer synthetic-session' } });
    expect(res.status).toBe(403); expect(f.calls()).toBe(0);
  });
  test('rechecks session on POST before creating or reusing a grant', async () => {
    const f = fixture({ session: async () => null }); expect((await f.app.request(url, { method: 'POST', headers })).status).toBe(401); expect(f.calls()).toBe(0);
  });
  test('explicit human submission uses their home workspace and returns local setup instructions', async () => {
    const f = fixture(); const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(200); expect(await res.text()).toContain('lobu init --from-org public-provider'); expect(f.calls()).toBe(1);
  });
  test('redirects pending consent to the returned authorization URL', async () => {
    const f = fixture({ connect: async () => ({ action: 'connect', status: 'pending_auth', connection_id: 1, auth_type: 'oauth', connect_url: 'https://cloud.example/connect/synthetic-token', message: 'Authorize' }) });
    const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('https://cloud.example/connect/synthetic-token');
  });
  test('does not claim a setup-required connection is ready', async () => {
    const f = fixture({ connect: async () => ({ action: 'connect', status: 'setup_required', connector_key: 'mail', setup_family: 'device_bound', next_action: 'connect_device', instructions: 'Connect the required device first.' }) });
    const res = await f.app.request(url, { method: 'POST', headers });
    expect(res.status).toBe(409); expect(await res.text()).toContain('Connect the required device first.');
  });
  test('public metadata does not require a browser session', async () => {
    const f = fixture({ session: async () => { throw new Error('must not authenticate'); } });
    expect((await f.app.request('https://cloud.example/api/connection-options?connector_key=mail')).status).toBe(200);
  });
});
