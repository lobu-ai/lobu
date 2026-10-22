/**
 * Transient-connection retry for postgres.js queries.
 *
 * The prod DB sits behind a session-mode connection pooler
 * (`lobu-ai-prod-db-pooler`). With the client pool's `idle_timeout: 0`
 * (see db/client.ts) a socket can stay checked-out long after the pooler — or
 * an intermediary LB — has silently closed the far end (idle eviction, pooler
 * reload/rollout). postgres.js only discovers the dead socket when it writes
 * the next query, which it then rejects with `CONNECTION_ENDED`. The query
 * never round-tripped (the write failed before reaching the backend), so the
 * backend rolled back any open transaction — re-running on a fresh connection
 * is safe.
 *
 * This surfaced as periodic 500s on `POST /api/workers/poll` (the most
 * frequent, most-often-idle query path) that self-heal on the next poll, but
 * the same gap can 500 any query under the shared pool — including a
 * user-facing request.
 *
 * `fn` MUST be a re-runnable thunk: a rejected postgres.js `PendingQuery`
 * cannot be re-awaited, so we re-invoke the whole operation. Only wrap
 * operations that are safe to run twice (idempotent reads, `FOR UPDATE SKIP
 * LOCKED` claims, transactions with no external side effects).
 */
import { retryWithBackoff } from '@lobu/core';
import { incrementCounter } from '../gateway/metrics/prometheus';
import logger from '../utils/logger';

/** postgres.js / socket error codes that mean the connection died before the
 *  query round-tripped — safe to retry on a fresh connection. Deliberately
 *  narrow: query-level failures (deadlocks, constraint violations, statement
 *  timeouts) are NOT transient and must not be retried. */
const TRANSIENT_CONN_CODES = [
  'CONNECTION_ENDED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'ECONNRESET',
  'EPIPE',
];

export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CONN_CODES.includes(code)) {
    return true;
  }
  // postgres.js stamps the code into `.code`, but a wrapped/relayed error may
  // only carry it in the message ("write CONNECTION_ENDED <host>").
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') {
    return TRANSIENT_CONN_CODES.some((c) => message.includes(c));
  }
  return false;
}

/**
 * Run a re-runnable DB thunk, retrying on a transient connection drop.
 *
 * `op` labels the metric so an operator can see which call sites hit
 * stale-socket drops — alert on
 * `rate(lobu_db_conn_retry_total{outcome="exhausted"}[5m])` (those still 500).
 */
export function noteDbConnRetry(op: string, attempt: number, error: Error): void {
  incrementCounter('lobu_db_conn_retry_total', { op, outcome: 'retried' });
  logger.warn(
    { op, attempt, err: error.message },
    'transient DB connection drop — retrying query on a fresh connection'
  );
}

export async function withDbRetry<T>(
  op: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await retryWithBackoff(fn, {
      maxRetries: 2,
      baseDelay: 50,
      maxDelay: 250,
      shouldRetry: (error) => isTransientDbError(error),
      onRetry: (attempt, error) => noteDbConnRetry(op, attempt, error),
    });
  } catch (error) {
    if (isTransientDbError(error)) {
      incrementCounter('lobu_db_conn_retry_total', { op, outcome: 'exhausted' });
    }
    throw error;
  }
}
