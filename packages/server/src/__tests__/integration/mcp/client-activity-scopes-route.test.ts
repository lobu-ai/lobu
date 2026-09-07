import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { recordMcpConversationActivity } from '../../../lobu/stores/mcp-client-conversations';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('client activity scopes route', () => {
  let organizationId: string;
  let organizationSlug: string;
  let userId: string;
  let token: string;
  let chatgptClientId: string;
  let claudeClientId: string;
  let commandClientId: string;

  function context(overrides: Partial<ToolContext>): ToolContext {
    return {
      organizationId,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      clientId: chatgptClientId,
      scopes: ['mcp:read', 'mcp:write'],
      ...overrides,
    } as ToolContext;
  }

  async function record(overrides: Partial<ToolContext>) {
    await recordMcpConversationActivity({
      ctx: context(overrides),
      toolName: 'query_sdk',
      failed: false,
    });
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const organization = await createTestOrganization({
      name: 'Client activity scopes',
      slug: 'client-activity-scopes',
    });
    organizationId = organization.id;
    organizationSlug = organization.slug;

    const user = await createTestUser({ email: 'client-activity@example.com' });
    userId = user.id;
    await addUserToOrganization(userId, organizationId, 'owner');

    chatgptClientId = (
      await createTestOAuthClient({ client_name: 'ChatGPT', owner_user_id: userId })
    ).client_id;
    claudeClientId = (
      await createTestOAuthClient({ client_name: 'Claude', owner_user_id: userId })
    ).client_id;
    commandClientId = (
      await createTestOAuthClient({
        client_name: 'Lobu CLI',
        software_id: 'lobu-cli',
        owner_user_id: userId,
      })
    ).client_id;
    token = (
      await createTestAccessToken(userId, organizationId, chatgptClientId, {
        scope: 'mcp:read mcp:write',
      })
    ).token;

    // A deployed registration may still carry the retired metadata until the
    // one-time migration runs. The API must not reinterpret it as assignment.
    await getDb()`
      UPDATE oauth_clients
      SET metadata = COALESCE(metadata, '{}'::jsonb)
        || '{"last_agent_id":"legacy-agent"}'::jsonb
      WHERE id = ${chatgptClientId}
    `;

    await record({ mcpConversationId: 'chatgpt-conversation-a', mcpSessionId: 'transport-a1' });
    await record({ mcpConversationId: 'chatgpt-conversation-a', mcpSessionId: 'transport-a2' });
    await record({ mcpConversationId: 'chatgpt-conversation-b', mcpSessionId: 'transport-b1' });
    await record({ mcpSessionId: 'chatgpt-transport-only' });
    await record({
      clientId: claudeClientId,
      mcpSessionId: 'claude-transport',
    });
    await record({
      clientId: commandClientId,
      mcpSessionId: 'command-transport',
    });
  });

  it('keeps distinct ChatGPT conversations separate while combining only their reconnecting transports', async () => {
    const response = await get(
      `/api/${organizationSlug}/clients/activity-scopes?client_ids=${chatgptClientId}`,
      { token }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scopes: Array<{
        activityId: string;
        activityKind: 'conversation' | 'session';
        clientId: string;
        callCount: number;
      }>;
    };

    expect(body.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: 'chatgpt-conversation-a',
          activityKind: 'conversation',
          clientId: chatgptClientId,
          callCount: 2,
        }),
        expect.objectContaining({
          activityId: 'chatgpt-conversation-b',
          activityKind: 'conversation',
          clientId: chatgptClientId,
          callCount: 1,
        }),
        expect.objectContaining({
          activityId: 'chatgpt-transport-only',
          activityKind: 'session',
          clientId: chatgptClientId,
          callCount: 1,
        }),
      ])
    );
    expect(body.scopes.filter((scope) => scope.activityKind === 'conversation')).toHaveLength(2);
    expect(body.scopes.some((scope) => scope.activityId === 'claude-transport')).toBe(false);
    expect(body.scopes.some((scope) => scope.activityId === 'command-transport')).toBe(false);
  });

  it('classifies rows from their recorded structure rather than client-name or id-format guesses', async () => {
    const rows = await getDb()<Array<{
      conversation_id: string;
      activity_kind: 'conversation' | 'session';
    }>>`
      SELECT conversation_id, activity_kind
      FROM mcp_client_conversations
      WHERE organization_id = ${organizationId}
        AND conversation_id IN ('chatgpt-conversation-a', 'chatgpt-transport-only', 'claude-transport')
      ORDER BY conversation_id
    `;
    expect(rows).toEqual([
      { conversation_id: 'chatgpt-conversation-a', activity_kind: 'conversation' },
      { conversation_id: 'chatgpt-transport-only', activity_kind: 'session' },
      { conversation_id: 'claude-transport', activity_kind: 'session' },
    ]);
  });

  it('filters conversation and transport-session scopes explicitly', async () => {
    const conversations = await get(
      `/api/${organizationSlug}/clients/activity-scopes?client_ids=${chatgptClientId}&activity_kind=conversation`,
      { token }
    );
    const conversationBody = (await conversations.json()) as {
      scopes: Array<{ activityId: string; activityKind: string }>;
    };
    expect(conversationBody.scopes).toHaveLength(2);
    expect(conversationBody.scopes.every((scope) => scope.activityKind === 'conversation')).toBe(true);

    const sessions = await get(
      `/api/${organizationSlug}/clients/activity-scopes?client_ids=${chatgptClientId}&activity_kind=session`,
      { token }
    );
    const sessionBody = (await sessions.json()) as {
      scopes: Array<{ activityId: string; activityKind: string }>;
    };
    expect(sessionBody.scopes.map((scope) => scope.activityId)).toEqual([
      'chatgpt-transport-only',
    ]);
  });

  it('excludes command clients before applying the Recent result limit', async () => {
    const sql = getDb();
    await sql`
      UPDATE mcp_client_conversations
      SET last_activity_at = now() + interval '1 minute'
      WHERE organization_id = ${organizationId}
        AND conversation_id = 'command-transport'
    `;
    const response = await get(
      `/api/${organizationSlug}/clients/activity-scopes?exclude_command_clients=true&limit=1`,
      { token }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scopes: Array<{ activityId: string }>;
    };
    expect(body.scopes).toHaveLength(1);
    expect(body.scopes[0]?.activityId).not.toBe('command-transport');
  });

  it('has no legacy sessions API payload', async () => {
    const response = await get(`/api/${organizationSlug}/clients/sessions`, { token });
    const body = (await response.json()) as Record<string, unknown>;
    // Unknown GET paths currently return the server discovery document. The
    // load-bearing assertion is that no legacy route or sessions payload remains.
    expect(body.sessions).toBeUndefined();
    expect(body.mcp_endpoint).toEqual(expect.any(String));
  });

  it('rejects unauthenticated activity reads', async () => {
    const response = await get(`/api/${organizationSlug}/clients/activity-scopes`);
    expect(response.status).toBe(401);
  });

  it('treats MCP registrations as Connected Apps rather than agent assignments', async () => {
    const response = await get(`/api/${organizationSlug}/clients`, { token });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      clients: Array<Record<string, unknown> & { id: string; kind: string }>;
    };
    const chatgpt = body.clients.find((client) => client.id === chatgptClientId)!;
    expect(chatgpt.kind).toBe('mcp');
    expect(chatgpt).not.toHaveProperty('assignedAgentId');
    expect(chatgpt).not.toHaveProperty('assignedAgentName');

    const filtered = await get(
      `/api/${organizationSlug}/clients?agentId=legacy-agent`,
      { token }
    );
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as {
      clients: Array<{ kind: string }>;
    };
    expect(filteredBody.clients.some((client) => client.kind === 'mcp')).toBe(false);
  });
});
