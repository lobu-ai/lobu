/**
 * A chat turn reaches the sender's other workspaces
 * (docs/design/chat-sender-workspace-scope.md).
 *
 * A linked member writing to a bot in a direct message gets a turn token that
 * keeps the bot's workspace (the home) as the default and is marked eligible
 * for the sender's memberships. When a call names another workspace through
 * `client.org(slug)` or a tool's workspace argument, membership is re-read
 * against `member` rows at that moment and the call acts as the sender, with
 * the sender's role there and that workspace's own connector policy.
 *
 * Every other turn keeps today's single-workspace scope: a group
 * conversation, an `org_shared` or `public_visitor` sender, a workspace the
 * sender does not belong to, and a membership removed after the mint.
 *
 * Tokens come from the production mint, then the gateway's internal MCP hop,
 * so the claim the middleware reads is the claim the producer writes.
 */

import { mintGatewayMcpToken, verifyWorkerToken, type MessagePayload } from '@lobu/core';
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
  createTestUser,
  linkChatIdentityInGraph,
  seedSystemEntityTypes,
  insertAgentTurnRun,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'chat-reach-agent';
const TEAM_ID = 'T0REACH';
const SENDER_PLATFORM_ID = 'U0REACHSENDER';
const STRANGER_PLATFORM_ID = 'U0REACHSTRANGER';
const MESSAGE_ID = '1787292000.000888';
const CONNECTOR_KEY = 'demo.chat.reach.local';

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
  isDirect?: boolean;
  senderVouched?: boolean;
}

/** A Slack chat message exactly as the Chat SDK bridge enqueues it. */
function slackChatMessage(organizationId: string, senderPlatformId: string, evidence: Evidence): MessagePayload {
  return {
    userId: senderPlatformId,
    conversationId: `slack:C0REACH:${MESSAGE_ID}`,
    messageId: MESSAGE_ID,
    channelId: 'slack:C0REACH',
    teamId: `slack:${TEAM_ID}`,
    agentId: AGENT_ID,
    organizationId,
    botId: 'slack',
    platform: 'slack',
    messageText: 'add this to my personal workspace',
    platformMetadata: {
      connectionId: 'slackinst-chat-reach',
      teamId: TEAM_ID,
      senderId: senderPlatformId,
      responseThreadId: `slack:C0REACH:${MESSAGE_ID}`,
      ...(evidence.isDirect !== undefined ? { isDirect: evidence.isDirect } : {}),
      ...(evidence.senderVouched ? { senderVouched: true } : {}),
    },
    agentOptions: {},
  } as MessagePayload;
}

async function turnToken(organizationId: string, senderPlatformId: string, evidence: Evidence): Promise<string> {
  const message = slackChatMessage(organizationId, senderPlatformId, evidence);
  return mintTurnToken(message, await insertAgentTurnRun(message));
}

async function gatewayToken(organizationId: string, senderPlatformId: string, evidence: Evidence): Promise<string> {
  const token = mintGatewayMcpToken(await turnToken(organizationId, senderPlatformId, evidence));
  if (!token) throw new Error('chat turn token did not verify');
  return token;
}

const DIRECT_AUTH = { 'X-Lobu-Memory-Direct-Auth': '1' };

/** One MCP session on the home workspace, as the turn's tool hop opens it. */
async function openTurnSession(orgSlug: string, token: string) {
  const response = await post(`/mcp/${orgSlug}`, { body: INITIALIZE_BODY, token, headers: DIRECT_AUTH });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id') as string;
  await post(`/mcp/${orgSlug}`, {
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    token,
    headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId },
  });
  return async (name: string, args: Record<string, unknown>) => {
    const call = await post(`/mcp/${orgSlug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      token,
      headers: { ...DIRECT_AUTH, 'mcp-session-id': sessionId },
    });
    expect(call.status).toBe(200);
    const body = (await call.json()) as {
      result?: { isError?: boolean };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    return {
      isError: body.result?.isError === true,
      text: JSON.stringify(body),
    };
  };
}

const sdk = (script: string) => ({ script: `export default async (ctx, client) => { ${script} };` });

describe('chat turn: the sender\'s workspaces, reachable from a direct message only', () => {
  let home: Awaited<ReturnType<typeof createTestOrganization>>;
  let personal: Awaited<ReturnType<typeof createTestOrganization>>;
  let foreign: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let sender: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    home = await createTestOrganization({ name: 'Reach Home Org' });
    personal = await createTestOrganization({ name: 'Reach Personal Org' });
    foreign = await createTestOrganization({ name: 'Reach Foreign Org' });
    owner = await createTestUser({ email: 'chat-reach-owner@example.test' });
    sender = await createTestUser({ email: 'chat-reach-sender@example.test' });
    await addUserToOrganization(owner.id, home.id, 'owner');
    await addUserToOrganization(owner.id, foreign.id, 'owner');
    await addUserToOrganization(sender.id, home.id, 'member');
    await addUserToOrganization(sender.id, personal.id, 'owner');
    await createTestAgent({ organizationId: home.id, agentId: AGENT_ID, ownerUserId: owner.id });
    await linkChatIdentityInGraph({
      organizationId: home.id,
      userId: sender.id,
      platform: 'slack',
      teamId: TEAM_ID,
      platformUserId: SENDER_PLATFORM_ID,
    });
  });

  it('marks only a linked member\'s direct-message turn as eligible', async () => {
    const dm = verifyWorkerToken(await turnToken(home.id, SENDER_PLATFORM_ID, { isDirect: true }));
    expect(dm).toMatchObject({ organizationId: home.id, chatAccess: 'member', actorUserId: sender.id, chatSenderWorkspaces: true });
    const group = verifyWorkerToken(await turnToken(home.id, SENDER_PLATFORM_ID, { isDirect: false }));
    expect(group?.chatAccess).toBe('org_shared');
    expect(group?.chatSenderWorkspaces).toBeUndefined();
    const vouched = verifyWorkerToken(await turnToken(home.id, STRANGER_PLATFORM_ID, { isDirect: true, senderVouched: true }));
    expect(vouched?.chatAccess).toBe('org_shared');
    expect(vouched?.chatSenderWorkspaces).toBeUndefined();
  });

  it('acts as the sender in another workspace they belong to, through client.org and workspace arguments', async () => {
    const call = await openTurnSession(home.slug, await gatewayToken(home.id, SENDER_PLATFORM_ID, { isDirect: true }));

    const selected = await call('query_sdk', sdk(
      `const ws = await client.org('${personal.slug}'); return (await ws.organizations.current()).id;`,
    ));
    expect(selected.isError, selected.text).toBe(false);
    expect(selected.text).toContain(personal.id);

    const saved = await call('save_memory', {
      org_slug: personal.slug,
      content: 'Dentist on Friday at 10.',
      semantic_type: 'note',
      title: 'chat reach personal note',
      metadata: {},
    });
    expect(saved.isError, saved.text).toBe(false);
    const rows = await getTestDb()<{ organization_id: string; created_by: string | null }>`
      SELECT organization_id, created_by FROM events WHERE title = 'chat reach personal note'
    `;
    expect(rows).toEqual([{ organization_id: personal.id, created_by: sender.id }]);

    const searched = await call('search_memory', { query: 'dentist', workspace: personal.slug });
    expect(searched.isError, searched.text).toBe(false);
    expect(searched.text).toContain('Scope: selected_workspace');
    expect(searched.text).toContain(`Workspace: \`${personal.slug}\``);
    expect(searched.text).toContain('Dentist on Friday at 10.');
    const searchAudits = await getTestDb()`
      SELECT created_by FROM events
      WHERE organization_id = ${personal.id}
        AND metadata->>'event_type' = 'tool_invocation.workspace_activity'
        AND metadata->>'tool_name' = 'search_memory'
    `;
    expect(searchAudits).toEqual([{ created_by: sender.id }]);

    const workspaces = await call('query_sdk', sdk('return (await client.organizations.list()).map(org => org.id);'));
    expect(workspaces.isError, workspaces.text).toBe(false);
    expect(workspaces.text).toContain(personal.id);
    expect(workspaces.text).not.toContain(foreign.id);

    // The home workspace stays the default for every unqualified call.
    const unqualified = await call('query_sdk', sdk('return (await client.organizations.current()).id;'));
    expect(unqualified.text).toContain(home.id);
    expect(unqualified.text).not.toContain(personal.id);
  });

  it('keeps the SDK ceiling of the home role, even where the sender is an owner', async () => {
    // Fail closed: the sender is an ordinary member at home and an owner of
    // the personal workspace, and a chat turn never gets admin-tier SDK
    // methods from a role it holds elsewhere.
    const call = await openTurnSession(home.slug, await gatewayToken(home.id, SENDER_PLATFORM_ID, { isDirect: true }));
    const createType = await call('run_sdk', sdk(
      `const ws = await client.org('${personal.slug}'); return await ws.entitySchema.createType({ slug: 'chat_reach_owned', name: 'Chat reach test' });`,
    ));
    expect(createType.text).not.toContain('"success": true');
    const rows = await getTestDb()`SELECT 1 FROM entity_types WHERE organization_id = ${personal.id} AND slug = 'chat_reach_owned'`;
    expect(rows).toHaveLength(0);
  });

  it('refuses a workspace the sender is not a member of, without revealing it', async () => {
    const call = await openTurnSession(home.slug, await gatewayToken(home.id, SENDER_PLATFORM_ID, { isDirect: true }));
    const viaSdk = await call('query_sdk', sdk(`return (await client.org('${foreign.slug}')).organizations.current();`));
    expect(viaSdk.text).toContain('Workspace is not available for this authorization');
    expect(viaSdk.text).not.toContain(foreign.id);
    const viaSearch = await call('search_memory', { query: 'anything', workspace: foreign.slug });
    expect(viaSearch.isError).toBe(true);
  });

  it('refuses another workspace once the sender\'s membership there is removed after the mint', async () => {
    const call = await openTurnSession(home.slug, await gatewayToken(home.id, SENDER_PLATFORM_ID, { isDirect: true }));
    await getTestDb()`DELETE FROM "member" WHERE "organizationId" = ${personal.id} AND "userId" = ${sender.id}`;
    const viaSdk = await call('query_sdk', sdk(`return (await client.org('${personal.slug}')).organizations.current();`));
    expect(viaSdk.text).toContain('Workspace is not available for this authorization');
    const viaSave = await call('save_memory', {
      org_slug: personal.slug, content: 'late', semantic_type: 'note', title: 'chat reach removed', metadata: {},
    });
    expect(viaSave.isError).toBe(true);
    const rows = await getTestDb()`SELECT 1 FROM events WHERE title = 'chat reach removed'`;
    expect(rows).toHaveLength(0);
  });

  it('keeps a group-conversation turn in its own workspace', async () => {
    const call = await openTurnSession(home.slug, await gatewayToken(home.id, SENDER_PLATFORM_ID, { isDirect: false }));
    const viaSdk = await call('query_sdk', sdk(`return (await client.org('${personal.slug}')).organizations.current();`));
    expect(viaSdk.text).toContain('CrossOrgAccessDenied');
    expect(viaSdk.text).not.toContain(personal.id);
    const viaSearch = await call('search_memory', { query: 'anything', workspace: personal.slug });
    expect(viaSearch.isError).toBe(true);
  });

  it('keeps a vouched org_shared sender in its own workspace', async () => {
    const call = await openTurnSession(home.slug, await gatewayToken(home.id, STRANGER_PLATFORM_ID, { isDirect: true, senderVouched: true }));
    const viaSdk = await call('query_sdk', sdk(`return (await client.org('${personal.slug}')).organizations.current();`));
    expect(viaSdk.text).toContain('CrossOrgAccessDenied');
    const viaSearch = await call('search_memory', { query: 'anything', workspace: personal.slug });
    expect(viaSearch.isError).toBe(true);
  });

  it('keeps a public visitor in the public workspace it wrote to', async () => {
    const publicOrg = await createTestOrganization({ name: 'Reach Public Org', visibility: 'public' });
    await createTestAgent({ organizationId: publicOrg.id, agentId: AGENT_ID, ownerUserId: owner.id });
    expect(verifyWorkerToken(await turnToken(publicOrg.id, STRANGER_PLATFORM_ID, { isDirect: true }))?.chatAccess)
      .toBe('public_visitor');
    const call = await openTurnSession(publicOrg.slug, await gatewayToken(publicOrg.id, STRANGER_PLATFORM_ID, { isDirect: true }));
    const viaSearch = await call('search_memory', { query: 'anything', workspace: personal.slug });
    expect(viaSearch.isError).toBe(true);
  });

  it('applies the target workspace\'s connector policy and keeps approvals human-only', async () => {
    await createTestConnectorDefinition({ key: CONNECTOR_KEY, name: 'Chat reach local', organization_id: personal.id });
    await getTestDb()`
      UPDATE connector_definitions
      SET actions_schema = ${getTestDb().json({
        echo: { name: 'Echo', kind: 'write', input_schema: { type: 'object', properties: { value: { type: 'string' } } } },
        wipe: { name: 'Wipe', kind: 'write', input_schema: { type: 'object', properties: {} } },
      })}
      WHERE organization_id = ${personal.id} AND key = ${CONNECTOR_KEY}
    `;
    const connection = await createTestConnection({
      organization_id: personal.id, connector_key: CONNECTOR_KEY, created_by: sender.id, visibility: 'private',
    });
    // The personal workspace blocks one action. The other has no rule there,
    // so its default (ask) applies, even though the home workspace would run
    // the same action without asking. Neither runs here.
    await upsertEntityApprovalPolicy(home.id, {
      resourceClass: 'connector_action', operationKey: `${CONNECTOR_KEY}::echo`, effects: { execute: 'auto' },
    });
    await upsertEntityApprovalPolicy(personal.id, {
      resourceClass: 'connector_action', operationKey: `${CONNECTOR_KEY}::wipe`, effects: { execute: 'deny' },
    });

    const call = await openTurnSession(home.slug, await gatewayToken(home.id, SENDER_PLATFORM_ID, { isDirect: true }));
    const execute = (operation: string) => call('run_sdk', sdk(
      `const ws = await client.org('${personal.slug}');
       return await ws.operations.execute({ connection_id: ${connection.id}, operation_key: '${operation}', input: {} });`,
    ));

    const asked = await execute('echo');
    expect(asked.text).toContain('pending_approval');
    const [run] = await getTestDb()<{ id: number; organization_id: string; status: string }>`
      SELECT id, organization_id, status FROM runs
      WHERE connection_id = ${connection.id} AND action_key = 'echo'
    `;
    expect(asked.text).toContain(`/${personal.slug}/events?run_ids=`);
    expect(run).toMatchObject({ organization_id: personal.id, status: 'pending' });

    const blocked = await execute('wipe');
    expect(blocked.text).toContain("Policy blocks 'wipe' for this principal.");
    const wiped = await getTestDb()`SELECT 1 FROM runs WHERE connection_id = ${connection.id} AND action_key = 'wipe' AND status <> 'failed'`;
    expect(wiped).toHaveLength(0);

    // The sender owns the personal workspace, but the turn is not a human
    // web session, so it cannot approve its own request there.
    const approved = await call('run_sdk', sdk(
      `const ws = await client.org('${personal.slug}'); return await ws.operations.approve({ run_id: ${run!.id} });`,
    ));
    expect(approved.text).toContain('requires a human web session');
    const [after] = await getTestDb()<{ status: string }>`SELECT status FROM runs WHERE id = ${run!.id}`;
    expect(after?.status).toBe('pending');
  });
});
