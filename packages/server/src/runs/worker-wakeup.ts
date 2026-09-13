import { intervals } from '../config/intervals';
import { getDbListener, type DbClient } from '../db/client';
import { notifyChannelFor } from '../gateway/infrastructure/queue/runs-queue';
import logger from '../utils/logger';

const CHANNEL = notifyChannelFor('worker');

type WakeChannel = { revision: number; callbacks: Set<() => void> };
const channels = new WeakMap<ReturnType<typeof getDbListener>, Promise<WakeChannel>>();

function workerChannel(): Promise<WakeChannel> {
  const listener = getDbListener();
  let pending = channels.get(listener);
  if (!pending) {
    const state: WakeChannel = { revision: 0, callbacks: new Set() };
    const changed = () => {
      state.revision++;
      for (const callback of state.callbacks) callback();
    };
    // One subscription per gateway DB client, owned by that client's lifetime.
    // Per-request callbacks below are ephemeral wake hints, never durable work.
    pending = listener.listen(CHANNEL, changed, changed).then(() => state).catch((error) => {
      channels.delete(listener);
      throw error;
    });
    channels.set(listener, pending);
  }
  return pending;
}

/**
 * Postgres delivers the hint on commit; the run/feed rows remain authoritative.
 * A failed hint must never fail the write that produced the work — held claims
 * recheck on their own fallback tick, exactly as `RunsQueue.enqueue` treats its
 * own `pg_notify`.
 */
export async function notifyWorkerWork(sql: DbClient): Promise<void> {
  try {
    await sql`SELECT pg_notify(${CHANNEL}, '')`;
  } catch (error) {
    logger.warn({ error }, 'Worker wake notification failed; held claims fall back to polling');
  }
}

/** Hold the existing claim request. Notifications never contain jobs or authority. */
export async function waitForWorkerWork<T>(options: {
  claim: () => Promise<T | null>;
  waitMs: number;
  signal: AbortSignal;
  /**
   * Give up the hold while this reports true. A held claim outlives the HTTP
   * drain budget (`HTTP_CLOSE_TIMEOUT_MS`, 10s) that teardown allows in-flight
   * requests, so on SIGTERM an unbounded hold would still be claiming when
   * `server-lifecycle.ts` closes the DB listener and pool underneath it.
   * Answering early keeps the request inside the budget it is given.
   */
  stopped: () => boolean;
}): Promise<T | null> {
  if (options.waitMs <= 0 || options.stopped()) return options.claim();
  const deadline = Date.now() + options.waitMs;
  let wake: (() => void) | undefined;
  const changed = () => wake?.();
  let channel: WakeChannel | undefined;
  try {
    // Subscribe before claiming: a commit between an empty claim and the wait
    // must remain visible. postgres-js multiplexes listeners on its one socket.
    channel = await workerChannel();
    channel.callbacks.add(changed);
  } catch (error) {
    logger.warn({ error }, 'Worker wake listener unavailable; retaining runs-queue polling');
  }
  try {
    while (!options.signal.aborted && !options.stopped()) {
      const observed = channel?.revision;
      const run = await options.claim();
      if (run) return run;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || options.signal.aborted || options.stopped()) return null;
      if (channel?.revision !== observed) continue;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', done);
          wake = undefined;
          resolve();
        };
        // Same fallback cadence as the existing durable queue. This covers
        // scheduled work, missed notifications and older producers during rollout.
        const timer = setTimeout(done, Math.min(remaining, intervals.runsPollIntervalMs));
        wake = done;
        options.signal.addEventListener('abort', done, { once: true });
        if (options.signal.aborted || channel?.revision !== observed) done();
      });
    }
    return null;
  } finally {
    channel?.callbacks.delete(changed);
  }
}
