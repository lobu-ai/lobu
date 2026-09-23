/**
 * Mac bridge action runs: poll must surface the operation under both
 * `action_key` (chrome convention) and `operation_key` (Mac/iOS decode name).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceManifestHash } from '@lobu/connector-sdk/device-manifest-hash';
import type { DeviceConnectorManifest } from '@lobu/connector-sdk/device-manifest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

const CONNECTOR_KEY = 'apple.computer_use';
const OPERATION_KEY = 'permissions';

const MAC_MANIFESTS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../owletto/apps/mac/Owletto/ConnectorManifests/macos-device-connector-manifests.json',
);

// Private-submodule guard: skip in sandboxes without owletto access, but in
// CI a missing manifest must fail loudly, not silently skip.
const itWithManifest = existsSync(MAC_MANIFESTS_PATH)
  ? it
  : process.env.CI
    ? it
    : it.skip;

function loadComputerUseManifest(): Record<string, unknown> {
  const manifests = JSON.parse(readFileSync(MAC_MANIFESTS_PATH, 'utf8')) as unknown;
  if (!Array.isArray(manifests)) {
    throw new Error('canonical Owletto Mac manifest artifact must be an array');
  }
  const manifest = manifests.find(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      candidate.key === CONNECTOR_KEY,
  );
  if (!manifest) throw new Error(`${CONNECTOR_KEY} missing from canonical Owletto Mac manifests`);
  return manifest;
}

async function seedDeviceOwner() {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-mac-cu-${generateSecureToken(4)}`;
  const workerId = `mac-${generateSecureToken(6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Mac CU Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${orgId}, 'Mac CU Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  const deviceRows = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json(['computer_use'])}, 'Test Mac', ${orgId})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { userId, orgId, workerId, deviceWorkerId: deviceRows[0].id };
}

async function pollMac(
  workerId: string,
  capabilities: Record<string, boolean>,
  connectorManifests: unknown[],
) {
  return post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform: 'macos',
      app_version: '0.1.0',
      label: 'Test Mac',
      capabilities,
      connector_manifests: connectorManifests,
    },
  });
}

describe('mac computer_use action poll', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  itWithManifest('claims a pinned action run and returns operation_key alongside action_key', async () => {
    const { orgId, workerId, deviceWorkerId } = await seedDeviceOwner();
    const manifest = loadComputerUseManifest();
    const connectorManifests = [manifest];

    const install = await pollMac(workerId, { computer_use: true }, connectorManifests);
    expect(install.status).toBe(200);

    const sql = getTestDb();
    const connRows = (await sql`
      SELECT id, device_worker_id FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
      LIMIT 1
    `) as unknown as Array<{ id: number; device_worker_id: string }>;
    expect(connRows[0]?.id).toBeTruthy();
    expect(connRows[0]?.device_worker_id).toBe(deviceWorkerId);

    const inserted = (await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key, connector_version,
        connector_artifact_hash, action_key, action_input, approval_status, status, created_at
      ) VALUES (
        ${orgId}, 'action', ${connRows[0].id}, ${CONNECTOR_KEY}, '0.1.0',
        ${deviceManifestHash(manifest as unknown as DeviceConnectorManifest)},
        ${OPERATION_KEY}, ${sql.json({})}, 'auto', 'pending', current_timestamp
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = Number(inserted[0].id);

    const claim = await pollMac(workerId, { computer_use: true }, connectorManifests);
    expect(claim.status).toBe(200);
    const body = (await claim.json()) as Record<string, unknown>;

    expect(body.run_id).toBe(runId);
    expect(body.run_type).toBe('action');
    expect(body.connector_key).toBe(CONNECTOR_KEY);
    expect(body.action_key).toBe(OPERATION_KEY);
    expect(body.operation_key).toBe(OPERATION_KEY);
    expect(body.compiled_code).toBeUndefined();
  });
});
