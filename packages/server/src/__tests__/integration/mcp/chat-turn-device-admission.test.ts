/**
 * Exercise device admission through the production turn mint and embedded
 * MCP lane, so the gate receives the identity that authentication derives
 * from signed chat evidence. No device worker executes these runs.
 */

import { mintGatewayMcpToken, type MessagePayload } from '@lobu/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { mintTurnToken } from '../../../gateway/orchestration/agent-turn-producer';
import { resolveRunDeciderUserId } from '../../../tools/admin/run-decider';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'device-admission-agent';
const TEAM_ID = 'T0DEVADMIT';
const DEVICE_OWNER_PLATFORM_ID = 'U0DEVOWNER';
const OTHER_MEMBER_PLATFORM_ID = 'U0OTHERMEMBER';
const COWORKER_PLATFORM_ID = 'U0COWORKER';
const CONNECTOR = 'demo.device.chat_admission';
const DIRECT_AUTH = { 'X-Lobu-Memory-Direct-Auth': '1' };

interface Evidence {
  isDirect?: boolean;
  senderVouched?: boolean;
}

function slackChatMessage(organizationId: string, sender: string, evidence: Evidence): MessagePayload {
  return {
    userId: sender,
    conversationId: 'slack:C0DEVADMIT:1787292000.000901',
    messageId: '1787292000.000901',
    channelId: 'slack:C0DEVADMIT',
    teamId: `slack:${TEAM_ID}`,
    agentId: AGENT_ID,
    organizationId,
    botId: 'slack',
    platform: 'slack',
    messageText: 'run it on the laptop',
    platformMetadata: {
      connectionId: 'slackinst-device-admission',
      teamId: TEAM_ID,
      senderId: sender,
      responseThreadId: 'slack:C0DEVADMIT:1787292000.000901',
      ...(evidence.isDirect !== undefined ? { isDirect: evidence.isDirect } : {}),
      ...(evidence.senderVouched ? { senderVouched: true } : {}),
    },
    agentOptions: {},
  } as MessagePayload;
}

async function chatTurnToken(organizationId: string, sender: string, evidence: Evidence): Promise<string> {
  const token = mintGatewayMcpToken(await mintTurnToken(slackChatMessage(organizationId, sender, evidence), 1));
  if (!token) throw new Error('chat turn token did not verify');
  return token;
}

async function executeAsChatTurn(orgSlug: string, token: string, connectionId: number, key: string) {
  const init = await post(`/mcp/${orgSlug}`, {
    body: {
      jsonrpc: '2.0', method: 'initialize', id: 0,
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'chat-turn', version: '1.0.0' } },
    },
    token,
    headers: DIRECT_AUTH,
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id') as string;
  await post(`/mcp/${orgSlug}`, {
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    token,
    headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId },
  });
  const response = await post(`/mcp/${orgSlug}`, {
    body: {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'manage_operations',
        arguments: {
          action: 'execute', connection_id: connectionId, operation_key: 'echo',
          input: {}, background: true, idempotency_key: key,
        },
      },
    },
    token,
    headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: { structuredContent?: { run_id?: number } } };
  return { text: JSON.stringify(body), runId: body.result?.structuredContent?.run_id };
}

describe('chat-turn admission to device-pinned connections', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let connectionId: number;
  let deviceOwnerId: string;

  async function runOf(result: { runId?: number }) {
    expect(result.runId).toBeDefined();
    const [run] = await getTestDb()<{ approval_status: string; status: string; claimed_by: string | null }>`
      SELECT approval_status, status, claimed_by FROM runs
      WHERE organization_id = ${org.id} AND connection_id = ${connectionId} AND id = ${result.runId as number}
    `;
    return run;
  }

  async function policy(effect: 'auto' | 'deny') {
    await upsertEntityApprovalPolicy(org.id, {
      resourceClass: 'connector_action', connectionId, effects: { execute: effect },
    });
  }

  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Device Admission Org' });
    const admin = await createTestUser({ email: 'device-admission-admin@example.test' });
    const deviceOwner = await createTestUser({ email: 'device-admission-owner@example.test' });
    const otherMember = await createTestUser({ email: 'device-admission-other@example.test' });
    await addUserToOrganization(admin.id, org.id, 'owner');
    deviceOwnerId = deviceOwner.id;
    await addUserToOrganization(deviceOwner.id, org.id, 'member');
    await addUserToOrganization(otherMember.id, org.id, 'member');
    await createTestAgent({ organizationId: org.id, agentId: AGENT_ID, ownerUserId: admin.id });
    for (const [userId, platformUserId] of [
      [deviceOwner.id, DEVICE_OWNER_PLATFORM_ID],
      [otherMember.id, OTHER_MEMBER_PLATFORM_ID],
    ] as const) {
      await linkChatIdentityInGraph({ organizationId: org.id, userId, platform: 'slack', teamId: TEAM_ID, platformUserId });
    }

    const sql = getTestDb();
    await createTestConnectorDefinition({
      key: CONNECTOR, name: 'Device chat admission fixture', organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      echo: { name: 'Echo', kind: 'write', input_schema: { type: 'object' } },
    })}, supports_execute = true WHERE organization_id = ${org.id} AND key = ${CONNECTOR}`;
    const [device] = await sql<{ id: string }>`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${deviceOwner.id}, 'synthetic-owner-laptop', 'macos', '0.1.0', '[]'::jsonb, 'Owner laptop', ${org.id}, NOW())
      RETURNING id
    `;
    // Shared with the workspace, so every org-shared chat turn can see it.
    const connection = await createTestConnection({
      organization_id: org.id, connector_key: CONNECTOR, created_by: deviceOwner.id, visibility: 'org',
      createDefaultFeed: false,
    });
    connectionId = connection.id;
    await sql`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${connectionId}`;
    await policy('auto');
  });

  it("holds a vouched coworker's request for approval instead of auto-running it", async () => {
    const token = await chatTurnToken(org.id, COWORKER_PLATFORM_ID, { isDirect: false, senderVouched: true });
    const result = await executeAsChatTurn(org.slug, token, connectionId, 'synthetic-vouched');
    expect(await runOf(result)).toMatchObject({ approval_status: 'pending', status: 'pending', claimed_by: null });
  });

  it("holds the device owner's own group-conversation request for approval", async () => {
    const token = await chatTurnToken(org.id, DEVICE_OWNER_PLATFORM_ID, { isDirect: false });
    const result = await executeAsChatTurn(org.slug, token, connectionId, 'synthetic-group');
    expect(await runOf(result)).toMatchObject({ approval_status: 'pending', status: 'pending', claimed_by: null });
  });

  it("auto-admits another member's own direct-message request on the shared device", async () => {
    const token = await chatTurnToken(org.id, OTHER_MEMBER_PLATFORM_ID, { isDirect: true });
    const result = await executeAsChatTurn(org.slug, token, connectionId, 'synthetic-other-dm');
    expect(await runOf(result)).toMatchObject({ approval_status: 'auto', status: 'pending', claimed_by: null });
  });

  it("routes a coworker's held request to the device owner to decide", async () => {
    const token = await chatTurnToken(org.id, COWORKER_PLATFORM_ID, { isDirect: false, senderVouched: true });
    const result = await executeAsChatTurn(org.slug, token, connectionId, 'synthetic-owner-decides');
    expect(await runOf(result)).toMatchObject({ approval_status: 'pending' });
    expect(await resolveRunDeciderUserId(getTestDb(), result.runId as number, org.id)).toBe(deviceOwnerId);
  });

  it("auto-admits the device owner's own direct-message request", async () => {
    const token = await chatTurnToken(org.id, DEVICE_OWNER_PLATFORM_ID, { isDirect: true });
    const result = await executeAsChatTurn(org.slug, token, connectionId, 'synthetic-owner-dm');
    expect(await runOf(result)).toMatchObject({ approval_status: 'auto', status: 'pending', claimed_by: null });
  });

  it('still refuses a blocked operation outright', async () => {
    await policy('deny');
    const token = await chatTurnToken(org.id, COWORKER_PLATFORM_ID, { isDirect: false, senderVouched: true });
    const result = await executeAsChatTurn(org.slug, token, connectionId, 'synthetic-blocked');
    expect(result.text).toContain('Policy blocks');
    expect(result.runId).toBeUndefined();
    const runs = await getTestDb()`SELECT 1 FROM runs WHERE organization_id = ${org.id} AND connection_id = ${connectionId}`;
    expect(runs).toHaveLength(0);
  });
});
