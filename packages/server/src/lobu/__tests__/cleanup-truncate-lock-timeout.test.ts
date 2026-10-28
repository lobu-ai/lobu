/**
 * Regression for #2818: a conflicting lock without a deadlock cycle must not
 * leave cleanup's `TRUNCATE … CASCADE` waiting until the test or job timeout.
 * This needs a real database because a scripted fake cannot reproduce lock
 * waits; the probe truncates only its own scratch table.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { truncateAllTables } from '../../__tests__/setup/test-db';
import { ensureDbForGatewayTests } from '../../gateway/__tests__/helpers/db-setup';

const PROBE_TABLE = 'truncate_lock_probe_2818';
/** Release before the 25s test budget to protect later suites if this test regresses. */
const LOCK_WATCHDOG_MS = 20_000;

let owner: postgres.Sql;
let blocker: postgres.Sql;

beforeAll(async () => {
  await ensureDbForGatewayTests();
  const url = process.env.DATABASE_URL as string;
  owner = postgres(url, { max: 2, onnotice: () => {} });
  blocker = postgres(url, { max: 1, onnotice: () => {} });
  await owner.unsafe(`CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id int)`);
});

afterAll(async () => {
  await blocker?.end({ timeout: 5 });
  await owner?.unsafe(`DROP TABLE IF EXISTS ${PROBE_TABLE}`).catch(() => {});
  await owner?.end({ timeout: 5 });
});

/**
 * Hold `ACCESS EXCLUSIVE` on the probe table from a second session and keep the
 * transaction open until `release()` is called. This is the non-cyclic shape:
 * TRUNCATE simply queues behind it, so Postgres never raises a deadlock.
 */
async function holdConflictingLock(): Promise<{ release: () => Promise<void> }> {
  let signalRelease!: () => void;
  const held = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });
  let released = false;
  const releaseLock = () => {
    if (released) return;
    released = true;
    signalRelease();
  };
  // Release before the per-test timeout even if the lock timeout regresses,
  // so this probe cannot starve later cleanup hooks in the shared process.
  const watchdog = setTimeout(releaseLock, LOCK_WATCHDOG_MS);
  watchdog.unref?.();
  let lockAcquired!: () => void;
  let lockFailed!: (err: unknown) => void;
  const locked = new Promise<void>((resolve, reject) => {
    lockAcquired = resolve;
    lockFailed = reject;
  });
  const transaction = blocker.begin(async (tx) => {
    await tx.unsafe(`LOCK TABLE ${PROBE_TABLE} IN ACCESS EXCLUSIVE MODE`);
    lockAcquired();
    await held;
  });
  void transaction.catch(lockFailed);
  await locked;
  return {
    release: async () => {
      clearTimeout(watchdog);
      releaseLock();
      await transaction;
    },
  };
}

describe('truncateAllTables — blocked-lock timeout (#2818)', () => {
  for (const canDisableTriggers of [true, false]) {
    test(
      `fails fast instead of blocking forever (canDisableTriggers=${canDisableTriggers})`,
      async () => {
        const { release } = await holdConflictingLock();
        const startedAt = performance.now();
        let caught: (Error & { code?: string }) | null = null;
        try {
          await truncateAllTables(owner, `"${PROBE_TABLE}"`, canDisableTriggers);
        } catch (err) {
          caught = err as Error & { code?: string };
        } finally {
          await release();
        }
        const elapsed = performance.now() - startedAt;

        expect(caught).not.toBeNull();
        expect(caught?.code).toBe('55P03');
        // The diagnostic is the entire point of the change: a failure that does
        // not name the holder leaves the next person exactly where CI did.
        expect(caught?.message).toContain('conflicting lock');
        expect(caught?.message).toMatch(/pid=\d+/);
        expect(caught?.message).toContain(PROBE_TABLE);

        // The timeout must fire before the watchdog releases the blocker;
        // without it, this call succeeds only after the watchdog fires.
        expect(elapsed).toBeLessThan(20_000);
      },
      25_000
    );
  }

  test('still succeeds when nothing holds a conflicting lock', async () => {
    await owner.unsafe(`INSERT INTO ${PROBE_TABLE} (id) VALUES (1)`);
    await truncateAllTables(owner, `"${PROBE_TABLE}"`, true);
    const rows = await owner.unsafe(`SELECT count(*)::int AS n FROM ${PROBE_TABLE}`);
    expect(rows[0]?.n).toBe(0);
  });
});

/**
 * Deadlock (40P01) retry accounting. Background DML from one test can overlap
 * the next test's cleanup TRUNCATE in the shared-process bun lanes, and the
 * opposite lock orders make Postgres pick the TRUNCATE as the victim. A real
 * deadlock is not reproducible on demand, so a scripted transaction drives the
 * retry loop; the lock-timeout cases above cover real lock waits.
 */
describe('truncateAllTables — deadlock retry accounting', () => {
  function scriptedDb(script: string[]) {
    let i = 0;
    const db = {
      attempts: 0,
      async unsafe(_sql: string) {},
      async begin(cb: (tx: { unsafe: (s: string) => Promise<void> }) => Promise<void>) {
        db.attempts++;
        await cb({ unsafe: async () => {} });
        const code = script[Math.min(i++, script.length - 1)];
        if (code !== 'ok') throw Object.assign(new Error(`pg error ${code}`), { code });
      },
    };
    return db;
  }

  test.each([
    { script: ['40P01', '40P01', 'ok'], rejects: null, attempts: 3, label: 'recovers after deadlocks' },
    { script: ['42P01'], rejects: null, attempts: 1, label: 'tolerates a vanished table' },
    { script: ['42501', 'ok'], rejects: '42501', attempts: 1, label: 'rethrows an unrelated error without retry' },
  ])('$label', async ({ script, rejects, attempts }) => {
    const db = scriptedDb(script);
    const run = truncateAllTables(db as never, '"a"', true);
    if (rejects) await expect(run).rejects.toMatchObject({ code: rejects });
    else await expect(run).resolves.toBeUndefined();
    expect(db.attempts).toBe(attempts);
  });

  test('rethrows the deadlock once retries are exhausted', async () => {
    const db = scriptedDb(['40P01']);
    await expect(truncateAllTables(db as never, '"a"', true)).rejects.toMatchObject({ code: '40P01' });
    expect(db.attempts).toBeGreaterThan(1);
  });
});
