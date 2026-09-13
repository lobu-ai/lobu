import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controller = new AbortController();
let listen: ReturnType<typeof vi.fn>;
let waitForWorkerWork: typeof import('../../runs/worker-wakeup').waitForWorkerWork;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  listen = vi.fn(() => new Promise(() => {}));
  const listener = { listen };
  vi.doMock('../../db/client', () => ({ getDbListener: () => listener }));
  vi.doMock('../../gateway/infrastructure/queue/runs-queue', () => ({ notifyChannelFor: () => 'worker' }));
  vi.doMock('../../utils/logger', () => ({ default: { warn: vi.fn() } }));
  ({ waitForWorkerWork } = await import('../../runs/worker-wakeup'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('../../db/client');
  vi.doUnmock('../../gateway/infrastructure/queue/runs-queue');
  vi.doUnmock('../../utils/logger');
  vi.resetModules();
});

describe('worker wake listener availability', () => {
  it('claims ready work even while LISTEN is still connecting', async () => {
    const claim = vi.fn(async () => 'ready');
    const result = waitForWorkerWork({ claim, waitMs: 25_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(await result).toBe('ready');
  });

  it('expires or cancels a wait even when LISTEN never connects', async () => {
    const abort = new AbortController();
    const result = waitForWorkerWork({ claim: async () => null, waitMs: 25_000, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect(await result).toBeNull();
    const expired = waitForWorkerWork({ claim: async () => null, waitMs: 100, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    expect(await expired).toBeNull();
  });

  it('uses the worker recovery cadence without repeatedly scanning idle feeds', async () => {
    listen.mockResolvedValue({});
    const claim = vi.fn(async () => null);
    const abort = new AbortController();
    const result = waitForWorkerWork({ claim, waitMs: 25_000, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(claim).toHaveBeenCalledTimes(1);
    abort.abort();
    expect(await result).toBeNull();
  });
});
