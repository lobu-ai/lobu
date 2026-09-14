/**
 * Auto-wire installs a device connector into its owner's PERSONAL org, and a
 * device-manifest write replaces the whole artifact family rather than merging
 * into it (`replaceVersionArtifact` in `utils/connector-definition-install.ts`).
 *
 * Only `chrome.*` is a reserved namespace. `os.shell`, `apple.*` and
 * `local.directory` are all keys a user may legitimately install with their own
 * source — so a device advertising one of those keys could silently discard
 * those bytes and repoint the definition at a manifest, converting a working
 * code-backed connector into one that only runs while a device is awake.
 *
 * `refreshPinnedOrgDeviceConnectorDefinitions` already declines this in team
 * orgs (`IS_DEVICE_CONNECTOR_SQL`); these cases pin the same bound on the wire
 * path, and — just as important — pin that it does not freeze the wiring it is
 * supposed to do. Ownership is read off the org-scoped row's `source_path`, and
 * off its bytes only when it has no path at all: `resolveConnectorInstallSource`
 * leaves `source_path` NULL for a pasted-`source_code` install, while bytes on a
 * `device-manifest://` row are stale and scrubbing them back to manifest-only is
 * a deliberate invariant.
 */
import type { DeviceConnectorManifest } from '@lobu/connector-sdk/device-manifest';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { deviceManifestHash } from '../../worker-api/device-manifests';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';

/** Deliberately outside the reserved `chrome.*` namespace — that is the collision. */
const CONNECTOR_KEY = 'apple.notes_wire_guard';
const CAPABILITY = 'os.files';
const ADVERTISED_VERSION = '2.0.0';
const INSTALLED_VERSION = '1.0.0';
const ORG_CODE = 'export default { key: "apple.notes_wire_guard" };';
const ORG_CODE_HASH = 'org-installed-artifact-hash';

function manifest(version = ADVERTISED_VERSION): DeviceConnectorManifest {
  return {
    key: CONNECTOR_KEY,
    version,
    name: 'Wire Guard Notes',
    description: 'Device manifest used to prove the wire-path artifact guard.',
    required_capability: CAPABILITY,
    runtime: { platforms: ['macos'] },
    auth_schema: { methods: [{ type: 'none' }] },
    feeds_schema: {
      commands: {
        key: 'commands',
        name: 'Commands',
        operations: ['sync'],
        eventKinds: { command: {} },
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
    VALUES (${userId}, 'Wire Guard Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
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

/** A device advertising the manifest, exactly as a poll would have stored it. */
async function seedAdvertisingDevice(userId: string, personalOrgId: string) {
  const sql = getTestDb();
  const advertised = manifest();
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, app_version, capabilities, label,
      organization_id, connector_manifests, last_seen_at
    ) VALUES (
      ${userId}, ${`wk-${generateSecureToken(6)}`}, 'macos', '0.8.1',
      ${sql.json([CAPABILITY])}, 'Test Mac', ${personalOrgId},
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
 * An existing personal-org definition under the same key. `artifact: 'code'` is
 * the shape a `source_uri` / `source_url` install leaves behind;
 * `'code-without-source-path'` is the shape a pasted-`source_code` install
 * leaves behind (`resolveConnectorInstallSource` derives a path from neither);
 * `'manifest'` is the shape device reconciliation itself installs;
 * `'manifest-with-stale-bytes'` is a device row that picked up compiled/source
 * bytes it must not keep; `'empty-marker'` is the content-empty preserve record
 * a rollback leaves behind, which owns nothing.
 */
async function seedInstalledConnector(
  organizationId: string,
  {
    artifact,
  }: {
    artifact:
      | 'code'
      | 'code-without-source-path'
      | 'manifest'
      | 'manifest-with-stale-bytes'
      | 'empty-marker';
  },
) {
  const sql = getTestDb();
  const isCode = artifact === 'code' || artifact === 'code-without-source-path';
  const staleBytes = artifact === 'manifest-with-stale-bytes';
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, description, version, auth_schema, feeds_schema,
      status, required_capability, created_at, updated_at
    ) VALUES (
      ${organizationId}, ${CONNECTOR_KEY}, 'Wire Guard Notes', 'installed',
      ${INSTALLED_VERSION}, ${sql.json({ methods: [{ type: 'none' }] })}, ${sql.json({})},
      'active', ${isCode ? null : CAPABILITY}, NOW(), NOW()
    )
  `;
  await sql`
    INSERT INTO connector_versions (
      connector_key, version, organization_id, compiled_code, compiled_code_hash,
      compile_config_hash, source_code, source_path
    ) VALUES (
      ${CONNECTOR_KEY}, ${INSTALLED_VERSION}, ${organizationId},
      ${isCode || staleBytes ? ORG_CODE : null},
      ${artifact === 'empty-marker' ? null : ORG_CODE_HASH}, NULL,
      ${isCode || staleBytes ? ORG_CODE : null},
      ${
        artifact === 'code'
          ? 'org-install'
          : artifact === 'code-without-source-path' || artifact === 'empty-marker'
            ? null
            : `device-manifest://macos/${CONNECTOR_KEY}@${INSTALLED_VERSION}`
      }
    )
  `;
}

async function readDefinition(organizationId: string) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT cd.version,
           cv.compiled_code_hash AS artifact_hash,
           cv.compiled_code IS NOT NULL AS has_compiled_code,
           cv.source_code IS NOT NULL AS has_source_code,
           cv.source_path
    FROM connector_definitions cd
    LEFT JOIN LATERAL (
      SELECT v.compiled_code, v.compiled_code_hash, v.source_code, v.source_path
      FROM connector_versions v
      WHERE v.connector_key = cd.key
        AND v.version = cd.version
        AND (v.organization_id = cd.organization_id OR v.organization_id IS NULL)
      ORDER BY v.organization_id NULLS LAST
      LIMIT 1
    ) cv ON TRUE
    WHERE cd.organization_id = ${organizationId}
      AND cd.key = ${CONNECTOR_KEY}
      AND cd.status = 'active'
    LIMIT 1
  `) as unknown as Array<{
    version: string;
    artifact_hash: string | null;
    has_compiled_code: boolean;
    has_source_code: boolean;
    source_path: string | null;
  }>;
  return rows[0] ?? null;
}

describe('device auto-wire artifact ownership guard', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('never wires over an artifact the org installed with its own code', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'code' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const untouched = await readDefinition(personalOrgId);
    expect(untouched?.version).toBe(INSTALLED_VERSION);
    expect(untouched?.artifact_hash).toBe(ORG_CODE_HASH);
    expect(untouched?.has_compiled_code).toBe(true);
    expect(untouched?.has_source_code).toBe(true);
  });

  it('never wires over inline source installed with no source_path', async () => {
    // `resolveConnectorInstallSource` derives `source_path` only from
    // `source_uri` / `source_url`; pasting `source_code` — the commonest custom
    // install — stores bytes with a NULL path. Reading ownership off the path
    // alone would wire straight over exactly that artifact.
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'code-without-source-path' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const untouched = await readDefinition(personalOrgId);
    expect(untouched?.version).toBe(INSTALLED_VERSION);
    expect(untouched?.artifact_hash).toBe(ORG_CODE_HASH);
    expect(untouched?.has_compiled_code).toBe(true);
    expect(untouched?.has_source_code).toBe(true);
    expect(untouched?.source_path).toBeNull();
  });

  it('leaves the org-installed connection alone rather than adopting it', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'code' });
    const sql = getTestDb();
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, display_name, status, config, slug,
        created_at, updated_at
      ) VALUES (
        ${personalOrgId}, ${CONNECTOR_KEY}, 'Hand-built shell', 'active',
        ${sql.json({})}, ${`shell-${generateSecureToken(4)}`}, NOW(), NOW()
      )
    `;

    await reconcileDeviceCapabilities(userId, deviceId);

    // A guarded pass must not pin the user's own connection to the device
    // either — the definition it would execute against is not the manifest.
    const [connection] = (await sql`
      SELECT device_worker_id FROM connections
      WHERE organization_id = ${personalOrgId} AND connector_key = ${CONNECTOR_KEY}
        AND deleted_at IS NULL
    `) as unknown as Array<{ device_worker_id: string | null }>;
    expect(connection?.device_worker_id).toBeNull();
    expect((await readDefinition(personalOrgId))?.has_compiled_code).toBe(true);
  });

  it('still upgrades a definition device reconciliation itself installed', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'manifest' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const refreshed = await readDefinition(personalOrgId);
    expect(refreshed?.version).toBe(ADVERTISED_VERSION);
    // Readiness compares this exact slot against the device's claim.
    expect(refreshed?.artifact_hash).toBe(manifestHash);
    expect(refreshed?.has_compiled_code).toBe(false);
  });

  it('still reconciles stale bytes sitting on a device-manifest row', async () => {
    // A row that HAS a path is judged on that path alone. Bytes on a
    // `device-manifest://` row are stale — a manifest hash must never attest
    // compiled bytes — so the row stays reconcilable. A guard that consulted
    // bytes even when a path is present would wrongly freeze it here.
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'manifest-with-stale-bytes' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const reconciled = await readDefinition(personalOrgId);
    expect(reconciled?.version).toBe(ADVERTISED_VERSION);
    expect(reconciled?.artifact_hash).toBe(manifestHash);
    expect(reconciled?.has_compiled_code).toBe(false);
    expect(reconciled?.has_source_code).toBe(false);
  });

  it('still reconciles a content-empty rollback marker row', async () => {
    // The preserve record a rollback leaves (no path, no bytes) is not org code
    // and must stay wireable: refusing it would freeze the definition with no
    // self-service repair.
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'empty-marker' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const reconciled = await readDefinition(personalOrgId);
    expect(reconciled?.version).toBe(ADVERTISED_VERSION);
    expect(reconciled?.artifact_hash).toBe(manifestHash);
    expect(reconciled?.source_path).toMatch(/^device-manifest:\/\//);
  });

  it('still performs a first install when the org has no definition at all', async () => {
    const { userId, personalOrgId } = await seedUserWithPersonalOrg();
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);

    await reconcileDeviceCapabilities(userId, deviceId);

    const installed = await readDefinition(personalOrgId);
    expect(installed?.version).toBe(ADVERTISED_VERSION);
    expect(installed?.artifact_hash).toBe(manifestHash);
    expect(installed?.source_path).toMatch(/^device-manifest:\/\//);
  });
});
