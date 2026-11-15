import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceInboxConnector from '@lobu/connectors/workspace-inbox';
import WebhookConnector from '@lobu/connectors/webhook';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { CONNECTOR_HTTP_AUTH_CAPABILITY } from '@lobu/core/contracts/worker/protocol';
import type { Env } from '../../../index';
import type { StoredConnection } from '@lobu/core';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestConnection, createTestConnectorDefinition, seedOwnerContext } from '../../setup/test-fixtures';
import triageFeedback from '../../../../../../examples/lobu-team/feedback-triage.reaction';
import teamConfig from '../../../../../../examples/lobu-team/lobu.config';
import type { ReactionClient, ReactionContext } from '@lobu/connector-sdk';

const URL = 'https://inbox.example.com/lobu/api/v1/webhooks/product-feedback';
const TOKEN = 'synthetic-feedback-token-0123456789abcdef';
const connector = new WorkspaceInboxConnector();
const transport = vi.fn();
let compiled: string;
let sdkModule: typeof import('../../../sandbox/client-sdk');
let profiles: typeof import('../../../utils/auth-profiles');
let operations: typeof import('../../../tools/admin/manage_operations');
let webhooks: typeof import('../../../gateway/connections/webhook-ingest');
let automations: typeof import('../../../tools/admin/manage_automations');
let app: typeof import('../../../index').app;
let policies: typeof import('../../../authz/entity-policy');

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('@lobu/connector-worker/egress', async (original) => ({
    ...await original<object>(), fetchCredentialedPublicUrl: transport,
  }));
  sdkModule = await import('../../../sandbox/client-sdk');
  profiles = await import('../../../utils/auth-profiles');
  operations = await import('../../../tools/admin/manage_operations');
  webhooks = await import('../../../gateway/connections/webhook-ingest');
  automations = await import('../../../tools/admin/manage_automations');
  ({ app } = await import('../../../index'));
  policies = await import('../../../authz/entity-policy');
  await (await import('../../../workspace')).initWorkspaceProvider();
  compiled = await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(
    fileURLToPath(new globalThis.URL('../../../../../connectors/src/workspace-inbox.ts', import.meta.url))
  );
}, 120000);
beforeEach(async () => { await cleanupTestDatabase(); transport.mockReset(); });
afterAll(async () => {
  vi.doUnmock('@lobu/connector-worker/egress');
  vi.resetModules();
  await cleanupTestDatabase();
});

async function finishApproved(runId: number) {
  const workerId = 'synthetic-feedback-worker';
  const workerToken = 'synthetic-feedback-fleet-token';
  const post = async (path: string, body: unknown) => {
    const response = await app.fetch(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { WORKER_API_TOKEN: workerToken, ENVIRONMENT: 'test' } as Env);
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  };
  const job = await post('/api/workers/poll', { worker_id: workerId, capabilities: { [CONNECTOR_HTTP_AUTH_CAPABILITY]: true } });
  expect(job.run_id).toBe(runId);
  expect(job.http_auth).toBe(true);
  expect(JSON.stringify(job)).not.toContain(TOKEN);
  let executed;
  try {
    executed = await executeCompiledConnector({
      compiledCode: job.compiled_code,
      job: { mode: 'action', actionKey: job.action_key, actionInput: job.action_input, config: job.config ?? {},
        env: {}, credentials: job.credentials, httpAuth: job.http_auth },
      hooks: { onHttpFetch: (request) => post('/api/workers/http-fetch', { worker_id: workerId, run_id: runId, request }) },
    });
  } catch (error) {
    await post('/api/workers/complete-action', { run_id: runId, worker_id: workerId, status: 'failure',
      error_message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  expect(executed.mode, JSON.stringify(executed)).toBe('action');
  if (executed.mode !== 'action') throw new Error('Expected successful action');
  expect(executed.output).toMatchObject({ status: 'received', receipt: expect.any(String) });
  await post('/api/workers/complete-action', { run_id: runId, worker_id: workerId, status: 'success', action_output: executed.output });
}

async function fixture() {
  const sender = await seedOwnerContext({ orgName: 'Synthetic sending workspace' });
  const receiver = await seedOwnerContext({ orgName: 'Synthetic receiving workspace' });
  const sql = getTestDb();
  const declaration = connector.definition;
  await createTestConnectorDefinition({ key: declaration.key, name: declaration.name,
    auth_schema: declaration.authSchema, feeds_schema: {}, organization_id: sender.org.id });
  const action = declaration.actions!.send_message!;
  await sql`UPDATE connector_definitions SET supports_execute = true, actions_schema = ${sql.json({
    send_message: { ...action, input_schema: action.inputSchema },
  })} WHERE key = ${declaration.key}`;
  await sql`UPDATE connector_versions SET compiled_code = ${compiled} WHERE connector_key = ${declaration.key}`;
  await createTestConnectorDefinition({ key: 'webhook', name: 'Inbound webhook', feeds_schema: {}, organization_id: receiver.org.id,
    automation_events: new WebhookConnector().definition.automationEvents as Array<Record<string, unknown>> });
  const inbox = await createTestConnection({ organization_id: receiver.org.id, connector_key: 'webhook',
    slug: 'product-feedback-inbox', created_by: receiver.user.id, createDefaultFeed: false });
  const sending = await createTestConnection({ organization_id: sender.org.id, connector_key: declaration.key,
    created_by: sender.user.id, config: { inbox_url: URL }, createDefaultFeed: false });
  const profile = await profiles.createAuthProfile({
    organizationId: sender.org.id, connectorKey: declaration.key, displayName: 'Synthetic inbox grant', profileKind: 'env',
    authData: { AUTHORIZATION: `Bearer ${TOKEN}` },
    http: { origin: 'https://inbox.example.com', headers: { authorization: 'AUTHORIZATION' } },
    createdBy: sender.user.id, status: 'active',
  });
  await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${sending.id}`;
  const agent = await createTestAgent({ organizationId: receiver.org.id, ownerUserId: receiver.user.id });
  const created = await automations.manageAutomations({
    action: 'create', name: 'Synthetic feedback triage', slug: 'synthetic-feedback-triage',
    managed_agent_id: agent.agentId,
    prompt: 'Triage received reports.',
    triggers: [{ kind: 'event', source: 'connector', connector_key: 'webhook',
      connection_id: inbox.id, event_types: ['delivery.received'], execution: 'window', active_run: 'queue', output: 'silent' }],
  }, {} as Env, receiver.ctx);
  if (!('automation_id' in created)) throw new Error(JSON.stringify(created));
  const automationId = Number(created.automation_id);
  transport.mockImplementation(async (url: globalThis.URL | string, init: RequestInit) => {
    if (String(url) !== URL) throw new Error('Unexpected outbound destination');
    return webhooks.handleWebhookIngest({
      id: 'product-feedback', platform: 'webhook', organizationId: receiver.org.id, agentId: agent.agentId,
      config: { platform: 'webhook', token: TOKEN, semanticType: 'product.feedback', titlePath: '/subject' },
      settings: {}, metadata: {}, status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
    } as StoredConnection, new Request(String(url), init), { get: async () => null } as never,
    undefined, { activateGenericAutomationEvent: true, automationConnectionId: inbox.id });
  });
  const mcp = { ...sender.ctx, clientId: 'synthetic-feedback-client' };
  const sdk = sdkModule.buildClientSDK(mcp, {} as Env);
  const receiverSdk = sdkModule.buildClientSDK(receiver.ctx, {} as Env);
  for (const key of ['task', 'issue']) {
    const entity = teamConfig.entities!.find((type) => type.key === key)!;
    await receiverSdk.entitySchema.createType({ slug: key, name: key, metadata_schema: { type: 'object', properties: entity.properties } });
  }
  return { sender, receiver, sdk, receiverSdk, inbox, sending, automationId, sql };
}

const message = { subject: 'Source sync fails', body: 'Expected a successful sync; received a failure after authorization.', references: ['https://example.com/reproduction'] };

describe('workspace feedback inbox composition', () => {
  it('honors Block and rejects oversized input without creating a delivery', async () => {
    const f = await fixture();
    await expect(f.sdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message',
      input: { ...message, body: 'x'.repeat(12001) } })).rejects.toThrow();
    await policies.upsertEntityApprovalPolicy(f.sender.org.id, {
      resourceClass: 'connector_action', connectionId: f.sending.id,
      operationKey: 'workspace-inbox::send_message', effects: { execute: 'deny' },
    });
    await expect(f.sdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message', input: message })).rejects.toThrow();
    expect(await f.sql`SELECT id FROM runs WHERE organization_id = ${f.sender.org.id} AND run_type = 'action'`).toHaveLength(0);
    expect(await f.sql`SELECT id FROM events WHERE connection_id = ${f.inbox.id}`).toHaveLength(0);
  });

  it.each(['private destination', 'HTTP destination', 'unauthorized', 'invalid receipt', 'oversized receipt', 'network error'])(
    'fails closed for %s without exposing upstream diagnostics', async (failure) => {
      const f = await fixture();
      if (failure.endsWith('destination')) {
        const url = failure === 'private destination'
          ? 'https://127.0.0.1/lobu/api/v1/webhooks/feedback'
          : 'http://inbox.example.com/lobu/api/v1/webhooks/feedback';
        await f.sql`UPDATE connections SET config = ${f.sql.json({ inbox_url: url })} WHERE id = ${f.sending.id}`;
      } else {
        transport.mockImplementation(async () => {
          if (failure === 'network error') throw new Error(`Upstream detail ${TOKEN}`);
          return new Response(failure === 'oversized receipt' ? 'x'.repeat(1025)
            : failure === 'invalid receipt' ? JSON.stringify({ ok: true, id: -1 }) : TOKEN,
          { status: failure === 'unauthorized' ? 401 : 202 });
        });
      }
      const pending = await f.sdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message', input: message }) as { run_id: number };
      await operations.manageOperations({ action: 'approve', run_id: pending.run_id }, {} as Env, f.sender.ctx);
      await expect(finishApproved(pending.run_id)).rejects.toThrow();
      const run = await f.sdk.operations.getRun(pending.run_id);
      expect(run).toMatchObject({ run: { status: 'failed' } });
      expect(JSON.stringify(run)).not.toContain(TOKEN);
      expect(await f.sql`SELECT id FROM events WHERE connection_id = ${f.inbox.id}`).toHaveLength(0);
    }
  );

  it('waits for a human, delivers through the isolated connector, activates triage, and replays one receipt', async () => {
    const f = await fixture();
    const discovery = await f.sdk.operations.listAvailable({ connector_key: 'workspace-inbox' });
    expect(JSON.stringify(discovery)).not.toContain(TOKEN);
    const pending = await f.sdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message', input: message, idempotency_key: 'synthetic-report-one' }) as { run_id: number; status: string };
    expect(pending).toMatchObject({ status: 'pending_approval' });
    if (!('run_id' in pending)) throw new Error('Missing pending run');
    expect(await f.sql`SELECT id FROM events WHERE connection_id = ${f.inbox.id}`).toHaveLength(0);
    expect(await operations.manageOperations({ action: 'approve', run_id: pending.run_id }, {} as Env,
      { ...f.sender.ctx, clientId: 'synthetic-feedback-client' })).toMatchObject({ error: expect.any(String) });
    expect(await f.sql`SELECT id FROM events WHERE connection_id = ${f.inbox.id}`).toHaveLength(0);
    const approved = await operations.manageOperations({ action: 'approve', run_id: pending.run_id }, {} as Env, f.sender.ctx);
    expect(approved).toMatchObject({ approved: true });
    await finishApproved(pending.run_id);
    const run = await f.sdk.operations.getRun(pending.run_id);
    const [received] = await f.sql`SELECT id, payload_data, origin_id FROM events WHERE connection_id = ${f.inbox.id}`;
    expect(received.payload_data).toEqual(message);
    expect(JSON.stringify(run)).toContain('received');
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
    const replay = await f.sdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message', input: message, idempotency_key: 'synthetic-report-one' });
    expect(replay).toMatchObject({ run_id: pending.run_id });
    // A fresh approved run delivering identical bytes is also deduped at intake.
    const second = await f.sdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message', input: message, idempotency_key: 'synthetic-report-retry' }) as { run_id: number };
    if (!('run_id' in second)) throw new Error('Missing second run');
    await operations.manageOperations({ action: 'approve', run_id: second.run_id }, {} as Env, f.sender.ctx);
    await finishApproved(second.run_id);
    expect(await f.sql`SELECT id FROM events WHERE connection_id = ${f.inbox.id}`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
    await expect(f.sdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message', input: { ...message, inbox_url: 'https://other.example.com' } })).rejects.toThrow();
    await expect(f.receiverSdk.operations.execute({ connection_id: f.sending.id, operation_key: 'send_message', input: message })).rejects.toThrow();
  });

  it('attaches user evidence to existing issues and creates only one task across reaction retries', async () => {
    const f = await fixture();
    const response = await transport(URL, { method: 'POST', body: JSON.stringify(message), headers: { authorization: `Bearer ${TOKEN}` } });
    const receipt = await response.json();
    const issue = await f.receiverSdk.entities.create({ entity_type: 'issue', name: 'Synthetic production error', slug: 'synthetic-issue',
      metadata: { fingerprint: '0123456789abcdef0123456789abcdef', status: 'ongoing', kind: 'system', seen_24h: 17 } });
    if (!issue.entity) throw new Error('Missing issue');
    const [run] = await f.sql`SELECT id, approved_input FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`;
    const context = {
      extracted_data: { reports: [{ report_id: receipt.id, summary: 'A user reports that the authorized source sync fails. Reproduction remains pending.', kind: 'bug', issue_id: issue.entity.id }] },
      window: { automation_id: f.automationId, run_id: Number(run.id), window_start: new Date(Date.now() - 60000).toISOString(), window_end: new Date(Date.now() + 60000).toISOString() },
    } as ReactionContext;
    const client = f.receiverSdk as unknown as ReactionClient;
    const first = await triageFeedback(context, client);
    expect(await triageFeedback(context, client)).toEqual(first);
    const alerts = await f.receiverSdk.notifications.list({ limit: 50 });
    expect(alerts.notifications).toHaveLength(1);
    const tasks = await f.sql`SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.entity_type_id WHERE e.organization_id = ${f.receiver.org.id} AND t.slug = 'task'`;
    expect(tasks).toHaveLength(1);
    const evidence = await f.sql`SELECT ${issue.entity.id}::bigint = ANY(entity_ids) AS linked_issue, payload_data FROM events WHERE organization_id = ${f.receiver.org.id} AND metadata ? '_lobu_idempotency_key' AND metadata->>'_lobu_idempotency_key' LIKE 'feedback-triage:%'`;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].payload_data).toMatchObject({ report_id: receipt.id, verification: 'user_reported' });
    expect(evidence[0].linked_issue).toBe(true);
    const [unchanged] = await f.sql`SELECT metadata FROM entities WHERE id = ${issue.entity.id}`;
    expect(unchanged.metadata).toMatchObject({ seen_24h: 17, status: 'ongoing' });
    const outside = { ...context, extracted_data: { reports: [{ report_id: receipt.id + 1000000, summary: 'Outside report', kind: 'bug' }] } } as ReactionContext;
    await expect(triageFeedback(outside, client)).rejects.toThrow('in this inbox');
    await expect(triageFeedback({ ...context, extracted_data: { reports: [] } }, client)).rejects.toThrow('every report');
    const wrongIssue = { ...context, extracted_data: { reports: [{ report_id: receipt.id, summary: 'Reported failure', kind: 'bug', issue_id: tasks[0].id }] } } as ReactionContext;
    // An already persisted decision is replayed instead of rematched.
    expect(await triageFeedback(wrongIssue, client)).toEqual(first);
  });
});
