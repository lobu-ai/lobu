import { classifyToolError, getErrorMessage, type ToolErrorCode } from '@lobu/core';
import type { AuthzScope } from '../authz/scope';
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
  /**
   * The workspace and principal member SQL is scoped to: the scope its CTEs
   * were built from (`buildScopedQuery`). The transaction then reads as the
   * `lobu_member_sql` role, whose row-level security policies apply the same
   * tenancy before any caller predicate can see a row.
   */
  fence?: AuthzScope;
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
    if (options.fence) {
      // Transaction-local, so the settings and the role end with this
      // transaction on whichever pooled connection ran it.
      await tx.unsafe(
        `SELECT set_config('lobu.member_sql_org', $1, true),
          set_config('lobu.member_sql_principal', $2, true),
          set_config('role', 'lobu_member_sql', true)`,
        [options.fence.organizationId, options.fence.principal ?? '']
      );
    }
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
 * The caller-facing text of a failed member SQL read.
 *
 * Scope CTEs are inlined, so the planner may run a caller's predicate on a row
 * before the scope predicate removes it, and a database error raised by that
 * row's value quotes the value (`invalid input syntax for type integer: "…"`,
 * `relation "…" does not exist`). Only an error Postgres raised while parsing
 * the statement carries a `position`, and it can quote nothing but the
 * caller's own SQL text. Every other database error, and every data exception
 * (22xxx) or integrity violation (23xxx) whatever its origin, is reduced to its
 * SQLSTATE. Errors that did not come from Postgres pass through unchanged.
 */
export function readQueryFailureMessage(error: unknown): string {
  const message = getErrorMessage(error);
  const pgCode = postgresErrorCode(error);
  if (!pgCode) return message;
  const position = (error as { position?: unknown }).position;
  const sqlClass = pgCode.slice(0, 2);
  const parseError = typeof position === 'string' && position !== '';
  if (parseError && sqlClass !== '22' && sqlClass !== '23') return message;
  return (
    `The query failed while evaluating row values (SQLSTATE ${pgCode}). ` +
    'The database error text is withheld because it can quote rows outside your access; ' +
    'check the casts and functions applied to column values.'
  );
}

/**
 * A five-character SQLSTATE from Postgres. postgres.js reports its own
 * failures with longer codes (`CONNECTION_CLOSED`), and an errno such as
 * `EPIPE` is the one five-character shape that is not a SQLSTATE.
 */
function postgresErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length === 5 && !code.startsWith('E') ? code : undefined;
}

/**
 * Classify a failed member SQL read (`query_sql`, `client.query`) by SQLSTATE.
 * Both readers run under `boundedRead`, so they share this one mapping and
 * report the same code and message for the same statement.
 */
export function classifyReadQueryFailure(error: unknown): { code: ToolErrorCode; message: string } {
  const pgCode = postgresErrorCode(error);
  if (pgCode === '57014') {
    return { code: 'UPSTREAM_TIMEOUT', message: 'Query exceeded the 5 second timeout.' };
  }
  // read_only_sql_transaction: the statement tried to write.
  if (pgCode === '25006') {
    return { code: 'VALIDATION', message: 'Only read-only queries are allowed.' };
  }
  // insufficient_privilege: under the fence, the statement reached a relation
  // or function outside the workspace tables (a sequence write, a system view).
  if (pgCode === '42501') {
    return {
      code: 'VALIDATION',
      message: 'Only read-only queries over the workspace tables are allowed; the query used a relation or function outside them.',
    };
  }
  const rawCode = (error as { code?: unknown } | null)?.code;
  return {
    code: classifyToolError({
      pgCode: typeof rawCode === 'string' ? rawCode : undefined,
      message: getErrorMessage(error),
    }),
    message: readQueryFailureMessage(error),
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
