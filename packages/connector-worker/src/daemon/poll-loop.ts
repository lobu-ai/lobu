/**
 * Shared worker poll lifecycle.
 *
 * The full connector worker and the lean device daemon use the same health,
 * polling, concurrency, and graceful-shutdown lifecycle. Run execution stays
 * injected so the device build does not import fleet connector machinery.
 */

import { type PollResponse, WorkerHttpError, type WorkerClient } from './client.js';
import { log } from './log.js';

export interface WorkerPollLoopOptions {
  client: WorkerClient;
  pollIntervalMs?: number;
  /**
   * Optional ceiling for the delay between claims. Device daemons that expose
   * short-deadline source reads use this so an idle server hint cannot consume
   * the caller's whole queue budget before the run is claimed.
   */
  maxIdleDelayMs?: number;
  maxConcurrentJobs?: number;
  execute: (job: PollResponse) => Promise<unknown>;
  beforeIdlePoll?: () => Promise<void>;
  /** Persisted device credentials treat poll-time revocation as terminal. */
  failClosedOnPollAuthError?: boolean;
}

export type WorkerPollLoopExit = (code: number) => void;

export interface WorkerPollLoopSignalOptions {
  /** Only a supervised parent/child launch treats stdin EOF as shutdown. */
  stdinEof?: boolean;
}

export function shouldHandleWorkerPollLoopStdinEof(
  options: WorkerPollLoopSignalOptions = {}
): boolean {
  return options.stdinEof === true;
}

export class WorkerPollLoop {
  private readonly client: WorkerClient;
  private readonly pollIntervalMs: number;
  private readonly maxIdleDelayMs?: number;
  private readonly maxConcurrentJobs: number;
  private readonly execute: (job: PollResponse) => Promise<unknown>;
  private readonly beforeIdlePoll?: () => Promise<void>;
  private readonly failClosedOnPollAuthError: boolean;
  private running = false;
  private admittingJobs = true;
  private activeJobs = 0;
  private capacityVersion = 0;
  private wakePoll?: (capacityReleased?: boolean) => void;

  constructor(options: WorkerPollLoopOptions) {
    this.client = options.client;
    this.pollIntervalMs = options.pollIntervalMs ?? 10000;
    this.maxIdleDelayMs = options.maxIdleDelayMs === undefined
      ? undefined
      : Math.max(1, options.maxIdleDelayMs);
    this.maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 1);
    this.execute = options.execute;
    this.beforeIdlePoll = options.beforeIdlePoll;
    this.failClosedOnPollAuthError = options.failClosedOnPollAuthError === true;
  }

  async start(): Promise<void> {
    if (this.running) {
      log.info('[daemon] Already running');
      return;
    }

    if (!(await this.client.healthCheck())) {
      throw new Error('Backend health check failed');
    }
    if (!this.admittingJobs) return;

    log.info('[daemon] Starting worker daemon...');
    this.running = true;
    while (this.running) {
      if (this.activeJobs === 0) await this.beforeIdlePoll?.();
      let nextDelayMs: number | undefined;
      // A job may finish while the HTTP poll is in flight, before its wait
      // exists. Keep that completion observable when deciding whether to wait.
      let capacityVersion: number | undefined = this.capacityVersion;
      try {
        nextDelayMs = await this.pollAndExecute();
      } catch (err) {
        // Server errors retain their retry backoff even if a slot opens.
        capacityVersion = undefined;
        if (
          this.failClosedOnPollAuthError &&
          err instanceof WorkerHttpError &&
          (err.status === 401 || err.status === 403)
        ) {
          throw err;
        }
        log.info('[daemon] Poll error:', err);
      }
      if (this.running) {
        const requestedDelayMs = nextDelayMs ?? this.pollIntervalMs;
        const delayMs = nextDelayMs === undefined || this.maxIdleDelayMs === undefined
          ? requestedDelayMs
          : Math.min(requestedDelayMs, this.maxIdleDelayMs);
        await this.waitForNextPoll(delayMs, capacityVersion);
      }
    }
    log.info('[daemon] Stopped');
  }

  stop(): void {
    log.info('[daemon] Stopping...');
    this.running = false;
    this.admittingJobs = false;
    this.wakePoll?.();
  }

  async waitForActiveJobs(timeoutMs = 30000, pollMs = 500): Promise<boolean> {
    if (this.activeJobs === 0) return true;

    log.debug(`[daemon] Waiting for ${this.activeJobs} active job(s) to finish...`);
    const deadline = Date.now() + timeoutMs;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await this.sleep(pollMs);
    }

    if (this.activeJobs > 0) {
      log.info(
        `[daemon] Timed out after ${timeoutMs}ms waiting for ${this.activeJobs} active job(s)`
      );
      return false;
    }

    log.debug('[daemon] All active jobs completed');
    return true;
  }

  private async pollAndExecute(): Promise<number | undefined> {
    if (!this.admittingJobs) return undefined;
    const capacityAvailable = Math.max(0, this.maxConcurrentJobs - this.activeJobs);
    const job = await this.client.poll(capacityAvailable);
    if (!job.run_id) {
      if (!this.admittingJobs) return undefined;
      const nextPoll = job.next_poll_seconds ?? 30;
      log.debug(`[daemon] No runs available, next poll in ${nextPoll}s`);
      return Number.isFinite(nextPoll) && nextPoll > 0 ? nextPoll * 1000 : 1000;
    }

    // A zero-capacity response should be impossible: the server must not enter
    // a claim lane when the worker truthfully reports no free slot. Do not
    // execute a job if a server bug violates that contract.
    if (capacityAvailable === 0) {
      log.info(
        `[daemon] Server returned run ${job.run_id} while worker is at capacity; leaving it untouched`
      );
      return undefined;
    }

    this.activeJobs++;
    Promise.resolve()
      .then(() => this.execute(job))
      .catch((err) => {
        log.info(`[daemon] Run ${job.run_id} crashed:`, err);
      })
      .finally(() => {
        this.activeJobs--;
        this.capacityVersion++;
        this.wakePoll?.(true);
      });
    // Fill remaining slots while the queue has work, then wait for capacity
    // or the normal heartbeat instead of delaying every successful claim.
    return this.activeJobs < this.maxConcurrentJobs ? 0 : undefined;
  }

  private waitForNextPoll(ms: number, capacityVersion: number | undefined): Promise<void> {
    if (
      !this.running ||
      (capacityVersion !== undefined && capacityVersion !== this.capacityVersion)
    ) return Promise.resolve();

    return new Promise((resolve) => {
      const wake = (capacityReleased = false) => {
        if (capacityReleased && capacityVersion === undefined) return;
        clearTimeout(timer);
        this.wakePoll = undefined;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakePoll = wake;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createWorkerPollLoopShutdownHandler(
  loop: WorkerPollLoop,
  onShutdown: () => void | Promise<void> = () => loop.stop(),
  exit: WorkerPollLoopExit = process.exit
): (signal: string) => Promise<void> {
  let shuttingDown = false;
  return async (signal: string) => {
    if (shuttingDown) {
      console.error(`[daemon] Received ${signal} during shutdown, forcing exit`);
      exit(130);
      return;
    }
    shuttingDown = true;
    log.info(`\n[daemon] Received ${signal}, shutting down...`);
    let shutdownHookSucceeded = true;
    try {
      await onShutdown();
    } catch (error) {
      shutdownHookSucceeded = false;
      log.info('[daemon] Shutdown hook failed:', error);
    }
    const allDone = await loop.waitForActiveJobs();
    if (!allDone) log.info('[daemon] Forcing exit with active jobs still running');
    exit(allDone && shutdownHookSucceeded ? 0 : 1);
  };
}

export function installWorkerPollLoopSignals(
  loop: WorkerPollLoop,
  onShutdown: () => void | Promise<void> = () => loop.stop(),
  options: WorkerPollLoopSignalOptions = { stdinEof: false }
): void {
  const gracefulShutdown = createWorkerPollLoopShutdownHandler(loop, onShutdown);
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  if (shouldHandleWorkerPollLoopStdinEof(options)) {
    process.stdin.once('end', () => void gracefulShutdown('EOF'));
    process.stdin.resume();
  }
}

export async function startWorkerPollLoop(
  options: WorkerPollLoopOptions
): Promise<WorkerPollLoop> {
  const loop = new WorkerPollLoop(options);
  installWorkerPollLoopSignals(loop);
  await loop.start();
  return loop;
}
