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
  createTestEntity,
  createTestPAT,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
  seedSystemEntityTypes,
  insertAgentTurnRun,
} from '../../setup/test-fixtures';
import { post, mcpToolsCall } from '../../setup/test-helpers';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { executeAutomationScript } from '../../../automations/reaction-executor';
import { ensureRelationshipType, upsertEdges } from '../../../utils/edge-writes';
import { applyEventAttributions } from '../../../utils/entity-link-upsert';
import { withAclEdgeWrite } from '../../../utils/relationship-validation';
import { PERSONAL_MEMORY_OWNER_NAMESPACE } from '../../../identity/personal-memory-identity';

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

let nextToolRequestId = 1;

async function callTool(orgSlug: string, token: string, sessionId: string, name: string, args: Record<string, unknown>) {
  return post(`/mcp/${orgSlug}`, {
    body: { jsonrpc: '2.0', id: nextToolRequestId++, method: 'tools/call', params: { name, arguments: args } },
    token,
    headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId, 'X-MCP-Format': 'json' },
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

  for (const platform of ['slack', 'whatsapp.web'] as const) {
    for (const reader of ['other member DM', 'group'] as const) {
      for (const readPath of ['text search', 'vector search', 'exact read', 'SQL'] as const) {
        {
          it(`personal memory: ${platform} DM is hidden from ${reader} through ${readPath}`, async () => {
            const bob = await createTestUser({ email: 'memory-bob@example.test' });
            await addUserToOrganization(bob.id, org.id, 'member');
            const alicePlatformId = platform === 'slack' ? SENDER_PLATFORM_ID : '15550000001@s.whatsapp.net';
            const bobPlatformId = platform === 'slack' ? 'U0MEMORYBOB' : '15550000002@s.whatsapp.net';
            for (const [userId, platformUserId] of [[linkedMember.id, alicePlatformId], [bob.id, bobPlatformId]]) {
              await linkChatIdentityInGraph({ organizationId: org.id, userId, platform, teamId: TEAM_ID, platformUserId });
            }

            async function caller(sender: string, isDirect: boolean) {
              const message = slackChatMessage(org.id, sender, { isDirect });
              message.platform = platform;
              message.channelId = platform === 'slack' ? 'slack:C0PRINCIPAL'
                : `whatsapp.web:${isDirect ? sender : '15550000000@g.us'}`;
              message.conversationId = `${message.channelId}:${MESSAGE_ID}`;
              if (platform === 'whatsapp.web') {
                message.botId = platform;
                message.platformMetadata = { connectionId: 'synthetic-whatsapp-memory', senderId: sender, isDirect };
              }
              const turnToken = await mintTurnToken(message, await insertAgentTurnRun(message));
              expect(verifyWorkerToken(turnToken)).toMatchObject({
                actorUserId: sender === alicePlatformId ? linkedMember.id : bob.id,
                chatAccess: isDirect ? 'member' : 'org_shared',
              });
              const token = mintGatewayMcpToken(turnToken);
              expect(token).toBeTruthy();
              const session = await openSession(org.slug, token as string);
              expect(session.status).toBe(200);
              expect(session.sessionId).toBeTruthy();
              return async (name: string, args: Record<string, unknown>) => {
                const response = await callTool(org.slug, token as string, session.sessionId as string, name, args);
                expect(response.status).toBe(200);
                const body = await response.json();
                expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
                return body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
              };
            }

            const alice = await caller(alicePlatformId, true);
            const saved = await alice('save_memory', {
              content: 'Zephyr orchid budget is confidential to Alice.',
              semantic_type: 'observation', title: 'Zephyr orchid budget',
            });
            const id = Number(saved.id);
            expect(id).toBeGreaterThan(0);
            const vector = [1, ...Array(767).fill(0)];
            if (readPath === 'vector search') {
              await getTestDb()`INSERT INTO event_embeddings (event_id, embedding, embedding_model)
                VALUES (${id}, ${JSON.stringify(vector)}::vector, ${getConfiguredEmbeddingModel()})`;
            }
            const readArgs = readPath === 'SQL'
              ? { sql: `SELECT id, payload_text FROM events WHERE id = ${id}`, title: 'Check synthetic private memory' }
              : { query: readPath === 'exact read' ? `memory ${id}` : readPath === 'vector search' ? 'Unrelated semantic query' : 'Zephyr orchid budget',
                  ...(readPath === 'vector search' ? { query_embedding: vector } : {}),
                  include_content: true, include_connections: false, include_public_catalogs: false, content_limit: 6 };
            const tool = readPath === 'SQL' ? 'query_sql' : 'search_memory';
            const ids = (result: { rows?: { id: number }[]; content?: { id: number }[] }) =>
              (readPath === 'SQL' ? result.rows ?? [] : result.content ?? []).map((row) => Number(row.id));
            // This positive control rules out a recall miss or an inaccessible save.
            const own = await alice(tool, readArgs);
            expect(ids(own), JSON.stringify(own)).toContain(id);
            const other = await caller(reader === 'group' ? alicePlatformId : bobPlatformId, reader !== 'group');
            expect(ids(await other(tool, readArgs))).not.toContain(id);
          });
        }
      }
    }
  }

  async function dmCaller() {
    const token = await chatTurnGatewayMcpToken(org.id);
    const session = await openSession(org.slug, token);
    expect(session.status).toBe(200);
    return async (name: string, args: Record<string, unknown>, allowError = false): Promise<any> => {
      const response = await callTool(org.slug, token, session.sessionId as string, name, args);
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      if (allowError) return body.result;
      expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
      return body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
    };
  }

  async function personalResource() {
    const [row] = await getTestDb()<{ entity_id: number }>`SELECT entity_id FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = ${PERSONAL_MEMORY_OWNER_NAMESPACE}
        AND identifier = ${linkedMember.id} AND deleted_at IS NULL`;
    return Number(row.entity_id);
  }

  it('creates one audience and one owner grant across concurrent DM saves and replays without exposing receipts', async () => {
    const alice = await dmCaller();
    const saves = await Promise.all(Array.from({ length: 6 }, (_, i) => alice('save_memory', {
      content: `Concurrent private note ${i}`, semantic_type: 'observation', idempotency_key: `personal-note-${i}`,
    })));
    const resourceId = await personalResource();
    expect(saves.every(row => row.entity_ids.includes(resourceId))).toBe(true);
    const resources = await getTestDb()`SELECT id FROM entity_identities WHERE organization_id = ${org.id}
      AND namespace = ${PERSONAL_MEMORY_OWNER_NAMESPACE} AND identifier = ${linkedMember.id} AND deleted_at IS NULL`;
    expect(resources).toHaveLength(1);
    const grants = await getTestDb()`SELECT id FROM entity_relationships WHERE organization_id = ${org.id}
      AND to_entity_id = ${resourceId} AND deleted_at IS NULL`;
    expect(grants).toHaveLength(1);
    const replay = await alice('save_memory', { content: 'Concurrent private note 0', semantic_type: 'observation', idempotency_key: 'personal-note-0' });
    expect(replay.id).toBe(saves[0].id);
    expect(replay.created).toBe(false);

    const pat = await createTestPAT(linkedMember.id, org.id, { scope: 'mcp:read mcp:write' });
    const read = await mcpToolsCall<any>('query_sdk', { script: `export default async (_ctx, client) => await client.knowledge.read({content_ids:[${saves[0].id}]});` }, { token: pat.token, orgSlug: org.slug });
    expect(read.success).toBe(true);
    expect(read.return_value.content.map((row: { id: number }) => Number(row.id))).toContain(Number(saves[0].id));
    // An administrator has no personal-read bypass, including receipt replays.
    const outsider = await createTestPAT(owner.id, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const hidden = await mcpToolsCall<any>('search_memory', { query: `memory ${saves[0].id}` }, { token: outsider.token, orgSlug: org.slug });
    expect((hidden.content ?? []).map((row: { id: number }) => Number(row.id))).not.toContain(Number(saves[0].id));
    await expect(mcpToolsCall('save_memory', { content: 'Concurrent private note 0', semantic_type: 'observation', idempotency_key: 'personal-note-0' },
      { token: outsider.token, orgSlug: org.slug })).rejects.toThrow();
  });

  it('preserves the private requirement when the owner replaces a memory from a non-chat client', async () => {
    const saved = await (await dmCaller())('save_memory', { content: 'Private original', semantic_type: 'observation' });
    const pat = await createTestPAT(linkedMember.id, org.id, { scope: 'mcp:read mcp:write' });
    const replacement = await mcpToolsCall<any>('save_memory', { content: 'Private replacement', semantic_type: 'observation', supersedes_event_id: saved.id },
      { token: pat.token, orgSlug: org.slug });
    expect(replacement.entity_ids).toContain(await personalResource());
    const outsider = await createTestPAT(owner.id, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const hidden = await mcpToolsCall<any>('query_sql', { sql: `SELECT id FROM events WHERE id IN (${saved.id}, ${replacement.id})` }, { token: outsider.token, orgSlug: org.slug });
    expect(hidden.rows).toEqual([]);
    await expect(mcpToolsCall('save_memory', { content: 'Unauthorized replacement', semantic_type: 'observation', supersedes_event_id: replacement.id },
      { token: outsider.token, orgSlug: org.slug })).rejects.toThrow();
  });

  it('includes personal notes in owner entity counts and score listings while hiding them from other members', async () => {
    const saved = await (await dmCaller())('save_memory', { content: 'Private scored note', semantic_type: 'observation' });
    const resourceId = await personalResource();
    const connection = await createTestConnection({ organization_id: org.id, connector_key: 'slack',
      created_by: linkedMember.id, visibility: 'org' });
    await getTestDb()`UPDATE events SET connection_id = ${connection.id} WHERE id = ${saved.id}`;
    for (const [userId, expectedCount] of [[linkedMember.id, 1], [owner.id, 0]] as const) {
      const pat = await createTestPAT(userId, org.id, { scope: 'mcp:read mcp:write' });
      const result = await mcpToolsCall<any>('query_sdk', { script: `export default async (_ctx, client) => ({
        listed: await client.entities.list({entity_type:'$resource'}),
        sorted: await client.entities.list({entity_type:'$resource',sort_by:'total_content'}),
        scored: await client.knowledge.read({entity_id:${resourceId},sort_by:'score'})
      });` }, { token: pat.token, orgSlug: org.slug });
      expect(result.success, JSON.stringify(result)).toBe(true);
      for (const page of [result.return_value.listed, result.return_value.sorted]) {
        expect(Number(page.entities.find((entity: { id: number }) => Number(entity.id) === resourceId).total_content)).toBe(expectedCount);
      }
      expect(result.return_value.scored.content.map((row: { id: number }) => Number(row.id)))
        .toEqual(expectedCount ? [Number(saved.id)] : []);
    }
  });

  it.each(['membership', 'resource', 'workspace membership'] as const)('revoking %s denies reads and new writes without healing the audience', async (revocation) => {
    const alice = await dmCaller();
    const saved = await alice('save_memory', { content: 'Revocable private memory', semantic_type: 'observation' });
    const resourceId = await personalResource();
    if (revocation === 'membership') {
      await withAclEdgeWrite(getTestDb(), tx => tx`UPDATE entity_relationships SET deleted_at = now()
        WHERE organization_id = ${org.id} AND to_entity_id = ${resourceId}`.then(() => undefined));
    } else if (revocation === 'resource') {
      await getTestDb()`UPDATE entities SET deleted_at = now() WHERE id = ${resourceId}`;
    } else {
      await getTestDb()`DELETE FROM "member" WHERE "organizationId" = ${org.id} AND "userId" = ${linkedMember.id}`;
    }
    if (revocation === 'workspace membership') {
      expect((await openSession(org.slug, await chatTurnGatewayMcpToken(org.id))).status).toBe(403);
    } else {
      const read = await alice('search_memory', { query: `memory ${saved.id}` });
      expect(read.content ?? []).toEqual([]);
      expect((await alice('save_memory', { content: 'New private note after revocation', semantic_type: 'observation' }, true)).isError).toBe(true);
    }
  });

  it('refuses unresolved group saves and DM guidance, including for an administrator', async () => {
    await getTestDb()`UPDATE "member" SET role = 'admin' WHERE "organizationId" = ${org.id} AND "userId" = ${linkedMember.id}`;
    const alice = await dmCaller();
    expect((await alice('save_memory', { content: 'Private guidance must not enter all prompts', semantic_type: 'guidance' }, true)).isError).toBe(true);
    const token = await chatTurnGatewayMcpToken(org.id, SENDER_PLATFORM_ID, { isDirect: false });
    const session = await openSession(org.slug, token);
    const response = await callTool(org.slug, token, session.sessionId as string, 'save_memory', { content: 'Unresolved group capture', semantic_type: 'observation' });
    expect((await response.json()).result.isError).toBe(true);
    expect(await getTestDb()`SELECT id FROM events WHERE organization_id = ${org.id} AND semantic_type IN ('guidance', 'observation')`).toHaveLength(0);
    const privateNote = await alice('save_memory', { content: 'Restricted guidance source', semantic_type: 'observation' });
    const pat = await createTestPAT(linkedMember.id, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    await expect(mcpToolsCall('save_memory', { content: 'Do not publish private source as guidance', semantic_type: 'guidance', parent_event_id: privateNote.id },
      { token: pat.token, orgSlug: org.slug })).rejects.toThrow();
    expect(await getTestDb()`SELECT id FROM events WHERE organization_id = ${org.id} AND semantic_type = 'guidance'`).toHaveLength(0);
  });

  it('refuses connector and SDK attribution claims on the reserved owner namespace', async () => {
    const entity = await createTestEntity({ organization_id: org.id, name: 'Synthetic attempted audience' });
    await expect(applyEventAttributions({ connectorKey: 'synthetic-memory', orgId: org.id,
      items: [{ origin_type: 'test', metadata: { owner: linkedMember.id } }],
      rules: { test: [{ role: 'about', entityType: '$resource', autoCreate: true,
        identities: [{ namespace: PERSONAL_MEMORY_OWNER_NAMESPACE, eventPath: 'metadata.owner', primary: true }] }] },
    }, getTestDb())).rejects.toThrow();
    const alice = await dmCaller();
    const saved = await alice('save_memory', { content: 'Trusted audience despite forged metadata', semantic_type: 'observation',
      metadata: { personalMemoryPrincipal: owner.id, lobu_personal_memory_owner: owner.id, audience: entity.id } });
    expect(saved.entity_ids).toContain(await personalResource());
    expect(saved.entity_ids).not.toContain(entity.id);
  });

  it('denies a creator Automation and its managed worker access to personal memory while retaining workspace reads', async () => {
    await getTestDb()`UPDATE "member" SET role = 'admin' WHERE "organizationId" = ${org.id} AND "userId" = ${linkedMember.id}`;
    await getTestDb()`UPDATE agents SET owner_user_id = ${linkedMember.id} WHERE organization_id = ${org.id} AND id = ${AGENT_ID}`;
    const saved = await (await dmCaller())('save_memory', { content: 'Zephyr confidential creator memory', semantic_type: 'observation' });
    const pat = await createTestPAT(linkedMember.id, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const publicNote = await mcpToolsCall<any>('save_memory', { content: 'Workspace note', semantic_type: 'observation' }, { token: pat.token, orgSlug: org.slug });
    expect(publicNote.entity_ids).not.toContain(await personalResource());
    const entity = await createTestEntity({ organization_id: org.id, name: 'Synthetic memory automation' });
    const created = await mcpToolsCall<any>('run_sdk', { script: `export default async (_ctx, client) => await client.automations.create({entity_id:${entity.id},slug:'personal-memory-probe',name:'Personal memory probe',prompt:'Read allowed context',managed_agent_id:'${AGENT_ID}',sources:[{name:'content',query:'SELECT * FROM events'}]});` }, { token: pat.token, orgSlug: org.slug });
    expect(created.success, JSON.stringify(created)).toBe(true);
    const automationId = Number(created.return_value.automation_id);
    const executed = await executeAutomationScript({
      compiledScript: `export default async (_ctx, client) => ({
        exact: await client.knowledge.read({content_ids:[${saved.id}]}),
        recall: await client.knowledge.search({query:'Zephyr confidential creator memory',include_connections:false}),
        rows: await client.query('SELECT id FROM events WHERE id IN (${saved.id},${publicNote.id})')
      });`,
      context: { window: { run_id: 1, automation_id: automationId, window_start: '2026-11-15T00:00:00Z', window_end: '2026-11-16T00:00:00Z' },
        automation: { id: automationId, slug: 'personal-memory-probe', name: 'Personal memory probe', version: 1 },
        organization_id: org.id, organization_slug: org.slug, entities: [], trigger_signals: [] }, env: {},
    });
    expect(executed.success, JSON.stringify(executed)).toBe(true);
    const value = executed.returnValue as any;
    expect(value.exact.content).toEqual([]);
    expect(value.recall.content ?? []).toEqual([]);
    expect(value.rows.map((row: { id: number }) => Number(row.id))).toEqual([Number(publicNote.id)]);
    const worker = mintGatewayMcpToken(generateWorkerToken(linkedMember.id, 'synthetic-automation', 'agent-turn:synthetic', {
      platform: 'api', channelId: 'synthetic-automation', source: 'automation-run', agentId: AGENT_ID, organizationId: org.id,
    })) as string;
    const session = await openSession(org.slug, worker);
    expect(session.status).toBe(200);
    const response = await callTool(org.slug, worker, session.sessionId as string, 'query_sql', {
      sql: `SELECT id FROM events WHERE id IN (${saved.id},${publicNote.id})`,
    });
    const body = await response.json();
    expect(body.result.isError, JSON.stringify(body)).not.toBe(true);
    const rows = body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
    expect(rows.rows.map((row: { id: number }) => Number(row.id))).toEqual([Number(publicNote.id)]);
  });

  it('retains source requirements as well as the private owner requirement', async () => {
    await getTestDb()`UPDATE "member" SET role = 'admin' WHERE "organizationId" = ${org.id} AND "userId" = ${linkedMember.id}`;
    const source = await createTestEntity({ organization_id: org.id, entity_type: '$resource', name: 'Synthetic source audience' });
    const [member] = await getTestDb()`SELECT entity_id FROM entity_identities WHERE organization_id = ${org.id}
      AND namespace = 'auth_user_id' AND identifier = ${linkedMember.id} AND source_connector = 'auth:signup' AND deleted_at IS NULL`;
    const typeId = await ensureRelationshipType({ organizationId: org.id, slug: 'member_of', name: 'Member of', description: 'Synthetic source grant', purpose: 'authorization' });
    const [grantId] = await withAclEdgeWrite(getTestDb(), tx => upsertEdges({ db: tx, organizationId: org.id, relationshipTypeId: typeId,
      pairs: [{ fromEntityId: Number(member.entity_id), toEntityId: source.id }], source: 'manual', createdBy: linkedMember.id, claimKey: 'manual', onConflict: 'ignore' }));
    const alice = await dmCaller();
    const saved = await alice('save_memory', { content: 'Source restricted private note', semantic_type: 'observation', entity_ids: [source.id] });
    expect(saved.entity_ids).toEqual(expect.arrayContaining([source.id, await personalResource()]));
    expect((await alice('search_memory', { query: `memory ${saved.id}` })).content.map((row: { id: number }) => Number(row.id))).toContain(Number(saved.id));
    await withAclEdgeWrite(getTestDb(), tx => tx`UPDATE entity_relationships SET deleted_at = now() WHERE id = ${grantId}`.then(() => undefined));
    expect((await alice('search_memory', { query: `memory ${saved.id}` })).content ?? []).toEqual([]);
  });

  it('does not promote a conflicting untrusted personal-owner identity', async () => {
    const entity = await createTestEntity({ organization_id: org.id, entity_type: '$resource', name: 'Synthetic untrusted claim' });
    await getTestDb()`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector, scope_key)
      VALUES (${org.id}, ${entity.id}, ${PERSONAL_MEMORY_OWNER_NAMESPACE}, ${linkedMember.id}, 'connector:synthetic', NULL)`;
    const alice = await dmCaller();
    const result = await alice('save_memory', { content: 'Do not publish when audience cannot resolve', semantic_type: 'observation' }, true);
    expect(result.isError).toBe(true);
    expect(await getTestDb()`SELECT id FROM events WHERE organization_id = ${org.id} AND semantic_type = 'observation'`).toHaveLength(0);
    const [identity] = await getTestDb()`SELECT source_connector FROM entity_identities WHERE entity_id = ${entity.id}`;
    expect(identity.source_connector).toBe('connector:synthetic');
  });

  it('applies the DM audience through SDK saves and re-resolves it after client.org', async () => {
    const target = await createTestOrganization({ name: 'Synthetic target memory workspace' });
    await addUserToOrganization(linkedMember.id, target.id, 'member');
    await linkChatIdentityInGraph({ organizationId: target.id, userId: linkedMember.id, platform: 'slack', teamId: TEAM_ID, platformUserId: SENDER_PLATFORM_ID });
    const alice = await dmCaller();
    const result = await alice('run_sdk', { script: `export default async (_ctx, client) => {
      const home = await client.knowledge.save({content:'SDK private home note',semantic_type:'observation'});
      const other = await client.org('${target.slug}');
      const foreign = await other.knowledge.save({content:'SDK private foreign note',semantic_type:'observation'});
      return {home,foreign,rows:await other.query('SELECT id FROM events WHERE id = ' + foreign.id)};
    };` });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const homeId = await personalResource();
    const [foreign] = await getTestDb()`SELECT entity_id FROM entity_identities WHERE organization_id = ${target.id}
      AND namespace = ${PERSONAL_MEMORY_OWNER_NAMESPACE} AND identifier = ${linkedMember.id} AND deleted_at IS NULL`;
    expect(Number(foreign.entity_id)).not.toBe(homeId);
    expect(result.return_value.home.entity_ids).toContain(homeId);
    expect(result.return_value.foreign.entity_ids).toContain(Number(foreign.entity_id));
    expect(result.return_value.foreign.entity_ids).not.toContain(homeId);
    expect(result.return_value.rows.map((row: { id: number }) => Number(row.id))).toContain(Number(result.return_value.foreign.id));
    await getTestDb()`DELETE FROM "member" WHERE "organizationId" = ${target.id} AND "userId" = ${linkedMember.id}`;
    const denied = await alice('query_sdk', { script: `export default async (_ctx, client) => (await client.org('${target.slug}')).knowledge.read({content_ids:[${result.return_value.foreign.id}]});` });
    expect(denied.success).toBe(false);
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
