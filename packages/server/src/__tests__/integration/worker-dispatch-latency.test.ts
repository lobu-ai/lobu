import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { WorkerClient } from '../../../../connector-worker/src/daemon/client';
import { WorkerPollLoop } from '../../../../connector-worker/src/daemon/poll-loop';
import { app } from '../../index';
import { requestFeedSync } from '../../runs/feed-notifications';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, createTestOrganization } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

describe('worker dispatch latency', () => {
  let server: Server | undefined;
  let loop: WorkerPollLoop | undefined;
  let running: Promise<void> | undefined;

  beforeEach(cleanupTestDatabase);
  afterEach(async () => {
    loop?.stop();
    await running;
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  });

  it('keeps zero-capacity source submissions immediate and rejects unbounded waits', async () => {
    const token = 'synthetic-dispatch-worker-token';
    const env = { WORKER_API_TOKEN: token };
    const start = performance.now();
    const response = await post('/api/workers/poll', { token, env, body: {
      worker_id: 'synthetic-capacity-zero', capacity_available: 0, wait_seconds: 25,
      feed_notifications: [{ feed_id: 123, connection_id: 456, feed_key: 'items', notification_id: 'synthetic-notice', changed: true }],
    } });
    expect(response.status).toBe(200);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(await response.json()).toMatchObject({ feed_notification_receipts: [{ active: false }] });
    for (const wait_seconds of [-1, 26, 1.5]) {
      expect((await post('/api/workers/poll', { token, env, body: {
        worker_id: 'synthetic-invalid-wait', wait_seconds,
      } })).status).toBe(400);
    }
  });

  it('starts an idle worker promptly when a source makes its feed due', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const connectorKey = 'synthetic.dispatch-latency';
    await createTestConnectorDefinition({
      key: connectorKey, name: 'Synthetic dispatch source', organization_id: org.id,
      feeds_schema: { items: { operations: ['sync'], webhook: { mode: 'trigger', events: ['changed'] } } },
    });
    const connection = await createTestConnection({ connector_key: connectorKey, organization_id: org.id, createDefaultFeed: false });
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
      VALUES (${org.id}, ${connection.id}, 'items', 'active', NULL, NULL) RETURNING id
    `;
    const token = 'synthetic-dispatch-worker-token';
    const env = { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL, WORKER_API_TOKEN: token, RATE_LIMIT_ENABLED: 'false', JWT_SECRET: 'test-jwt-secret-for-testing-only', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only' };
    // Initialize the same workspace provider used by the HTTP integration suite.
    expect((await post('/api/workers/poll', { token, env, body: { worker_id: 'synthetic-dispatch-warmup', capacity_available: 0 } })).status).toBe(200);
    let emptyPoll!: () => void;
    const idle = new Promise<void>((resolve) => { emptyPoll = resolve; });
    server = serve({
      port: 0, hostname: '127.0.0.1',
      fetch: async (request) => {
        // The only feed is not due. Signal while this request is held, before
        // an empty response (otherwise this would miss the in-flight wait race).
        if (new URL(request.url).pathname === '/api/workers/poll') {
          emptyPoll();
        }
        return app.fetch(request, env);
      },
      overrideGlobalObjects: false,
    }) as Server;
    await new Promise<void>((resolve) => server!.listening ? resolve() : server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const client = new WorkerClient({ apiUrl: `http://127.0.0.1:${address.port}`, workerId: 'synthetic-dispatch-worker', authToken: token, capabilities: {} });
    let resolveClaim!: (value: { runId: number; at: number }) => void;
    const claimed = new Promise<{ runId: number; at: number }>((resolve) => { resolveClaim = resolve; });
    loop = new WorkerPollLoop({ client, execute: async (job) => {
      resolveClaim({ runId: Number(job.run_id), at: performance.now() });
      loop!.stop();
    } });
    running = loop.start();
    await idle;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sentAt = performance.now();
    await requestFeedSync(sql, sql`SELECT id FROM feeds WHERE id = ${feed.id}`);
    const result = await claimed;
    const [run] = await sql`SELECT feed_id, claimed_by FROM runs WHERE id = ${result.runId}`;
    expect(Number(run.feed_id)).toBe(Number(feed.id));
    expect(run.claimed_by).toBe('synthetic-dispatch-worker');
    const latencyMs = result.at - sentAt;
    console.info(`source signal -> worker execution: ${Math.round(latencyMs)}ms`);
    expect(latencyMs).toBeLessThan(1000);
  });
});
