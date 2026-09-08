/**
 * Reconciliation preserves device placement through upgrades, permission loss,
 * and offline intervals. Availability never authorizes another device to take
 * over an existing pin. Integration tests against real Postgres.
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

const CONNECTOR = 'test.pin_preservation';
const CAPABILITY = 'test_pin_preservation';

/** Bundled connectors come from the on-disk catalog (empty in tests), so the
 * connector must arrive as a device manifest to reach the wire pass at all. */
const MANIFEST = {
  key: CONNECTOR,
  version: '1.0.0',
  name: 'Test Pin Preservation',
  required_capability: CAPABILITY,
  runtime: { platforms: ['macos'] },
  feeds_schema: {},
};

async function seedDefinition(orgId: string) {
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, required_capability,
      runtime, feeds_schema, auth_schema, actions_schema, options_schema
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'Test Pin Preservation', '1.0.0', 'active', ${CAPABILITY},
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

async function seedWorker(userId: string, orgId: string, fresh: boolean): Promise<string> {
  const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
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
      ${orgId}, ${CONNECTOR}, ${slug}, 'Test Pin Preservation', 'active',
      NULL, ${userId}, 'private', ${device}::uuid
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function seedAuthProfile(orgId: string, userId: string): Promise<number> {
  const [row] = (await sql`
    INSERT INTO auth_profiles (
      organization_id, slug, display_name, connector_key, profile_kind, created_by
    ) VALUES (
      ${orgId}, ${`prof-${Math.random().toString(36).slice(2, 8)}`}, 'Test Profile',
      ${CONNECTOR}, 'env', ${userId}
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

/** Live connections carrying the device-connector identity: auto-wire's own
 * INSERT writes NULL to BOTH profile columns, so this is exactly the set the
 * wire pass owns — and exactly what a credential-backed row must stay out of. */
async function autoWiredConnections(
  orgId: string
): Promise<Array<{ id: number; device_worker_id: string | null }>> {
  const rows = (await sql`
    SELECT id, device_worker_id
    FROM connections
    WHERE organization_id = ${orgId}
      AND connector_key = ${CONNECTOR}
      AND auth_profile_id IS NULL
      AND app_auth_profile_id IS NULL
      AND deleted_at IS NULL
    ORDER BY id ASC
  `) as unknown as Array<{ id: number; device_worker_id: string | null }>;
  return rows.map((r) => ({ id: Number(r.id), device_worker_id: r.device_worker_id }));
}

/** Only the SLOW path re-runs `upsertConnectorDefinitionRecords`, and that
 * upsert always stamps `updated_at = NOW()`. So a definition whose stamp did not
 * move is proof the fast path was taken — the one externally visible difference
 * between the two branches. */
async function definitionUpdatedAt(orgId: string): Promise<string> {
  const [row] = (await sql`
    SELECT updated_at FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = ${CONNECTOR} AND status = 'active'
  `) as unknown as Array<{ updated_at: string | Date }>;
  return new Date(row.updated_at).toISOString();
}

/**
 * Block until `reconcileDeviceCapabilities` has parked on the per-(user,
 * connector) autowire advisory lock. Two-int advisory locks surface in
 * `pg_locks` as classid=key1, objid=key2, objsubid=2; `hashtext` is int4 so the
 * keys are compared in their unsigned form. Throwing on timeout is deliberate —
 * a test that silently proceeds without the interleave would prove nothing.
 */
async function waitForAutowireLockWaiter(lockKey: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = (await sql`
      SELECT count(*)::int AS waiting
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND objsubid = 2
        AND classid::text::bigint = (hashtext('lobu:autowire')::bigint & 4294967295)
        AND objid::text::bigint = (hashtext(${lockKey})::bigint & 4294967295)
    `) as unknown as Array<{ waiting: number }>;
    if (Number(row.waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`reconcile never blocked on the autowire advisory lock for ${lockKey}`);
}

describe('device pin preservation', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const org = await createTestOrganization();
    orgId = org.id;
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

  it('preserves every offline pin while another device is available', async () => {
    const staleA = await seedWorker(userId, orgId, false);
    const staleB = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);

    const current = await seedConn(orgId, userId, freshDevice);
    const retiredA = await seedConn(orgId, userId, staleA);
    const retiredB = await seedConn(orgId, userId, staleB);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(current)).toBe(freshDevice);
    expect(await pinOf(retiredA)).toBe(staleA);
    expect(await pinOf(retiredB)).toBe(staleB);
  });

  it('leaves every pin alone when several devices are fresh', async () => {
    // Neither device may take over the other connection.
    const deviceA = await seedWorker(userId, orgId, true);
    const deviceB = await seedWorker(userId, orgId, true);
    const connA = await seedConn(orgId, userId, deviceA);
    const connB = await seedConn(orgId, userId, deviceB);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(connA)).toBe(deviceA);
    expect(await pinOf(connB)).toBe(deviceB);
  });

  it.each(['0.9.0', '1.0.0'])('preserves both pins with different manifests (other version %s)', async (otherVersion) => {
    const olderDevice = await seedWorker(userId, orgId, true);
    const newerDevice = await seedWorker(userId, orgId, true);
    const olderManifest = { ...MANIFEST, version: otherVersion, description: 'Other device build' };
    const newerManifest = { ...MANIFEST, version: '1.0.0' };
    await sql`
      UPDATE device_workers
      SET connector_manifests = ${sql.json({
        [CONNECTOR]: {
          manifest: olderManifest,
          manifest_hash: deviceManifestHash(olderManifest as DeviceConnectorManifest),
          received_at: new Date(Date.now() - 60_000).toISOString(),
        },
      })}
      WHERE id = ${olderDevice}::uuid
    `;
    await sql`
      UPDATE device_workers
      SET connector_manifests = ${sql.json({
        [CONNECTOR]: {
          manifest: newerManifest,
          manifest_hash: deviceManifestHash(newerManifest as DeviceConnectorManifest),
          received_at: new Date().toISOString(),
        },
      })}
      WHERE id = ${newerDevice}::uuid
    `;

    const olderConn = await seedConn(orgId, userId, olderDevice);
    const newerConn = await seedConn(orgId, userId, newerDevice);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(newerConn)).toBe(newerDevice);
    expect(await pinOf(olderConn)).toBe(olderDevice);
  });

  it('preserves placement when a live device loses its capability', async () => {
    const serving = await seedWorker(userId, orgId, true);
    const lapsed = await seedWorker(userId, orgId, true);
    await sql`
      UPDATE device_workers SET capabilities = ${sql.json([])} WHERE id = ${lapsed}::uuid
    `;
    const servingConn = await seedConn(orgId, userId, serving);
    const lapsedConn = await seedConn(orgId, userId, lapsed);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(servingConn)).toBe(serving);
    expect(await pinOf(lapsedConn)).toBe(lapsed);
  });

  it('preserves placement when another replica observes capability loss during reconciliation', async () => {
    const serving = await seedWorker(userId, orgId, true);
    const lapsing = await seedWorker(userId, orgId, true);
    const servingConn = await seedConn(orgId, userId, serving);
    const lapsingConn = await seedConn(orgId, userId, lapsing);

    // Hold the autowire lock after the fleet read, then revoke the capability
    // before reconciliation can commit. Neither snapshot may change placement.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${CONNECTOR}`}))`;
      await held;
    });

    const reconciling = reconcileDeviceCapabilities(userId);
    await waitForAutowireLockWaiter(`${userId}:${CONNECTOR}`);

    await sql`
      UPDATE device_workers SET capabilities = ${sql.json([])} WHERE id = ${lapsing}::uuid
    `;
    release();
    await Promise.all([reconciling, holder]);

    expect(await pinOf(servingConn)).toBe(serving);
    expect(await pinOf(lapsingConn)).toBe(lapsing);
  });

  it('pauses only auth-free feeds when the fleet stops serving the capability', async () => {
    // When no fresh device advertises the capability, the connector routes to
    // `pauseStaleDeviceFeeds` instead of the wire pass. That statement carries
    // the same credential filter: an auth- or app-auth-backed connection is
    // user-created, so pausing its feeds would break a connection auto-wire
    // never made.
    // A FRESH device is needed for the manifest to load at all (byKey is built
    // from fresh workers), but it must NOT advertise the capability — that is
    // what routes the connector to the pause path instead of the wire pass.
    const dead = await seedWorker(userId, orgId, false);
    const freshNoCap = await seedWorker(userId, orgId, true);
    await sql`
      UPDATE device_workers SET capabilities = ${sql.json([])} WHERE id = ${freshNoCap}::uuid
    `;

    const profileId = await seedAuthProfile(orgId, userId);

    const autoWired = await seedConn(orgId, userId, dead);
    const authBacked = await seedConn(orgId, userId, null);
    const appAuthBacked = await seedConn(orgId, userId, null);
    await sql`UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${authBacked}`;
    await sql`UPDATE connections SET app_auth_profile_id = ${profileId} WHERE id = ${appAuthBacked}`;

    const feedOf = async (connId: number) => {
      const [row] = (await sql`
        INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status)
        VALUES (${orgId}, ${connId}, 'items', 'Items', 'active')
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      return Number(row.id);
    };
    const autoFeed = await feedOf(autoWired);
    const authFeed = await feedOf(authBacked);
    const appAuthFeed = await feedOf(appAuthBacked);

    // No FRESH device serves the capability, so the pause path runs.
    await reconcileDeviceCapabilities(userId);

    const statusOf = async (id: number) => {
      const [row] = (await sql`
        SELECT status FROM feeds WHERE id = ${id}
      `) as unknown as Array<{ status: string }>;
      return row.status;
    };
    expect(await statusOf(autoFeed)).toBe('paused');
    expect(await statusOf(authFeed)).toBe('active');
    expect(await statusOf(appAuthFeed)).toBe('active');
  });

  it('never touches an auth-backed connection, even on a dead device', async () => {
    // Auto-wire owns auth-FREE rows only — every other query in the wire pass
    // filters `auth_profile_id IS NULL`. An auth-backed connection is
    // user-created; unpinning it would hand it to any capable device while the
    // poll withholds credentials from unpinned connections, breaking a
    // connection this pass never created.
    const dead = await seedWorker(userId, orgId, false);
    const fresh = await seedWorker(userId, orgId, true);
    const authBacked = await seedConn(orgId, userId, dead);
    const profileId = await seedAuthProfile(orgId, userId);
    await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${authBacked}
    `;
    // Same protection for an APP-auth-backed row: auto-wire's own INSERT writes
    // NULL to both profile columns, so either one being set means the row is
    // credential-backed and user-created.
    const dead2 = await seedWorker(userId, orgId, false);
    const appAuthBacked = await seedConn(orgId, userId, null);
    await sql`
      UPDATE connections SET app_auth_profile_id = ${profileId}, device_worker_id = ${dead2}::uuid
      WHERE id = ${appAuthBacked}
    `;
    const autoWired = await seedConn(orgId, userId, fresh);

    await reconcileDeviceCapabilities(userId);

    // Stale pins, but not ours to clear.
    expect(await pinOf(authBacked)).toBe(dead);
    expect(await pinOf(appAuthBacked)).toBe(dead2);
    expect(await pinOf(autoWired)).toBe(fresh);
  });

  it('fast path refuses to adopt an app-auth-backed connection', async () => {
    // The FAST path, not the slow one. Every case above runs against the
    // hand-seeded definition, which does not match the manifest source
    // (`definitionMatchesSource` is false), so they all fall through to the slow
    // path and never exercise the fast path's own credential filter.
    const fresh = await seedWorker(userId, orgId, true);
    const dead = await seedWorker(userId, orgId, false);

    // Arm the fast path by letting reconciliation write the definition itself:
    // its upsert stores exactly the metadata `definitionMatchesSource` compares
    // against. Deriving the match from production rather than transcribing it
    // into a fixture is what stops this test decaying into a no-op if the
    // manifest→metadata mapping ever changes.
    await reconcileDeviceCapabilities(userId);
    const [wired] = await autoWiredConnections(orgId);
    expect(wired).toBeDefined();

    // Turn that row into the connection under test: credential-backed, and
    // pinned to a device that has since dropped out. It is now the ONLY
    // connection, so the fast path's `LIMIT 1` has a single candidate — the
    // outcome is decided by the credential filter, not by scan order.
    const profileId = await seedAuthProfile(orgId, userId);
    const appAuthBacked = wired.id;
    await sql`
      UPDATE connections
      SET app_auth_profile_id = ${profileId}, device_worker_id = ${dead}::uuid
      WHERE id = ${appAuthBacked}
    `;
    // Read the stamp back rather than comparing against the literal: whether the
    // column is tz-aware decides how it round-trips, and a comparison that never
    // matches would pass this test for free.
    await sql`
      UPDATE connector_definitions SET updated_at = '2000-01-01T00:00:00Z'
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR} AND status = 'active'
    `;
    const stamp = await definitionUpdatedAt(orgId);

    await reconcileDeviceCapabilities(userId);

    // The fast path found no connection it owns, so the wire pass fell through
    // to the slow path — which re-upserts the definition (moving the stamp) and
    // creates its OWN credential-free connection. Adopting the app-auth row
    // instead would have fast-pathed out: stamp frozen, no connection made.
    expect(await definitionUpdatedAt(orgId)).not.toBe(stamp);
    const autoWired = await autoWiredConnections(orgId);
    expect(autoWired).toHaveLength(1);
    expect(autoWired[0].id).not.toBe(appAuthBacked);
    expect(autoWired[0].device_worker_id).toBe(fresh);
    // ...and never re-pinned the credential-backed row it does not own.
    expect(await pinOf(appAuthBacked)).toBe(dead);
  });

  it('keeps a pin whose device comes back during reconciliation', async () => {
    const fresh = await seedWorker(userId, orgId, true);
    const revived = await seedWorker(userId, orgId, false);
    // Exercise the sibling row as well as the first connection selected.
    const currentConn = await seedConn(orgId, userId, fresh);
    const revivedConn = await seedConn(orgId, userId, revived);

    const lockKey = `${userId}:${CONNECTOR}`;
    let running!: Promise<void>;
    await sql.begin(async (tx) => {
      // Hold the wire pass's own lock, from a connection it does not own.
      await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${lockKey}))`;
      // Reads the fleet — `revived` is stale here — then parks on the lock.
      running = reconcileDeviceCapabilities(userId);
      await waitForAutowireLockWaiter(lockKey);
      // The device comes back while the pass is parked, exactly the window the
      // reconciliation must preserve.
      await sql`UPDATE device_workers SET last_seen_at = now() WHERE id = ${revived}::uuid`;
    });
    await running;

    expect(await pinOf(currentConn)).toBe(fresh);
    expect(await pinOf(revivedConn)).toBe(revived);
  });
});
