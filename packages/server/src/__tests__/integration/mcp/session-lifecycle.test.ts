import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { app } from '../../../index';
import { mcpSessionMap } from '../../../mcp-session-state';
import { McpSessionStore, type PersistedMcpSession } from '../../../mcp-session-store';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const HOUR = 3_600_000;
const store = new McpSessionStore();

function session(sessionId: string): PersistedMcpSession {
  return {
    sessionId, userId: null, clientId: null, organizationId: null,
    memberRole: null, requestedAgentId: null, isAuthenticated: false,
    scopedToOrg: false, supportsMcpApps: false, supportsAppSandboxDomain: false,
    lastAccessedAt: Date.now(), expiresAt: Date.now() + HOUR,
  };
}

beforeAll(async () => { await initWorkspaceProvider(); });
beforeEach(async () => { await cleanupTestDatabase(); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const entry of mcpSessionMap.values()) {
    await (entry as { transport: WebStandardStreamableHTTPServerTransport }).transport.close();
  }
  mcpSessionMap.clear();
});

describe('MCP expiry maintenance', () => {
  it('keeps unexpired idle rows and removes rows at or before the database cutoff', async () => {
    const db = getTestDb();
    await db`
      INSERT INTO mcp_sessions (session_id, last_accessed_at, expires_at) VALUES
        ('idle-live', now() - interval '59 minutes', now() + interval '1 minute'),
        ('boundary', now() - interval '1 hour', now()),
        ('expired', now() - interval '2 hours', now() - interval '1 hour')
    `;
    await store.deleteExpiredSessions();
    expect((await db`SELECT session_id FROM mcp_sessions`).map(r => r.session_id)).toEqual(['idle-live']);
  });

  it('deletes at most 500 rows per batch and repeated cleanup converges', async () => {
    const db = getTestDb();
    await db`
      INSERT INTO mcp_sessions (session_id, expires_at)
      SELECT 'expired-' || n, now() - interval '1 second' FROM generate_series(1, 1001) n
    `;
    await store.deleteExpiredSessions();
    expect((await db`SELECT session_id FROM mcp_sessions`).length).toBe(501);
    await Promise.all([store.deleteExpiredSessions(), new McpSessionStore().deleteExpiredSessions()]);
    expect(await db`SELECT session_id FROM mcp_sessions`).toHaveLength(0);
    await store.deleteExpiredSessions();
    expect(await db`SELECT session_id FROM mcp_sessions`).toHaveLength(0);
  });

  it('skips a row locked by another replica while it refreshes, then retains it', async () => {
    const db = getTestDb();
    await db`INSERT INTO mcp_sessions (session_id, expires_at) VALUES ('refreshing', now())`;
    await db.begin(async tx => {
      await tx`SELECT session_id FROM mcp_sessions WHERE session_id = 'refreshing' FOR UPDATE`;
      // This must complete before releasing the other connection's row lock.
      let timeout: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([store.deleteExpiredSessions(), new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('cleanup waited for another replica row lock')), 1000);
        })]);
      } finally { clearTimeout(timeout!); }
      await tx`UPDATE mcp_sessions SET last_accessed_at = now(), expires_at = now() + interval '1 hour'
        WHERE session_id = 'refreshing'`;
    });
    await store.deleteExpiredSessions();
    expect(await store.getSession('refreshing')).not.toBeNull();
  }, 3000);

  it('refreshActivity updates timestamps only, monotonically, without resurrecting rows', async () => {
    const initial = session('activity');
    await store.upsertSession(initial);
    const newer = { ...initial, memberRole: 'admin', supportsMcpApps: true,
      lastAccessedAt: initial.lastAccessedAt + HOUR, expiresAt: initial.expiresAt + HOUR };
    await store.refreshSession(newer);
    expect(await store.refreshActivity(initial.sessionId)).toBe(true);
    expect(await store.getSession(initial.sessionId)).toEqual(newer);

    // A slow request's older timestamp snapshot must not undo a heartbeat.
    await store.refreshSession({ ...newer, lastAccessedAt: initial.lastAccessedAt, expiresAt: initial.expiresAt });
    expect(await store.getSession(initial.sessionId)).toEqual(newer);
    await store.deleteSession(initial.sessionId);
    expect(await store.refreshActivity(initial.sessionId)).toBe(false);
    expect(await store.getSession(initial.sessionId)).toBeNull();
  });

  it('does not resurrect a row deleted while its heartbeat is waiting on another connection', async () => {
    await store.upsertSession(session('delete-race'));
    let refresh!: Promise<boolean>;
    await getTestDb().begin(async tx => {
      await tx`DELETE FROM mcp_sessions WHERE session_id = 'delete-race'`;
      refresh = store.refreshActivity('delete-race');
    });
    expect(await refresh).toBe(false);
    expect(await store.getSession('delete-race')).toBeNull();
  });

  it('retains a refreshed row and never recreates one that cleanup won first', async () => {
    const db = getTestDb();
    await db`INSERT INTO mcp_sessions (session_id, expires_at) VALUES ('refresh-first', now()), ('delete-first', now())`;
    expect(await store.refreshActivity('refresh-first')).toBe(true);
    await store.deleteExpiredSessions();
    expect(await store.refreshActivity('delete-first')).toBe(false);
    expect(await store.getSession('refresh-first')).not.toBeNull();
    expect(await store.getSession('delete-first')).toBeNull();
  });
});

describe('MCP active transport lifetime', () => {
  let sessionId: string;
  let url: string;
  let entry: { transport: WebStandardStreamableHTTPServerTransport; server: Server; lastAccessedAt: number };
  const env = { ENVIRONMENT: 'test', RATE_LIMIT_ENABLED: 'false' };

  beforeEach(async () => {
    const org = await createTestOrganization({ name: 'Transport lifetime', visibility: 'public' });
    url = `http://localhost/mcp/${org.slug}`;
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1' },
      } },
    });
    expect(response.status).toBe(200);
    sessionId = response.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();
    entry = mcpSessionMap.get(sessionId) as typeof entry;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  async function ageRow() {
    await getTestDb()`UPDATE mcp_sessions SET last_accessed_at = now() - interval '2 hours',
      expires_at = now() - interval '1 hour' WHERE session_id = ${sessionId}`;
    return (await getTestDb()`SELECT last_accessed_at FROM mcp_sessions WHERE session_id = ${sessionId}`)[0].last_accessed_at;
  }

  async function expectRefreshed() {
    await vi.waitFor(async () => { expect(await store.getSession(sessionId)).not.toBeNull(); });
    const row = (await store.getSession(sessionId))!;
    expect(row.expiresAt - row.lastAccessedAt).toBe(HOUR);
    await store.deleteExpiredSessions();
    expect(await store.getSession(sessionId)).not.toBeNull();
  }

  function request(method: string, signal: AbortSignal, body?: unknown) {
    return new Request(url, { method, signal, headers: {
      'mcp-session-id': sessionId, 'content-type': 'application/json',
      // Deliberately requires Accept normalization.
      accept: method === 'GET' ? 'text/event-stream' : 'application/json',
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }

  it('refreshes an open SSE stream on delivered heartbeats and stops on normalized-request abort', async () => {
    const ctrl = new AbortController();
    const response = await app.fetch(request('GET', ctrl.signal), env);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      await ageRow();
      await getTestDb()`UPDATE mcp_sessions SET member_role = 'admin', supports_mcp_apps = true
        WHERE session_id = ${sessionId}`;
      const heartbeat = reader.read();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(new TextDecoder().decode((await heartbeat).value)).toContain(': ping');
      await expectRefreshed();
      expect(await store.getSession(sessionId)).toMatchObject({ memberRole: 'admin', supportsMcpApps: true });
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
      const stale = await ageRow();
      await vi.advanceTimersByTimeAsync(30_000);
      const [row] = await getTestDb()`SELECT last_accessed_at FROM mcp_sessions WHERE session_id = ${sessionId}`;
      expect(row.last_accessed_at).toEqual(stale);
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('cancels an unread GET immediately on abort and permits another GET on the same transport', async () => {
    const ctrl = new AbortController();
    const response = await app.fetch(request('GET', ctrl.signal), env);
    ctrl.abort();
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(0); });
    await response.body!.cancel().catch(() => undefined);
    const retry = await app.fetch(request('GET', new AbortController().signal), env);
    expect(retry.status).toBe(200);
    await retry.body!.cancel();
    await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(0); });
  });

  it('does not refresh or queue unlimited heartbeats for an unread stream', async () => {
    const ctrl = new AbortController();
    const response = await app.fetch(request('GET', ctrl.signal), env);
    const stale = await ageRow();
    await vi.advanceTimersByTimeAsync(HOUR + 15_000);
    const [row] = await getTestDb()`SELECT last_accessed_at FROM mcp_sessions WHERE session_id = ${sessionId}`;
    expect(row.last_accessed_at).toEqual(stale);
    ctrl.abort();
    await response.body!.cancel().catch(() => undefined);
  });

  it.each(['completion', 'throw', 'abort'] as const)('refreshes in-flight JSON POSTs and stops after %s', async ending => {
    const started = deferred();
    const release = deferred();
    entry.server.setRequestHandler(PingRequestSchema, async () => {
      started.resolve();
      await release.promise;
      if (ending === 'throw') throw new Error('handler failed');
      return {};
    });
    const ctrl = new AbortController();
    const pending = app.fetch(request('POST', ctrl.signal, { jsonrpc: '2.0', id: 2, method: 'ping' }), env);
    try {
      await started.promise;
      await ageRow();
      await vi.advanceTimersByTimeAsync(15_000);
      await expectRefreshed();
      if (ending === 'abort') ctrl.abort();
      else {
        release.resolve();
        const response = await pending;
        expect(response.status).toBe(200);
        const body = await response.json();
        if (ending === 'throw') expect(body.error.message).toBe('handler failed');
        else expect(body.result).toEqual({});
      }
      expect(vi.getTimerCount()).toBe(0);
      const stale = await ageRow();
      await vi.advanceTimersByTimeAsync(30_000);
      const [row] = await getTestDb()`SELECT last_accessed_at FROM mcp_sessions WHERE session_id = ${sessionId}`;
      expect(row.last_accessed_at).toEqual(stale);
    } finally {
      release.resolve();
      await pending;
      ctrl.abort();
    }
  });

  it.each(['pre-aborted HTTP', 'deleted shared row'] as const)('does not keep renewing with %s', async ending => {
    const started = deferred();
    const release = deferred();
    entry.server.setRequestHandler(PingRequestSchema, async () => {
      started.resolve();
      await release.promise;
      return {};
    });
    const ctrl = new AbortController();
    if (ending === 'pre-aborted HTTP') ctrl.abort();
    const pending = app.fetch(request('POST', ctrl.signal, { jsonrpc: '2.0', id: 2, method: 'ping' }), env);
    const refresh = vi.spyOn(McpSessionStore.prototype, 'refreshActivity');
    try {
      await started.promise;
      if (ending === 'deleted shared row') {
        await store.deleteSession(sessionId);
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(0); });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(await store.getSession(sessionId)).toBeNull();
        refresh.mockClear();
      }
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      expect((await pending).status).toBe(200);
      ctrl.abort();
    }
  });

  it('does not start renewal when the SDK cancels before handler dispatch', async () => {
    const started = deferred();
    const release = deferred();
    let signal!: AbortSignal;
    entry.server.setRequestHandler(PingRequestSchema, async (_, extra) => {
      signal = extra.signal;
      started.resolve();
      await release.promise;
      return {};
    });
    const ctrl = new AbortController();
    // The SDK accepts this protocol-version's batch and aborts before invoking
    // the handler microtask. No payload parsing is mocked by the test.
    const pending = app.fetch(request('POST', ctrl.signal, [
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } },
    ]), env);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await started.promise;
      expect(signal.aborted).toBe(true);
      expect(ctrl.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      release.resolve();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      ctrl.abort();
    }
  });

  it.each(['protocol cancellation', 'transport close', 'DELETE'] as const)(
    'stops renewal on %s even when the JSON response never settles', async ending => {
      const started = deferred();
      const release = deferred();
      let handlerSignal!: AbortSignal;
      let returned = false;
      let settled = false;
      entry.server.setRequestHandler(PingRequestSchema, async (_, extra) => {
        handlerSignal = extra.signal;
        started.resolve();
        await release.promise;
        returned = true;
        return {};
      });
      const ctrl = new AbortController();
      const pending = app.fetch(request('POST', ctrl.signal, { jsonrpc: '2.0', id: 2, method: 'ping' }), env);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      try {
        await started.promise;
        expect(vi.getTimerCount()).toBe(1);
        if (ending === 'protocol cancellation') {
          // An unrelated cancellation must not stop this request.
          const notify = (requestId: number) => app.fetch(request('POST', new AbortController().signal, {
            jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId },
          }), env);
          expect((await notify(999)).status).toBe(202);
          expect(handlerSignal.aborted).toBe(false);
          expect(vi.getTimerCount()).toBe(1);
          expect((await notify(2)).status).toBe(202);
        } else if (ending === 'transport close') {
          await entry.transport.close();
        } else {
          expect((await app.fetch(request('DELETE', new AbortController().signal), env)).status).toBe(200);
        }
        await vi.waitFor(() => { expect(handlerSignal.aborted).toBe(true); });
        // Stop at cancellation, even before a cooperative handler returns.
        expect(vi.getTimerCount()).toBe(0);
        release.resolve();
        await vi.waitFor(() => { expect(returned).toBe(true); });
        expect(ctrl.signal.aborted).toBe(false);
        expect(settled).toBe(false); // SDK suppresses the cancelled JSON response.
        const refresh = vi.spyOn(McpSessionStore.prototype, 'refreshActivity');
        if (ending !== 'DELETE') await ageRow();
        await vi.advanceTimersByTimeAsync(45_000);
        expect(refresh).not.toHaveBeenCalled();
        await store.deleteExpiredSessions();
        expect(await store.getSession(sessionId)).toBeNull();
      } finally {
        release.resolve();
        ctrl.abort();
      }
    }
  );

  it('real SDK client cancellations preserve the GET heartbeat and a concurrent active request', async () => {
    const sent: Request[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (input, options) => {
        const req = new Request(input, options);
        if (req.method === 'POST' && (await req.clone().json()).method === 'ping') sent.push(req);
        return app.fetch(req, env);
      },
    });
    const client = new Client({ name: 'lifecycle-client', version: '1' });
    const siblingStarted = deferred();
    const siblingRelease = deferred();
    let release = deferred();
    try {
      await client.connect(transport);
      sessionId = transport.sessionId!;
      entry = mcpSessionMap.get(sessionId) as typeof entry;
      await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(1); });
      entry.server.setRequestHandler(PingRequestSchema, async () => {
        siblingStarted.resolve();
        await siblingRelease.promise;
        return {};
      });
      const sibling = client.ping().catch(error => error);
      await siblingStarted.promise;
      for (let n = 0; n < 3; n++) {
        const started = deferred();
        release = deferred();
        const currentRelease = release;
        let signal!: AbortSignal;
        let returned = false;
        entry.server.setRequestHandler(PingRequestSchema, async (_, extra) => {
          signal = extra.signal;
          started.resolve();
          await currentRelease.promise;
          returned = true;
          return {};
        });
        const cancel = new AbortController();
        const call = client.ping({ signal: cancel.signal });
        const rejected = expect(call).rejects.toThrow('user cancelled');
        await started.promise;
        expect(vi.getTimerCount()).toBe(3);
        cancel.abort('user cancelled');
        await rejected;
        await vi.waitFor(() => { expect(signal.aborted).toBe(true); });
        release.resolve();
        await vi.waitFor(() => { expect(returned).toBe(true); });
        expect(vi.getTimerCount()).toBe(2);
      }
      expect(sent).toHaveLength(4);
      expect(sent.every(req => !req.signal.aborted)).toBe(true);
      await ageRow();
      const stale = Date.now() - HOUR - 1;
      entry.lastAccessedAt = stale;
      await vi.advanceTimersByTimeAsync(15_000);
      await expectRefreshed();
      expect(entry.lastAccessedAt).toBeGreaterThan(stale);
      siblingRelease.resolve();
      expect(await sibling).toEqual({});
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      release.resolve();
      siblingRelease.resolve();
      await client.close();
      await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(0); });
    }
  });

  it('closes a live stream after another replica deletes its row without resurrecting it', async () => {
    const ctrl = new AbortController();
    const response = await app.fetch(request('GET', ctrl.signal), env);
    const reader = response.body!.getReader();
    await store.deleteSession(sessionId);
    const drain = (async () => { while (!(await reader.read()).done) {} })();
    await vi.advanceTimersByTimeAsync(15_000);
    try {
      await vi.waitFor(() => { expect(mcpSessionMap.has(sessionId)).toBe(false); });
      await drain;
      expect(await store.getSession(sessionId)).toBeNull();
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
      await drain.catch(() => undefined);
    }
  });

  it('preserves another replica\'s refreshed row on local close and recovers on POST', async () => {
    const persisted = (await store.getSession(sessionId))!;
    await new McpSessionStore().refreshSession({ ...persisted,
      lastAccessedAt: persisted.lastAccessedAt + 1000, expiresAt: persisted.expiresAt + 1000 });
    await entry.transport.close();
    expect(mcpSessionMap.has(sessionId)).toBe(false);
    expect(await store.getSession(sessionId)).not.toBeNull();
    const recovered = await app.fetch(request('POST', new AbortController().signal,
      { jsonrpc: '2.0', id: 2, method: 'ping' }), env);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).result).toEqual({});
  });

  it('still deletes shared state on an explicit client DELETE', async () => {
    const response = await app.fetch(request('DELETE', new AbortController().signal), env);
    expect(response.status).toBe(200);
    expect(await store.getSession(sessionId)).toBeNull();
  });
});
