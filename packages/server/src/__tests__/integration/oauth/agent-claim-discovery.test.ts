/**
 * auth.md discovery surface + the full user_claimed loop.
 *
 * Discovery: the `agent_auth` block in AS metadata, the `auth_md` pointer in
 * protected-resource metadata, and the GET /auth.md walkthrough.
 *
 * Full loop: drives the user_claimed flow end to end against the mounted
 * oauthRoutes — register -> device_authorization -> device/email -> consent
 * approve (as the signed-in user) -> token poll yields a scoped credential.
 * `createTestSession` stands in for "user clicked the magic link and is now
 * signed in"; the magic-link verify -> session step is better-auth's own
 * tested code, and the device/email -> consent-link emission is covered by
 * device-email-claim.test.ts.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { oauthRoutes } from '../../../auth/oauth/routes';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestDeviceCode,
  createTestOAuthClient,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';

const ORIGIN = 'http://localhost';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', oauthRoutes);
  return app;
}

function call(
  app: Hono<{ Bindings: Env }>,
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> }
): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...opts?.headers },
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    TEST_ENV
  );
}

beforeAll(async () => {
  await initWorkspaceProvider();
  await cleanupTestDatabase();
});

describe('auth.md discovery surface', () => {
  it('advertises the user_claimed agent_auth block in AS metadata', async () => {
    const res = await call(buildApp(), 'GET', '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent_auth?: {
        skill: string;
        register_uri: string;
        claim_uri: string;
        flows_supported: string[];
        claim_methods_supported: string[];
        claim_email_endpoint: string;
        device_authorization_endpoint: string;
        auth_md: string;
      };
    };
    expect(body.agent_auth).toBeDefined();
    // Standard auth.md profile names for generic scanners.
    expect(body.agent_auth?.skill).toMatch(/\/auth\.md$/);
    expect(body.agent_auth?.register_uri).toMatch(/\/oauth\/register$/);
    expect(body.agent_auth?.claim_uri).toMatch(/\/oauth\/device\/email$/);
    expect(body.agent_auth?.flows_supported).toEqual(['user_claimed']);
    // Zero-touch ID-JAG is not offered yet.
    expect(body.agent_auth?.flows_supported).not.toContain('agent_verified');
    expect(body.agent_auth?.claim_methods_supported).toContain('email');
    expect(body.agent_auth?.claim_email_endpoint).toMatch(/\/oauth\/device\/email$/);
    expect(body.agent_auth?.device_authorization_endpoint).toMatch(
      /\/oauth\/device_authorization$/
    );
    expect(body.agent_auth?.auth_md).toMatch(/\/auth\.md$/);
  });

  it('points at auth.md from protected-resource metadata', async () => {
    const res = await call(buildApp(), 'GET', '/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_md?: string };
    expect(body.auth_md).toMatch(/\/auth\.md$/);
  });

  it('serves the auth.md walkthrough as markdown', async () => {
    const res = await call(buildApp(), 'GET', '/auth.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text).toContain('# auth.md');
    expect(text).toContain('/oauth/device/email');
    expect(text).toContain('user_claimed');
  });
});

describe('user_claimed flow — full loop', () => {
  it('rejects an MCP device authorization that omits its resource audience', async () => {
    const app = buildApp();
    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Unbound Claim Agent',
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    const response = await call(app, 'POST', '/oauth/device_authorization', {
      body: {
        client_id: client.client_id,
        scope: 'mcp:read mcp:write',
      },
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({ error: 'invalid_request' }),
    );
  });

  it('rejects a cross-origin resource at the token endpoint before grant exchange', async () => {
    const app = buildApp();
    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Cross-Origin Claim Agent',
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    const response = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: DEVICE_GRANT,
        client_id: client.client_id,
        device_code: 'not-a-real-device-code',
        resource: 'https://evil.example/mcp',
      },
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({ error: 'invalid_request' }),
    );
  });

  it('agent registers a user by email and collects a scoped credential after consent', async () => {
    const app = buildApp();
    const org = await createTestOrganization({ name: 'Claim Org' });
    const user = await createTestUser({ name: 'Claim User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const session = await createTestSession(user.id);

    // 1. Agent registers a device-code client (DCR).
    const reg = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Claim Agent',
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    // 2. Agent starts a device authorization, binding to the user's org.
    const da = await call(app, 'POST', '/oauth/device_authorization', {
      body: {
        client_id: client.client_id,
        scope: 'mcp:read mcp:write',
        resource: `${ORIGIN}/mcp/${org.slug}`,
      },
    });
    expect(da.status).toBe(200);
    const { device_code, user_code } = (await da.json()) as {
      device_code: string;
      user_code: string;
    };

    // 3. Agent delivers the claim by email -> opaque 202.
    const email = await call(app, 'POST', '/oauth/device/email', {
      body: { user_code, email: user.email },
    });
    expect(email.status).toBe(202);

    // 4. User clicks the magic link (modelled by the session). Loading the
    // consent page verifies and binds the exact code before approval.
    const info = await call(app, 'GET', `/oauth/device/info?user_code=${user_code}`, {
      headers: { Cookie: session.cookieHeader },
    });
    expect(info.status).toBe(200);

    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code, approved: true },
      headers: { Cookie: session.cookieHeader },
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()) as { status: string }).toEqual({
      status: 'approved',
      user_code,
    });

    // 5. A mismatched audience is rejected without consuming the one-time
    // device code, so the correctly bound client can still complete.
    const mismatch = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: DEVICE_GRANT,
        device_code,
        client_id: client.client_id,
        resource: `${ORIGIN}/mcp/not-the-authorized-org`,
      },
    });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()) as { error: string }).toMatchObject({
      error: 'invalid_grant',
    });

    // 6. Agent polls with the exact audience and collects the scoped credential.
    const tokenRes = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: DEVICE_GRANT,
        device_code,
        client_id: client.client_id,
        resource: `${ORIGIN}/mcp/${org.slug}`,
      },
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; scope?: string };
    expect(tokens.access_token).toBeTruthy();
    expect((tokens.scope ?? '').split(' ')).toContain('mcp:read');
  });
});

describe('GET /oauth/device/info — informed consent (who + scopes)', () => {
  it('returns the requesting client name + scopes for a pending code (authed)', async () => {
    const app = buildApp();
    const user = await createTestUser({ name: 'Info User' });
    const session = await createTestSession(user.id);
    const client = await createTestOAuthClient({
      client_name: 'Acme Agent',
      grant_types: [DEVICE_GRANT, 'refresh_token'],
    });
    const device = await createTestDeviceCode(client.client_id, {
      scope: 'mcp:read mcp:write',
    });

    const res = await call(app, 'GET', `/oauth/device/info?user_code=${device.userCode}`, {
      headers: { Cookie: session.cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_name: string; scopes: string[] };
    expect(body.client_name).toBe('Acme Agent');
    expect(body.scopes).toContain('mcp:read');
    expect(body.scopes).toContain('mcp:write');
  });

  it('requires authentication', async () => {
    const app = buildApp();
    const client = await createTestOAuthClient({ grant_types: [DEVICE_GRANT, 'refresh_token'] });
    const device = await createTestDeviceCode(client.client_id);
    const res = await call(app, 'GET', `/oauth/device/info?user_code=${device.userCode}`);
    expect(res.status).toBe(401);
  });

  it('400s for an unknown user_code', async () => {
    const app = buildApp();
    const user = await createTestUser({ name: 'Info User 2' });
    const session = await createTestSession(user.id);
    const res = await call(app, 'GET', '/oauth/device/info?user_code=NOPE-NOPE', {
      headers: { Cookie: session.cookieHeader },
    });
    expect(res.status).toBe(400);
  });
});
