/**
 * Postgres `runs`-table-backed message queue.
 *
 * SKIP-LOCKED claim loop on `public.runs`. The connector worker (run_type IN
 * 'sync', 'action', 'embed_backfill', 'automation', 'auth') keeps its existing
 * HTTP-poll claim path; this queue strictly handles the lobu-queue lanes
 * ('chat_message', 'schedule', 'agent_run', 'internal').
 *
 * Wakeup is `pg_notify('runs_lobu:<queue_name>', '<run_type>')` on every send;
 * subscribers register via the shared `getRawDb().listen()` socket so all
 * caches and the queue multiplex onto a single LISTEN connection per process.
 *
 * Connection model: this class does NOT open its own pool or LISTEN client.
 * - Read/write queries go through `getDb()` (postgres.js singleton, max 20).
 * - LISTEN goes through `getRawDb().listen(channel, fn)` (postgres.js
 *   internally maintains one shared listener Sql instance with max:1).
 * Reconnect/backoff is handled by postgres.js. We only re-issue LISTENs after
 * postgres.js's `onlisten` callback fires post-reconnect.
 */

import { randomUUID } from "node:crypto";
import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import * as Sentry from "@sentry/node";
import { intervals } from "../../../config/intervals.js";
import { getDb, getDbListener, type DbClient } from "../../../db/client.js";
import { incrementCounter } from "../../metrics/prometheus.js";
import {
  isDeferralError,
  type IMessageQueue,
  type JobHandler,
  type QueueJob,
  type QueueOptions,
  type QueueStats,
} from "./types.js";

const logger = createLogger("runs-queue");

/**
 * Per-queue_name NOTIFY channels keyed `runs_lobu:<queue_name>`. Avoids the
 * thundering herd that a single shared channel would cause: every worker
 * would wake on every insert regardless of which queue it owns.
 */
const NOTIFY_CHANNEL_PREFIX = "runs_lobu:";
export function notifyChannelFor(queueName: string): string {
  return `${NOTIFY_CHANNEL_PREFIX}${queueName}`;
}
// Poll cadence lives in config/intervals.ts (`runsPollIntervalMs`),
// env-overridable.
/** Backoff cap (seconds) when retrying a failed run. */
const MAX_BACKOFF_SECONDS = 300;
/** How often the stale-claim sweeper runs. */
const STALE_SWEEP_INTERVAL_MS = 30_000;
/** Max time to wait for in-flight handlers during graceful stop. */
const SHUTDOWN_DRAIN_MS = 30_000;

function queueBreadcrumb(
  category: string,
  message: string,
  data: Record<string, unknown>,
): void {
  try {
    Sentry.addBreadcrumb({
      category: `runs-queue.${category}`,
      level: "info",
      message,
      data,
    });
  } catch {
    // Sentry init may not be present in tests; ignore.
  }
}
// Claim visibility timeout + heartbeat cadence live in config/intervals.ts
// (`runsClaimVisibilityTimeoutMs` / `runsClaimHeartbeatIntervalMs`),
// env-overridable. Rows in `claimed` for longer than the visibility timeout
// without a heartbeat are reset to pending so a fresh claim can pick them up;
// the active handler heartbeats well under the timeout, so a live worker
// keeps its claim indefinitely and only crashed/wedged workers fall past it.

/** Lobu-queue run types. Inserts/claims are restricted to these so connector
 *  lanes (sync, action, embed_backfill, automation, auth) are never disturbed. */
const LOBU_RUN_TYPES = [
  "chat_message",
  "schedule",
  "agent_run",
  "internal",
  "task",
] as const;

type LobuRunType = (typeof LOBU_RUN_TYPES)[number];

/** Per-queue concurrency for handler invocations. Hardcoded today; lift to a
 *  config knob if/when a queue legitimately needs >1. */
const DEFAULT_WORKER_CONCURRENCY = 1;

interface QueueWorker {
  queueName: string;
  runType: LobuRunType;
  handler: JobHandler<unknown>;
  concurrency: number;
  paused: boolean;
  stopped: boolean;
  /** Claims issued to `claimOne` that have not returned yet. */
  claiming: number;
  active: number;
  wakeup: () => void;
  pendingWakeup: boolean;
}

/** Map a queue name to a lobu-queue `run_type`. */
export function classifyQueue(queueName: string): LobuRunType {
  if (queueName === "task" || queueName.startsWith("task:")) return "task";
  if (queueName.startsWith("schedule")) return "schedule";
  if (queueName === "agent_run" || queueName.startsWith("agent_run:"))
    return "agent_run";
  if (queueName.startsWith("internal")) return "internal";
  return "chat_message";
}

/** Compute the next-attempt delay for a failed run. Exponential, base 2 seconds,
 *  capped at MAX_BACKOFF_SECONDS. */
export function backoffSeconds(attempt: number): number {
  const seconds = 2 ** Math.max(0, attempt);
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
}

export class RunsQueue implements IMessageQueue {
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;
  /** Set true on stop(); send/work check this and refuse new work. */
  private shuttingDown = false;

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Workers keyed by queue name. */
  private workers = new Map<string, QueueWorker>();
  /** Per-channel subscribers, keyed by full per-queue_name channel. */
  private subscribersByChannel = new Map<string, Set<QueueWorker>>();
  /** Active LISTEN subscriptions, keyed by channel. */
  private listenSubs = new Map<string, { unlisten: () => Promise<unknown> }>();

  /**
   * Per-process claim identity. UUID instead of `process.pid` because pids
   * collide across Kubernetes pods — two replicas can each have pid 42, and
   * filtering ownership by pid would let one pod's heartbeat / completion
   * silently mutate another pod's claim. Generated once at construction and
   * stamped into `claimed_by` on every claim; every subsequent ownership
   * mutation (heartbeat / mark-completed / mark-failed / schedule-retry /
   * shutdown release) MUST include `AND claimed_by = ${this.claimedBy}` to
   * prevent cross-pod ownership corruption.
   */
  private readonly claimedBy: string;

  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error("RunsQueue: DATABASE_URL is required");
    }
    this.claimedBy = `gateway-${randomUUID()}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isConnected) return;

    this.isConnected = true;
    this.shuttingDown = false;

    // Reset any rows orphaned by a hard crash before SIGTERM ran
    // (claimed/running with no recent heartbeat).
    await this.recoverStaleClaimedRowsOnStartup();

    this.startStaleSweep();
    logger.debug("Runs queue started");
  }

  /** At startup, reset rows orphaned by a hard crash. */
  private async recoverStaleClaimedRowsOnStartup(): Promise<void> {
    const sql = getDb();
    try {
      const recoveryWindowMs = intervals.runsClaimVisibilityTimeoutMs * 2;
      const result = await sql`
        UPDATE public.runs
        SET status = 'pending',
            claimed_at = NULL,
            claimed_by = NULL,
            run_at = now()
        WHERE status IN ('claimed', 'running')
          AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
          AND NOT (
            run_type = 'chat_message'
            AND COALESCE(
              action_input->'executionTarget'->>'kind' = 'device',
              false
            )
          )
          -- RunsQueue work uses the 'auto' default. Human-approved rows have
          -- a separate inline lease and reconciliation path that must retain
          -- their running state across a gateway restart.
          AND COALESCE(approval_status, 'auto') = 'auto'
          AND (claimed_at IS NULL
               OR claimed_at < now() - (${recoveryWindowMs}::int * interval '1 millisecond'))
        RETURNING id
      `;
      if (result.count > 0) {
        logger.warn(
          `Startup recovery: reclaimed ${result.count} stale runs orphaned by crash`,
        );
      }
    } catch (err) {
      logger.warn(
        `Startup recovery scan failed: ${(err as Error).message}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.isConnected = false;
    this.shuttingDown = true;

    // Graceful shutdown: stop accepting new claims, wait for in-flight
    // handlers to finish (with a timeout), then release any rows still in
    // `claimed` state by this consumer back to `pending`.
    for (const w of this.workers.values()) {
      w.stopped = true;
      w.wakeup();
    }

    const drainStart = Date.now();
    while (Date.now() - drainStart < SHUTDOWN_DRAIN_MS) {
      // `claiming` as well as `active`: a claim still inside `claimOne` is
      // about to become a row this process owns, so breaking the drain before
      // it lands would leave it claimed by an exiting pod.
      const inFlight = Array.from(this.workers.values()).reduce(
        (sum, w) => sum + w.claiming + w.active,
        0,
      );
      if (inFlight === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Release any rows still claimed by this process so a fresh gateway
    // can pick them up immediately rather than waiting for the stale
    // sweeper. Filter by our per-process claim identity so a sibling pod's
    // in-flight claims aren't released out from under it.
    try {
      const released = await this.releaseAllClaims();
      if (released > 0) {
        logger.info(`Released ${released} claimed run(s) on shutdown`);
      }
    } catch (err) {
      logger.warn(
        `Failed to release claimed rows on shutdown: ${(err as Error).message}`,
      );
    }

    this.workers.clear();
    this.subscribersByChannel.clear();

    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }

    // Tear down all LISTEN subscriptions on the shared postgres-js listener.
    const subs = Array.from(this.listenSubs.values());
    this.listenSubs.clear();
    for (const sub of subs) {
      try {
        await sub.unlisten();
      } catch {
        // ignore
      }
    }

    logger.debug("Runs queue stopped");
  }

  isHealthy(): boolean {
    return this.isConnected;
  }

  // ── Producer ────────────────────────────────────────────────────────────

  async createQueue(queueName: string): Promise<void> {
    if (!queueName) {
      throw new Error("queueName is required");
    }
  }

  async send<T>(
    queueName: string,
    data: T,
    options?: QueueOptions,
  ): Promise<string> {
    if (!this.isConnected) throw new Error("RunsQueue not started");
    if (this.shuttingDown) {
      throw new Error("RunsQueue is shutting down; refusing new work");
    }
    const runType = classifyQueue(queueName);
    const idempotencyKey = options?.singletonKey ?? null;
    const maxAttempts = options?.retryLimit ?? 3;
    const delayMs = options?.delayMs ?? 0;
    const priority = options?.priority ?? 0;
    const retryDelaySeconds = options?.retryDelay ?? null;
    const expireInSeconds = options?.expireInSeconds;
    const actionKey = options?.actionKey ?? null;
    const runAtSql = delayMs > 0
      ? `now() + ${Number(delayMs) / 1000}::float * interval '1 second'`
      : "now()";
    const expiresAtSql = expireInSeconds && expireInSeconds > 0
      ? `now() + ${Number(expireInSeconds)}::int * interval '1 second'`
      : "NULL";

    const sql = getDb();
    // Pass the payload object through postgres-js's `sql.json()` helper so
    // the driver sends it as a single-encoded JSONB value. The previous
    // shape — `JSON.stringify(data)` bound to a `$4::jsonb` parameter via
    // `tx.unsafe()` — round-tripped through Postgres as a JSONB *string*
    // (jsonb_typeof = 'string'), not a JSONB object. That broke every
    // downstream reader using `action_input ->> 'field'`, including the
    // snapshot-route ownership verifier in transcript-routes.ts.
    const actionInput = sql.json(data ?? {});

    // Populate runs.organization_id from the payload. This column is
    // preexisting (NOT from PR #870's denormalization — that one removed
    // agent_id+conversation_id only) and is the column the snapshot
    // verifier checks via `WHERE organization_id = $X` in
    // isRunOwnedByJwtScope. PR #873's denormalize revert accidentally
    // dropped organization_id from the INSERT alongside agent_id/
    // conversation_id, leaving the column NULL on every new chat_message
    // row. Result: verifier returned false for every snapshot POST,
    // workers rejected with 403 the moment Phase 5 flipped snapshot
    // mode to default. Re-add organization_id only.
    const organizationIdFromPayload =
      typeof (data as { organizationId?: unknown })?.organizationId ===
        "string" &&
      ((data as { organizationId?: string }).organizationId as string).length >
        0
        ? (data as { organizationId: string }).organizationId
        : null;

    // Insert + ON-CONFLICT-fallback inside a single transaction so a race
    // between two enqueues with the same idempotency key resolves cleanly.
    // pg_notify happens AFTER commit (otherwise listeners may wake before
    // the row is visible).
    //
    // runAt/expires_at are interpolated as raw SQL fragments via two helpers
    // because postgres-js can't parameterize an `interval` argument that is
    // itself a JS number-of-ms — we just compose the SQL.
    const id = await sql.begin(async (tx: DbClient) => {
      // ON CONFLICT must match the index predicate exactly. The
      // `runs_idempotency_key_uniq` index is partial:
      //   WHERE idempotency_key IS NOT NULL
      //     AND status IN ('pending', 'claimed', 'running')
      // Rows whose status has already moved to a terminal value drop out of
      // the index, so a later enqueue with the same singleton key inserts a
      // fresh row instead of being silently swallowed.
      const result = await tx.unsafe<{ id: number | string }>(
        `INSERT INTO public.runs (
          run_type,
          queue_name,
          action_key,
          action_input,
          idempotency_key,
          max_attempts,
          attempts,
          status,
          run_at,
          priority,
          expires_at,
          retry_delay_seconds,
          organization_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 0, 'pending', ${runAtSql}, $7, ${expiresAtSql}, $8, $9
        )
        ON CONFLICT (idempotency_key)
          WHERE idempotency_key IS NOT NULL
            AND status IN ('pending', 'claimed', 'running')
        DO NOTHING
        RETURNING id`,
        [
          runType,
          queueName,
          actionKey,
          actionInput,
          idempotencyKey,
          maxAttempts,
          priority,
          retryDelaySeconds,
          organizationIdFromPayload,
        ],
      );

      if (result.length === 0 && idempotencyKey) {
        const existing = await tx<{ id: number | string }>`
          SELECT id FROM public.runs
          WHERE idempotency_key = ${idempotencyKey}
            AND status IN ('pending', 'claimed', 'running')
          ORDER BY id DESC
          LIMIT 1
        `;
        return String(existing[0]?.id ?? "");
      }
      return String(result[0]?.id ?? "");
    });

    // Wake listeners post-commit. Failure here is non-fatal; pollers catch
    // it on the next tick.
    try {
      await sql`SELECT pg_notify(${notifyChannelFor(queueName)}, ${queueName})`;
    } catch (err) {
      logger.warn(
        `pg_notify failed for ${queueName}: ${(err as Error).message}`,
      );
    }

    queueBreadcrumb("enqueue", `Enqueued run ${id}`, {
      runId: id,
      queueName,
      runType,
      priority,
      idempotencyKey,
    });

    return id;
  }

  // ── Consumer ────────────────────────────────────────────────────────────

  async work<T>(
    queueName: string,
    handler: JobHandler<T>,
    options?: { startPaused?: boolean },
  ): Promise<void> {
    if (!this.isConnected) throw new Error("RunsQueue not started");
    if (this.shuttingDown) {
      throw new Error("RunsQueue is shutting down; refusing new work");
    }

    // Re-register in place. The worker object is the concurrency boundary, so
    // swapping it out on a reconnect published a fresh `active: 0` alongside a
    // handler the old worker was still running, and the replacement's poll loop
    // then claimed a second row for a queue meant to run one at a time.
    // `registerWorker` is documented as safe to call repeatedly, so this ran
    // every time a worker's SSE connection came back.
    const existing = this.workers.get(queueName);
    if (existing) {
      existing.handler = handler as JobHandler<unknown>;
      existing.paused = options?.startPaused ?? false;
      existing.wakeup();
      await this.ensureChannelListened(notifyChannelFor(queueName));
      return;
    }

    const runType = classifyQueue(queueName);
    let resolveWake: (() => void) | null = null;
    const worker: QueueWorker = {
      queueName,
      runType,
      handler: handler as JobHandler<unknown>,
      concurrency: DEFAULT_WORKER_CONCURRENCY,
      paused: options?.startPaused ?? false,
      stopped: false,
      claiming: 0,
      active: 0,
      pendingWakeup: false,
      wakeup: () => {
        worker.pendingWakeup = true;
        if (resolveWake) {
          const r = resolveWake;
          resolveWake = null;
          r();
        }
      },
    };
    this.workers.set(queueName, worker);

    const channel = notifyChannelFor(queueName);
    let channelSet = this.subscribersByChannel.get(channel);
    if (!channelSet) {
      channelSet = new Set();
      this.subscribersByChannel.set(channel, channelSet);
    }
    channelSet.add(worker);
    await this.ensureChannelListened(channel);

    // Self-driving poll loop. Sleeps `intervals.runsPollIntervalMs` between
    // empty claims;
    // a NOTIFY for the channel cuts the sleep short.
    const loop = async () => {
      while (!worker.stopped) {
        if (worker.paused) {
          await this.sleep(intervals.runsPollIntervalMs, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
          continue;
        }
        if (worker.active >= worker.concurrency) {
          await this.sleep(50, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
          continue;
        }
        try {
          worker.claiming += 1;
          let claimed: Awaited<ReturnType<RunsQueue["claimOne"]>>;
          try {
            claimed = await this.claimOne(worker);
          } finally {
            worker.claiming -= 1;
          }
          // `stop()` can flip these flags while the claim above is in flight.
          // There is no await between this check and `active += 1`, so a row
          // claimed by a queue that is going away is handed back rather than
          // started on a process that is exiting.
          if (claimed && (worker.stopped || this.shuttingDown)) {
            await this.releaseClaim(claimed.runId);
            continue;
          }
          if (!claimed) {
            await this.sleep(intervals.runsPollIntervalMs, worker, () => {
              resolveWake = null;
            }, (resolve) => {
              resolveWake = resolve;
            });
            continue;
          }
          worker.active += 1;
          this.runHandler(worker, claimed).finally(() => {
            worker.active -= 1;
          });
        } catch (err) {
          logger.error(`Poll loop error for ${queueName}:`, err);
          await this.sleep(intervals.runsPollIntervalMs, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
        }
      }
    };
    void loop();
  }

  async pauseWorker(queueName: string): Promise<void> {
    const w = this.workers.get(queueName);
    if (!w) return;
    w.paused = true;
  }

  async resumeWorker(queueName: string): Promise<void> {
    const w = this.workers.get(queueName);
    if (!w) return;
    w.paused = false;
    w.wakeup();
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    const sql = getDb();
    const rows = await sql<{
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    }>`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS waiting,
        COALESCE(SUM(CASE WHEN status IN ('claimed','running') THEN 1 ELSE 0 END), 0)::int AS active,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed
      FROM public.runs
      WHERE queue_name = ${queueName}
    `;
    const row = rows[0] ?? {} as Partial<{
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    }>;
    return {
      waiting: Number(row.waiting ?? 0),
      active: Number(row.active ?? 0),
      completed: Number(row.completed ?? 0),
      failed: Number(row.failed ?? 0),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Claim one row scoped to the worker's `queue_name`. */
  private async claimOne(worker: QueueWorker): Promise<{
    runId: number;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
    retryDelaySeconds: number | null;
  } | null> {
    const sql = getDb();
    const claimedBy = this.claimedBy;
    const rows = await sql<{
      id: number | string;
      action_input: unknown;
      attempts: number | string;
      max_attempts: number | string;
      retry_delay_seconds: number | string | null;
    }>`
      WITH next_run AS (
        SELECT id FROM public.runs
        WHERE status = 'pending'
          AND run_type = ${worker.runType}
          AND queue_name = ${worker.queueName}
          -- Device-placed chat turns stay on the same messages/chat_message
          -- substrate, but are claimed by that device's worker poller. The
          -- gateway consumer must never race it for the same row.
          AND NOT (
            queue_name = 'messages'
            AND COALESCE(
              action_input->'executionTarget'->>'kind' = 'device',
              false
            )
          )
          AND run_at <= now()
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY priority DESC, run_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.runs r
      SET status = 'claimed',
          claimed_at = now(),
          claimed_by = ${claimedBy}
      FROM next_run nr
      WHERE r.id = nr.id
      RETURNING r.id, r.action_input, r.attempts, r.max_attempts, r.retry_delay_seconds
    `;
    const row = rows[0];
    if (!row) return null;
    queueBreadcrumb("claim", `Claimed run ${row.id}`, {
      runId: Number(row.id),
      queueName: worker.queueName,
      attempts: Number(row.attempts ?? 0),
    });
    return {
      runId: Number(row.id),
      payload: row.action_input,
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      retryDelaySeconds:
        row.retry_delay_seconds === null
          ? null
          : Number(row.retry_delay_seconds),
    };
  }

  private async runHandler(
    worker: QueueWorker,
    claimed: {
      runId: number;
      payload: unknown;
      attempts: number;
      maxAttempts: number;
      retryDelaySeconds: number | null;
    },
  ): Promise<void> {
    const job: QueueJob<unknown> = {
      id: String(claimed.runId),
      data: claimed.payload,
      name: worker.queueName,
      attempt: claimed.attempts,
      maxAttempts: claimed.maxAttempts,
    };
    const heartbeat = setInterval(() => {
      void this.heartbeatClaim(claimed.runId);
    }, intervals.runsClaimHeartbeatIntervalMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    try {
      await worker.handler(job);
      await this.markCompleted(claimed.runId);
    } catch (err) {
      if (isDeferralError(err)) {
        // Waiting, not failing — reschedule without consuming an attempt
        // (see isDeferralError in types.ts for the contract).
        await this.scheduleRetry(
          claimed.runId,
          claimed.attempts,
          claimed.retryDelaySeconds,
        );
      } else {
        const nextAttempt = claimed.attempts + 1;
        if (nextAttempt >= claimed.maxAttempts) {
          await this.markFailed(claimed.runId, err);
        } else {
          await this.scheduleRetry(
            claimed.runId,
            nextAttempt,
            claimed.retryDelaySeconds,
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Refresh `claimed_at` so the stale-claim sweeper does not reclaim a row
   *  whose handler is still running. Filters on `claimed_by = ${this.claimedBy}`
   *  so a sibling pod that has since reclaimed this row (after a heartbeat
   *  gap → sweep → re-claim cycle) doesn't have its claim silently extended
   *  by ours. */
  private async heartbeatClaim(runId: number): Promise<void> {
    try {
      const sql = getDb();
      await sql`
        UPDATE public.runs
        SET claimed_at = now()
        WHERE id = ${runId}
          AND status = 'claimed'
          AND claimed_by = ${this.claimedBy}
      `;
    } catch (err) {
      logger.warn({ runId, err }, "runs-queue heartbeat failed");
    }
  }

  private async markCompleted(runId: number): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE public.runs
      SET status = 'completed',
          completed_at = now()
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${this.claimedBy}
    `;
    queueBreadcrumb("complete", `Completed run ${runId}`, { runId });
  }

  private async markFailed(runId: number, err: unknown): Promise<void> {
    const sql = getDb();
    const message = getErrorMessage(err);
    const rows = await sql`
      UPDATE public.runs
      SET status = 'failed',
          completed_at = now(),
          error_message = ${message},
          attempts = attempts + 1
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${this.claimedBy}
      RETURNING run_type, queue_name
    `;
    const row = rows[0] as
      | { run_type?: string; queue_name?: string }
      | undefined;
    // Only emit when we actually transitioned the row (a sibling pod may have
    // reclaimed it after a heartbeat gap). The failed `runs` row is the durable
    // dead-letter record (kept FAILED_RUNS_RETENTION_DAYS); this counter is the
    // aggregate, alertable signal the log alone never provided — a
    // user-facing reply (run_type='chat_message') here was silently dropped.
    if (row) {
      incrementCounter("lobu_runs_failed_total", {
        run_type: row.run_type ?? "unknown",
        queue: row.queue_name ?? "unknown",
      });
    }
    // Logged as a warning; not emitted to Sentry. Per-run terminal failures
    // are high-volume and low-actionable (each is a separate event in Sentry,
    // burning the org quota with no per-incident signal beyond the log).
    // The aggregate "we have failed runs" signal lives on lobu_runs_failed_total.
    logger.warn(`Run ${runId} failed after retries: ${message}`);
  }

  private async scheduleRetry(
    runId: number,
    attempt: number,
    retryDelaySeconds: number | null,
  ): Promise<void> {
    const sql = getDb();
    const delay = retryDelaySeconds !== null
      ? Math.max(0, retryDelaySeconds)
      : backoffSeconds(attempt);
    await sql`
      UPDATE public.runs
      SET status = 'pending',
          attempts = ${attempt},
          run_at = now() + (${delay}::int * interval '1 second'),
          claimed_at = NULL,
          claimed_by = NULL
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${this.claimedBy}
    `;
    queueBreadcrumb("retry", `Scheduled retry for run ${runId}`, {
      runId,
      attempt,
      delaySeconds: delay,
    });
  }

  /** Release every row still claimed by this process. Scoped to our own claim
   *  identity so a sibling pod's in-flight claims are left alone. */
  private async releaseAllClaims(): Promise<number> {
    const sql = getDb();
    const result = await sql`
      UPDATE public.runs
      SET status = 'pending',
          claimed_at = NULL,
          claimed_by = NULL
      WHERE claimed_by = ${this.claimedBy}
        AND status = 'claimed'
    `;
    return result.count;
  }

  /** Hand a just-claimed row straight back to `pending`. Scoped to this
   *  process's claim identity for the same reason `scheduleRetry` is: a sibling
   *  pod that reclaimed the row after a heartbeat gap keeps it. */
  private async releaseClaim(runId: number): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE public.runs
      SET status = 'pending',
          claimed_at = NULL,
          claimed_by = NULL
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${this.claimedBy}
    `;
    queueBreadcrumb("release", `Released run ${runId} on shutdown`, { runId });
  }

  /**
   * Subscribe to a per-queue_name channel via the shared postgres-js
   * listener. Idempotent — repeat calls return immediately. postgres-js
   * handles disconnect/reconnect internally and re-LISTENs on its own;
   * callers don't need a reconnect timer.
   */
  private async ensureChannelListened(channel: string): Promise<void> {
    if (this.listenSubs.has(channel)) return;
    try {
      const sub = await getDbListener().listen(channel, () => {
        const set = this.subscribersByChannel.get(channel);
        if (!set) return;
        for (const w of set) w.wakeup();
      });
      this.listenSubs.set(channel, { unlisten: sub.unlisten });
      logger.debug(`LISTEN ${channel}`);
    } catch (err) {
      logger.warn(
        `LISTEN ${channel} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Sleep for `ms` or until the worker's wakeup() is called or it stops. */
  private async sleep(
    ms: number,
    worker: QueueWorker,
    onClear: () => void,
    onCapture: (resolve: () => void) => void,
  ): Promise<void> {
    if (worker.pendingWakeup) {
      worker.pendingWakeup = false;
      return;
    }
    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        worker.pendingWakeup = false;
        onClear();
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      onCapture(finish);
      if (worker.stopped) finish();
    });
  }

  // ── Stale-claim recovery ────────────────────────────────────────────────

  private staleSweepInFlight = false;

  private startStaleSweep(): void {
    if (this.staleSweepTimer) return;
    const tick = async () => {
      if (this.staleSweepInFlight) return;
      this.staleSweepInFlight = true;
      try {
        const sql = getDb();
        // Threshold comes from intervals.ts, which guarantees a positive
        // integer (parseEnvInt rounds and falls back on bad input), so it is
        // safe to inline as a SQL literal — no placeholders needed.
        const thresholdMs = intervals.runsClaimVisibilityTimeoutMs;
        const result = await sql.unsafe(
          `UPDATE public.runs
           SET status = 'pending',
               claimed_at = NULL,
               claimed_by = NULL,
               run_at = now()
           WHERE status = 'claimed'
             AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
             AND claimed_at < now() - (${thresholdMs} * interval '1 millisecond')
           RETURNING id`,
        );
        if (result.count > 0) {
          // Operational housekeeping, not an incident — log it, but don't
          // page Sentry (Seer flagged the alert super-low actionability).
          logger.warn(
            `Reclaimed ${result.count} stale runs (claimed > ${
              thresholdMs / 1000
            }s ago)`,
          );
        }
      } catch (err) {
        logger.warn(
          `Stale-claim sweep failed: ${(err as Error).message}`,
        );
      } finally {
        this.staleSweepInFlight = false;
      }
    };
    void tick();
    this.staleSweepTimer = setInterval(tick, STALE_SWEEP_INTERVAL_MS);
    this.staleSweepTimer.unref?.();
  }
}

/**
 * Delete expired runs rows AND completed/failed lobu-queue runs older than
 * the configured retention window. Called from the periodic ephemeral-table
 * sweep. RUNS_RETENTION_DAYS env override (defaults to 30).
 */
export async function sweepCompletedRuns(): Promise<number> {
  const sql = getDb();
  const retentionDays = (() => {
    const raw = Number(process.env.RUNS_RETENTION_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  })();
  // Failed runs are the dead-letter record an operator inspects/replays. Keep
  // them at least as long as completed runs, but allow a longer, independent
  // window via FAILED_RUNS_RETENTION_DAYS so the dead-letter lane isn't pruned
  // at the same cadence as routine completions. Defaults to retentionDays, so
  // execution is unchanged unless an operator opts into a longer window.
  const failedRetentionDays = (() => {
    const raw = Number(process.env.FAILED_RUNS_RETENTION_DAYS);
    return Number.isFinite(raw) && raw > 0
      ? Math.max(raw, retentionDays)
      : retentionDays;
  })();

  let total = 0;

  const expired = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE expires_at IS NOT NULL
        AND expires_at <= now()
        AND status = 'pending'
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((expired[0] as { count?: number } | undefined)?.count ?? 0);

  const aged = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE status IN ('completed', 'cancelled', 'timeout')
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
        AND completed_at IS NOT NULL
        AND completed_at < now() - (${retentionDays}::int * interval '1 day')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((aged[0] as { count?: number } | undefined)?.count ?? 0);

  // Dead-letter lane: prune failed runs on their own (>=) retention window.
  const agedFailed = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE status = 'failed'
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
        AND completed_at IS NOT NULL
        AND completed_at < now() - (${failedRetentionDays}::int * interval '1 day')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((agedFailed[0] as { count?: number } | undefined)?.count ?? 0);

  return total;
}
