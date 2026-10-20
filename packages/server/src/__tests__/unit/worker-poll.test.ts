import { describe, expect, mock, spyOn, test } from 'bun:test';
import { serveWorkerJobs } from '../setup/worker-poll';

describe('serveWorkerJobs', () => {
  test('keeps serving past the former attempt cap and returns a false done value', async () => {
    let polls = 0;
    const handle = mock(async () => ({ done: false }));
    const result = await serveWorkerJobs({
      deadlineMs: 10_000,
      intervalMs: 0,
      poll: async () => ++polls <= 75 ? (polls % 2 ? null : {}) : { run_id: 1 },
      handle,
    });
    expect(polls).toBe(76);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  test('stops polling once the served promise settles', async () => {
    let polls = 0;
    const until = Promise.reject(new Error('read failed'));
    const result = await serveWorkerJobs({
      until,
      deadlineMs: 1000,
      intervalMs: 0,
      poll: async () => { polls += 1; return null; },
      handle: async () => ({ done: true }),
    });
    expect(result).toBeUndefined();
    expect(polls).toBeLessThanOrEqual(1);
    await expect(until).rejects.toThrow('read failed');
  });

  test('stops at the wall-clock deadline', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let polls = 0;
      const result = await serveWorkerJobs({
        deadlineMs: 100,
        intervalMs: 0,
        poll: async () => { polls += 1; now += 60; return null; },
        handle: async () => ({ done: true }),
      });
      expect(result).toBeUndefined();
      expect(polls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  test('continues when the handler has more work to serve', async () => {
    let polls = 0;
    const result = await serveWorkerJobs({
      deadlineMs: 1000,
      intervalMs: 0,
      poll: async () => ({ run_id: ++polls }),
      handle: async (job) => job.run_id === 2 ? { done: job.run_id } : undefined,
    });
    expect(result).toBe(2);
    expect(polls).toBe(2);
  });

  test.each(['poll', 'handle'] as const)('propagates %s failures', async (stage) => {
    await expect(serveWorkerJobs({
      deadlineMs: 1000,
      poll: async () => {
        if (stage === 'poll') throw new Error('poll failed');
        return { run_id: 1 };
      },
      handle: async () => { throw new Error('handle failed'); },
    })).rejects.toThrow(`${stage} failed`);
  });
});
