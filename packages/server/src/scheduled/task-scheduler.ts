/**
 * TaskScheduler — unified primitive for periodic + one-shot platform-internal
 * jobs.
 *
 * Why this exists
 * ---------------
 * Before this module, each "background job" picked its own pattern: most used
 * `setInterval` from `scheduled/jobs.ts`, some used the runs-queue, some used
 * advisory locks directly. That meant N different mental models for "do work
 * regularly" with no shared observability, no cross-pod coordination beyond
 * a hand-rolled advisory lock, and no idempotency on dispatch.
 *
 * The TaskScheduler collapses all of that into a single concept: every
 * platform-side scheduled or lazy job is a *task* with a registered handler.
 * Tasks live as rows in `public.runs` (run_type='task', queue_name='task' or a
 * rollout-safe `task:<name>` lane),
 * which gives us — for free — claim semantics, retry/backoff, heartbeats,
 * idempotency-key dedup, observability via the existing runs/operations
 * dashboards, and LISTEN/NOTIFY wakeups via the existing runs-queue.
 *
 * Two invocation patterns
 * -----------------------
 *  1. Periodic (cron): `scheduler.register('foo', fn, { cron: '* * * * *' })`.
 *     The scheduler keeps a stream of one row per cron tick in the runs
 *     table. Each tick has idempotency_key = 'cron:<name>:<iso-tick>' so
 *     N pods racing to seed the same tick produce exactly one row.
 *
 *  2. Lazy / on-demand: `scheduler.spawn('foo', payload, opts)`. Caller-driven
 *     dispatch with optional idempotency key. Useful when the platform wants
 *     "fire-and-forget durable work" — e.g. refresh a token, reconcile a
 *     specific entity. Many concurrent callers + same idempotency key →
 *     one row.
 *
 * Crash + retry semantics
 * -----------------------
 * Periodic runs schedule their NEXT tick *before* running the handler. So
 * if the handler crashes, the runs-queue retries the current row (existing
 * exponential backoff path); the next tick is already queued and unaffected.
 * A pod restart between ticks is also fine — at boot, every cron registration
 * tries to seed the next tick, and idempotency dedups against any seed an
 * earlier pod (or this pod's last lifetime) already inserted.
 */

import { createLogger } from '@lobu/core';
import type { DbClient } from '../db/client';
import { incrementCounter } from '../gateway/metrics/prometheus';
import { notifyChannelFor } from '../gateway/infrastructure/queue/runs-queue';
import type { IMessageQueue, QueueJob } from '../gateway/infrastructure/queue/types';
import { nextRunAt } from '../utils/cron';
import {
  isTransactionalTaskName,
  taskQueueName,
} from './task-definitions';

const logger = createLogger('task-scheduler');

const TASK_QUEUE_NAME = 'task';

interface TaskContext<P = unknown> {
  /** Decoded task payload. */
  payload: P;
  /** runs.id — useful for correlating logs. */
  taskRunId: number;
  /** One-based delivery attempt for this task run. */
  attempt: number;
  /** Owner captured by the queue at dispatch, never re-read from a later claim. */
  claimedBy?: string;
}

type TaskHandler<P = unknown> = (ctx: TaskContext<P>) => Promise<void>;

interface SpawnOptions {
  /** Dedup key. While a row with this key is in (pending|claimed|running),
   *  spawn() is a no-op. */
  idempotencyKey?: string;
  /** Run no earlier than this absolute time. Default: now. */
  runAt?: Date;
  /** Override registration retryLimit. Default: 3. */
  maxAttempts?: number;
  /** Higher runs first. Default: 0. */
  priority?: number;
}

interface TaskJobData {
  name: string;
  payload: unknown;
  /** ISO timestamp of the cron tick this row represents. Set only on cron
   *  seeds (not on `spawn()` calls). Carrying it in the payload makes
   *  next-tick computation deterministic across pods regardless of local-
   *  clock drift: every claimer computes nextTick from this field, so the
   *  idempotency key for the next seed is identical for everyone, and dedup
   *  on the partial unique index wins. Computing nextTick from local
   *  `new Date()` would race the row's own claim window — if the pod's
   *  clock is slightly behind Postgres, `nextRunAt()` returns the SAME
   *  tick as the currently-claimed row, the seed conflicts, no new row is
   *  inserted, and the cron permanently stops. */
  __scheduledTick?: string;
}

interface TransactionalTask<P = unknown> {
  name: string;
  payload: P;
  opts: {
    idempotencyKey: string;
    maxAttempts?: number;
    priority?: number;
    organizationId?: string;
    automationId?: number;
    parentRunId?: number;
  };
}

/**
 * Transactional task enqueue for writers that must commit their domain rows
 * and their durable handoffs atomically. Unlike `spawn()`, this never opens a
 * nested transaction and acquires no domain/Automation locks. Postgres holds the
 * NOTIFY until the caller commits; the queue poller remains the fallback if
 * notification delivery fails. Domain writers persist a bounded set of rows in
 * one transaction, so the whole batch takes one INSERT and one NOTIFY per queue
 * lane rather than a database round-trip per row. Transactional handoffs
 * deliberately have no expiry: if every worker is unavailable, the durable row
 * must remain until it is claimed.
 */
export async function enqueueTasksInTransaction<P>(
  tx: DbClient,
  tasks: TransactionalTask<P>[],
): Promise<Map<string, number>> {
  if (tasks.length === 0) return new Map();
  const unknownTask = tasks.find((task) => !isTransactionalTaskName(task.name));
  if (unknownTask) {
    throw new Error(
      `Cannot enqueue unknown transactional task "${unknownTask.name}"`,
    );
  }
  const requested = tasks.map(({ name, payload, opts }) => ({
    name,
    queue_name: taskQueueName(name),
    data: { name, payload } satisfies TaskJobData,
    idempotency_key: opts.idempotencyKey,
    max_attempts: opts.maxAttempts ?? 5,
    priority: opts.priority ?? 0,
    organization_id: opts.organizationId ?? null,
    automation_id: opts.automationId ?? null,
    parent_run_id: opts.parentRunId ?? null,
  }));
  await tx`
    INSERT INTO public.runs (
      run_type, queue_name, action_key, action_input, idempotency_key,
      max_attempts, attempts, status, run_at, priority, expires_at,
      organization_id, automation_id, parent_run_id
    )
    SELECT
      'task', task.queue_name, task.name, task.data, task.idempotency_key,
      task.max_attempts, 0, 'pending', now(), task.priority, NULL,
      task.organization_id, task.automation_id, task.parent_run_id
    FROM jsonb_to_recordset(${tx.json(requested)}::jsonb) AS task(
      name text,
      queue_name text,
      data jsonb,
      idempotency_key text,
      max_attempts integer,
      priority integer,
      organization_id text,
      automation_id bigint,
      parent_run_id bigint
    )
    ON CONFLICT (idempotency_key)
      WHERE idempotency_key IS NOT NULL
        AND status IN ('pending', 'claimed', 'running')
    DO NOTHING
  `;
  const resolved = await tx<{
    id: number | string;
    idempotency_key: string;
  }>`
    SELECT r.id, r.idempotency_key
    FROM public.runs r
    JOIN jsonb_to_recordset(${tx.json(requested)}::jsonb) requested(
      idempotency_key text,
      queue_name text
    )
      ON requested.idempotency_key = r.idempotency_key
     AND requested.queue_name = r.queue_name
    WHERE r.run_type = 'task'
      AND r.status IN ('pending', 'claimed', 'running')
  `;
  const resolvedKeys = new Set(resolved.map((row) => row.idempotency_key));
  const missingTask = requested.find(
    (task) => !resolvedKeys.has(task.idempotency_key),
  );
  if (missingTask) {
    throw new Error(
      `Failed to enqueue transactional task "${missingTask.name}"`,
    );
  }
  for (const queueName of new Set(requested.map((task) => task.queue_name))) {
    await tx`SELECT pg_notify(${notifyChannelFor(queueName)}, ${queueName})`;
  }
  return new Map(
    resolved.map((row) => [row.idempotency_key, Number(row.id)]),
  );
}

interface TaskRegistration {
  name: string;
  handler: TaskHandler;
  cron?: string;
}

/** Cron seed key — per-tick so each scheduled fire produces exactly one row.
 *  Race-safe: N pods seeing "next tick is at T" all attempt insert with the
 *  same key; the partial unique index on idempotency_key admits exactly one. */
function cronSeedKey(name: string, tick: Date): string {
  return `cron:${name}:${tick.toISOString()}`;
}

export class TaskScheduler {
  private handlers = new Map<string, TaskRegistration>();
  private started = false;
  private localTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly queue: IMessageQueue) {}

  /** Register a task handler. Call before `start()`. */
  register<P = unknown>(
    name: string,
    handler: TaskHandler<P>,
    opts?: { cron?: string },
  ): void {
    if (this.started) {
      throw new Error(
        `TaskScheduler.register("${name}") called after start(); register all tasks first`,
      );
    }
    if (this.handlers.has(name)) {
      throw new Error(`Task "${name}" already registered`);
    }
    this.handlers.set(name, {
      name,
      handler: handler as TaskHandler,
      cron: opts?.cron,
    });
  }

  /** Spawn a one-shot task invocation. */
  async spawn<P>(name: string, payload: P, opts?: SpawnOptions): Promise<string> {
    if (!this.handlers.has(name)) {
      throw new Error(`Cannot spawn unknown task "${name}"`);
    }
    const data: TaskJobData = { name, payload };
    const delayMs = opts?.runAt
      ? Math.max(0, opts.runAt.getTime() - Date.now())
      : 0;
    return this.queue.send(taskQueueName(name), data, {
      singletonKey: opts?.idempotencyKey,
      delayMs,
      retryLimit: opts?.maxAttempts,
      priority: opts?.priority,
      actionKey: name,
    });
  }

  /** Start dispatching. Seeds the first tick for every cron-registered task,
   *  then registers the in-process handler with the runs-queue. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const reg of this.handlers.values()) {
      if (!reg.cron) continue;
      try {
        await this.seedNextCronTick(reg);
      } catch (err) {
        logger.error(
          { err, taskName: reg.name, cron: reg.cron },
          '[task-scheduler] Failed to seed cron row at boot; will retry in background',
        );
        // Periodic tasks self-seed via line ~216 once they dispatch, but a
        // task with no prior cron row stays idle until a successful seed.
        // Retry in the background so a transient DB hiccup at boot doesn't
        // disable the task until the next pod restart.
        this.retrySeedInBackground(reg);
      }
    }

    const queueNames = new Set([
      TASK_QUEUE_NAME,
      ...[...this.handlers.keys()].map(taskQueueName),
    ]);
    for (const queueName of queueNames) {
      await this.queue.work<TaskJobData>(queueName, (job) => this.dispatch(job));
    }

    const periodic = [...this.handlers.values()].filter((r) => r.cron).length;
    logger.info(
      { total: this.handlers.size, periodic },
      '[task-scheduler] Started',
    );
  }

  private retrySeedInBackground(reg: TaskRegistration): void {
    const delays = [5_000, 15_000, 60_000];
    const attempt = (i: number): void => {
      if (!this.started || i >= delays.length) return;
      setTimeout(() => {
        if (!this.started) return;
        this.seedNextCronTick(reg)
          .then(() =>
            logger.info(
              { taskName: reg.name, cron: reg.cron, attempt: i + 1 },
              '[task-scheduler] Recovered cron seed in background',
            ),
          )
          .catch((err) => {
            logger.error(
              { err, taskName: reg.name, cron: reg.cron, attempt: i + 1 },
              '[task-scheduler] Background cron seed retry failed',
            );
            attempt(i + 1);
          });
      }, delays[i]).unref();
    };
    attempt(0);
  }

  /** Best-effort work tied to this process's source, not the shared queue.
   *  Stop cancels pending callbacks; timers never hold the process open. */
  runOnceAfter(delayMs: number, fn: () => Promise<void>): void {
    const timer = setTimeout(async () => {
      this.localTimers.delete(timer);
      if (!this.started) return;
      try {
        await fn();
      } catch (err) {
        logger.error({ err }, '[task-scheduler] Local delayed task failed');
      }
    }, delayMs);
    this.localTimers.add(timer);
    timer.unref();
  }

  /** Stop dispatching. The underlying queue handles in-flight drain on its
   *  own `stop()`; local callbacks already running are not interrupted. */
  stop(): void {
    this.started = false;
    for (const timer of this.localTimers) clearTimeout(timer);
    this.localTimers.clear();
  }

  hasHandler(name: string): boolean {
    return this.handlers.has(name);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async dispatch(job: QueueJob<TaskJobData>): Promise<void> {
    const data = job.data ?? ({ name: '', payload: {} } as TaskJobData);
    const reg = this.handlers.get(data.name);
    if (!reg) {
      logger.error(
        { taskName: data.name, runId: job.id },
        '[task-scheduler] No handler registered for task; failing run',
      );
      throw new Error(`No handler registered for task "${data.name}"`);
    }

    // Periodic tasks: queue the next tick BEFORE running the handler. If
    // seeding fails, do NOT swallow — re-throw so the runs-queue marks this
    // row failed/retry; the retry path will re-attempt the seed before next
    // running the handler. Silent failure here would leave the cron stranded
    // with no successor row.
    //
    // Compute nextTick from the row's own scheduled tick (carried in payload)
    // not from local `new Date()`. See the comment on TaskJobData.__scheduledTick
    // for the clock-drift hazard this avoids.
    if (reg.cron) {
      const fromTick = data.__scheduledTick
        ? new Date(data.__scheduledTick)
        : new Date();
      // Add 1ms so nextRunAt skips past the current tick when fromTick falls
      // exactly on a cron boundary.
      await this.seedNextCronTick(reg, new Date(fromTick.getTime() + 1));
    }

    // Per-tick outcome counter — the scheduler heartbeat that backs the
    // "automation silent / failing" alerts. Counts every dispatched
    // task; alerts filter by job name. Re-throw is preserved so the runs-queue
    // retry path is unchanged.
    try {
      await reg.handler({
        payload: data.payload,
        taskRunId: Number(job.id),
        attempt: (job.attempt ?? 0) + 1,
        claimedBy: job.claimedBy,
      });
      // Label is `task`, NOT `job`: Prometheus reserves `job` for the scrape
      // target and overwrites any same-named metric label, which silently
      // collapses per-task series (and broke the automation alert).
      incrementCounter('lobu_scheduled_job_runs_total', {
        task: data.name,
        outcome: 'success',
      });
    } catch (err) {
      incrementCounter('lobu_scheduled_job_runs_total', {
        task: data.name,
        outcome: 'error',
      });
      throw err;
    }
  }

  /** Insert (or no-op if already present) a row for this task's next cron
   *  tick after `from`. The idempotency key is per-tick so successive ticks
   *  each get a fresh row.
   *
   *  Throws on insert failure — callers (boot + dispatch) decide whether to
   *  surface or downgrade. The dispatch path re-throws so the run retries;
   *  the boot path logs and continues so a transient DB hiccup at boot
   *  doesn't crash the pod (next pod start retries via the same path). */
  private async seedNextCronTick(
    reg: TaskRegistration,
    from: Date = new Date(),
  ): Promise<void> {
    if (!reg.cron) return;
    const tick = new Date(nextRunAt(reg.cron, from));
    const delayMs = Math.max(0, tick.getTime() - Date.now());
    const data: TaskJobData = {
      name: reg.name,
      payload: {},
      __scheduledTick: tick.toISOString(),
    };
    await this.queue.send(taskQueueName(reg.name), data, {
      singletonKey: cronSeedKey(reg.name, tick),
      delayMs,
      actionKey: reg.name,
    });
  }
}
