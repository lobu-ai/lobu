import { beforeAll, describe, expect, it } from 'vitest';
import { createSpan, initTracing, MCP_PROTOCOL_VERSION, runInSpanContext, shutdownTracing, SpanKind, SpanStatusCode } from '@lobu/core';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { initWorkspaceProvider } from '../../../workspace';
import { getDb } from '../../../db/client';
import { app, type Env } from '../../../index';
import { type AuthContext, executeTool } from '../../../tools/execute';
import { ensureMcpSession, get, post, mcpRequest } from '../../setup/test-helpers';
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

  it('traces each cached MCP call with its current parent, authorized workspace and result status', async () => {
    const token = await createTestAccessToken(auth.userId!, null, auth.clientId!, {
      grantedOrganizationIds: [first.id, second.id], scope: 'mcp:read mcp:write',
    });
    // Warm the real transport so later calls reuse a server session.
    await mcpRequest('tools/list', {}, { token: token.token });
    const exporter = new InMemorySpanExporter();
    await shutdownTracing();
    initTracing({ serviceName: 'mcp-dispatch-tracing-test', spanProcessors: [new SimpleSpanProcessor(exporter)] });
    try {
      const parents: string[] = [];
      const tracedCall = async (name: string, args: Record<string, unknown>) => {
        const parent = createSpan('request work');
        parents.push(parent!.spanContext().spanId);
        try { return await runInSpanContext(parent, () => mcpRequest('tools/call', { name, arguments: args }, { token: token.token })); }
        finally { parent?.end(); }
      };
      const firstResult = await tracedCall('query_sql', { org_slug: first.slug, sql: 'SELECT 7 AS value' });
      const secondResult = await tracedCall('query_sql', { org_slug: second.slug, sql: 'SELECT 8 AS value' });
      expect(firstResult.result.structuredContent.rows).toEqual([{ value: 7 }]);
      expect(secondResult.result.structuredContent.rows).toEqual([{ value: 8 }]);
      const denied = await tracedCall('save_memory', { org_slug: 'private-unavailable-target', content: 'private-denied-body' });
      expect(denied.result.isError).toBe(true);
      const missing = await tracedCall('save_memory', { content: 'private-missing-target-body' });
      expect(missing.result.isError).toBe(true);
      const invalidSql = await tracedCall('query_sql', { org_slug: first.slug, sql: 'SELECT private_missing_column' });
      expect(invalidSql.result.isError).toBe(true);
      const scriptFailure = await tracedCall('query_sdk', { script: 'export default async () => { throw new Error("private-script-error"); };' });
      expect(scriptFailure.result.isError ?? false).toBe(false);
      expect(scriptFailure.result.structuredContent.success).toBe(false);
      const spans = exporter.getFinishedSpans().filter((span) => span.attributes['lobu.tool_name']);
      expect(spans).toHaveLength(6);
      expect(spans.map((span) => span.parentSpanContext?.spanId)).toEqual(parents);
      expect(spans.map((span) => span.attributes['lobu.org_id'])).toEqual([first.id, second.id, undefined, undefined, first.id, undefined]);
      expect(spans.map((span) => span.attributes['user.id'])).toEqual(Array(6).fill(auth.userId));
      expect(spans.map((span) => span.status.code)).toEqual([
        SpanStatusCode.OK, SpanStatusCode.OK, SpanStatusCode.ERROR,
        SpanStatusCode.ERROR, SpanStatusCode.ERROR, SpanStatusCode.OK,
      ]);
      expect(JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })))).not.toMatch(/private-|SELECT|org_slug|script/);

      // Exercise the production wrapper too: the shared helper above mounts the
      // bare app. A cached MCP server must use each HTTP request's active span.
      const { buildWrapperApp } = await import('../../../server-lifecycle');
      const wrapper = buildWrapperApp({
        ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL,
        JWT_SECRET: 'test-jwt-secret-for-testing-only', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
        RATE_LIMIT_ENABLED: 'false',
      } as Env, null, app);
      const sessionId = await ensureMcpSession({ token: token.token });
      const cases = [
        { traceId: '33333333333333333333333333333333', parentId: '4444444444444444', org: first, value: 9 },
        { traceId: '55555555555555555555555555555555', parentId: '6666666666666666', org: second, value: 10 },
      ];
      const responses = await Promise.all(cases.map((item, index) => wrapper.request('/mcp', {
        method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token.token}`, 'mcp-session-id': sessionId,
          'mcp-protocol-version': MCP_PROTOCOL_VERSION, traceparent: `00-${item.traceId}-${item.parentId}-01`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: index + 10, method: 'tools/call', params: {
          name: 'query_sql', arguments: { org_slug: item.org.slug, sql: `SELECT ${item.value} AS value` },
        } }),
      })));
      for (const [index, item] of cases.entries()) {
        expect(responses[index]!.status).toBe(200);
        expect((await responses[index]!.json()).result.structuredContent.rows).toEqual([{ value: item.value }]);
        const current = exporter.getFinishedSpans().filter((span) => span.spanContext().traceId === item.traceId);
        const request = current.find((span) => span.kind === SpanKind.SERVER)!;
        const tool = current.find((span) => span.attributes['lobu.tool_name'] === 'query_sql')!;
        expect(request.parentSpanContext?.spanId).toBe(item.parentId);
        expect(request.attributes['user.id']).toBe(auth.userId);
        expect(request.attributes['lobu.org_id']).toBeUndefined();
        expect(tool.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
        expect(tool.attributes['lobu.org_id']).toBe(item.org.id);
      }
    } finally {
      await shutdownTracing();
    }
  });

  it('discovers SDK methods and runs account methods with no implicit workspace', async () => {
    const docs = await call('search_sdk', { query: 'organizations.list' });
    expect(docs.results.length).toBeGreaterThan(0);
    const result = await call('query_sdk', { script: 'export default async (ctx, client) => ({ current: await client.organizations.current(), count: (await client.organizations.list()).length, workspace: ctx.organization_id });' });
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(result).toMatchObject({ success: true, return_value: { current: null, count: 2, workspace: null } });
    const title = await call('run_sdk', { script: 'export default async (ctx, client) => client.conversations.setTitle({ title: "Account activity" });' });
    expect(title).toMatchObject({ success: true, return_value: { title: 'Account activity' } });
    const [activity] = await getDb()`SELECT title FROM mcp_client_conversations WHERE user_id=${auth.userId} AND conversation_id='account-conversation'`;
    expect(activity).toMatchObject({ title: 'Account activity' });
    expect(await getDb()`SELECT 1 FROM mcp_client_conversation_workspaces WHERE user_id=${auth.userId} AND conversation_id='account-conversation'`).toHaveLength(0);
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
    // The caller is a member of `second` — the grant just excludes it — so the
    // denial names the workspace with a re-consent hint (visible only to
    // members), not the indistinguishable answer for unknown targets.
    const hinted = await call('save_memory', { org_slug: second.slug, content: 'Denied target' }, { ...auth, grantedOrganizationIds: [first.id] }).catch((e) => e);
    expect(String(hinted.message)).toContain(second.slug);
    expect(String(hinted.message)).toContain('Reconnect');
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

  it('accepts the bound workspace as an explicit target on scoped /mcp/<slug> and still refuses another', async () => {
    const token = await createTestAccessToken(auth.userId!, first.id, auth.clientId!, {
      resource: `http://localhost/mcp/${first.slug}`, grantedOrganizationIds: [first.id], scope: 'mcp:read mcp:write',
    });
    const scopedCall = (name: string, args: Record<string, unknown>) =>
      mcpRequest('tools/call', { name, arguments: args }, { token: token.token, orgSlug: first.slug });
    for (const target of [first.slug, first.id]) {
      const saved = await scopedCall('save_memory', { org_slug: target, semantic_type: 'note', content: 'Synthetic scoped self-target note', title: 'Scoped self target' });
      expect(saved.result.isError ?? false, JSON.stringify(saved.result)).toBe(false);
      const [event] = await getDb()`SELECT organization_id FROM events WHERE id=${saved.result.structuredContent.id}`;
      expect(event.organization_id).toBe(first.id);
      const queried = await scopedCall('query_sql', { org_slug: target, sql: 'SELECT 7 AS value' });
      expect(queried.result.isError ?? false, JSON.stringify(queried.result)).toBe(false);
      expect(queried.result.structuredContent.rows).toEqual([{ value: 7 }]);
      const searched = await scopedCall('search_memory', { workspace: target, query: 'scoped self target' });
      expect(searched.result.isError ?? false, JSON.stringify(searched.result)).toBe(false);
      // No such run: the lookup must reach the bound workspace, not stop at a cross-org denial.
      const approval = await scopedCall('get_approval', { run_id: 987654321, organization: target });
      expect(approval.result.isError, JSON.stringify(approval.result)).toBe(true);
      expect(approval.result.content[0].text).toBe('Approval run 987654321 was not found');
    }
    // Naming another workspace — even one the user belongs to — is still a switch.
    for (const name of ['save_memory', 'query_sql'] as const) {
      const denied = await scopedCall(name, name === 'save_memory'
        ? { org_slug: second.slug, semantic_type: 'note', content: 'Synthetic scoped cross-target note' }
        : { org_slug: second.slug, sql: 'SELECT 1' });
      expect(denied.result.isError, name).toBe(true);
      expect(denied.result.structuredContent.error, name).toMatchObject({ code: 'PERMISSION' });
    }
    const [leaked] = await getDb()`SELECT count(*)::int AS n FROM events WHERE organization_id=${second.id} AND payload_text LIKE 'Synthetic scoped cross-target%'`;
    expect(leaked.n).toBe(0);
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
