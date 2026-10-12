/**
 * The Lobu principal a chat turn's tool calls run as.
 *
 * A chat turn's worker token keeps the PLATFORM sender in `userId`. The
 * producer (`agent-turn-producer.ts` `mintTurnToken`) resolves that sender
 * through the verified chat-identity graph, scoped to the turn's organization,
 * and signs the member it found as `actorUserId`. When the turn calls Lobu's
 * own MCP tools, the gateway narrows the token to the gateway-mcp kind and
 * stamps the direct-auth header (`gateway/auth/mcp/proxy-shared.ts`); the
 * embedded multi-tenant middleware then acts as that member, re-checking the
 * membership on every request.
 *
 * A sender who is not a linked member of the org gets a reply-only turn: the
 * token carries no actor and the MCP lane refuses it outright. The agent owner
 * is never substituted for a chat sender.
 *
 * Tokens are minted through the production mint, so the claim the middleware
 * reads is the claim the producer writes.
 */

import { mintGatewayMcpToken, verifyWorkerToken, type MessagePayload } from '@lobu/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintTurnToken } from '../../../gateway/orchestration/agent-turn-producer';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'chat-principal-agent';
const TEAM_ID = 'T0PRINCIPAL';
const SENDER_PLATFORM_ID = 'U0SENDER';
const STRANGER_PLATFORM_ID = 'U0STRANGER';
const MESSAGE_ID = '1787292000.000777';

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'chat-turn', version: '1.0.0' },
  },
  id: 0,
};

/** A Slack chat message exactly as the Chat SDK bridge enqueues it. */
function slackChatMessage(organizationId: string, senderPlatformId: string): MessagePayload {
  return {
    userId: senderPlatformId,
    conversationId: `slack:C0PRINCIPAL:${MESSAGE_ID}`,
    messageId: MESSAGE_ID,
    channelId: 'slack:C0PRINCIPAL',
    // The bridge's top-level team is a worker routing key, not the native
    // Slack team; the native one rides platformMetadata.
    teamId: `slack:${TEAM_ID}`,
    agentId: AGENT_ID,
    organizationId,
    botId: 'slack',
    platform: 'slack',
    messageText: 'save a note for me',
    platformMetadata: {
      connectionId: 'slackinst-chat-principal',
      teamId: TEAM_ID,
      senderId: senderPlatformId,
      responseThreadId: `slack:C0PRINCIPAL:${MESSAGE_ID}`,
    },
    agentOptions: {},
  } as MessagePayload;
}

/** The production turn mint, then the internal MCP hop the gateway forwards. */
async function chatTurnGatewayMcpToken(organizationId: string, senderPlatformId = SENDER_PLATFORM_ID): Promise<string> {
  const turnToken = await mintTurnToken(slackChatMessage(organizationId, senderPlatformId), 1);
  const gatewayToken = mintGatewayMcpToken(turnToken);
  if (!gatewayToken) throw new Error('chat turn token did not verify');
  return gatewayToken;
}

const DIRECT_AUTH = { 'X-Lobu-Memory-Direct-Auth': '1' };

async function openSession(orgSlug: string, token: string): Promise<{ status: number; sessionId: string | null; body: any }> {
  const response = await post(`/mcp/${orgSlug}`, { body: INITIALIZE_BODY, token, headers: DIRECT_AUTH });
  const sessionId = response.headers.get('mcp-session-id');
  const body = response.status === 200 ? null : await response.json();
  if (sessionId) {
    await post(`/mcp/${orgSlug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      token,
      headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId },
    });
  }
  return { status: response.status, sessionId, body };
}

async function callTool(orgSlug: string, token: string, sessionId: string, name: string, args: Record<string, unknown>) {
  return post(`/mcp/${orgSlug}`, {
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    token,
    headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId },
  });
}

describe('chat turn principal: the verified sender, never the agent owner', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let linkedMember: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Chat Principal Org' });
    owner = await createTestUser({ email: 'chat-principal-owner@example.test' });
    linkedMember = await createTestUser({ email: 'chat-principal-member@example.test' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(linkedMember.id, org.id, 'member');
    await createTestAgent({ organizationId: org.id, agentId: AGENT_ID, ownerUserId: owner.id });
    // The sender's Slack identity is verified-linked to an ordinary member.
    await linkChatIdentityInGraph({
      organizationId: org.id,
      userId: linkedMember.id,
      platform: 'slack',
      teamId: TEAM_ID,
      platformUserId: SENDER_PLATFORM_ID,
    });
  });

  it('signs the linked member as the actor and keeps the platform sender as userId', async () => {
    const claims = verifyWorkerToken(await mintTurnToken(slackChatMessage(org.id, SENDER_PLATFORM_ID), 1));
    expect(claims).toMatchObject({ userId: SENDER_PLATFORM_ID, actorUserId: linkedMember.id });
  });

  it('writes memory as the linked member, admitted on an ordinary member role', async () => {
    const token = await chatTurnGatewayMcpToken(org.id);
    const session = await openSession(org.slug, token);
    expect(session.status).toBe(200);
    expect(session.sessionId).toBeTruthy();

    const response = await callTool(org.slug, token, session.sessionId as string, 'save_memory', {
      content: 'Note saved from a Slack chat turn.',
      semantic_type: 'note',
      title: 'chat principal note',
      metadata: {},
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { result?: { isError?: boolean } };
    expect(result.result?.isError).not.toBe(true);

    const rows = await getTestDb()<{ created_by: string | null }>`
      SELECT created_by FROM events
      WHERE organization_id = ${org.id} AND title = 'chat principal note'
    `;
    expect(rows).toEqual([{ created_by: linkedMember.id }]);
  });

  it("sees org-shared and the member's own private connections, not the owner's", async () => {
    await createTestConnection({
      organization_id: org.id, connector_key: 'github', display_name: 'Shared conn', visibility: 'org', created_by: owner.id,
    });
    await createTestConnection({
      organization_id: org.id, connector_key: 'github', display_name: 'Member private conn', visibility: 'private', created_by: linkedMember.id,
    });
    await createTestConnection({
      organization_id: org.id, connector_key: 'github', display_name: 'Owner private conn', visibility: 'private', created_by: owner.id,
    });
    const token = await chatTurnGatewayMcpToken(org.id);
    const session = await openSession(org.slug, token);
    expect(session.status).toBe(200);

    const response = await callTool(org.slug, token, session.sessionId as string, 'manage_connections', { action: 'list' });
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('Shared conn');
    expect(text).toContain('Member private conn');
    expect(text).not.toContain('Owner private conn');
  });

  it("is admitted or refused on the sender's membership, never the owner's role", async () => {
    // Demote the owner: the linked member's turn is unaffected.
    await getTestDb()`UPDATE member SET role = 'member' WHERE "organizationId" = ${org.id} AND "userId" = ${owner.id}`;
    const admitted = await openSession(org.slug, await chatTurnGatewayMcpToken(org.id));
    expect(admitted.status).toBe(200);
  });

  it('refuses an unlinked sender with a typed error instead of borrowing the owner', async () => {
    const claims = verifyWorkerToken(await mintTurnToken(slackChatMessage(org.id, STRANGER_PLATFORM_ID), 1));
    expect(claims?.userId).toBe(STRANGER_PLATFORM_ID);
    expect(claims?.actorUserId).toBeUndefined();

    const refused = await openSession(org.slug, await chatTurnGatewayMcpToken(org.id, STRANGER_PLATFORM_ID));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'insufficient_scope',
      error_description: 'Chat sender is not a linked member of this organization',
    });
  });

  it('refuses a sender linked only in ANOTHER organization', async () => {
    const otherOrg = await createTestOrganization({ name: 'Other Principal Org' });
    const outsider = await createTestUser({ email: 'chat-principal-outsider@example.test' });
    await addUserToOrganization(outsider.id, otherOrg.id, 'owner');
    await linkChatIdentityInGraph({
      organizationId: otherOrg.id,
      userId: outsider.id,
      platform: 'slack',
      teamId: TEAM_ID,
      platformUserId: STRANGER_PLATFORM_ID,
    });

    const claims = verifyWorkerToken(await mintTurnToken(slackChatMessage(org.id, STRANGER_PLATFORM_ID), 1));
    expect(claims?.actorUserId).toBeUndefined();
    const refused = await openSession(org.slug, await chatTurnGatewayMcpToken(org.id, STRANGER_PLATFORM_ID));
    expect(refused.status).toBe(403);
  });

  it('refuses a minted actor whose membership was revoked before use', async () => {
    const token = await chatTurnGatewayMcpToken(org.id);
    await getTestDb()`DELETE FROM member WHERE "organizationId" = ${org.id} AND "userId" = ${linkedMember.id}`;

    const refused = await openSession(org.slug, token);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'insufficient_scope',
      error_description: 'Chat sender is not a linked member of this organization',
    });
  });
});
