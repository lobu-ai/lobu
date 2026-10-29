import { serve } from '@hono/node-server';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { executeRun, WorkerClient } from '@lobu/connector-worker/daemon';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, type Env } from '../../../index';
import { createSyncRun } from '../../../runs/queue-service';
import { materializeDueFeeds } from '../../../scheduled/check-due-feeds';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, seedOwnerContext } from '../../setup/test-fixtures';

const TOKEN = 'synthetic-continuation-worker-token';
const originalFetch = globalThis.fetch;
const old = '2026-01-01T00:00:00.000Z';
let server: ReturnType<typeof serve>;
let baseUrl: string;
const env = {
  ENVIRONMENT: 'test', WORKER_API_TOKEN: TOKEN, RATE_LIMIT_ENABLED: 'false',
  JWT_SECRET: 'test-jwt-secret-for-testing-only', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
} as Env;

beforeAll(async () => {
  await initWorkspaceProvider();
  server = serve({ hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false,
    fetch: request => app.fetch(request, env) });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => { await cleanupTestDatabase(); });
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await cleanupTestDatabase();
});

const issue = (id: number) => ({ id, number: id, title: `Issue ${id}`, body: `Body ${id}`, created_at: old, updated_at: old });
const calendarEvent = (id: string) => ({ id, summary: id, status: 'confirmed', created: old, updated: old,
  start: { dateTime: old }, end: { dateTime: old } });
const cases = [
  { key: 'github', feed: 'issues', host: 'api.github.com',
    config: { repo_owner: 'synthetic', repo_name: 'continuation' }, checkpoint: { last_sync_at: old },
    first: 100, total: 101, tail: 'issue_synthetic_continuation_101', cursorParam: 'page', tailCursor: '2',
    page: (cursor: string | null) => cursor === '2' ? [issue(101)] : Array.from({ length: 100 }, (_, i) => issue(i + 1)),
  },
  { key: 'google_calendar', feed: 'changes', host: 'www.googleapis.com', config: {},
    checkpoint: { scope: JSON.stringify([2, 'primary', 30]), sync_token: 'INITIAL', last_sync_at: old },
    first: 1, total: 2, tail: 'calendar-tail', cursorParam: 'pageToken', tailCursor: 'p3',
    page: (cursor: string | null) => cursor === 'p3'
      ? { items: [calendarEvent('calendar-tail')], nextSyncToken: 'FINAL' }
      : cursor === 'p2' ? { items: [], nextPageToken: 'p3' }
        : { items: [calendarEvent('calendar-first')], nextPageToken: 'p2' },
  },
  { key: 'jira', feed: 'issues', host: 'api.atlassian.com', config: { cloud_id: 'synthetic-cloud', jql: 'order by updated DESC' },
    checkpoint: { last_sync_at: old }, first: 1, total: 2, tail: 'jira_issue_tail', cursorParam: 'nextPageToken', tailCursor: 'p3',
    page: (cursor: string | null) => cursor === 'p3'
      ? { issues: [{ id: 'tail', fields: { summary: 'Tail', updated: old } }] }
      : cursor === 'p2' ? { issues: [], nextPageToken: 'p3' }
        : { issues: [{ id: 'first', fields: { summary: 'First', updated: old } }], nextPageToken: 'p2' },
  },
];

describe('connector continuation through worker HTTP and Postgres', () => {
  it.each(cases)('$key persists pages, schedules continuation, and survives a failed resumed run', async fixture => {
    const sql = getTestDb();
    const owner = await seedOwnerContext();
    await createTestConnectorDefinition({ key: fixture.key, name: 'Synthetic continuation fixture',
      organization_id: owner.org.id, feeds_schema: { [fixture.feed]: {} } });
    const source = fileURLToPath(new URL(`../../../../../connectors/src/${fixture.key}.ts`, import.meta.url));
    const code = await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(source);
    await sql`UPDATE connector_versions SET compiled_code = ${code} WHERE connector_key = ${fixture.key}`;
    const connection = await createTestConnection({ organization_id: owner.org.id, connector_key: fixture.key,
      config: fixture.config, created_by: owner.user.id, createDefaultFeed: false });
    const [feed] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, checkpoint)
      VALUES (${owner.org.id}, ${connection.id}, ${fixture.feed}, 'active', '0 0 * * *', ${sql.json(fixture.checkpoint)}) RETURNING id`;
    const checkpoint = async () => (await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`)[0].checkpoint;
    const origins = async () => (await sql`SELECT origin_id FROM events WHERE connection_id = ${connection.id}
      AND superseded_by IS NULL ORDER BY origin_id`).map(row => row.origin_id);
    const requests: string[] = [];
    let failTail = false;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === baseUrl) return originalFetch(input, init);
      if (url.hostname !== fixture.host) throw new Error(`Unexpected test egress: ${url.origin}`);
      requests.push(url.href);
      if (failTail && url.searchParams.get(fixture.cursorParam) === fixture.tailCursor) {
        return new Response('synthetic provider refusal', { status: 403 });
      }
      return Response.json(fixture.page(url.searchParams.get(fixture.cursorParam)));
    }) as typeof fetch;

    // Real queue creation, worker claim, isolated connector, HTTP stream and completion.
    // Only the external provider and OAuth grant are synthetic.
    let workerNumber = 0;
    const execute = async () => {
      const client = new WorkerClient({ apiUrl: baseUrl, workerId: `synthetic-continuation-${++workerNumber}`,
        authToken: TOKEN, capabilities: {} });
      const claimed = await client.poll(1);
      expect(claimed.run_id).toBeTruthy();
      return executeRun(client, { ...claimed, credentials: { provider: 'synthetic', accessToken: 'synthetic-provider-token' } }, {},
        { generateEmbeddings: false, timeoutMs: 20000 });
    };
    expect((await createSyncRun(Number(feed.id), env)).ok).toBe(true);
    await execute();
    expect(await origins()).toHaveLength(fixture.first);
    const parked = await checkpoint();
    expect(parked.last_sync_at).toBe(old);
    const due = await materializeDueFeeds(env, sql);
    expect(due.runsCreated).toBe(1);

    failTail = true;
    expect((await execute()).error).toContain('(403)');
    expect(await checkpoint()).toEqual(parked);
    expect(await origins()).toHaveLength(fixture.first);
    failTail = false;
    expect((await createSyncRun(Number(feed.id), env)).ok).toBe(true);
    await execute();
    expect(await origins()).toHaveLength(fixture.total);
    expect(await origins()).toContain(fixture.tail);
    const finished = await checkpoint();
    expect(finished.pending).toBeUndefined();
    expect(finished.content).toBeUndefined();
    expect(finished.last_sync_at).not.toBe(old);
    if (fixture.key === 'google_calendar') expect(finished.sync_token).toBe('FINAL');
    expect(new URL(requests.at(-1)!).searchParams.get(fixture.cursorParam)).toBe(fixture.tailCursor);
    expect(await sql`SELECT status FROM runs WHERE feed_id = ${feed.id} ORDER BY id`)
      .toEqual([{ status: 'completed' }, { status: 'failed' }, { status: 'completed' }]);
  }, 60000);

  it.each(['before-commit', 'after-commit', 'exhausted'] as const)(
    'preserves a successful sync when completion delivery is %s', async fault => {
    const fixture = cases[0]!;
    const sql = getTestDb();
    const owner = await seedOwnerContext();
    await createTestConnectorDefinition({ key: fixture.key, name: 'Synthetic delivery fixture',
      organization_id: owner.org.id, feeds_schema: { [fixture.feed]: {} } });
    const source = fileURLToPath(new URL(`../../../../../connectors/src/${fixture.key}.ts`, import.meta.url));
    const code = await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(source);
    await sql`UPDATE connector_versions SET compiled_code = ${code} WHERE connector_key = ${fixture.key}`;
    const connection = await createTestConnection({ organization_id: owner.org.id, connector_key: fixture.key,
      config: fixture.config, created_by: owner.user.id, createDefaultFeed: false });
    const [feed] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, checkpoint)
      VALUES (${owner.org.id}, ${connection.id}, ${fixture.feed}, 'active', '0 0 * * *', ${sql.json(fixture.checkpoint)}) RETURNING id`;
    const completions: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === baseUrl) {
        if (url.pathname === '/api/workers/complete') {
          const payload = JSON.parse(String(init?.body));
          completions.push(payload);
          if (payload.status === 'success' && (completions.length === 1 || fault === 'exhausted')) {
            if (fault === 'after-commit') {
              const response = await originalFetch(input, init);
              expect(response.ok).toBe(true);
              await response.arrayBuffer();
            }
            throw new TypeError('synthetic completion connection reset');
          }
        }
        return originalFetch(input, init);
      }
      if (url.hostname !== fixture.host) throw new Error(`Unexpected test egress: ${url.origin}`);
      return Response.json(fixture.page(url.searchParams.get(fixture.cursorParam)));
    }) as typeof fetch;
    expect((await createSyncRun(Number(feed.id), env)).ok).toBe(true);
    const client = new WorkerClient({ apiUrl: baseUrl, workerId: 'synthetic-delivery-worker',
      authToken: TOKEN, capabilities: {} });
    const claimed = await client.poll(1);
    expect(claimed.run_id).toBeTruthy();
    const execute = (job: Awaited<ReturnType<WorkerClient['poll']>>) => executeRun(client,
      { ...job, credentials: { provider: 'synthetic', accessToken: 'synthetic-provider-token' } }, {},
      { generateEmbeddings: false, timeoutMs: 20000 });
    const result = await execute(claimed);
    expect(result.itemsCollected).toBe(fixture.first);
    expect(completions).toHaveLength(2);
    expect(completions[0]).toEqual(completions[1]);
    expect(completions[0]).toMatchObject({ status: 'success', more: true, items_collected: fixture.first });
    const [run] = await sql`SELECT status FROM runs WHERE id = ${claimed.run_id!}`;
    const [storedFeed] = await sql`SELECT checkpoint, consecutive_failures, last_error FROM feeds WHERE id = ${feed.id}`;
    expect(Number(storedFeed.consecutive_failures)).toBe(0);
    expect(storedFeed.last_error).toBeNull();
    expect(storedFeed.checkpoint.last_sync_at).toBe(old);
    expect(await sql`SELECT origin_id FROM events WHERE connection_id = ${connection.id} AND superseded_by IS NULL`)
      .toHaveLength(fixture.first);
    if (fault === 'exhausted') {
      expect(result.error).toContain('synthetic completion connection reset');
      expect(run.status).toBe('running');
      return;
    }
    expect(result.error).toBeUndefined();
    expect(run.status).toBe('completed');
    expect((await materializeDueFeeds(env, sql)).runsCreated).toBe(1);
    const resumed = await client.poll(1);
    expect(resumed.run_id).toBeTruthy();
    expect((await execute(resumed)).error).toBeUndefined();
    expect(await sql`SELECT origin_id FROM events WHERE connection_id = ${connection.id} AND superseded_by IS NULL`)
      .toHaveLength(fixture.total);
    expect((await sql`SELECT status FROM runs WHERE feed_id = ${feed.id} ORDER BY id`))
      .toEqual([{ status: 'completed' }, { status: 'completed' }]);
  }, 60000);

});
