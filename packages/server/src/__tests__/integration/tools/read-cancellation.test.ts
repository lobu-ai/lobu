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
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mcpAuth } from '../../../auth/middleware';
import type { Env } from '../../../index';
import { restToolProxy } from '../../../rest-api';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';

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
  let release: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const org = await createTestOrganization({ name: 'Read Cancellation' });
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'read-cancellation@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    token = (await createTestPAT(user.id, org.id)).token;
    await createTestEvent({ organization_id: org.id, content: 'synthetic feed item' });
    app = new Hono<{ Bindings: Env }>();
    app.post('/api/:orgSlug/:toolName', mcpAuth, (c) => restToolProxy(c));
  });

  afterEach(async () => {
    await release?.();
    release = null;
  });

  async function holdEventsLock(): Promise<number> {
    const holder = await getTestDb().reserve();
    await holder`BEGIN`;
    await holder`LOCK TABLE events IN ACCESS EXCLUSIVE MODE`;
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
  });
});
