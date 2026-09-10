/**
 * Centralized, env-overridable timing constants for the server's scheduling /
 * reaping loops.
 *
 * Every value is exposed as a lazy getter so overrides via `process.env` take
 * effect no matter when the module was imported (tests set env in
 * `beforeAll`, operators set it before boot — both work). Defaults are the
 * exact values previously hardcoded at the call sites.
 *
 * Other areas of the server (SSE keep-alive, due-feed cooldowns, …) can add
 * their constants here as they migrate — keep one getter per constant, name
 * the env var after the subsystem, and document the rationale for the
 * default.
 */

/** Positive number from env (rounded to an integer, matching the `::int`
 *  casts the SQL call sites apply); falls back when unset/invalid. */
function parseEnvInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

/**
 * Like `parseEnvInt`, but ZERO is a legal value.
 *
 * That difference is why this cannot reuse `parseEnvInt`, and why it must check
 * for an empty string explicitly: `Number('')` is `0`, which `>= 0` accepts. A
 * bare `AUTOMATION_ARRIVAL_SETTLE_MS=` in a .env — a shape people write all the
 * time meaning "unset" — would otherwise collapse the setting to zero instead of
 * falling back, silently and with no error. `parseEnvInt` is immune only because
 * `> 0` happens to reject the same value.
 */
function parseEnvIntAllowingZero(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : fallback;
}

/** Strict `<n> <unit>` Postgres interval literals only — these values are
 *  inlined into SQL by the stale-run sweeper, so anything fancier (or
 *  malformed) falls back to the default instead of reaching the database. */
export const PG_INTERVAL_PATTERN = /^\d+ (second|minute|hour|day)s?$/;

/** Postgres interval literal (e.g. '3 minutes') from env; falls back when
 *  unset or not a simple `<n> <unit>` literal. */
function parseEnvInterval(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && PG_INTERVAL_PATTERN.test(raw) ? raw : fallback;
}

/** How long an unclaimed device action remains eligible for worker pickup. */
export const DEVICE_ACTION_QUEUE_BUDGET_MS = 60_000;

export const intervals = {
  /** Stale threshold (seconds) for the connector-lane run reaper.
   *  120s leaves room for the 30s worker heartbeat to miss ~3 ticks before
   *  the reaper writes the row off — a real worker stutter (GC pause, network
   *  blip) gets a grace window, but a crashed worker frees the feed within
   *  a couple of minutes instead of five.
   *
   *  Doubles as the `agent_turn` CLAIM horizon (`sweepStaleAgentTurnRuns`): a
   *  claim-eligible turn still pending this long never started, so lowering
   *  this also shortens the pre-admission window `armTurnTimeout` grants a
   *  queued turn. */
  get runsReaperStaleAfterSeconds(): number {
    return parseEnvInt('RUNS_REAPER_STALE_AFTER_SECONDS', 120);
  },

  /** How often the gateway-boot setInterval calls `reapStaleRuns`. */
  get runsReaperTickMs(): number {
    return parseEnvInt('RUNS_REAPER_TICK_MS', 30_000);
  },

  /** Coarse TTL for automation runs that never heartbeat — generous (2h) so a
   *  long but live non-heartbeating turn isn't killed prematurely. */
  get automationRunStaleInterval(): string {
    return parseEnvInterval('AUTOMATION_RUN_STALE_INTERVAL', '2 hours');
  },

  /** ~4 missed 30s device heartbeats. A heartbeating executor that goes
   *  silent this long is crashed/abandoned; a live one (beats every ~30s)
   *  never lapses. */
  get automationRunHeartbeatStaleInterval(): string {
    return parseEnvInterval('AUTOMATION_RUN_HEARTBEAT_STALE_INTERVAL', '3 minutes');
  },

  /** Stale-claim threshold for automation orphan recovery: a run stuck in
   *  `claimed` this long without progressing to `running` is taken to be from
   *  a crashed dispatcher (real session-create + fetch + POST takes seconds,
   *  not minutes). Any tighter and we'd race a legitimate slow dispatch on
   *  the same row. */
  get automationOrphanedClaimThreshold(): string {
    return parseEnvInterval('AUTOMATION_ORPHANED_CLAIM_THRESHOLD', '5 minutes');
  },

  /** Poll cadence for the embedded in-process connector-worker daemon. */
  get embeddedWorkerPollIntervalMs(): number {
    return parseEnvInt('EMBEDDED_WORKER_POLL_INTERVAL_MS', 5_000);
  },

  /** Grace window (ms) an embedded worker subprocess gets after SIGTERM
   *  before the orchestrator escalates to SIGKILL. */
  get workerKillTimeoutMs(): number {
    return parseEnvInt('WORKER_KILL_TIMEOUT_MS', 5_000);
  },

  /** Turn-liveness deadline while the turn EXECUTES. Comfortably exceeds the
   *  worker's 20s status_update interval so a live worker (which extends the
   *  deadline on every status_update — plus on the 30s SSE-ping ACK and
   *  delivery receipts) is never falsely failed; a silent/dead worker lapses
   *  within this window of its last worker-driven signal. `armTurnTimeout`
   *  adds `runsReaperStaleAfterSeconds` on top, because a turn still waiting
   *  for a worker slot has nothing that could signal liveness yet. */
  get turnDefaultDeadlineMs(): number {
    return parseEnvInt('TURN_DEFAULT_DEADLINE_MS', 60_000);
  },

  /** How often each replica sweeps for lapsed turn-liveness markers. */
  get turnLivenessSweepIntervalMs(): number {
    return parseEnvInt('TURN_LIVENESS_SWEEP_INTERVAL_MS', 15_000);
  },

  /** Runs-queue claim visibility timeout: rows in `claimed` for longer than
   *  this without a heartbeat are reset to pending so a fresh claim can pick
   *  them up. Must stay well above the claim heartbeat interval. */
  get runsClaimVisibilityTimeoutMs(): number {
    return parseEnvInt('RUNS_CLAIM_VISIBILITY_TIMEOUT_MS', 5 * 60 * 1000);
  },

  /** How often an in-flight runs-queue handler refreshes `claimed_at` to
   *  prove it's still alive. Must be << runsClaimVisibilityTimeoutMs so the
   *  sweeper doesn't race a healthy handler. */
  get runsClaimHeartbeatIntervalMs(): number {
    return parseEnvInt('RUNS_CLAIM_HEARTBEAT_INTERVAL_MS', 60 * 1000);
  },

  /** Runs-queue worker poll cadence between empty claims (a NOTIFY for the
   *  channel cuts the sleep short). */
  get runsPollIntervalMs(): number {
    return parseEnvInt('RUNS_POLL_INTERVAL_MS', 200);
  },

  /** Long-horizon TTL (days) after which a run still sitting at
   *  `approval_status='pending'` is expired.
   *
   *  Deliberately measured in DAYS, not the 120s claim horizon: the
   *  short-horizon reaper exempts approval-pending rows on purpose (#2044,
   *  scheduled/stale-run-sweeper.ts) because a human needs real time to decide.
   *  7 days spans a full work week plus a weekend, so a reviewer on PTO still
   *  gets a chance; past that the proposal's inputs are stale enough that
   *  executing it would surprise the operator more than dropping it. */
  get pendingApprovalTtlDays(): number {
    return parseEnvInt('PENDING_APPROVAL_TTL_DAYS', 7);
  },

  /** TTL for per-agent SSE backlog entries (pruned lazily on read/write). */
  get sseBacklogTtlMs(): number {
    return parseEnvInt('SSE_BACKLOG_TTL_MS', 2 * 60 * 1000);
  },

  /** Max retained SSE backlog entries per agent (most-recent wins). */
  get sseBacklogLimit(): number {
    return parseEnvInt('SSE_BACKLOG_LIMIT', 100);
  },

  /**
   * How far behind the database clock an Automation's arrival window may reach.
   *
   * Automation windows select rows by `events.created_at`, and `created_at`
   * (`DEFAULT now()`) is stamped at the writer's transaction START while the
   * row becomes VISIBLE only at commit. Between the two, a concurrent reader
   * can compute a horizon that already sits past a row it cannot see — and
   * that row would fall inside a window which completes without it. The
   * horizon is therefore `now() - this`, and the exposure is exactly one
   * writer's transaction length.
   *
   * Bound the WRITER, not the reader: `events-insert-sites.test.ts` enumerates
   * the two `INSERT INTO events` sites and asserts their transactions stay far
   * inside this budget, and production's `idle_in_transaction_session_timeout`
   * is one minute. The knob exists so an operator can widen the budget during
   * an incident without a deploy, and so integration tests can collapse it to
   * see a row they just inserted; widening costs only freshness, since a row
   * stored inside the settle window belongs to the next run, never to none.
   *
   * Zero is a legal value (tests), so this reads through `parseEnvIntAllowingZero`
   * rather than `parseEnvInt`, which rejects it.
   */
  get automationArrivalSettleMs(): number {
    return parseEnvIntAllowingZero('AUTOMATION_ARRIVAL_SETTLE_MS', 60_000);
  },

  /**
   * How far back a BRAND-NEW Automation's first arrival window reaches.
   *
   * The mark for an existing Automation is a fact — the end of the last range a
   * run actually completed. A new Automation has no such fact, and seeding the
   * mark at the creation instant makes it permanently blind to everything
   * already ingested: connect a source, build an Automation over it, and the
   * first run reads nothing, with no way to ever reach back. The old calendar
   * axis did not have this problem because a first window was a calendar
   * period, which already contained earlier content.
   *
   * So the first window starts one bounded lookback behind creation. Seven days
   * is long enough to cover a source connected in the same sitting and short
   * enough that a new Automation cannot stall on a year of history.
   *
   * This applies ONLY at creation. It is not a repair for a NULL mark
   * (`computePendingWindow` seeds that at the clock — an unseeded mark means
   * unknown, and re-reading history on a repair would double-process), and it
   * is not the cutover seed (the migration deliberately starts every existing
   * Automation at the clock, since their history was already processed).
   */
  get automationFirstWindowLookbackMs(): number {
    return parseEnvIntAllowingZero('AUTOMATION_FIRST_WINDOW_LOOKBACK_MS', 7 * 24 * 60 * 60 * 1000);
  },
};
