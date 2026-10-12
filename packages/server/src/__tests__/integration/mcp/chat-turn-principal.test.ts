/**
 * Characterization: the Lobu principal a chat turn's tool calls run as.
 *
 * A Slack or Google Chat message enqueues a turn whose one credential is a
 * worker token minted for the PLATFORM sender (`userId` = the chat user id,
 * never a Lobu user). When the turn calls Lobu's own MCP tools, the gateway
 * narrows that token to the gateway-mcp kind and stamps the direct-auth
 * header (`gateway/auth/mcp/proxy-shared.ts`). The embedded multi-tenant
 * middleware then attributes every call to the AGENT OWNER
 * (`agents.owner_user_id`) and requires that owner to be an org owner/admin.
 *
 * CURRENT (known gap, intentionally changed by the chat-sender-authority PR):
 * a chat turn acts as the agent owner, not as the verified sender. A sender
 * whose chat identity is linked to an ordinary member — or who is not a Lobu
 * user at all — still writes memory as the owner with admin scopes. These
 * tests lock that attribution so the later change shows up as an intentional
 * diff here rather than as an unnoticed regression.
 */

import { generateWorkerToken, mintGatewayMcpToken } from '@lobu/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildWorkerTokenClaims } from '../../../gateway/orchestration/worker-token-claims';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'chat-principal-agent';
const TEAM_ID = 'T0PRINCIPAL';
const SENDER_PLATFORM_ID = 'U0SENDER';
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

/**
 * Mint the credential exactly as `agent-turn-producer.ts` `mintTurnToken`
 * does for a Slack chat turn, then derive the internal MCP hop credential the
 * gateway MCP proxy forwards.
 */
function chatTurnGatewayMcpToken(organizationId: string): string {
  const turnToken = generateWorkerToken(
    SENDER_PLATFORM_ID,
    `slack:C0PRINCIPAL:${MESSAGE_ID}`,
    `agent-turn:${MESSAGE_ID}`,
    {
      ...buildWorkerTokenClaims({
        channelId: 'slack:C0PRINCIPAL',
        teamId: TEAM_ID,
        agentId: AGENT_ID,
        organizationId,
        platform: 'slack',
        platformMetadata: {
          connectionId: 'slackinst-chat-principal',
          teamId: TEAM_ID,
          responseThreadId: `slack:C0PRINCIPAL:${MESSAGE_ID}`,
        },
      }),
      messageId: MESSAGE_ID,
      runId: 1,
    }
  );
  const gatewayToken = mintGatewayMcpToken(turnToken);
  if (!gatewayToken) throw new Error('chat turn token did not verify');
  return gatewayToken;
}

async function openSession(orgSlug: string, token: string): Promise<{ status: number; sessionId: string | null; body: any }> {
  const headers = { 'X-Lobu-Memory-Direct-Auth': '1' };
  const response = await post(`/mcp/${orgSlug}`, { body: INITIALIZE_BODY, token, headers });
  const sessionId = response.headers.get('mcp-session-id');
  const body = response.status === 200 ? null : await response.json();
  if (sessionId) {
    await post(`/mcp/${orgSlug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      token,
      headers: { ...headers, 'mcp-session-id': sessionId },
    });
  }
  return { status: response.status, sessionId, body };
}

describe('chat turn principal (CURRENT: agent owner)', () => {
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

  it('writes memory as the agent owner even when the sender is linked to an ordinary member', async () => {
    const token = chatTurnGatewayMcpToken(org.id);
    const session = await openSession(org.slug, token);
    expect(session.status).toBe(200);
    expect(session.sessionId).toBeTruthy();

    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            content: 'Characterization note saved from a Slack chat turn.',
            semantic_type: 'note',
            title: 'chat principal note',
            metadata: {},
          },
        },
      },
      token,
      headers: { 'X-Lobu-Memory-Direct-Auth': '1', 'mcp-session-id': session.sessionId as string },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { result?: { isError?: boolean } };
    expect(result.result?.isError).not.toBe(true);

    const rows = await getTestDb()<{ created_by: string | null }>`
      SELECT created_by FROM events
      WHERE organization_id = ${org.id} AND title = 'chat principal note'
    `;
    // CURRENT (known gap): attributed to the agent owner, not the linked
    // sender (`linkedMember`). The sender-authority PR flips this to the
    // verified sender's member.
    expect(rows).toEqual([{ created_by: owner.id }]);
  });

  it("is admitted or refused on the agent owner's role, never the sender's", async () => {
    // Promote the linked sender to admin and demote the owner: the turn is now
    // refused although the person who sent the message is an org admin.
    await getTestDb()`UPDATE member SET role = 'admin' WHERE "organizationId" = ${org.id} AND "userId" = ${linkedMember.id}`;
    await getTestDb()`UPDATE member SET role = 'member' WHERE "organizationId" = ${org.id} AND "userId" = ${owner.id}`;

    const refused = await openSession(org.slug, chatTurnGatewayMcpToken(org.id));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'insufficient_scope',
      error_description: 'Agent owner is not an organization admin',
    });

    // Restore the owner: admitted again although the sender is unchanged.
    await getTestDb()`UPDATE member SET role = 'owner' WHERE "organizationId" = ${org.id} AND "userId" = ${owner.id}`;
    const admitted = await openSession(org.slug, chatTurnGatewayMcpToken(org.id));
    expect(admitted.status).toBe(200);
  });
});
