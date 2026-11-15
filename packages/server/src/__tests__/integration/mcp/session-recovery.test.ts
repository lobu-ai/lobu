/**
 * MCP session recovery semantics.
 *
 * MCP sessions live on a 1h sliding TTL (`SESSION_MAX_AGE_MS`). When a session
 * ages out, both the in-memory transport (per-pod cleanup) and the persisted
 * row (`DELETE FROM mcp_sessions WHERE expires_at <= NOW()`) disappear.
 *
 * Recovery is allowed ONLY from a persisted, server-issued session row (a
 * cross-replica hop / pod restart within the TTL) — that proves the id was
 * genuinely issued. An id with no persisted record (expired, or never issued)
 * must NOT be resurrected from request auth alone, because that would let a
 * caller create a session under any id they supply. Per the MCP Streamable
 * HTTP spec, those return 404 so the client re-initializes with a fresh
 * server-generated id. The error message is human-friendly and actionable.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { McpSessionStore } from '../../../mcp-session-store';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

describe('MCP session recovery', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Recovery Org' });
    publicOrg = await createTestOrganization({ name: 'Recovery Public Org', visibility: 'public' });
    user = await createTestUser({});
    await addUserToOrganization(user.id, org.id);
    client = await createTestOAuthClient();
  });

  beforeEach(() => {
    clearInMemoryMcpSessionsForTests();
  });

  /** Initialize a session and return its id (does the notifications/initialized handshake). */
  async function initSession(opts: { token?: string; orgSlug?: string }): Promise<string> {
    const path = opts.orgSlug ? `/mcp/${opts.orgSlug}` : '/mcp';
    const res = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lobu-test', version: '1.0' },
        },
      },
      token: opts.token,
    });
    const sid = res.headers.get('mcp-session-id');
    if (!sid) throw new Error(`no session id (status ${res.status}): ${await res.text()}`);
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { 'mcp-session-id': sid },
      token: opts.token,
    });
    return sid;
  }

  /** Simulate the session fully ageing out: in-memory evicted + persisted row gone. */
  async function expireSessionEverywhere(sessionId: string): Promise<void> {
    clearInMemoryMcpSessionsForTests();
    await getTestDb()`DELETE FROM mcp_sessions WHERE session_id = ${sessionId}`;
  }

  function toolsList(sessionId: string, opts: { token?: string; orgSlug?: string }) {
    return post(opts.orgSlug ? `/mcp/${opts.orgSlug}` : '/mcp', {
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      headers: { 'mcp-session-id': sessionId, 'X-MCP-Format': 'json' },
      token: opts.token,
    });
  }

  async function sessionRowExists(sessionId: string): Promise<boolean> {
    const rows = await getTestDb()`SELECT 1 FROM mcp_sessions WHERE session_id = ${sessionId}`;
    return rows.length > 0;
  }

  it('requires fresh PAT authority instead of treating a transport session id as a credential', async () => {
    const { token } = await createTestPAT(user.id, org.id);
    const sessionId = await initSession({ token });
    const response = await post('/mcp', {
      headers: { 'mcp-session-id': sessionId },
      body: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'query_sql', arguments: { sql: 'SELECT 1 AS missing_pat_probe' } },
      },
    });

    expect(response.status).toBe(401);
    expect(await sessionRowExists(sessionId)).toBe(true);
    expect((await toolsList(sessionId, { token })).status).toBe(200);
  });

  it('recovers from the persisted row after only the in-memory transport is gone (replica hop)', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });

    // Replica hop: in-memory map cleared, DB row intact (within TTL).
    clearInMemoryMcpSessionsForTests();

    const res = await toolsList(sessionId, { token, orgSlug: org.slug });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });

  it('does not resurrect a row revoked while another replica is recovering it', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });
    clearInMemoryMcpSessionsForTests();

    const originalGetSession = McpSessionStore.prototype.getSession;
    const getSessionSpy = vi
      .spyOn(McpSessionStore.prototype, 'getSession')
      .mockImplementationOnce(async function (id) {
        const persisted = await originalGetSession.call(this, id);
        await getTestDb()`DELETE FROM mcp_sessions WHERE session_id = ${id}`;
        return persisted;
      });

    try {
      const res = await toolsList(sessionId, { token, orgSlug: org.slug });
      expect(res.status).toBe(404);
      expect(await sessionRowExists(sessionId)).toBe(false);
    } finally {
      getSessionSpy.mockRestore();
    }
  });

  it('persists an anonymous → authenticated upgrade', async () => {
    // The reuse path refreshes the row BEFORE re-resolving auth, then upgrades
    // `session.authCtx` IN PLACE (isAuthenticated, userId, clientId, role).
    // Without a write after that upgrade the row keeps the anonymous binding,
    // and a replica recovering this session enforces the stale identity — the
    // upgraded user/client binding silently doesn't cross pods.
    //
    // A public workspace is the one place an anonymous session legitimately
    // exists and can later present a token on the same session id.
    const sessionId = await initSession({ orgSlug: publicOrg.slug });

    const anonRow = (await getTestDb()`
      SELECT is_authenticated FROM mcp_sessions WHERE session_id = ${sessionId}
    `)[0] as { is_authenticated: boolean } | undefined;
    expect(anonRow?.is_authenticated).toBe(false);

    const { token } = await createTestAccessToken(user.id, publicOrg.id, client.client_id);
    const res = await toolsList(sessionId, { token, orgSlug: publicOrg.slug });
    expect(res.status).toBe(200);

    const rows = await getTestDb()`
      SELECT user_id, client_id, is_authenticated
      FROM mcp_sessions WHERE session_id = ${sessionId}
    `;
    expect(rows).toHaveLength(1);
    const row = rows[0] as {
      user_id: string | null;
      client_id: string | null;
      is_authenticated: boolean;
    };
    expect(row.is_authenticated).toBe(true);
    expect(row.user_id).toBe(user.id);
    expect(row.client_id).toBe(client.client_id);

    const headerless = await toolsList(sessionId, { orgSlug: publicOrg.slug });
    expect(headerless.status).toBe(401);
  });

  it('rejects a live local session whose persisted row was deleted by another replica', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });

    await getTestDb()`DELETE FROM mcp_sessions WHERE session_id = ${sessionId}`;

    const res = await toolsList(sessionId, { token, orgSlug: org.slug });
    expect(res.status).toBe(404);
    expect(await sessionRowExists(sessionId)).toBe(false);
  });

  it('returns 404 (not 200) for an authenticated caller whose session fully expired, and creates no phantom row', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });

    await expireSessionEverywhere(sessionId);

    const res = await toolsList(sessionId, { token, orgSlug: org.slug });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.message).toMatch(/expired or not recognized/i);

    // Must NOT re-mint a session under the (now-unverifiable) client-supplied id.
    expect(await sessionRowExists(sessionId)).toBe(false);
  });

  it('returns 404 and creates no row for an authenticated request with a never-issued session id', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const neverIssued = '00000000-0000-4000-8000-000000000000';

    const res = await toolsList(neverIssued, { token, orgSlug: org.slug });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.message).toMatch(/expired or not recognized/i);

    expect(await sessionRowExists(neverIssued)).toBe(false);
  });

  it('returns 404 for a GET (SSE reconnect) with a stale session id, consistent with POST', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });
    await expireSessionEverywhere(sessionId);

    const res = await get(`/mcp/${org.slug}`, {
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect(res.status).toBe(404);
  });

  it('returns a clear, actionable message (not the old "initialize POST first")', async () => {
    const sessionId = await initSession({ orgSlug: publicOrg.slug });
    await expireSessionEverywhere(sessionId);

    const res = await toolsList(sessionId, { orgSlug: publicOrg.slug });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.message).toMatch(/expired or not recognized/i);
    expect(body.error?.message).not.toMatch(/Send an initialize POST first/);
  });
});
