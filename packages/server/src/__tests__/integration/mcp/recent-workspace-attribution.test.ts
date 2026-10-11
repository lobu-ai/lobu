import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { type AuthContext, executeTool } from '../../../tools/execute';
import { issueTemplateActionCapability } from '../../../interactions/template-action-capability';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('Recent attributes account conversations to the workspaces they ran in', () => {
  let auth: AuthContext;
  let token: string;
  let first: { id: string; slug: string };
  let second: { id: string; slug: string };

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    first = await createTestOrganization({ slug: 'recent-attribution-first' });
    second = await createTestOrganization({ slug: 'recent-attribution-second' });
    const user = await createTestUser({ email: 'recent-attribution@example.test' });
    await addUserToOrganization(user.id, first.id, 'owner');
    await addUserToOrganization(user.id, second.id, 'owner');
    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, first.id, client.client_id, { scope: 'mcp:read mcp:write' })).token;
    auth = {
      organizationId: null, tokenOrganizationId: null, userId: user.id,
      memberRole: null, agentId: null, requestedAgentId: null, isAuthenticated: true,
      clientId: client.client_id, tokenType: 'oauth', scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      requestUrl: 'http://localhost/mcp', baseUrl: 'http://localhost', scopedToOrg: false,
      allowCrossOrg: true, grantedOrganizationIds: [first.id, second.id], directSearchFederation: true,
      mcpSessionId: 'recent-attribution-transport', mcpConversationId: null,
    };
  });

  const run = async (conversation: string, tool: 'query_sdk' | 'run_sdk', body: string) => {
    const result = (await executeTool(
      tool,
      { script: `export default async (ctx, client) => { ${body} };` },
      {} as Env,
      { ...auth, mcpConversationId: conversation },
    )) as { success: boolean; error?: unknown };
    return result;
  };

  const recent = async (organizationId?: string) => {
    const query = organizationId ? `?organization_id=${organizationId}` : '';
    const response = await get(`/api/me/clients/activity-scopes${query}`, { token });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scopes: Array<{ activityId: string; organizationId: string | null }>;
    };
    return body.scopes;
  };

  const workspacesOf = async (conversation: string) =>
    (await getDb()`
      SELECT organization_id FROM mcp_client_conversation_workspaces
      WHERE user_id = ${auth.userId} AND conversation_id = ${conversation}
    `).map((row) => row.organization_id as string).sort();

  it('shows a read-only research conversation only in the workspace it read', async () => {
    const result = await run('research-first', 'query_sdk',
      `const ws = await client.org('${first.slug}'); return ws.entities.list({});`);
    expect(result.success, JSON.stringify(result.error)).toBe(true);

    expect(await workspacesOf('research-first')).toEqual([first.id]);
    expect((await recent(first.id)).find((s) => s.activityId === 'research-first'))
      .toMatchObject({ organizationId: first.id });
    expect((await recent(second.id)).map((s) => s.activityId)).not.toContain('research-first');

    // The workspace's activity page has a row for the read, naming only the
    // methods that ran there.
    const [summary] = await getDb()`
      SELECT payload_data, metadata FROM events
      WHERE organization_id = ${first.id}
        AND metadata->>'mcp_conversation_id' = 'research-first'
        AND metadata->>'event_type' = 'tool_invocation.workspace_activity'
    `;
    expect(summary.payload_data).toEqual({
      tool_name: 'query_sdk', sdk_methods: ['entities.list'], success: true,
    });
    expect(summary.metadata.mcp_session_id).toBe('recent-attribution-transport');
  });

  it('shows a conversation in each workspace it ran in', async () => {
    const result = await run('two-workspaces', 'run_sdk', `
      await (await client.org('${first.slug}')).entities.list({});
      await (await client.org('${second.slug}')).knowledge.save({ content: 'Recent attribution note', semantic_type: 'note' });
    `);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(await workspacesOf('two-workspaces')).toEqual([first.id, second.id].sort());
    expect((await recent(first.id)).map((s) => s.activityId)).toContain('two-workspaces');
    expect((await recent(second.id)).map((s) => s.activityId)).toContain('two-workspaces');
  });

  it('does not attribute a workspace that was only selected or whose call failed', async () => {
    const selected = await run('selected-only', 'query_sdk',
      `await client.org('${second.slug}'); return client.organizations.list();`);
    expect(selected.success, JSON.stringify(selected.error)).toBe(true);
    expect(await workspacesOf('selected-only')).toEqual([]);

    const failed = await run('failed-call', 'query_sdk',
      `return (await client.org('${second.slug}')).entities.get({ entity_id: 999999999 });`);
    expect(failed.success).toBe(false);
    expect(await workspacesOf('failed-call')).toEqual([]);

    // Account-only activity is listed for the account, with no workspace.
    const account = await recent();
    expect(account.find((s) => s.activityId === 'selected-only')).toMatchObject({ organizationId: null });
    expect((await recent(first.id)).map((s) => s.activityId)).not.toContain('selected-only');
    expect((await recent(second.id)).map((s) => s.activityId)).not.toContain('selected-only');
  });

  it('attributes a direct workspace-targeted call without a duplicate summary row', async () => {
    await executeTool(
      'save_memory',
      { org_slug: second.slug, semantic_type: 'note', content: 'Direct targeted note' },
      {} as Env,
      { ...auth, mcpConversationId: 'direct-target' },
    );
    expect(await workspacesOf('direct-target')).toEqual([second.id]);
    const summaries = await getDb()`
      SELECT 1 FROM events
      WHERE metadata->>'mcp_conversation_id' = 'direct-target'
        AND metadata->>'event_type' = 'tool_invocation.workspace_activity'
    `;
    expect(summaries).toHaveLength(0);
  });

  it('shows a federated search only in the workspaces that returned results', async () => {
    const federated = (await executeTool(
      'search_memory',
      { query: 'Recent attribution note', include_content: true },
      {} as Env,
      { ...auth, mcpConversationId: 'federated-search' },
    )) as { content?: Array<{ workspace_slug: string }> };
    expect(federated.content?.map((c) => c.workspace_slug)).toContain(second.slug);
    expect(await workspacesOf('federated-search')).toEqual([second.id]);
    const summaries = await getDb()`
      SELECT organization_id, payload_data FROM events
      WHERE metadata->>'mcp_conversation_id' = 'federated-search'
        AND metadata->>'event_type' = 'tool_invocation.workspace_activity'
    `;
    expect(summaries.map((row) => ({ ...row }))).toEqual([{
      organization_id: second.id,
      payload_data: { tool_name: 'search_memory', sdk_methods: ['search'], success: true },
    }]);

    // Naming a workspace targets it even when nothing matched there.
    await executeTool(
      'search_memory',
      { query: 'Recent attribution note', workspace: first.slug },
      {} as Env,
      { ...auth, mcpConversationId: 'narrowed-search' },
    );
    expect(await workspacesOf('narrowed-search')).toEqual([first.id]);
  });

  it('shows a card action clicked from an account session in the workspace it ran in', async () => {
    const entity = await createTestEntity({
      name: 'Recent attribution decision', entity_type: 'recent-decision',
      organization_id: first.id, created_by: auth.userId!,
    });
    await getDb()`
      UPDATE entity_types SET event_kinds = ${getDb().json({
        decision: {
          jsonTemplate: { type: 'button', props: { label: 'Ship', value: 'ship', onClick: '@choose' } },
          interactions: { choose: { emits: 'decision_cast' } },
        },
        decision_cast: { description: 'A recorded decision' },
      })} WHERE organization_id = ${first.id} AND slug = 'recent-decision'
    `;
    const source = await insertEvent({
      entityIds: [entity.id], organizationId: first.id, originId: 'recent-attribution-decision',
      payloadType: 'empty', semanticType: 'decision', payloadData: {},
    });
    const session = { ...auth, mcpConversationId: 'card-action' } as typeof auth & {
      userId: string; clientId: string; mcpSessionId: string;
    };
    // The card was rendered from the workspace, which the capability records.
    const capability = issueTemplateActionCapability([source.id], { ...session, organizationId: first.id });
    const result = (await executeTool(
      'invoke_event_action',
      { source_event_id: source.id, action: 'choose', value: 'ship', interaction_id: 'recent-card-action' },
      {} as Env,
      { ...session, mcpAppEventActionCapability: capability },
    )) as { created?: boolean };
    expect(result.created).toBe(true);
    expect(await workspacesOf('card-action')).toEqual([first.id]);
  });
});
