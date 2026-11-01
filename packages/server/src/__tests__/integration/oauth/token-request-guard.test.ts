import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthClientsStore } from '../../../auth/oauth/clients';
import { OAuthProvider } from '../../../auth/oauth/provider';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { hashToken } from '../../../auth/oauth/utils';
import { pgTextArray } from '../../../db/client';
import type { Env } from '../../../index';
import { resetRateLimiterForTests } from '../../../utils/rate-limiter';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TOKEN_PATHS = ['/oauth/token', '/mcp/oauth/token'];
const TEST_ENV = {
  ENVIRONMENT: 'test',
  JWT_SECRET: 'test-token-guard-jwt-secret',
  BETTER_AUTH_SECRET: 'test-token-guard-auth-secret',
} as Env;
const INVALID_GRANT = { grant_type: 'unsupported', client_id: 'public-client' };

function appForPeer(peer = '203.0.113.9') {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('peerRemoteAddress', peer);
    await next();
  });
  app.route('/', oauthRoutes);
  app.route('/mcp', oauthRoutes);
  return app;
}

function post(
  app: ReturnType<typeof appForPeer>,
  path: string,
  body: BodyInit = JSON.stringify(INVALID_GRANT),
  headers: Record<string, string> = {},
  env: Env = TEST_ENV
) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit), { ...env, DATABASE_URL: process.env.DATABASE_URL });
}

async function seedRefreshGrant(authMethod: 'none' | 'client_secret_basic' = 'none') {
  const sql = getTestDb();
  const user = await createTestUser({ name: 'Token Guard User' });
  const org = await createTestOrganization({ name: 'Token Guard Workspace' });
  await addUserToOrganization(user.id, org.id, 'owner');
  const client = await new OAuthClientsStore(sql).registerClient({
    client_name: 'Token Guard Client',
    redirect_uris: ['https://client.example/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: authMethod,
  });
  const refreshToken = 'test-token-guard-refresh';
  await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      granted_organization_ids, authorization_grant_type, scope, expires_at
    ) VALUES (
      'token-guard-refresh-row', 'refresh', ${hashToken(refreshToken)},
      ${client.client_id}, ${user.id}, ${org.id},
      ${pgTextArray([org.id])}::text[], 'authorization_code', 'mcp:read profile:read',
      NOW() + INTERVAL '30 days'
    )
  `;
  return { client, refreshToken, provider: new OAuthProvider(sql) };
}

describe('OAuth token request guards', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    resetRateLimiterForTests();
    await cleanupTestDatabase();
    vi.stubEnv('TRUSTED_PROXY', '');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  });

  afterEach(() => {
    resetRateLimiterForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('shares the IP budget across both mounts and survives a fresh replica cache', async () => {
    vi.stubEnv('TRUSTED_PROXY', '2');
    const app = appForPeer('10.0.0.2');
    const headers = { 'X-Forwarded-For': '192.0.2.99, 203.0.113.44, 192.0.2.10' };
    // Exercise the public route, including its real shared PostgreSQL counter.
    for (let i = 0; i < 600; i++) {
      const response = await post(app, TOKEN_PATHS[i % 2], undefined, headers);
      expect(response.status).toBe(400);
    }
    resetRateLimiterForTests();
    for (const path of TOKEN_PATHS) {
      const response = await post(app, path, undefined, {
        ...headers,
        'X-Forwarded-For': '198.51.100.80, 203.0.113.44, 192.0.2.10',
        'CF-Connecting-IP': '198.51.100.81',
      });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    }
    expect((await post(app, TOKEN_PATHS[0], undefined, {
      'X-Forwarded-For': '203.0.113.45, 192.0.2.10',
    })).status).toBe(400);
  });

  it('ignores spoofed forwarded headers when proxy trust is disabled', async () => {
    const app = appForPeer();
    // A different replica can have spent the budget; route admission must await
    // the existing atomic counter rather than rely on an empty local cache.
    const sql = getTestDb();
    const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await sql`
      INSERT INTO rate_limit_counters (key, window_start, count)
      VALUES ('rate:oauth:token:203.0.113.9', ${windowStart}, 600)
    `;
    const response = await post(app, TOKEN_PATHS[0], undefined, {
      'X-Forwarded-For': '198.51.100.99',
      'CF-Connecting-IP': '198.51.100.98',
      'X-Real-IP': '198.51.100.97',
    });
    expect(response.status).toBe(429);
    expect((await post(appForPeer('203.0.113.10'), TOKEN_PATHS[0])).status).toBe(400);
  });

  it.each(TOKEN_PATHS)('rejects oversized bodies at %s before grant processing', async (path) => {
    const response = await post(appForPeer(), path, JSON.stringify({
      ...INVALID_GRANT, extension: 'x'.repeat(32 * 1024),
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it.each([undefined, '1'])('bounds chunked bytes with Content-Length=%s and cancels overflow', async (length) => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(8 * 1024).fill(120));
        // Finite source lets the old, unbounded parser finish for the red test.
        if (pulls === 12) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const response = await post(appForPeer(), TOKEN_PATHS[0], stream, {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(length ? { 'Content-Length': length } : {}),
    });
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(12);
  });

  it.each([null, [], { grant_type: ['refresh_token'] }, { ...INVALID_GRANT, client_secret: 123 }])(
    'returns an OAuth error for non-object or non-string JSON parameters',
    async (body) => {
      const response = await post(appForPeer(), TOKEN_PATHS[0], JSON.stringify(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
  );

  it('rejects duplicate form parameters instead of choosing an ambiguous credential', async () => {
    const response = await post(appForPeer(), TOKEN_PATHS[0],
      'grant_type=refresh_token&client_id=one&client_id=two&refresh_token=fake',
      { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('bounds individual credentials and Basic authorization before client authentication', async () => {
    const app = appForPeer();
    const field = await post(app, TOKEN_PATHS[0], JSON.stringify({
      grant_type: 'refresh_token', client_id: 'public-client', refresh_token: 'fake', client_secret: 'x'.repeat(4097),
    }));
    expect(field.status).toBe(400);
    expect(await field.json()).toMatchObject({ error: 'invalid_request' });
    const basic = await post(app, TOKEN_PATHS[1], 'grant_type=refresh_token&refresh_token=fake', {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`client:${'x'.repeat(8192)}`).toString('base64')}`,
    });
    expect(basic.status).toBe(400);
    expect(await basic.json()).toMatchObject({ error: 'invalid_request' });
  });

  it.each(['json', 'form'])('keeps successful %s refresh and rotation working through both mounts', async (encoding) => {
    const { client, refreshToken, provider } = await seedRefreshGrant();
    const app = appForPeer();
    let nextRefresh = refreshToken;
    for (const path of TOKEN_PATHS) {
      const params = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: nextRefresh };
      const response = await post(app, path,
        encoding === 'json' ? JSON.stringify({ ...params, vendor_context: { trace: 'synthetic' } }) : new URLSearchParams(params),
        { 'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      const tokens = await response.json() as { access_token: string; refresh_token: string };
      expect(tokens.refresh_token).not.toBe(nextRefresh);
      expect(await provider.verifyAccessToken(tokens.access_token)).not.toBeNull();
      nextRefresh = tokens.refresh_token;
    }
    const stale = await post(app, TOKEN_PATHS[0], JSON.stringify({
      grant_type: 'refresh_token', client_id: client.client_id, refresh_token: refreshToken,
    }));
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('keeps confidential Basic client authentication working and rejects a fake refresh token', async () => {
    const { client, refreshToken } = await seedRefreshGrant('client_secret_basic');
    const app = appForPeer();
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
    };
    const fake = await post(app, TOKEN_PATHS[0],
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'fake-refresh' }), headers);
    expect(fake.status).toBe(400);
    expect(await fake.json()).toMatchObject({ error: 'invalid_grant' });
    const valid = await post(app, TOKEN_PATHS[1],
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), headers);
    expect(valid.status).toBe(200);
  });

  it('requires possession of a valid refresh token even for a registered public client', async () => {
    const { client } = await seedRefreshGrant();
    const response = await post(appForPeer(), TOKEN_PATHS[0], JSON.stringify({
      grant_type: 'refresh_token', client_id: client.client_id, refresh_token: 'fake-refresh',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });
});
