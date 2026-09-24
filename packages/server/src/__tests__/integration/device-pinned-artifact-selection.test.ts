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
import { deviceManifestHash } from '@lobu/connector-sdk/device-manifest-hash';
import type { DeviceConnectorManifest } from '@lobu/connector-sdk/device-manifest';
import { handleApprove } from '../../tools/admin/manage_operations/handlers/approvals';
import { ownerToolContext } from '../setup/test-fixtures';
import type { Env } from '../../index';
import { insertEvent } from '../../utils/insert-event';
import { readFileSync } from 'node:fs';

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

async function poll(workerId: string, manifests: unknown[] | undefined, platform: string) {
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
    SELECT connector_version, connector_artifact_hash, target_device_worker_id, error_message, status
    FROM runs WHERE id = ${runId}
  `) as unknown as Array<{
    connector_version: string;
    connector_artifact_hash: string | null;
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

  it('does not claim an admitted run after the same device changes its manifest without a version bump', async () => {
    const { orgId, workerId } = await seedOwnerWithDevice('macos');
    expect((await poll(workerId, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const queued = await queueShellRun(orgId, Number(connection.id));
    expect((await runRow(queued.runId)).status).toBe('pending');
    expect((await runRow(queued.runId)).connector_artifact_hash).toBe(
      deviceManifestHash(OS_SHELL_MANIFEST as unknown as DeviceConnectorManifest),
    );

    const changed = { ...OS_SHELL_MANIFEST, description: 'A different contract under the same version' };
    const response = await poll(workerId, [changed], 'macos');
    expect(response.status).toBe(200);
    const job = await response.json() as { run_id?: number };
    expect(job.run_id).toBeUndefined();
    expect((await runRow(queued.runId)).status).toBe('pending');
  });

  it.each(['missing', 'different-family'] as const)('keeps the admitted hash authoritative when the catalog artifact is %s', async (change) => {
    const sql = getTestDb();
    const { orgId, workerId } = await seedOwnerWithDevice('macos');
    expect((await poll(workerId, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const queued = await queueShellRun(orgId, Number(connection.id));
    if (change === 'missing') {
      await sql`DELETE FROM connector_versions WHERE organization_id = ${orgId} AND connector_key = 'os.shell'`;
    } else {
      await sql`UPDATE connector_versions SET source_path = 'https://connector.example.test/mcp', compiled_code_hash = NULL
        WHERE organization_id = ${orgId} AND connector_key = 'os.shell'`;
    }
    // A capability-only poll cannot claim a run admitted against an exact hash,
    // even when the current artifact no longer looks manifest-backed.
    const response = await poll(workerId, [], 'macos');
    expect(response.status).toBe(200);
    expect((await response.json() as { run_id?: number }).run_id).toBeUndefined();
    expect((await runRow(queued.runId)).status).toBe('pending');
  });

  it('records queued approvals and refuses approval after the device contract changes', async () => {
    const { userId, orgId, workerId } = await seedOwnerWithDevice('macos');
    expect((await poll(workerId, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const queued = await createConnectorOperationRun({
      organizationId: orgId, connectionId: Number(connection.id),
      connectorKey: 'os.shell', operationKey: 'run', operationInput: { command: 'hostname' },
      approvalMode: 'queued', createdByUserId: userId,
    });
    expect((await runRow(queued.runId)).connector_artifact_hash).toBe(
      deviceManifestHash(OS_SHELL_MANIFEST as unknown as DeviceConnectorManifest),
    );
    expect((await poll(workerId, [{ ...OS_SHELL_MANIFEST, description: 'Changed before approval' }], 'macos')).status).toBe(200);
    const result = await handleApprove({ action: 'approve', run_id: queued.runId }, ownerToolContext(orgId, userId), {} as Env);
    expect(result).toEqual({ error: expect.stringContaining('contract changed') });
    const [run] = await getTestDb()`SELECT approval_status FROM runs WHERE id = ${queued.runId}`;
    expect(run.approval_status).toBe('pending');
  });

  it('rejects changes to an admitted run identity in the database', async () => {
    const sql = getTestDb();
    const { orgId, workerId } = await seedOwnerWithDevice('macos');
    expect((await poll(workerId, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const queued = await queueShellRun(orgId, Number(connection.id));
    await expect(sql`UPDATE runs SET connector_artifact_hash = NULL WHERE id = ${queued.runId}`).rejects.toThrow('immutable');
    await expect(sql`UPDATE runs SET connector_version = '9.9.9' WHERE id = ${queued.runId}`).rejects.toThrow('immutable');
    await sql`UPDATE runs SET status = 'cancelled' WHERE id = ${queued.runId}`;
    expect((await runRow(queued.runId)).status).toBe('cancelled');
  });

  it('approves and claims a queued run when the original device still advertises its contract', async () => {
    const { userId, orgId, workerId } = await seedOwnerWithDevice('macos');
    expect((await poll(workerId, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const queued = await createConnectorOperationRun({
      organizationId: orgId, connectionId: Number(connection.id),
      connectorKey: 'os.shell', operationKey: 'run', operationInput: { command: 'hostname' },
      approvalMode: 'queued', createdByUserId: userId,
    });
    await insertEvent({
      entityIds: [], organizationId: orgId, originId: `run_${queued.runId}_pending`,
      title: 'Shell operation awaiting approval', content: null, semanticType: 'operation',
      runId: queued.runId, interactionType: 'approval', interactionStatus: 'pending',
      metadata: { action_key: 'run', run_id: queued.runId }, authorName: 'Test requester',
    });
    const result = await handleApprove({ action: 'approve', run_id: queued.runId }, ownerToolContext(orgId, userId), {} as Env);
    expect(result).not.toHaveProperty('error');
    const [approved] = await getTestDb()`SELECT approval_status FROM runs WHERE id = ${queued.runId}`;
    expect(approved.approval_status).toBe('approved');
    const response = await poll(workerId, [OS_SHELL_MANIFEST], 'macos');
    expect(response.status).toBe(200);
    expect((await response.json() as { run_id?: number }).run_id).toBe(queued.runId);
  });

  it('never guesses the hash for a run inserted without its admitted manifest', async () => {
    const sql = getTestDb();
    const { orgId, workerId } = await seedOwnerWithDevice('macos');
    expect((await poll(workerId, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const [run] = await sql`
      INSERT INTO runs (organization_id, run_type, connection_id, connector_key, connector_version,
        action_key, action_input, status, approval_status, target_device_worker_id)
      VALUES (${orgId}, 'action', ${connection.id}, 'os.shell', ${OS_SHELL_MANIFEST.version as string},
        'run', ${sql.json({ command: 'hostname' })}, 'pending', 'auto', ${connection.device_worker_id}::uuid)
      RETURNING id
    `;
    const response = await poll(workerId, [OS_SHELL_MANIFEST], 'macos');
    expect(response.status).toBe(200);
    expect((await response.json() as { run_id?: number }).run_id).toBeUndefined();
    expect(await runRow(Number(run.id))).toMatchObject({ status: 'pending', connector_artifact_hash: null });
  });

  it('cuts over pending runs without guessing their hashes and preserves compiled work', async () => {
    const sql = getTestDb();
    const { orgId, workerId } = await seedOwnerWithDevice('macos');
    expect((await poll(workerId, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const queued = await queueShellRun(orgId, Number(connection.id));
    const [compiled] = await sql`
      INSERT INTO runs (organization_id, run_type, connector_key, connector_version, status, approval_status)
      VALUES (${orgId}, 'action', 'test.compiled', '1.0.0', 'pending', 'pending') RETURNING id
    `;
    await sql`
      INSERT INTO connector_versions (organization_id, connector_key, version, compiled_code, compiled_code_hash)
      VALUES (${orgId}, 'test.compiled', '1.0.0', 'export default {}', 'compiled-fixture-hash')
    `;
    const [missing] = await sql`
      INSERT INTO runs (organization_id, run_type, connector_key, connector_version, status, approval_status)
      VALUES (${orgId}, 'action', 'test.missing', '1.0.0', 'pending', 'pending') RETURNING id
    `;
    // Exercise the actual migration against the pre-column schema. This is a
    // disposable embedded database; the transaction restores it on failure.
    const migration = readFileSync(new URL('../../../../../db/migrations/20260923230000_runs_connector_artifact_hash.sql', import.meta.url), 'utf8').split('-- migrate:down')[0];
    await sql.begin(async (tx) => {
      await tx`DROP TRIGGER runs_preserve_connector_artifact ON runs`;
      await tx`DROP FUNCTION preserve_run_connector_artifact()`;
      await tx`ALTER TABLE runs DROP COLUMN connector_artifact_hash`;
      await tx.unsafe(migration);
      await tx.unsafe(migration);
    });
    expect(await runRow(queued.runId)).toMatchObject({ status: 'failed', connector_artifact_hash: null, error_message: expect.stringContaining('Re-run') });
    // Cloud connectors can resolve code from the image without a version row.
    expect(await runRow(Number(missing.id))).toMatchObject({ status: 'pending', connector_artifact_hash: null });
    const [preserved] = await sql`SELECT status, approval_status FROM runs WHERE id = ${compiled.id}`;
    expect(preserved).toMatchObject({ status: 'pending', approval_status: 'pending' });
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

  it('approves a queued run on a pinned endpoint after a sibling endpoint advertises a newer version', async () => {
    const { userId, orgId, workerId: macWorker } = await seedOwnerWithDevice('macos');
    expect((await poll(macWorker, [OS_SHELL_MANIFEST], 'macos')).status).toBe(200);
    const connection = await shellConnection(orgId);
    const queued = await createConnectorOperationRun({
      organizationId: orgId, connectionId: Number(connection.id),
      connectorKey: 'os.shell', operationKey: 'run', operationInput: { command: 'hostname' },
      approvalMode: 'queued', createdByUserId: userId,
    });
    await insertEvent({
      entityIds: [], organizationId: orgId, originId: `run_${queued.runId}_pending`,
      title: 'Shell operation awaiting approval', content: null, semanticType: 'operation',
      runId: queued.runId, interactionType: 'approval', interactionStatus: 'pending',
      metadata: { action_key: 'run', run_id: queued.runId }, authorName: 'Test requester',
    });
    const headlessWorker = await addDevice(userId, orgId, 'headless');
    expect((await poll(headlessWorker, [{ ...OS_SHELL_MANIFEST, version: '9.9.9' }], 'headless')).status).toBe(200);
    const result = await handleApprove({ action: 'approve', run_id: queued.runId }, ownerToolContext(orgId, userId), {} as Env);
    expect(result).not.toHaveProperty('error');
    const response = await poll(macWorker, [OS_SHELL_MANIFEST], 'macos');
    expect((await response.json() as { run_id?: number }).run_id).toBe(queued.runId);
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
