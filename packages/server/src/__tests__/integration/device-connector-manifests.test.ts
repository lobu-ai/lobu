import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { parsePgTextArray } from '../../db/client';
import { isChromeNamespaceConnectorKey } from '../../utils/connector-execution-placement';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { TestApiClient } from '../setup/test-mcp-client';
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../worker-api/device-manifests';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestEvent,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';
import { DEVICE_MANIFESTS_BY_PLATFORM } from '@lobu/connector-worker/daemon/device-manifests';
import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';

// The exact contract the headless daemon advertises, read from the daemon's own
// generated artifact rather than restated here: the point of these tests is
// that the shipped manifest is claimable, which a local copy could not prove.
const HEADLESS_OS_SHELL_MANIFEST = (DEVICE_MANIFESTS_BY_PLATFORM.headless ?? []).find(
  (entry) => (entry as { key?: string }).key === 'os.shell',
) as Record<string, unknown> | undefined;
if (!HEADLESS_OS_SHELL_MANIFEST) {
  throw new Error('headless daemon advertises no os.shell manifest');
}
const HEADLESS_OS_SHELL_VERSION = HEADLESS_OS_SHELL_MANIFEST.version as string;

const CONNECTOR_KEY = 'apple.test_device_manifest';

async function seedDeviceOwner(platform = 'macos') {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-device-manifest-${generateSecureToken(4)}`;
  const workerId = `wk-${generateSecureToken(6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Device Manifest Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${orgId}, 'Device Manifest Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, ${platform}, '0.1.0', ${sql.json([])}, 'Test Device', ${orgId})
  `;
  return { userId, orgId, workerId };
}

const CHROME_MANIFEST_KEY = 'chrome.messages';
const CHROME_MANIFEST_CAPABILITY = 'browser.history';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    key: CONNECTOR_KEY,
    version: '0.1.0',
    name: 'Device Manifest Test',
    description: 'Metadata-only connector manifest registered by a device.',
    required_capability: 'screentime',
    runtime: { platforms: ['macos'] },
    auth_schema: { methods: [{ type: 'none' }] },
    feeds_schema: {
      snapshots: {
        key: 'snapshots',
        name: 'Snapshots',
        operations: ['sync'],
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          snapshot: {
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string', const: 'device_manifest_test' },
                origin_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
    ...overrides,
  };
}

/**
 * A Chrome-extension device manifest, used below wherever a case needs a
 * concrete manifest rather than a specific product.
 *
 * This used to be `whatsapp.local`, advertised by BOTH the Mac and the
 * extension — the one connector key that lived outside the reserved `chrome.*`
 * namespace while the extension implemented it natively. That exception is
 * retired, and with it the cross-platform cases that only made sense while a
 * single key had two competing device implementations.
 */
function chromeConnectorManifest(overrides: Record<string, unknown> = {}) {
  return {
    key: CHROME_MANIFEST_KEY,
    version: '2.0.0',
    name: 'Browser Messages',
    description: 'Chrome-extension implementation',
    required_capability: CHROME_MANIFEST_CAPABILITY,
    runtime: { platforms: ['chrome-extension'] },
    auth_schema: { methods: [{ type: 'none' }] },
    feeds_schema: {
      messages: {
        key: 'messages',
        name: 'Messages',
        operations: ['sync', 'read'],
        eventKinds: {
          message: {
            attributions: [
              { role: 'authored_by', autoCreate: true, target: { entityType: 'person' } },
            ],
          },
        },
      },
    },
    ...overrides,
  };
}

async function seedAdditionalDevice(params: {
  userId: string;
  orgId: string;
  workerId: string;
  platform: 'macos' | 'chrome-extension';
}) {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, app_version, capabilities, label, organization_id
    ) VALUES (
      ${params.userId}, ${params.workerId}, ${params.platform}, '0.1.0', ${sql.json([])},
      ${params.workerId}, ${params.orgId}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return row.id;
}

async function readChromeConnectorRows(orgId: string) {
  const sql = getTestDb();
  const connections = (await sql`
    SELECT id, device_worker_id
    FROM connections
    WHERE organization_id = ${orgId}
      AND connector_key = ${CHROME_MANIFEST_KEY}
      AND deleted_at IS NULL
    ORDER BY id
  `) as unknown as Array<{ id: number; device_worker_id: string | null }>;
  const feeds = (await sql`
    SELECT f.id, f.connection_id, f.feed_key, f.status, f.next_run_at
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE c.organization_id = ${orgId}
      AND c.connector_key = ${CHROME_MANIFEST_KEY}
      AND f.deleted_at IS NULL
    ORDER BY f.id
  `) as unknown as Array<{
    id: number;
    connection_id: number;
    feed_key: string;
    status: string;
    next_run_at: Date | string | null;
  }>;
  return { connections, feeds };
}

/** Queue an approved os.shell action run against the device's auto-wired connection. */
async function seedHeadlessShellRun(orgId: string, version = HEADLESS_OS_SHELL_VERSION) {
  const sql = getTestDb();
  const [connection] = (await sql`
    SELECT id FROM connections
    WHERE organization_id = ${orgId}
      AND connector_key = 'os.shell'
      AND deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{ id: number }>;
  const [run] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key,
      connector_version, action_key, action_input, approval_status, status,
      created_at
    ) VALUES (
      ${orgId}, 'action', ${connection.id}, 'os.shell', ${version}, 'run',
      ${sql.json({ command: 'hostname' })}, 'auto', 'pending', NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(run.id);
}

async function readFeedStatus(orgId: string, key = CONNECTOR_KEY) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT f.status
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE c.organization_id = ${orgId} AND c.connector_key = ${key}
    ORDER BY f.id ASC
    LIMIT 1
  `) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? null;
}

async function readDefinition(orgId: string, key = CONNECTOR_KEY) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT key, name, version, required_capability, runtime, feeds_schema
    FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = ${key}
    LIMIT 1
  `) as unknown as Array<{
    key: string;
    name: string;
    version: string;
    required_capability: string | null;
    runtime: unknown;
    feeds_schema: unknown;
  }>;
  return rows[0] ?? null;
}

async function poll(
  workerId: string,
  connectorManifests: unknown[],
  platform = 'macos',
  capabilities: Record<string, boolean> = { screentime: true },
  options: {
    capacityAvailable?: number;
    agentKinds?: string[];
    backendCapacity?: Record<string, number>;
  } = {},
) {
  const body: Record<string, unknown> = {
    worker_id: workerId,
    platform,
    app_version: '9.9.0',
    label: 'Test Device',
    capabilities,
    connector_manifests: connectorManifests,
  };
  if (options.capacityAvailable !== undefined) {
    body.capacity_available = options.capacityAvailable;
  }
  if (options.agentKinds !== undefined) body.agent_kinds = options.agentKinds;
  if (options.backendCapacity !== undefined) body.backend_capacity = options.backendCapacity;
  return post('/api/workers/poll', {
    body,
  });
}

async function pollFleet(workerId: string) {
  return post('/api/workers/poll', {
    body: { worker_id: workerId, capabilities: {} },
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

async function pollClaimingDueFeed(
  workerId: string,
  connectorManifests: unknown[],
  options: { capacityAvailable?: number; agentKinds?: string[] } = {},
) {
  const response = await poll(workerId, connectorManifests, 'macos', { screentime: true }, options);
  expect(response.status).toBe(200);
  return response.json();
}

async function deviceIdFor(workerId: string): Promise<string> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT id FROM device_workers WHERE worker_id = ${workerId} LIMIT 1
  `) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

async function settleRunsAndFeeds(orgId: string) {
  const sql = getTestDb();
  await sql`
    UPDATE runs
    SET status = 'completed', completed_at = NOW()
    WHERE organization_id = ${orgId} AND status IN ('pending', 'claimed', 'running')
  `;
  await sql`
    UPDATE feeds SET next_run_at = '2099-01-01T00:00:00Z'
    WHERE organization_id = ${orgId} AND feed_key = 'messages'
  `;
}

async function insertPendingManifestRun(params: {
  orgId: string;
  connectionId: number;
  feedId: number;
  version: string;
}) {
  const sql = getTestDb();
  const [run] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id, connector_key,
      connector_version, approval_status, status, created_at
    ) VALUES (
      ${params.orgId}, 'sync', ${params.feedId}, ${params.connectionId},
      ${CHROME_MANIFEST_KEY}, ${params.version}, 'auto', 'pending', NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(run.id);
}

async function waitForAutowireWaiters(userId: string, connectorKey: string, count: number) {
  const sql = getTestDb();
  await vi.waitFor(
    async () => {
      const [row] = (await sql`
        SELECT count(*)::int AS count
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND classid::bigint = (hashtext('lobu:autowire')::bigint & 4294967295)
          AND objid::bigint = (hashtext(${`${userId}:${connectorKey}`})::bigint & 4294967295)
      `) as unknown as Array<{ count: number }>;
      expect(Number(row.count)).toBe(count);
    },
    { timeout: 5_000, interval: 10 }
  );
}

const OWLETTO_MANIFEST_DIRS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    mac: resolve(here, '../../../../owletto/apps/mac/Owletto/ConnectorManifests'),
    chrome: resolve(here, '../../../../owletto/apps/chrome/connector-manifests'),
  };
})();

/**
 * The owletto submodule is a private repo, so contributor sandboxes without
 * access to it cannot init it. Skip the manifest-parity tests there — but in
 * CI (which checks the submodule out) a missing dir must FAIL, not skip, or a
 * broken submodule checkout would silently drop manifest validation.
 */
function itWithOwlettoManifests(kind: keyof typeof OWLETTO_MANIFEST_DIRS) {
  if (existsSync(OWLETTO_MANIFEST_DIRS[kind])) return it;
  return process.env.CI ? it : it.skip;
}

function loadOwlettoManifests(kind: 'mac' | 'chrome'): Array<Record<string, unknown>> {
  const dir = OWLETTO_MANIFEST_DIRS[kind];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
      const manifests = Array.isArray(parsed) ? parsed : [parsed];
      return manifests.map((manifest) => {
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
          throw new Error(`invalid Owletto connector manifest in ${file}`);
        }
        return manifest as Record<string, unknown>;
      });
    });
}

function capabilitiesFor(manifests: Array<Record<string, unknown>>): Record<string, boolean> {
  return Object.fromEntries(
    manifests
      .map((manifest) => manifest.required_capability)
      .filter((cap): cap is string => typeof cap === 'string')
      .map((cap) => [cap, true]),
  );
}

describe('device connector manifests', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  it('durably suppresses an explicitly deleted auto-wired connection until reconnect', async () => {
    const { orgId, userId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();
    const client = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    const [wired] = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
        AND auth_profile_id IS NULL AND app_auth_profile_id IS NULL
        AND deleted_at IS NULL
    `) as unknown as Array<{ id: number }>;
    expect(wired?.id).toBeTruthy();

    const deleted = (await client.connections.delete(Number(wired.id))) as {
      deleted?: boolean;
    };
    expect(deleted.deleted).toBe(true);

    const [tombstone] = (await sql`
      SELECT deleted_at, config->>'__lobu_device_autowire_suppressed' AS suppressed
      FROM connections WHERE id = ${wired.id}
    `) as unknown as Array<{ deleted_at: string | null; suppressed: string | null }>;
    expect(tombstone.deleted_at).not.toBeNull();
    expect(tombstone.suppressed).toBe('true');

    await Promise.all(
      Array.from({ length: 4 }, () => reconcileDeviceCapabilities(userId)),
    );
    const liveAfterDelete = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
        AND auth_profile_id IS NULL AND app_auth_profile_id IS NULL
        AND deleted_at IS NULL
    `;
    expect(liveAfterDelete).toHaveLength(0);

    const [reconnected] = await Promise.all([
      client.connections.connect({
        connector_key: CONNECTOR_KEY,
        device_worker_id: await deviceIdFor(workerId),
      }),
      reconcileDeviceCapabilities(userId),
    ]) as [{ connection_id?: number; status?: string }, void];
    expect(reconnected.connection_id).toBeTruthy();
    expect(reconnected.status).toBe('active');

    await reconcileDeviceCapabilities(userId);
    const liveAfterReconnect = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
        AND auth_profile_id IS NULL AND app_auth_profile_id IS NULL
        AND deleted_at IS NULL
    `;
    expect(liveAfterReconnect).toHaveLength(1);
    expect(Number(liveAfterReconnect[0].id)).toBe(reconnected.connection_id);
    const healedFeeds = await sql`
      SELECT status FROM feeds
      WHERE connection_id = ${reconnected.connection_id}
        AND feed_key = 'snapshots' AND deleted_at IS NULL
    `;
    expect(healedFeeds).toEqual([{ status: 'active' }]);
  });

  it('suppresses an explicitly deleted auto-wired connection even while it is unpinned', async () => {
    const { orgId, userId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();
    const client = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    const [wired] = (await sql`
      UPDATE connections
      SET device_worker_id = NULL
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
        AND auth_profile_id IS NULL AND app_auth_profile_id IS NULL
        AND deleted_at IS NULL
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    expect(wired?.id).toBeTruthy();

    const deleted = (await client.connections.delete(Number(wired.id))) as {
      deleted?: boolean;
    };
    expect(deleted.deleted).toBe(true);
    await Promise.all(
      Array.from({ length: 4 }, () => reconcileDeviceCapabilities(userId)),
    );

    const rows = await sql`
      SELECT id, deleted_at, config->>'__lobu_device_autowire_suppressed' AS suppressed
      FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
      ORDER BY id
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].suppressed).toBe('true');
  });

  it('does not let a deleted credential-backed connection suppress auto-wire', async () => {
    const { orgId, userId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();
    const [profile] = (await sql`
      INSERT INTO auth_profiles (
        organization_id, slug, display_name, connector_key, profile_kind, created_by
      ) VALUES (
        ${orgId}, ${`profile-${generateSecureToken(4)}`}, 'Manual profile',
        ${CONNECTOR_KEY}, 'env', ${userId}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const [manual] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        auth_profile_id, created_by, visibility
      ) VALUES (
        ${orgId}, ${CONNECTOR_KEY}, ${`manual-${generateSecureToken(4)}`},
        'Manual connection', 'active', ${profile.id}, ${userId}, 'private'
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const client = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });

    const deleted = (await client.connections.delete(Number(manual.id))) as {
      deleted?: boolean;
    };
    expect(deleted.deleted).toBe(true);
    expect((await poll(workerId, [manifest()])).status).toBe(200);

    const rows = await sql`
      SELECT auth_profile_id, deleted_at
      FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.auth_profile_id === null && row.deleted_at === null)).toBe(true);
  });

  // No definition is installed until the first poll, so `is_device_connector`
  // is false at delete time and the delete leaves no marker. Once a device
  // connector IS installed, an auth-none row in the personal org is the
  // auto-wire identity by construction — `ensureDeviceConnectorWired` matches
  // and adopts exactly that shape — so there is no separate "manual" case to
  // exempt.
  it('does not let an auth-none row deleted before the connector is installed suppress auto-wire', async () => {
    const { orgId, userId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();
    const [manual] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, auth_profile_id, app_auth_profile_id, device_worker_id
      ) VALUES (
        ${orgId}, ${CONNECTOR_KEY}, ${`manual-none-${generateSecureToken(4)}`},
        'Manual auth-none connection', 'active', ${userId}, 'private', NULL, NULL, NULL
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const client = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });

    const deleted = (await client.connections.delete(Number(manual.id))) as {
      deleted?: boolean;
    };
    expect(deleted.deleted).toBe(true);
    const [manualTombstone] = (await sql`
      SELECT config->>'__lobu_device_autowire_suppressed' AS suppressed
      FROM connections WHERE id = ${manual.id}
    `) as unknown as Array<{ suppressed: string | null }>;
    expect(manualTombstone.suppressed).toBeNull();

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    const live = await sql`
      SELECT id, device_worker_id
      FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
        AND auth_profile_id IS NULL AND app_auth_profile_id IS NULL
        AND deleted_at IS NULL
    `;
    expect(live).toHaveLength(1);
    expect(live[0].device_worker_id).not.toBeNull();
  });

  it('rejects the reserved auto-wire suppression marker on public config writes', async () => {
    const { orgId, userId } = await seedDeviceOwner();
    const client = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });

    await expect(
      client.connections.connect({
        connector_key: CONNECTOR_KEY,
        config: { __lobu_device_autowire_suppressed: true },
      }),
    ).rejects.toThrow(
      'The device auto-wire suppression marker is reserved for connection deletion.',
    );
  });

  it('installs a metadata-only device connector from poll and claims its feed run without compiled_code', async () => {
    const { orgId, workerId } = await seedDeviceOwner();

    const body = await pollClaimingDueFeed(workerId, [manifest()], { capacityAvailable: 1 });

    const def = await readDefinition(orgId);
    expect(def?.key).toBe(CONNECTOR_KEY);
    expect(def?.required_capability).toBe('screentime');

    expect(body.connector_key).toBe(CONNECTOR_KEY);
    expect(body.feed_key).toBe('snapshots');
    expect(body.compiled_code).toBeUndefined();

    const sql = getTestDb();
    const versionRows = (await sql`
      SELECT compiled_code, source_path FROM connector_versions
      WHERE connector_key = ${CONNECTOR_KEY} AND version = '0.1.0'
      LIMIT 1
    `) as unknown as Array<{ compiled_code: string | null; source_path: string | null }>;
    expect(versionRows[0]?.compiled_code).toBeNull();
    expect(versionRows[0]?.source_path).toBe(`device-manifest://macos/${CONNECTOR_KEY}@0.1.0`);
  });

  it('marks only the exact authorized device artifact in the poll response', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const bridgeManifest = manifest({ runtime: { platforms: ['macos'] } });

    const body = await pollClaimingDueFeed(workerId, [bridgeManifest]);

    // The contract identity, and no routing marker: which local backend serves
    // the run is the device's own decision.
    expect(body.execution_backend).toBeUndefined();
    expect(body.connector_version).toBe('0.1.0');
    expect(body.connector_manifest_hash).toBe(
      deviceManifestHash(bridgeManifest as DeviceConnectorManifest),
    );
    expect(body.compiled_code).toBeUndefined();

    const sql = getTestDb();
    const [run] = (await sql`
      SELECT status, claimed_by FROM runs
      WHERE organization_id = ${orgId}
        AND connector_key = ${CONNECTOR_KEY}
      ORDER BY id DESC
      LIMIT 1
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(run.status).toBe('running');
    expect(run.claimed_by).toBe(workerId);

    await settleRunsAndFeeds(orgId);
    const [refs] = (await sql`
      SELECT c.id AS connection_id, f.id AS feed_id
      FROM connections c
      JOIN feeds f ON f.connection_id = c.id AND f.feed_key = 'snapshots'
      WHERE c.organization_id = ${orgId} AND c.connector_key = ${CONNECTOR_KEY}
      LIMIT 1
    `) as unknown as Array<{ connection_id: number; feed_id: number }>;
    await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'sync', ${refs.feed_id}, ${refs.connection_id}, ${CONNECTOR_KEY},
        '0.1.0', 'auto', 'pending', NOW()
      )
    `;
    await sql`
      UPDATE device_workers
      SET connector_manifests = ${sql.json({
        [CONNECTOR_KEY]: {
          manifest: bridgeManifest,
          manifest_hash: 'unauthorized-hash',
          received_at: new Date().toISOString(),
        },
      })}
      WHERE worker_id = ${workerId}
    `;
    const unauthorizedResponse = await post('/api/workers/poll', {
      body: {
        worker_id: workerId,
        platform: 'macos',
        app_version: '9.9.0',
        capabilities: { screentime: true },
      },
    });
    expect(unauthorizedResponse.status).toBe(200);
    const unauthorizedBody = (await unauthorizedResponse.json()) as {
      connector_manifest_hash?: string;
    };
    expect(unauthorizedBody.connector_manifest_hash).toBeUndefined();
  });

  it('claims a device manifest after reconciliation when auth_schema is omitted', async () => {
    const { workerId } = await seedDeviceOwner();
    const bridgeManifest = manifest({
      runtime: { platforms: ['macos'] },
      auth_schema: undefined,
    });

    const body = await pollClaimingDueFeed(workerId, [bridgeManifest]);

    expect(body.connector_manifest_hash).toBe(
      deviceManifestHash(bridgeManifest as DeviceConnectorManifest),
    );
  });

  it('keeps a persisted pre-operations bridge manifest authorized and scheduled', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();
    const currentManifest = manifest({ runtime: { platforms: ['macos'] } });
    const snapshotFeed = {
      ...(currentManifest.feeds_schema.snapshots as Record<string, unknown>),
    };
    delete snapshotFeed.operations;
    const legacyManifest = {
      ...currentManifest,
      feeds_schema: {
        snapshots: snapshotFeed,
        live_snapshots: {
          key: 'live_snapshots',
          name: 'Live snapshots',
          virtual: true,
        },
      },
    };
    const legacyHash = deviceManifestHash(legacyManifest as DeviceConnectorManifest);

    await sql`
      UPDATE device_workers
      SET capabilities = ${sql.json(['screentime'])},
          connector_manifests = ${sql.json({
            [CONNECTOR_KEY]: {
              manifest: legacyManifest,
              manifest_hash: legacyHash,
              received_at: new Date().toISOString(),
            },
          })},
          last_seen_at = NOW()
      WHERE worker_id = ${workerId}
    `;

    const pollPersistedInventory = (capacityAvailable: number) =>
      post('/api/workers/poll', {
        body: {
          worker_id: workerId,
          platform: 'macos',
          app_version: '9.9.0',
          capabilities: { screentime: true },
          capacity_available: capacityAvailable,
        },
      });

    const reconcileResponse = await pollPersistedInventory(0);
    expect(reconcileResponse.status).toBe(200);

    const definition = await readDefinition(orgId);
    expect(definition?.feeds_schema).toEqual(
      expect.objectContaining({
        snapshots: expect.objectContaining({ operations: ['sync'] }),
        live_snapshots: expect.objectContaining({ operations: ['read'] }),
      }),
    );
    const feeds = (await sql`
      SELECT f.feed_key, f.next_run_at
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE c.organization_id = ${orgId}
        AND c.connector_key = ${CONNECTOR_KEY}
        AND f.feed_key IN ('snapshots', 'live_snapshots')
      ORDER BY f.feed_key
    `) as unknown as Array<{ feed_key: string; next_run_at: Date | string | null }>;
    expect(feeds).toEqual([
      { feed_key: 'live_snapshots', next_run_at: null },
      { feed_key: 'snapshots', next_run_at: expect.anything() },
    ]);

    const claimResponse = await pollPersistedInventory(1);
    expect(claimResponse.status).toBe(200);
    const body = (await claimResponse.json()) as Record<string, unknown>;
    expect(body.connector_key).toBe(CONNECTOR_KEY);
    expect(body.feed_key).toBe('snapshots');
    expect(body.connector_manifest_hash).toBe(legacyHash);
  });

  it('reconciles a same-version compiled artifact back to manifest-only poll payload', async () => {
    const { orgId, workerId } = await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const chromeManifest = chromeConnectorManifest();
    expect(
      (
        await poll(workerId, [chromeManifest], 'chrome-extension', {
          [CHROME_MANIFEST_CAPABILITY]: true,
        })
      ).status
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    await sql`
      UPDATE connector_versions
      SET compiled_code = 'module.exports = { sync: async () => ({ items: [] }) }',
          compiled_code_hash = ${deviceManifestHash(chromeManifest as DeviceConnectorManifest)},
          compile_config_hash = ${COMPILE_CONFIG_HASH},
          source_code = 'export const stale = true',
          source_path = ${`device-manifest://chrome-extension/${CHROME_MANIFEST_KEY}@2.0.0`}
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '2.0.0'
    `;
    const rows = await readChromeConnectorRows(orgId);
    const messagesFeed = rows.feeds.find((feed) => feed.feed_key === 'messages');
    expect(messagesFeed).toBeDefined();
    const runId = await insertPendingManifestRun({
      orgId,
      connectionId: Number(rows.connections[0].id),
      feedId: Number(messagesFeed!.id),
      version: '2.0.0',
    });

    const response = await poll(workerId, [chromeManifest], 'chrome-extension', {
      [CHROME_MANIFEST_CAPABILITY]: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run_id?: number; compiled_code?: string };
    expect(body.run_id).toBe(runId);
    expect(body.compiled_code).toBeUndefined();
    const [artifact] = (await sql`
      SELECT compiled_code, compiled_code_hash, compile_config_hash, source_code, source_path
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '2.0.0'
    `) as unknown as Array<{
      compiled_code: string | null;
      compiled_code_hash: string | null;
      compile_config_hash: string | null;
      source_code: string | null;
      source_path: string | null;
    }>;
    expect(artifact).toEqual({
      compiled_code: null,
      compiled_code_hash: deviceManifestHash(chromeManifest as DeviceConnectorManifest),
      compile_config_hash: null,
      source_code: null,
      source_path: `device-manifest://chrome-extension/${CHROME_MANIFEST_KEY}@2.0.0`,
    });
  });

  it('repairs stale same-hash device-manifest provenance on the fast path', async () => {
    const { orgId, workerId } = await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const chromeManifest = chromeConnectorManifest();
    const pollOptions = { [CHROME_MANIFEST_CAPABILITY]: true };

    expect((await poll(workerId, [chromeManifest], 'chrome-extension', pollOptions)).status).toBe(
      200,
    );
    await settleRunsAndFeeds(orgId);

    await sql`
      UPDATE connector_versions
      SET source_path = ${`device-manifest://macos/${CHROME_MANIFEST_KEY}@2.0.0`}
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '2.0.0'
    `;
    const rows = await readChromeConnectorRows(orgId);
    const messagesFeed = rows.feeds.find((feed) => feed.feed_key === 'messages');
    expect(messagesFeed).toBeDefined();
    const runId = await insertPendingManifestRun({
      orgId,
      connectionId: Number(rows.connections[0].id),
      feedId: Number(messagesFeed!.id),
      version: '2.0.0',
    });

    const repairedPoll = await poll(workerId, [chromeManifest], 'chrome-extension', pollOptions);
    expect(repairedPoll.status).toBe(200);
    expect(((await repairedPoll.json()) as { run_id?: number }).run_id).toBe(runId);
    const [artifact] = (await sql`
      SELECT source_path
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '2.0.0'
    `) as unknown as Array<{ source_path: string | null }>;
    expect(artifact.source_path).toBe(
      `device-manifest://chrome-extension/${CHROME_MANIFEST_KEY}@2.0.0`,
    );
  });

  it('ships compiled code for a TypeScript connector claimed by a local-files device worker', async () => {
    const connectorKey = 'test.local_files';
    const compiledCode = 'module.exports = { sync: async () => ({ items: [] }) }';
    const { orgId, userId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Local Files Test',
      organization_id: orgId,
    });
    await sql`
      UPDATE connector_definitions
      SET required_capability = 'os.files', runtime = ${sql.json({ platforms: ['macos'] })}
      WHERE organization_id = ${orgId} AND key = ${connectorKey}
    `;
    const connection = await createTestConnection({
      organization_id: orgId,
      connector_key: connectorKey,
      created_by: userId,
    });
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key, connector_version,
        approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'sync', ${connection.id}, ${connectorKey}, '1.0.0',
        'auto', 'pending', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const response = await poll(workerId, [], 'macos', { 'os.files': true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.run_id).toBe(Number(run.id));
    expect(body.connector_key).toBe(connectorKey);
    expect(body.compiled_code).toBe(compiledCode);
  });

  it('re-syncs connector_definitions when a later poll ships a changed manifest (new action)', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    const actionsV1 = {
      alpha: { key: 'alpha', name: 'Alpha', inputSchema: { type: 'object' } },
    };
    const first = await poll(workerId, [manifest({ actions_schema: actionsV1 })]);
    expect(first.status).toBe(200);

    const readActions = async () => {
      const rows = (await sql`
        SELECT actions_schema FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
        LIMIT 1
      `) as unknown as Array<{ actions_schema: Record<string, unknown> | null }>;
      return Object.keys(rows[0]?.actions_schema ?? {}).sort();
    };
    expect(await readActions()).toEqual(['alpha']);

    // The extension updates: same key + version, actions_schema gains `beta`
    // (exactly what happened when console_capture shipped). The wired fast
    // path must not strand the org catalog on the old action set.
    const actionsV2 = {
      ...actionsV1,
      beta: { key: 'beta', name: 'Beta', inputSchema: { type: 'object' } },
    };
    const second = await poll(workerId, [manifest({ actions_schema: actionsV2 })]);
    expect(second.status).toBe(200);
    expect(await readActions()).toEqual(['alpha', 'beta']);

    // Stability: an UNCHANGED manifest must take the fast path again (the
    // definition upsert stamps updated_at, so a moving timestamp here would
    // mean every poll pays the advisory-lock slow path).
    const readUpdatedAt = async () => {
      const rows = (await sql`
        SELECT updated_at FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
        LIMIT 1
      `) as unknown as Array<{ updated_at: string }>;
      return rows[0]?.updated_at;
    };
    const afterResync = await readUpdatedAt();
    const third = await poll(workerId, [manifest({ actions_schema: actionsV2 })]);
    expect(third.status).toBe(200);
    expect(await readUpdatedAt()).toEqual(afterResync);
  });

  it('archives an unreferenced manifest definition the fleet no longer advertises', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    // Reconcile used to skip keys that vanished from the source inventory, so
    // their definitions stayed active indefinitely.
    expect((await poll(workerId, [manifest()])).status).toBe(200);
    expect(await readDefinition(orgId)).not.toBeNull();
    await sql`
      UPDATE connections SET deleted_at = NOW()
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
    `;

    expect((await poll(workerId, [])).status).toBe(200);

    const rows = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(['archived']);
    const liveConnections = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId}
        AND connector_key = ${CONNECTOR_KEY}
        AND deleted_at IS NULL
    `;
    expect(liveConnections).toHaveLength(0);

    // Idempotent: this pass runs on every poll, so a re-archive that kept
    // stamping updated_at would churn the row forever.
    const stamp = async () => {
      const r = (await sql`
        SELECT updated_at FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY} LIMIT 1
      `) as unknown as Array<{ updated_at: string }>;
      return r[0]?.updated_at;
    };
    const afterFirst = await stamp();
    expect((await poll(workerId, [])).status).toBe(200);
    expect(await stamp()).toEqual(afterFirst);

    // Advertising the key again creates one new active definition and live
    // connection while retaining the archived rows.
    expect((await poll(workerId, [manifest()])).status).toBe(200);
    const restoredDefinitions = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
      ORDER BY id
    `) as unknown as Array<{ status: string }>;
    expect(restoredDefinitions.map((r) => r.status)).toEqual(['archived', 'active']);
    const restoredConnections = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId}
        AND connector_key = ${CONNECTOR_KEY}
        AND deleted_at IS NULL
    `;
    expect(restoredConnections).toHaveLength(1);
  });

  it('leaves a second device’s connectors alone when one device drops its manifests', async () => {
    const { userId, orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    // Manifests are stored per device and read across the whole fleet, so a poll
    // from device A must not archive what device B still serves.
    const otherWorkerId = `wk-${generateSecureToken(6)}`;
    const otherKey = 'apple.test_other_device';
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${userId}, ${otherWorkerId}, 'macos', '0.1.0', ${sql.json([])}, 'Other Device', ${orgId})
    `;
    expect((await poll(otherWorkerId, [manifest({ key: otherKey })])).status).toBe(200);
    expect((await poll(workerId, [manifest()])).status).toBe(200);
    await sql`
      UPDATE connections SET deleted_at = NOW()
      WHERE organization_id = ${orgId}
        AND connector_key IN (${CONNECTOR_KEY}, ${otherKey})
    `;

    // Device A drops its manifests; device B has not polled again.
    expect((await poll(workerId, [])).status).toBe(200);

    const statusOf = async (key: string) => {
      const rows = (await sql`
        SELECT status FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${key}
      `) as unknown as Array<{ status: string }>;
      return rows.map((r) => r.status);
    };
    expect(await statusOf(CONNECTOR_KEY)).toEqual(['archived']);
    expect(await statusOf(otherKey)).toEqual(['active']);
  });

  it('keeps a definition active while the owner has a default-shaped connection', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    expect((await poll(workerId, [])).status).toBe(200);

    const definitions = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(definitions.map((r) => r.status)).toEqual(['active']);
    const liveConnections = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${orgId}
        AND connector_key = ${CONNECTOR_KEY}
        AND deleted_at IS NULL
    `;
    expect(liveConnections).toHaveLength(1);
  });

  it('does not archive a device-gated definition installed from a non-manifest source', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    await sql`
      UPDATE connector_versions
      SET source_path = 'custom/device-connector.ts'
      WHERE connector_key = ${CONNECTOR_KEY}
        AND (organization_id = ${orgId} OR organization_id IS NULL)
    `;
    await sql`
      UPDATE connections SET deleted_at = NOW()
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
    `;

    expect((await poll(workerId, [])).status).toBe(200);

    const definitions = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(definitions.map((r) => r.status)).toEqual(['active']);
  });

  it('archives an unreferenced definition left by a formerly bundled device connector', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    await sql`
      UPDATE connector_versions
      SET organization_id = NULL,
          source_path = 'browser/evaluate.ts'
      WHERE organization_id = ${orgId}
        AND connector_key = ${CONNECTOR_KEY}
    `;
    await sql`
      UPDATE connections SET deleted_at = NOW()
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
    `;

    expect((await poll(workerId, [])).status).toBe(200);

    const definitions = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(definitions.map((r) => r.status)).toEqual(['archived']);
  });

  it('drops a manifest whose key does not belong to the polling platform', async () => {
    const { orgId, workerId } = await seedDeviceOwner();

    const res = await poll(workerId, [manifest({ key: 'chrome.history' })]);
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'chrome.history')).toBeNull();
  });

  /**
   * `os.shell` is admitted for macOS, and — the part that actually bit — an
   * unrecognised key does not merely drop itself. It sets
   * `accepted = false` for the whole payload, and the caller then declines to
   * replace the device's inventory at all, so every OTHER connector on that
   * device disappears with it. That is deliberate (a malformed poll must not
   * look like removal), which is exactly why the key allowlist must not lag
   * behind the capability allowlist in @lobu/core.
   *
   * Asserted here with a synthetic manifest rather than relying on the
   * real-Owletto-manifests test above: that one only covers `os.shell` for as
   * long as owletto happens to ship `os_shell.json`.
   */
  it('admits os.shell on macOS and does not let one unknown key drop its siblings', async () => {
    const { orgId, workerId } = await seedDeviceOwner();

    // Synthetic sibling on purpose. A real key like `apple.screen_time` also
    // exists in the bundled device-connector catalog, which puts it on a
    // different reconcile path and makes the result depend on catalog state
    // rather than on the allowlist under test.
    // Distinct display name keeps this test independent of the connection-slug
    // race: two manifests sharing a name race ensureUniqueConnectionSlug under
    // Promise.allSettled (the advisory lock is keyed on (userId, connectorKey),
    // not the slug), and the loser's INSERT trips connections_org_slug_unique.
    // ensureDeviceConnectorWired now retries that collision once — covered by
    // device-reconcile-slug-race.test.ts — but the allowlist under test here
    // has nothing to do with slugs, so the names stay distinct anyway.
    const shell = manifest({
      key: 'os.shell',
      required_capability: 'os.shell',
      name: 'OS Shell Probe',
    });
    const sibling = manifest();

    const res = await poll(workerId, [shell, sibling], 'macos', {
      'os.shell': true,
      screentime: true,
    });
    expect(res.status).toBe(200);

    // The sibling survives. This is the whole regression: pre-fix, `os.shell`
    // was rejected by the key allowlist, which set accepted=false for the
    // entire payload and left apple.screen_time uninstalled alongside it.
    //
    // Deliberately NOT asserting that os.shell's own definition materializes —
    // it declares no feeds, and what reconcile does with a feedless device
    // connector is a separate question this test has no business pinning.
    expect(await readDefinition(orgId)).not.toBeNull();
  });

  it('claims an os.shell run without any advertised backend capacity', async () => {
    const { orgId, workerId } = await seedDeviceOwner('headless');
    // The daemon implements os.shell itself, so the gateway ships no code and
    // names no backend: routing is the endpoint's own decision, taken from its
    // local registry. What the gateway owes the device is the contract identity
    // it must recognise, and nothing more.
    const registered = await poll(
      workerId,
      [HEADLESS_OS_SHELL_MANIFEST],
      'headless',
      { 'os.shell': true },
      { capacityAvailable: 0 },
    );
    expect(registered.status).toBe(200);

    const sql = getTestDb();
    const [version] = (await sql`
      SELECT source_path, compiled_code FROM connector_versions
      WHERE connector_key = 'os.shell' AND version = ${HEADLESS_OS_SHELL_VERSION}
      LIMIT 1
    `) as unknown as Array<{ source_path: string | null; compiled_code: string | null }>;
    expect(version?.source_path).toBe(
      `device-manifest://headless/os.shell@${HEADLESS_OS_SHELL_VERSION}`,
    );
    expect(version?.compiled_code).toBeNull();

    const runId = await seedHeadlessShellRun(orgId);

    // A daemon whose connector compiler failed to load still implements its own
    // connectors; advertising `compiled_connector: 0` is exactly the recovery
    // case this must survive. Capacity gates code the SERVER hands over, and a
    // manifest-backed run hands over none, so it is admitted on no capacity at
    // all.
    const claimed = await poll(
      workerId,
      [HEADLESS_OS_SHELL_MANIFEST],
      'headless',
      { 'os.shell': true },
      {
        capacityAvailable: 1,
        backendCapacity: { compiled_connector: 0 },
      },
    );
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as Record<string, unknown>;
    expect(body.run_id).toBe(runId);
    expect(body.connector_key).toBe('os.shell');
    expect(body.execution_backend).toBeUndefined();
    expect(body.connector_manifest_hash).toBe(
      deviceManifestHash(HEADLESS_OS_SHELL_MANIFEST as unknown as DeviceConnectorManifest),
    );
    expect(body.compiled_code).toBeUndefined();
  });

  it('runs os.shell natively for a legacy definition installed before device manifests', async () => {
    // The shape three production organizations are actually in, and the one
    // that made deleting the gateway-compiled `os_shell.ts` risky: the pinned
    // version resolves to the SHARED artifact whose `source_path` is the
    // bundled `os_shell.ts`, so the run is not manifest-backed and the device
    // does not own it by contract.
    // With the bundled source present the gateway used to compile and ship
    // bytes. With it gone, the capability branch must let the device run its
    // own shell -- if it instead reached `resolveConnectorCode` the
    // already-claimed run would be failed with "No bundled source or stored
    // compiled code". Shell needs a real process, which no isolate has, so the
    // device is the only correct executor here regardless.
    const sql = getTestDb();
    const { userId, orgId, workerId } = await seedDeviceOwner('macos');
    await sql`
      UPDATE device_workers SET capabilities = ${sql.json(['os.shell'])}
      WHERE worker_id = ${workerId}
    `;
    const [device] = (await sql`
      SELECT id FROM device_workers WHERE worker_id = ${workerId} LIMIT 1
    `) as unknown as Array<{ id: string }>;

    // Legacy metadata-only definition: `runtime` carries no `execution` key.
    await sql`
      INSERT INTO connector_definitions (
        key, name, description, version, organization_id, status,
        required_capability, runtime, auth_schema, feeds_schema, actions_schema
      ) VALUES (
        'os.shell', 'Mac Shell', 'Legacy shell definition', '0.2.0', ${orgId}, 'active',
        'os.shell', ${sql.json({ platforms: ['macos'] })},
        ${sql.json({ methods: [{ type: 'none' }] })}, ${sql.json({})},
        ${sql.json({ run: { key: 'run', name: 'Run command', kind: 'write' } })}
      )
    `;
    // The SHARED artifact the run resolves to: bundled source path, no bytes.
    await sql`
      INSERT INTO connector_versions (connector_key, version, organization_id, source_path)
      VALUES ('os.shell', '0.2.0', NULL, 'os_shell.ts')
      ON CONFLICT DO NOTHING
    `;
    const [connection] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id
      ) VALUES (
        ${orgId}, 'os.shell', ${`legacy-shell-${generateSecureToken(4)}`},
        'Legacy shell', 'active', ${userId}, 'private', ${device.id}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key,
        connector_version, action_key, action_input, approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'action', ${connection.id}, 'os.shell', '0.2.0', 'run',
        ${sql.json({ command: 'hostname' })}, 'auto', 'pending', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = Number(run.id);

    const claimed = await poll(workerId, [], 'macos', { 'os.shell': true }, {
      capacityAvailable: 1,
    });
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as Record<string, unknown>;
    expect(body.run_id).toBe(runId);
    expect(body.connector_key).toBe('os.shell');
    // The two assertions that matter: the gateway shipped no code, and it did
    // not terminalize the run trying to find some.
    expect(body.compiled_code).toBeUndefined();
    expect(body.error).toBeUndefined();
    expect(body.skipped_run_id).toBeUndefined();

    const [stored] = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string }>;
    expect(stored.status).not.toBe('failed');
  });

  // THE consolidation regression. Two of this user's endpoints implement
  // os.shell — the Mac app and a headless daemon — and an organization elects
  // exactly ONE definition per connector key. While each endpoint authored its
  // own manifest the two hashed differently, so whichever lost the election was
  // denied claim authorization and went silently unreachable: polling, healthy,
  // capability advertised, and never handed a run. Shipping ONE contract from
  // both endpoints is what fixes it, and provenance must not re-split them —
  // the definition is registered by whichever endpoint polled first, so a claim
  // check that compared the artifact's source platform would deny the other.
  it('authorizes both endpoints of a contract shared across platforms', async () => {
    const { userId, orgId, workerId: headlessWorkerId } = await seedDeviceOwner('headless');
    const sql = getTestDb();
    const macWorkerId = `wk-${generateSecureToken(6)}`;
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${userId}, ${macWorkerId}, 'macos', '0.1.0', ${sql.json([])}, 'Test Mac', ${orgId})
    `;

    // The headless daemon registers the definition first.
    expect(
      (
        await poll(headlessWorkerId, [HEADLESS_OS_SHELL_MANIFEST], 'headless', {
          'os.shell': true,
        })
      ).status,
    ).toBe(200);
    const [version] = (await sql`
      SELECT source_path, compiled_code_hash FROM connector_versions
      WHERE connector_key = 'os.shell' AND version = ${HEADLESS_OS_SHELL_VERSION}
      LIMIT 1
    `) as unknown as Array<{ source_path: string; compiled_code_hash: string }>;
    expect(version.source_path).toBe(
      `device-manifest://headless/os.shell@${HEADLESS_OS_SHELL_VERSION}`,
    );

    // The Mac endpoint advertises the SAME contract, byte for byte, and so
    // resolves to the same hash the org already elected.
    expect(
      (
        await poll(macWorkerId, [HEADLESS_OS_SHELL_MANIFEST], 'macos', { 'os.shell': true })
      ).status,
    ).toBe(200);
    expect(version.compiled_code_hash).toBe(
      deviceManifestHash(HEADLESS_OS_SHELL_MANIFEST as unknown as DeviceConnectorManifest),
    );

    // Pin the connection to the Mac endpoint and let it claim. The definition
    // and its artifact were registered by the HEADLESS endpoint, so this is the
    // exact case that used to fail: identity is the contract hash, which both
    // endpoints advertise, not the platform that happened to register it.
    const [macDevice] = (await sql`
      SELECT id FROM device_workers WHERE worker_id = ${macWorkerId} LIMIT 1
    `) as unknown as Array<{ id: string }>;
    await sql`
      UPDATE connections SET device_worker_id = ${macDevice.id}
      WHERE organization_id = ${orgId} AND connector_key = 'os.shell'
    `;

    const runId = await seedHeadlessShellRun(orgId);
    const claimed = await poll(
      macWorkerId,
      [HEADLESS_OS_SHELL_MANIFEST],
      'macos',
      { 'os.shell': true },
      { capacityAvailable: 1 },
    );
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as Record<string, unknown>;
    expect(body.run_id).toBe(runId);
    expect(body.connector_key).toBe('os.shell');
    expect(body.compiled_code).toBeUndefined();
    expect(body.connector_manifest_hash).toBe(version.compiled_code_hash);
  });

  it('leaves an os.shell run queued for a daemon that stops advertising the contract', async () => {
    const { orgId, workerId } = await seedDeviceOwner('headless');
    const registered = await poll(
      workerId,
      [HEADLESS_OS_SHELL_MANIFEST],
      'headless',
      { 'os.shell': true },
      { capacityAvailable: 0 },
    );
    expect(registered.status).toBe(200);
    const runId = await seedHeadlessShellRun(orgId);

    // Authorization is the advertised contract, not capacity: capacity now
    // describes only code the server hands over, and this artifact carries
    // none. A daemon that no longer offers os.shell — the switch turned off,
    // an implementation withdrawn — must leave the run for a poll that does.
    const claimed = await poll(
      workerId,
      [],
      'headless',
      { 'os.shell': true },
      { capacityAvailable: 1, backendCapacity: { compiled_connector: 1 } },
    );
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as Record<string, unknown>;
    expect(body.run_id).toBeUndefined();

    const sql = getTestDb();
    const [run] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(run.status).toBe('pending');
    expect(run.claimed_by).toBeNull();
  });

  it('drops a manifest that still declares removed entityLinks rules', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const legacyManifest = manifest({
      feeds_schema: {
        snapshots: {
          key: 'snapshots',
          name: 'Snapshots',
          eventKinds: {
            snapshot: {
              entityLinks: [
                {
                  entityType: 'person',
                  identities: [{ namespace: 'email', eventPath: 'metadata.email' }],
                },
              ],
            },
          },
        },
      },
    });

    const res = await poll(workerId, [legacyManifest]);
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId)).toBeNull();

    const sql = getTestDb();
    const rows = (await sql`
      SELECT connector_manifests
      FROM device_workers
      WHERE worker_id = ${workerId}
      LIMIT 1
    `) as unknown as Array<{ connector_manifests: Record<string, unknown> }>;
    expect(rows[0]?.connector_manifests).toEqual({});
  });

  it('preserves the last valid inventory when a later manifest payload is rejected', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    expect(
      (
        await poll(
          workerId,
          [manifest()],
          'macos',
          { screentime: true },
          { capacityAvailable: 0 },
        )
      ).status,
    ).toBe(200);
    const before = (await sql`
      SELECT connector_manifests
      FROM device_workers
      WHERE worker_id = ${workerId}
    `) as unknown as Array<{ connector_manifests: unknown }>;
    const invalidManifest = manifest({
      feeds_schema: {
        snapshots: {
          eventKinds: {
            snapshot: {
              entityLinks: [],
            },
          },
        },
      },
    });

    expect(
      (
        await poll(
          workerId,
          [invalidManifest],
          'macos',
          { screentime: true },
          { capacityAvailable: 0 },
        )
      ).status,
    ).toBe(200);

    const definitions = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(definitions.map((r) => r.status)).toEqual(['active']);
    const devices = (await sql`
      SELECT connector_manifests
      FROM device_workers
      WHERE worker_id = ${workerId}
    `) as unknown as Array<{ connector_manifests: Record<string, unknown> }>;
    expect(Object.keys(devices[0]?.connector_manifests ?? {})).toEqual([CONNECTOR_KEY]);
    expect(devices[0]?.connector_manifests).toEqual(before[0]?.connector_manifests);
  });

  it('registers and reconciles a zero-capacity poll without claiming an eligible run', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();
    const manifestPayload = manifest();

    const first = await poll(
      workerId,
      [manifestPayload],
      'macos',
      { screentime: true },
      { capacityAvailable: 0, agentKinds: ['claude-code'] },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.run_id).toBeUndefined();

    const [connectionFeed] = (await sql`
      SELECT c.id AS connection_id, f.id AS feed_id
      FROM connections c
      JOIN feeds f ON f.connection_id = c.id
      WHERE c.organization_id = ${orgId}
        AND c.connector_key = ${CONNECTOR_KEY}
        AND f.feed_key = 'snapshots'
      LIMIT 1
    `) as unknown as Array<{ connection_id: number; feed_id: number }>;
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'sync', ${connectionFeed.feed_id}, ${connectionFeed.connection_id},
        ${CONNECTOR_KEY}, '0.1.0', 'auto', 'pending', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = Number(run.id);
    await sql`
      UPDATE device_workers
      SET last_seen_at = current_timestamp - INTERVAL '1 hour'
      WHERE worker_id = ${workerId}
    `;
    const beforePoll = (await sql`
      SELECT status, claimed_by, claimed_at, last_heartbeat_at
      FROM runs WHERE id = ${runId}
    `) as unknown as Array<Record<string, unknown>>;

    const second = await poll(
      workerId,
      [manifestPayload],
      'macos',
      { screentime: true },
      { capacityAvailable: 0, agentKinds: ['pi'] },
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as Record<string, unknown>).run_id).toBeUndefined();

    const [device] = (await sql`
      SELECT last_seen_at, capabilities, app_version, label, agent_kinds, connector_manifests
      FROM device_workers
      WHERE worker_id = ${workerId}
    `) as unknown as Array<{
      last_seen_at: string | Date;
      capabilities: unknown;
      app_version: string;
      label: string;
      agent_kinds: string | string[] | null;
      connector_manifests: unknown;
    }>;
    expect(new Date(String(device.last_seen_at)).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(device.capabilities).toEqual(['screentime']);
    expect(device.app_version).toBe('9.9.0');
    expect(device.label).toBe('Test Device');
    expect(parsePgTextArray(device.agent_kinds)).toEqual(['pi']);
    expect(device.connector_manifests).toEqual(
      expect.objectContaining({ [CONNECTOR_KEY]: expect.anything() }),
    );

    const [afterRun] = (await sql`
      SELECT status, claimed_by, claimed_at, last_heartbeat_at
      FROM runs WHERE id = ${runId}
    `) as unknown as Array<Record<string, unknown>>;
    expect(afterRun).toEqual(beforePoll[0]);
  });

  it('rejects invalid poll bodies before changing worker or run state', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();
    const manifestPayload = manifest();

    expect(
      (
        await poll(
          workerId,
          [manifestPayload],
          'macos',
          { screentime: true },
          { capacityAvailable: 0 },
        )
      ).status,
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    const [connectionFeed] = (await sql`
      SELECT c.id AS connection_id, f.id AS feed_id
      FROM connections c
      JOIN feeds f ON f.connection_id = c.id
      WHERE c.organization_id = ${orgId}
        AND c.connector_key = ${CONNECTOR_KEY}
        AND f.feed_key = 'snapshots'
      LIMIT 1
    `) as unknown as Array<{ connection_id: number; feed_id: number }>;
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'sync', ${connectionFeed.feed_id}, ${connectionFeed.connection_id},
        ${CONNECTOR_KEY}, '0.1.0', 'auto', 'pending', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const validBody = {
      worker_id: workerId,
      platform: 'macos',
      app_version: '9.9.0',
      label: 'Test Device',
      capabilities: { screentime: true },
      connector_manifests: [manifestPayload],
    };
    const invalidBodies: unknown[] = [-1, 1.5, 1025, '1', null, {}].map(
      (capacity_available) => ({ ...validBody, capacity_available }),
    );
    invalidBodies.push([], null);

    const [beforeDevice] = (await sql`
      SELECT app_version, capabilities, label, agent_kinds, connector_manifests,
             last_seen_at::text AS last_seen_at
      FROM device_workers
      WHERE worker_id = ${workerId}
    `) as unknown as Array<Record<string, unknown>>;
    const beforeFeeds = await sql`
      SELECT id, status, next_run_at::text AS next_run_at
      FROM feeds
      WHERE organization_id = ${orgId}
      ORDER BY id
    `;
    const [beforeRun] = (await sql`
      SELECT status, claimed_by, claimed_at, last_heartbeat_at
      FROM runs
      WHERE id = ${run.id}
    `) as unknown as Array<Record<string, unknown>>;

    for (const body of invalidBodies) {
      const response =
        body === null
          ? await post('/api/workers/poll')
          : await post('/api/workers/poll', { body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }

    const [afterDevice] = (await sql`
      SELECT app_version, capabilities, label, agent_kinds, connector_manifests,
             last_seen_at::text AS last_seen_at
      FROM device_workers
      WHERE worker_id = ${workerId}
    `) as unknown as Array<Record<string, unknown>>;
    const afterFeeds = await sql`
      SELECT id, status, next_run_at::text AS next_run_at
      FROM feeds
      WHERE organization_id = ${orgId}
      ORDER BY id
    `;
    const [afterRun] = (await sql`
      SELECT status, claimed_by, claimed_at, last_heartbeat_at
      FROM runs
      WHERE id = ${run.id}
    `) as unknown as Array<Record<string, unknown>>;

    expect(afterDevice).toEqual(beforeDevice);
    expect(afterFeeds).toEqual(beforeFeeds);
    expect(afterRun).toEqual(beforeRun);
  });

  it('keeps device inventory while permission is revoked and reuses rows when granted again', async () => {
    const { orgId, workerId } = await seedDeviceOwner('chrome-extension');
    const connectorManifest = chromeConnectorManifest();

    const first = await poll(workerId, [connectorManifest], 'chrome-extension', {
      [CHROME_MANIFEST_CAPABILITY]: true,
    });
    expect(first.status).toBe(200);
    const before = await readChromeConnectorRows(orgId);
    expect(before.feeds).toHaveLength(1);
    expect(before.feeds[0]?.status).toBe('active');

    const second = await poll(workerId, [connectorManifest], 'chrome-extension', {});
    expect(second.status).toBe(200);
    const revoked = await readChromeConnectorRows(orgId);
    expect(revoked.feeds[0]?.status).toBe('paused');
    expect(revoked.connections.map((row) => Number(row.id))).toEqual(
      before.connections.map((row) => Number(row.id))
    );
    expect(revoked.feeds.map((row) => Number(row.id))).toEqual(
      before.feeds.map((row) => Number(row.id))
    );

    const third = await poll(workerId, [connectorManifest], 'chrome-extension', {
      [CHROME_MANIFEST_CAPABILITY]: true,
    });
    expect(third.status).toBe(200);
    const restored = await readChromeConnectorRows(orgId);
    expect(restored.feeds[0]?.status).toBe('active');
    expect(restored.connections).toEqual(before.connections);
    expect(restored.feeds.map((row) => Number(row.id))).toEqual(
      before.feeds.map((row) => Number(row.id))
    );
  });

  it('keeps an online capable v1 feed active while a newer v2 manifest awaits setup', async () => {
    const { userId, orgId, workerId: v1WorkerId } =
      await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const v1Manifest = chromeConnectorManifest({
      version: '1.0.0',
      name: 'Browser Messages v1',
    });
    expect(
      (
        await poll(v1WorkerId, [v1Manifest], 'chrome-extension', {
          [CHROME_MANIFEST_CAPABILITY]: true,
        })
      ).status
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    const before = await readChromeConnectorRows(orgId);
    expect(before.feeds).toHaveLength(1);
    expect(before.feeds[0]?.status).toBe('active');
    expect((await readDefinition(orgId, CHROME_MANIFEST_KEY))?.version).toBe('1.0.0');

    const v2WorkerId = `chrome-wa-v2-setup-${generateSecureToken(4)}`;
    await seedAdditionalDevice({
      userId,
      orgId,
      workerId: v2WorkerId,
      platform: 'chrome-extension',
    });
    const v2Manifest = chromeConnectorManifest({
      version: '2.0.0',
      name: 'Browser Messages v2',
    });
    expect(
      (
        await poll(v2WorkerId, [v2Manifest], 'chrome-extension', {
          'browser.scripting': true,
        })
      ).status
    ).toBe(200);

    const awaitingSetup = await readChromeConnectorRows(orgId);
    expect(awaitingSetup.feeds[0]?.status).toBe('active');
    expect(awaitingSetup.connections[0]?.device_worker_id).toBe(
      before.connections[0]?.device_worker_id
    );
    expect((await readDefinition(orgId, CHROME_MANIFEST_KEY))?.version).toBe('1.0.0');

    await sql`
      UPDATE device_workers
      SET last_seen_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${before.connections[0]?.device_worker_id}::uuid
    `;
    expect(
      (
        await poll(v2WorkerId, [v2Manifest], 'chrome-extension', {
          'browser.scripting': true,
        })
      ).status
    ).toBe(200);
    const noRunnableVersion = await readChromeConnectorRows(orgId);
    expect(noRunnableVersion.feeds[0]?.status).toBe('paused');
    expect((await readDefinition(orgId, CHROME_MANIFEST_KEY))?.version).toBe('1.0.0');

    expect(
      (
        await poll(v2WorkerId, [v2Manifest], 'chrome-extension', {
          [CHROME_MANIFEST_CAPABILITY]: true,
        })
      ).status
    ).toBe(200);
    const upgraded = await readChromeConnectorRows(orgId);
    expect(upgraded.feeds[0]?.status).toBe('active');
    expect(upgraded.connections[0]?.device_worker_id).toBe(before.connections[0]?.device_worker_id);
    expect((await readDefinition(orgId, CHROME_MANIFEST_KEY))?.version).toBe('2.0.0');
  });

  it('uses only identical winning advertisers for multi-device pinning and unpinned claims', async () => {
    const { userId, orgId, workerId: workerA } = await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const chromeManifest = chromeConnectorManifest();

    expect(
      (await poll(workerA, [chromeManifest], 'chrome-extension', { [CHROME_MANIFEST_CAPABILITY]: true }))
        .status
    ).toBe(200);
    const [deviceA] = (await sql`
      SELECT id FROM device_workers WHERE user_id = ${userId} AND worker_id = ${workerA}
    `) as unknown as Array<{ id: string }>;

    const workerB = `chrome-wa-b-${generateSecureToken(4)}`;
    const deviceB = await seedAdditionalDevice({
      userId,
      orgId,
      workerId: workerB,
      platform: 'chrome-extension',
    });
    expect(
      (await poll(workerB, [chromeManifest], 'chrome-extension', { [CHROME_MANIFEST_CAPABILITY]: true }))
        .status
    ).toBe(200);

    const initial = await readChromeConnectorRows(orgId);
    expect(initial.connections).toHaveLength(1);
    const connectionId = Number(initial.connections[0].id);
    expect(initial.connections[0].device_worker_id).toBe(deviceA.id);

    // Any existing pin to a winning advertiser is deliberate. Reconciliation
    // must preserve it even though another identical implementation is online.
    await sql`
      UPDATE connections SET device_worker_id = ${deviceB}::uuid WHERE id = ${connectionId}
    `;
    expect(
      (await poll(workerA, [chromeManifest], 'chrome-extension', { [CHROME_MANIFEST_CAPABILITY]: true }))
        .status
    ).toBe(200);
    expect((await readChromeConnectorRows(orgId)).connections[0].device_worker_id).toBe(deviceB);

    // With several identical advertisers and no explicit pin there is no
    // principled winner, so leave the connection unpinned.
    await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${connectionId}`;
    expect(
      (await poll(workerB, [chromeManifest], 'chrome-extension', { [CHROME_MANIFEST_CAPABILITY]: true }))
        .status
    ).toBe(200);
    expect((await readChromeConnectorRows(orgId)).connections[0].device_worker_id).toBeNull();

    await sql`
      UPDATE runs
      SET status = 'completed', completed_at = NOW()
      WHERE organization_id = ${orgId} AND status IN ('pending', 'claimed', 'running')
    `;
    await sql`
      UPDATE feeds SET next_run_at = '2099-01-01T00:00:00Z'
      WHERE organization_id = ${orgId} AND feed_key = 'messages'
    `;
    const messagesFeed = initial.feeds.find((feed) => feed.feed_key === 'messages');
    expect(messagesFeed).toBeDefined();
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'sync', ${messagesFeed!.id}, ${connectionId}, ${CHROME_MANIFEST_KEY},
        '2.0.0', 'auto', 'pending', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const genericWorker = `chrome-generic-${generateSecureToken(4)}`;
    await seedAdditionalDevice({
      userId,
      orgId,
      workerId: genericWorker,
      platform: 'chrome-extension',
    });
    const genericPoll = await poll(genericWorker, [], 'chrome-extension', {
      'browser.scripting': true,
    });
    expect(genericPoll.status).toBe(200);
    expect((await genericPoll.json()).run_id).toBeUndefined();

    const advertiserPoll = await poll(workerA, [chromeManifest], 'chrome-extension', {
      [CHROME_MANIFEST_CAPABILITY]: true,
    });
    expect(advertiserPoll.status).toBe(200);
    expect((await advertiserPoll.json()).run_id).toBe(Number(run.id));
    expect((await readChromeConnectorRows(orgId)).connections[0].device_worker_id).toBeNull();
  });

  it('authorizes a retained v1 manifest only from its advertiser after v2 wins, including hashless attestation', async () => {
    const { userId, orgId, workerId: v1WorkerId } = await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const v1Manifest = chromeConnectorManifest({
      version: '1.0.0',
      name: 'Browser Messages v1',
    });
    expect(
      (await poll(v1WorkerId, [v1Manifest], 'chrome-extension', { [CHROME_MANIFEST_CAPABILITY]: true }))
        .status
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    const v2WorkerId = `chrome-wa-v2-${generateSecureToken(4)}`;
    await seedAdditionalDevice({
      userId,
      orgId,
      workerId: v2WorkerId,
      platform: 'chrome-extension',
    });
    const v2Manifest = chromeConnectorManifest({
      version: '2.0.0',
      name: 'Browser Messages v2',
    });
    expect(
      (await poll(v2WorkerId, [v2Manifest], 'chrome-extension', { [CHROME_MANIFEST_CAPABILITY]: true }))
        .status
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    const v2SecondWorkerId = `chrome-wa-v2-second-${generateSecureToken(4)}`;
    await seedAdditionalDevice({
      userId,
      orgId,
      workerId: v2SecondWorkerId,
      platform: 'chrome-extension',
    });
    expect(
      (
        await poll(v2SecondWorkerId, [v2Manifest], 'chrome-extension', {
          [CHROME_MANIFEST_CAPABILITY]: true,
        })
      ).status
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    const rows = await readChromeConnectorRows(orgId);
    const connectionId = Number(rows.connections[0].id);
    const messagesFeed = rows.feeds.find((feed) => feed.feed_key === 'messages');
    expect(messagesFeed).toBeDefined();
    await sql`
      UPDATE connections
      SET device_worker_id = NULL
      WHERE id = ${connectionId}
    `;
    await sql`
      UPDATE connector_versions
      SET compiled_code_hash = NULL
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '1.0.0'
    `;
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'sync', ${messagesFeed!.id}, ${connectionId}, ${CHROME_MANIFEST_KEY},
        '1.0.0', 'auto', 'pending', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const v2Poll = await poll(v2WorkerId, [v2Manifest], 'chrome-extension', {
      [CHROME_MANIFEST_CAPABILITY]: true,
    });
    expect(v2Poll.status).toBe(200);
    expect(((await v2Poll.json()) as { run_id?: number }).run_id).toBeUndefined();
    const [stillPending] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(stillPending).toEqual({ status: 'pending', claimed_by: null });

    const v1Poll = await poll(v1WorkerId, [v1Manifest], 'chrome-extension', {
      [CHROME_MANIFEST_CAPABILITY]: true,
    });
    expect(v1Poll.status).toBe(200);
    expect(((await v1Poll.json()) as { run_id?: number }).run_id).toBe(Number(run.id));
    const [attested] = (await sql`
      SELECT compiled_code_hash
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '1.0.0'
    `) as unknown as Array<{ compiled_code_hash: string | null }>;
    expect(attested.compiled_code_hash).toBe(deviceManifestHash(v1Manifest));
  });

  it('authorizes only the advertiser of the selected hash when versions are equal', async () => {
    const { userId, orgId, workerId: losingWorkerId } =
      await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const candidateA = chromeConnectorManifest({
      name: 'Browser Messages candidate A',
    }) as DeviceConnectorManifest;
    const candidateB = chromeConnectorManifest({
      name: 'Browser Messages candidate B',
    }) as DeviceConnectorManifest;
    const ordered = [candidateA, candidateB].sort((left, right) =>
      deviceManifestHash(left).localeCompare(deviceManifestHash(right))
    );
    const losingManifest = ordered[0]!;
    const winningManifest = ordered[1]!;

    expect(
      (
        await poll(losingWorkerId, [losingManifest], 'chrome-extension', {
          [CHROME_MANIFEST_CAPABILITY]: true,
        })
      ).status
    ).toBe(200);
    const winningWorkerId = `chrome-wa-winner-${generateSecureToken(4)}`;
    await seedAdditionalDevice({
      userId,
      orgId,
      workerId: winningWorkerId,
      platform: 'chrome-extension',
    });
    expect(
      (
        await poll(winningWorkerId, [winningManifest], 'chrome-extension', {
          [CHROME_MANIFEST_CAPABILITY]: true,
        })
      ).status
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    const rows = await readChromeConnectorRows(orgId);
    const messagesFeed = rows.feeds.find((feed) => feed.feed_key === 'messages');
    expect(messagesFeed).toBeDefined();
    await sql`
      UPDATE connections SET device_worker_id = NULL
      WHERE id = ${rows.connections[0].id}
    `;
    const runId = await insertPendingManifestRun({
      orgId,
      connectionId: Number(rows.connections[0].id),
      feedId: Number(messagesFeed!.id),
      version: '2.0.0',
    });

    const losingPoll = await poll(
      losingWorkerId,
      [losingManifest],
      'chrome-extension',
      { [CHROME_MANIFEST_CAPABILITY]: true }
    );
    expect(losingPoll.status).toBe(200);
    expect(((await losingPoll.json()) as { run_id?: number }).run_id).toBeUndefined();
    const [pending] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(pending).toEqual({ status: 'pending', claimed_by: null });

    const winningPoll = await poll(
      winningWorkerId,
      [winningManifest],
      'chrome-extension',
      { [CHROME_MANIFEST_CAPABILITY]: true }
    );
    expect(winningPoll.status).toBe(200);
    expect(((await winningPoll.json()) as { run_id?: number }).run_id).toBe(runId);
    const [artifact] = (await sql`
      SELECT compiled_code_hash
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '2.0.0'
    `) as unknown as Array<{ compiled_code_hash: string | null }>;
    expect(artifact.compiled_code_hash).toBe(deviceManifestHash(winningManifest));
  });

  it('recomputes the manifest winner after waiting for the connector advisory lock', async () => {
    const { userId, orgId, workerId: v1WorkerId } =
      await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const v1Manifest = chromeConnectorManifest({
      version: '1.0.0',
      name: 'Browser Messages v1',
    });
    const v2Manifest = chromeConnectorManifest({
      version: '2.0.0',
      name: 'Browser Messages v2',
    });
    const v2WorkerId = `chrome-wa-v2-${generateSecureToken(4)}`;
    const v2DeviceId = await seedAdditionalDevice({
      userId,
      orgId,
      workerId: v2WorkerId,
      platform: 'chrome-extension',
    });

    let v1PollPromise: Promise<Awaited<ReturnType<typeof poll>>> | undefined;
    let v2PollPromise: Promise<Awaited<ReturnType<typeof poll>>> | undefined;
    await sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtext('lobu:autowire'), hashtext(${`${userId}:${CHROME_MANIFEST_KEY}`})
        )
      `;
      v1PollPromise = poll(v1WorkerId, [v1Manifest], 'chrome-extension', {
        [CHROME_MANIFEST_CAPABILITY]: true,
      });
      v1PollPromise.catch(() => undefined);
      await waitForAutowireWaiters(userId, CHROME_MANIFEST_KEY, 1);
      v2PollPromise = poll(v2WorkerId, [v2Manifest], 'chrome-extension', {
        [CHROME_MANIFEST_CAPABILITY]: true,
      });
      v2PollPromise.catch(() => undefined);
      await waitForAutowireWaiters(userId, CHROME_MANIFEST_KEY, 2);
    });

    const [v1Response, v2Response] = await Promise.all([v1PollPromise!, v2PollPromise!]);
    expect(v1Response.status).toBe(200);
    expect(v2Response.status).toBe(200);
    expect(((await v1Response.json()) as { run_id?: number }).run_id).toBeUndefined();

    const definition = await readDefinition(orgId, CHROME_MANIFEST_KEY);
    expect(definition?.version).toBe('2.0.0');
    expect(definition?.name).toBe('Browser Messages v2');
    const rows = await readChromeConnectorRows(orgId);
    expect(rows.connections).toHaveLength(1);
    expect(rows.connections[0].device_worker_id).toBe(v2DeviceId);
    const [artifact] = (await sql`
      SELECT compiled_code_hash
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = ${CHROME_MANIFEST_KEY}
        AND version = '2.0.0'
    `) as unknown as Array<{ compiled_code_hash: string | null }>;
    expect(artifact.compiled_code_hash).toBe(
      deviceManifestHash(v2Manifest as DeviceConnectorManifest)
    );
  });

  it('fails claim authorization closed when under-lock reconciliation fails', async () => {
    const { orgId, workerId } = await seedDeviceOwner('chrome-extension');
    const sql = getTestDb();
    const chromeManifest = chromeConnectorManifest();
    expect(
      (
        await poll(workerId, [chromeManifest], 'chrome-extension', {
          [CHROME_MANIFEST_CAPABILITY]: true,
        })
      ).status
    ).toBe(200);
    await settleRunsAndFeeds(orgId);

    const rows = await readChromeConnectorRows(orgId);
    const messagesFeed = rows.feeds.find((feed) => feed.feed_key === 'messages');
    expect(messagesFeed).toBeDefined();
    const runId = await insertPendingManifestRun({
      orgId,
      connectionId: Number(rows.connections[0].id),
      feedId: Number(messagesFeed!.id),
      version: '2.0.0',
    });
    await sql`
      UPDATE connector_definitions SET name = 'stale metadata'
      WHERE organization_id = ${orgId} AND key = ${CHROME_MANIFEST_KEY} AND status = 'active'
    `;

    const triggerSuffix = generateSecureToken(6).replace(/[^a-zA-Z0-9]/g, '');
    const triggerFunction = `test_fail_manifest_reconcile_${triggerSuffix}`;
    const triggerName = `${triggerFunction}_trigger`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION ${triggerFunction}()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key = '${CHROME_MANIFEST_KEY}' THEN
          RAISE EXCEPTION 'forced manifest reconciliation failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await sql.unsafe(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON connector_definitions
      FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()
    `);
    try {
      const response = await poll(workerId, [chromeManifest], 'chrome-extension', {
        [CHROME_MANIFEST_CAPABILITY]: true,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { run_id?: number; skipped_run_id?: number };
      expect(body.run_id).toBeUndefined();
      expect(body.skipped_run_id).toBeUndefined();
      const [run] = (await sql`
        SELECT status, claimed_by FROM runs WHERE id = ${runId}
      `) as unknown as Array<{ status: string; claimed_by: string | null }>;
      expect(run).toEqual({ status: 'pending', claimed_by: null });
    } finally {
      await sql.unsafe(
        `DROP TRIGGER IF EXISTS ${triggerName} ON connector_definitions`
      );
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
    }
  });

  it('installs declared event-kind attributions from a manifest feeds_schema', async () => {
    const { orgId, workerId } = await seedDeviceOwner('chrome-extension');
    const manifest = chromeConnectorManifest();

    const res = await poll(workerId, [manifest], 'chrome-extension', {
      [CHROME_MANIFEST_CAPABILITY]: true,
    });
    expect(res.status).toBe(200);

    const definitionRow = await readDefinition(orgId, CHROME_MANIFEST_KEY);
    const feedsSchema = definitionRow?.feeds_schema as
      | {
          messages?: {
            eventKinds?: {
              message?: { entityLinks?: unknown; attributions?: unknown };
            };
          };
        }
      | undefined;
    const messageKind = feedsSchema?.messages?.eventKinds?.message;
    expect(messageKind?.entityLinks).toBeUndefined();
    expect(messageKind?.attributions).toEqual([
      expect.objectContaining({
        role: 'authored_by',
        autoCreate: true,
        target: expect.objectContaining({ entityType: 'person' }),
      }),
    ]);
  });

  it('refuses a macos manifest for a key outside the Mac allowlist', async () => {
    const { orgId, workerId } = await seedDeviceOwner('macos');
    // `local_directory` is an allowed macOS capability, so the capability check
    // admits this manifest and the KEY allowlist is the only thing that can
    // reject it. Without that, a retired key could still install itself.
    const manifest = {
      key: 'whatsapp.local',
      version: '1.0.0',
      name: 'Retired native WhatsApp',
      description: 'A key the Mac app no longer implements',
      required_capability: 'local_directory',
      runtime: { platforms: ['macos'] },
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: {
        messages: { key: 'messages', name: 'Messages', operations: ['sync'] },
      },
    };

    const res = await poll(workerId, [manifest], 'macos', { local_directory: true });
    expect(res.status).toBe(200);
    expect(await readDefinition(orgId, 'whatsapp.local')).toBeNull();
  });

  itWithOwlettoManifests('mac')('accepts the actual Owletto Mac manifests and installs their connector definitions', async () => {
    const { orgId, workerId } = await seedDeviceOwner('macos');
    const manifests = loadOwlettoManifests('mac');

    const res = await poll(workerId, manifests, 'macos', capabilitiesFor(manifests));
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'apple.screen_time')).not.toBeNull();
    expect(await readDefinition(orgId, 'apple.computer_use')).not.toBeNull();
    expect(await readDefinition(orgId, 'local.directory')).not.toBeNull();
    expect(await readDefinition(orgId, 'os.shell')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.history')).toBeNull();

    expect(await readDefinition(orgId, CHROME_MANIFEST_KEY)).toBeNull();
  });

  itWithOwlettoManifests('chrome')('accepts the actual Owletto Chrome manifests and installs their connector definitions', async () => {
    const { orgId, workerId } = await seedDeviceOwner('chrome-extension');
    const manifests = loadOwlettoManifests('chrome');

    const res = await poll(
      workerId,
      manifests,
      'chrome-extension',
      capabilitiesFor(manifests),
    );
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'chrome')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.history')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.bookmarks')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.downloads')).not.toBeNull();
    expect(await readDefinition(orgId, 'apple.screen_time')).toBeNull();

    // The extension ships manifests only for the connectors it implements
    // itself, all of which live in the reserved namespace. Anything the
    // extension merely drives the page for is an ordinary connector that ships
    // its own code, so it has no manifest here.
    for (const manifest of manifests) {
      expect(isChromeNamespaceConnectorKey(String(manifest.key))).toBe(true);
    }
  });
});
