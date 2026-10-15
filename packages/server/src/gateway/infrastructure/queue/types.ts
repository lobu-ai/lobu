/**
 * Message queue interface and payload types for lobu
 * Implemented by RunsQueue over the Postgres `public.runs` substrate.
 */

// ============================================================================
// Queue Types
// ============================================================================

export interface QueueJob<T = any> {
  id: string;
  data: T;
  name?: string;
  /**
   * Attempts already consumed by this row, and the budget they run against.
   * Both are present only for handlers invoked by `RunsQueue`; a handler must
   * treat `undefined` as "budget unknown" and keep its normal retry policy.
   *
   * A handler whose drop policy IS attempt exhaustion (the `thread_response`
   * owner-gate, see TERMINAL_DELIVERY_SEND_OPTS) reads these to recognise its
   * LAST claim and degrade to a local, best-effort delivery instead of letting
   * the row dead-letter with its side effects unrun.
   */
  attempt?: number;
  maxAttempts?: number;
  /** RunsQueue's claim owner; durable handlers must fence against this identity. */
  claimedBy?: string;
}

export interface QueueOptions {
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
  singletonKey?: string;
  /** Delay in milliseconds before the job is processed */
  delayMs?: number;
  /** Optional `runs.action_key` value — the task lane uses this to encode the
   *  task name so admin/ops queries can filter without unpacking JSON. */
  actionKey?: string;
}

/**
 * Send options for TERMINAL `thread_response` rows (success completion or
 * error) that are subject to the API owner-gate in `routeToRenderer`. When a
 * non-owning replica claims such a row it throws to re-queue; the owning pod
 * (which holds the client's SSE) must win a SKIP-LOCKED claim before delivery.
 *
 * A short FIXED retry delay (not the default exponential backoff, which would
 * span hours) plus a raised retry limit gives a ~30s re-claim window. That
 * covers both the cross-pod hand-off and the client's POST→connect gap at the
 * small replica counts we run. On the LAST claim the consumer stops re-queueing
 * and renders locally instead (see the owner-gate in unified-thread-consumer):
 * the client may well be gone, but the terminal row's durable side effects —
 * Automation run resolution above all — must still run, and dead-lettering the
 * row skipped them.
 *
 * Non-terminal rows (deltas/status) are NOT owner-gated, so they don't need
 * this and keep the default send options.
 */
export const TERMINAL_DELIVERY_SEND_OPTS: QueueOptions = {
  retryLimit: 30,
  retryDelay: 1,
};

/**
 * A handler-thrown error carrying `deferral: true` asks the queue to
 * reschedule the job WITHOUT consuming an attempt: the job is waiting on an
 * external condition (e.g. the dispatch gate waiting out a prior turn on the
 * same worker), not failing. `max_attempts` stays a genuine-failure budget —
 * without this flag, a legitimately hour-long prior turn would exhaust the
 * follower job's budget and strand it as a failed, never-delivered row.
 *
 * Opt-in by design: throws that USE exhaustion as their drop policy (the
 * thread_response owner-gate above) must keep consuming attempts. A thrower
 * setting this flag must have an external termination bound (a sweep,
 * head-of-line progress) — the flag is not a license to wait on a condition
 * nothing else resolves.
 */
export function isDeferralError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { deferral?: unknown }).deferral === true
  );
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export type JobHandler<T = any> = (job: QueueJob<T>) => Promise<void>;

/**
 * Abstract message queue interface.
 * Implementations: RunsQueue (Postgres `public.runs` + SKIP LOCKED).
 */
export interface IMessageQueue {
  /**
   * Start the queue (connect to backend)
   */
  start(): Promise<void>;

  /**
   * Stop the queue (disconnect from backend)
   */
  stop(): Promise<void>;

  /**
   * Create a queue if it doesn't exist
   */
  createQueue(queueName: string): Promise<void>;

  /**
   * Send a message to a queue
   */
  send<T>(queueName: string, data: T, options?: QueueOptions): Promise<string>;

  /**
   * Subscribe to a queue and process jobs.
   * @param startPaused - If true, worker is created but won't process jobs until resumeWorker() is called.
   */
  work<T>(
    queueName: string,
    handler: JobHandler<T>,
    options?: { startPaused?: boolean }
  ): Promise<void>;

  /**
   * Pause a queue worker (stops processing jobs)
   */
  pauseWorker(queueName: string): Promise<void>;

  /**
   * Resume a queue worker (starts processing jobs)
   */
  resumeWorker(queueName: string): Promise<void>;

  /**
   * Get detailed queue statistics
   */
  getQueueStats(queueName: string): Promise<QueueStats>;

  /**
   * Check if queue is healthy/connected
   */
  isHealthy(): boolean;
}

// ============================================================================
// Payload Types
// ============================================================================

// `ThreadResponsePayload` is defined once in `@lobu/core` and re-exported
// from this package's queue index for convenience. It is shared by workers
// and platform renderers, so keeping a single source of truth is essential.
export type { ThreadResponsePayload } from "@lobu/core";
