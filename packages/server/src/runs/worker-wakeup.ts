import { intervals } from '../config/intervals';
import { getDbListener, type DbClient } from '../db/client';
import { notifyChannelFor } from '../gateway/infrastructure/queue/runs-queue';
import logger from '../utils/logger';

const CHANNEL = notifyChannelFor('worker');

type WakeChannel = { revision: number; callbacks: Set<() => void> };
const channels = new WeakMap<ReturnType<typeof getDbListener>, WakeChannel>();

function workerChannel(): WakeChannel {
  const listener = getDbListener();
  let channel = channels.get(listener);
  if (!channel) {
    const state: WakeChannel = { revision: 0, callbacks: new Set() };
    const changed = () => {
      state.revision++;
      for (const callback of state.callbacks) callback();
    };
    // One subscription per gateway DB client, owned by that client's lifetime.
    // Per-request callbacks below are ephemeral wake hints, never durable work.
    channels.set(listener, state);
    // Start listening before claiming, without making ready work or request
    // cancellation depend on this separate socket connecting. The on-listen
    // callback rechecks durable work after initial connect and reconnect.
    void listener.listen(CHANNEL, changed, changed).catch((error) => {
      channels.delete(listener);
      logger.warn({ error }, 'Worker wake listener unavailable; retaining worker recovery polling');
    });
    channel = state;
  }
  return channel;
}

/** Postgres delivers the hint on commit; the run/feed rows remain authoritative. */
export async function notifyWorkerWork(sql: DbClient): Promise<void> {
  await sql`SELECT pg_notify(${CHANNEL}, '')`;
}

/** Hold the existing claim request. Notifications never contain jobs or authority. */
export async function waitForWorkerWork<T>(options: {
  claim: () => Promise<T | null>;
  waitMs: number;
  signal: AbortSignal;
}): Promise<T | null> {
  if (options.waitMs <= 0) return options.claim();
  const deadline = Date.now() + options.waitMs;
  let wake: (() => void) | undefined;
  const changed = () => wake?.();
  let channel: WakeChannel | undefined;
  try {
    channel = workerChannel();
    channel.callbacks.add(changed);
  } catch (error) {
    logger.warn({ error }, 'Worker wake listener unavailable; retaining worker recovery polling');
  }
  try {
    while (!options.signal.aborted) {
      const observed = channel?.revision;
      const run = await options.claim();
      if (run) return run;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || options.signal.aborted) return null;
      if (channel?.revision !== observed) continue;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', done);
          wake = undefined;
          resolve();
        };
        // Notifications deliver ready work promptly. Keep the existing worker
        // poll cadence for recovery, instead of repeatedly scanning idle feeds
        // at the in-process Automation queue's much shorter cadence.
        const timer = setTimeout(done, Math.min(remaining, intervals.embeddedWorkerPollIntervalMs));
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
