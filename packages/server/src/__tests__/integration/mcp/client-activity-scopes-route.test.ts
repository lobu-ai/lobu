import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { recordToolInvocationAudit } from '../../../tools/audit';
import { setCurrentMcpConversationTitle } from '../../../lobu/stores/mcp-client-conversations';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  createTestSession,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('client activity scopes route', () => {
  let organizationId: string;
  let organizationSlug: string;
  let userId: string;
  let token: string;
  let cookie: string;
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
    await recordToolInvocationAudit({
      ctx: context(overrides),
      toolName: 'query_sdk',
      args: { script: 'return 1;' }, result: { success: true }, durationMs: 1,
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
    cookie = (await createTestSession(userId)).cookieHeader;
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
      `/api/me/clients/activity-scopes?client_ids=${chatgptClientId}`,
      { cookie }
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
      activity_id: string;
      activity_kind: 'conversation' | 'session';
    }>>`
      SELECT activity_id, activity_kind
      FROM user_mcp_activities
      WHERE user_id = ${userId}
        AND activity_id IN ('chatgpt-conversation-a', 'chatgpt-transport-only', 'claude-transport')
      ORDER BY activity_id
    `;
    expect(rows).toEqual([
      { activity_id: 'chatgpt-conversation-a', activity_kind: 'conversation' },
      { activity_id: 'chatgpt-transport-only', activity_kind: 'session' },
      { activity_id: 'claude-transport', activity_kind: 'session' },
    ]);
  });

  it('filters conversation and transport-session scopes explicitly', async () => {
    const conversations = await get(
      `/api/me/clients/activity-scopes?client_ids=${chatgptClientId}&activity_kind=conversation`,
      { cookie }
    );
    const conversationBody = (await conversations.json()) as {
      scopes: Array<{ activityId: string; activityKind: string }>;
    };
    expect(conversationBody.scopes).toHaveLength(2);
    expect(conversationBody.scopes.every((scope) => scope.activityKind === 'conversation')).toBe(true);

    const sessions = await get(
      `/api/me/clients/activity-scopes?client_ids=${chatgptClientId}&activity_kind=session`,
      { cookie }
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
      UPDATE user_mcp_activities
      SET last_activity_at = now() + interval '1 minute'
      WHERE user_id = ${userId}
        AND activity_id = 'command-transport'
    `;
    const response = await get(
      `/api/me/clients/activity-scopes?exclude_command_clients=true&limit=1`,
      { cookie }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scopes: Array<{ activityId: string }>;
    };
    expect(body.scopes).toHaveLength(1);
    expect(body.scopes[0]?.activityId).not.toBe('command-transport');
  });

  it('removes the organization activity endpoint and legacy sessions payload', async () => {
    const retired = await get(`/api/${organizationSlug}/clients/activity-scopes`, { token });
    expect((await retired.json()).scopes).toBeUndefined();
    const response = await get(`/api/${organizationSlug}/clients/sessions`, { token });
    const body = (await response.json()) as Record<string, unknown>;
    // Unknown GET paths currently return the server discovery document. The
    // load-bearing assertion is that no legacy route or sessions payload remains.
    expect(body.sessions).toBeUndefined();
    expect(body.mcp_endpoint).toEqual(expect.any(String));
  });

  it('rejects unauthenticated activity reads', async () => {
    const response = await get(`/api/me/clients/activity-scopes`);
    expect(response.status).toBe(401);
  });

  it('isolates summaries by user even for a shared client and activity ID', async () => {
    const other = await createTestUser({ email: 'other-history@example.test' });
    await addUserToOrganization(other.id, organizationId, 'admin');
    const otherCookie = (await createTestSession(other.id)).cookieHeader;
    await record({ userId: other.id, mcpConversationId: 'chatgpt-conversation-a', mcpSessionId: 'other-transport' });
    const response = await get('/api/me/clients/activity-scopes', { cookie: otherCookie });
    expect((await response.json()).scopes).toEqual([
      expect.objectContaining({ activityId: 'chatgpt-conversation-a', callCount: 1 }),
    ]);
    expect((await get('/api/me/clients/activity-scopes', { token })).status).toBe(401);
  });

  it('records summaries without an execution workspace and keeps them after membership removal', async () => {
    await record({ organizationId: null as never, mcpSessionId: 'account-session' });
    await getDb()`DELETE FROM member WHERE "userId" = ${userId} AND "organizationId" = ${organizationId}`;
    const response = await get('/api/me/clients/activity-scopes', { cookie });
    expect(response.status).toBe(200);
    expect((await response.json()).scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId: 'account-session' }),
    ]));
    await addUserToOrganization(userId, organizationId, 'owner');
  });

  it('updates titles for the calling user and excludes them from workspace cards', async () => {
    const { resolveActionOrigin } = await import('../../../notifications/action-origin');
    const ctx = context({ mcpConversationId: 'private-title', mcpSessionId: 'private-transport' });
    await setCurrentMcpConversationTitle(ctx, 'Private account title');
    await record(ctx);
    const response = await get(`/api/me/clients/activity-scopes?client_ids=${chatgptClientId}`, { cookie });
    expect((await response.json()).scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId: 'private-title', title: 'Private account title', callCount: 1 }),
    ]));
    expect(await resolveActionOrigin(ctx)).toEqual({ kind: 'conversation', label: 'ChatGPT conversation' });
  });

  it('rolls the invocation back if its summary cannot be written', async () => {
    const sql = getDb();
    await sql.unsafe("ALTER TABLE user_mcp_activities ADD CONSTRAINT history_test_summary_failure CHECK (activity_id <> 'summary-failure')");
    try {
      await record({ mcpSessionId: 'summary-failure' });
      const calls = await sql`SELECT id FROM user_tool_invocations WHERE user_id = ${userId} AND activity_id = 'summary-failure'`;
      expect(calls).toHaveLength(0);
    } finally {
      await sql.unsafe('ALTER TABLE user_mcp_activities DROP CONSTRAINT history_test_summary_failure');
    }
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
