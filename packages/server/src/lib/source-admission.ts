/**
 * Admission for LIVE source reads: how many runs one connection may have
 * against its source at once, who waits for a slot, and when identical reads
 * share one run.
 *
 * Source-backed public pages read their source live, one run per page. A
 * crawler walking distinct URLs (mostly cache misses at the edge) fanned out
 * enough runs to trip the source's own ingress limit, answering 429 to every
 * reader. Admission protects the SOURCE: no client is blocked or rate-limited
 * here. A caller either runs, waits its turn, shares an identical read already
 * running, or is refused fast with a retryable error and a Retry-After hint.
 *
 * Invariant (read this before treating it as shared state): at most
 * `SOURCE_RUNS_PER_CONNECTION` live source runs per connection ON THIS
 * REPLICA, so the cluster total is at most that times the replica count. It is
 * a local guard on this process's own runs. No replica has to agree with
 * another, which is why process memory, not Postgres, is the right home.
 *
 * - Public visitors may hold at most one slot fewer than the limit, and
 *   members, MCP clients and Automations are dequeued first, so a crawler never
 *   starves a member.
 * - Waiting is bounded: a full queue or a deadline too close to run refuses at
 *   once, and a waiter leaves at its deadline minus the run budget or on abort.
 *   Nobody queues past the point where its run could still finish.
 * - A slot always comes back: every admitted run is bounded by the executor's
 *   hard timeout and the caller's abort signal, and the slot is released when
 *   the run settles.
 * - A run the source answered with 429 halves the connection's limit here
 *   (floor 1); each later 30s interval without a 429 restores one slot.
 */

import { createSpan, ToolError, type ChatTurnAccess, type Span } from '@lobu/core';
import { chatAccessOfToolContext, type DeviceAccessCaller } from '../authz/device-access';
import logger from '../utils/logger';

/** Live source runs one connection may have in flight on this replica. */
const SOURCE_RUNS_PER_CONNECTION = 4;
/** Callers that may wait for a slot on one connection; the next is refused. */
const SOURCE_WAITERS_PER_CONNECTION = 32;
/** A caller with less than this left of its deadline is not worth queueing. */
export const MIN_RUN_BUDGET_MS = 2_000;
/** How long a source's 429 lowers the limit, and the pace of restoring it. */
export const RATE_LIMIT_STEP_MS = 30_000;
/** Refusals are logged at most this often, not once each during a burst. */
const REFUSAL_LOG_INTERVAL_MS = 10_000;
/** Latency assumed for the Retry-After hint before a connection has run once. */
const DEFAULT_RUN_LATENCY_MS = 1_000;
const MAX_RETRY_AFTER_SECONDS = 30;

export type SourceCallerClass = 'anonymous' | 'member';

type AdmissionOutcome = 'admitted' | 'joined' | 'refused_queue_full' | 'refused_deadline' | 'aborted';

/**
 * The admission class of a caller's access tier: a public visitor (an anonymous
 * page or REST reader, or a stranger's chat turn) or anyone else.
 */
export function sourceCallerClassOfAccess(access: ChatTurnAccess | null): SourceCallerClass {
  return access === 'public_visitor' ? 'anonymous' : 'member';
}

/** The admission class of a tool caller. */
export function sourceCallerClass(ctx: DeviceAccessCaller): SourceCallerClass {
  return sourceCallerClassOfAccess(chatAccessOfToolContext(ctx));
}

/**
 * The source was not read because this connection is at its live-read limit.
 * Retryable, and `retryAfterSeconds` estimates when the queue will have drained.
 */
export class SourceAdmissionRefusedError extends ToolError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    readonly outcome: 'refused_queue_full' | 'refused_deadline',
  ) {
    super('UPSTREAM_UNAVAILABLE', message);
  }
}

interface SourceAdmissionRequest {
  callerClass: SourceCallerClass;
  /** Absolute deadline of the caller's read. */
  deadlineAt: number;
  signal?: AbortSignal;
}

/** One admitted run. Release it exactly when the run, retries included, settled. */
export interface SourceRunSlot {
  release(outcome: { rateLimited: boolean }): void;
}

interface Waiter {
  callerClass: SourceCallerClass;
  admit: () => void;
}

interface ConnectionState {
  running: number;
  runningAnonymous: number;
  waiters: Waiter[];
  limit: number;
  /** Bumped by every halving; a 429 from a run admitted before it halves no further. */
  generation: number;
  /** When the next slot of a lowered limit comes back. */
  nextRestoreAt: number;
  avgLatencyMs: number | null;
}

interface SharedRead {
  promise: Promise<unknown>;
  participants: number;
  controller: AbortController;
  /** The run's own deadline, which its executor timeout enforces. */
  deadlineAt: number;
}

export class SourceAdmission {
  private readonly connections = new Map<number, ConnectionState>();
  private readonly reads = new Map<string, SharedRead>();
  private lastRefusalLogAt = Number.NEGATIVE_INFINITY;
  private unloggedRefusals = 0;

  constructor(
    private readonly capacity = SOURCE_RUNS_PER_CONNECTION,
    private readonly maxWaiters = SOURCE_WAITERS_PER_CONNECTION,
  ) {}

  /**
   * Run `start` once for every concurrent caller with the same `key`. A caller
   * that finds the read already running joins it and takes no slot. Each
   * participant waits under its own deadline and abort signal and receives its
   * own copy of the result; the shared run is aborted only when every
   * participant has left. The entry is dropped when the run settles.
   */
  async coalesce<T>(
    key: string,
    connectionId: number,
    participant: SourceAdmissionRequest,
    start: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    participant.signal?.throwIfAborted();
    let shared = this.reads.get(key);
    if (shared) {
      this.endSpan(this.startSpan(connectionId, participant.callerClass), 'joined', 0, this.connections.get(connectionId));
    } else {
      const controller = new AbortController();
      const read: SharedRead = {
        participants: 0, controller, promise: Promise.resolve(), deadlineAt: participant.deadlineAt,
      };
      read.promise = (async () => start(controller.signal))().finally(() => {
        if (this.reads.get(key) === read) this.reads.delete(key);
      });
      this.reads.set(key, read);
      shared = read;
    }
    const read = shared;
    read.participants += 1;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const settle = (finish: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        participant.signal?.removeEventListener('abort', onAbort);
        read.participants -= 1;
        finish();
      };
      const leave = (reason: unknown) => settle(() => {
        if (read.participants === 0) {
          // Nobody is left to receive it, and a later caller must not join a
          // run that is being aborted: it starts its own read.
          if (this.reads.get(key) === read) this.reads.delete(key);
          read.controller.abort(reason);
        }
        reject(reason);
      });
      const onAbort = () => leave(participant.signal?.reason);
      // The run ends by its own deadline; only a participant due sooner needs a timer.
      const timer = participant.deadlineAt < read.deadlineAt
        ? setTimeout(
          () => leave(Object.assign(new Error('source read timed out at the caller deadline'), { exitReason: 'timeout' as const })),
          Math.max(0, participant.deadlineAt - Date.now()),
        )
        : undefined;
      participant.signal?.addEventListener('abort', onAbort, { once: true });
      read.promise.then(
        (value) => settle(() => resolve(structuredClone(value) as T)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  /** Take a run slot on `connectionId`, waiting for one when the connection is full. */
  async acquire(connectionId: number, request: SourceAdmissionRequest): Promise<SourceRunSlot> {
    const startedAt = Date.now();
    const span = this.startSpan(connectionId, request.callerClass);
    const state = this.state(connectionId);
    try {
      request.signal?.throwIfAborted();
      this.pump(state);
      if (this.canRun(state, request.callerClass)) {
        this.take(state, request.callerClass);
      } else {
        if (state.waiters.length >= this.maxWaiters) throw this.refuse(connectionId, state, 'refused_queue_full');
        const waitMs = request.deadlineAt - MIN_RUN_BUDGET_MS - Date.now();
        if (waitMs <= 0) throw this.refuse(connectionId, state, 'refused_deadline');
        await this.wait(connectionId, state, request, waitMs);
      }
    } catch (error) {
      this.endSpan(
        span,
        error instanceof SourceAdmissionRefusedError ? error.outcome : 'aborted',
        Date.now() - startedAt,
        state,
      );
      this.forgetIdle(connectionId, state);
      throw error;
    }
    this.endSpan(span, 'admitted', Date.now() - startedAt, state);
    return this.slot(connectionId, state, request.callerClass);
  }

  private state(connectionId: number): ConnectionState {
    let state = this.connections.get(connectionId);
    if (!state) {
      state = {
        running: 0,
        runningAnonymous: 0,
        waiters: [],
        limit: this.capacity,
        generation: 0,
        nextRestoreAt: 0,
        avgLatencyMs: null,
      };
      this.connections.set(connectionId, state);
    }
    return state;
  }

  /** Drop a connection's state once nothing runs, waits, or is throttled on it. */
  private forgetIdle(connectionId: number, state: ConnectionState): void {
    if (state.running === 0 && state.waiters.length === 0 && state.limit === this.capacity) {
      if (this.connections.get(connectionId) === state) this.connections.delete(connectionId);
    }
  }

  private anonymousLimit(state: ConnectionState): number {
    return Math.max(1, state.limit - 1);
  }

  private canRun(state: ConnectionState, callerClass: SourceCallerClass): boolean {
    return state.running < state.limit
      && (callerClass === 'member' || state.runningAnonymous < this.anonymousLimit(state));
  }

  private take(state: ConnectionState, callerClass: SourceCallerClass): void {
    state.running += 1;
    if (callerClass === 'anonymous') state.runningAnonymous += 1;
  }

  /** Restore one slot per clean interval since the last 429, then admit whoever can run. */
  private pump(state: ConnectionState): void {
    const now = Date.now();
    while (state.limit < this.capacity && now >= state.nextRestoreAt) {
      state.limit += 1;
      state.nextRestoreAt += RATE_LIMIT_STEP_MS;
    }
    for (;;) {
      if (state.running >= state.limit) return;
      let index = state.waiters.findIndex((waiter) => waiter.callerClass === 'member');
      if (index < 0 && state.runningAnonymous < this.anonymousLimit(state)) index = 0;
      const waiter = index < 0 ? undefined : state.waiters[index];
      if (!waiter) return;
      state.waiters.splice(index, 1);
      this.take(state, waiter.callerClass);
      waiter.admit();
    }
  }

  private wait(
    connectionId: number,
    state: ConnectionState,
    request: SourceAdmissionRequest,
    waitMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        callerClass: request.callerClass,
        admit: () => {
          cleanup();
          resolve();
        },
      };
      const leave = (error: unknown) => {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        state.waiters.splice(index, 1);
        cleanup();
        reject(error);
      };
      const onAbort = () => leave(request.signal?.reason);
      const timer = setTimeout(() => leave(this.refuse(connectionId, state, 'refused_deadline')), waitMs);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      state.waiters.push(waiter);
    });
  }

  private slot(connectionId: number, state: ConnectionState, callerClass: SourceCallerClass): SourceRunSlot {
    const generation = state.generation;
    const startedAt = Date.now();
    let released = false;
    return {
      release: ({ rateLimited }) => {
        if (released) return;
        released = true;
        state.running -= 1;
        if (callerClass === 'anonymous') state.runningAnonymous -= 1;
        const latencyMs = Date.now() - startedAt;
        state.avgLatencyMs = state.avgLatencyMs === null ? latencyMs : state.avgLatencyMs * 0.8 + latencyMs * 0.2;
        if (rateLimited) {
          state.nextRestoreAt = Date.now() + RATE_LIMIT_STEP_MS;
          // Concurrent runs of one burst report the same 429; halve once for them.
          if (generation === state.generation) {
            state.limit = Math.max(1, Math.floor(state.limit / 2));
            state.generation += 1;
          }
        }
        this.pump(state);
        this.forgetIdle(connectionId, state);
      },
    };
  }

  /** Seconds until the queue ahead has likely drained at the current limit. */
  private retryAfterSeconds(state: ConnectionState): number {
    const latencySeconds = (state.avgLatencyMs ?? DEFAULT_RUN_LATENCY_MS) / 1000;
    const estimate = Math.ceil((state.waiters.length * latencySeconds) / state.limit);
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, estimate));
  }

  private refuse(
    connectionId: number,
    state: ConnectionState,
    outcome: SourceAdmissionRefusedError['outcome'],
  ): SourceAdmissionRefusedError {
    const retryAfterSeconds = this.retryAfterSeconds(state);
    const now = Date.now();
    if (now - this.lastRefusalLogAt >= REFUSAL_LOG_INTERVAL_MS) {
      logger.warn({
        connectionId,
        outcome,
        running: state.running,
        waiting: state.waiters.length,
        limit: state.limit,
        refusedSinceLastLog: this.unloggedRefusals,
      }, '[source-admission] refusing live source reads at the connection limit');
      this.lastRefusalLogAt = now;
      this.unloggedRefusals = 0;
    } else {
      this.unloggedRefusals += 1;
    }
    return new SourceAdmissionRefusedError(
      outcome === 'refused_queue_full'
        ? `the source is busy (${state.running} reads running, ${state.waiters.length} waiting); retry in ${retryAfterSeconds}s`
        : `the source is busy and too little of the read deadline remains to wait; retry in ${retryAfterSeconds}s`,
      retryAfterSeconds,
      outcome,
    );
  }

  private startSpan(connectionId: number, callerClass: SourceCallerClass): Span | null {
    return createSpan('source.admission', {
      'lobu.source.connection_id': connectionId,
      'lobu.source.admission.class': callerClass,
    });
  }

  /** Close the admission span with what the caller got and what it found. */
  private endSpan(
    span: Span | null,
    outcome: AdmissionOutcome,
    waitMs: number,
    state: ConnectionState | undefined,
  ): void {
    span?.setAttributes({
      'lobu.source.admission.outcome': outcome,
      'lobu.source.admission.wait_ms': waitMs,
      'lobu.source.admission.inflight': state?.running ?? 0,
      'lobu.source.admission.queue_depth': state?.waiters.length ?? 0,
      'lobu.source.admission.limit': state?.limit ?? this.capacity,
    });
    span?.end();
  }
}

/** This replica's admission for live source reads. */
export const sourceAdmission = new SourceAdmission();
