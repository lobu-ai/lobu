/**
 * A team org reaches a device by PINNING a connection to it, and that pin is
 * the consent claim scope follows (`resolveDeviceClaimableOrgs`). Definition
 * reconciliation did not follow it: it targets the owner's personal org only,
 * so a pinned org stayed on whatever `connector_definitions` row it was created
 * with while the fleet moved on. Readiness compares the org's selected artifact
 * against the exact version/hash the device advertises, so the drift made the
 * pin permanently unrunnable and no self-service path repaired it.
 *
 * These cases pin the repair AND its bounds: it must never invent a connector
 * in an org that does not already pin one, never reach an org the owner has
 * left, never resurrect a deleted connection's definition, and never replace an
 * artifact the org installed with its own code.
 */
import type { DeviceConnectorManifest } from '@lobu/connector-sdk/device-manifest';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { deviceManifestHash } from '../../worker-api/device-manifests';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';

const CONNECTOR_KEY = 'chrome.pinned_org_refresh';
const CAPABILITY = 'browser.history';
const ADVERTISED_VERSION = '0.4.0';
const STALE_VERSION = '0.2.0';
const STALE_ARTIFACT_HASH = 'stale-manifest-hash';

function manifest(version = ADVERTISED_VERSION): DeviceConnectorManifest {
  return {
    key: CONNECTOR_KEY,
    version,
    name: 'Pinned Org Refresh',
    description: 'Chrome-extension manifest used to prove pinned-org refresh.',
    required_capability: CAPABILITY,
    runtime: { platforms: ['chrome-extension'] },
    auth_schema: { methods: [{ type: 'none' }] },
    feeds_schema: {
      messages: {
        key: 'messages',
        name: 'Messages',
        operations: ['sync'],
        eventKinds: { message: {} },
      },
    },
  };
}

async function seedUserWithPersonalOrg() {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const personalOrgId = `org-personal-${generateSecureToken(4)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Pinned Org Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${personalOrgId}, 'Personal', ${personalOrgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${personalOrgId}, ${userId}, 'owner', NOW())
  `;
  return { userId, personalOrgId };
}

async function seedTeamOrg(userId: string, { asMember = true } = {}) {
  const sql = getTestDb();
  const teamOrgId = `org-team-${generateSecureToken(4)}`;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (${teamOrgId}, 'Team', ${teamOrgId}, 'private', ${sql.json({})}, NOW())
  `;
  if (asMember) {
    await sql`
      INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
      VALUES (${`mem_${generateSecureToken(4)}`}, ${teamOrgId}, ${userId}, 'admin', NOW())
    `;
  }
  return teamOrgId;
}

/** A device advertising the manifest, exactly as a poll would have stored it. */
async function seedAdvertisingDevice(userId: string, personalOrgId: string) {
  const sql = getTestDb();
  const advertised = manifest();
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, app_version, capabilities, label,
      organization_id, connector_manifests, last_seen_at
    ) VALUES (
      ${userId}, ${`wk-${generateSecureToken(6)}`}, 'chrome-extension', '0.8.1',
      ${sql.json([CAPABILITY])}, 'Test Extension', ${personalOrgId},
      ${sql.json({
        [CONNECTOR_KEY]: {
          manifest: advertised,
          manifest_hash: deviceManifestHash(advertised),
          received_at: new Date().toISOString(),
        },
      })},
      NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { deviceId: row.id, manifestHash: deviceManifestHash(advertised) };
}

/**
 * A team-org connector frozen at an old version, plus the pin that consents to
 * it. `artifact` is what the org's selected `connector_versions` row carries:
 * 'manifest' is the shape device reconciliation installs, 'code' is an org's
 * own `install_connector` bytes under the same key.
 */
async function seedStaleTeamConnector(
  teamOrgId: string,
  deviceId: string | null,
  {
    deleted = false,
    artifact = 'manifest',
  }: { deleted?: boolean; artifact?: 'manifest' | 'code' } = {},
) {
  const sql = getTestDb();
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, description, version, auth_schema, feeds_schema,
      status, required_capability, created_at, updated_at
    ) VALUES (
      ${teamOrgId}, ${CONNECTOR_KEY}, 'Pinned Org Refresh', 'stale', ${STALE_VERSION},
      ${sql.json({ methods: [{ type: 'none' }] })}, ${sql.json({})},
      'active', ${CAPABILITY}, NOW(), NOW()
    )
  `;
  await sql`
    INSERT INTO connector_versions (
      connector_key, version, organization_id, compiled_code, compiled_code_hash,
      compile_config_hash, source_code, source_path
    ) VALUES (
      ${CONNECTOR_KEY}, ${STALE_VERSION}, ${teamOrgId},
      ${artifact === 'code' ? 'export default {};' : null}, ${STALE_ARTIFACT_HASH},
      NULL, ${artifact === 'code' ? 'export default {};' : null},
      ${
        artifact === 'code'
          ? 'org-install'
          : `device-manifest://chrome-extension/${CONNECTOR_KEY}@${STALE_VERSION}`
      }
    )
  `;
  await sql`
    INSERT INTO connections (
      organization_id, connector_key, display_name, status, config,
      device_worker_id, slug, created_at, updated_at, deleted_at
    ) VALUES (
      ${teamOrgId}, ${CONNECTOR_KEY}, 'Team pin', 'active', ${sql.json({})},
      ${deviceId === null ? null : sql`${deviceId}::uuid`},
      ${`pin-${generateSecureToken(4)}`}, NOW(), NOW(),
      ${deleted ? sql`NOW()` : null}
    )
  `;
}

async function readDefinition(orgId: string) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT cd.version,
           (
             SELECT cv.compiled_code_hash
             FROM connector_versions cv
             WHERE cv.organization_id = ${orgId}
               AND cv.connector_key = ${CONNECTOR_KEY}
               AND cv.version = cd.version
             LIMIT 1
           ) AS artifact_hash
    FROM connector_definitions cd
    WHERE cd.organization_id = ${orgId}
      AND cd.key = ${CONNECTOR_KEY}
      AND cd.status = 'active'
    LIMIT 1
  `) as unknown as Array<{ version: string; artifact_hash: string | null }>;
  return rows[0] ?? null;
}

describe('pinned-org device connector definition refresh', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('brings a pinned team org up to the version the device advertises', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedStaleTeamConnector(teamOrgId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);

    await reconcileDeviceCapabilities(userId, deviceId);

    const refreshed = await readDefinition(teamOrgId);
    expect(refreshed?.version).toBe(ADVERTISED_VERSION);
    // Readiness compares this exact slot against the device's claim.
    expect(refreshed?.artifact_hash).toBe(manifestHash);
  });

  it('leaves a team org that pins no device untouched', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    // Definition + connection exist, but the connection pins no device, so the
    // org never consented to this fleet.
    await seedStaleTeamConnector(teamOrgId, null);

    await reconcileDeviceCapabilities(userId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);
  });

  it('never invents a connector in an org that has no connection for it', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);

    await reconcileDeviceCapabilities(userId, deviceId);

    expect(await readDefinition(teamOrgId)).toBeNull();
  });

  it('does not reach an org the owner is no longer a member of', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const teamOrgId = await seedTeamOrg(userId, { asMember: false });
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedStaleTeamConnector(teamOrgId, deviceId);

    await reconcileDeviceCapabilities(userId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);
  });

  it("never replaces an artifact the org installed with its own code", async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    // A device manifest is not always in a reserved namespace — `os.shell`,
    // `apple.*` and `local.directory` are keys an org may also install with its
    // own bytes. A device-manifest write replaces the whole artifact family, so
    // the repair has to leave those alone.
    await seedStaleTeamConnector(teamOrgId, deviceId, { artifact: 'code' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const untouched = await readDefinition(teamOrgId);
    expect(untouched?.version).toBe(STALE_VERSION);
    expect(untouched?.artifact_hash).toBe(STALE_ARTIFACT_HASH);
  });

  it('does not refresh on the strength of a deleted connection', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedStaleTeamConnector(teamOrgId, deviceId, { deleted: true });

    await reconcileDeviceCapabilities(userId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);
  });
});
