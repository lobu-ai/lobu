/**
 * `completeActionOnce` carries an already-decided terminal outcome to the
 * gateway. Losing it costs a real run: the gateway then has no report and the
 * stale-run reaper mislabels a finished action as a timeout. These pin the two
 * properties that make the retry worth having — a hung first attempt is
 * retried inside the remaining budget, and a payload the gateway could not
 * parse is not re-sent.
 */

import { describe, expect, it } from 'bun:test';
import { WorkerDecodeError } from '../daemon/client.js';
import type { ExecutorClient } from '../daemon/client.js';
import { completeActionOnce } from '../daemon/terminal-delivery.js';

type CompletePayload = Parameters<ExecutorClient['completeAction']>[0];

// The production budget compressed: six attempts in 1.2s, 1ms initial backoff.
const FAST = { deadlineMs: 1_200, backoffMs: 1 };

const PAYLOAD = {
  run_id: 1,
  worker_id: 'wk-terminal-delivery',
  status: 'completed',
} as unknown as CompletePayload;

function clientWith(
  completeAction: (payload: CompletePayload) => Promise<void>
): ExecutorClient {
  return { completeAction } as unknown as ExecutorClient;
}

describe('completeActionOnce', () => {
  it('retries a hung attempt instead of spending the whole deadline on it', async () => {
    const calls: number[] = [];
    const started = Date.now();
    const client = clientWith(async () => {
      calls.push(Date.now() - started);
      // The first attempt never settles — exactly the dropped-connection case
      // the deadline exists for. The second answers immediately.
      if (calls.length === 1) return new Promise<void>(() => {});
    });

    await completeActionOnce(client, PAYLOAD, FAST);

    expect(calls.length).toBe(2);
    // The retry starts after the first attempt's sixth of the budget, not
    // after the whole of it: the split is what makes a second attempt possible.
    expect(calls[1]).toBeGreaterThanOrEqual(200);
    expect(calls[1]).toBeLessThan(1_000);
  });

  it('re-sends a payload the gateway rejected transiently', async () => {
    let attempts = 0;
    const client = clientWith(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('socket hang up');
    });

    await completeActionOnce(client, PAYLOAD, FAST);

    expect(attempts).toBe(2);
  });

  it('does NOT re-send a payload the gateway could not decode', async () => {
    let attempts = 0;
    const client = clientWith(async () => {
      attempts += 1;
      throw new WorkerDecodeError('unparseable completion payload');
    });

    await expect(completeActionOnce(client, PAYLOAD, FAST)).rejects.toThrow(WorkerDecodeError);
    expect(attempts).toBe(1);
  });

  it('surfaces the last transport error when every attempt fails', async () => {
    let attempts = 0;
    const client = clientWith(async () => {
      attempts += 1;
      throw new Error(`ECONNRESET ${attempts}`);
    });

    await expect(completeActionOnce(client, PAYLOAD, FAST)).rejects.toThrow('ECONNRESET 6');
    expect(attempts).toBe(6);
  });
});
