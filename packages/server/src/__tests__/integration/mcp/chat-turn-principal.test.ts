/**
 * The Lobu principal a chat turn's tool calls run as — the access matrix.
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
 * A linked member acts as themselves in a direct message. In a group
 * conversation, a linked member and an unlinked sender the platform vouches
 * for both act with no user and an ordinary-member role (org-shared
 * connections only); the member is recorded as run attribution. Any
 * other unlinked sender is an anonymous public visitor of a public org, or
 * reply-only in a private org, refused outright. The agent owner is never
 * substituted for a chat sender.
 *
 * Tokens are minted through the production mint, so the claim the middleware
 * reads is the claim the producer writes.
 */

import { generateWorkerToken, mintGatewayMcpToken, verifyWorkerToken, type MessagePayload } from '@lobu/core';
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
  insertAgentTurnRun,
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

interface Evidence {
  /** Structured DM flag the bridge stamps (`platformMetadata.isDirect`). */
  isDirect?: boolean;
  /** The platform's same-tenant verdict (`platformMetadata.senderVouched`). */
  senderVouched?: boolean;
}

/** A Slack chat message exactly as the Chat SDK bridge enqueues it. */
function slackChatMessage(organizationId: string, senderPlatformId: string, evidence: Evidence = {}): MessagePayload {
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
      ...(evidence.isDirect !== undefined ? { isDirect: evidence.isDirect } : {}),
      ...(evidence.senderVouched ? { senderVouched: true } : {}),
    },
    agentOptions: {},
  } as MessagePayload;
}

/** The production turn mint, then the internal MCP hop the gateway forwards. */
async function chatTurnGatewayMcpToken(
  organizationId: string,
  senderPlatformId = SENDER_PLATFORM_ID,
  evidence: Evidence = { isDirect: true },
): Promise<string> {
  const message = slackChatMessage(organizationId, senderPlatformId, evidence);
  const turnToken = await mintTurnToken(message, await insertAgentTurnRun(message));
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
    const dm = verifyWorkerToken(await mintTurnToken(slackChatMessage(org.id, SENDER_PLATFORM_ID, { isDirect: true }), 1));
    expect(dm).toMatchObject({ userId: SENDER_PLATFORM_ID, actorUserId: linkedMember.id, chatAccess: 'member' });
    const channel = verifyWorkerToken(await mintTurnToken(slackChatMessage(org.id, SENDER_PLATFORM_ID, { isDirect: false }), 1));
    // In a group conversation the member's id rides along as attribution only.
    expect(channel).toMatchObject({ actorUserId: linkedMember.id, chatAccess: 'org_shared' });
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

  async function seedConnections() {
    await createTestConnection({
      organization_id: org.id, connector_key: 'github', display_name: 'Shared conn', visibility: 'org', created_by: owner.id,
    });
    await createTestConnection({
      organization_id: org.id, connector_key: 'github', display_name: 'Member private conn', visibility: 'private', created_by: linkedMember.id,
    });
    await createTestConnection({
      organization_id: org.id, connector_key: 'github', display_name: 'Owner private conn', visibility: 'private', created_by: owner.id,
    });
  }

  async function listedConnections(token: string): Promise<string> {
    const session = await openSession(org.slug, token);
    expect(session.status).toBe(200);
    const response = await callTool(org.slug, token, session.sessionId as string, 'manage_connections', { action: 'list' });
    expect(response.status).toBe(200);
    return JSON.stringify(await response.json());
  }

  it("in a DM sees org-shared and the member's own private connections, not the owner's", async () => {
    await seedConnections();
    const text = await listedConnections(await chatTurnGatewayMcpToken(org.id, SENDER_PLATFORM_ID, { isDirect: true }));
    expect(text).toContain('Shared conn');
    expect(text).toContain('Member private conn');
    expect(text).not.toContain('Owner private conn');
  });

  it("in a group conversation acts with no user (org-shared only) and records the member as attribution", async () => {
    await seedConnections();
    const token = await chatTurnGatewayMcpToken(org.id, SENDER_PLATFORM_ID, { isDirect: false });
    const text = await listedConnections(token);
    expect(text).toContain('Shared conn');
    expect(text).not.toContain('Member private conn');
    expect(text).not.toContain('Owner private conn');

    // No user principal: the member rides the token as attribution only, which
    // the lane copies into sourceContext.memberUserId → run initiator_ref
    // (unit: __tests__/unit/run-initiator.test.ts).
    const claims = verifyWorkerToken(await mintTurnToken(slackChatMessage(org.id, SENDER_PLATFORM_ID, { isDirect: false }), 1));
    expect(claims).toMatchObject({ userId: SENDER_PLATFORM_ID, actorUserId: linkedMember.id, chatAccess: 'org_shared' });

    // Never owner/admin, even for a member whose own role would allow more.
    const session = await openSession(org.slug, token);
    const admin = await callTool(org.slug, token, session.sessionId as string, 'manage_entity_schema', {
      action: 'create', slug: 'group_probe', name: 'Group probe',
    });
    expect(JSON.stringify(await admin.json())).toContain('requires admin or owner access');
  });

  it('refuses a group-conversation turn once the member behind it is removed', async () => {
    const token = await chatTurnGatewayMcpToken(org.id, SENDER_PLATFORM_ID, { isDirect: false });
    await getTestDb()`DELETE FROM "member" WHERE "organizationId" = ${org.id} AND "userId" = ${linkedMember.id}`;
    const session = await openSession(org.slug, token);
    expect(session.status).toBe(403);
  });

  it('serves a vouched unlinked sender org-shared connections only, with an ordinary-member role', async () => {
    await seedConnections();
    const token = await chatTurnGatewayMcpToken(org.id, STRANGER_PLATFORM_ID, { isDirect: false, senderVouched: true });
    const claims = verifyWorkerToken(await mintTurnToken(
      slackChatMessage(org.id, STRANGER_PLATFORM_ID, { isDirect: false, senderVouched: true }), 1,
    ));
    expect(claims).toMatchObject({ userId: STRANGER_PLATFORM_ID, chatAccess: 'org_shared' });
    expect(claims?.actorUserId).toBeUndefined();

    const text = await listedConnections(token);
    expect(text).toContain('Shared conn');
    expect(text).not.toContain('Member private conn');
    expect(text).not.toContain('Owner private conn');

    // Never owner/admin: an admin-tier action is refused.
    const session = await openSession(org.slug, token);
    const admin = await callTool(org.slug, token, session.sessionId as string, 'manage_entity_schema', {
      action: 'create', slug: 'vouched_probe', name: 'Vouched probe',
    });
    expect(JSON.stringify(await admin.json())).toContain('requires admin or owner access');
  });

  it('serves a public-org stranger exactly the anonymous public-read path', async () => {
    const publicOrg = await createTestOrganization({ name: 'Public Principal Org', visibility: 'public' });
    await createTestAgent({ organizationId: publicOrg.id, agentId: AGENT_ID, ownerUserId: owner.id });
    const claims = verifyWorkerToken(await mintTurnToken(slackChatMessage(publicOrg.id, STRANGER_PLATFORM_ID), 1));
    expect(claims?.chatAccess).toBe('public_visitor');

    const token = await chatTurnGatewayMcpToken(publicOrg.id, STRANGER_PLATFORM_ID, {});
    const session = await openSession(publicOrg.slug, token);
    expect(session.status).toBe(200);
    const write = await callTool(publicOrg.slug, token, session.sessionId as string, 'save_memory', {
      content: 'Stranger note.', semantic_type: 'note', title: 'stranger note', metadata: {},
    });
    // The same refusal any anonymous public-workspace visitor gets for a write.
    expect(JSON.stringify(await write.json())).toContain('Authentication required');
    const read = await callTool(publicOrg.slug, token, session.sessionId as string, 'search_memory', { query: 'anything' });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    const rows = await getTestDb()`SELECT 1 FROM events WHERE organization_id = ${publicOrg.id} AND title = 'stranger note'`;
    expect(rows).toHaveLength(0);
  });

  it('fails closed on a chat token minted without an access tier', async () => {
    const legacy = generateWorkerToken(SENDER_PLATFORM_ID, 'conv-legacy', 'agent-turn:legacy', {
      channelId: 'slack:C0PRINCIPAL', platform: 'slack', agentId: AGENT_ID, organizationId: org.id,
      actorUserId: linkedMember.id,
    });
    const refused = await openSession(org.slug, mintGatewayMcpToken(legacy) as string);
    expect(refused.status).toBe(403);
  });

  it("is admitted or refused on the sender's membership, never the owner's role", async () => {
    // Demote the owner: the linked member's turn is unaffected.
    await getTestDb()`UPDATE member SET role = 'member' WHERE "organizationId" = ${org.id} AND "userId" = ${owner.id}`;
    const admitted = await openSession(org.slug, await chatTurnGatewayMcpToken(org.id));
    expect(admitted.status).toBe(200);
  });

  it('refuses an unvouched stranger of a private org with a typed error instead of borrowing the owner', async () => {
    const claims = verifyWorkerToken(await mintTurnToken(slackChatMessage(org.id, STRANGER_PLATFORM_ID), 1));
    expect(claims?.userId).toBe(STRANGER_PLATFORM_ID);
    expect(claims?.actorUserId).toBeUndefined();
    expect(claims?.chatAccess).toBe('reply_only');

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
