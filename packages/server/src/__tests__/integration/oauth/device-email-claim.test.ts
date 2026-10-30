/**
 * Agent device-claim email tests (POST /oauth/device/email)
 *
 * The agent starts a standard device_authorization, then delivers it to a user
 * by email instead of having them type a user_code. We assert the endpoint
 * triggers a Better Auth magic link (a `verification` row is created before
 * delivery), stays opaque about whether the email has an account, and rejects
 * the agent's own bad input.
 *
 * Email delivery is best-effort and offline here: testEnv sets no
 * CLOUDFLARE_EMAIL_API_TOKEN, so the magic-link send callback throws *after* the
 * verification value is persisted — the handler swallows that and still
 * returns the opaque 202.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import { MagicLinkEmail } from '../../../email/templates/magic-link';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestSession, createTestUser } from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function pendingUserCode(): Promise<string> {
  const register = await post('/oauth/register', {
    body: {
      client_name: 'Claim Test Agent',
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(register.status).toBe(201);
  const client = (await register.json()) as { client_id: string };

  const device = await post('/oauth/device_authorization', {
    body: {
      client_id: client.client_id,
      scope: 'mcp:read mcp:write',
      resource: 'http://localhost/mcp',
    },
  });
  expect(device.status).toBe(200);
  const body = (await device.json()) as { user_code: string };
  return body.user_code;
}

async function verificationExistsFor(email: string): Promise<boolean> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT 1 FROM verification WHERE value LIKE ${`%${email}%`} LIMIT 1
  `) as unknown as Array<unknown>;
  return rows.length === 1;
}

describe('POST /oauth/device/email — agent account claim', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  it('triggers a magic link for a pending user_code and returns an opaque 202', async () => {
    const userCode = await pendingUserCode();
    const email = `claim-${Date.now()}@example.com`;

    const res = await post('/oauth/device/email', {
      body: { user_code: userCode, email },
    });

    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('pending');

    // signInMagicLink persists the verification value before invoking the send
    // callback, so a row proves the magic link was triggered for this address.
    expect(await verificationExistsFor(email)).toBe(true);
  });

  it('returns the same opaque 202 whether or not the email already has an account', async () => {
    const existing = await createTestUser({ email: `existing-${Date.now()}@example.com` });
    const fresh = `new-${Date.now()}@example.com`;

    const resExisting = await post('/oauth/device/email', {
      body: { user_code: await pendingUserCode(), email: existing.email },
    });
    const resNew = await post('/oauth/device/email', {
      body: { user_code: await pendingUserCode(), email: fresh },
    });

    expect(resExisting.status).toBe(202);
    expect(resNew.status).toBe(202);
    expect((await resExisting.json()).status).toBe('pending');
    expect((await resNew.json()).status).toBe('pending');
  });

  it('rejects an unknown or expired user_code with 400 (the agent\'s own error)', async () => {
    const res = await post('/oauth/device/email', {
      body: { user_code: 'NOPE-NOPE', email: 'x@example.com' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('rejects email delivery after a user has claimed the code', async () => {
    const userCode = await pendingUserCode();
    const user = await createTestUser({ name: 'Claimed verifier' });
    const session = await createTestSession(user.id);
    const info = await get(`/oauth/device/info?user_code=${encodeURIComponent(userCode)}`, {
      cookie: session.cookieHeader,
    });
    expect(info.status).toBe(200);

    const res = await post('/oauth/device/email', {
      body: { user_code: userCode, email: `late-${Date.now()}@example.com` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('requires user_code, email, and a plausible address', async () => {
    const userCode = await pendingUserCode();

    const noEmail = await post('/oauth/device/email', { body: { user_code: userCode } });
    expect(noEmail.status).toBe(400);

    const noCode = await post('/oauth/device/email', { body: { email: 'x@example.com' } });
    expect(noCode.status).toBe(400);

    const badEmail = await post('/oauth/device/email', {
      body: { user_code: userCode, email: 'not-an-email' },
    });
    expect(badEmail.status).toBe(400);
  });

  it('rejects malformed non-string inputs with 400 (not an uncaught 500)', async () => {
    const res = await post('/oauth/device/email', {
      body: { user_code: 123, email: { nested: true } },
    });
    expect(res.status).toBe(400);
  });

  it('returns sanitized client branding in device info', async () => {
    const branded = await post('/oauth/register', {
      body: {
        client_name: 'Branded Device Agent',
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        token_endpoint_auth_method: 'none',
        logo_uri: 'https://branded.example.com/logo.png',
        client_uri: 'https://branded.example.com/',
      },
    });
    expect(branded.status).toBe(201);
    const brandedClient = (await branded.json()) as { client_id: string };
    const brandedDevice = await post('/oauth/device_authorization', {
      body: {
        client_id: brandedClient.client_id,
        scope: 'mcp:read',
        resource: 'http://localhost/mcp',
      },
    });
    expect(brandedDevice.status).toBe(200);
    const brandedCode = ((await brandedDevice.json()) as { user_code: string }).user_code;

    const junk = await post('/oauth/register', {
      body: {
        client_name: 'Junk Brand Device Agent',
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        token_endpoint_auth_method: 'none',
        logo_uri: 'javascript:alert(1)',
        client_uri: 'http://insecure.example.com/',
      },
    });
    expect(junk.status).toBe(201);
    const junkClient = (await junk.json()) as { client_id: string };
    const junkDevice = await post('/oauth/device_authorization', {
      body: {
        client_id: junkClient.client_id,
        scope: 'mcp:read',
        resource: 'http://localhost/mcp',
      },
    });
    expect(junkDevice.status).toBe(200);
    const junkCode = ((await junkDevice.json()) as { user_code: string }).user_code;

    const user = await createTestUser({ name: 'Branding verifier' });
    const session = await createTestSession(user.id);
    const brandedInfo = await get(
      `/oauth/device/info?user_code=${encodeURIComponent(brandedCode)}`,
      { cookie: session.cookieHeader }
    );
    expect(brandedInfo.status).toBe(200);
    expect(await brandedInfo.json()).toMatchObject({
      logo_uri: 'https://branded.example.com/logo.png',
      client_uri: 'https://branded.example.com/',
    });

    const junkInfo = await get(`/oauth/device/info?user_code=${encodeURIComponent(junkCode)}`, {
      cookie: session.cookieHeader,
    });
    expect(junkInfo.status).toBe(200);
    expect(await junkInfo.json()).toMatchObject({ logo_uri: null, client_uri: null });
  });
});

describe('MagicLinkEmail authorization copy', () => {
  it('includes the device user code so stale approval emails are distinguishable', async () => {
    const text = await render(
      MagicLinkEmail({
        mode: 'authorize',
        url: 'https://app.lobu.ai/api/auth/magic-link/verify?token=t&callbackURL=%2Foauth%2Fdevice%3Fuser_code%3DB49F-VMPZ',
      }),
      { plainText: true }
    );

    expect(text).toContain('Approval code: B49F-VMPZ');
  });
});
