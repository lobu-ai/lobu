import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { McpSessionStore } from '../../../mcp-session-store';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
  seedOwnerContext,
} from '../../setup/test-fixtures';
import { ensureMcpSession, post } from '../../setup/test-helpers';

describe('REST tool execution with an existing MCP session', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let token: string;
  let connectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    ({ org, user } = await seedOwnerContext());
    client = await createTestOAuthClient();
    ({ token } = await createTestAccessToken(user.id, org.id, client.client_id));
    const key = 'demo.rest.session';
    await createTestConnectorDefinition({ key, name: 'REST session fixture', organization_id: org.id });
    const sql = getTestDb();
    await sql`
      UPDATE connector_definitions
      SET actions_schema = ${sql.json({ echo: { name: 'Echo', kind: 'write', requiresApproval: false } })}
      WHERE key = ${key} AND organization_id = ${org.id}
    `;
    await sql`
      UPDATE connector_versions
      SET compiled_code = ${`class FixtureRuntime {
        async sync() { return { items: [] }; }
        async execute() { return { success: true, output: { echoed: true } }; }
      }
      module.exports = { FixtureRuntime };`}
      WHERE connector_key = ${key}
    `;
    const connection = await createTestConnection({
      organization_id: org.id, connector_key: key, created_by: user.id, visibility: 'org',
    });
    connectionId = connection.id;
  });

  afterAll(async () => {
    clearInMemoryMcpSessionsForTests();
    await cleanupTestDatabase();
  });

  const args = () => ({ action: 'execute', connection_id: connectionId, operation_key: 'echo', input: {} });

  async function session(bearer = token, orgSlug = org.slug) {
    // Each token creates a real server-issued row through MCP initialization.
    return ensureMcpSession({ token: bearer, orgSlug });
  }

  function execute(sessionId?: string, bearer = token, orgSlug = org.slug) {
    return post(`/api/${orgSlug}/manage_operations`, {
      token: bearer,
      headers: sessionId === undefined ? {} : { 'mcp-session-id': sessionId },
      body: args(),
    });
  }

  async function runFrom(response: Awaited<ReturnType<typeof post>>, mcp = false) {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const result = mcp ? body.result.structuredContent ?? JSON.parse(body.result.content[0].text) : body;
    expect(result.status, JSON.stringify(body)).toBe('completed');
    const [run] = await getTestDb()`SELECT id, run_metadata FROM runs WHERE id = ${result.run_id}`;
    expect(run).toBeDefined();
    return run;
  }

  async function expectRejected(response: Awaited<ReturnType<typeof post>>, countBefore: number, status = 404) {
    expect(response.status, await response.text()).toBe(status);
    const [row] = await getTestDb()`SELECT count(*)::int AS count FROM runs WHERE organization_id = ${org.id}`;
    expect(row.count).toBe(countBefore);
  }

  async function runCount() {
    const [row] = await getTestDb()`SELECT count(*)::int AS count FROM runs WHERE organization_id = ${org.id}`;
    return Number(row.count);
  }

  it('attributes REST execute calls to the same persisted session as native MCP after a replica hop', async () => {
    const sessionId = await session();
    const native = await runFrom(await post(`/mcp/${org.slug}`, {
      token, headers: { 'mcp-session-id': sessionId },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'manage_operations', arguments: args() } },
    }), true);
    expect(native.run_metadata.browser_context.kind).toBe('mcp');
    clearInMemoryMcpSessionsForTests();
    for (let i = 0; i < 2; i++) {
      const rest = await runFrom(await execute(sessionId));
      expect(rest.id).not.toBe(native.id);
      expect(rest.run_metadata?.browser_context).toEqual(native.run_metadata.browser_context);
    }
    const [audit] = await getTestDb()`
      SELECT metadata FROM events
      WHERE organization_id = ${org.id} AND origin_type = 'tool_invocation'
        AND payload_data->>'tool_name' = 'manage_operations'
      ORDER BY id DESC LIMIT 1
    `;
    expect(audit.metadata.mcp_session_id).toBe(sessionId);
  });

  it('keeps correlation-free REST calls unattributed', async () => {
    for (let i = 0; i < 2; i++) {
      const run = await runFrom(await execute());
      expect(run.run_metadata?.browser_context).toBeUndefined();
    }
  });

  it.each(['never-issued', 'expired', 'revoked', 'empty'])(
    'rejects a %s session before executing', async (state) => {
      const bearer = (await createTestAccessToken(user.id, org.id, client.client_id)).token;
      let sessionId = state === 'empty' ? '' : 'synthetic-never-issued-session';
      if (state === 'expired' || state === 'revoked') {
        sessionId = await session(bearer);
        if (state === 'expired') {
          await getTestDb()`UPDATE mcp_sessions SET expires_at = NOW() - interval '1 second' WHERE session_id = ${sessionId}`;
        } else {
          await new McpSessionStore().deleteSession(sessionId);
        }
      }
      const before = await runCount();
      await expectRejected(await execute(sessionId, bearer), before);
      expect(await new McpSessionStore().getSession(sessionId)).toBeNull();
    },
  );

  it('rejects a foreign organization session even when the caller can access both organizations', async () => {
    const otherOrg = await createTestOrganization();
    await addUserToOrganization(user.id, otherOrg.id, 'owner');
    const bearer = (await createTestAccessToken(user.id, org.id, client.client_id, {
      grantedOrganizationIds: [org.id, otherOrg.id],
    })).token;
    const sessionId = await session(bearer, otherOrg.slug);
    const before = await runCount();
    await expectRejected(await execute(sessionId, bearer), before);
    expect(await new McpSessionStore().getSession(sessionId)).not.toBeNull();
  });

  it.each(['user', 'client'])('rejects a different authenticated %s without revoking the owner session', async (identity) => {
    const sessionId = await session();
    const otherUser = identity === 'user' ? await createTestUser() : user;
    if (identity === 'user') await addUserToOrganization(otherUser.id, org.id, 'owner');
    const otherClient = identity === 'client' ? await createTestOAuthClient() : client;
    const bearer = (await createTestAccessToken(otherUser.id, org.id, otherClient.client_id)).token;
    const before = await runCount();
    await expectRejected(await execute(sessionId, bearer), before);
    expect(await new McpSessionStore().getSession(sessionId)).not.toBeNull();
  });

  it('uses the current bearer scopes instead of the session initialization scopes', async () => {
    const sessionId = await session();
    const bearer = (await createTestAccessToken(user.id, org.id, client.client_id, { scope: 'mcp:read' })).token;
    const before = await runCount();
    await expectRejected(await execute(sessionId, bearer), before, 400);
  });

  it('requires the OAuth bearer even when a PAT authenticates the same user', async () => {
    const sessionId = await session();
    const { token: pat } = await createTestPAT(user.id, org.id);
    const before = await runCount();
    await expectRejected(await execute(sessionId, pat), before, 401);
    expect(await new McpSessionStore().getSession(sessionId)).not.toBeNull();
  });

  it('rejects a bearer whose current workspace grants exclude the session workspace', async () => {
    const sessionId = await session();
    const bearer = (await createTestAccessToken(user.id, org.id, client.client_id, { grantedOrganizationIds: [] })).token;
    const before = await runCount();
    await expectRejected(await execute(sessionId, bearer), before, 403);
  });

  it('does not execute or resurrect a session revoked between validation and refresh', async () => {
    const bearer = (await createTestAccessToken(user.id, org.id, client.client_id)).token;
    const sessionId = await session(bearer);
    const original = McpSessionStore.prototype.getSession;
    const spy = vi.spyOn(McpSessionStore.prototype, 'getSession').mockImplementationOnce(async function (id) {
      const persisted = await original.call(this, id);
      await new McpSessionStore().deleteSession(id);
      return persisted;
    });
    try {
      const before = await runCount();
      await expectRejected(await execute(sessionId, bearer), before);
      const rows = await getTestDb()`SELECT 1 FROM mcp_sessions WHERE session_id = ${sessionId}`;
      expect(rows).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
