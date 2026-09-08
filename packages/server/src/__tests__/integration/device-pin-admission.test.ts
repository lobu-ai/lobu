import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { createConnectorOperationRun, createSyncRun } from '../../runs/queue-service';
import { manageOperations } from '../../tools/admin/manage_operations';
import type { ToolContext } from '../../tools/registry';
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../worker-api/device-manifests';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const KEY = 'chrome.test_admission';
const CAPABILITY = 'browser.scripting';

function manifest(version = '1.0.0', name = 'Admission test browser'): DeviceConnectorManifest {
  return {
    key: KEY,
    version,
    name,
    description: 'Synthetic device admission test connector.',
    required_capability: CAPABILITY,
    runtime: { platforms: ['chrome-extension'] },
    auth_schema: { methods: [{ type: 'none' }] },
    actions_schema: {
      echo: {
        name: 'Echo',
        kind: 'read',
        input_schema: { type: 'object', properties: {} },
      },
    },
    feeds_schema: {
      default: { key: 'default', name: 'Snapshots', operations: ['sync'] },
    },
  };
}

async function seedDevice(userId: string, orgId: string, advertised: DeviceConnectorManifest) {
  const sql = getTestDb();
  const workerId = `admission-test-${randomUUID()}`;
  const [device] = await sql<{ id: string }[]>`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, connector_manifests,
      label, organization_id, last_seen_at
    ) VALUES (
      ${userId}, ${workerId}, ${advertised.runtime.platforms[0]}, ${sql.json([advertised.required_capability])},
      ${sql.json({
        [advertised.key]: {
          manifest: advertised,
          manifest_hash: deviceManifestHash(advertised),
          received_at: new Date().toISOString(),
        },
      })}, 'Synthetic admission device', ${orgId}, NOW()
    ) RETURNING id
  `;
  return { id: device.id, workerId };
}

async function seedFixture(advertised = manifest(), selected = manifest()) {
  const { org, user, ctx } = await seedOwnerContext();
  ctx.baseUrl = 'https://gateway.test/lobu';
  const sql = getTestDb();
  await sql`
    UPDATE organization SET metadata = ${sql.json({ personal_org_for_user_id: user.id })}
    WHERE id = ${org.id}
  `;
  await createTestConnectorDefinition({
    organization_id: org.id,
    key: selected.key,
    name: selected.name,
    version: selected.version,
    auth_schema: selected.auth_schema,
    feeds_schema: selected.feeds_schema,
  });
  await sql`
    UPDATE connector_definitions
    SET required_capability = ${selected.required_capability!}, runtime = ${sql.json(selected.runtime)},
        actions_schema = ${sql.json(selected.actions_schema!)}
    WHERE organization_id = ${org.id} AND key = ${selected.key}
  `;
  await sql`
    UPDATE connector_versions
    SET source_path = ${`device-manifest://${selected.runtime.platforms[0]}/${selected.key}@${selected.version}`},
        compiled_code = NULL, compile_config_hash = NULL, source_code = NULL,
        compiled_code_hash = ${deviceManifestHash(selected)}
    WHERE connector_key = ${selected.key} AND version = ${selected.version}
  `;
  const device = await seedDevice(user.id, org.id, advertised);
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: selected.key,
    created_by: user.id,
    visibility: 'private',
  });
  await sql`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${connection.id}`;
  await sql`UPDATE feeds SET next_run_at = '2099-01-01' WHERE connection_id = ${connection.id}`;
  return { org, user, ctx, connection, device, selected, advertised };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function queueOperation(fixture: Fixture, idempotencyKey?: string) {
  return createConnectorOperationRun({
    organizationId: fixture.org.id,
    connectionId: fixture.connection.id,
    connectorKey: fixture.selected.key,
    operationKey: 'echo',
    operationInput: {},
    approvalMode: 'device',
    createdByUserId: fixture.user.id,
    idempotencyKey,
  });
}

async function readiness(connectionId: number, ctx: ToolContext) {
  const result = await manageOperations(
    { action: 'list_available', connection_id: connectionId },
    {} as Env,
    ctx,
  ) as {
    operations: Array<{
      operation_key: string;
      executable: boolean;
      execution_targets: Array<{ executable: boolean; reason: string }>;
    }>;
  };
  const operation = result.operations.find((candidate) => candidate.operation_key === 'echo');
  expect(operation).toBeDefined();
  return operation!;
}

async function pollDevice(device: { workerId: string }, advertised: DeviceConnectorManifest) {
  const response = await post('/api/workers/poll', {
    body: {
      worker_id: device.workerId,
      platform: 'chrome-extension',
      app_version: '1.0.0',
      capabilities: { [CAPABILITY]: true },
      connector_manifests: [advertised],
      capacity_available: 1,
    },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ run_id?: number }>;
}

describe('manifest-backed device pin admission', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });

  afterEach(async () => {
    await cleanupTestDatabase();
  });

  it.each([
    ['different version', manifest('0.9.0')],
    ['different hash at the same version', manifest('1.0.0', 'Other implementation')],
  ])('blocks a pin advertising a %s even when another device matches', async (_case, advertised) => {
    const fixture = await seedFixture(advertised as DeviceConnectorManifest);
    await seedDevice(fixture.user.id, fixture.org.id, fixture.selected);
    const available = await readiness(fixture.connection.id, fixture.ctx);
    expect(available.executable).toBe(false);
    expect(available.execution_targets[0]).toMatchObject({ executable: false });
    expect(available.execution_targets[0].reason).toMatch(/manifest|setup|implementation|version/i);

    const result = await queueOperation(fixture);
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/device|manifest|setup|implementation|version/i);
    const rows = await getTestDb()`
      SELECT id FROM runs WHERE connection_id = ${fixture.connection.id}
        AND status IN ('pending', 'claimed', 'running')
    `;
    expect(rows).toHaveLength(0);
  });

  it('does not report ready when no device advertises the selected exact artifact', async () => {
    const fixture = await seedFixture(manifest('0.9.0'));
    const available = await readiness(fixture.connection.id, fixture.ctx);
    expect(available.executable).toBe(false);
    expect(available.execution_targets[0].reason).toMatch(/manifest|setup|implementation|version/i);
    const result = await queueOperation(fixture);
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/device|manifest|setup|implementation|version/i);
  });

  it.each([true, false])('rejects a manifest artifact without a hash (pinned=%s)', async (pinned) => {
    const fixture = await seedFixture(manifest('1.0.0', 'Unverified build'));
    const sql = getTestDb();
    await sql`
      UPDATE connector_versions SET compiled_code_hash = NULL
      WHERE connector_key = ${KEY} AND version = ${fixture.selected.version}
    `;
    if (!pinned) {
      await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${fixture.connection.id}`;
    }

    expect((await queueOperation(fixture)).status).toBe('failed');
    expect((await readiness(fixture.connection.id, fixture.ctx)).executable).toBe(false);
    const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${fixture.connection.id}`;
    await expect(createSyncRun(Number(feed.id), {} as Env)).rejects.toThrow(/manifest/i);
  });

  it('returns the admission failure through operations.execute without waiting for a worker', async () => {
    const fixture = await seedFixture(manifest('0.9.0'));
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 3_000);
    try {
      const result = await manageOperations(
        { action: 'execute', connection_id: fixture.connection.id, operation_key: 'echo', input: {} },
        {} as Env,
        { ...fixture.ctx, abortSignal: controller.signal },
      ) as { status?: string; error_message?: string };
      expect(controller.signal.aborted).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error_message).toMatch(/device|manifest|setup|implementation|version/i);
      const runnable = await getTestDb()`
        SELECT id FROM runs WHERE connection_id = ${fixture.connection.id}
          AND status IN ('pending', 'claimed', 'running')
      `;
      expect(runnable).toHaveLength(0);
    } finally {
      clearTimeout(deadline);
    }
  });

  it('returns a completed keyed result unchanged after its device goes offline', async () => {
    const fixture = await seedFixture();
    const first = await queueOperation(fixture, 'admission-completed-replay');
    expect(first.status).toBe('pending');
    const sql = getTestDb();
    await sql`
      UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json({ original: true })}
      WHERE id = ${first.runId}
    `;
    await sql`UPDATE device_workers SET last_seen_at = NOW() - INTERVAL '10 minutes' WHERE id = ${fixture.device.id}::uuid`;

    const replay = await queueOperation(fixture, 'admission-completed-replay');
    expect(replay).toMatchObject({
      created: false,
      runId: first.runId,
      status: 'completed',
      actionOutput: { original: true },
      errorMessage: null,
    });
    const fresh = await queueOperation(fixture, 'admission-after-offline');
    expect(fresh.status).toBe('failed');
  });

  it('admits a compatible operation only to the exact pinned device', async () => {
    const fixture = await seedFixture();
    const other = await seedDevice(fixture.user.id, fixture.org.id, fixture.selected);
    expect((await readiness(fixture.connection.id, fixture.ctx)).executable).toBe(true);
    const run = await queueOperation(fixture);
    expect(run.status).toBe('pending');
    const [stored] = await getTestDb()`SELECT target_device_worker_id FROM runs WHERE id = ${run.runId}`;
    expect(stored.target_device_worker_id).toBe(fixture.device.id);
    expect((await pollDevice(other, fixture.selected)).run_id).toBeUndefined();
    expect((await pollDevice(fixture.device, fixture.selected)).run_id).toBe(run.runId);
  });

  it('admits native capability-only actions and manual sync without a manifest hash', async () => {
    const native = {
      ...manifest(),
      key: 'local.test_admission',
      required_capability: 'local_directory',
      runtime: { platforms: ['macos'] },
    };
    const fixture = await seedFixture(native, native);
    const sql = getTestDb();
    await sql`
      UPDATE connector_versions SET compiled_code_hash = NULL
      WHERE connector_key = ${native.key} AND version = ${native.version}
    `;
    await sql`UPDATE device_workers SET connector_manifests = '{}'::jsonb WHERE id = ${fixture.device.id}::uuid`;
    expect((await readiness(fixture.connection.id, fixture.ctx)).executable).toBe(true);
    const run = await queueOperation(fixture);
    expect(run.status).toBe('pending');
    const response = await post('/api/workers/poll', {
      body: {
        worker_id: fixture.device.workerId,
        platform: 'macos',
        capabilities: { local_directory: true },
        capacity_available: 1,
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).run_id).toBe(run.runId);
    const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${fixture.connection.id}`;
    expect((await createSyncRun(Number(feed.id), {} as Env)).ok).toBe(true);
  });

  it('rejects a hashless artifact whose platform cannot use the legacy capability lane', async () => {
    // `headless` and `chrome-extension` are excluded from
    // `legacyHashlessManifestAuthorization`, so a hashless artifact confined to
    // them is unclaimable — admitting it would park a run nothing can pick up.
    const shell = {
      ...manifest(),
      key: 'local.test_headless_admission',
      required_capability: 'local_directory',
      runtime: { platforms: ['headless'] },
    };
    const fixture = await seedFixture(shell, shell);
    const sql = getTestDb();
    await sql`
      UPDATE connector_versions SET compiled_code_hash = NULL
      WHERE connector_key = ${shell.key} AND version = ${shell.version}
    `;
    await sql`UPDATE device_workers SET connector_manifests = '{}'::jsonb WHERE id = ${fixture.device.id}::uuid`;
    expect((await readiness(fixture.connection.id, fixture.ctx)).executable).toBe(false);
    const run = await queueOperation(fixture);
    expect(run.status).toBe('failed');
    const [stored] = await sql`SELECT error_message FROM runs WHERE id = ${run.runId}`;
    expect(String(stored.error_message)).toMatch(/selected connector manifest.*eligible device/i);
    const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${fixture.connection.id}`;
    await expect(createSyncRun(Number(feed.id), {} as Env)).rejects.toThrow(/selected connector manifest.*eligible device/i);
  });

  it('rejects a manual sync whose selected artifact cannot run on its pinned device', async () => {
    const fixture = await seedFixture(manifest('0.9.0'));
    const [feed] = await getTestDb()`SELECT id FROM feeds WHERE connection_id = ${fixture.connection.id}`;
    await expect(createSyncRun(Number(feed.id), {} as Env)).rejects.toThrow(/device|manifest|setup|implementation|version/i);
    const runs = await getTestDb()`SELECT id FROM runs WHERE connection_id = ${fixture.connection.id}`;
    expect(runs).toHaveLength(0);
  });

  it('admits a retained pinned_version sync despite an incompatible newer active definition', async () => {
    const oldManifest = manifest('0.9.0');
    const fixture = await seedFixture(oldManifest);
    const sql = getTestDb();
    await sql`
      INSERT INTO connector_versions (
        organization_id, connector_key, version, source_path, compiled_code_hash, created_at
      ) VALUES (
        ${fixture.org.id}, ${KEY}, ${oldManifest.version},
        ${`device-manifest://chrome-extension/${KEY}@${oldManifest.version}`},
        ${deviceManifestHash(oldManifest)}, NOW()
      )
    `;
    const [feed] = await sql`
      UPDATE feeds SET pinned_version = ${oldManifest.version}
      WHERE connection_id = ${fixture.connection.id} RETURNING id
    `;
    const result = await createSyncRun(Number(feed.id), {} as Env);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Sync was skipped: ${result.reason}`);
    const [run] = await sql`
      SELECT connector_version, target_device_worker_id, status FROM runs WHERE id = ${result.runId}
    `;
    expect(run).toMatchObject({
      connector_version: oldManifest.version,
      target_device_worker_id: fixture.device.id,
      status: 'pending',
    });
  });
});
