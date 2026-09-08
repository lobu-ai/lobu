/**
 * reconcileDeviceCapabilities — never steal a device pin another live
 * connection holds. Integration test against real Postgres.
 *
 * `idx_connections_org_connector_device_live` is UNIQUE on
 * (organization_id, connector_key, device_worker_id) WHERE deleted_at IS NULL
 * AND device_worker_id IS NOT NULL — an org legitimately holds one connection
 * PER DEVICE, the same shape `idx_connections_org_connector_account_live` gives
 * OAuth accounts.
 *
 * An offline device's connection retains its placement even when another
 * device can serve the connector. Initial binding must still respect the
 * unique device ownership constraint.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../worker-api/device-manifests';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();

const CONNECTOR = 'test.device_pin';
const CAPABILITY = 'test_device_pin';

async function seedDefinition(orgId: string) {
  // A bundled-shape device connector: runtime + required_capability, and
  // feeds_schema {} so `declaredFeedKeys` is empty and the fast-path `ready`
  // check short-circuits true — exactly apple.computer_use's shape.
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, required_capability,
      runtime, feeds_schema, auth_schema, actions_schema, options_schema
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'Test Device Pin', '1.0.0', 'active', ${CAPABILITY},
      ${sql.json({ kind: 'device' })}, ${sql.json({})}, ${sql.json({})},
      ${sql.json({})}, ${sql.json({})}
    )
  `;
  await sql`
    INSERT INTO connector_versions (organization_id, connector_key, version)
    VALUES (${orgId}, ${CONNECTOR}, '1.0.0')
    ON CONFLICT DO NOTHING
  `;
}

/**
 * The connector must reach reconcile as a DEVICE MANIFEST: bundled connectors
 * come from the on-disk catalog (`getBundledDeviceConnectors`), which is empty
 * in tests, so a DB-only definition never enters `byKey` and the wire pass
 * returns before it can pin anything.
 */
const MANIFEST = {
  key: CONNECTOR,
  version: '1.0.0',
  name: 'Test Device Pin',
  required_capability: CAPABILITY,
  runtime: { platforms: ['macos'] },
  feeds_schema: {},
};

async function seedWorker(userId: string, orgId: string, fresh: boolean): Promise<string> {
  const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
  // Stale = outside DEVICE_WORKER_FRESH_INTERVAL ('7 days').
  const lastSeen = fresh ? new Date() : new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const manifests = {
    [CONNECTOR]: {
      manifest: MANIFEST,
      manifest_hash: deviceManifestHash(MANIFEST as DeviceConnectorManifest),
      received_at: new Date().toISOString(),
    },
  };
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id,
      last_seen_at, connector_manifests
    ) VALUES (
      ${userId}, ${workerId}, 'macos', ${sql.json([CAPABILITY])},
      ${fresh ? 'Mac mini' : 'MacBook Pro'}, ${orgId}, ${lastSeen},
      ${sql.json(manifests)}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function seedConn(orgId: string, userId: string, device: string | null): Promise<number> {
  const slug = `conn-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      auth_profile_id, created_by, visibility, device_worker_id
    ) VALUES (
      ${orgId}, ${CONNECTOR}, ${slug}, 'Test Device Pin', 'active',
      NULL, ${userId}, 'private', ${device}::uuid
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function pinOf(id: number): Promise<string | null> {
  const [row] = (await sql`
    SELECT device_worker_id FROM connections WHERE id = ${id}
  `) as unknown as Array<{ device_worker_id: string | null }>;
  return row?.device_worker_id ?? null;
}

describe('device pin owner guard', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const org = await createTestOrganization();
    orgId = org.id;
    // Auto-wire targets the user's PERSONAL org, resolved by this metadata tag
    // (auth/personal-org-provisioning.ts) rather than by ownership.
    await sql`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: userId })}
      WHERE id = ${orgId}
    `;
    await seedDefinition(orgId);
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('preserves both pins when only one device is online', async () => {
    const staleDevice = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);

    const retired = await seedConn(orgId, userId, staleDevice); // old MacBook's row
    const current = await seedConn(orgId, userId, freshDevice); // new Mac mini's row

    // Both rows are already pinned, so the wire pass must leave both alone —
    // it may neither repoint the retired row nor contend for the fresh device.
    await reconcileDeviceCapabilities(userId);

    // Offline placement is retained; it must not become a fleet-wide grant.
    expect(await pinOf(current)).toBe(freshDevice);
    expect(await pinOf(retired)).toBe(staleDevice);
  });

  it('does not move an offline pin to the sole fresh device', async () => {
    const staleDevice = await seedWorker(userId, orgId, false);
    await seedWorker(userId, orgId, true);
    const only = await seedConn(orgId, userId, staleDevice);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(only)).toBe(staleDevice);
  });

  it('leaves a pin that is already a fresh device untouched', async () => {
    const freshDevice = await seedWorker(userId, orgId, true);
    const only = await seedConn(orgId, userId, freshDevice);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(only)).toBe(freshDevice);
  });

  it('initially binds an unpinned connection to its sole advertiser', async () => {
    const device = await seedWorker(userId, orgId, true);
    const connection = await seedConn(orgId, userId, null);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(connection)).toBe(device);
  });

  it('leaves an unpinned connection alone when a sibling owns the sole advertiser', async () => {
    const device = await seedWorker(userId, orgId, true);
    const unpinned = await seedConn(orgId, userId, null);
    const owner = await seedConn(orgId, userId, device);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(unpinned)).toBeNull();
    expect(await pinOf(owner)).toBe(device);
  });
});
