/**
 * A read stops on Postgres when its caller is gone.
 *
 * A browser that gives up on a feed read (fetch timeout, closed tab, a
 * superseded refetch) used to leave the read running to completion. Under a
 * client that re-reads on every change, those abandoned copies stacked on the
 * pool until the database was pinned. The caller's request signal now reaches
 * the read, which cancels its statements.
 *
 * A held `ACCESS EXCLUSIVE` lock on `events` stands in for a slow read: the
 * feed's statements block in Postgres until the request is aborted, so the
 * only way the blocked backend can disappear while the lock is still held is
 * a cancel sent on the caller's behalf.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { initTracing, shutdownTracing, SpanKind, SpanStatusCode } from '@lobu/core';
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpAuth } from '../../../auth/middleware';
import type { Env } from '../../../index';
import { publicRestSearchKnowledge, restSearchKnowledge, restToolProxy } from '../../../rest-api';
import { buildWrapperApp } from '../../../server-lifecycle';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';
import { mcpRequest } from '../../setup/test-helpers';

const env: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
};

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Reads of this database blocked on the held lock. The aborted call still
 * writes its audit row, which waits on the same lock and is meant to finish.
 */
async function blockedReads(holderPid: number): Promise<number[] | null> {
  const rows = await getTestDb()<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database()
      AND wait_event_type = 'Lock'
      AND pid <> ${holderPid}
      AND ltrim(query, E' \t\n') NOT ILIKE 'insert%'
  `;
  return rows.length > 0 ? rows.map((row) => row.pid) : null;
}

describe('read cancellation', () => {
  let app: Hono<{ Bindings: Env }>;
  let orgSlug: string;
  let token: string;
  let readOnlyToken: string;
  let release: (() => Promise<void>) | null = null;
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    // Capture the real serialized diagnostic output, not logger method calls.
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      logLines.push(String(chunk));
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (done) queueMicrotask(done);
      return true;
    });
  });

  function errorRecords() {
    return logLines.flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((record) => record.level === 'error');
  }

  function toolFailures(toolName: string) {
    return errorRecords().filter((record) => record.tool_name === toolName);
  }

  /** Every record the issue tracker would count, whichever code path wrote it. */
  function issues() {
    return errorRecords().filter((record) => typeof record.error_fingerprint === 'string');
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const org = await createTestOrganization({ name: 'Read Cancellation', visibility: 'public' });
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'read-cancellation@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    token = (await createTestPAT(user.id, org.id)).token;
    readOnlyToken = (await createTestPAT(user.id, org.id, { scope: 'mcp:read' })).token;
    await createTestEvent({ organization_id: org.id, content: 'synthetic feed item' });
    app = new Hono<{ Bindings: Env }>();
    app.post('/api/:orgSlug/:toolName', mcpAuth, (c) => restToolProxy(c));
    app.get('/api/:orgSlug/knowledge/search', mcpAuth, restSearchKnowledge);
    app.get('/api/:orgSlug/public/knowledge/search', publicRestSearchKnowledge);
  });

  afterEach(async () => {
    try {
      await release?.();
      release = null;
    } finally {
      vi.restoreAllMocks();
    }
  });

  async function holdEventsLock(table: 'events' | 'entities' = 'events'): Promise<number> {
    const holder = await getTestDb().reserve();
    await holder`BEGIN`;
    await holder.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    const [{ pid }] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    release = async () => {
      await holder`ROLLBACK`;
      holder.release();
    };
    return pid;
  }

  it('cancels the feed read on Postgres when the request is aborted', async () => {
    const holderPid = await holdEventsLock();
    const caller = new AbortController();
    const response = app.fetch(
      new Request(`http://localhost/api/${orgSlug}/read_knowledge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10 }),
        signal: caller.signal,
      }),
      env
    );

    const blocked = await waitFor(() => blockedReads(holderPid), 5000);
    expect(blocked).not.toBeNull();

    caller.abort();
    const remaining = await waitFor(
      async () => ((await blockedReads(holderPid)) === null ? [] : null),
      3000
    );
    expect(remaining).toEqual([]);

    await release?.();
    release = null;
    await response;
    expect(toolFailures('read_knowledge')).toEqual([]);
  });

  it.each(['proxy', 'wrapper', 'public wrapper'] as const)('does not record an abandoned search through the %s as a failed recall', async (route) => {
    const holderPid = await holdEventsLock();
    const caller = new AbortController();
    const response = app.fetch(
      new Request(route === 'proxy'
        ? `http://localhost/api/${orgSlug}/search_memory`
        : `http://localhost/api/${orgSlug}/${route === 'public wrapper' ? 'public/' : ''}knowledge/search?query=synthetic%20feed%20item`, {
        method: route === 'proxy' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: route === 'proxy' ? JSON.stringify({ query: 'synthetic feed item', include_content: true }) : undefined,
        signal: caller.signal,
      }),
      env
    );

    const blocked = await waitFor(() => blockedReads(holderPid), 5000);
    expect(blocked).not.toBeNull();

    // Aborting under the held lock is the only thing that can end the recall
    // read, and it rejects like a failed one. The rest of the search needs the
    // lock gone before it can settle.
    caller.abort();
    await release?.();
    release = null;
    await response;
    expect(issues()).toEqual([]);
  });

  it('cancels the feed read when the HTTP connection drops', async () => {
    // The adapter production serves through (`server-lifecycle.ts`), so this
    // covers the socket close turning into the request's abort.
    const server = http.createServer(getRequestListener((request) => app.fetch(request, env)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      // A request the client keeps open is never cancelled once its body is read.
      const served = await fetch(`http://127.0.0.1:${port}/api/${orgSlug}/read_knowledge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10 }),
      });
      expect(served.status).toBe(200);
      const { content } = (await served.json()) as { content: Array<{ payload_text?: string }> };
      expect(content.map((row) => row.payload_text)).toContain('synthetic feed item');

      const holderPid = await holdEventsLock();
      const request = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/${orgSlug}/read_knowledge`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      request.on('error', () => {});
      request.end(JSON.stringify({ limit: 10 }));

      const blocked = await waitFor(() => blockedReads(holderPid), 5000);
      expect(blocked).not.toBeNull();

      request.destroy();
      const remaining = await waitFor(
        async () => ((await blockedReads(holderPid)) === null ? [] : null),
        3000
      );
      expect(remaining).toEqual([]);
    } finally {
      await release?.();
      release = null;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    expect(toolFailures('read_knowledge')).toEqual([]);
  });

  it('records an admin read abandoned by a dropped connection as a 499, not an issue', async () => {
    // The node adapter aborts the request with a plain string reason
    // ("Client connection prematurely closed."), which the cancelled read
    // rethrows; the admin action router must treat it like executeTool does.
    // Served through the production wrapper, whose span and access log record
    // the status: nobody receives it, so it must not read as a server 500.
    const exporter = new InMemorySpanExporter();
    await shutdownTracing();
    initTracing({ serviceName: 'read-cancellation-test', spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const wrapped = buildWrapperApp(env, null, app);
    const server = http.createServer(getRequestListener((request) => wrapped.fetch(request, env)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let requestSpan: ReadableSpan | null = null;
    try {
      const { port } = server.address() as AddressInfo;
      const holderPid = await holdEventsLock('entities');
      const request = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/${orgSlug}/manage_entity`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      request.on('error', () => {});
      request.end(JSON.stringify({ action: 'list', limit: 10 }));

      const blocked = await waitFor(() => blockedReads(holderPid), 5000);
      expect(blocked).not.toBeNull();

      request.destroy();
      const remaining = await waitFor(
        async () => ((await blockedReads(holderPid)) === null ? [] : null),
        3000
      );
      expect(remaining).toEqual([]);
      requestSpan = await waitFor(
        async () => exporter.getFinishedSpans().find((span) => span.kind === SpanKind.SERVER) ?? null,
        3000
      );
    } finally {
      await release?.();
      release = null;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await shutdownTracing();
    }
    expect(requestSpan?.attributes).toMatchObject({
      'http.route': '/api/:orgSlug/:toolName',
      'http.response.status_code': 499,
    });
    expect(requestSpan?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(requestSpan?.attributes['error.fingerprint']).toBeUndefined();
    const records = logLines.flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    expect(records.filter((record) => record.source === 'route_failure' || record.source === 'http_response')).toEqual([]);
    expect(records.filter((record) => record.res?.status !== undefined).map((record) => record.res.status)).toEqual([499]);
    expect(issues()).toEqual([]);
  });

  it('keeps a real write failure visible after its caller leaves', async () => {
    const sql = getTestDb();
    await sql`ALTER TABLE events ADD CONSTRAINT synthetic_failed_write
      CHECK (payload_text IS DISTINCT FROM 'synthetic failed write') NOT VALID`;
    const exporter = new InMemorySpanExporter();
    await shutdownTracing();
    initTracing({ serviceName: 'read-cancellation-test', spanProcessors: [new SimpleSpanProcessor(exporter)] });
    try {
      const holderPid = await holdEventsLock();
      const caller = new AbortController();
      // Through the production wrapper: a failure the tool boundary reported
      // keeps its 5xx, and its cause on the request span, even though nobody
      // is left to receive it.
      const pending = buildWrapperApp(env, null, app).fetch(new Request(`http://localhost/api/${orgSlug}/save_memory`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ semantic_type: 'note', content: 'synthetic failed write' }),
        signal: caller.signal,
      }), env);
      expect(await waitFor(async () => {
        const rows = await sql`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> ${holderPid}`;
        return rows.length ? rows : null;
      }, 5000)).not.toBeNull();
      caller.abort();
      await release?.();
      release = null;
      const response = await pending;
      expect(response.status).toBe(500);
      expect(exporter.getFinishedSpans().find((span) => span.kind === SpanKind.SERVER)?.attributes).toMatchObject({
        'http.response.status_code': 500, 'error.code': '23514',
      });
      // One failure is one issue: the tool boundary's record, not a second
      // copy from the REST wrapper or the HTTP response middleware.
      expect(issues()).toEqual([
        expect.objectContaining({
          tool_name: 'save_memory', call_id: expect.any(String), error_code: '23514',
          error_fingerprint: expect.any(String),
        }),
      ]);
    } finally {
      await release?.();
      release = null;
      await shutdownTracing();
      await sql`ALTER TABLE events DROP CONSTRAINT synthetic_failed_write`;
    }
  });

  it('reports a failed tool call its caller waited for as one issue', async () => {
    const sql = getTestDb();
    await sql`ALTER TABLE events ADD CONSTRAINT synthetic_failed_write
      CHECK (payload_text IS DISTINCT FROM 'synthetic failed write') NOT VALID`;
    try {
      const response = await app.fetch(new Request(`http://localhost/api/${orgSlug}/save_memory`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ semantic_type: 'note', content: 'synthetic failed write' }),
      }), env);
      expect(response.status).toBe(500);
      expect(issues()).toEqual([
        expect.objectContaining({
          msg: 'Tool call failed', tool_name: 'save_memory', error_code: '23514',
          error_fingerprint: expect.any(String),
        }),
      ]);
    } finally {
      await sql`ALTER TABLE events DROP CONSTRAINT synthetic_failed_write`;
    }
  });

  it('reports a refused caller as a user issue, not a system failure', async () => {
    // A read-only token asking for a write is refused by the access gate.
    const denied = await app.fetch(new Request(`http://localhost/api/${orgSlug}/save_memory`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readOnlyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ semantic_type: 'note', content: 'refused write' }),
    }), env);
    expect(denied.status).toBe(403);
    // A client asking for a tool name that does not exist.
    const unknown = await mcpRequest<{ isError?: boolean; structuredContent?: unknown }>(
      'tools/call',
      { name: 'no_such_tool', arguments: {} },
      { token, orgSlug },
    );
    expect(unknown.result?.isError).toBe(true);
    expect(unknown.result?.structuredContent).toBeUndefined();
    expect(issues()).toEqual([
      expect.objectContaining({
        msg: 'Tool call failed', tool_name: 'save_memory', error_class: 'AccessDeniedError',
        error_code: 'PERMISSION', error_kind: 'user',
      }),
      expect.objectContaining({
        msg: 'Tool call failed', tool_name: 'no_such_tool', error_class: 'ToolNotRegisteredError',
        error_code: 'VALIDATION', error_kind: 'user',
      }),
    ]);
  });

  it('reports a timed-out search as one dependency issue, kind taken from its code', async () => {
    // Through the production wrapper, whose response middleware would log any
    // 5xx the route left unreported. Postgres cancelling the read stands in for
    // the statement timeout; the caller is still waiting for the answer.
    const wrapped = buildWrapperApp(env, null, app);
    const holderPid = await holdEventsLock();
    const pending = wrapped.fetch(
      new Request(`http://localhost/api/${orgSlug}/knowledge/search?query=synthetic%20feed%20item`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );
    const blocked = await waitFor(() => blockedReads(holderPid), 5000);
    expect(blocked).not.toBeNull();
    for (const pid of blocked ?? []) await getTestDb()`SELECT pg_cancel_backend(${pid})`;
    await release?.();
    release = null;
    const response = await pending;

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    expect(issues()).toEqual([
      expect.objectContaining({ res_status: 500, error_code: 'UPSTREAM_TIMEOUT', error_kind: 'dependency' }),
    ]);
  });
});
