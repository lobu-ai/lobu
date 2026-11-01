import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { WorkerClient } from '../../../../connector-worker/src/daemon/client';
import { WorkerPollLoop } from '../../../../connector-worker/src/daemon/poll-loop';
import { ResourceAdmission } from '../../../../connector-worker/src/daemon/resource-admission';
import { app } from '../../index';
import { requestFeedSync } from '../../runs/feed-notifications';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, createTestOrganization } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

/**
 * The held claim rechecks durable work every `WORKER_HOLD_RECHECK_MS` (2s by
 * default) whether or not a notification arrives, so at the default cadence the
 * end-to-end assertion below passes even with `notifyWorkerWork` stubbed out —
 * it would measure the fallback, not the dispatch this branch exists to add.
 * Pinning the fallback past the deadline makes the notification the only thing
 * that can satisfy it (`worker-wakeup.test.ts` pins the same knob, for the same
 * reason).
 */
const SLOW_FALLBACK_MS = 5000;

describe('worker dispatch latency', () => {
  let server: Server | undefined;
  let loop: WorkerPollLoop | undefined;
  let running: Promise<void> | undefined;
  let restoreInterval: string | undefined;

  beforeEach(async () => {
    restoreInterval = process.env.WORKER_HOLD_RECHECK_MS;
    process.env.WORKER_HOLD_RECHECK_MS = String(SLOW_FALLBACK_MS);
    await cleanupTestDatabase();
  });
  afterEach(async () => {
    loop?.stop();
    await running;
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    if (restoreInterval === undefined) delete process.env.WORKER_HOLD_RECHECK_MS;
    else process.env.WORKER_HOLD_RECHECK_MS = restoreInterval;
  });

  const token = 'synthetic-dispatch-worker-token';
  const workerEnv = { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL, WORKER_API_TOKEN: token, RATE_LIMIT_ENABLED: 'false', JWT_SECRET: 'test-jwt-secret-for-testing-only', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only' };

  /** Serve the real app over HTTP so a real WorkerClient polls the real route. */
  async function serveWorkerApi(onPoll: () => void = () => {}): Promise<string> {
    // Initialize the same workspace provider used by the HTTP integration suite.
    expect((await post('/api/workers/poll', { token, env: workerEnv, body: { worker_id: 'synthetic-dispatch-warmup', capacity_available: 0 } })).status).toBe(200);
    server = serve({
      port: 0, hostname: '127.0.0.1',
      fetch: async (request) => {
        if (new URL(request.url).pathname === '/api/workers/poll') onPoll();
        return app.fetch(request, workerEnv);
      },
      overrideGlobalObjects: false,
    }) as Server;
    await new Promise<void>((resolve) => server!.listening ? resolve() : server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    return `http://127.0.0.1:${address.port}`;
  }

  it('keeps zero-capacity source submissions immediate and rejects unbounded waits', async () => {
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
    let emptyPoll!: () => void;
    const idle = new Promise<void>((resolve) => { emptyPoll = resolve; });
    // The only feed is not due. Signal while this request is held, before
    // an empty response (otherwise this would miss the in-flight wait race).
    const apiUrl = await serveWorkerApi(() => emptyPoll());
    const client = new WorkerClient({ apiUrl, workerId: 'synthetic-dispatch-worker', authToken: token, capabilities: {} });
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

  it('keeps agent turns and connector work on separate budgets', async () => {
    // Runs are inserted directly, so no notification wakes the held poll;
    // a short recheck keeps each claim prompt.
    process.env.WORKER_HOLD_RECHECK_MS = '100';
    const sql = getTestDb();
    const org = await createTestOrganization();
    const connectorKey = 'synthetic.worker-budgets';
    await createTestConnectorDefinition({ key: connectorKey, name: 'Synthetic budget source', organization_id: org.id });
    const connection = await createTestConnection({ connector_key: connectorKey, organization_id: org.id, createDefaultFeed: false });
    const pendingSync = async () => Number((await sql`
      INSERT INTO runs (organization_id, run_type, connection_id, connector_key, connector_version, approval_status, status)
      VALUES (${org.id}, 'sync', ${connection.id}, ${connectorKey}, '1.0.0', 'auto', 'pending') RETURNING id
    `)[0].id);
    const pendingTurn = async (conversationId: string) => Number((await sql`
      INSERT INTO runs (organization_id, run_type, action_input, approval_status, status, run_at)
      VALUES (${org.id}, 'agent_turn', ${sql.json({
        turn: { agent_id: 'synthetic-agent', conversation_id: conversationId },
        credential: 'synthetic-turn-credential',
      })}, 'auto', 'pending', now()) RETURNING id
    `)[0].id);

    const apiUrl = await serveWorkerApi();
    // What a fleet daemon advertises: the agent-turn lane and a ready
    // compiled-connector backend.
    const client = new WorkerClient({
      apiUrl, workerId: 'synthetic-budget-worker', authToken: token,
      capabilities: { agent_turn: true }, backendCapacity: { compiled_connector: 1 },
    });
    const started: number[] = [];
    const finish = new Map<number, () => void>();
    loop = new WorkerPollLoop({
      client, pollIntervalMs: 200, maxConcurrentJobs: 1, maxConcurrentAgentTurns: 1,
      execute: (job) => new Promise<void>((resolve) => {
        started.push(Number(job.run_id));
        finish.set(Number(job.run_id), resolve);
      }),
    });
    running = loop.start();
    const claim = (runId: number) =>
      vi.waitFor(() => expect(started).toContain(runId), { timeout: 5000, interval: 50 });
    // Several held-poll rechecks: long enough for a wrongly admitted run to start.
    const staysPending = async (runId: number) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(started).not.toContain(runId);
      const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
      expect(row.status).toBe('pending');
    };
    try {
      // A long sync holds the only connector slot, so the next sync waits...
      const sync = await pendingSync();
      await claim(sync);
      const waitingSync = await pendingSync();
      await staysPending(waitingSync);
      // ...while a chat turn still starts on its own budget.
      const turn = await pendingTurn('synthetic-conversation-a');
      await claim(turn);

      // With the turn budget full, a freed connector slot takes the sync and
      // leaves the next turn queued, even when nothing else is waiting.
      const queuedTurn = await pendingTurn('synthetic-conversation-b');
      finish.get(sync)!();
      await claim(waitingSync);
      finish.get(waitingSync)!();
      await staysPending(queuedTurn);

      // Releasing the turn slot admits the queued turn.
      finish.get(turn)!();
      await claim(queuedTurn);
      expect(started).toEqual([sync, turn, waitingSync, queuedTurn]);
    } finally {
      for (const done of finish.values()) done();
    }
  });

  it('leaves work pending under resource pressure and recovers while the first turn stays resident', async () => {
    process.env.WORKER_HOLD_RECHECK_MS = '100';
    const sql = getTestDb();
    const org = await createTestOrganization();
    const enqueue = async (conversation: string) => Number((await sql`
      INSERT INTO runs (organization_id, run_type, action_input, approval_status, status, run_at)
      VALUES (${org.id}, 'agent_turn', ${sql.json({
        turn: { agent_id: 'synthetic-agent', conversation_id: conversation },
        credential: 'synthetic-credential',
      })}, 'auto', 'pending', now()) RETURNING id
    `)[0].id);
    const first = await enqueue('synthetic-resident-turn');
    const second = await enqueue('synthetic-queued-turn');
    let usedBytes = 100;
    const admission = new ResourceAdmission(() => ({
      memory: [{ usedBytes, limitBytes: 1000 }], cpu: [],
    }));
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const client = new WorkerClient({
      apiUrl: await serveWorkerApi(), workerId: 'synthetic-resource-worker', authToken: token,
      capabilities: { agent_turn: true }, backendCapacity: { compiled_connector: 0 },
    });
    loop = new WorkerPollLoop({
      client, resourceAdmission: admission, maxConcurrentJobs: 1, maxConcurrentAgentTurns: 8,
      execute: job => new Promise<void>(resolve => {
        started.push(Number(job.run_id)); finish.push(resolve); usedBytes = 900;
      }),
    });
    running = loop.start();
    try {
      await vi.waitFor(() => expect(started).toEqual([first]), { timeout: 3000 });
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(started).toEqual([first]);
      expect((await sql`SELECT status, claimed_by FROM runs WHERE id = ${second}`)[0]).toMatchObject({ status: 'pending', claimed_by: null });
      usedBytes = 100;
      await vi.waitFor(() => expect(started).toEqual([first, second]), { timeout: 1500 });
      expect((await sql`SELECT claimed_by FROM runs WHERE id = ${second}`)[0].claimed_by).toBe('synthetic-resource-worker');
    } finally {
      loop.stop(); for (const done of finish) done();
      await loop.waitForActiveJobs(1000, 1);
    }
  });
});
