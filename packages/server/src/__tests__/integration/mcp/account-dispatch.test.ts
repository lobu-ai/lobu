import { beforeAll, describe, expect, it } from 'vitest';
import { initWorkspaceProvider } from '../../../workspace';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { type AuthContext, executeTool } from '../../../tools/execute';
import { get, post, mcpRequest } from '../../setup/test-helpers';
import { cleanupTestDatabase } from '../../setup/test-db';
import { addUserToOrganization, createTestAccessToken, createTestSession, createTestOAuthClient, createTestOrganization, createTestUser, seedSystemEntityTypes } from '../../setup/test-fixtures';

describe('account MCP dispatch', () => {
  let auth: AuthContext;
  let first: { id: string; slug: string };
  let second: { id: string; slug: string };
  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    first = await createTestOrganization({ slug: 'account-dispatch-first' });
    second = await createTestOrganization({ slug: 'account-dispatch-second' });
    const user = await createTestUser({ email: 'account-dispatch@example.test' });
    await addUserToOrganization(user.id, first.id, 'owner');
    await addUserToOrganization(user.id, second.id, 'member');
    const client = await createTestOAuthClient();
    auth = {
      organizationId: null, tokenOrganizationId: null, userId: user.id,
      memberRole: null, agentId: null, requestedAgentId: null, isAuthenticated: true,
      clientId: client.client_id, tokenType: 'oauth', scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      requestUrl: 'http://localhost/mcp', baseUrl: 'http://localhost', scopedToOrg: false,
      allowCrossOrg: true, grantedOrganizationIds: [first.id, second.id], directSearchFederation: true,
      mcpSessionId: 'account-transport', mcpConversationId: 'account-conversation',
    };
  });
  const call = (tool: string, args: Record<string, unknown>, ctx = auth) => executeTool(tool, args, {} as Env, ctx) as Promise<any>;

  it('discovers SDK methods and runs account methods with no implicit workspace', async () => {
    const docs = await call('search_sdk', { query: 'organizations.list' });
    expect(docs.results.length).toBeGreaterThan(0);
    const result = await call('query_sdk', { script: 'export default async (ctx, client) => ({ current: await client.organizations.current(), count: (await client.organizations.list()).length, workspace: ctx.organization_id });' });
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(result).toMatchObject({ success: true, return_value: { current: null, count: 2, workspace: null } });
    const title = await call('run_sdk', { script: 'export default async (ctx, client) => client.conversations.setTitle({ title: "Account activity" });' });
    expect(title).toMatchObject({ success: true, return_value: { title: 'Account activity' } });
    const [activity] = await getDb()`SELECT organization_id, title FROM mcp_client_conversations WHERE user_id=${auth.userId} AND conversation_id='account-conversation'`;
    expect(activity).toMatchObject({ organization_id: null, title: 'Account activity' });
    const [audit] = await getDb()`SELECT organization_id, created_by FROM events WHERE client_id=${auth.clientId} AND payload_data->>'tool_name'='run_sdk' ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ organization_id: null, created_by: auth.userId });
  });

  it('requires explicit SDK targets and composes two authorized workspaces', async () => {
    const missing = await call('query_sdk', { script: 'export default async (ctx, client) => client.entities.list({});' });
    expect(missing.success).toBe(false);
    expect(missing.error.message).toMatch(/client\.org/);
    const selected = await call('query_sdk', { script: `export default async (ctx, client) => { const a = await client.org('${first.slug}'); const b = await client.org('${second.slug}'); return [(await a.organizations.current()).id, (await b.organizations.current()).id]; };` });
    expect(selected.success, JSON.stringify(selected.error)).toBe(true);
    expect(selected).toMatchObject({ success: true, return_value: [first.id, second.id] });
    const denied = await call('query_sdk', { script: `export default async (ctx, client) => (await client.org('${second.slug}')).organizations.current();` }, { ...auth, grantedOrganizationIds: [first.id] });
    expect(denied.success).toBe(false);
  });

  it('searches grants even without an anchor and refuses untargeted writes/SQL', async () => {
    const result = await call('search_memory', { query: 'account dispatch probe' });
    expect(result.coverage?.scope).toBe('all_granted');
    await expect(call('save_memory', { content: 'No target' })).rejects.toThrow(/workspace|org_slug/i);
    await expect(call('query_sql', { sql: 'SELECT 1' })).rejects.toThrow(/workspace|org_slug/i);
  });
  it('targets direct saves and SQL with the selected workspace role and audit target', async () => {
    const saved = await call('save_memory', { org_slug: second.slug, semantic_type: 'note', content: 'Explicit account memory', title: 'Targeted note' });
    expect(saved.id).toBeDefined();
    const [event] = await getDb()`SELECT organization_id FROM events WHERE id=${saved.id}`;
    expect(event.organization_id).toBe(second.id);
    const queried = await call('query_sql', { org_slug: second.slug, sql: 'SELECT 7 AS value' });
    expect(queried.rows).toEqual([{ value: 7 }]);
    const [audit] = await getDb()`SELECT organization_id FROM events WHERE client_id=${auth.clientId} AND payload_data->>'tool_name'='query_sql' ORDER BY id DESC LIMIT 1`;
    expect(audit.organization_id).toBe(second.id);
    await expect(call('save_memory', { org_slug: second.slug, content: 'Denied target' }, { ...auth, grantedOrganizationIds: [first.id] })).rejects.toThrow(/not available/);
  });

  it('advertises required workspace targets only on account MCP and returns actionable errors', async () => {
    const token = await createTestAccessToken(auth.userId!, null, auth.clientId!, {
      grantedOrganizationIds: [first.id, second.id], scope: 'mcp:read mcp:write',
    });
    for (const orgSlug of [undefined, first.slug, undefined]) {
      const listed = await mcpRequest('tools/list', {}, { token: token.token, orgSlug });
      for (const [name, field] of [['save_memory', 'org_slug'], ['query_sql', 'org_slug'], ['get_approval', 'organization']]) {
        const tool = listed.result.tools.find((item: any) => item.name === name);
        expect(tool, name).toBeDefined();
        // A required key absent from `properties` is an invalid schema hosts reject.
        expect(tool.inputSchema.properties?.[field!], name).toBeDefined();
        expect(tool.inputSchema.required?.includes(field) ?? false, name).toBe(!orgSlug);
      }
    }
    const failed = await mcpRequest('tools/call', {
      name: 'save_memory', arguments: { content: 'Synthetic untargeted note', semantic_type: 'note' },
    }, { token: token.token });
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0].text).toMatch(/workspace|org_slug/i);
    expect(failed.result.structuredContent.error).toMatchObject({
      code: 'VALIDATION', retryable: false, call_id: expect.any(String),
    });
    // An ungranted target is a denial, not malformed input: it must carry the
    // same correlated taxonomy rather than the SDK's untranslated typed error.
    const denied = await mcpRequest('tools/call', {
      name: 'save_memory',
      arguments: { org_slug: 'unavailable-synthetic-workspace', content: 'Synthetic untargeted note', semantic_type: 'note' },
    }, { token: token.token });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.structuredContent.error).toMatchObject({
      code: 'PERMISSION', retryable: false, call_id: expect.any(String),
    });
  });

  it('audits early missing, invalid, and unauthorized targets privately without saving content', async () => {
    for (const args of [
      { content: 'Synthetic rejected note', semantic_type: 'note' },
      { org_slug: '', content: 'Synthetic rejected note', semantic_type: 'note' },
      { org_slug: 'unavailable-synthetic-workspace', content: 'Synthetic rejected note', semantic_type: 'note' },
    ]) {
      const [before] = await getDb()`SELECT count(*)::int AS n FROM events WHERE client_id=${auth.clientId} AND origin_type='tool_invocation'`;
      await expect(call('save_memory', args)).rejects.toThrow();
      const [after] = await getDb()`SELECT count(*)::int AS n FROM events WHERE client_id=${auth.clientId} AND origin_type='tool_invocation'`;
      expect(after.n).toBe(before.n + 1);
      const [audit] = await getDb()`SELECT organization_id, created_by, payload_data FROM events WHERE client_id=${auth.clientId} AND origin_type='tool_invocation' ORDER BY id DESC LIMIT 1`;
      expect(audit.organization_id).toBeNull();
      expect(audit.created_by).toBe(auth.userId);
      expect(audit.payload_data.success).toBe(false);
      expect(JSON.stringify(audit.payload_data)).not.toContain('Synthetic rejected note');
    }
  });

  it('opens actor history through the account HTTP route without inheriting a token workspace', async () => {
    await call('query_sdk', { script: 'export default async () => "Actor private history";' });
    const [event] = await getDb()`SELECT id FROM events WHERE client_id=${auth.clientId} AND created_by=${auth.userId} ORDER BY id DESC LIMIT 1`;
    const session = await createTestSession(auth.userId!);
    const accountToken = await createTestAccessToken(auth.userId!, null, auth.clientId!, {
      grantedOrganizationIds: [first.id, second.id], scope: 'mcp:read',
    });
    const boundToken = await createTestAccessToken(auth.userId!, first.id, auth.clientId!, {
      grantedOrganizationIds: [first.id], scope: 'mcp:read',
    });
    for (const credentials of [{ cookie: session.cookieHeader }, { token: accountToken.token }, { token: boundToken.token }]) {
      const response = await post('/api/me/read_knowledge', { ...credentials, body: { content_ids: [Number(event.id)] } });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.content.map((item: { id: number }) => item.id)).toEqual([Number(event.id)]);
      expect(JSON.stringify(body)).toContain('Actor private history');
      const recent = await get('/api/me/clients/activity-scopes', credentials);
      expect(recent.status).toBe(200);
      expect((await recent.json()).scopes.some((row: { activityId: string }) => row.activityId === 'account-conversation')).toBe(true);
    }
    const stranger = await createTestUser({ email: 'account-reader-other@example.test' });
    await addUserToOrganization(stranger.id, first.id, 'owner');
    const strangerSession = await createTestSession(stranger.id);
    const denied = await post('/api/me/read_knowledge', { cookie: strangerSession.cookieHeader, body: { content_ids: [Number(event.id)] } });
    expect(denied.status).toBe(200);
    expect((await denied.json()).content).toEqual([]);
    const anonymous = await post('/api/me/read_knowledge', { body: { content_ids: [Number(event.id)] } });
    expect(anonymous.status).not.toBe(200);
    const profile = await createTestAccessToken(auth.userId!, null, auth.clientId!, { scope: 'profile:read' });
    expect((await get('/api/me/clients/activity-scopes', { token: profile.token })).status).toBe(403);
    expect((await post('/api/me/read_knowledge', { token: profile.token, body: { content_ids: [Number(event.id)] } })).status).not.toBe(200);
    const scoped = await createTestAccessToken(auth.userId!, first.id, auth.clientId!, {
      resource: `http://localhost/mcp/${first.slug}`, scope: 'mcp:read',
    });
    const replay = await post('/api/me/read_knowledge', { token: scoped.token, body: { content_ids: [Number(event.id)] } });
    expect(replay.status).toBe(401);
  });
});
