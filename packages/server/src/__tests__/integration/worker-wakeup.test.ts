import { afterEach, describe, expect, it } from 'vitest';
import { getTestDb } from '../setup/test-db';
import { notifyWorkerWork, waitForWorkerWork } from '../../runs/worker-wakeup';

const controllers: AbortController[] = [];
function signal() {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
}
afterEach(() => { for (const controller of controllers.splice(0)) controller.abort(); });

describe('Postgres worker wake hints', () => {
  it('does not lose a notification arriving between an empty claim and its wait', async () => {
    const sql = getTestDb();
    let attempts = 0;
    let firstClaim!: () => void;
    const claimed = new Promise<void>((resolve) => { firstClaim = resolve; });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const result = waitForWorkerWork({ waitMs: 2000, signal: signal().signal, claim: async () => {
      if (++attempts > 1) return 'claimed';
      firstClaim();
      await paused;
      return null;
    } });
    await claimed;
    // Separate postgres client, as with a source received by another replica.
    await notifyWorkerWork(sql);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect(await result).toBe('claimed');
    expect(attempts).toBe(2);
  });

  it('keeps sibling requests subscribed when one is cancelled', async () => {
    const first = signal();
    const second = signal();
    let ready = false;
    let entered!: () => void;
    const claiming = new Promise<void>((resolve) => { entered = resolve; });
    const a = waitForWorkerWork({ waitMs: 2000, signal: first.signal, claim: async () => null });
    const b = waitForWorkerWork({ waitMs: 2000, signal: second.signal, claim: async () => {
      entered();
      return ready ? 'second' : null;
    } });
    await claiming;
    first.abort();
    expect(await a).toBeNull();
    ready = true;
    await notifyWorkerWork(getTestDb());
    expect(await b).toBe('second');
  });

  it('rechecks durable work without a notification and expires empty waits', async () => {
    let attempts = 0;
    expect(await waitForWorkerWork({ waitMs: 2000, signal: signal().signal,
      claim: async () => ++attempts === 2 ? 'scheduled' : null,
    })).toBe('scheduled');
    const start = performance.now();
    expect(await waitForWorkerWork({ waitMs: 40, signal: signal().signal, claim: async () => null })).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('propagates claim failures and does not claim an aborted request', async () => {
    await expect(waitForWorkerWork({ waitMs: 1000, signal: signal().signal,
      claim: async () => { throw new Error('database unavailable'); },
    })).rejects.toThrow('database unavailable');
    const controller = signal();
    controller.abort();
    let claims = 0;
    expect(await waitForWorkerWork({ waitMs: 1000, signal: controller.signal,
      claim: async () => { claims++; return 'unexpected'; },
    })).toBeNull();
    expect(claims).toBe(0);
  });
});
