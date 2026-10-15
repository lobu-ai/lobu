import { WorkerHttpError, type ExecutorClient } from './client.js';
import { log } from './log.js';

/** Action work stops when its durable lease is revoked. Network failures alone
 * do not prove revocation; the gateway's structured 409 does. */
export function monitorActionRun(
  client: ExecutorClient,
  runId: number,
  cfg: { heartbeatIntervalMs: number; shutdownSignal?: AbortSignal }
) {
  const controller = new AbortController();
  const signal = cfg.shutdownSignal
    ? AbortSignal.any([controller.signal, cfg.shutdownSignal])
    : controller.signal;
  const interval = setInterval(async () => {
    try {
      const response = await client.heartbeat(runId);
      if (response?.continue === false) controller.abort();
    } catch (error) {
      if (error instanceof WorkerHttpError && error.status === 409) controller.abort();
      else log.debug('[executor] Action heartbeat failed:', error);
    }
  }, cfg.heartbeatIntervalMs);
  return { signal, revoked: () => controller.signal.aborted, stop: () => clearInterval(interval) };
}
