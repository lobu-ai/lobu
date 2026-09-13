/**
 * First-party client version floor: user-scoped device polls below
 * MIN_CLIENT_VERSION fail LOUD (409 upgrade_required) before any DB work;
 * at/above-floor and unset-floor polls behave exactly as before.
 */

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { pollWorkerJob } from '../../worker-api/poll';
import { cleanupTestDatabase } from '../setup/test-db';
import { seedOwnerContext } from '../setup/test-fixtures';

describe('worker client version floor', () => {
  beforeAll(() => {
    process.env.MIN_CLIENT_VERSION = '1.4.0';
  });

  afterAll(() => {
    delete process.env.MIN_CLIENT_VERSION;
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  async function pollAs(
    orgId: string,
    userId: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const app = new Hono();
    app.post(
      '/api/workers/poll',
      async (c, next) => {
        c.set('workerAuthMode' as never, 'user' as never);
        c.set('workerUserId' as never, userId as never);
        c.set('workerOrgIds' as never, [orgId] as never);
        c.set('organizationId' as never, orgId as never);
        c.set('mcpAuthInfo' as never, { scopes: ['device_worker:run'] } as never);
        await next();
      },
      (c) => pollWorkerJob(c as never)
    );
    const response = await app.fetch(
      new Request('http://localhost/api/workers/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worker_id: 'floor-probe-worker',
          capabilities: {},
          ...body,
        }),
      }),
      {} as never
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('rejects a below-floor user device with upgrade_required before claiming', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Version Floor Org' });
    const rejected = await pollAs(org.id, user.id, {
      platform: 'macos',
      app_version: '1.3.9',
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('upgrade_required');
    expect(String(rejected.body.error_description)).toContain('Mac app');
  });

  it('rejects a version-less user device while a floor is set (fail closed, loud)', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Version Floor Org' });
    const rejected = await pollAs(org.id, user.id, {
      platform: 'chrome-extension',
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('upgrade_required');
    expect(String(rejected.body.error_description)).toContain('Chrome extension');
  });

  it('lets at-floor and above-floor devices poll normally', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Version Floor Org' });
    for (const app_version of ['1.4.0', '2.0.0']) {
      const ok = await pollAs(org.id, user.id, { platform: 'macos', app_version });
      expect(ok.status).toBe(200);
      expect(ok.body.error).toBeUndefined();
    }
  });
});
