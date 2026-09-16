/**
 * Issue #3623: the device approval UI reported success while the CLI poller
 * stayed `authorization_pending` and saved no credential.
 *
 * These tests pin the protocol contract the UI is allowed to trust: the
 * approval response body is the ONLY success signal, and it is emitted
 * strictly downstream of the `status='approved'` write that the token poll
 * later consumes. They drive the exact CLI shape — `device_worker:run` plus
 * the rest of `packages/cli/src/internal/oauth.ts`'s SCOPE, no `resource` —
 * through the real routes, then assert on the persisted row rather than on a
 * log line or an HTTP status alone.
 *
 * The negatives cover every way the polled row must stay un-consumable — a
 * different verifier, a different client, an expired code, a replay, and an
 * approval that never claimed the code — and each one asserts the response
 * body carries no success signal, which is the guard the UI regression needed.
 */

import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { hashToken } from '../../../auth/oauth/utils';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';

const ORIGIN = 'http://localhost';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// The exact scope string `lobu login` requests (packages/cli/src/internal/oauth.ts).
const CLI_SCOPE =
  'device_worker:run mcp:read mcp:write mcp:admin profile:read connections:token';

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
  options?: { body?: unknown; cookie?: string }
): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        ...(options?.cookie ? { Cookie: options.cookie } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
    TEST_ENV
  );
}

/** A user with a personal org, as the device-worker branch force-binds to it. */
async function createDeviceUser(name: string) {
  const sql = getTestDb();
  const personalOrg = await createTestOrganization({ name: `${name} Personal` });
  const user = await createTestUser({ name });
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
    WHERE id = ${personalOrg.id}
  `;
  await addUserToOrganization(user.id, personalOrg.id, 'owner');
  const session = await createTestSession(user.id);
  return { user, personalOrg, session };
}

async function registerCliClient(app: Hono<{ Bindings: Env }>, name: string) {
  const response = await call(app, 'POST', '/oauth/register', {
    body: {
      client_name: name,
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

async function startDeviceAuthorization(app: Hono<{ Bindings: Env }>, clientId: string) {
  const response = await call(app, 'POST', '/oauth/device_authorization', {
    body: { client_id: clientId, scope: CLI_SCOPE },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    device_code: string;
    user_code: string;
    expires_in: number;
    interval: number;
  };
}

function pollToken(app: Hono<{ Bindings: Env }>, deviceCode: string, clientId: string) {
  return call(app, 'POST', '/oauth/token', {
    body: { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId },
  });
}

async function readRowStatus(deviceCode: string): Promise<string | null> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT status FROM oauth_device_codes WHERE device_code = ${deviceCode}
  `) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? null;
}

/**
 * Asserts a failed approval carries NO success signal.
 *
 * This is the contract the #3623 UI regression turned on: the success screen
 * keys off `status === 'approved'`, so a rejected approval must not put that
 * field in the body at any value, and must not echo `user_code` either — an
 * echo without a status is exactly the shape a lenient client misreads as
 * "it worked". Asserting the error body is the whole payload (not just that
 * `error` is present) is what makes a future field addition fail loudly here
 * instead of silently in the browser.
 *
 * SCOPE — verified by mutation, not assumed. Every negative reachable from
 * these fixtures (unclaimed, foreign verifier, expired, already-consumed)
 * fails at the `getDeviceCodeForUser` ownership guard, which runs BEFORE
 * `approveDeviceCode`. So these cases pin that guard's body, and they do not
 * cover the route's own `if (!approved)` return.
 *
 * That branch is genuinely unreachable here: `getDeviceCodeForUser` and
 * `approveDeviceCode` use identical predicates (user_code, user_id,
 * status='pending', expires_at > NOW()), so `!approved` requires the row to
 * change state in the await window between them — a real TOCTOU race that
 * needs provider mocking or a coordinated concurrent write to force. Injecting
 * that mock would assert against a stub rather than the route, so the UI proof
 * on #3623 remains the true red/green guard for that specific branch. Both
 * returns are 400 with no success field today; this helper is what keeps the
 * reachable majority of them that way.
 */
async function expectNoApprovalSuccess(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual({
    error: 'invalid_grant',
    error_description: 'Invalid or expired user code',
  });
  expect(body).not.toHaveProperty('status');
  expect(body).not.toHaveProperty('user_code');
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

describe('device flow approval/exchange consistency (#3623)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('approves the exact CLI grant and lets the original device_code mint a token', async () => {
    const app = buildApp();
    const { personalOrg, session } = await createDeviceUser('Device Flow User');
    const client = await registerCliClient(app, 'Lobu CLI e2e');
    const device = await startDeviceAuthorization(app, client.client_id);

    // The CLI advertises a 15-minute window and a 5s poll interval.
    expect(device.expires_in).toBe(900);
    expect(device.interval).toBe(5);

    // A poll BEFORE approval is non-terminal — the CLI must keep waiting.
    const pendingPoll = await pollToken(app, device.device_code, client.client_id);
    expect(pendingPoll.status).toBe(400);
    expect(((await pendingPoll.json()) as { error: string }).error).toBe('authorization_pending');

    // Browser: bind the code to the verifier, then approve it.
    const info = await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${encodeURIComponent(device.user_code)}`,
      { cookie: session.cookieHeader }
    );
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as { client_id: string; scopes: string[] };
    expect(infoBody.client_id).toBe(client.client_id);
    expect(infoBody.scopes).toContain('device_worker:run');

    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: true },
      cookie: session.cookieHeader,
    });
    expect(approve.status).toBe(200);
    // The body the UI is required to validate before rendering success, and
    // the echo that lets it prove WHICH code it approved.
    expect(await approve.json()).toEqual({
      status: 'approved',
      user_code: device.user_code,
    });

    // HTTP success must mean the row the poller reads is already approved.
    expect(await readRowStatus(device.device_code)).toBe('approved');

    // The ORIGINAL device_code — the one the live poller holds — mints a token.
    const tokenRes = await pollToken(app, device.device_code, client.client_id);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // The row is consumed, and the token is bound to the personal org.
    expect(await readRowStatus(device.device_code)).toBeNull();
    const sql = getTestDb();
    const tokenRows = (await sql`
      SELECT organization_id FROM oauth_tokens
      WHERE token_hash = ${hashToken(tokens.access_token)} AND token_type = 'access'
    `) as unknown as Array<{ organization_id: string | null }>;
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0].organization_id).toBe(personalOrg.id);
  });

  it('rejects approval by a verifier who does not own the code, leaving it pending', async () => {
    const app = buildApp();
    const owner = await createDeviceUser('Code Owner');
    const stranger = await createDeviceUser('Other Verifier');
    const client = await registerCliClient(app, 'Lobu CLI verifier-negative');
    const device = await startDeviceAuthorization(app, client.client_id);

    // The rightful verifier binds the code first.
    const claim = await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${encodeURIComponent(device.user_code)}`,
      { cookie: owner.session.cookieHeader }
    );
    expect(claim.status).toBe(200);

    // A different logged-in user cannot see it...
    const strangerInfo = await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${encodeURIComponent(device.user_code)}`,
      { cookie: stranger.session.cookieHeader }
    );
    expect(strangerInfo.status).toBe(400);

    // ...nor approve it.
    const strangerApprove = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: true },
      cookie: stranger.session.cookieHeader,
    });
    await expectNoApprovalSuccess(strangerApprove);

    // The row stayed pending, so the poller correctly keeps waiting.
    expect(await readRowStatus(device.device_code)).toBe('pending');
    const poll = await pollToken(app, device.device_code, client.client_id);
    expect(poll.status).toBe(400);
    expect(((await poll.json()) as { error: string }).error).toBe('authorization_pending');
  });

  it('rejects a token poll from a different client than the one that requested the code', async () => {
    const app = buildApp();
    const { session } = await createDeviceUser('Client Mismatch User');
    const client = await registerCliClient(app, 'Lobu CLI real');
    const otherClient = await registerCliClient(app, 'Lobu CLI impostor');
    const device = await startDeviceAuthorization(app, client.client_id);

    await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${encodeURIComponent(device.user_code)}`,
      { cookie: session.cookieHeader }
    );
    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: true },
      cookie: session.cookieHeader,
    });
    expect(approve.status).toBe(200);

    // The impostor client must not consume another client's approved code.
    const stolen = await pollToken(app, device.device_code, otherClient.client_id);
    expect(stolen.status).toBe(400);
    expect(((await stolen.json()) as { error: string }).error).toBe('invalid_grant');

    // Still approved and still available to its rightful client.
    expect(await readRowStatus(device.device_code)).toBe('approved');
    const rightful = await pollToken(app, device.device_code, client.client_id);
    expect(rightful.status).toBe(200);
  });

  it('rejects an expired code at both approval and token exchange', async () => {
    const app = buildApp();
    const { session } = await createDeviceUser('Expiry User');
    const client = await registerCliClient(app, 'Lobu CLI expiry');
    const device = await startDeviceAuthorization(app, client.client_id);
    const sql = getTestDb();

    // Claim while still valid, then age the row past its lifetime.
    const claim = await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${encodeURIComponent(device.user_code)}`,
      { cookie: session.cookieHeader }
    );
    expect(claim.status).toBe(200);
    await sql`
      UPDATE oauth_device_codes
      SET expires_at = NOW() - INTERVAL '1 second'
      WHERE device_code = ${device.device_code}
    `;

    // Approval must fail closed rather than approving a dead code.
    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: true },
      cookie: session.cookieHeader,
    });
    await expectNoApprovalSuccess(approve);
    expect(await readRowStatus(device.device_code)).toBe('pending');

    // And the poller gets the terminal expiry error, not a pending spin.
    const poll = await pollToken(app, device.device_code, client.client_id);
    expect(poll.status).toBe(400);
    expect(((await poll.json()) as { error: string }).error).toBe('expired_token');
  });

  it('consumes an approved code exactly once (replay is rejected)', async () => {
    const app = buildApp();
    const { session } = await createDeviceUser('Replay User');
    const client = await registerCliClient(app, 'Lobu CLI replay');
    const device = await startDeviceAuthorization(app, client.client_id);

    await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${encodeURIComponent(device.user_code)}`,
      { cookie: session.cookieHeader }
    );
    const approve = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: true },
      cookie: session.cookieHeader,
    });
    expect(approve.status).toBe(200);

    const first = await pollToken(app, device.device_code, client.client_id);
    expect(first.status).toBe(200);

    // Replaying the same device_code must not mint a second token.
    const replay = await pollToken(app, device.device_code, client.client_id);
    expect(replay.status).toBe(400);
    const replayBody = (await replay.json()) as { error: string; error_description?: string };
    expect(replayBody.error).toBe('invalid_grant');
    expect(replayBody.error_description).toContain('Unknown device_code');

    // Re-approving a consumed code is likewise a miss, not a resurrection.
    const reApprove = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: true },
      cookie: session.cookieHeader,
    });
    await expectNoApprovalSuccess(reApprove);
  });

  it('never returns a success body when approval is refused', async () => {
    const app = buildApp();
    const { session } = await createDeviceUser('Unclaimed Approver');
    const client = await registerCliClient(app, 'Lobu CLI unclaimed');
    const device = await startDeviceAuthorization(app, client.client_id);

    // Approving without the `/device/info` claim leaves `user_id` unset, so the
    // ownership read matches nothing and the route refuses before it ever
    // writes. The UI must see no success field on that refusal (#3623).
    const unclaimed = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: true },
      cookie: session.cookieHeader,
    });
    await expectNoApprovalSuccess(unclaimed);

    // A code that never existed is the same non-success shape — no field that
    // distinguishes it for an enumerating caller.
    const unknown = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: 'ZZZZ-ZZZZ', approved: true },
      cookie: session.cookieHeader,
    });
    await expectNoApprovalSuccess(unknown);

    // The real row is untouched, so the CLI poller is still correctly pending
    // rather than holding a credential the UI claimed it had.
    expect(await readRowStatus(device.device_code)).toBe('pending');
    const poll = await pollToken(app, device.device_code, client.client_id);
    expect(poll.status).toBe(400);
    expect(((await poll.json()) as { error: string }).error).toBe('authorization_pending');
  });

  it('a denied code reports access_denied to the poller and never mints a token', async () => {
    const app = buildApp();
    const { session } = await createDeviceUser('Denier');
    const client = await registerCliClient(app, 'Lobu CLI deny');
    const device = await startDeviceAuthorization(app, client.client_id);

    await call(
      app,
      'GET',
      `/oauth/device/info?user_code=${encodeURIComponent(device.user_code)}`,
      { cookie: session.cookieHeader }
    );
    const deny = await call(app, 'POST', '/oauth/device/approve', {
      body: { user_code: device.user_code, approved: false },
      cookie: session.cookieHeader,
    });
    expect(deny.status).toBe(200);
    expect(await deny.json()).toEqual({ status: 'denied' });
    expect(await readRowStatus(device.device_code)).toBe('denied');

    const poll = await pollToken(app, device.device_code, client.client_id);
    expect(poll.status).toBe(400);
    expect(((await poll.json()) as { error: string }).error).toBe('access_denied');
  });
});
