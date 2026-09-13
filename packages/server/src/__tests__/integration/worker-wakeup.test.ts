import { afterEach, describe, expect, it } from 'vitest';
import { getTestDb } from '../setup/test-db';
import { notifyWorkerWork, waitForWorkerWork } from '../../runs/worker-wakeup';

const controllers: AbortController[] = [];
function signal() {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
}

/**
 * The durable-queue recheck (`RUNS_POLL_INTERVAL_MS`, 200ms by default) re-runs
 * `claim` on its own, so at the default cadence every wake assertion below
 * passes whether or not the notification arrives — a dropped `pg_notify` would
 * be invisible. Pinning the fallback far beyond the deadline makes the
 * notification the ONLY thing that can satisfy these tests in time.
 */
const SLOW_FALLBACK_MS = 5000;
const WAKE_DEADLINE_MS = 1000;
let restoreInterval: string | undefined;
let intervalPinned = false;
function pinSlowFallback() {
  restoreInterval = process.env.RUNS_POLL_INTERVAL_MS;
  intervalPinned = true;
  process.env.RUNS_POLL_INTERVAL_MS = String(SLOW_FALLBACK_MS);
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  if (!intervalPinned) return;
  if (restoreInterval === undefined) delete process.env.RUNS_POLL_INTERVAL_MS;
  else process.env.RUNS_POLL_INTERVAL_MS = restoreInterval;
  intervalPinned = false;
});

describe('Postgres worker wake hints', () => {
  it('does not lose a notification arriving between an empty claim and its wait', async () => {
    const sql = getTestDb();
    pinSlowFallback();
    let attempts = 0;
    let firstClaim!: () => void;
    const claimed = new Promise<void>((resolve) => { firstClaim = resolve; });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const result = waitForWorkerWork({ waitMs: SLOW_FALLBACK_MS, signal: signal().signal, stopped: () => false, claim: async () => {
      if (++attempts > 1) return 'claimed';
      firstClaim();
      await paused;
      return null;
    } });
    await claimed;
    // Separate postgres client, as with a source received by another replica.
    await notifyWorkerWork(sql);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const released = performance.now();
    release();
    expect(await result).toBe('claimed');
    expect(attempts).toBe(2);
    expect(performance.now() - released).toBeLessThan(WAKE_DEADLINE_MS);
  });

  it('keeps sibling requests subscribed when one is cancelled', async () => {
    pinSlowFallback();
    const first = signal();
    const second = signal();
    let ready = false;
    let entered!: () => void;
    const claiming = new Promise<void>((resolve) => { entered = resolve; });
    const a = waitForWorkerWork({ waitMs: SLOW_FALLBACK_MS, signal: first.signal, stopped: () => false, claim: async () => null });
    const b = waitForWorkerWork({ waitMs: SLOW_FALLBACK_MS, signal: second.signal, stopped: () => false, claim: async () => {
      entered();
      return ready ? 'second' : null;
    } });
    await claiming;
    first.abort();
    expect(await a).toBeNull();
    ready = true;
    const notified = performance.now();
    await notifyWorkerWork(getTestDb());
    expect(await b).toBe('second');
    expect(performance.now() - notified).toBeLessThan(WAKE_DEADLINE_MS);
  });

  it('rechecks durable work without a notification and expires empty waits', async () => {
    let attempts = 0;
    expect(await waitForWorkerWork({ waitMs: 2000, signal: signal().signal, stopped: () => false,
      claim: async () => ++attempts === 2 ? 'scheduled' : null,
    })).toBe('scheduled');
    const start = performance.now();
    expect(await waitForWorkerWork({ waitMs: 40, signal: signal().signal, stopped: () => false, claim: async () => null })).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('propagates claim failures and does not claim an aborted request', async () => {
    await expect(waitForWorkerWork({ waitMs: 1000, signal: signal().signal, stopped: () => false,
      claim: async () => { throw new Error('database unavailable'); },
    })).rejects.toThrow('database unavailable');
    const controller = signal();
    controller.abort();
    let claims = 0;
    expect(await waitForWorkerWork({ waitMs: 1000, signal: controller.signal, stopped: () => false,
      claim: async () => { claims++; return 'unexpected'; },
    })).toBeNull();
    expect(claims).toBe(0);
  });

  it('gives up the hold once the process starts draining', async () => {
    pinSlowFallback();
    let draining = false;
    let claims = 0;
    // A hold far longer than the HTTP drain budget teardown allows in-flight
    // requests: without the shutdown check it would still be claiming when
    // server-lifecycle closes the listener and pool under it.
    const held = waitForWorkerWork({
      waitMs: 25_000, signal: signal().signal, stopped: () => draining,
      claim: async () => { claims++; return null; },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const drainedAt = performance.now();
    draining = true;
    await notifyWorkerWork(getTestDb());
    expect(await held).toBeNull();
    expect(performance.now() - drainedAt).toBeLessThan(WAKE_DEADLINE_MS);

    // Already draining when the request lands: claim once, never hold.
    const claimsBefore = claims;
    expect(await waitForWorkerWork({
      waitMs: 25_000, signal: signal().signal, stopped: () => true,
      claim: async () => { claims++; return null; },
    })).toBeNull();
    expect(claims).toBe(claimsBefore + 1);
  });
});
