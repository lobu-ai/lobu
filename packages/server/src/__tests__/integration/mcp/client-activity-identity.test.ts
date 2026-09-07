import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { recordMcpConversationActivity, setCurrentMcpConversationTitle } from '../../../lobu/stores/mcp-client-conversations';
import { resolveActionOrigin } from '../../../notifications/action-origin';
import { resolveMcpActivitySessionIds } from '../../../tools/get_content/mcp-activity-filter';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import { addUserToOrganization, createTestAccessToken, createTestOAuthClient, createTestOrganization, createTestUser, seedSystemEntityTypes } from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('MCP activity actor identity', () => {
  let org: { id: string; slug: string };
  let secondOrg: { id: string; slug: string };
  let userId: string;
  let otherUserId: string;
  let clientId: string;
  let token: string;

  function context(actor: string, activity: string, workspace = org.id): ToolContext {
    return {
      organizationId: workspace, userId: actor, memberRole: 'owner',
      isAuthenticated: true, tokenType: 'oauth', clientId,
      mcpConversationId: activity, mcpSessionId: `${activity}-${actor}`,
      scopes: ['mcp:read', 'mcp:write'],
    } as ToolContext;
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ slug: 'activity-actor-first' });
    secondOrg = await createTestOrganization({ slug: 'activity-actor-second' });
    userId = (await createTestUser({ email: 'activity-actor@example.test' })).id;
    otherUserId = (await createTestUser({ email: 'activity-other@example.test' })).id;
    await addUserToOrganization(userId, org.id, 'owner');
    await addUserToOrganization(otherUserId, org.id, 'owner');
    await addUserToOrganization(userId, secondOrg.id, 'owner');
    clientId = (await createTestOAuthClient({ owner_user_id: userId })).client_id;
    token = (await createTestAccessToken(userId, org.id, clientId, { scope: 'mcp:read mcp:write' })).token;
  });

  it('separates two users with the same client-supplied conversation ID', async () => {
    const first = context(userId, 'shared-host-id');
    const second = context(otherUserId, 'shared-host-id');
    await recordMcpConversationActivity({ ctx: first, toolName: 'query_sdk', failed: false });
    await recordMcpConversationActivity({ ctx: second, toolName: 'run_sdk', failed: true });
    await setCurrentMcpConversationTitle(first, 'My conversation');
    await setCurrentMcpConversationTitle(second, 'Other private conversation');
    const rows = await getDb()`SELECT user_id, title, call_count, failed_count, transport_session_ids
      FROM mcp_client_conversations WHERE client_identity = ${clientId}
        AND conversation_id = 'shared-host-id' ORDER BY user_id`;
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.user_id === userId)).toMatchObject({
      title: 'My conversation', call_count: 1, failed_count: 0, transport_session_ids: [first.mcpSessionId],
    });
    expect(rows.find(row => row.user_id === otherUserId)).toMatchObject({
      title: 'Other private conversation', call_count: 1, failed_count: 1, transport_session_ids: [second.mcpSessionId],
    });
    expect(await resolveMcpActivitySessionIds(getDb(), userId, [clientId], 'shared-host-id')).toEqual([first.mcpSessionId]);
    expect(await resolveMcpActivitySessionIds(getDb(), otherUserId, [clientId], 'shared-host-id')).toEqual([second.mcpSessionId]);
    await expect(resolveMcpActivitySessionIds(getDb(), null, [clientId], 'shared-host-id')).rejects.toThrow(/not found/i);
    expect(await resolveActionOrigin(first)).toMatchObject({ label: expect.stringContaining('My conversation') });
    expect(await resolveActionOrigin(second)).toMatchObject({ label: expect.stringContaining('Other private conversation') });
    const response = await get(`/api/me/clients/activity-scopes`, { token });
    expect(response.status).toBe(200);
    const body = await response.json() as { scopes: Array<{ title: string }> };
    expect(body.scopes.map(row => row.title)).toContain('My conversation');
    expect(body.scopes.map(row => row.title)).not.toContain('Other private conversation');
  });

  it('keeps one actor activity when the execution target changes', async () => {
    await recordMcpConversationActivity({ ctx: context(userId, 'two-targets'), toolName: 'run_sdk', failed: false });
    await recordMcpConversationActivity({ ctx: context(userId, 'two-targets', secondOrg.id), toolName: 'query_sdk', failed: false });
    const rows = await getDb()`SELECT organization_id, call_count FROM mcp_client_conversations
      WHERE user_id = ${userId} AND conversation_id = 'two-targets'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: null, call_count: 2 });
    const response = await get(`/api/me/clients/activity-scopes`, { token });
    const body = await response.json() as { scopes: Array<{ activityId: string; callCount: number }> };
    expect(body.scopes.find(row => row.activityId === 'two-targets')?.callCount).toBe(2);
  });

  it('materializes workspace-free titles and concurrent calls in Postgres', async () => {
    const ctx = { ...context(userId, 'unbound-title'), organizationId: null };
    await setCurrentMcpConversationTitle(ctx, 'Account conversation');
    await Promise.all(Array.from({ length: 8 }, (_, index) => recordMcpConversationActivity({
      ctx: { ...ctx, mcpSessionId: `reconnect-${index}` }, toolName: 'list_organizations', failed: index === 0,
    })));
    const [row] = await getDb()`SELECT organization_id, title, call_count, failed_count,
      transport_session_ids, activity_kind FROM mcp_client_conversations
      WHERE user_id = ${userId} AND conversation_id = 'unbound-title'`;
    expect(row).toMatchObject({ organization_id: null, title: 'Account conversation',
      call_count: 8, failed_count: 1, activity_kind: 'conversation' });
    expect(row.transport_session_ids).toHaveLength(9);
  });

  it('does not create personal Recent rows for an unattributed caller', async () => {
    const ctx = { ...context(userId, 'anonymous-activity'), userId: null };
    await recordMcpConversationActivity({ ctx, toolName: 'query_sdk', failed: false });
    expect(await getDb()`SELECT 1 FROM mcp_client_conversations WHERE conversation_id = 'anonymous-activity'`).toHaveLength(0);
    await expect(setCurrentMcpConversationTitle(ctx, 'No owner')).rejects.toThrow(/user/i);
  });
});
