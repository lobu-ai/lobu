/**
 * A write tool call an agent turn repeats for the same input message runs once.
 *
 * Driven through the production turn mint and the embedded MCP lane: the
 * signed turn credential is the only thing that marks a call as
 * turn-originated, and the dedupe key is derived from the stored `agent_turn`
 * row it names. A re-run of the same input mints a NEW run (new run id, new
 * credential) for the SAME message, which is the case these tests model.
 */

import { mintGatewayMcpToken, type MessagePayload } from '@lobu/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { mintTurnToken } from '../../../gateway/orchestration/agent-turn-producer';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestPAT,
  createTestUser,
  insertChatConnectionRow,
  linkChatIdentityInGraph,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'turn-write-dedupe-agent';
const TEAM_ID = 'T0TURNWRITE';
const OWNER_PLATFORM_ID = 'U0TURNOWNER';
const COWORKER_PLATFORM_ID = 'U0TURNCOWORKER';
const ADMIN_PLATFORM_ID = 'U0TURNADMIN';
const CONNECTOR = 'demo.device.turn_write_dedupe';
const CONVERSATION_ID = 'slack:C0TURNWRITE:1787292000.000901';
const DIRECT_AUTH = { 'X-Lobu-Memory-Direct-Auth': '1' };

interface Evidence {
  isDirect?: boolean;
  senderVouched?: boolean;
}

function slackChatMessage(organizationId: string, sender: string, messageId: string, evidence: Evidence): MessagePayload {
  return {
    userId: sender,
    conversationId: CONVERSATION_ID,
    messageId,
    channelId: 'slack:C0TURNWRITE',
    teamId: `slack:${TEAM_ID}`,
    agentId: AGENT_ID,
    organizationId,
    botId: 'slack',
    platform: 'slack',
    messageText: 'run it on the laptop',
    platformMetadata: {
      connectionId: 'slackinst-turn-write-dedupe',
      teamId: TEAM_ID,
      senderId: sender,
      responseThreadId: CONVERSATION_ID,
      ...(evidence.isDirect !== undefined ? { isDirect: evidence.isDirect } : {}),
      ...(evidence.senderVouched ? { senderVouched: true } : {}),
    },
    agentOptions: {},
  } as MessagePayload;
}

/** One stored agent turn for `messageId` plus the gateway-hop credential minted for it. */
async function turnFor(organizationId: string, sender: string, messageId: string, evidence: Evidence): Promise<string> {
  const [run] = await getTestDb()<{ id: number }>`
    INSERT INTO runs (organization_id, run_type, status, action_input, created_at)
    VALUES (${organizationId}, 'agent_turn', 'running', ${getTestDb().json({
      turn: { agent_id: AGENT_ID, conversation_id: CONVERSATION_ID, message_id: messageId },
    })}, NOW())
    RETURNING id
  `;
  const token = mintGatewayMcpToken(
    await mintTurnToken(slackChatMessage(organizationId, sender, messageId, evidence), Number(run.id))
  );
  if (!token) throw new Error('turn token did not verify');
  return token;
}

async function openSession(orgSlug: string, token: string, headers: Record<string, string> = DIRECT_AUTH): Promise<string> {
  const init = await post(`/mcp/${orgSlug}`, {
    body: {
      jsonrpc: '2.0', method: 'initialize', id: 0,
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'turn', version: '1.0.0' } },
    },
    token,
    headers,
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id') as string;
  await post(`/mcp/${orgSlug}`, {
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    token,
    headers: { ...headers, 'mcp-session-id': sessionId },
  });
  return sessionId;
}

async function callTool(
  orgSlug: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  options: { sessionId?: string; headers?: Record<string, string> } = {}
): Promise<Record<string, any>> {
  const headers = options.headers ?? DIRECT_AUTH;
  const sessionId = options.sessionId ?? await openSession(orgSlug, token, headers);
  const response = await post(`/mcp/${orgSlug}`, {
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    token,
    headers: { ...headers, 'mcp-session-id': sessionId, 'X-MCP-Format': 'json' },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}');
}

function execute(input: Record<string, unknown>) {
  return { action: 'execute', connection_id: connectionId, operation_key: 'echo', input, background: true };
}

let org: Awaited<ReturnType<typeof createTestOrganization>>;
let connectionId: number;
let adminId: string;

async function actionRuns() {
  return getTestDb()<{ id: number; approval_status: string }>`
    SELECT id, approval_status FROM runs
    WHERE organization_id = ${org.id} AND run_type = 'action' AND connection_id = ${connectionId}
    ORDER BY id
  `;
}

describe('a repeated turn write runs once per input message', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Turn Write Dedupe Org' });
    const admin = await createTestUser({ email: 'turn-write-admin@example.test' });
    const owner = await createTestUser({ email: 'turn-write-owner@example.test' });
    adminId = admin.id;
    await addUserToOrganization(admin.id, org.id, 'owner');
    await addUserToOrganization(owner.id, org.id, 'member');
    await createTestAgent({ organizationId: org.id, agentId: AGENT_ID, ownerUserId: admin.id });
    await linkChatIdentityInGraph({
      organizationId: org.id, userId: owner.id, platform: 'slack', teamId: TEAM_ID, platformUserId: OWNER_PLATFORM_ID,
    });
    await linkChatIdentityInGraph({
      organizationId: org.id, userId: admin.id, platform: 'slack', teamId: TEAM_ID, platformUserId: ADMIN_PLATFORM_ID,
    });

    const sql = getTestDb();
    await createTestConnectorDefinition({
      key: CONNECTOR, name: 'Turn write dedupe fixture', organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      echo: { name: 'Echo', kind: 'write', input_schema: { type: 'object' } },
      inspect: { name: 'Inspect', kind: 'read', input_schema: { type: 'object' } },
    })}, supports_execute = true WHERE organization_id = ${org.id} AND key = ${CONNECTOR}`;
    const [device] = await sql<{ id: string }>`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${owner.id}, 'synthetic-turn-laptop', 'macos', '0.1.0', '[]'::jsonb, 'Owner laptop', ${org.id}, NOW())
      RETURNING id
    `;
    const connection = await createTestConnection({
      organization_id: org.id, connector_key: CONNECTOR, created_by: owner.id, visibility: 'org',
      createDefaultFeed: false,
    });
    connectionId = connection.id;
    await sql`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${connectionId}`;
    await upsertEntityApprovalPolicy(org.id, {
      resourceClass: 'connector_action', connectionId, effects: { execute: 'auto' },
    });
  });

  it('a re-run of the same input message adopts the first operation run', async () => {
    const first = await callTool(org.slug, await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true }),
      'manage_operations', execute({ text: 'hi' }));
    const rerun = await callTool(org.slug, await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true }),
      'manage_operations', execute({ text: 'hi' }));
    expect(first.run_id).toEqual(expect.any(Number));
    expect(rerun.run_id).toBe(first.run_id);
    expect(await actionRuns()).toHaveLength(1);
  });

  it('different arguments in the same input message are two operations', async () => {
    const token = await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true });
    const a = await callTool(org.slug, token, 'manage_operations', execute({ text: 'hi' }));
    const b = await callTool(org.slug, token, 'manage_operations', execute({ text: 'bye' }));
    expect(b.run_id).not.toBe(a.run_id);
    expect(await actionRuns()).toHaveLength(2);
  });

  it('repeated read operations in one input message create fresh runs', async () => {
    const token = await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true });
    const args = { ...execute({}), operation_key: 'inspect' };
    const a = await callTool(org.slug, token, 'manage_operations', args);
    const b = await callTool(org.slug, token, 'manage_operations', args);
    expect(a.run_id).toEqual(expect.any(Number));
    expect(b.run_id).not.toBe(a.run_id);
    expect(await actionRuns()).toHaveLength(2);
  });

  it('the same call for a different input message is a second operation, even on a reused session', async () => {
    const firstToken = await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true });
    const sessionId = await openSession(org.slug, firstToken);
    const a = await callTool(org.slug, firstToken, 'manage_operations', execute({ text: 'hi' }), { sessionId });
    const secondToken = await turnFor(org.id, OWNER_PLATFORM_ID, 'm-2', { isDirect: true });
    const b = await callTool(org.slug, secondToken, 'manage_operations', execute({ text: 'hi' }), { sessionId });
    expect(b.run_id).not.toBe(a.run_id);
    expect(await actionRuns()).toHaveLength(2);
  });

  it('an operation awaiting approval, repeated by a re-run, keeps one approval', async () => {
    const evidence = { isDirect: false, senderVouched: true };
    const first = await callTool(org.slug, await turnFor(org.id, COWORKER_PLATFORM_ID, 'm-1', evidence),
      'manage_operations', execute({ text: 'hi' }));
    const rerun = await callTool(org.slug, await turnFor(org.id, COWORKER_PLATFORM_ID, 'm-1', evidence),
      'manage_operations', execute({ text: 'hi' }));
    expect(first.status).toBe('pending_approval');
    expect(rerun.status).toBe('pending_approval');
    expect(rerun.run_id).toBe(first.run_id);
    const runs = await actionRuns();
    expect(runs).toEqual([expect.objectContaining({ approval_status: 'pending' })]);
    const approvals = await getTestDb()`
      SELECT 1 FROM events
      WHERE organization_id = ${org.id} AND interaction_type = 'approval' AND run_id = ${Number(first.run_id)}
    `;
    expect(approvals).toHaveLength(1);
  });

  it('a model-supplied idempotency_key still wins over the derived one', async () => {
    const a = await callTool(org.slug, await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true }),
      'manage_operations', { ...execute({ text: 'hi' }), idempotency_key: 'caller-a' });
    const b = await callTool(org.slug, await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true }),
      'manage_operations', { ...execute({ text: 'hi' }), idempotency_key: 'caller-b' });
    expect(b.run_id).not.toBe(a.run_id);
    expect(await actionRuns()).toHaveLength(2);
  });

  it('refuses a turn write whose credential names a stored turn for another message', async () => {
    const token = await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true });
    await getTestDb()`
      UPDATE runs SET action_input = jsonb_set(action_input, '{turn,message_id}', '"m-other"')
      WHERE organization_id = ${org.id} AND run_type = 'agent_turn'
    `;
    const sessionId = await openSession(org.slug, token);
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'manage_operations', arguments: execute({ text: 'hi' }) } },
      token,
      headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId, 'X-MCP-Format': 'json' },
    });
    const body = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('does not match this credential');
    expect(await actionRuns()).toHaveLength(0);
  });

  it('a non-turn caller repeating the same call still gets two operations', async () => {
    const pat = await createTestPAT(adminId, org.id);
    const a = await callTool(org.slug, pat.token, 'manage_operations', execute({ text: 'hi' }), { headers: {} });
    const b = await callTool(org.slug, pat.token, 'manage_operations', execute({ text: 'hi' }), { headers: {} });
    expect(b.run_id).not.toBe(a.run_id);
    expect(await actionRuns()).toHaveLength(2);
  });

  it('save_memory repeated by a re-run stores one memory; a new input message stores another', async () => {
    const args = { content: 'The team lunch is on Fridays.', semantic_type: 'note' };
    const first = await callTool(org.slug, await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true }),
      'save_memory', args);
    expect(first.id).toEqual(expect.any(Number));
    const rerun = await callTool(org.slug, await turnFor(org.id, OWNER_PLATFORM_ID, 'm-1', { isDirect: true }),
      'save_memory', args);
    expect(rerun.id).toBe(first.id);
    const next = await callTool(org.slug, await turnFor(org.id, OWNER_PLATFORM_ID, 'm-2', { isDirect: true }),
      'save_memory', args);
    expect(next.id).not.toBe(first.id);
    const stored = await getTestDb()`
      SELECT 1 FROM events WHERE organization_id = ${org.id} AND semantic_type = 'note'
    `;
    expect(stored).toHaveLength(2);
  });

  it('notify repeated by a re-run delivers one notification; a new input message delivers another', async () => {
    const args = { action: 'send', title: 'Lunch is ready', recipients: 'admins' };
    const first = await callTool(org.slug, await turnFor(org.id, ADMIN_PLATFORM_ID, 'm-1', { isDirect: true }),
      'notify', args);
    const rerun = await callTool(org.slug, await turnFor(org.id, ADMIN_PLATFORM_ID, 'm-1', { isDirect: true }),
      'notify', args);
    expect(first.event_id).toEqual(expect.any(Number));
    expect(rerun.event_id).toBe(first.event_id);
    const next = await callTool(org.slug, await turnFor(org.id, ADMIN_PLATFORM_ID, 'm-2', { isDirect: true }),
      'notify', args);
    expect(next.event_id).not.toBe(first.event_id);
  });

  it('a schedule created twice by a re-run is one schedule; different arguments are two', async () => {
    const args = (prompt: string) => ({
      action: 'create', description: 'Remind me', run_at: new Date(Date.now() + 86_400_000).toISOString(),
      payload: { type: 'wake_agent', agent_id: AGENT_ID, prompt },
    });
    // The chat connection the turn arrived on, which a chat-originated schedule delivers back to.
    await insertChatConnectionRow({
      id: 'slackinst-turn-write-dedupe', organizationId: org.id, agentId: AGENT_ID, platform: 'slack',
      metadata: { teamId: TEAM_ID },
    });
    const same = args('check the oven');
    const first = await callTool(org.slug, await turnFor(org.id, ADMIN_PLATFORM_ID, 'm-1', { isDirect: true }),
      'manage_schedules', same);
    expect(first.schedule?.id).toEqual(expect.any(String));
    const rerun = await callTool(org.slug, await turnFor(org.id, ADMIN_PLATFORM_ID, 'm-1', { isDirect: true }),
      'manage_schedules', same);
    expect(rerun.schedule?.id).toBe(first.schedule?.id);
    await callTool(org.slug, await turnFor(org.id, ADMIN_PLATFORM_ID, 'm-1', { isDirect: true }),
      'manage_schedules', args('water the plants'));
    const schedules = await getTestDb()`SELECT 1 FROM scheduled_jobs WHERE organization_id = ${org.id}`;
    expect(schedules).toHaveLength(2);
  });
});
