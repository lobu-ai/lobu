/**
 * Rate limiter integration tests (Postgres-backed fixed window).
 *
 * The limiter's contract: synchronous decisions, exact per-pod enforcement,
 * cluster-wide enforcement via the shared `rate_limit_counters` table, and
 * FAIL OPEN (degrade to per-pod limiting) when Postgres is unavailable.
 *
 * Two `RateLimiter` instances in one process stand in for two replicas: each
 * has its own in-memory window cache and only communicates through Postgres,
 * which is exactly the production topology.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { getClientIP, getRateLimiter, RateLimiter, resetRateLimiterForTests } from '../rate-limiter';

/** Unique key per test so fixed windows never collide across tests. */
let keySeq = 0;
function uniqueKey(label: string): string {
  return `test:${label}:${Date.now()}:${keySeq++}`;
}

/** Wide window; with the frozen clock below, a window can never roll mid-test. */
const WIDE = { limit: 3, windowSeconds: 3600 };

describe('RateLimiter (Postgres-backed fixed window)', () => {
  let limiter: RateLimiter;

  beforeEach(async () => {
    await cleanupTestDatabase();
    resetRateLimiterForTests();
    limiter = getRateLimiter();
    // The limiter derives its fixed window from Date.now(); on a slow runner a
    // real-time test can straddle an epoch-aligned window boundary and the
    // budget silently refills mid-test (#2073). Fake Date only (timers and DB
    // I/O stay real) and drive window rollover explicitly via setSystemTime.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimiterForTests();
  });

  it('allows requests up to the limit and blocks beyond it (single pod)', async () => {
    const key = uniqueKey('single-pod');

    for (let i = 1; i <= WIDE.limit; i++) {
      const result = limiter.checkLimit(key, WIDE);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(i);
      expect(result.limit).toBe(WIDE.limit);
    }

    const blocked = limiter.checkLimit(key, WIDE);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(WIDE.limit + 1);
    expect(blocked.errorMessage).toBeTruthy();

    await limiter.flushPendingWrites();
  });

  it('persists the cluster-wide count in rate_limit_counters', async () => {
    const key = uniqueKey('persist');

    limiter.checkLimit(key, WIDE);
    limiter.checkLimit(key, WIDE);
    await limiter.flushPendingWrites();

    const db = getTestDb();
    const rows = await db<{ count: number }[]>`
      SELECT count FROM rate_limit_counters WHERE key = ${key}
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('enforces the limit across two limiter instances (two replicas)', async () => {
    // BEFORE this change: each pod had its own in-memory window, so a 2-pod
    // cluster allowed 2 × limit. AFTER: counts ride Postgres, so pod B blocks
    // requests it would have allowed on local state alone.
    const key = uniqueKey('cluster');
    const podA = new RateLimiter();
    const podB = new RateLimiter();

    try {
      // Pod A consumes 2 of the 3-request budget.
      expect(podA.checkLimit(key, WIDE).allowed).toBe(true);
      expect(podA.checkLimit(key, WIDE).allowed).toBe(true);
      await podA.flushPendingWrites();

      // Pod B's first request is #3 cluster-wide — allowed, and it pulls the
      // shared count down from Postgres.
      expect(podB.checkLimit(key, WIDE).allowed).toBe(true);
      await podB.flushPendingWrites();

      // Pod B request #4 cluster-wide: shared count is 3, local would be only
      // 2 — a per-pod limiter would still allow this. It must be blocked.
      const fourth = podB.checkLimit(key, WIDE);
      expect(fourth.allowed).toBe(false);
      expect(fourth.count).toBeGreaterThan(WIDE.limit);
      await podB.flushPendingWrites();
    } finally {
      podA.destroy();
      podB.destroy();
    }
  });

  it('resets the count when the fixed window rolls over', async () => {
    const key = uniqueKey('window-roll');
    const config = { limit: 1, windowSeconds: 1 };

    // Pin the clock to the start of a 1s window so both calls land inside it.
    const windowStartMs = Math.ceil(Date.now() / 1000) * 1000;
    vi.setSystemTime(windowStartMs);

    expect(limiter.checkLimit(key, config).allowed).toBe(true);
    expect(limiter.checkLimit(key, config).allowed).toBe(false);

    // Next fixed window → fresh budget.
    vi.setSystemTime(windowStartMs + 1000);
    expect(limiter.checkLimit(key, config).allowed).toBe(true);
    await limiter.flushPendingWrites();
  });

  it('fails open to per-pod enforcement when the counters table is missing', async () => {
    const db = getTestDb();
    await db`ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_hidden`;
    try {
      const key = uniqueKey('fail-open');
      const config = { limit: 2, windowSeconds: 3600 };

      // No throw, requests under the limit still allowed (fail open) ...
      expect(limiter.checkLimit(key, config).allowed).toBe(true);
      expect(limiter.checkLimit(key, config).allowed).toBe(true);
      await limiter.flushPendingWrites();

      // ... while local (per-pod) enforcement still applies.
      expect(limiter.checkLimit(key, config).allowed).toBe(false);
      await limiter.flushPendingWrites();
    } finally {
      await db`ALTER TABLE rate_limit_counters_hidden RENAME TO rate_limit_counters`;
    }
  });

  it('cleanup sweeps expired windows from Postgres and stale local entries', async () => {
    const db = getTestDb();
    const staleKey = uniqueKey('stale');
    const freshKey = uniqueKey('fresh');
    const otherPodDailyKey = uniqueKey('other-pod-daily');

    await db`
      INSERT INTO rate_limit_counters (key, window_start, count)
      VALUES (${staleKey}, NOW() - INTERVAL '3 days', 5),
             (${otherPodDailyKey}, NOW() - INTERVAL '12 hours', 1)
    `;
    limiter.checkLimit(freshKey, WIDE);
    await limiter.flushPendingWrites();

    limiter.cleanup();
    await limiter.flushPendingWrites();

    const keys = await db<{ key: string }[]>`SELECT key FROM rate_limit_counters`;
    const names = keys.map((r) => r.key);
    expect(names).not.toContain(staleKey);
    expect(names).toContain(freshKey);
    expect(names).toContain(otherPodDailyKey);
  });
});

describe('getClientIP', () => {
  const originalTrustedProxy = process.env.TRUSTED_PROXY;

  afterEach(() => {
    if (originalTrustedProxy === undefined) {
      delete process.env.TRUSTED_PROXY;
    } else {
      process.env.TRUSTED_PROXY = originalTrustedProxy;
    }
  });

  it('without TRUSTED_PROXY keys on the socket peer, ignoring forwarded headers', () => {
    delete process.env.TRUSTED_PROXY;
    const req = new Request('http://x.test', {
      headers: { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2, 3.3.3.3' },
    });
    expect(getClientIP(req, '9.9.9.9')).toBe('9.9.9.9');
  });

  it('without TRUSTED_PROXY, a spoofed X-Forwarded-For cannot change the key', () => {
    delete process.env.TRUSTED_PROXY;
    // Same peer, attacker rotates the forwarded header between requests — the
    // rate-limit key must stay constant (this is the bypass the fix closes).
    const a = getClientIP(
      new Request('http://x.test', { headers: { 'X-Forwarded-For': 'a.a.a.a' } }),
      '9.9.9.9'
    );
    const b = getClientIP(
      new Request('http://x.test', { headers: { 'X-Forwarded-For': 'b.b.b.b' } }),
      '9.9.9.9'
    );
    expect(a).toBe('9.9.9.9');
    expect(b).toBe('9.9.9.9');
  });

  it('without TRUSTED_PROXY and no peer, returns "unknown"', () => {
    delete process.env.TRUSTED_PROXY;
    const req = new Request('http://x.test', {
      headers: { 'X-Forwarded-For': '1.1.1.1' },
    });
    expect(getClientIP(req)).toBe('unknown');
  });

  it('uses the rightmost X-Forwarded-For entry with TRUSTED_PROXY', () => {
    process.env.TRUSTED_PROXY = 'true';
    const req = new Request('http://x.test', {
      headers: { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2, 3.3.3.3' },
    });
    expect(getClientIP(req)).toBe('3.3.3.3');
  });

  it('with TRUSTED_PROXY falls back to CF-Connecting-IP, X-Real-IP, then peer/unknown', () => {
    process.env.TRUSTED_PROXY = 'true';
    expect(
      getClientIP(new Request('http://x.test', { headers: { 'CF-Connecting-IP': '4.4.4.4' } }))
    ).toBe('4.4.4.4');
    expect(
      getClientIP(new Request('http://x.test', { headers: { 'X-Real-IP': '5.5.5.5' } }))
    ).toBe('5.5.5.5');
    expect(getClientIP(new Request('http://x.test'), '8.8.8.8')).toBe('8.8.8.8');
    expect(getClientIP(new Request('http://x.test'))).toBe('unknown');
  });
});
