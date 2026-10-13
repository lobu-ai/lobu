import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertEntityApprovalPolicy } from '../../authz/entity-policy';
import type { Env } from '../../index';
import { reapStaleRuns } from '../../scheduled/check-stalled-executions';
import { manageOperations } from '../../tools/admin/manage_operations';
import type { ToolContext } from '../../tools/registry';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, seedOwnerContext } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const CONNECTOR = 'demo.device.queue';
const SELECTED_WORKER = 'synthetic-selected-worker';
const OTHER_WORKER = 'synthetic-other-worker';

describe('public device operation queue deadlines', () => {
  let ctx: ToolContext;
  let connectionId: number;
  let selectedDeviceId: string;
  let otherDeviceId: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of ['RUNS_REAPER_STALE_AFTER_SECONDS', 'WORKER_API_TOKEN', 'LOBU_CLOUD_MODE']) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.RUNS_REAPER_STALE_AFTER_SECONDS = '120';
    await initWorkspaceProvider();
  });

  afterAll(async () => {
    await cleanupTestDatabase();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext({ orgName: 'Device Queue Fixture' });
    ctx = { ...seeded.ctx, baseUrl: 'https://gateway.test/lobu' };
    const sql = getTestDb();
    await createTestConnectorDefinition({
      key: CONNECTOR, name: 'Device queue fixture', organization_id: ctx.organizationId,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      echo: { name: 'Echo', kind: 'write', input_schema: { type: 'object' } },
    })}, supports_execute = true WHERE organization_id = ${ctx.organizationId} AND key = ${CONNECTOR}`;
    const devices = await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${seeded.user.id}, ${SELECTED_WORKER}, 'macos', '0.1.0', '[]'::jsonb, 'Selected device', ${ctx.organizationId}, NOW()),
             (${seeded.user.id}, ${OTHER_WORKER}, 'macos', '0.1.0', '[]'::jsonb, 'Other device', ${ctx.organizationId}, NOW())
      RETURNING id, worker_id
    `;
    selectedDeviceId = String(devices.find(d => d.worker_id === SELECTED_WORKER)!.id);
    otherDeviceId = String(devices.find(d => d.worker_id === OTHER_WORKER)!.id);
    const connection = await createTestConnection({
      organization_id: ctx.organizationId, connector_key: CONNECTOR,
      created_by: seeded.user.id, visibility: 'private',
    });
    connectionId = connection.id;
    await sql`UPDATE connections SET device_worker_id = ${selectedDeviceId}::uuid WHERE id = ${connectionId}`;
    await policy('auto');
  });

  async function policy(effect: 'auto' | 'approval' | 'deny') {
    await upsertEntityApprovalPolicy(ctx.organizationId, {
      resourceClass: 'connector_action', connectionId, effects: { execute: effect },
    });
  }

  function execute(background = true, key = 'synthetic-queue-request', context = ctx) {
    return manageOperations({ action: 'execute', connection_id: connectionId,
      operation_key: 'echo', input: {}, background, idempotency_key: key }, {} as Env, context) as Promise<{
        run_id: number; status: string; message?: string; output?: unknown;
      }>;
  }

  async function row(runId: number) {
    const [run] = await getTestDb()`SELECT *,
      EXTRACT(EPOCH FROM (expires_at - created_at))::float AS creation_budget,
      EXTRACT(EPOCH FROM (expires_at - run_at))::float AS approval_budget
      FROM runs WHERE id = ${runId}`;
    return run!;
  }

  async function poll(workerId = SELECTED_WORKER, capacity = 1) {
    const response = await post('/api/workers/poll', { body: {
      worker_id: workerId, platform: 'macos', app_version: '0.1.0', label: workerId,
      capabilities: {}, capacity_available: capacity,
    } });
    expect(response.status).toBe(200);
    return response.json();
  }

  it('persists ten minutes for explicit background and sixty seconds for foreground', async () => {
    const queued = await execute();
    expect(queued.status).toBe('in_progress');
    expect(await row(queued.run_id)).toMatchObject({ creation_budget: 600, run_metadata: { background: true } });
    expect(queued.message).toMatch(/queued.*selected device/i);
    expect(queued.message).not.toMatch(/offline|capacity|busy/i);

    // End the real synchronous waiter immediately; the inserted queue horizon
    // remains observable without sleeping for the production sixty seconds.
    const abort = new AbortController();
    abort.abort();
    const foreground = await execute(false, 'synthetic-foreground', { ...ctx, abortSignal: abort.signal });
    expect(foreground.status).toBe('timeout');
    expect((await row(foreground.run_id)).creation_budget).toBe(60);
  });

  it('waits past the coarse reaper threshold, retains the exact pin, and completes through worker routes', async () => {
    const queued = await execute();
    const sql = getTestDb();
    await sql`UPDATE runs SET created_at = now() - interval '3 minutes' WHERE id = ${queued.run_id}`;
    // A healthy device reporting no capacity leaves work queued. No assertion
    // about why it has no capacity is inferred from the queue state itself.
    expect(await poll(SELECTED_WORKER, 0)).not.toHaveProperty('run_id', queued.run_id);
    await reapStaleRuns();
    expect((await row(queued.run_id)).status).toBe('pending');
    await sql`UPDATE connections SET device_worker_id = ${otherDeviceId}::uuid WHERE id = ${connectionId}`;
    expect(await poll(OTHER_WORKER)).not.toHaveProperty('run_id', queued.run_id);
    expect(await poll()).toMatchObject({ run_id: queued.run_id });
    expect((await row(queued.run_id)).target_device_worker_id).toBe(selectedDeviceId);
    const completed = await post('/api/workers/complete-action', { body: {
      run_id: queued.run_id, worker_id: SELECTED_WORKER, status: 'success', action_output: { done: true },
    } });
    expect(completed.status).toBe(200);
    expect(await execute()).toMatchObject({ run_id: queued.run_id, status: 'completed', output: { done: true } });
  });

  it('replays without renewing expiry or changing the original background intent', async () => {
    const queued = await execute();
    const sql = getTestDb();
    await sql`UPDATE runs SET expires_at = now() + interval '4 minutes' WHERE id = ${queued.run_id}`;
    const original = await row(queued.run_id);
    expect(await execute(false)).toMatchObject({ run_id: queued.run_id, status: 'in_progress' });
    expect((await row(queued.run_id)).expires_at).toEqual(original.expires_at);
    expect((await row(queued.run_id)).run_metadata.background).toBe(true);
    await sql`UPDATE runs SET expires_at = now() - interval '1 second' WHERE id = ${queued.run_id}`;
    const expired = (await row(queued.run_id)).expires_at;
    // The poller must reject the row even before a reaper has run.
    expect(await poll()).not.toHaveProperty('run_id', queued.run_id);
    await reapStaleRuns();
    expect(await execute()).toMatchObject({ run_id: queued.run_id, status: 'timeout' });
    expect((await row(queued.run_id)).expires_at).toEqual(expired);
    expect(await poll()).not.toHaveProperty('run_id', queued.run_id);
  });

  it.each([false, true])('starts the device claim budget at human approval (background=%s)', async background => {
    await policy('approval');
    const queued = await execute(background);
    expect(queued.status).toBe('pending_approval');
    expect((await row(queued.run_id)).expires_at).toBeNull();
    const sql = getTestDb();
    await sql`UPDATE runs SET created_at = now() - interval '1 day', run_at = now() - interval '1 day' WHERE id = ${queued.run_id}`;
    await reapStaleRuns();
    expect(await poll()).not.toHaveProperty('run_id', queued.run_id);
    expect(await manageOperations({ action: 'approve', run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ approved: true });
    const approved = await row(queued.run_id);
    expect(approved.approval_budget).toBe(background ? 600 : 60);
    expect(await execute(!background)).toMatchObject({ run_id: queued.run_id, status: 'in_progress' });
    expect((await row(queued.run_id)).expires_at).toEqual(approved.expires_at);
    if (background) {
      await sql`UPDATE runs SET run_at = now() - interval '3 minutes' WHERE id = ${queued.run_id}`;
      await reapStaleRuns();
      expect((await row(queued.run_id)).status).toBe('pending');
    }
    await sql`UPDATE runs SET expires_at = now() - interval '1 second' WHERE id = ${queued.run_id}`;
    expect(await poll()).not.toHaveProperty('run_id', queued.run_id);
    await reapStaleRuns();
    expect(await row(queued.run_id)).toMatchObject({ status: 'timeout', error_message: 'worker_claim_timeout' });
    const [card] = await sql`SELECT interaction_error FROM current_event_records WHERE run_id = ${queued.run_id} AND semantic_type = 'operation'`;
    expect(card?.interaction_error).toBe('worker_claim_timeout');
  });

  it('preserves explicit cancellation before claim and policy rechecks after approval', async () => {
    const queued = await execute();
    expect(await manageOperations({ action: 'cancel', run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ cancelled: true });
    expect(await poll()).not.toHaveProperty('run_id', queued.run_id);
    expect((await row(queued.run_id)).status).toBe('cancelled');
    await policy('approval');
    const gated = await execute(true, 'synthetic-gated-request');
    await policy('deny');
    expect(await manageOperations({ action: 'approve', run_id: gated.run_id }, {} as Env, ctx)).toHaveProperty('error');
    expect((await row(gated.run_id)).status).toBe('cancelled');
    expect(await poll()).not.toHaveProperty('run_id', gated.run_id);
  });

  it('retains background intent when a claim-time policy change parks the run for human approval', async () => {
    const queued = await execute();
    await policy('approval');
    expect(await poll()).not.toHaveProperty('run_id', queued.run_id);
    expect(await row(queued.run_id)).toMatchObject({ status: 'pending', approval_status: 'pending', expires_at: null, run_metadata: { background: true } });
    await getTestDb()`UPDATE runs SET created_at = now() - interval '1 day' WHERE id = ${queued.run_id}`;
    await reapStaleRuns();
    expect(await manageOperations({ action: 'approve', run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ approved: true });
    expect((await row(queued.run_id)).approval_budget).toBe(600);
    expect(await poll()).toMatchObject({ run_id: queued.run_id });
  });

  it('preserves a page activation deadline through approval and its existing post-activation claim clock', async () => {
    const sql = getTestDb();
    await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${connectionId}`;
    await policy('approval');
    const queued = await manageOperations({ action: 'execute', connection_id: connectionId,
      operation_key: 'echo', input: {}, activation: { kind: 'page_visit', urls: ['https://example.test/draft'], expires_in_seconds: 3600 },
    }, {} as Env, ctx) as { run_id: number; status: string };
    expect(queued.status).toBe('pending_approval');
    const parked = await row(queued.run_id);
    expect(parked.creation_budget).toBe(3600);
    expect(await manageOperations({ action: 'approve', run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ approved: true });
    expect((await row(queued.run_id)).expires_at).toEqual(parked.expires_at);
    await sql`UPDATE runs SET created_at = now() - interval '10 minutes', run_at = now() - interval '10 minutes' WHERE id = ${queued.run_id}`;
    await reapStaleRuns();
    expect((await row(queued.run_id)).status).toBe('pending');
    await sql`UPDATE runs SET activated_at = now() - interval '3 minutes', activated_by_device_worker_id = ${selectedDeviceId}::uuid, activation_tab_id = 17 WHERE id = ${queued.run_id}`;
    await reapStaleRuns();
    expect((await row(queued.run_id)).status).toBe('timeout');
  });

  it.each([false, true])('uses heartbeat liveness after claim, independently of queue expiry (approved=%s)', async approved => {
    if (approved) await policy('approval');
    const queued = await execute();
    if (approved) expect(await manageOperations({ action: 'approve', run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ approved: true });
    expect(await poll()).toMatchObject({ run_id: queued.run_id });
    const sql = getTestDb();
    await sql`UPDATE runs SET expires_at = now() - interval '1 second' WHERE id = ${queued.run_id}`;
    await reapStaleRuns();
    expect((await row(queued.run_id)).status).toBe('running');
    await sql`UPDATE runs SET last_heartbeat_at = now() - interval '3 minutes', expires_at = now() + interval '5 minutes' WHERE id = ${queued.run_id}`;
    await reapStaleRuns();
    expect(await row(queued.run_id)).toMatchObject({ status: 'timeout', error_message: 'worker_heartbeat_lost' });
  });
});
