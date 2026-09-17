/**
 * A device-pinned connection's runs must be created against the contract the
 * PINNED endpoint advertises, not the organization's fleet-elected definition.
 *
 * The org keeps one active `connector_definitions` row per key, elected across
 * the whole fleet, while every advertised artifact is retained as its own
 * `connector_versions` row. Selecting the run's artifact from the elected row
 * made a healthy pinned endpoint unrunnable whenever a SIBLING endpoint
 * advertised a different version: the run was created against an artifact the
 * target never claimed, so the manifest admission gate failed it closed and
 * the connection went dark for a reason unrelated to its own device (#3306).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { createConnectorOperationRun } from '../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';
import { DEVICE_MANIFESTS_BY_PLATFORM } from '@lobu/connector-worker/daemon/device-manifests';

// The contract the shipped daemon actually advertises, read from its generated
// artifact: the point is that the SHIPPED manifest stays runnable on a pin.
const OS_SHELL_MANIFEST = (DEVICE_MANIFESTS_BY_PLATFORM.headless ?? []).find(
  (entry) => (entry as { key?: string }).key === 'os.shell',
) as Record<string, unknown> | undefined;
if (!OS_SHELL_MANIFEST) {
  throw new Error('headless daemon advertises no os.shell manifest');
}

async function seedOwnerWithDevice(platform: string) {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-pinned-artifact-${generateSecureToken(4)}`;
  const workerId = `wk-${generateSecureToken(6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Pinned Artifact Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (${orgId}, 'Pinned Artifact Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW())
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, ${platform}, '0.1.0', ${sql.json([])}, ${`Device ${platform}`}, ${orgId})
  `;
  return { userId, orgId, workerId };
}

async function addDevice(userId: string, orgId: string, platform: string) {
  const sql = getTestDb();
  const workerId = `wk-${platform}-${generateSecureToken(4)}`;
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, ${platform}, '0.1.0', ${sql.json([])}, ${`Device ${platform}`}, ${orgId})
  `;
  return workerId;
}

async function poll(workerId: string, manifests: unknown[], platform: string) {
  return post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform,
      app_version: '9.9.0',
      label: `Device ${platform}`,
      capabilities: { 'os.shell': true },
      connector_manifests: manifests,
    },
  });
}

async function deviceIdFor(workerId: string): Promise<string> {
  const rows = (await getTestDb()`
    SELECT id FROM device_workers WHERE worker_id = ${workerId} LIMIT 1
  `) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

async function shellConnection(orgId: string) {
  const rows = (await getTestDb()`
    SELECT id, device_worker_id FROM connections
    WHERE organization_id = ${orgId} AND connector_key = 'os.shell' AND deleted_at IS NULL
    ORDER BY id
  `) as unknown as Array<{ id: number; device_worker_id: string | null }>;
  return rows[0];
}

function queueShellRun(orgId: string, connectionId: number) {
  return createConnectorOperationRun({
    organizationId: orgId,
    connectionId,
    connectorKey: 'os.shell',
    operationKey: 'run',
    operationInput: { command: 'hostname' },
    approvalMode: 'device',
    requireCompiledCode: true,
  });
}

async function runRow(runId: number) {
  const rows = (await getTestDb()`
    SELECT connector_version, target_device_worker_id, error_message, status
    FROM runs WHERE id = ${runId}
  `) as unknown as Array<{
    connector_version: string;
    target_device_worker_id: string | null;
    error_message: string | null;
    status: string;
  }>;
  return rows[0];
}

describe('device-pinned artifact selection', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
  });

  it('keeps a pinned endpoint runnable when a sibling endpoint advertises a newer version', async () => {
    const { userId, orgId, workerId: macWorker } = await seedOwnerWithDevice('macos');
    // The pinned Mac advertises the shipped contract and gets auto-wired.
    expect((await poll(macWorker, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const macId = await deviceIdFor(macWorker);
    const connection = await shellConnection(orgId);
    expect(connection.device_worker_id).toBe(macId);
    const shippedVersion = OS_SHELL_MANIFEST.version as string;

    // A sibling endpoint ships a NEWER contract and wins the org's single
    // active definition slot. The Mac keeps advertising what it shipped with.
    const headlessWorker = await addDevice(userId, orgId, 'headless');
    const newer = { ...OS_SHELL_MANIFEST, version: '9.9.9' };
    expect((await poll(headlessWorker, [newer], 'headless')).status).toBe(200);
    const [activeDefinition] = (await getTestDb()`
      SELECT version FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = 'os.shell' AND status = 'active'
    `) as unknown as Array<{ version: string }>;
    expect(activeDefinition.version).toBe('9.9.9');

    // The pin must be preserved, and the run created against the MAC's
    // artifact so the Mac can claim it.
    const queued = await queueShellRun(orgId, Number(connection.id));
    const run = await runRow(queued.runId);
    expect(run.error_message).toBeNull();
    expect(run.target_device_worker_id).toBe(macId);
    expect(run.connector_version).toBe(shippedVersion);

    const claimed = (await (await poll(macWorker, [OS_SHELL_MANIFEST], 'macos')).json()) as {
      run_id?: number;
      connector_version?: string;
    };
    expect(claimed.run_id).toBe(queued.runId);
    expect(claimed.connector_version).toBe(shippedVersion);
  });

  it('routes each endpoint its own run and never the other endpoint\'s', async () => {
    const { userId, orgId, workerId: macWorker } = await seedOwnerWithDevice('macos');
    expect((await poll(macWorker, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const macId = await deviceIdFor(macWorker);
    const connection = await shellConnection(orgId);

    const headlessWorker = await addDevice(userId, orgId, 'headless');
    expect((await poll(headlessWorker, [OS_SHELL_MANIFEST], 'headless')).status).toBe(200);

    const queued = await queueShellRun(orgId, Number(connection.id));
    expect((await runRow(queued.runId)).target_device_worker_id).toBe(macId);

    // The non-target endpoint must not receive the run.
    const headlessJob = (await (await poll(headlessWorker, [OS_SHELL_MANIFEST], 'headless')).json()) as {
      run_id?: number;
    };
    expect(headlessJob.run_id).toBeUndefined();

    // The target endpoint receives it and is recorded as the executor.
    const macJob = (await (await poll(macWorker, [OS_SHELL_MANIFEST], 'macos')).json()) as {
      run_id?: number;
    };
    expect(macJob.run_id).toBe(queued.runId);
    const [executed] = (await getTestDb()`
      SELECT executed_by_device_worker_id FROM runs WHERE id = ${queued.runId}
    `) as unknown as Array<{ executed_by_device_worker_id: string | null }>;
    expect(executed.executed_by_device_worker_id).toBe(macId);
  });

  it('still fails closed when the pinned endpoint advertises an unregistered version', async () => {
    const sql = getTestDb();
    const { orgId, workerId: macWorker } = await seedOwnerWithDevice('macos');
    expect((await poll(macWorker, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);

    // Drop the registered artifact for the version the device advertises.
    // Nothing registered means nothing admissible: the pin must not redirect
    // the run onto an artifact this organization never registered.
    await sql`
      DELETE FROM connector_versions
      WHERE connector_key = 'os.shell' AND version = ${OS_SHELL_MANIFEST.version as string}
    `;
    await sql`
      UPDATE connector_definitions SET version = '0.0.9'
      WHERE organization_id = ${orgId} AND key = 'os.shell' AND status = 'active'
    `;
    await sql`
      INSERT INTO connector_versions (connector_key, version, organization_id, source_path, compiled_code_hash)
      VALUES ('os.shell', '0.0.9', ${orgId}, 'device-manifest://macos/os.shell@0.0.9', 'deadbeef')
    `;

    const queued = await queueShellRun(orgId, Number(connection.id));
    const run = await runRow(queued.runId);
    expect(run.connector_version).toBe('0.0.9');
    expect(run.status).toBe('failed');
    expect(run.error_message).toMatch(/manifest|device|setup/i);
  });
});
