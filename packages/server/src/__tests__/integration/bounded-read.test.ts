/**
 * `boundedRead` against a real Postgres: the caller's abort and the
 * per-statement cap each stop a read on the server, and neither leaves the
 * pooled connection unusable.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbClient, PROD_PG_VALUE_OPTIONS } from '../../db/client';
import { asReadTimeout, boundedQuery, boundedRead, cancellable } from '../../utils/bounded-read';
import { ToolUserError } from '../../utils/errors';
import { getTestDb } from '../setup/test-db';

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Backends currently running `text`, seen from outside the pool under test. */
async function running(text: string): Promise<number[] | null> {
  const rows = await getTestDb()<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND query = ${text}
  `;
  return rows.length > 0 ? rows.map((row) => row.pid) : null;
}

describe('boundedRead', () => {
  // One connection, so a stuck transaction would show up as the next read hanging.
  const sent: string[] = [];
  let pool: postgres.Sql;
  let sql: DbClient;

  beforeAll(() => {
    pool = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      onnotice: () => {},
      debug: (_connection, query) => sent.push(query),
      ...PROD_PG_VALUE_OPTIONS,
    });
    sql = pool as unknown as DbClient;
  });

  afterAll(async () => {
    await pool.end({ timeout: 5 });
  });

  /** The connection is back in autocommit, with none of the read's settings left. */
  async function expectConnectionReusable(): Promise<void> {
    const [row] = await pool<{ read_only: string; statement_timeout: string }[]>`
      SELECT current_setting('transaction_read_only') AS read_only,
             current_setting('statement_timeout') AS statement_timeout
    `;
    expect(row).toEqual({ read_only: 'off', statement_timeout: '0' });
  }

  it('cancels the running statement on Postgres when the caller aborts', async () => {
    const text = 'SELECT pg_sleep(30) AS bounded_read_abort';
    const caller = new AbortController();
    const read = boundedQuery(sql, text, [], { signal: caller.signal, statementTimeoutMs: 60_000 });
    const settled = read.catch((error: unknown) => error);

    expect(await waitFor(() => running(text), 5000)).not.toBeNull();
    const startedAt = Date.now();
    caller.abort();

    expect(await settled).toBe(caller.signal.reason);
    expect(await waitFor(async () => ((await running(text)) === null ? [] : null), 3000)).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    await expectConnectionReusable();
  });

  it('stops a statement at its cap when the caller never aborts', async () => {
    const startedAt = Date.now();
    const error = await boundedQuery(sql, 'SELECT pg_sleep(30) AS bounded_read_cap', [], {
      statementTimeoutMs: 200,
    }).catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('57014');
    expect(Date.now() - startedAt).toBeLessThan(3000);
    const typed = asReadTimeout(error);
    expect(typed).toBeInstanceOf(ToolUserError);
    expect(typed).toMatchObject({ code: 'UPSTREAM_TIMEOUT', retryable: true, httpStatus: 500 });
    await expectConnectionReusable();
  });

  it('caps every statement of a multi-statement read, not just the first', async () => {
    const error = await boundedRead(sql, { statementTimeoutMs: 200 }, async (tx) => {
      await tx.unsafe('SELECT 1 AS bounded_read_first');
      return tx.unsafe('SELECT pg_sleep(30) AS bounded_read_second');
    }).catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('57014');
    await expectConnectionReusable();
  });

  it('runs reads read-only', async () => {
    const error = await boundedQuery(sql, 'CREATE TEMP TABLE bounded_read_write (id int)', [], {
      statementTimeoutMs: 1000,
    }).catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('25006');
    await expectConnectionReusable();
  });

  it('never sends a statement whose caller already left', async () => {
    const text = 'SELECT 1 AS bounded_read_pre_aborted';
    const caller = new AbortController();
    caller.abort();

    await expect(
      boundedQuery(sql, text, [], { signal: caller.signal, statementTimeoutMs: 1000 })
    ).rejects.toBe(caller.signal.reason);
    await expectConnectionReusable();
    expect(sent).not.toContain(text);
  });

  it('releases a caller waiting for a pool connection and drops its statement', async () => {
    const text = 'SELECT 1 AS bounded_read_queued';
    const holder = await pool.reserve();
    const caller = new AbortController();
    const read = boundedQuery(sql, text, [], { signal: caller.signal, statementTimeoutMs: 1000 });
    const settled = read.catch((error: unknown) => error);

    caller.abort();
    // The caller is released while the only connection is still held.
    expect(await settled).toBe(caller.signal.reason);

    holder.release();
    await expectConnectionReusable();
    expect(sent).not.toContain(text);
  });

  it('passes an unrelated failure through unchanged', async () => {
    const caller = new AbortController();
    const error = await boundedRead(sql, { signal: caller.signal, statementTimeoutMs: 1000 }, (tx) =>
      cancellable(tx.unsafe('SELECT bounded_read_missing_column FROM pg_class LIMIT 1'), caller.signal)
    ).catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('42703');
    expect(asReadTimeout(error)).toBe(error);
    await expectConnectionReusable();
  });

  it('refuses a cap Postgres would read as no cap', () => {
    for (const statementTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => boundedRead(sql, { statementTimeoutMs }, async () => null)).toThrow(
        /positive integer/
      );
    }
  });
});
