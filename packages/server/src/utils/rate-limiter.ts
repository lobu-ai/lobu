/**
 * Rate Limiting Module
 *
 * Cluster-wide fixed-window counters backed by Postgres
 * (`rate_limit_counters`, UNLOGGED — see
 * db/migrations/20260610130000_rate_limit_counters.sql), fronted by a
 * synchronous per-pod cache.
 *
 * Why this shape: the previous implementation was a purely in-memory sliding
 * window, which is per-pod state — with N replicas behind ClientIP affinity
 * every IP limit was effectively multiplied by N (affinity churn / restarts /
 * multiple ingress paths spread one client across pods). Counters now live in
 * Postgres so the limit holds across the whole cluster.
 *
 * Semantics: fixed window (epoch-aligned) instead of the old interpolated
 * sliding window. Each `checkLimit` call:
 *   1. increments a per-pod local counter for the current window and decides
 *      synchronously from `max(localCount, lastSharedCount)` — so the public
 *      API stays synchronous and existing callers are unchanged;
 *   2. fires one atomic UPSERT (`INSERT ... ON CONFLICT ... DO UPDATE SET
 *      count = count + 1 RETURNING count`) in the background and folds the
 *      returned cluster-wide count back into the cache.
 * Cross-pod counts therefore apply with ~one DB round-trip of lag; within a
 * single pod enforcement is exact and immediate (matching the old semantics).
 *
 * `consume` is the awaited variant for callers that are already async and
 * cannot tolerate that lag (e.g. a once-per-day notice, where a fresh replica's
 * empty cache would otherwise admit a duplicate): it awaits the same atomic
 * UPSERT and decides from the cluster-wide count it returns.
 *
 * Failure policy: FAIL OPEN on any Postgres error (same philosophy as
 * guardrails). A DB outage degrades to the old per-pod in-memory enforcement
 * — it never blocks a request and never takes down the auth routes. A missing
 * table (migration not applied yet) logs a single warning and behaves the
 * same way.
 */

import { type DbClient, getDb } from '../db/client';
import logger from './logger';

interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Optional custom error message */
  errorMessage?: string;
}

interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current count of requests in the window (cluster-wide, best known) */
  count: number;
  /** Maximum requests allowed */
  limit: number;
  /** Seconds until the rate limit resets */
  resetInSeconds: number;
  /** Error message if rate limit exceeded */
  errorMessage?: string;
}

interface ConsumedRateLimitResult extends RateLimitResult {
  /** Fixed-window start (epoch seconds) this request was counted in; {@link RateLimiter.refund} needs it. */
  windowStart: number;
  /** Local fallback admissions must never refund another replica's shared count. */
  countedInDb: boolean;
}

interface WindowState {
  /** Fixed-window start (epoch seconds, aligned to windowSeconds). */
  windowStart: number;
  /** Increments observed by this pod in the window (exact, immediate). */
  localCount: number;
  /** Last cluster-wide count returned by Postgres for this window. */
  sharedCount: number;
}

/** Throttle for DB-failure warn logs (avoid one warn per request during an outage). */
const DB_WARN_INTERVAL_MS = 30_000;
/** Pause DB writes briefly after a failure so a down DB isn't hammered. */
const DB_ERROR_BACKOFF_MS = 5_000;
/** Longer pause when the table is missing (migration not applied). */
const DB_TABLE_MISSING_BACKOFF_MS = 60_000;
/** Postgres error code: undefined_table. */
const PG_UNDEFINED_TABLE = '42P01';

/**
 * High-water mark for in-flight counter UPSERTs. A slow-but-not-erroring
 * Postgres never trips the error backoff, so without a cap the pending set
 * would grow with request-rate × latency. Past the cap new increments skip
 * the DB write — per-pod local enforcement (the fail-open mode) still holds.
 */
const MAX_PENDING_WRITES = 500;

/**
 * The one atomic cluster-wide increment: bump this key's counter for the
 * window and return the committed count (null if the row came back empty).
 */
async function upsertSharedCount(
  db: DbClient,
  key: string,
  windowStartSec: number
): Promise<number | null> {
  const rows = await db<{ count: number }>`
    INSERT INTO rate_limit_counters (key, window_start, count)
    VALUES (${key}, ${new Date(windowStartSec * 1000)}, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limit_counters.count + 1
    RETURNING count
  `;
  const count = rows[0]?.count;
  return typeof count === 'number' ? count : null;
}

/** Postgres-backed fixed-window limiter with synchronous and awaited admission. */
export class RateLimiter {
  private windows = new Map<string, WindowState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight background UPSERTs — awaitable for deterministic tests. */
  private pendingWrites = new Set<Promise<void>>();
  /** Largest window seen so far; bounds the DB cleanup horizon. */
  // Another pod may use the daily chat-notice window without this process
  // ever seeing it. Cleanup must retain that shared window too.
  private maxWindowSeconds = 86400;
  private dbBackoffUntilMs = 0;
  private lastDbWarnAtMs = 0;
  private warnedTableMissing = false;

  constructor() {
    // Clean up stale entries every 5 minutes (local map + opportunistic
    // sweep of expired Postgres windows — piggybacked here rather than a
    // scheduled job so the limiter stays self-contained).
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    // Allow Node to exit even if timer is active
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check if a request is within rate limit.
   *
   * Synchronous (no awaits) — the decision runs to completion in a single
   * microtask, so concurrent callers on this pod cannot interleave between
   * the read and write of the window state. The cluster-wide count is folded
   * in asynchronously (see module docs); `count` reflects the best currently
   * known value.
   */
  checkLimit(key: string, config: RateLimitConfig): RateLimitResult {
    const { state, now } = this.countLocally(key, config);

    // Cluster-wide UPSERT, fire-and-forget. The shared count it returns is
    // applied to the *next* decision; this one uses the cached value.
    this.persistIncrement(key, state.windowStart);

    // `sharedCount` is the cluster-wide count as of our last committed
    // increment (it already includes this pod's prior requests, and was read
    // before this request's UPSERT fired) — so `sharedCount + 1` counts all
    // known prior requests plus this one, with no double-counting. `localCount`
    // covers the burst case where our own increments are still in flight.
    // Either term can only *under*-count by the in-flight round-trip.
    return this.result(Math.max(state.localCount, state.sharedCount + 1), config, now, state.windowStart);
  }

  /**
   * Awaited, cluster-exact variant of {@link checkLimit}: awaits the same
   * atomic UPSERT and decides from the cluster-wide count it returns, so a
   * replica with an empty cache cannot admit a request another replica already
   * spent. FAILS OPEN like the rest of the module: when Postgres is
   * unavailable (error, backoff, missing table) the decision falls back to
   * this request's cached count instead of rejecting solely for the DB error.
   */
  async consume(key: string, config: RateLimitConfig): Promise<ConsumedRateLimitResult> {
    const { state, now } = this.countLocally(key, config);
    // Other requests can increment this window while the DB write is pending.
    const fallbackCount = Math.max(state.localCount, state.sharedCount + 1);
    const shared = await this.incrementShared(key, state.windowStart);
    if (shared !== null && shared > state.sharedCount) state.sharedCount = shared;
    return {
      ...this.result(shared ?? fallbackCount, config, now, state.windowStart),
      windowStart: state.windowStart,
      countedInDb: shared !== null,
    };
  }

  /** Count this request in the pod-local window, rolling it over when due. */
  private countLocally(key: string, config: RateLimitConfig): { state: WindowState; now: number } {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % config.windowSeconds);

    if (config.windowSeconds > this.maxWindowSeconds) {
      this.maxWindowSeconds = config.windowSeconds;
    }

    let state = this.windows.get(key);
    if (!state || state.windowStart !== windowStart) {
      // First request for this key, or the fixed window rolled over.
      state = { windowStart, localCount: 0, sharedCount: 0 };
      this.windows.set(key, state);
    }

    state.localCount++;
    return { state, now };
  }

  private result(
    effectiveCount: number,
    config: RateLimitConfig,
    now: number,
    windowStart: number
  ): RateLimitResult {
    const allowed = effectiveCount <= config.limit;
    const resetInSeconds = Math.max(0, config.windowSeconds - (now - windowStart));
    return {
      allowed,
      count: effectiveCount,
      limit: config.limit,
      resetInSeconds,
      errorMessage: allowed
        ? undefined
        : config.errorMessage || `Rate limit exceeded. Try again in ${resetInSeconds} seconds.`,
    };
  }

  /**
   * Give back one admission {@link consume} granted, when the work it admitted
   * failed. Denied attempts can push the counter above the limit; discard that
   * excess so it cannot prevent the refunded work from retrying. Targets the
   * original window and only refunds Postgres when it counted the admission.
   * Best effort: a DB error can leave the shared count spent.
   */
  async refund(key: string, admitted: ConsumedRateLimitResult): Promise<void> {
    const state = this.windows.get(key);
    if (state && state.windowStart === admitted.windowStart) {
      state.localCount = Math.max(0, Math.min(state.localCount, admitted.limit) - 1);
      if (admitted.countedInDb) {
        state.sharedCount = Math.max(0, Math.min(state.sharedCount, admitted.limit) - 1);
      }
    }
    if (!admitted.countedInDb || Date.now() < this.dbBackoffUntilMs) return;
    try {
      await getDb()`
        UPDATE rate_limit_counters SET count = GREATEST(LEAST(count, ${admitted.limit}) - 1, 0)
        WHERE key = ${key} AND window_start = ${new Date(admitted.windowStart * 1000)}
      `;
    } catch (err) {
      this.noteDbFailure(err);
    }
  }

  /**
   * Awaited cluster-wide increment for {@link consume}. Returns the committed
   * count, or null when Postgres is unavailable (the caller fails open).
   */
  private async incrementShared(key: string, windowStartSec: number): Promise<number | null> {
    if (Date.now() < this.dbBackoffUntilMs) return null;
    try {
      return await upsertSharedCount(getDb(), key, windowStartSec);
    } catch (err) {
      this.noteDbFailure(err);
      return null;
    }
  }

  /**
   * Background increment of the cluster-wide counter. Never throws; any DB
   * failure logs (throttled) and leaves the local counter as the only
   * enforcement — i.e. fail open to the old per-pod semantics.
   */
  private persistIncrement(key: string, windowStartSec: number): void {
    if (Date.now() < this.dbBackoffUntilMs) return;
    if (this.pendingWrites.size >= MAX_PENDING_WRITES) {
      const now = Date.now();
      if (now - this.lastDbWarnAtMs >= DB_WARN_INTERVAL_MS) {
        this.lastDbWarnAtMs = now;
        logger.warn(
          { pendingWrites: this.pendingWrites.size },
          '[rate-limiter] counter write backlog at high-water mark (slow Postgres?) — ' +
            'skipping cluster-wide increments, per-pod limiting still enforced'
        );
      }
      return;
    }

    let db: DbClient;
    try {
      db = getDb(); // throws when DATABASE_URL is unset
    } catch (err) {
      this.noteDbFailure(err);
      return;
    }

    const write: Promise<void> = upsertSharedCount(db, key, windowStartSec)
      .then((sharedCount) => {
        if (sharedCount === null) return;
        const state = this.windows.get(key);
        // Only fold back into the same window; a rolled-over window starts fresh.
        if (state && state.windowStart === windowStartSec && sharedCount > state.sharedCount) {
          state.sharedCount = sharedCount;
        }
      })
      .catch((err) => {
        this.noteDbFailure(err);
      })
      .finally(() => {
        this.pendingWrites.delete(write);
      });
    this.pendingWrites.add(write);
  }

  /** Record a DB failure: throttled warn + short write backoff. Fail open. */
  private noteDbFailure(err: unknown): void {
    const tableMissing = (err as { code?: string } | null)?.code === PG_UNDEFINED_TABLE;
    this.dbBackoffUntilMs =
      Date.now() + (tableMissing ? DB_TABLE_MISSING_BACKOFF_MS : DB_ERROR_BACKOFF_MS);

    if (tableMissing) {
      if (!this.warnedTableMissing) {
        this.warnedTableMissing = true;
        logger.warn(
          { err },
          '[rate-limiter] rate_limit_counters table missing (migration not applied?) — ' +
            'failing open to per-pod in-memory limiting'
        );
      }
      return;
    }

    const now = Date.now();
    if (now - this.lastDbWarnAtMs >= DB_WARN_INTERVAL_MS) {
      this.lastDbWarnAtMs = now;
      logger.warn(
        { err },
        '[rate-limiter] Postgres counter update failed — failing open to per-pod in-memory limiting'
      );
    }
  }

  /**
   * Wait for all in-flight counter UPSERTs to settle. Test hook — production
   * code never needs to await the background writes.
   */
  async flushPendingWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
  }

  /**
   * Cleanup stale rate limit entries (default: older than 24h) from the local
   * cache, and opportunistically sweep expired windows from Postgres.
   * Returns the number of local entries deleted.
   */
  cleanup(maxAgeSeconds: number = 86400): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    let deleted = 0;

    for (const [key, state] of this.windows) {
      if (state.windowStart < cutoff) {
        this.windows.delete(key);
        deleted++;
      }
    }

    // Opportunistic DB sweep: a window is definitely expired once
    // 2 × the largest window we've ever been asked about has elapsed.
    // Fire-and-forget; failures follow the same fail-open path as writes.
    if (Date.now() >= this.dbBackoffUntilMs) {
      try {
        const db = getDb();
        const horizon = new Date(Date.now() - 2 * this.maxWindowSeconds * 1000);
        const sweep: Promise<void> = db`
          DELETE FROM rate_limit_counters WHERE window_start < ${horizon}
        `
          .then(() => undefined)
          .catch((err) => {
            this.noteDbFailure(err);
          })
          .finally(() => {
            this.pendingWrites.delete(sweep);
          });
        this.pendingWrites.add(sweep);
      } catch (err) {
        this.noteDbFailure(err);
      }
    }

    return deleted;
  }

  /** Stop the cleanup timer (for graceful shutdown). */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}

/**
 * Predefined rate limit configurations (only those actively used)
 */
export const RateLimitPresets = {
  /** API requests per IP: 60/minute */
  API_PER_IP_MINUTE: {
    limit: 60,
    windowSeconds: 60,
    errorMessage: 'API rate limit exceeded. Maximum 60 requests per minute.',
  } as RateLimitConfig,

  /** Discovery: 5/hour per IP (expensive operation) */
  DISCOVERY_PER_IP_HOUR: {
    limit: 5,
    windowSeconds: 3600,
    errorMessage: 'Discovery rate limit exceeded. Maximum 5 discoveries per hour.',
  } as RateLimitConfig,

  /** OAuth client registration: 10/hour per IP */
  OAUTH_REGISTER_PER_IP_HOUR: {
    limit: 10,
    windowSeconds: 3600,
    errorMessage:
      'OAuth client registration rate limit exceeded. Maximum 10 registrations per hour.',
  } as RateLimitConfig,

  /** Agent device-claim email: 10/hour per IP (sends a login email to a caller-supplied address) */
  DEVICE_EMAIL_PER_IP_HOUR: {
    limit: 10,
    windowSeconds: 3600,
    errorMessage:
      'Device email rate limit exceeded. Maximum 10 confirmation emails per hour.',
  } as RateLimitConfig,

  /** Invitation preview lookup: 5/minute per IP (unauthenticated) */
  INVITATION_PREVIEW_PER_IP_MINUTE: {
    limit: 5,
    windowSeconds: 60,
    errorMessage: 'Too many invitation lookups. Try again shortly.',
  } as RateLimitConfig,

  /** Self-serve join public org: 10/hour per IP */
  JOIN_PUBLIC_ORG_PER_IP_HOUR: {
    limit: 10,
    windowSeconds: 3600,
    errorMessage: 'Join rate limit exceeded. Maximum 10 join attempts per hour.',
  } as RateLimitConfig,

  /** Public template-agent install: 20/hour per user */
  INSTALL_AGENT_PER_USER_HOUR: {
    limit: 20,
    windowSeconds: 3600,
    errorMessage: 'Install rate limit exceeded. Maximum 20 installs per hour.',
  } as RateLimitConfig,
};

/** Module-level singleton rate limiter. */
let _rateLimiter: RateLimiter | null = null;

/** Get the shared rate limiter instance. */
export function getRateLimiter(): RateLimiter {
  if (!_rateLimiter) {
    _rateLimiter = new RateLimiter();
  }
  return _rateLimiter;
}

/** Destroy and reset the singleton. Test hook. */
export function resetRateLimiterForTests(): void {
  _rateLimiter?.destroy();
  _rateLimiter = null;
}

/**
 * Get client IP from request.
 *
 * When `TRUSTED_PROXY` is set, the rightmost `X-Forwarded-For` entry (the address
 * the trusted proxy actually observed, not client-controllable) is used, falling
 * back to `CF-Connecting-IP` / `X-Real-IP`. This is the abuse-resistant mode and
 * operators behind a tunnel/reverse-proxy should set it.
 *
 * Without `TRUSTED_PROXY` we key on the *socket peer address* (`peerAddress`,
 * stashed from the Node adapter's `socket.remoteAddress`). Forwarded headers are
 * fully client-controlled here, so keying on them lets an attacker rotate the
 * header per request to evade per-IP limits (e.g. email-bombing arbitrary
 * recipients via `/oauth/device/email`, or flooding OAuth dynamic client
 * registration). The peer address is per-connection and non-spoofable, so it
 * keys distinct callers correctly without collapsing everyone into `'unknown'`.
 * `'unknown'` is only returned when no peer is available (outside the Node
 * adapter, e.g. unit tests via `app.request()`).
 */
export function getClientIP(request: Request, peerAddress?: string | null): string {
  const trustForwarded = process.env.TRUSTED_PROXY === 'true' || process.env.TRUSTED_PROXY === '1';
  if (trustForwarded) {
    const xff = request.headers.get('X-Forwarded-For');
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      // Rightmost entry = the address the trusted proxy actually observed.
      if (parts.length > 0) return parts[parts.length - 1]!;
    }
    const cf = request.headers.get('CF-Connecting-IP');
    if (cf) return cf.trim();
    const xreal = request.headers.get('X-Real-IP');
    if (xreal) return xreal.trim();
  }
  if (peerAddress && peerAddress.trim()) return peerAddress.trim();
  return 'unknown';
}
