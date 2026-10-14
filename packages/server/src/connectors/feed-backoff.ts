/**
 * Failure backoff + hard auto-pause policy for connector feeds.
 *
 * A feed whose connector keeps failing (revoked auth, source outage, connector
 * bug) used to re-enqueue every plain cron cadence regardless of
 * `consecutive_failures`. On a 5-minute feed that is a failing run every 5
 * minutes, forever — hammering the connector and its upstream API rate limit.
 *
 * The policy lives here so sync failure charging (feed-sync-failure.ts, for
 * the worker-reported outcome, the gateway failing a claimed run whose
 * connector bundle cannot be produced, and the reaper timing out a sync after
 * it crossed the worker-claim boundary), source wake scheduling
 * (runs/feed-notifications.ts), and the `feed.auto_paused` signal
 * (automations/platform-events.ts) read the same numbers. It applies ONLY to a
 * run that was claimed for the feed. A never-claimed run is a dispatch failure
 * — the connector never ran — so check-stalled-executions.ts deliberately does
 * not consume this source-health budget. Failed syncs without a cron use
 * {@link feedRetryAtSql} to re-arm the due time consumed by enqueue, until
 * the feed is paused.
 * Source listener setup failures and rejected source reference deliveries
 * reuse only the base delay and cap. They keep retrying without hard-pausing,
 * so a recovered browser/source can attach again.
 *
 *  1. Exponential backoff on `next_run_at` after a failure, so a failing feed
 *     retries progressively less often instead of every cadence.
 *  2. A hard consecutive-failure threshold that pauses the feed outright and
 *     emits a `feed.auto_paused` Automation signal so orgs can react with a
 *     normal Automation (see automations/platform-events.ts).
 *
 * All timings are env-overridable for tests/operators via lazy getters (same
 * convention as config/intervals.ts).
 */

/**
 * Positive integer from env (rounded); falls back when unset/invalid. A value
 * that rounds to 0 is invalid too because zero either disables the delay or
 * hard-pauses every healthy feed.
 */
function parseEnvInt(name: string, fallback: number): number {
  const raw = Math.round(Number(process.env[name]));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const feedBackoff = {
  /** Base backoff delay applied after the first failure (doubles each
   *  subsequent consecutive failure). 60s keeps a single transient blip cheap
   *  while still spacing out a genuinely broken feed. */
  get baseMs(): number {
    return parseEnvInt('FEED_BACKOFF_BASE_MS', 60_000);
  },

  /** Cap on the exponential backoff. 6h means a chronically-failing feed still
   *  retries a few times a day (in case the upstream recovers) but never sits
   *  on the plain cadence. */
  get maxMs(): number {
    return parseEnvInt('FEED_BACKOFF_MAX_MS', 6 * 60 * 60 * 1000);
  },

  /** Consecutive-failure count at which a feed is hard-paused
   *  (`status='paused'`, `next_run_at=NULL`) and `feed.auto_paused` is emitted.
   *  20 failures is deliberately conservative: at the capped 6h backoff that is
   *  several days of a feed being down before we stop scheduling it entirely,
   *  so a feed is never paused for a transient outage. Operators can lower it
   *  via env if they want to give up sooner. */
  get pauseThreshold(): number {
    return parseEnvInt('FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES', 20);
  },
};

/**
 * Exponential backoff delay (ms) for a feed with `consecutiveFailures` failures
 * (the count INCLUDING the failure that just happened, i.e. >= 1). Returns 0
 * for a healthy feed (0 failures) so the caller keeps the plain cron cadence.
 *
 * delay = min(baseMs * 2^(failures-1), maxMs)
 */
export function feedBackoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  // Guard the shift so a huge failure count can't overflow to a tiny/negative
  // value — anything past the cap is clamped anyway.
  const exponent = Math.min(consecutiveFailures - 1, 30);
  const delay = feedBackoff.baseMs * 2 ** exponent;
  return Math.min(delay, feedBackoff.maxMs);
}

/**
 * Whether a feed with `consecutiveFailures` failures has crossed the hard
 * auto-pause threshold and should be paused (`status='paused'`,
 * `next_run_at=NULL`).
 */
export function shouldHardPauseFeed(consecutiveFailures: number): boolean {
  return consecutiveFailures >= feedBackoff.pauseThreshold;
}

interface SqlTag<TFragment> {
  (strings: TemplateStringsArray, ...values: any[]): TFragment;
}

/**
 * `current_timestamp` plus the backoff for a feed that has already failed
 * `failures` times — the SQL twin of `feedBackoffDelayMs(failures + 1)`.
 *
 * The only SQL copy of the feed backoff; every lane that arms a failure retry
 * goes through it. It is the whole retry clock for a feed with no cron. The
 * failure lane passes the count
 * BEFORE its increment, so the delay grows with the budget it charges and the
 * hard pause still bounds it. Lanes that deliberately do not charge the budget
 * (an unavailable execution dependency, a failed admission) pass the current
 * count: they retry at a fixed, capped delay, as a scheduled feed retries at
 * its fixed cadence.
 */
export function feedRetryAtSql<TFragment>(sql: SqlTag<TFragment>, failures: TFragment): TFragment {
  return sql`current_timestamp + (LEAST(
    ${feedBackoff.baseMs}::bigint * (2 ^ LEAST(${failures}, 30))::bigint,
    ${feedBackoff.maxMs}::bigint
  ) || ' milliseconds')::interval`;
}
