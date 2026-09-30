/**
 * reconcileDeviceCapabilities — auto-wired device connections must seed
 * `default_connection_config` exactly like manage_connections create/connect do.
 *
 * Auto-wire must preserve connector settings when a device reconnects or a
 * replacement device creates a new connection.
 *
 * The same pass must (a) seed new rows from the org definition default, (b) heal
 * a surviving NULL-config row once a default exists, and (c) never clobber an
 * explicit per-connection config. No default → keep writing NULL, so the legacy
 * shape (and anything downstream that expects NULL) is untouched.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../worker-api/device-manifests';
import logger from '../../utils/logger';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();

const CONNECTOR = 'test.device_config_seed';
const CAPABILITY = 'test_device_config_seed';
const VERSION = '1.0.0';

const DEFAULT_CONFIG = { fetch_limit: 25 };

async function seedDefinition(
  orgId: string,
  defaultConfig: Record<string, unknown> | null,
  feedsSchema: Record<string, unknown> = {},
) {
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, required_capability,
      runtime, feeds_schema, auth_schema, actions_schema, options_schema,
      default_connection_config
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'Test Device Config Seed', ${VERSION}, 'active', ${CAPABILITY},
      ${sql.json({ platforms: ['macos'] })}, ${sql.json(feedsSchema)}, ${sql.json({})},
      ${sql.json({})}, ${sql.json({})}, ${defaultConfig ? sql.json(defaultConfig) : null}
    )
  `;
  // device-manifest connectors install `connector_versions` through
  // upsertConnectorDefinitionRecords; the ready-gate version_key check needs
  // the match present, exactly as the pin-guard harness does.
  await sql`
    INSERT INTO connector_versions (organization_id, connector_key, version)
    VALUES (${orgId}, ${CONNECTOR}, ${VERSION})
    ON CONFLICT DO NOTHING
  `;
}

async function manifestFor(
  feeds: Record<string, unknown>,
): Promise<typeof MANIFEST> {
  return {
    key: CONNECTOR,
    version: VERSION,
    name: 'Test Device Config Seed',
    required_capability: CAPABILITY,
    runtime: { platforms: ['macos'] },
    // Mirror the definition row the harness seeds so the manifest-matches-
    // source check (and with it the ready fast path) can actually pass —
    // without these the wildcard fields fall back to `{ methods: [...none] }`
    // / null and no poll ever converges to the fast path.
    auth_schema: {},
    actions_schema: {},
    options_schema: {},
    feeds_schema: feeds,
  };
}

const MANIFEST = {
  key: CONNECTOR,
  version: VERSION,
  name: 'Test Device Config Seed',
  required_capability: CAPABILITY,
  runtime: { platforms: ['macos'] },
  feeds_schema: {},
};

async function seedWorker(
  userId: string,
  orgId: string,
  feeds: Record<string, unknown> = {},
): Promise<string> {
  const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
  const manifest =
    Object.keys(feeds).length > 0 ? await manifestFor(feeds) : MANIFEST;
  const manifests = {
    [CONNECTOR]: {
      manifest,
      manifest_hash: deviceManifestHash(manifest as DeviceConnectorManifest),
      received_at: new Date().toISOString(),
    },
  };
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id,
      last_seen_at, connector_manifests
    ) VALUES (
      ${userId}, ${workerId}, 'macos', ${sql.json([CAPABILITY])},
      'Mac mini', ${orgId}, NOW(), ${sql.json(manifests)}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function seedConn(
  orgId: string,
  userId: string,
  config: Record<string, unknown> | null | undefined,
): Promise<number> {
  const slug = `conn-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      auth_profile_id, created_by, visibility, config
    ) VALUES (
      ${orgId}, ${CONNECTOR}, ${slug}, 'Test Device Config Seed', 'active',
      NULL, ${userId}, 'private', ${config === undefined ? null : config ? sql.json(config) : null}
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function configOf(id: number): Promise<Record<string, unknown> | null> {
  const [row] = (await sql`
    SELECT config FROM connections WHERE id = ${id}
  `) as unknown as Array<{ config: unknown }>;
  if (row == null || row.config == null) return null;
  return typeof row.config === 'string'
    ? JSON.parse(row.config)
    : (row.config as Record<string, unknown>);
}

async function setUpOrg(): Promise<{ orgId: string; userId: string }> {
  const user = await createTestUser();
  const org = await createTestOrganization();
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
    WHERE id = ${org.id}
  `;
  return { orgId: org.id, userId: user.id };
}

describe('device reconcile config seeding', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    ({ orgId, userId } = await setUpOrg());
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('creates a connection whose config is seeded from the definition default', async () => {
    await seedDefinition(orgId, DEFAULT_CONFIG);
    await seedWorker(userId, orgId);

    await reconcileDeviceCapabilities(userId);

    const [row] = (await sql`
      SELECT id, config FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
    `) as unknown as Array<{ id: number; config: unknown }>;
    expect(row).toBeDefined();
    expect(row.config).toEqual(DEFAULT_CONFIG);
  });

  it('seeds an existing NULL-config connection once the definition has a default', async () => {
    await seedDefinition(orgId, DEFAULT_CONFIG);
    await seedWorker(userId, orgId);
    const id = await seedConn(orgId, userId, null);

    await reconcileDeviceCapabilities(userId);

    expect(await configOf(id)).toEqual(DEFAULT_CONFIG);
  });

  it('never clobbers an explicit per-connection config', async () => {
    await seedDefinition(orgId, DEFAULT_CONFIG);
    await seedWorker(userId, orgId);
    const explicit = { fetch_limit: 50 };
    const id = await seedConn(orgId, userId, explicit);

    await reconcileDeviceCapabilities(userId);

    expect(await configOf(id)).toEqual(explicit);
  });

  it('keeps config NULL when the definition has no default', async () => {
    await seedDefinition(orgId, null);
    await seedWorker(userId, orgId);

    await reconcileDeviceCapabilities(userId);

    const [row] = (await sql`
      SELECT config FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
    `) as unknown as Array<{ config: unknown }>;
    expect(row).toBeDefined();
    expect(row.config).toBeNull();
  });

  it('converges without re-wiring when the definition default is wholly feed-scoped', async () => {
    const FEEDS = {
      main: {
        operations: ['sync'],
        configSchema: {
          type: 'object',
          properties: { lookback_days: { type: 'number' } },
        },
      },
    };
    await seedDefinition(orgId, { lookback_days: 30 }, FEEDS);
    await seedWorker(userId, orgId, FEEDS);

    const info = vi.spyOn(logger, 'info');
    try {
      await reconcileDeviceCapabilities(userId);
      await reconcileDeviceCapabilities(userId);

      const [row] = (await sql`
        SELECT config FROM connections
        WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
      `) as unknown as Array<{ config: unknown }>;
      // Feed-scoped defaults never belong on the connection row.
      expect(row).toBeDefined();
      expect(row.config).toBeNull();

      const wired = info.mock.calls.filter(
        (call) => call[1] === '[device-connectors] Wired device connector',
      );
      // Exactly one wire pass. A ready-gate that approximated "default exists"
      // with the raw default instead of the seedable CONNECTION-scoped half
      // spun forever here: NULL config + wholly feed-scoped default re-wired
      // (and re-upserted the definition) on every single poll.
      expect(wired).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
});
