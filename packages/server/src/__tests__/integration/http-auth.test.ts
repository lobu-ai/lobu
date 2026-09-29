import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_HTTP_MAX_BYTES } from '@lobu/core/contracts/worker/protocol';
import type { Env } from '../../index';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, seedOwnerContext } from '../setup/test-fixtures';

const binding = { origin: 'https://api.example.com', headers: { authorization: 'AUTHORIZATION' } };
const secret = 'Bearer synthetic-http-secret';
const transport = vi.fn(async (_url: unknown, _init: RequestInit) => new Response('ok'));
let fetchConnectionHttp: typeof import('../../utils/http-auth').fetchConnectionHttp;
let profiles: typeof import('../../utils/auth-profiles');
let manageAuthProfiles: typeof import('../../tools/admin/manage_auth_profiles').manageAuthProfiles;
let resolveExecutionAuth: typeof import('../../utils/execution-context').resolveExecutionAuth;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('@lobu/connector-worker/egress', async (importOriginal) => ({
    ...await importOriginal<object>(), fetchCredentialedPublicUrl: transport,
  }));
  ({ fetchConnectionHttp } = await import('../../utils/http-auth'));
  profiles = await import('../../utils/auth-profiles');
  ({ manageAuthProfiles } = await import('../../tools/admin/manage_auth_profiles'));
  ({ resolveExecutionAuth } = await import('../../utils/execution-context'));
  await (await import('../../workspace')).initWorkspaceProvider();
});
afterAll(() => { vi.doUnmock('@lobu/connector-worker/egress'); vi.resetModules(); });
beforeEach(async () => { await cleanupTestDatabase(); transport.mockReset(); transport.mockResolvedValue(new Response('ok')); });

async function fixture() {
  const { org, ctx } = await seedOwnerContext({ orgName: 'HTTP binding test', userName: 'Synthetic Owner' });
  const created = await manageAuthProfiles({
    action: 'create_auth_profile', connector_key: 'postgres', profile_kind: 'env',
    display_name: 'HTTP service', slug: 'http-service', credentials: { AUTHORIZATION: secret }, http: binding,
  }, {} as Env, ctx);
  expect('error' in created ? created.error : null).toBeNull();
  if (!('auth_profile' in created)) throw new Error('Expected created profile');
  expect(created.auth_profile.http).toEqual(binding);
  expect(JSON.stringify(created)).not.toContain(secret);
  const profile = (await profiles.getAuthProfileById(org.id, Number(created.auth_profile.id)))!;
  const connection = await createTestConnection({ organization_id: org.id, connector_key: 'postgres' });
  await getTestDb()`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connection.id}`;
  const call = (url = `${binding.origin}/query`, extra = {}) => fetchConnectionHttp({
    organizationId: org.id, connectionId: connection.id,
    request: { url, method: 'GET', headers: {}, ...extra },
  });
  return { org, ctx, profile, connection, call };
}

describe('HTTP delivery using env profiles', () => {
  it('executes native guest fetch through the real worker client and booted gateway', async () => {
    const f = await fixture();
    const { app } = await import('../../index');
    const { WorkerClient } = await import('@lobu/connector-worker/daemon');
    const { IsolateExecutor } = await import('@lobu/connector-worker/executor/isolate');
    const workerId = 'synthetic-http-worker';
    const token = 'synthetic-fleet-token';
    const [run] = await getTestDb()`INSERT INTO runs (organization_id, connection_id, run_type, status, approval_status, claimed_by, claimed_at, last_heartbeat_at)
      VALUES (${f.org.id}, ${f.connection.id}, 'action', 'running', 'auto', ${workerId}, NOW(), NOW()) RETURNING id`;
    const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => app.fetch(req, { WORKER_API_TOKEN: token, ENVIRONMENT: 'test' } as Env) });
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing gateway address');
      const client = new WorkerClient({ apiUrl: `http://127.0.0.1:${address.port}`, workerId, authToken: token, capabilities: {} });
      const auth = await resolveExecutionAuth({ organizationId: f.org.id, connectionId: f.connection.id, authProfileId: f.profile.id, credentialDb: getTestDb() });
      const result = await new IsolateExecutor({ timeoutMs: 5_000 }).execute(`module.exports.default = class {
        sync() {}
        async execute(ctx) { return { success: true, output: {
          text: await (await fetch('https://api.example.com/query')).text(),
          config: ctx.config, credential: ctx.credentials
        }}; }
      };`, {
        mode: 'action', actionKey: 'read', actionInput: {}, config: auth.connectionCredentials,
        credentials: auth.credentials, sessionState: auth.sessionState, env: {}, httpAuth: auth.httpAuth,
      }, { onHttpFetch: (request, signal) => client.httpFetch(Number(run.id), request, signal) });
      expect(result).toEqual({ mode: 'action', output: { text: 'ok', config: {}, credential: null } });
      expect(new Headers(transport.mock.calls[0][1].headers).get('authorization')).toBe(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('injects credentials only at egress and uses rotated values without changing the binding', async () => {
    const f = await fixture();
    const auth = await resolveExecutionAuth({ organizationId: f.org.id, connectionId: f.connection.id, authProfileId: f.profile.id, credentialDb: getTestDb() });
    expect(auth.httpAuth).toBe(true);
    expect(auth.credentials).toBeNull();
    expect(auth.connectionCredentials).toEqual({});
    expect(JSON.stringify(auth)).not.toContain(secret);
    const response = await auth.onHttpFetch!({ url: `${binding.origin}/query`, method: 'GET', headers: { Authorization: 'guest-override' } });
    expect(Buffer.from(response.body, 'base64').toString()).toBe('ok');
    expect(new Headers(transport.mock.calls[0][1].headers).get('authorization')).toBe(secret);
    const rotated = 'Basic synthetic-rotated-value';
    const updated = await manageAuthProfiles({ action: 'update_auth_profile', auth_profile_slug: f.profile.slug, credentials: { AUTHORIZATION: rotated } }, {} as Env, f.ctx);
    expect('error' in updated ? updated.error : null).toBeNull();
    transport.mockResolvedValueOnce(new Response('rotated'));
    await f.call();
    expect(new Headers(transport.mock.calls[1][1].headers).get('authorization')).toBe(rotated);
    expect((await profiles.getAuthProfileById(f.org.id, f.profile.id))?.metadata?.http).toEqual(binding);
    await expect(profiles.updateAuthProfile({
      organizationId: f.org.id, slug: f.profile.slug, authData: { AUTHORIZATION: rotated, API_URL: 'https://api.example.com' },
    })).rejects.toThrow('mapped to a header');
  });

  it('refuses different origins, userinfo and cross-organization use before transport', async () => {
    const f = await fixture();
    for (const url of ['http://api.example.com/query', 'https://other.example.com/query', 'https://api.example.com:8443/query', 'https://user@api.example.com/query']) {
      await expect(f.call(url)).rejects.toThrow('destination');
    }
    const other = await seedOwnerContext({ orgName: 'Other HTTP org', userName: 'Other Owner' });
    await expect(fetchConnectionHttp({ organizationId: other.org.id, connectionId: f.connection.id, request: { url: `${binding.origin}/query`, method: 'GET', headers: {} } })).rejects.toThrow('unavailable');
    expect(transport).not.toHaveBeenCalled();
  });

  it('checks current revocation and connection deletion for every request', async () => {
    const f = await fixture();
    await profiles.updateAuthProfile({ organizationId: f.org.id, slug: f.profile.slug, status: 'revoked' });
    await expect(f.call()).rejects.toThrow('unavailable');
    await profiles.updateAuthProfile({ organizationId: f.org.id, slug: f.profile.slug, status: 'active' });
    await getTestDb()`UPDATE connections SET deleted_at = NOW() WHERE id = ${f.connection.id}`;
    await expect(f.call()).rejects.toThrow('unavailable');
    expect(transport).not.toHaveBeenCalled();
  });

  it('tears down a paused connection webhook with gateway-held credentials', async () => {
    const f = await fixture();
    const code = vi.spyOn(await import('../../utils/ensure-connector-installed'), 'resolveConnectorCodeForKey')
      .mockResolvedValue(`module.exports.default = class {
        sync() {}
        execute() {}
        async unregisterWebhook(ctx) {
          if (ctx.credentials || ctx.config.AUTHORIZATION) throw new Error('Credential reached connector');
          await fetch('https://api.example.com/webhooks/' + ctx.externalId, { method: 'DELETE' });
        }
      };`);
    try {
      await getTestDb()`UPDATE connections SET status = 'paused',
        config = '{"webhook_external_id":"synthetic-subscription","keep":"public"}'::jsonb
        WHERE id = ${f.connection.id}`;
      const { unregisterConnectorWebhook } = await import('../../connect/webhook-registration');
      await unregisterConnectorWebhook({ organizationId: f.org.id, connectionId: f.connection.id, throwOnError: true });
      expect(String(transport.mock.calls[0][0])).toBe('https://api.example.com/webhooks/synthetic-subscription');
      expect(transport.mock.calls[0][1].method).toBe('DELETE');
      expect(new Headers(transport.mock.calls[0][1].headers).get('authorization')).toBe(secret);
      const [stored] = await getTestDb()`SELECT config FROM connections WHERE id = ${f.connection.id}`;
      expect(stored.config).toEqual({ keep: 'public' });
    } finally {
      code.mockRestore();
    }
  });

  it('refuses redirects and oversized bodies', async () => {
    const f = await fixture();
    transport.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example.com' } }));
    await expect(f.call()).rejects.toThrow('redirects');
    expect(transport.mock.calls[0][1].redirect).toBe('manual');
    transport.mockResolvedValueOnce(new Response('large', { headers: { 'content-length': String(CONNECTOR_HTTP_MAX_BYTES + 1) } }));
    await expect(f.call()).rejects.toThrow('too large');
    await expect(f.call(undefined, { method: 'POST', body: Buffer.alloc(CONNECTOR_HTTP_MAX_BYTES + 1).toString('base64') })).rejects.toThrow('Invalid');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([['HEAD', 200], ['GET', 304]] as const)('preserves bodyless %s/%s responses regardless of representation size', async (method, status) => {
    const f = await fixture();
    transport.mockResolvedValueOnce(new Response(null, {
      status, headers: { 'content-length': String(CONNECTOR_HTTP_MAX_BYTES + 1), etag: 'synthetic-version' },
    }));
    expect(await f.call(undefined, { method })).toMatchObject({
      status, body: '', headers: { etag: 'synthetic-version' },
    });
  });

  it('never returns transport diagnostics containing a secret', async () => {
    const f = await fixture();
    transport.mockRejectedValueOnce(new Error(`failed request ${secret}`));
    await expect(f.call()).rejects.toThrow(/^HTTP credential request failed$/);
    await profiles.updateAuthProfile({ organizationId: f.org.id, slug: f.profile.slug, authData: { AUTHORIZATION: `${secret}\r\ninvalid` } });
    await expect(f.call()).rejects.toThrow(/^Invalid HTTP credential header value$/);
  });

  it.each(['body', 'header', 'statusText'])('rejects a bound credential echoed in the upstream %s', async (location) => {
    const f = await fixture();
    transport.mockResolvedValueOnce(new Response(location === 'body' ? `echo: ${secret}` : 'ok', {
      headers: location === 'header' ? { 'x-debug-auth': secret } : {},
      statusText: location === 'statusText' ? secret : 'OK',
    }));
    await expect(f.call()).rejects.toThrow(/^HTTP response contained a bound credential$/);
  });

  it('uses the real egress guard to reject a private destination even when bound', async () => {
    const f = await fixture();
    const profile = await profiles.createAuthProfile({
      organizationId: f.org.id, connectorKey: 'postgres', displayName: 'Private destination',
      profileKind: 'env', authData: { AUTHORIZATION: secret }, http: { ...binding, origin: 'https://127.0.0.1' },
    });
    await getTestDb()`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${f.connection.id}`;
    const egress = await vi.importActual<typeof import('@lobu/connector-worker/egress')>('@lobu/connector-worker/egress');
    transport.mockImplementationOnce((url, init) => egress.fetchCredentialedPublicUrl(url as URL, init));
    await expect(f.call('https://127.0.0.1/query')).rejects.toThrow(/^HTTP credential request failed$/);
  });

  it('validates bindings and refuses malformed stored metadata without raw fallback', async () => {
    for (const origin of ['http://api.example.com', 'https://api.example.com/path', 'https://u:p@api.example.com', 'https://api.example.com?token=x']) {
      expect(() => profiles.validateHttpAuthBinding({ ...binding, origin })).toThrow();
    }
    for (const headers of [{ Host: 'KEY' }, { 'bad\nheader': 'KEY' }, { Authorization: 'KEY', authorization: 'KEY' }, {}]) {
      expect(() => profiles.validateHttpAuthBinding({ ...binding, headers })).toThrow();
    }
    const f = await fixture();
    await getTestDb()`UPDATE auth_profiles SET metadata = '{"http":null}'::jsonb WHERE id = ${f.profile.id}`;
    await expect(resolveExecutionAuth({ organizationId: f.org.id, connectionId: f.connection.id, authProfileId: f.profile.id, credentialDb: getTestDb() })).rejects.toThrow('binding');
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects HTTP binding before the separate browser-session creation path', async () => {
    const f = await fixture();
    expect(await manageAuthProfiles({
      action: 'create_auth_profile', profile_kind: 'browser_session', display_name: 'Invalid HTTP session', http: binding,
    }, {} as Env, f.ctx)).toEqual({ error: 'HTTP delivery requires an env auth profile.' });
  });

  it('worker auth completion cannot add, replace or remove the protected binding', async () => {
    const f = await fixture();
    const { completeAuthRun } = await import('../../worker-api');
    const raw = await profiles.createAuthProfile({ organizationId: f.org.id, connectorKey: 'postgres', displayName: 'Unbound env', profileKind: 'env', authData: { AUTHORIZATION: secret } });
    for (const [profile, metadata] of [
      [f.profile, { http: { ...binding, origin: 'https://other.example.com' } }],
      [f.profile, {}],
      [raw, { http: binding }],
    ] as const) {
      const sql = getTestDb();
      const [run] = await sql`INSERT INTO runs (organization_id, run_type, status, claimed_by, claimed_at, auth_profile_id)
        VALUES (${f.org.id}, 'auth', 'running', 'synthetic-http-worker', NOW(), ${profile.id}) RETURNING id`;
      let result: unknown;
      const ctx = {
        req: { json: async () => ({ run_id: run.id, worker_id: 'synthetic-http-worker', status: 'success', credentials: { AUTHORIZATION: secret }, metadata }) },
        var: {}, json: (body: unknown) => { result = body; return body; },
      } as unknown as Context<{ Bindings: Env }>;
      await completeAuthRun(ctx);
      expect(result).toEqual({ success: true });
      expect((await profiles.getAuthProfileById(f.org.id, profile.id))?.metadata?.http).toEqual(profile.id === f.profile.id ? binding : undefined);
    }
  });
});
