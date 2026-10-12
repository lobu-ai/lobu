/**
 * Device pairing, re-minting, renaming, moving, forgetting, and stale-device
 * reaping write workspace audit events. User actions carry their actor;
 * reaper actions have no user actor. Forgetting also revokes bound PATs.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthInfo } from '../../auth/oauth/types';
import type { Env } from '../../index';
import { reapStaleDeviceWorkers } from '../../scheduled/reap-stale-device-workers';
import {
  deleteDeviceWorker,
  mintDeviceChildToken,
  updateDeviceWorkerOrg,
} from '../../worker-api/device-management';
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

const FIRST_PARTY_LOGIN: Pick<AuthInfo, 'scopes' | 'tokenType' | 'authorizationGrantType'> = {
  scopes: ['mcp:read', 'mcp:write', 'mcp:admin', 'device_worker:run'],
  tokenType: 'access_token',
  authorizationGrantType: 'device_code',
};

function deviceApp(userId: string) {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string }; mcpAuthInfo: unknown } }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId });
    c.set('mcpAuthInfo', FIRST_PARTY_LOGIN);
    await next();
  });
  app.post('/api/me/devices/mint-child-token', (c) => mintDeviceChildToken(c as never));
  app.patch('/api/me/devices/:id', (c) => updateDeviceWorkerOrg(c as never));
  app.delete('/api/me/devices/:id', (c) => deleteDeviceWorker(c as never));
  const call = (method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      TEST_ENV
    );
  return call;
}

type AuditRow = {
  title: string;
  organization_id: string;
  created_by: string | null;
  metadata: { entity_id: string; extra?: Record<string, unknown> };
};

/** Audit writes are fire-and-forget; wait for the expected rows to land. */
async function auditRows(originType: string, entityId: string, expected = 1): Promise<AuditRow[]> {
  const sql = getTestDb();
  for (let i = 0; i < 60; i++) {
    const rows = (await sql`
      SELECT title, organization_id, created_by, metadata
      FROM events
      WHERE origin_type = ${originType} AND metadata->>'entity_id' = ${entityId}
      ORDER BY id
    `) as unknown as AuditRow[];
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

async function personalUser(email: string) {
  const sql = getTestDb();
  const org = await createTestOrganization({ name: `Personal ${email}` });
  const user = await createTestUser({ email });
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
    WHERE id = ${org.id}
  `;
  await addUserToOrganization(user.id, org.id, 'owner');
  return { org, user };
}

async function deviceRow(userId: string, workerId: string) {
  const rows = (await getTestDb()`
    SELECT id FROM device_workers WHERE user_id = ${userId} AND worker_id = ${workerId}
  `) as unknown as Array<{ id: string }>;
  return String(rows[0].id);
}

async function patIds(userId: string, workerId: string) {
  return (await getTestDb()`
    SELECT id, revoked_at FROM personal_access_tokens
    WHERE user_id = ${userId} AND worker_id = ${workerId}
    ORDER BY id
  `) as unknown as Array<{ id: number; revoked_at: Date | null }>;
}

describe('device audit trail', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  it('records a device paired through the Mac app, its token, and a re-mint, with the actor', async () => {
    const { org, user } = await personalUser('audit-mint@test.example.com');
    const call = deviceApp(user.id);
    const body = { platform: 'headless', worker_id: 'headless:audit-mint', label: 'Audit box' };

    expect((await call('POST', '/api/me/devices/mint-child-token', body)).status).toBe(200);
    const deviceId = await deviceRow(user.id, 'headless:audit-mint');
    const created = await auditRows('device_created', deviceId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ organization_id: org.id, created_by: user.id });
    expect(created[0].metadata.extra).toMatchObject({ via: 'mint-child-token', worker_id: 'headless:audit-mint' });
    const [first] = await patIds(user.id, 'headless:audit-mint');
    expect(await auditRows('access_token_created', String(first.id))).toEqual([
      expect.objectContaining({ organization_id: org.id, created_by: user.id }),
    ]);

    // A re-mint keeps the device (no second "created") and revokes the old PAT.
    expect((await call('POST', '/api/me/devices/mint-child-token', body)).status).toBe(200);
    const pats = await patIds(user.id, 'headless:audit-mint');
    expect(pats).toHaveLength(2);
    const revoked = await auditRows('access_token_deleted', String(first.id));
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ created_by: user.id });
    expect(revoked[0].metadata.extra).toMatchObject({ reason: 'device-remint' });
    expect(await auditRows('access_token_created', String(pats[1].id))).toHaveLength(1);
    expect(await auditRows('device_created', deviceId)).toHaveLength(1);
  });

  it('records a rename once and a move in both workspaces, and nothing for a no-op', async () => {
    const { org, user } = await personalUser('audit-move@test.example.com');
    const team = await createTestOrganization({ name: 'Audit Team' });
    await addUserToOrganization(user.id, team.id, 'member');
    const call = deviceApp(user.id);
    await call('POST', '/api/me/devices/mint-child-token', { platform: 'headless', worker_id: 'headless:audit-move' });
    const deviceId = await deviceRow(user.id, 'headless:audit-move');

    expect((await call('PATCH', `/api/me/devices/${deviceId}`, { organization_id: org.id })).status).toBe(200);
    expect((await call('PATCH', `/api/me/devices/${deviceId}`, { label: 'Renamed' })).status).toBe(200);
    expect((await call('PATCH', `/api/me/devices/${deviceId}`, { organization_id: team.id })).status).toBe(200);

    const updates = await auditRows('device_updated', deviceId, 3);
    expect(updates).toHaveLength(3);
    const rename = updates.find((row) => row.metadata.extra?.label_to === 'Renamed');
    const move = updates.filter((row) => row.metadata.extra?.to_organization_id === team.id);
    expect(rename).toMatchObject({ organization_id: org.id, created_by: user.id });
    expect(rename?.metadata.extra).toMatchObject({ label_from: null, label_to: 'Renamed' });
    expect(move.map((row) => row.organization_id).sort()).toEqual([org.id, team.id].sort());
    for (const row of move) {
      expect(row.created_by).toBe(user.id);
      expect(row.metadata.extra).toMatchObject({ from_organization_id: org.id, to_organization_id: team.id });
      expect(row.title).toBe(
        row.organization_id === team.id
          ? 'Device "Renamed" moved into this workspace'
          : 'Device "Renamed" moved to another workspace'
      );
    }
  });

  it('revokes the device PATs on delete and records both, with the actor', async () => {
    const { org, user } = await personalUser('audit-delete@test.example.com');
    const call = deviceApp(user.id);
    await call('POST', '/api/me/devices/mint-child-token', { platform: 'headless', worker_id: 'headless:audit-delete' });
    const deviceId = await deviceRow(user.id, 'headless:audit-delete');

    expect((await call('DELETE', `/api/me/devices/${deviceId}`)).status).toBe(200);

    const pats = await patIds(user.id, 'headless:audit-delete');
    expect(pats).toHaveLength(1);
    expect(pats[0].revoked_at).not.toBeNull();
    const deleted = await auditRows('device_deleted', deviceId);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ organization_id: org.id, created_by: user.id });
    expect(deleted[0].metadata.extra).toMatchObject({ revoked_tokens: 1 });
    const revoked = await auditRows('access_token_deleted', String(pats[0].id));
    expect(revoked[0]).toMatchObject({ created_by: user.id });
    expect(revoked[0].metadata.extra).toMatchObject({ reason: 'device-deleted' });
  });

  it('records devices the reaper removes and the PATs it revokes', async () => {
    const sql = getTestDb();
    const { org, user } = await personalUser('audit-reap@test.example.com');
    const call = deviceApp(user.id);
    await call('POST', '/api/me/devices/mint-child-token', { platform: 'headless', worker_id: 'headless:audit-reap' });
    const deviceId = await deviceRow(user.id, 'headless:audit-reap');
    await sql`UPDATE device_workers SET last_seen_at = now() - interval '31 days' WHERE id = ${deviceId}`;

    expect((await reapStaleDeviceWorkers()).reaped).toBeGreaterThanOrEqual(1);

    const deleted = await auditRows('device_deleted', deviceId);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ organization_id: org.id, created_by: null });
    expect(deleted[0].metadata.extra).toMatchObject({ reason: 'stale' });
    const [pat] = await patIds(user.id, 'headless:audit-reap');
    expect(pat.revoked_at).not.toBeNull();
    const revoked = await auditRows('access_token_deleted', String(pat.id));
    expect(revoked[0].metadata.extra).toMatchObject({ reason: 'device-reaped' });
  });

  it('leaves another user\'s PAT on the same worker_id live when reaping', async () => {
    const sql = getTestDb();
    const stale = await personalUser('audit-reap-shared-a@test.example.com');
    const active = await personalUser('audit-reap-shared-b@test.example.com');
    const body = { platform: 'headless', worker_id: 'headless:shared-name' };
    await deviceApp(stale.user.id)('POST', '/api/me/devices/mint-child-token', body);
    await deviceApp(active.user.id)('POST', '/api/me/devices/mint-child-token', body);
    await sql`
      UPDATE device_workers SET last_seen_at = now() - interval '31 days'
      WHERE user_id = ${stale.user.id} AND worker_id = 'headless:shared-name'
    `;

    await reapStaleDeviceWorkers();

    const [stalePat] = await patIds(stale.user.id, 'headless:shared-name');
    const [activePat] = await patIds(active.user.id, 'headless:shared-name');
    expect(stalePat.revoked_at).not.toBeNull();
    expect(activePat.revoked_at).toBeNull();
  });
});
