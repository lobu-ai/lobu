import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { readFileSync } from 'node:fs';
import { recordToolInvocationAudit } from '../../../tools/audit';
import { executeTool, type AuthContext } from '../../../tools/execute';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('user-owned tool invocation history', () => {
  let userId: string;
  let otherUserId: string;
  let orgId: string;
  let cookie: string;
  let otherCookie: string;
  let token: string;
  let clientId: string;

  function context(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      organizationId: orgId,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      clientId,
      mcpSessionId: 'history-transport',
      mcpConversationId: 'history-conversation',
      ...overrides,
    } as ToolContext;
  }

  async function record(overrides: Partial<ToolContext> = {}, script = 'return "private user request";') {
    await recordToolInvocationAudit({
      toolName: 'run_sdk', args: { script }, result: { success: true },
      durationMs: 12, ctx: context(overrides),
    });
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    orgId = (await createTestOrganization({ name: 'History workspace', slug: 'history-workspace' })).id;
    userId = (await createTestUser({ email: 'history-owner@example.test' })).id;
    otherUserId = (await createTestUser({ email: 'history-other@example.test' })).id;
    await addUserToOrganization(userId, orgId, 'owner');
    await addUserToOrganization(otherUserId, orgId, 'admin');
    cookie = (await createTestSession(userId)).cookieHeader;
    otherCookie = (await createTestSession(otherUserId)).cookieHeader;
    clientId = (await createTestOAuthClient({ owner_user_id: userId })).client_id;
    token = (await createTestAccessToken(userId, orgId, clientId, { scope: 'mcp:read mcp:write mcp:admin' })).token;
  });

  it('lists only the owner’s calls and never puts request bodies in the list', async () => {
    await record();
    await record({ userId: otherUserId }, 'return "another user request";');
    const response = await get('/api/me/tool-invocations', { cookie });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invocations).toHaveLength(1);
    expect(body.invocations[0]).toMatchObject({
      toolName: 'run_sdk', success: true, durationMs: 12,
      organizationId: null, clientId, activityId: 'history-conversation', requestStatus: 'complete',
    });
    expect(JSON.stringify(body)).not.toContain('private user request');
    expect(body.invocations[0]).not.toHaveProperty('payload');
    const detail = await get(`/api/me/tool-invocations/${body.invocations[0].id}`, { cookie });
    expect(detail.status).toBe(200);
    expect((await detail.json()).payload.request.script).toBe('return "private user request";');
    const forbidden = await get(`/api/me/tool-invocations/${body.invocations[0].id}`, { cookie: otherCookie });
    expect(forbidden.status).toBe(404);
    const missing = await get('/api/me/tool-invocations/9223372036854775807', { cookie: otherCookie });
    expect(await forbidden.json()).toEqual(await missing.json());
  });

  it('does not grant an OAuth app access to the user’s account-wide history', async () => {
    expect((await get('/api/me/tool-invocations')).status).toBe(401);
    expect((await get('/api/me/tool-invocations', { token })).status).toBe(401);
  });

  it('keeps explicit workspace attribution and paginates within the owner and filters', async () => {
    await record({ scopedToOrg: true, allowCrossOrg: false, mcpConversationId: 'scoped-history' });
    await record({ scopedToOrg: true, allowCrossOrg: false, mcpConversationId: 'scoped-history' });
    const first = await get(`/api/me/tool-invocations?limit=1&client_id=${clientId}&activity_id=scoped-history`, { cookie });
    const page = await first.json();
    expect(page.invocations).toHaveLength(1);
    expect(page.invocations[0]).toMatchObject({ organizationId: orgId, organizationSlug: 'history-workspace' });
    expect(page.nextCursor).toBe(page.invocations[0].id);
    const second = await get(`/api/me/tool-invocations?limit=1&client_id=${clientId}&activity_id=scoped-history&before=${page.nextCursor}`, { cookie });
    const next = await second.json();
    expect(next.invocations).toHaveLength(1);
    expect(next.invocations[0].id).not.toBe(page.invocations[0].id);
    expect(next.nextCursor).toBeNull();
  });

  it('rejects malformed and overflowing cursors without querying arbitrary SQL', async () => {
    for (const before of ['abc', '-1', '9223372036854775808', '1 OR 1=1']) {
      const response = await get(`/api/me/tool-invocations?before=${encodeURIComponent(before)}`, { cookie });
      expect(response.status).toBe(400);
    }
  });

  it('stores authenticated requests outside the workspace event stream', async () => {
    const rows = await getDb()`SELECT id FROM events WHERE organization_id = ${orgId} AND origin_type = 'tool_invocation'`;
    expect(rows).toHaveLength(0);
  });

  it('retains history after membership is removed', async () => {
    await getDb()`DELETE FROM member WHERE "userId" = ${userId} AND "organizationId" = ${orgId}`;
    const response = await get('/api/me/tool-invocations', { cookie });
    expect(response.status).toBe(200);
    expect((await response.json()).invocations.length).toBeGreaterThan(0);
  });

  it('records a call without any workspace and retains failed outcomes', async () => {
    await recordToolInvocationAudit({
      toolName: 'query_sdk', args: { script: 'throw new Error("probe")' },
      error: new Error('probe'), durationMs: 3,
      ctx: { ...context(), organizationId: null, mcpConversationId: 'unscoped-call' },
    });
    const response = await get('/api/me/tool-invocations?activity_id=unscoped-call', { cookie });
    expect((await response.json()).invocations).toEqual([
      expect.objectContaining({ organizationId: null, success: false, toolName: 'query_sdk' }),
    ]);
  });

  it('does not expose account history through workspace SQL, even to an admin', async () => {
    const result = await executeTool('query_sql', { sql: 'SELECT * FROM user_tool_invocations' }, {} as Env, {
      ...context({ allowCrossOrg: false }),
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    } as AuthContext) as { error?: string };
    expect(result.error).toBeTruthy();
  });

  it('audits account discovery even when no organization is bound', async () => {
    await executeTool('list_organizations', {}, {} as Env, {
      ...context(), organizationId: null, memberRole: null,
      mcpConversationId: 'unscoped-discovery', grantedOrganizationIds: [],
      scopes: ['mcp:read'],
    } as AuthContext);
    const response = await get('/api/me/tool-invocations?activity_id=unscoped-discovery', { cookie });
    expect((await response.json()).invocations).toEqual([
      expect.objectContaining({ toolName: 'list_organizations', organizationId: null, success: true }),
    ]);
  });

  it('keeps signed-in public-workspace calls in the user’s private history', async () => {
    await recordToolInvocationAudit({
      toolName: 'query_sql', args: { sql: 'SELECT id FROM entities' },
      result: { rows: [] }, durationMs: 1,
      ctx: {
        ...context(), isAuthenticated: false, memberRole: null,
        tokenType: 'session', clientId: null, allowCrossOrg: false,
        grantedOrganizationIds: null,
        mcpConversationId: 'signed-in-public-call',
      },
    });
    const response = await get('/api/me/tool-invocations?activity_id=signed-in-public-call', { cookie });
    expect((await response.json()).invocations).toEqual([
      expect.objectContaining({ toolName: 'query_sql', organizationId: orgId }),
    ]);
    const events = await getDb()`
      SELECT id FROM events
      WHERE organization_id = ${orgId}
        AND metadata->>'mcp_conversation_id' = 'signed-in-public-call'
    `;
    expect(events).toHaveLength(0);
  });

  it('keeps actor-less public calls in their workspace ledger', async () => {
    await recordToolInvocationAudit({
      toolName: 'query_sql', args: { sql: 'SELECT id FROM entities' },
      result: { rows: [] }, durationMs: 1,
      ctx: { ...context(), userId: null, isAuthenticated: false, tokenType: 'anonymous', allowCrossOrg: false },
    });
    const events = await getDb()`
      SELECT created_by FROM events
      WHERE organization_id = ${orgId} AND origin_type = 'tool_invocation'
    `;
    expect(events).toEqual([{ created_by: null }]);
  });

  it('replays the migration and backfills historical calls without changing their events', async () => {
    const sql = getDb();
    const metadata = { token_type: 'oauth', mcp_session_id: 'legacy-history' };
    const [event] = await sql`
      INSERT INTO events (organization_id, origin_id, semantic_type, origin_type, payload_type,
        payload_data, metadata, created_by, client_id)
      VALUES (${orgId}, 'legacy-owned-invocation', 'audit', 'tool_invocation', 'empty',
        ${sql.json({ tool_name: 'run_sdk', success: true, request: { script: 'return "old request"' } })},
        ${sql.json(metadata)}, ${userId}, ${clientId})
      RETURNING id, payload_data
    `;
    const [patEvent] = await sql`
      INSERT INTO events (organization_id, origin_id, semantic_type, origin_type, payload_type,
        payload_data, metadata, created_by)
      VALUES (${orgId}, 'legacy-pat-invocation', 'audit', 'tool_invocation', 'empty',
        ${sql.json({ tool_name: 'query_sql', success: true })},
        ${sql.json({ token_type: 'pat', mcp_session_id: 'legacy-pat-history' })}, ${userId})
      RETURNING id
    `;
    const migration = readFileSync(new URL('../../../../../../db/migrations/20260907130000_user_tool_invocations.sql', import.meta.url), 'utf8');
    const migrationUp = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf('-- migrate:down'));
    await sql.unsafe(migrationUp);
    await sql.unsafe(migrationUp);
    const rows = await sql`SELECT * FROM user_tool_invocations WHERE source_event_id = ${event.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: userId, organization_id: null, payload_data: event.payload_data });
    const [patRow] = await sql`
      SELECT organization_id FROM user_tool_invocations WHERE source_event_id = ${patEvent.id}
    `;
    expect(patRow.organization_id).toBe(orgId);
    const [original] = await sql`SELECT payload_data FROM events WHERE id = ${event.id}`;
    expect(original.payload_data).toEqual(event.payload_data);
    const response = await get('/api/me/tool-invocations?activity_id=legacy-history', { cookie });
    expect((await response.json()).invocations).toHaveLength(1);
  });
});
