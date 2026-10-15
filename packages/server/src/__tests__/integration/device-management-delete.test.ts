/**
 * DELETE /api/me/devices/:id must not turn an active Automation pin into a raw
 * restrictive-FK failure. Device removal is human-owned cleanup: the caller
 * gets the exact blocking Automation, resolves it explicitly, then retries.
 */

import type { Context } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { DEVICE_REMOVED_TOMBSTONE } from '../../utils/device-pin-tombstones';
import { deleteDeviceWorker } from '../../worker-api/device-management';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';
import { TestApiClient } from '../setup/test-mcp-client';

function deleteContext(userId: string, deviceId: string): Context<{ Bindings: Env }> {
  return {
    var: { user: { id: userId } },
    req: {
      url: `http://localhost/api/me/devices/${deviceId}`,
      param: (name: string) => (name === 'id' ? deviceId : undefined),
    },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('device management deletion', () => {
  let owner: TestApiClient;
  let organizationId: string;
  let organizationSlug: string;
  let userId: string;
  let agentId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const organization = await createTestOrganization({
      name: 'Device Delete Automation Pin',
    });
    const user = await createTestUser({ email: 'device-delete-automation@test.example.com' });
    await addUserToOrganization(user.id, organization.id, 'owner');
    const agent = await createTestAgent({
      organizationId: organization.id,
      ownerUserId: user.id,
    });

    organizationId = organization.id;
    organizationSlug = organization.slug;
    userId = user.id;
    agentId = agent.agentId;
    owner = await TestApiClient.for({
      organizationId: organization.id,
      userId: user.id,
      memberRole: 'owner',
    });
  });

  it('returns an actionable conflict for an owned device pinned by an active Automation, then succeeds after archive', async () => {
    const sql = getTestDb();
    const deviceRows = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id
      ) VALUES (
        ${userId}, 'device-delete-automation-worker', 'macos', ${sql.json([])},
        'Pinned Mac', ${organizationId}
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const deviceId = String(deviceRows[0].id);
    const connection = await createTestConnection({
      organization_id: organizationId,
      connector_key: 'device-delete-test',
      created_by: userId,
    });
    await sql`
      UPDATE connections SET device_worker_id = ${deviceId}
      WHERE id = ${connection.id}
    `;

    const created = (await owner.automations.manage({
      action: 'create',
      slug: 'device-delete-blocker',
      name: 'Pinned Device Automation',
      prompt: 'Run only on the explicitly selected device.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: agentId,
      device_worker_id: deviceId,
    })) as { automation_id: string };
    const automationId = created.automation_id;

    const conflict = await deleteDeviceWorker(deleteContext(userId, deviceId));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: expect.stringMatching(/reassign or archive.*retry/i),
      automations: [
        {
          automation_id: automationId,
          name: 'Pinned Device Automation',
          organization_slug: organizationSlug,
          view_url: expect.stringMatching(
            new RegExp(`/${organizationSlug}/automations/${automationId}$`)
          ),
        },
      ],
    });

    const afterConflict = (await sql`
      SELECT
        EXISTS(SELECT 1 FROM device_workers WHERE id = ${deviceId}) AS device_exists,
        status,
        device_worker_id::text AS device_worker_id
      FROM automations
      WHERE id = ${automationId}
    `) as unknown as Array<{
      device_exists: boolean;
      status: string;
      device_worker_id: string | null;
    }>;
    expect(afterConflict[0]).toEqual({
      device_exists: true,
      status: 'active',
      device_worker_id: deviceId,
    });
    const connectionAfterConflict = (await sql`
      SELECT c.status, c.device_worker_id::text AS device_worker_id,
             c.error_message, f.status AS feed_status
      FROM connections c
      JOIN feeds f ON f.connection_id = c.id
      WHERE c.id = ${connection.id}
    `) as unknown as Array<{
      status: string;
      device_worker_id: string | null;
      error_message: string | null;
      feed_status: string;
    }>;
    expect(connectionAfterConflict[0]).toEqual({
      status: 'active',
      device_worker_id: deviceId,
      error_message: null,
      feed_status: 'active',
    });

    // The public delete action is the existing archival semantic: the row is
    // retained and scheduling stops. It must no longer block its device.
    await owner.automations.delete({ automation_ids: [automationId] });

    const deleted = await deleteDeviceWorker(deleteContext(userId, deviceId));
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });

    const afterDelete = (await sql`
      SELECT
        EXISTS(SELECT 1 FROM device_workers WHERE id = ${deviceId}) AS device_exists,
        status,
        device_worker_id::text AS device_worker_id
      FROM automations
      WHERE id = ${automationId}
    `) as unknown as Array<{
      device_exists: boolean;
      status: string;
      device_worker_id: string | null;
    }>;
    expect(afterDelete[0]).toEqual({
      device_exists: false,
      status: 'archived',
      device_worker_id: null,
    });
    const connectionAfterDelete = (await sql`
      SELECT c.status, c.device_worker_id::text AS device_worker_id,
             c.error_message, f.status AS feed_status
      FROM connections c
      JOIN feeds f ON f.connection_id = c.id
      WHERE c.id = ${connection.id}
    `) as unknown as Array<{
      status: string;
      device_worker_id: string | null;
      error_message: string | null;
      feed_status: string;
    }>;
    expect(connectionAfterDelete[0]).toEqual({
      status: 'paused',
      device_worker_id: null,
      error_message: DEVICE_REMOVED_TOMBSTONE,
      feed_status: 'paused',
    });
  });

  // Device-bound auth profiles cascade away with their device. The connection
  // keeps its workspace and loses only the profile reference.
  it('deletes a device whose auth profiles are still referenced by a connection', async () => {
    const sql = getTestDb();
    const deviceRows = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id
      ) VALUES (
        ${userId}, 'device-delete-auth-profile-worker', 'chrome-extension', ${sql.json([])},
        'Browser With Profiles', ${organizationId}
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const deviceId = String(deviceRows[0].id);
    const profiles = (await sql`
      INSERT INTO auth_profiles (
        organization_id, connector_key, slug, display_name, profile_kind, device_worker_id
      ) VALUES
        (${organizationId}, 'device-delete-test', 'device-delete-session', 'Session',
         'browser_session', ${deviceId}),
        (${organizationId}, 'device-delete-test', 'device-delete-app', 'App',
         'oauth_app', ${deviceId})
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const connection = await createTestConnection({
      organization_id: organizationId,
      connector_key: 'device-delete-test',
      created_by: userId,
    });
    await sql`
      UPDATE connections
      SET device_worker_id = ${deviceId},
          auth_profile_id = ${profiles[0].id},
          app_auth_profile_id = ${profiles[1].id}
      WHERE id = ${connection.id}
    `;

    const deleted = await deleteDeviceWorker(deleteContext(userId, deviceId));
    await expect(deleted.json()).resolves.toEqual({ ok: true });
    expect(deleted.status).toBe(200);

    const after = (await sql`
      SELECT c.organization_id, c.auth_profile_id, c.app_auth_profile_id,
             c.status, c.error_message,
             (SELECT count(*)::int FROM auth_profiles
              WHERE id IN (${profiles[0].id}, ${profiles[1].id})) AS remaining_profiles
      FROM connections c
      WHERE c.id = ${connection.id}
    `) as unknown as Array<Record<string, unknown>>;
    expect(after[0]).toEqual({
      organization_id: organizationId,
      auth_profile_id: null,
      app_auth_profile_id: null,
      status: 'paused',
      error_message: DEVICE_REMOVED_TOMBSTONE,
      remaining_profiles: 0,
    });
  });

  it('keeps a connection in its workspace when its auth profile is deleted directly', async () => {
    const sql = getTestDb();
    const [profile] = (await sql`
      INSERT INTO auth_profiles (
        organization_id, connector_key, slug, display_name, profile_kind
      ) VALUES (
        ${organizationId}, 'device-delete-test', 'direct-delete-env', 'Env', 'env'
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const connection = await createTestConnection({
      organization_id: organizationId,
      connector_key: 'device-delete-test',
      created_by: userId,
    });
    await sql`
      UPDATE connections SET auth_profile_id = ${profile.id}, app_auth_profile_id = ${profile.id}
      WHERE id = ${connection.id}
    `;

    await sql`DELETE FROM auth_profiles WHERE id = ${profile.id}`;

    const after = (await sql`
      SELECT organization_id, auth_profile_id, app_auth_profile_id
      FROM connections WHERE id = ${connection.id}
    `) as unknown as Array<Record<string, unknown>>;
    expect(after[0]).toEqual({
      organization_id: organizationId,
      auth_profile_id: null,
      app_auth_profile_id: null,
    });
  });
});
