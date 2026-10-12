/**
 * POST /api/me/devices/mint-child-token registers eligible device platforms
 * from a device_worker:run bearer and binds each device + child PAT to the
 * user's personal org. The suite covers headless, Chrome, and macOS child-mint
 * requests plus the shared platform-isolation rules.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthInfo } from '../../auth/oauth/types';
import type { Env } from '../../index';
import { __resetPublicOriginCachesForTests } from '../../utils/public-origin';
import { mintDeviceChildToken } from '../../worker-api/device-management';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

async function withPublicGatewayUrl<T>(
  value: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  const previous = process.env.PUBLIC_GATEWAY_URL;
  if (value === undefined) {
    delete process.env.PUBLIC_GATEWAY_URL;
  } else {
    process.env.PUBLIC_GATEWAY_URL = value;
  }
  __resetPublicOriginCachesForTests();
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.PUBLIC_GATEWAY_URL;
    } else {
      process.env.PUBLIC_GATEWAY_URL = previous;
    }
    __resetPublicOriginCachesForTests();
  }
}

async function markPersonalOrg(orgId: string, userId: string): Promise<void> {
  const sql = getTestDb();
  // Match personal-org-provisioning.ts: the marker lives in org metadata as
  // plain JSON text (the read path casts with (metadata::jsonb)->>).
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: userId })}
    WHERE id = ${orgId}
  `;
}

type MintCaller = Pick<AuthInfo, 'scopes' | 'tokenType' | 'authorizationGrantType' | 'workerId'>;

// The Mac app's own sign-in: a device-code grant that carries mcp:admin.
const FIRST_PARTY_LOGIN: MintCaller = {
  scopes: ['mcp:read', 'mcp:write', 'mcp:admin', 'device_worker:run'],
  tokenType: 'access_token',
  authorizationGrantType: 'device_code',
};

function mintApp(
  userId: string,
  caller: MintCaller = FIRST_PARTY_LOGIN
): Hono<{ Bindings: Env; Variables: { user: { id: string }; mcpAuthInfo: MintCaller | null } }> {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string }; mcpAuthInfo: MintCaller | null } }>();
  app.post(
    '/api/me/devices/mint-child-token',
    async (c, next) => {
      // Device-scoped bearer: device_worker:run scope, NO MCP resource audience.
      c.set('user', { id: userId });
      c.set('mcpAuthInfo', caller);
      await next();
    },
    (c) => mintDeviceChildToken(c)
  );
  return app;
}

describe('device mint (mint-child-token)', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  it('mints a headless device bound to the personal org with an owl_pat_ child token', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal' });
    const user = await createTestUser({ email: 'headless-mint@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await withPublicGatewayUrl(undefined, () =>
      mintApp(user.id).request(
        '/api/me/devices/mint-child-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'headless', label: 'herdr-test' }),
        },
        TEST_ENV
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worker_id: string;
      access_token: string;
      platform: string;
      label: string;
      gateway_url: string;
    };
    expect(body.platform).toBe('headless');
    expect(body.label).toBe('herdr-test');
    expect(body.access_token.startsWith('owl_pat_')).toBe(true);
    expect(body.gateway_url).toBe('http://localhost');

    // The persisted device row is platform- and personal-org-bound.
    const rows = (await sql`
      SELECT platform, label, organization_id FROM device_workers
      WHERE user_id = ${user.id} AND worker_id = ${body.worker_id}
    `) as unknown as Array<{ platform: string; label: string; organization_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe('headless');
    expect(rows[0].label).toBe('herdr-test');
    expect(rows[0].organization_id).toBe(personalOrg.id);
  });

  it('stamps the configured public origin when the request uses an internal ingress URL', async () => {
    const personalOrg = await createTestOrganization({ name: 'Personal Public Origin' });
    const user = await createTestUser({ email: 'public-origin-mint@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await withPublicGatewayUrl('https://app.lobu.ai/lobu', () =>
      mintApp(user.id).request(
        'http://app.lobu.ai/api/me/devices/mint-child-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'macos', label: 'Public origin test' }),
        },
        TEST_ENV
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateway_url: string };
    expect(body.gateway_url).toBe('https://app.lobu.ai');
  });

  it('uses a first-party login caller requested worker_id for a new headless device', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Requested ID' });
    const user = await createTestUser({ email: 'headless-requested-id@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await mintApp(user.id).request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'headless',
          worker_id: 'headless:herdr-session',
          label: 'Herdr session',
        }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worker_id: string;
      access_token: string;
      session_token: string | null;
    };
    expect(body.worker_id).toBe('headless:herdr-session');
    expect(body.access_token.startsWith('owl_pat_')).toBe(true);
    expect(body.session_token).toBeNull();

    const rows = (await sql`
      SELECT worker_id, platform, organization_id FROM device_workers
      WHERE user_id = ${user.id}
    `) as unknown as Array<{
      worker_id: string;
      platform: string;
      organization_id: string;
    }>;
    expect(rows).toEqual([
      {
        worker_id: 'headless:herdr-session',
        platform: 'headless',
        organization_id: personalOrg.id,
      },
    ]);
  });

  it('rejects an invalid requested worker_id before minting a child token', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Invalid ID' });
    const user = await createTestUser({ email: 'headless-invalid-id@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await mintApp(user.id).request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'headless',
          worker_id: 'headless id with spaces',
        }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_worker_id' });
    const pats = (await sql`
      SELECT id FROM personal_access_tokens WHERE user_id = ${user.id}
    `) as unknown as Array<{ id: number }>;
    expect(pats).toHaveLength(0);
  });

  it('serializes concurrent first mint for the same requested worker_id', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Concurrent ID' });
    const user = await createTestUser({ email: 'headless-concurrent-id@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    const app = mintApp(user.id);
    const request = () =>
      app.request(
        '/api/me/devices/mint-child-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            platform: 'headless',
            worker_id: 'headless:concurrent-herdr',
          }),
        },
        TEST_ENV
      );

    // In-process requests against one pool serialize: each caller observes the
    // previous device row and takes the ordinary re-mint path, so this asserts
    // the CONVERGENCE contract (one device row, one live PAT) rather than the
    // multi-replica race the handler's advisory lock exists for — that one
    // needs two writers past the optimistic lookup at once, which a single
    // process cannot stage.
    const responses = await Promise.all(Array.from({ length: 4 }, request));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const bodies = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ worker_id: string; access_token: string }>
      )
    );
    expect(bodies.map((body) => body.worker_id)).toEqual(
      Array.from({ length: 4 }, () => 'headless:concurrent-herdr')
    );

    const devices = (await sql`
      SELECT worker_id FROM device_workers
      WHERE user_id = ${user.id} AND worker_id = 'headless:concurrent-herdr'
    `) as unknown as Array<{ worker_id: string }>;
    expect(devices).toHaveLength(1);
    const pats = (await sql`
      SELECT revoked_at FROM personal_access_tokens
      WHERE user_id = ${user.id} AND worker_id = 'headless:concurrent-herdr'
    `) as unknown as Array<{ revoked_at: Date | null }>;
    expect(pats).toHaveLength(4);
    expect(pats.filter((pat) => pat.revoked_at === null)).toHaveLength(1);
  });

  it('revokes an orphaned child PAT when a deleted identity is re-registered', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Orphan' });
    const user = await createTestUser({ email: 'headless-orphan-pat@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    const app = mintApp(user.id);
    const body = JSON.stringify({ platform: 'headless', worker_id: 'headless:forgotten-box' });
    const mint = () =>
      app.request(
        '/api/me/devices/mint-child-token',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        TEST_ENV
      );

    expect((await mint()).status).toBe(200);

    // `deleteDeviceWorker` ("forget this device" on the Devices page) drops the
    // row WITHOUT revoking the PAT bound to that worker_id. Re-registering the
    // same id must not then leave two live credentials polling as one device.
    await sql`
      DELETE FROM device_workers
      WHERE user_id = ${user.id} AND worker_id = 'headless:forgotten-box'
    `;

    expect((await mint()).status).toBe(200);

    const pats = (await sql`
      SELECT revoked_at FROM personal_access_tokens
      WHERE user_id = ${user.id} AND worker_id = 'headless:forgotten-box'
    `) as unknown as Array<{ revoked_at: Date | null }>;
    expect(pats).toHaveLength(2);
    expect(pats.filter((pat) => pat.revoked_at === null)).toHaveLength(1);
  });

  it('reuses a headless worker_id on re-mint and revokes the previous child PAT', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Reuse' });
    const user = await createTestUser({ email: 'headless-mint-reuse@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    const app = mintApp(user.id);

    const first = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', label: 'herdr-reuse' }),
      },
      TEST_ENV
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { worker_id: string; access_token: string };

    // Re-register with the stored worker_id (what a headless daemon does on
    // restart): identity must stay stable and the previous PAT must be revoked.
    const second = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', worker_id: firstBody.worker_id }),
      },
      TEST_ENV
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { worker_id: string; access_token: string };
    expect(secondBody.worker_id).toBe(firstBody.worker_id);
    expect(secondBody.access_token).not.toBe(firstBody.access_token);

    const deviceRows = (await sql`
      SELECT worker_id, platform FROM device_workers WHERE user_id = ${user.id}
    `) as unknown as Array<{ worker_id: string; platform: string }>;
    expect(deviceRows).toHaveLength(1);
    expect(deviceRows[0].worker_id).toBe(firstBody.worker_id);
    expect(deviceRows[0].platform).toBe('headless');

    const pats = (await sql`
      SELECT revoked_at FROM personal_access_tokens
      WHERE user_id = ${user.id} AND worker_id = ${firstBody.worker_id}
      ORDER BY id ASC
    `) as unknown as Array<{ revoked_at: Date | null }>;
    expect(pats).toHaveLength(2);
    expect(pats[0].revoked_at).not.toBeNull();
    expect(pats[1].revoked_at).toBeNull();
  });

  it('a re-mint cannot overwrite a stored device label', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Label' });
    const user = await createTestUser({ email: 'headless-mint-label@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    const app = mintApp(user.id);

    const first = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', label: 'herdr-box' }),
      },
      TEST_ENV
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { worker_id: string };

    // The user renames it on the Devices page (PATCH /api/me/devices/:id
    // lands exactly this state).
    await sql`
      UPDATE device_workers SET label = 'Build box'
      WHERE user_id = ${user.id} AND worker_id = ${firstBody.worker_id}
    `;

    // Daemon restarts and re-registers, still self-reporting its hostname.
    const second = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'headless',
          worker_id: firstBody.worker_id,
          label: 'herdr-box',
        }),
      },
      TEST_ENV
    );
    expect(second.status).toBe(200);

    const rows = (await sql`
      SELECT label FROM device_workers
      WHERE user_id = ${user.id} AND worker_id = ${firstBody.worker_id}
    `) as unknown as Array<{ label: string | null }>;
    expect(rows[0].label).toBe('Build box');
  });

  it('does not reuse a chrome-extension worker_id when re-minting as headless', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Cross' });
    const user = await createTestUser({ email: 'headless-mint-cross@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    const app = mintApp(user.id);

    const chrome = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'chrome-extension', label: 'chrome' }),
      },
      TEST_ENV
    );
    expect(chrome.status).toBe(200);
    const chromeBody = (await chrome.json()) as {
      worker_id: string;
      session_token: string | null;
    };
    expect(typeof chromeBody.session_token).toBe('string');

    const headless = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', worker_id: chromeBody.worker_id }),
      },
      TEST_ENV
    );
    expect(headless.status).toBe(200);
    const headlessBody = (await headless.json()) as {
      worker_id: string;
      session_token: string | null;
    };
    expect(headlessBody.worker_id).not.toBe(chromeBody.worker_id);
    expect(headlessBody.session_token).toBeNull();

    const rows = (await sql`
      SELECT worker_id, platform FROM device_workers WHERE user_id = ${user.id} ORDER BY platform ASC
    `) as unknown as Array<{ worker_id: string; platform: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platform)).toEqual(['chrome-extension', 'headless']);

    // The sharp edge of the old hardcoded predicate: the reuse branch matched
    // the chrome row even though 'headless' was requested, so the re-mint
    // revoked every other PAT on that worker_id — killing the live extension's
    // credential and leaving a headless-named PAT bound to a row whose stored
    // platform stayed 'chrome-extension'. Both devices must keep a live token.
    const pats = (await sql`
      SELECT worker_id, revoked_at FROM personal_access_tokens
      WHERE user_id = ${user.id} AND worker_id IS NOT NULL
    `) as unknown as Array<{ worker_id: string; revoked_at: string | null }>;
    expect(pats).toHaveLength(2);
    expect(pats.every((p) => p.revoked_at === null)).toBe(true);
    expect(new Set(pats.map((p) => p.worker_id))).toEqual(
      new Set([chromeBody.worker_id, headlessBody.worker_id])
    );
  });

  // The child PAT only runs device work; the browser session it rides with is
  // a full web login, so only a caller that may hold one can pass it on.
  it.each([
    ['a device-worker-only bearer', { scopes: ['device_worker:run'], tokenType: 'pat' } as MintCaller],
    [
      'a read-only device-code grant',
      {
        scopes: ['mcp:read', 'profile:read', 'device_worker:run'],
        tokenType: 'access_token',
        authorizationGrantType: 'device_code',
      } as MintCaller,
    ],
  ])('mints a Chrome child without a browser session for %s', async (_label, caller) => {
    const personalOrg = await createTestOrganization({ name: 'Personal Weak Caller' });
    const user = await createTestUser({ email: `weak-${crypto.randomUUID()}@test.example.com` });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await mintApp(user.id, caller).request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'chrome-extension' }),
      },
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; session_token: string | null };
    expect(body.access_token).toMatch(/^owl_pat_/);
    expect(body.session_token).toBeNull();
  });

  it('mints the exact requested macos identity without creating a browser session', async () => {
    const sql = getTestDb();
    const user = await createTestUser({ email: 'macos-mint@test.example.com' });
    const personalOrg = await createTestOrganization({ name: 'Test Personal Mac' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await mintApp(user.id).request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'macos',
          worker_id: 'mac-test-device',
          label: 'Test Mac',
        }),
      },
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worker_id: string;
      access_token: string;
      session_token: string | null;
      platform: string;
    };
    expect(body.worker_id).toBe('mac-test-device');
    expect(body.access_token.startsWith('owl_pat_')).toBe(true);
    expect(body.session_token).toBeNull();
    expect(body.platform).toBe('macos');

    const rows = (await sql`
      SELECT worker_id, platform, organization_id FROM device_workers
      WHERE user_id = ${user.id}
    `) as unknown as Array<{
      worker_id: string;
      platform: string;
      organization_id: string;
    }>;
    expect(rows).toEqual([
      {
        worker_id: 'mac-test-device',
        platform: 'macos',
        organization_id: personalOrg.id,
      },
    ]);
  });

  it.each(['ios', 'toString'])('rejects ineligible child-token platform %s', async (platform) => {
    const user = await createTestUser({ email: `mint-reject-${platform}@test.example.com` });
    const personalOrg = await createTestOrganization({ name: `Personal Reject ${platform}` });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await mintApp(user.id).request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform, worker_id: 'must-not-be-created' }),
      },
      TEST_ENV
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: `platform '${platform}' is not eligible for child-token mint`,
    });
  });
});
