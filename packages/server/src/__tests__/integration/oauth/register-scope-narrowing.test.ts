/**
 * A DCR registration must never promise a scope authorization will strip.
 *
 * Slack's MCP client registered while discovery still advertised
 * `device_worker:run` and `connections:token` — #1901 (2026-07-13) removed them
 * from `scopes_supported`. `/oauth/register` echoed and stored all six scopes,
 * so Slack asked for all six on every subsequent authorization — and
 * `/oauth/authorize` silently reduced the request to the four public ones and
 * returned a perfectly valid 200. Slack compared issued against requested,
 * refused the connection client-side with "you didn't select all the required
 * permissions", and never called `/mcp`. Because the wedge never produced a
 * 401, Slack never re-read discovery and never re-registered: the connection
 * stayed broken with every server-side hop reporting success. Only changing the
 * MCP endpoint URL forced a re-register.
 *
 * This drives the real `oauthRoutes` and pins both halves of the fix:
 * registration narrows to what the client's grant types can be granted, and
 * authorization rejects a stale non-public request loudly instead of reducing.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

const ORIGIN = 'http://localhost';
const REDIRECT_URI = 'https://oauth2.slack.com/external/auth/callback';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The exact scope string Slack's stale client sent. */
const SLACK_SIX =
  'mcp:read mcp:write mcp:admin profile:read device_worker:run connections:token';
const PUBLIC_FOUR = 'mcp:read mcp:write mcp:admin profile:read';

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', oauthRoutes);
  return app;
}

function call(
  app: Hono<{ Bindings: Env }>,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    TEST_ENV
  );
}

async function register(
  app: Hono<{ Bindings: Env }>,
  metadata: Record<string, unknown>
): Promise<{ client_id: string; scope?: string }> {
  const res = await call(app, 'POST', '/oauth/register', {
    client_name: 'Slack MCP',
    redirect_uris: [REDIRECT_URI],
    ...metadata,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json() as Promise<{ client_id: string; scope?: string }>;
}

function authorizeUrl(clientId: string, scope: string): string {
  const challenge = createHash('sha256')
    .update(randomBytes(32).toString('base64url'))
    .digest('base64url');
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  });
  return `/oauth/authorize?${query.toString()}`;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

describe('DCR registration scope narrowing', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('narrows an authorization-code registration to the grantable scopes', async () => {
    const app = buildApp();
    const client = await register(app, {
      grant_types: ['authorization_code', 'refresh_token'],
      scope: SLACK_SIX,
    });

    // The response is the contract the client will hold us to.
    expect(client.scope).toBe(PUBLIC_FOUR);

    // And the stored row agrees — a later re-read must not resurrect the six.
    const sql = getTestDb();
    const rows = await sql`SELECT scope FROM oauth_clients WHERE id = ${client.client_id}`;
    expect(rows[0].scope).toBe(PUBLIC_FOUR);
  });

  it('keeps device-flow-only scopes for a device-code client, whose consent grants them', async () => {
    const app = buildApp();
    const client = await register(app, {
      client_name: 'Lobu CLI',
      grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
      scope: SLACK_SIX,
    });
    expect(client.scope).toBe(SLACK_SIX);
  });

  it('drops unknown OIDC scopes rather than registering a scope we never issue', async () => {
    const app = buildApp();
    const client = await register(app, {
      grant_types: ['authorization_code', 'refresh_token'],
      scope: 'openid email profile offline_access mcp:read',
    });
    expect(client.scope).toBe('mcp:read');
  });

  it('leaves an absent scope absent — that means server default, not everything', async () => {
    const app = buildApp();
    const client = await register(app, { grant_types: ['authorization_code', 'refresh_token'] });
    expect(client.scope).toBeUndefined();
  });

  it('stores NULL when nothing requested is registrable, never the raw request', async () => {
    const app = buildApp();
    const client = await register(app, {
      grant_types: ['authorization_code', 'refresh_token'],
      scope: 'device_worker:run openid',
    });
    expect(client.scope).toBeUndefined();

    const sql = getTestDb();
    const rows = await sql`SELECT scope FROM oauth_clients WHERE id = ${client.client_id}`;
    expect(rows[0].scope).toBeNull();
  });
});

describe('/oauth/authorize rejects stale non-public requests', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('returns invalid_scope naming both scopes instead of silently reducing', async () => {
    const app = buildApp();
    const client = await register(app, {
      grant_types: ['authorization_code', 'refresh_token'],
      scope: PUBLIC_FOUR,
    });

    const res = await app.fetch(
      new Request(`${ORIGIN}${authorizeUrl(client.client_id, SLACK_SIX)}`),
      TEST_ENV
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_scope');
    expect(body.error_description).toContain('device_worker:run');
    expect(body.error_description).toContain('connections:token');
  });

  it('accepts the scope the narrowed registration handed back', async () => {
    const app = buildApp();
    const client = await register(app, {
      grant_types: ['authorization_code', 'refresh_token'],
      scope: SLACK_SIX,
    });

    const res = await app.fetch(
      new Request(`${ORIGIN}${authorizeUrl(client.client_id, client.scope as string)}`),
      TEST_ENV
    );

    // Not a scope rejection — the request proceeds to the consent page, still
    // carrying the full narrowed scope.
    expect(res.status, await res.clone().text()).toBe(302);
    const consent = new URL(res.headers.get('location') ?? '');
    expect(consent.pathname).toBe('/oauth/consent');
    expect(consent.searchParams.get('scope')).toBe(PUBLIC_FOUR);
  });
});
