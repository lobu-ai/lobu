import { classifyToolError, getErrorMessage, type ToolErrorCode } from '@lobu/core';
import type { DbClient, DbQuery } from '../db/client';
import { ToolUserError, toolErrorHttpStatus } from './errors';
import { isQueryCanceled } from './pg-errors';
import { raceAbort } from './race-abort';

/**
 * Await a statement that stops on Postgres as soon as `signal` aborts.
 *
 * A statement still waiting for a pool connection is dropped before it reaches
 * the database; a running one is sent a cancel request. A cancel request is
 * best effort, so pair this with a server-side cap (`boundedRead`). When the
 * abort caused the failure the caller sees `signal.reason`, so a caller that
 * left is never reported as a statement timeout.
 */
export async function cancellable<T>(
  query: DbQuery<T>,
  signal?: AbortSignal
): Promise<Awaited<DbQuery<T>>> {
  if (!signal) return query;
  // A postgres.js statement only runs once awaited, so this never reaches the DB.
  signal.throwIfAborted();
  const cancel = () => (query as { cancel?: () => void }).cancel?.();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await query;
  } catch (error) {
    if (signal.aborted && isQueryCanceled(error)) throw signal.reason;
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export interface BoundedReadOptions {
  /** The caller's lifetime. Its abort cancels whichever statement is running. */
  signal?: AbortSignal;
  /** Per-statement cap Postgres enforces, whatever the caller does. */
  statementTimeoutMs: number;
}

/**
 * Run read statements in one read-only transaction that Postgres caps per
 * statement and that stops when the caller is gone.
 *
 * The statement timeout is the backstop: it holds when a cancel request is
 * lost or the caller never disconnects. It does not cover waiting for a pool
 * connection, so the caller is released as soon as it aborts and the
 * transaction rolls back right after BEGIN, before any statement runs. Wrap
 * each statement in `cancellable`.
 */
export function boundedRead<T>(
  sql: DbClient,
  options: BoundedReadOptions,
  run: (tx: DbClient) => Promise<T>
): Promise<T> {
  const timeoutMs = options.statementTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`statementTimeoutMs must be a positive integer, got ${timeoutMs}`);
  }
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const transaction = sql.begin('read only', async (tx) => {
    options.signal?.throwIfAborted();
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return run(tx);
  });
  return raceAbort(transaction, options.signal);
}

/** One statement under `boundedRead`. */
export function boundedQuery<T = any>(
  sql: DbClient,
  query: string,
  params: unknown[],
  options: BoundedReadOptions
): Promise<Awaited<DbQuery<T>>> {
  return boundedRead(sql, options, (tx) => cancellable(tx.unsafe<T>(query, params), options.signal));
}

/**
 * Classify a failed member SQL read (`query_sql`, `client.query`) by SQLSTATE.
 * Both readers run under `boundedRead`, so they share this one mapping and
 * report the same code and message for the same statement.
 */
export function classifyReadQueryFailure(error: unknown): { code: ToolErrorCode; message: string } {
  const pgCode = (error as { code?: unknown } | null)?.code;
  if (pgCode === '57014') {
    return { code: 'UPSTREAM_TIMEOUT', message: 'Query exceeded the 5 second timeout.' };
  }
  // read_only_sql_transaction: the statement tried to write.
  if (pgCode === '25006') {
    return { code: 'VALIDATION', message: 'Only read-only queries are allowed.' };
  }
  const message = getErrorMessage(error);
  return {
    code: classifyToolError({ pgCode: typeof pgCode === 'string' ? pgCode : undefined, message }),
    message,
  };
}

/**
 * A statement Postgres stopped at its time cap, as the retryable timeout every
 * response boundary answers with. Anything else comes back unchanged.
 */
export function asReadTimeout(error: unknown): unknown {
  if (!isQueryCanceled(error)) return error;
  const code = classifyToolError({ pgCode: '57014' });
  return new ToolUserError(
    'The database stopped this call at its time limit. Narrow the request, for example with a smaller limit or a shorter time window, and retry.',
    toolErrorHttpStatus(code),
    code
  );
}
