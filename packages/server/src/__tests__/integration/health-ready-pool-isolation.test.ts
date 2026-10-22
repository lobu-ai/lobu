/**
 * `/health/ready` must answer from its OWN connection, never the main pool.
 *
 * Prod runs one app replica. When heavy reads saturated the main pool, the
 * readiness `SELECT 1` queued behind them, the kubelet's 3s probe timed out on
 * a healthy pod, and k8s pulled the only endpoint from the Service — every
 * client then got `503 no available server` from the ingress.
 *
 * The probe still has to fail on the two things it exists to detect: a real
 * database outage and the graceful-shutdown drain.
 */

import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDbSingleton, getDb } from '../../db/client';
import { app } from '../../index';
import * as lifecycleState from '../../lifecycle-state';

/** The chart's readinessProbe.timeoutSeconds — what the kubelet waits for. */
const PROBE_TIMEOUT_MS = 3000;

type ProbeAnswer = { status: number; body: Record<string, unknown> };
type ProbeResult = ProbeAnswer | 'probe-timeout';

async function probeReady(): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'probe-timeout'>((resolve) => {
    timer = setTimeout(() => resolve('probe-timeout'), PROBE_TIMEOUT_MS);
  });
  const answered = (async () => {
    const res = await app.request('/health/ready');
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  })();
  // A late answer from a timed-out probe must not surface as unhandled.
  answered.catch(() => undefined);
  try {
    return await Promise.race([answered, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The kubelet got an answer: the probe did not hang past its timeout. */
function expectAnswered(result: ProbeResult): asserts result is ProbeAnswer {
  expect(result).not.toBe('probe-timeout');
}

describe('/health/ready', () => {
  beforeEach(() => {
    // The shutdown flag is process-wide and one-way, and vitest.config.ts runs
    // every file in one module registry (`isolate: false`), so a file that drove
    // a real shutdown earlier in the run (src/__tests__/server-lifecycle.test.ts)
    // leaves it set. Pin it so each case states its own lifecycle phase.
    vi.spyOn(lifecycleState, 'isShuttingDown').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays ready while every main-pool connection is held', async () => {
    const poolMax = Number.parseInt(process.env.DB_POOL_MAX || '20', 10);
    const db = getDb() as unknown as {
      reserve: () => Promise<{ release: () => void }>;
    };
    const held: { release: () => void }[] = [];
    try {
      for (let i = 0; i < poolMax; i++) held.push(await db.reserve());

      const result = await probeReady();
      expect(result).toEqual({
        status: 200,
        body: { status: 'ok', service: 'lobu-api' },
      });
    } finally {
      for (const conn of held) conn.release();
    }
  });

  it('reports unready when the database is unreachable', async () => {
    const realUrl = process.env.DATABASE_URL;
    // Drop every cached pool so the probe has to dial the dead address.
    await closeDbSingleton();
    process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/unreachable_test';
    try {
      const result = await probeReady();
      expectAnswered(result);
      expect(result.status).toBe(503);
      expect(result.body.status).toBe('unready');
    } finally {
      process.env.DATABASE_URL = realUrl;
      await closeDbSingleton();
    }
  });

  it('reports unready, within the probe timeout, when the database hangs', async () => {
    // Accepts TCP and never answers: the shape of a wedged pooler.
    const sockets = new Set<net.Socket>();
    const blackhole = net.createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const { port } = blackhole.address() as net.AddressInfo;
    const realUrl = process.env.DATABASE_URL;
    await closeDbSingleton();
    process.env.DATABASE_URL = `postgresql://nobody:nothing@127.0.0.1:${port}/hung_test`;
    try {
      const result = await probeReady();
      expectAnswered(result);
      expect(result.status).toBe(503);
      expect(result.body.status).toBe('unready');
    } finally {
      process.env.DATABASE_URL = realUrl;
      await closeDbSingleton();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
    // The wedged connection was discarded: the next probe dials the real DB.
    expect(await probeReady()).toEqual({
      status: 200,
      body: { status: 'ok', service: 'lobu-api' },
    });
  });

  it('reports draining once shutdown has begun', async () => {
    vi.mocked(lifecycleState.isShuttingDown).mockReturnValue(true);
    const result = await probeReady();
    expect(result).toEqual({
      status: 503,
      body: { status: 'draining', service: 'lobu-api' },
    });
  });
});
