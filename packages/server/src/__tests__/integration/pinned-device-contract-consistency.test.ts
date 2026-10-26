import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deviceManifestHash, type DeviceConnectorManifest } from '../../worker-api/device-manifests';
import { upsertEntityApprovalPolicy } from '../../authz/entity-policy';
import {
  getOperationForConnection,
  getOperationsSummary,
  getOperationsSummaryBatch,
  getOperationsSummariesByConnection,
} from '../../operations/connector-operations';
import { createSyncRun } from '../../runs/queue-service';
import { materializeDueFeeds, type DueFeedClaimContext } from '../../scheduled/check-due-feeds';
import { manageOperations } from '../../tools/admin/manage_operations';
import { manageFeeds } from '../../tools/admin/manage_feeds';
import { readSourceFeed } from '../../lib/connector-pushdown';
import { __setDeviceActionWaiterForTest } from '../../lib/device-feed-read';
import type { Env } from '../../index';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, ownerToolContext, seedOwnerContext } from '../setup/test-fixtures';

const KEY = 'test.pinned-contract';
const manifest = (version: string): DeviceConnectorManifest => ({
  key: KEY, version, name: 'Pinned contract fixture', required_capability: 'local_directory',
  runtime: { platforms: ['macos'] }, auth_schema: { methods: [{ type: 'none' }] },
  feeds_schema: { items: { operations: ['read', 'sync'] } },
  actions_schema: { inspect: { description: 'Inspect metadata', kind: 'read', input_schema: { type: 'object', properties: { contract: { const: version } } } } },
});

async function fixture(options: { olderReadOnly?: boolean; newerExtraOperation?: boolean; newerWithoutActions?: boolean } = {}) {
  const sql = getTestDb();
  const { org, user } = await seedOwnerContext({ orgName: 'Mixed pinned contracts' });
  const older = manifest('1.0.0');
  const newer = manifest('2.0.0');
  if (options.olderReadOnly) older.feeds_schema = { items: { operations: ['read'] } };
  if (options.newerExtraOperation) newer.actions_schema = { ...newer.actions_schema, new_only: { description: 'New contract only', kind: 'read' } };
  if (options.newerWithoutActions) delete newer.actions_schema;
  const hashes = [deviceManifestHash(older), deviceManifestHash(newer)];
  const devices: string[] = [];
  for (const [i, contract] of [older, newer].entries()) {
    const [dw] = await sql`INSERT INTO device_workers
      (user_id, worker_id, platform, app_version, capabilities, organization_id, last_seen_at, connector_manifests)
      VALUES (${user.id}, ${`mixed-device-${i}`}, 'macos', '9.9.0', ${sql.json(['local_directory'])},
        ${org.id}, now(), ${sql.json({ [KEY]: { manifest: contract, manifest_hash: hashes[i], received_at: new Date().toISOString() } })})
      RETURNING id`;
    devices.push(String(dw.id));
    await sql`INSERT INTO connector_versions
      (organization_id, connector_key, version, source_path, compiled_code_hash)
      VALUES (${org.id}, ${KEY}, ${contract.version}, ${`device-manifest://macos/${KEY}@${contract.version}`}, ${hashes[i]})`;
  }
  await sql`INSERT INTO connector_definitions
    (organization_id, key, name, version, status, runtime, required_capability, feeds_schema, actions_schema, auth_schema, supports_execute)
    VALUES (${org.id}, ${KEY}, 'Fleet winner', ${newer.version}, 'active', ${sql.json(newer.runtime)},
      ${newer.required_capability}, ${sql.json(newer.feeds_schema ?? {})}, ${sql.json(newer.actions_schema ?? {})},
      ${sql.json(newer.auth_schema ?? {})}, ${newer.actions_schema != null})`;
  const connection = await createTestConnection({ organization_id: org.id, connector_key: KEY,
    created_by: user.id, createDefaultFeed: false });
  await sql`UPDATE connections SET device_worker_id = ${devices[0]}::uuid WHERE id = ${connection.id}`;
  const [feed] = await sql`INSERT INTO feeds
    (organization_id, connection_id, feed_key, status, schedule, next_run_at)
    VALUES (${org.id}, ${connection.id}, 'items', 'active', '* * * * *', now() - interval '5 minutes') RETURNING id`;
  await upsertEntityApprovalPolicy(org.id, { resourceClass: 'connector_action', connectorKey: KEY, effects: { execute: 'auto' } });
  const claimContext: DueFeedClaimContext = {
    isUserScopedWorker: true, deviceWorkerId: devices[0], workerPlatform: 'macos',
    authorizedCapabilities: ['local_directory'], capabilityMatchSet: ['local_directory'],
    manifestClaimAuthorizations: [{ connectorKey: KEY, connectorVersion: older.version, manifestHash: hashes[0] }],
    allowLegacyManifestCapabilityClaims: false, orgScopeIds: [org.id], baseOrgScopeIds: [org.id],
    workerHardensDbEgress: false, workerSupportsHttpAuth: false, backendCapacity: {},
  };
  return { sql, org, user, devices, hashes, older, connection, feedId: Number(feed.id), claimContext,
    ctx: ownerToolContext(org.id, user.id) };
}

describe('pinned device contract consistency across preflight and dispatch', () => {
  beforeAll(async () => { await initWorkspaceProvider(); });
  beforeEach(async () => { await cleanupTestDatabase(); });
  afterEach(() => { __setDeviceActionWaiterForTest(null); });

  it('materializes an overdue feed against the pinned endpoint, despite a newer sibling contract', async () => {
    const f = await fixture();
    expect(await materializeDueFeeds({} as Env, f.sql, { claimContext: f.claimContext }))
      .toMatchObject({ runsCreated: 1 });
    const [run] = await f.sql`SELECT connector_version, connector_artifact_hash FROM runs WHERE feed_id = ${f.feedId}`;
    expect(run).toMatchObject({ connector_version: '1.0.0', connector_artifact_hash: f.hashes[0] });
    expect(await materializeDueFeeds({} as Env, f.sql, { claimContext: f.claimContext }))
      .toMatchObject({ runsCreated: 0 });
  });

  it('reports operations and feed health against the same contract dispatch selects', async () => {
    const f = await fixture();
    const result = await manageOperations({ action: 'list_available', connection_id: Number(f.connection.id) }, {} as Env, f.ctx) as any;
    expect(result.operations.find((op: any) => op.operation_key === 'inspect')).toMatchObject({ executable: true, readiness: 'ready' });
    const listed = await manageFeeds({ action: 'list_feeds', connection_id: Number(f.connection.id) }, {} as Env, f.ctx) as any;
    expect(listed.feeds[0].attention).not.toMatchObject({ kind: 'device_offline' });
    expect(JSON.stringify(listed.feeds[0].attention)).not.toContain('manifest');
  });

  it('scopes mixed-version operation schemas to their actual connections', async () => {
    const f = await fixture({ newerExtraOperation: true });
    const newerConnection = await createTestConnection({ organization_id: f.org.id, connector_key: KEY,
      created_by: f.user.id, createDefaultFeed: false });
    await f.sql`UPDATE connections SET device_worker_id = ${f.devices[1]}::uuid WHERE id = ${newerConnection.id}`;
    const result = await manageOperations({ action: 'list_available', connector_key: KEY, include_input_schema: true }, {} as Env, f.ctx) as any;
    const oldInspect = result.operations.find((op: any) => op.operation_key === 'inspect' && op.input_schema?.properties?.contract?.const === '1.0.0');
    expect(oldInspect.execution_targets.map((target: any) => target.connection_id)).toEqual([Number(f.connection.id)]);
    const newOnly = result.operations.find((op: any) => op.operation_key === 'new_only');
    expect(newOnly.execution_targets.map((target: any) => target.connection_id)).toEqual([Number(newerConnection.id)]);
    const oldOperation = await getOperationForConnection(f.org.id, Number(f.connection.id), 'inspect');
    expect(oldOperation?.connection.connector_version).toBe('1.0.0');
    expect(oldOperation?.operation.input_schema).toMatchObject({ properties: { contract: { const: '1.0.0' } } });
    expect(await getOperationForConnection(f.org.id, Number(f.connection.id), 'new_only')).toBeNull();
    const summaries = await getOperationsSummaryBatch(f.org.id, [KEY], f.user.id);
    expect(summaries.get(KEY)).toMatchObject({ total: result.total, reads: 3, local_action: 3 });
    expect(await getOperationsSummary(f.org.id, KEY, Number(f.connection.id))).toMatchObject({ total: 1 });
    const byConnection = await getOperationsSummariesByConnection(f.org.id, [
      { id: Number(f.connection.id), connectorKey: KEY },
      { id: Number(newerConnection.id), connectorKey: KEY },
    ]);
    expect(byConnection.get(Number(f.connection.id))).toMatchObject({ total: 1 });
    expect(byConnection.get(Number(newerConnection.id))).toMatchObject({ total: 2 });
  });

  it('keeps pinned actions executable when the newer fleet contract has no actions', async () => {
    const f = await fixture({ newerWithoutActions: true });
    const resolved = await getOperationForConnection(f.org.id, Number(f.connection.id), 'inspect');
    expect(resolved?.operation).toMatchObject({ supports_execute: true });
    const result = await manageOperations({ action: 'list_available', connection_id: Number(f.connection.id) }, {} as Env, f.ctx) as any;
    expect(result.operations).toMatchObject([{ operation_key: 'inspect', executable: true }]);
    expect(await getOperationsSummary(f.org.id, KEY, Number(f.connection.id))).toMatchObject({ total: 1 });
  });

  it('does not borrow a sibling sync capability for a read-only contract', async () => {
    const f = await fixture({ olderReadOnly: true });
    expect(await createSyncRun(f.feedId, {} as Env, f.sql)).toMatchObject({ ok: false, reason: 'sync_unsupported' });
    const listed = await manageFeeds({ action: 'list_feeds', connection_id: Number(f.connection.id) }, {} as Env, f.ctx) as any;
    expect(listed.feeds[0].operations).toEqual(['read']);
    const detail = await manageFeeds({ action: 'read_feed', feed_id: f.feedId }, {} as Env, f.ctx) as any;
    expect(detail.feed.operations).toEqual(['read']);
    expect(await materializeDueFeeds({} as Env, f.sql, { claimContext: f.claimContext })).toMatchObject({ runsCreated: 0 });
  });

  it('lets a bounded native source read reach the existing dispatch selector', async () => {
    const f = await fixture();
    __setDeviceActionWaiterForTest(async () => ({ status: 'completed', output: { rows: [{ id: 'metadata-only' }], columns: [] } }));
    const result = await readSourceFeed({ scope: { organizationId: f.org.id, principal: f.user.id }, feedId: f.feedId, limit: 1, deadlineAt: Date.now() + 5_000 });
    expect(result.rows).toEqual([{ id: 'metadata-only' }]);
    const [run] = await f.sql`SELECT connector_version, connector_artifact_hash, action_output FROM runs WHERE feed_id = ${f.feedId}`;
    expect(run).toMatchObject({ connector_version: '1.0.0', connector_artifact_hash: f.hashes[0], action_output: null });
  });

  it('never overrides an explicit feed version pin with the device default', async () => {
    const f = await fixture();
    await f.sql`UPDATE feeds SET pinned_version = '2.0.0' WHERE id = ${f.feedId}`;
    expect(await materializeDueFeeds({} as Env, f.sql, { claimContext: f.claimContext })).toMatchObject({ runsCreated: 0 });
    await expect(readSourceFeed({ scope: { organizationId: f.org.id, principal: f.user.id }, feedId: f.feedId, limit: 1, deadlineAt: Date.now() + 5_000 }))
      .rejects.toThrow('manifest');
  });

  it('never schedules a different device pin onto the current poller', async () => {
    const f = await fixture();
    await f.sql`UPDATE connections SET device_worker_id = ${f.devices[1]}::uuid WHERE id = ${f.connection.id}`;
    expect(await materializeDueFeeds({} as Env, f.sql, { claimContext: f.claimContext }))
      .toMatchObject({ runsCreated: 0 });
  });

  it.each(['hash', 'capability', 'platform'] as const)('keeps the %s fence closed', async (change) => {
    const f = await fixture();
    if (change === 'hash') await f.sql`UPDATE connector_versions SET compiled_code_hash = 'wrong-hash' WHERE organization_id = ${f.org.id} AND version = '1.0.0'`;
    if (change === 'capability') await f.sql`UPDATE device_workers SET capabilities = '[]'::jsonb WHERE id = ${f.devices[0]}::uuid`;
    if (change === 'platform') await f.sql`UPDATE device_workers SET platform = 'headless' WHERE id = ${f.devices[0]}::uuid`;
    await expect(readSourceFeed({ scope: { organizationId: f.org.id, principal: f.user.id }, feedId: f.feedId, limit: 1, deadlineAt: Date.now() + 5_000 })).rejects.toThrow();
  });
});
