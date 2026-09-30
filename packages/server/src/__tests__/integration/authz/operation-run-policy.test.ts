import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRunConnectorPolicyAtClaim,
  CONNECTOR_PARENT_RUN_METADATA_KEY,
  resolveRunConnectorPolicy,
} from '../../../authz/operation-run-policy';
import type { Env } from '../../../index';
import { getOperationForConnection } from '../../../operations/connector-operations';
import { DEVICE_FEED_READ_ACTION_KEY } from '../../../lib/device-feed-read-protocol';
import { __setChatInstanceManagerForTests } from '../../../lobu/gateway';
import { deliverNotificationTask } from '../../../notifications/service';
import { createConnectorOperationRun } from '../../../runs/queue-service';
import { NOTIFICATION_DELIVERY_TASK } from '../../../scheduled/task-definitions';
import { waitForDeviceActionRunWithOptions } from '../../../tools/admin/device-action-wait';
import { executeOperationInline, handleExecute } from '../../../tools/admin/manage_operations/handlers/execute';
import { qualifiedOperationKey } from '../../../tools/admin/manage_operations/handlers/shared';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import { activatePageRun } from '../../../worker-api/page-activation';
import { pollWorkerJob } from '../../../worker-api/poll';
import { initWorkspaceProvider } from '../../../workspace';
import { createTestAutomationSubscription } from '../../setup/automation-subscriptions';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization, createTestAgent, createTestConnection, createTestConnectorDefinition,
  createTestOrganization, createTestUser, insertChatConnectionRow,
} from '../../setup/test-fixtures';

const sql = getTestDb();
const connectorKey = 'policy-dispatch-fixture';
let organizationId: string;
let connectionId: number;
let ownerId: string;

async function approvalNotifications() {
  return sql`SELECT e.id, e.metadata, e.payload_data FROM events e
    JOIN notification_targets t ON t.event_id = e.id
    WHERE e.organization_id = ${organizationId} AND t.user_id = ${ownerId}
      AND e.metadata->>'notification_type' = 'action_approval_needed'`;
}

async function rule(effect: 'auto' | 'approval' | 'deny', operationKey = 'perform', principalId: string | null = null) {
  const [policy] = await sql<{ id: number }>`
    INSERT INTO write_approval_policies (organization_id, resource_class, principal_kind, principal_id, operation_key)
    VALUES (${organizationId}, 'connector_action', ${principalId ? 'agent' : null}, ${principalId},
      ${qualifiedOperationKey(connectorKey, operationKey)}) RETURNING id
  `;
  await sql`INSERT INTO write_policy_action_effects (policy_id, action, effect) VALUES (${policy.id}, 'execute', ${effect})`;
  return Number(policy.id);
}

async function run(options: {
  status?: string; approval?: string; operation?: string; parent?: number;
  metadata?: Record<string, unknown>; principalKind?: string | null; principalId?: string | null;
  runType?: string; claimedBy?: string | null;
} = {}) {
  const [row] = await sql<{ id: number }>`
    INSERT INTO runs (organization_id, run_type, connection_id, connector_key, connector_version,
      action_key, action_input, status, approval_status, parent_run_id, run_metadata,
      policy_principal_kind, policy_principal_id, claimed_by)
    VALUES (${organizationId}, ${options.runType ?? 'action'}, ${connectionId}, ${connectorKey}, '1.0.0',
      ${options.operation ?? 'perform'}, '{}'::jsonb, ${options.status ?? 'pending'}, ${options.approval ?? 'auto'},
      ${options.parent ?? null}, ${sql.json(options.metadata ?? {})},
      ${options.principalKind === undefined ? 'user' : options.principalKind}, ${options.principalId ?? null}, ${options.claimedBy ?? null})
    RETURNING id
  `;
  return Number(row.id);
}

const decision = (runId: number) => resolveRunConnectorPolicy({ organizationId, runId });
const admit = (runId: number, claimedBy?: string) => sql.begin(tx =>
  applyRunConnectorPolicyAtClaim({ organizationId, runId, claimedBy, sql: tx }));

async function state(runId: number) {
  const [row] = await sql`SELECT status, approval_status, claimed_by, expires_at FROM runs WHERE id = ${runId}`;
  return row;
}

describe('operation policy at durable dispatch', () => {
  beforeAll(initWorkspaceProvider);
  beforeEach(async () => {
    await cleanupTestDatabase();
    organizationId = (await createTestOrganization()).id;
    ownerId = (await createTestUser()).id;
    await addUserToOrganization(ownerId, organizationId, 'owner');
    await createTestConnectorDefinition({ key: connectorKey, name: 'Policy dispatch fixture', organization_id: organizationId });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      perform: { name: 'Perform', kind: 'write' },
      scroll: { name: 'Scroll', kind: 'write' },
    })} WHERE organization_id = ${organizationId} AND key = ${connectorKey}`;
    connectionId = (await createTestConnection({ organization_id: organizationId, connector_key: connectorKey, createDefaultFeed: false })).id;
  });
  afterAll(cleanupTestDatabase);
  afterEach(() => __setChatInstanceManagerForTests(null));

  it('parks a queued Auto after policy tightens, superseding its ledger card without deleting history', async () => {
    const id = await run();
    const original = await insertEvent({
      entityIds: [], organizationId, runId: id, originId: 'policy-dispatch-auto',
      title: 'Dispatched', content: 'Dispatched', semanticType: 'operation',
      interactionType: 'approval', interactionStatus: 'approved',
    });
    await rule('approval');
    expect(await admit(id)).toBe(false);
    expect(await state(id)).toMatchObject({ status: 'pending', approval_status: 'pending', claimed_by: null, expires_at: null });
    const [current] = await sql`SELECT id, interaction_status, metadata FROM current_event_records WHERE run_id = ${id}`;
    expect(Number(current.id)).not.toBe(Number(original.id));
    expect(current.interaction_status).toBe('pending');
    expect(current.metadata.approval_context.kind).toBe('connector');
    expect(await sql`SELECT id FROM events WHERE id = ${original.id}`).toHaveLength(1);
    const notifications = await approvalNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].metadata).toMatchObject({
      resource_id: String(current.id),
      delivery_request: { context: { decisionRunId: id, deliveryScope: 'targeted' } },
    });
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${organizationId}
      AND action_key = ${NOTIFICATION_DELIVERY_TASK}
      AND action_input->'payload'->>'eventId' = ${String(notifications[0].id)}`).toHaveLength(1);
  });

  it('concurrent and repeated claims create only one late approval notification', async () => {
    const id = await run();
    expect(await Promise.all([admit(id), admit(id)])).toEqual([false, false]);
    expect(await admit(id)).toBe(false);
    expect(await approvalNotifications()).toHaveLength(1);
  });

  it('rolls back the parked run and its card if notification persistence fails', async () => {
    const id = await run();
    await sql.unsafe(`CREATE FUNCTION fail_late_approval_notification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic late approval notification failure'; END $$;
      CREATE TRIGGER fail_late_approval_notification BEFORE INSERT ON notification_targets
      FOR EACH ROW EXECUTE FUNCTION fail_late_approval_notification();`);
    try {
      await expect(admit(id)).rejects.toThrow('synthetic late approval notification failure');
      expect(await state(id)).toMatchObject({ status: 'pending', approval_status: 'auto' });
      expect(await sql`SELECT id FROM events WHERE run_id = ${id}`).toHaveLength(0);
      expect(await approvalNotifications()).toHaveLength(0);
    } finally {
      await sql.unsafe(`DROP TRIGGER fail_late_approval_notification ON notification_targets;
        DROP FUNCTION fail_late_approval_notification();`);
    }
    expect(await admit(id)).toBe(false);
    expect(await approvalNotifications()).toHaveLength(1);
  });

  it('preserves the verified conversation and destructive review details when an Auto becomes Ask', async () => {
    const agent = await createTestAgent({ organizationId, agentId: 'late-approval-agent', ownerUserId: ownerId });
    await insertChatConnectionRow({
      id: 'late-approval-chat', organizationId, agentId: agent.agentId,
      platform: 'slack', status: 'active', settings: {},
    });
    await createTestAutomationSubscription({
      organizationId, agentId: agent.agentId, connectionSlug: 'agentconn-late-approval-chat',
      platform: 'slack', channelId: 'slack:C_LATE', teamId: 'T_LATE', configuredBy: ownerId,
    });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      perform: { name: 'Perform', kind: 'write', annotations: { destructiveHint: true } },
    })} WHERE organization_id = ${organizationId} AND key = ${connectorKey}`;
    const policyId = await rule('auto');
    const queued = await handleExecute({
      action: 'execute', connection_id: connectionId, operation_key: 'perform',
      input: { text: 'Synthetic draft', api_key: 'synthetic-secret' },
      activation: { kind: 'page_visit', urls: ['https://example.test/draft'], expires_in_seconds: 300 },
    }, {
      organizationId, userId: ownerId, agentId: agent.agentId, memberRole: 'owner',
      isAuthenticated: true, tokenType: 'session', scopedToOrg: true,
      baseUrl: 'https://gateway.example.test/lobu',
      sourceContext: {
        platform: 'slack', connectionId: 'late-approval-chat', channelId: 'slack:C_LATE',
        conversationId: 'slack:C_LATE', teamId: 'T_LATE', userId: 'U_LATE',
      },
    } as ToolContext, {} as Env) as { run_id: number; status: string };
    expect(queued.status).toBe('in_progress');
    expect(await approvalNotifications()).toHaveLength(0);
    await sql`UPDATE write_policy_action_effects SET effect = 'approval' WHERE policy_id = ${policyId}`;
    expect(await admit(queued.run_id)).toBe(false);
    const [notification] = await approvalNotifications();
    expect(notification.metadata.delivery_request).toMatchObject({
      context: {
        connectionId: 'late-approval-chat', channelId: 'slack:C_LATE', teamId: 'T_LATE',
        ownerUserId: null, actionOrigin: { kind: 'conversation' },
      },
      targets: [{ connectionId: 'late-approval-chat', channelKey: 'slack:C_LATE', platform: 'slack' }],
    });
    const [card] = await sql`SELECT metadata FROM current_event_records
      WHERE run_id = ${queued.run_id} AND semantic_type = 'operation'`;
    expect(card.metadata.approval_context.impact.level).toBe('high');
    expect(card.metadata.review_fields).toEqual(expect.arrayContaining([
      { key: 'operation', value: 'Perform' },
      { key: 'input_text', value: 'Synthetic draft' },
    ]));
    expect(JSON.stringify(card.metadata.review_fields)).not.toContain('synthetic-secret');
    const post = vi.fn(async () => ({ messageId: 'late-approval-message', threadId: 'slack:C_LATE' }));
    __setChatInstanceManagerForTests({ postMessageToChannel: post });
    await deliverNotificationTask({ organizationId, eventId: Number(notification.id) });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.slice(0, 2)).toEqual(['late-approval-chat', 'slack:C_LATE']);
    const [delivered] = await sql`SELECT metadata FROM events WHERE id = ${notification.id}`;
    expect(delivered.metadata.delivery[0].attempts.at(-1).status).toBe('provider_accepted');
  });

  it('the inline executor parks and notifies before invoking its backend', async () => {
    const id = await run({ status: 'running', claimedBy: 'inline-policy-owner' });
    const resolved = await getOperationForConnection(organizationId, connectionId, 'perform');
    expect(resolved).not.toBeNull();
    expect(await executeOperationInline(id, organizationId, resolved!.connection, resolved!.operation,
      {}, ownerId, undefined, { runMetadata: undefined, claimedBy: 'inline-policy-owner' }))
      .toEqual({ status: 'pending_approval' });
    expect(await state(id)).toMatchObject({ approval_status: 'pending', claimed_by: null });
    expect(await approvalNotifications()).toHaveLength(1);
  });

  it('human approval satisfies Ask but a later Block cancels before worker dispatch', async () => {
    const id = await run({ approval: 'approved' });
    const policy = await rule('approval');
    expect(await admit(id)).toBe(true);
    await sql`UPDATE write_policy_action_effects SET effect = 'deny' WHERE policy_id = ${policy}`;
    expect(await admit(id)).toBe(false);
    expect(await state(id)).toMatchObject({ status: 'cancelled', approval_status: 'rejected' });
    const [card] = await sql`SELECT interaction_status FROM current_event_records WHERE run_id = ${id}`;
    expect(card.interaction_status).toBe('rejected');
  });

  it('only the current inline owner may park a run, clearing its lease before approval', async () => {
    const id = await run({ status: 'running', claimedBy: 'inline-owner' });
    expect(await admit(id, 'different-owner')).toBe(false);
    expect(await state(id)).toMatchObject({ status: 'running', claimed_by: 'inline-owner' });
    expect(await admit(id, 'inline-owner')).toBe(false);
    expect(await state(id)).toMatchObject({ status: 'pending', approval_status: 'pending', claimed_by: null });
  });

  it('does not reinterpret an unidentified or deleted requester as a human', async () => {
    await rule('auto');
    expect((await decision(await run({ principalKind: null })))?.effect).toBe('deny');
    await createTestAgent({ organizationId, agentId: 'dispatch-agent' });
    const id = await run({ principalKind: 'agent', principalId: 'dispatch-agent' });
    expect((await decision(id))?.effect).toBe('auto');
    await sql`DELETE FROM agents WHERE id = 'dispatch-agent' AND organization_id = ${organizationId}`;
    expect((await decision(id))?.effect).toBe('deny');
  });

  it('keeps a requesting agent restriction when a human approved its run', async () => {
    await createTestAgent({ organizationId, agentId: 'restricted-dispatch-agent' });
    await rule('auto');
    await rule('deny', 'perform', 'restricted-dispatch-agent');
    const id = await run({ approval: 'approved', principalKind: 'agent', principalId: 'restricted-dispatch-agent' });
    expect(await admit(id)).toBe(false);
    expect((await state(id)).status).toBe('cancelled');
  });

  it('inherits a live parent admission without asking again for every browser step', async () => {
    const parent = await run({ status: 'running' });
    const child = await run({ operation: 'scroll', parent, metadata: { [CONNECTOR_PARENT_RUN_METADATA_KEY]: parent } });
    expect(await decision(parent)).toMatchObject({ effect: 'approval' });
    expect(await decision(child)).toMatchObject({ effect: 'auto', reason: 'parent_approval' });
    expect(await admit(child)).toBe(true);
  });

  it('lets an explicit child Block veto inherited parent approval', async () => {
    await rule('auto');
    await rule('deny', 'scroll');
    const parent = await run({ status: 'running' });
    const child = await run({ operation: 'scroll', parent, metadata: { [CONNECTOR_PARENT_RUN_METADATA_KEY]: parent } });
    expect(await admit(child)).toBe(false);
    expect((await state(child)).status).toBe('cancelled');
  });

  it('rechecks parent Block and liveness before admitting a child', async () => {
    const policy = await rule('deny');
    await rule('auto', 'scroll');
    const parent = await run({ status: 'running' });
    const child = await run({ operation: 'scroll', parent, metadata: { [CONNECTOR_PARENT_RUN_METADATA_KEY]: parent } });
    expect((await decision(child))?.effect).toBe('deny');
    await sql`UPDATE write_policy_action_effects SET effect = 'auto' WHERE policy_id = ${policy}`;
    expect((await decision(child))?.effect).toBe('auto');
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${parent}`;
    expect((await decision(child))?.effect).toBe('deny');
  });

  it('does not turn ordinary causal parent links into inherited approval', async () => {
    const parent = await run({ status: 'running' });
    const ordinary = await run({ operation: 'scroll', parent });
    expect((await decision(ordinary))?.effect).toBe('approval');
    const malformed = await run({ operation: 'scroll', parent, metadata: { [CONNECTOR_PARENT_RUN_METADATA_KEY]: parent + 1 } });
    expect((await decision(malformed))?.effect).toBe('deny');
    const wrongPrincipal = await run({ operation: 'scroll', parent, principalKind: 'agent', metadata: { [CONNECTOR_PARENT_RUN_METADATA_KEY]: parent } });
    expect((await decision(wrongPrincipal))?.effect).toBe('deny');
  });

  it('retains collection authorization for sync children and exempts reserved feed transport only', async () => {
    const parent = await run({ runType: 'sync', status: 'running', principalKind: null });
    const child = await run({ operation: 'scroll', parent, principalKind: 'agent', metadata: { [CONNECTOR_PARENT_RUN_METADATA_KEY]: parent } });
    expect((await decision(child))?.effect).toBe('auto');
    expect(await decision(await run({ operation: DEVICE_FEED_READ_ACTION_KEY, principalKind: null }))).toBeNull();
    expect((await decision(await run({ operation: 'missing-public-operation' })))?.effect).toBe('deny');
  });

  it('does not exempt a public custom action that reuses the reserved feed transport name', async () => {
    await sql`UPDATE connector_definitions SET actions_schema = actions_schema || ${sql.json({
      [DEVICE_FEED_READ_ACTION_KEY]: { name: 'Custom public action', kind: 'write' },
    })}::jsonb WHERE organization_id = ${organizationId} AND key = ${connectorKey}`;
    await rule('deny', DEVICE_FEED_READ_ACTION_KEY);
    expect((await decision(await run({ operation: DEVICE_FEED_READ_ACTION_KEY })))?.effect).toBe('deny');
  });

  it('the actual worker poll parks a stale Auto and never returns its execution envelope', async () => {
    const id = await run();
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('workerAuthMode', 'trusted');
      c.set('workerUserId', null);
      c.set('workerOrgIds', null);
      await next();
    });
    app.post('/poll', pollWorkerJob);
    const poll = () => app.request('/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'policy-dispatch-worker', capabilities: {}, wait_seconds: 0 }),
    }, {} as Env);
    const response = await poll();
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('run_id');
    expect(await state(id)).toMatchObject({ status: 'pending', approval_status: 'pending' });
    expect(await approvalNotifications()).toHaveLength(1);
    await sql`UPDATE runs SET approval_status = 'approved' WHERE id = ${id}`;
    const approved = await poll();
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ run_id: id, run_type: 'action' });
    expect(await state(id)).toMatchObject({ status: 'running', approval_status: 'approved', claimed_by: 'policy-dispatch-worker' });
  });

  it('returns pending approval to the device waiter even after its caller aborts', async () => {
    const id = await run({ approval: 'pending' });
    const controller = new AbortController();
    controller.abort();
    expect(await waitForDeviceActionRunWithOptions(id, organizationId, {
      queueMs: 0, postClaimMs: 0, pollMs: 0, abortSignal: controller.signal,
    })).toEqual({ status: 'pending_approval' });
    expect((await state(id)).approval_status).toBe('pending');
  });

  it('hands a newly parked approval back instead of applying the device deadline', async () => {
    const id = await run();
    let time = 0;
    expect(await waitForDeviceActionRunWithOptions(id, organizationId, {
      queueMs: 1, postClaimMs: 1, pollMs: 0,
      now: () => time,
      sleep: async () => {
        await admit(id);
        time = 2;
      },
    })).toEqual({ status: 'pending_approval' });
    expect(await state(id)).toMatchObject({ status: 'pending', approval_status: 'pending' });
  });

  it('allows Ask and page activation together, requiring approval before the exact owner page visit', async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const workerId = 'policy-activation-owner';
    await sql`INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, app_version)
      VALUES (${user.id}, ${workerId}, 'chrome-extension', '[]'::jsonb, ${organizationId}, '0.6.1')`;
    const queued = await createConnectorOperationRun({
      organizationId, connectionId, connectorKey, operationKey: 'perform', operationInput: {},
      approvalMode: 'queued', policyPrincipalKind: 'user', createdByUserId: user.id,
      activation: { kind: 'page_visit', urls: ['https://example.test/item?id=123'], expiresInSeconds: 300 },
    });
    const app = new Hono<{ Bindings: Env }>();
    let caller = user.id;
    app.use('*', async (c, next) => {
      c.set('workerAuthMode', 'user'); c.set('workerUserId', caller); c.set('workerOrgIds', [organizationId]);
      await next();
    });
    app.post('/activate', activatePageRun);
    const activate = (url = 'https://example.test/item?id=123') => app.request('/activate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: workerId, run_id: queued.runId, tab_id: 17, url }),
    });
    expect(await (await activate()).json()).toEqual({ status: 'unavailable' });
    await sql`UPDATE runs SET approval_status = 'approved' WHERE id = ${queued.runId}`;
    expect(await (await activate('https://example.test/item?id=456')).json()).toEqual({ status: 'unavailable' });
    caller = other.id;
    expect((await activate()).status).toBe(403);
    caller = user.id;
    expect(await (await activate()).json()).toEqual({ status: 'activated' });
    const [activated] = await sql`SELECT status, approval_status, activation_tab_id FROM runs WHERE id = ${queued.runId}`;
    expect(activated).toMatchObject({ status: 'pending', approval_status: 'approved', activation_tab_id: 17 });
  });
});
