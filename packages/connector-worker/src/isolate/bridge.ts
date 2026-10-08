/**
 * Host side of the connector isolate lane.
 *
 * `IsolateHost` owns one `isolated-vm` isolate: creation with a memory limit,
 * the context and its `global` self-reference, the named host capabilities the
 * guest may call, the wall-clock budget, termination and disposal. The
 * connector-specific contract (which capabilities exist and what the guest
 * runner does with them) lives in `executor/isolate.ts`; this module only
 * knows how to get a call across the boundary and back safely.
 *
 * Boundary rules, learned from probing isolated-vm 7 on Node 26:
 *  - A host function that throws (sync or async) does reach the guest, but an
 *    async rejection ALSO surfaces as an unhandled rejection in the host
 *    process. Capabilities therefore never throw across the boundary: every
 *    reply is an envelope `{ __lobu: 1, ok, value | error }` and the guest
 *    prelude rethrows.
 *  - Error names do not survive the boundary (`e.name = 'X'` arrives as
 *    `Error`), another reason to carry `{ name, message }` in the envelope.
 *  - `script.run({ timeout })` bounds only the synchronous part of the run; a
 *    loop entered after an `await` is not interrupted. The wall clock here
 *    disposes the isolate, which rejects the pending run.
 *  - Exceeding `memoryLimit` disposes the isolate automatically; the run
 *    rejects with "disposed during execution due to memory limit".
 *  - `dispose()` on a disposed isolate throws; guard with `isDisposed`.
 */

import { createPreludeHostSync, GUEST_PRELUDE } from './prelude.js';
import type { IsolatedVm, IvmIsolate, IvmReference } from './ivm-types.js';

export type HostSyncCapability = (...args: unknown[]) => unknown;
export type HostAsyncCapability = (...args: unknown[]) => Promise<unknown>;

/** Terminal state the host imposed on the run (timeout, output cap, hook failure). */
export interface IsolateTerminalState {
  name: string;
  message: string;
}

export interface IsolateHostOptions {
  ivm: IsolatedVm;
  /** V8 heap limit for the isolate, in MB. */
  memoryMb: number;
  /** Cap on any single string crossing from the guest; exceeding it terminates the run. */
  messageBytes: number;
  /** `process.env` visible to the guest. */
  env: Record<string, string | undefined>;
  /** The run's own sync capabilities; a fresh set of the prelude's host halves (`createPreludeHostSync`) is always installed too. */
  sync: Record<string, HostSyncCapability>;
  async: Record<string, HostAsyncCapability>;
}

export interface IsolateRunOptions {
  /** Wall-clock budget in ms; `0` disables the timer (interactive auth). */
  timeoutMs: number;
  /** Script name for stack traces. */
  filename?: string;
}

export type IsolateFailureKind = 'timeout' | 'memory' | 'terminated' | 'crash';

/** A run that the host, not the guest, ended. */
export class IsolateHostError extends Error {
  readonly kind: IsolateFailureKind;
  readonly terminal: IsolateTerminalState | null;

  constructor(kind: IsolateFailureKind, message: string, terminal: IsolateTerminalState | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IsolateHostError';
    this.kind = kind;
    this.terminal = terminal;
  }
}

interface Envelope {
  __lobu: 1;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; code?: unknown; httpStatus?: number };
}

function describeHostError(error: unknown): Envelope['error'] {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? `: ${cause.message}` : '';
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name || 'Error',
      message: `${error.message}${causeText}`,
      ...(code !== undefined ? { code } : {}),
      ...(typeof status === 'number' && status >= 100 && status < 600 ? { httpStatus: status } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

export class IsolateHost {
  private readonly isolate: IvmIsolate;
  private readonly context: { global: IvmReference };
  private readonly options: IsolateHostOptions;
  private readonly sync: Record<string, HostSyncCapability>;
  private terminalState: IsolateTerminalState | null = null;
  private timedOut = false;

  private constructor(isolate: IvmIsolate, context: { global: IvmReference }, options: IsolateHostOptions) {
    this.isolate = isolate;
    this.context = context;
    this.options = options;
    this.sync = { ...createPreludeHostSync(), ...options.sync };
  }

  static async create(options: IsolateHostOptions): Promise<IsolateHost> {
    if (!Number.isFinite(options.memoryMb) || options.memoryMb < 8) {
      throw new RangeError(`memoryMb must be at least 8, got ${options.memoryMb}`);
    }
    if (!Number.isFinite(options.messageBytes) || options.messageBytes < 1024) {
      throw new RangeError(`messageBytes must be at least 1024, got ${options.messageBytes}`);
    }
    const isolate = new options.ivm.Isolate({ memoryLimit: options.memoryMb });
    const host = new IsolateHost(isolate, await isolate.createContext(), options);
    try {
      await host.install();
    } catch (error) {
      host.dispose();
      throw error;
    }
    return host;
  }

  /** The state the host imposed, if it ended the run. */
  get terminal(): IsolateTerminalState | null {
    return this.terminalState;
  }

  private async install(): Promise<void> {
    const jail = this.context.global;
    await jail.set('global', jail.derefInto());
    await jail.set('__host_env_json', JSON.stringify(this.options.env));
    await jail.set(
      '__host_sync',
      new this.options.ivm.Reference((name: unknown, ...args: unknown[]) => this.dispatchSync(name, args))
    );
    await jail.set(
      '__host_async',
      new this.options.ivm.Reference((name: unknown, ...args: unknown[]) => this.dispatchAsync(name, args))
    );
  }

  private terminalEnvelope(): Envelope {
    return {
      __lobu: 1,
      ok: false,
      error: { name: this.terminalState?.name ?? 'Terminated', message: this.terminalState?.message ?? 'run terminated' },
    };
  }

  /** True when every string argument fits the per-message cap; otherwise the run is terminated. */
  private guardArgs(args: unknown[]): boolean {
    for (const arg of args) {
      if (typeof arg === 'string' && Buffer.byteLength(arg, 'utf8') > this.options.messageBytes) {
        this.terminate({
          name: 'OutputSizeExceeded',
          message: `a single bridge message exceeded ${this.options.messageBytes} bytes`,
        });
        return false;
      }
    }
    return true;
  }

  private dispatchSync(name: unknown, args: unknown[]): Envelope {
    if (this.terminalState) return this.terminalEnvelope();
    if (!this.guardArgs(args)) return this.terminalEnvelope();
    const fn = typeof name === 'string' ? this.sync[name] : undefined;
    if (!fn) {
      return { __lobu: 1, ok: false, error: { name: 'UnknownHostCapability', message: `no sync host capability '${String(name)}'` } };
    }
    try {
      return { __lobu: 1, ok: true, value: fn(...args) };
    } catch (error) {
      return { __lobu: 1, ok: false, error: describeHostError(error) };
    }
  }

  private async dispatchAsync(name: unknown, args: unknown[]): Promise<Envelope> {
    if (this.terminalState) return this.terminalEnvelope();
    if (!this.guardArgs(args)) return this.terminalEnvelope();
    const fn = typeof name === 'string' ? this.options.async[name] : undefined;
    if (!fn) {
      return { __lobu: 1, ok: false, error: { name: 'UnknownHostCapability', message: `no async host capability '${String(name)}'` } };
    }
    try {
      const value = await fn(...args);
      // The capability may have ended the run while awaiting (hook failure,
      // output cap); do not hand a value back to a guest that is being torn down.
      if (this.terminalState) return this.terminalEnvelope();
      return { __lobu: 1, ok: true, value };
    } catch (error) {
      return { __lobu: 1, ok: false, error: describeHostError(error) };
    }
  }

  /**
   * End the run from the host. Disposing the isolate is the only way to stop
   * a guest that is parked on an `await` (nothing is executing, so a
   * termination request would no-op) or looping after one (the run timeout
   * covers only the synchronous prefix). The pending `run()` rejects and is
   * reported as this terminal state.
   */
  terminate(state: IsolateTerminalState): void {
    if (this.terminalState) return;
    this.terminalState = state;
    this.dispose();
  }

  /**
   * Compile the prelude plus `source` and run it, resolving with the value of
   * the script's final expression (awaited when it is a promise, copied out).
   * Throws `IsolateHostError` when the host ended the run; any other rejection
   * is the guest's own uncaught throw during module init.
   */
  async run(source: string, options: IsolateRunOptions): Promise<unknown> {
    if (this.terminalState) throw new IsolateHostError('terminated', this.terminalState.message, this.terminalState);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        this.timedOut = true;
        this.terminate({ name: 'TimeoutError', message: `wall-clock budget of ${options.timeoutMs}ms exceeded` });
      }, options.timeoutMs);
    }
    try {
      const script = await this.isolate.compileScript(`${GUEST_PRELUDE}\n${source}`, {
        filename: options.filename ?? 'connector.js',
      });
      return await script.run(this.context, {
        promise: true,
        copy: true,
        // The host's single deadline covers compilation, synchronous work,
        // and continuations after await. A second V8 deadline at the same
        // instant races the typed termination and leaks a guest-error result.
      });
    } catch (error) {
      throw this.classifyRunFailure(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private classifyRunFailure(error: unknown): unknown {
    if (this.terminalState) {
      return new IsolateHostError(this.timedOut ? 'timeout' : 'terminated', this.terminalState.message, this.terminalState, {
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/memory limit/i.test(message)) {
      this.terminalState = { name: 'MemoryLimitExceeded', message: `isolate exceeded its ${this.options.memoryMb} MB memory limit` };
      return new IsolateHostError('memory', this.terminalState.message, this.terminalState, { cause: error });
    }
    if (/disposed|abandoned|terminated/i.test(message)) {
      return new IsolateHostError('crash', `isolate ended unexpectedly: ${message}`, null, { cause: error });
    }
    return error;
  }

  dispose(): void {
    if (this.isolate.isDisposed) return;
    try {
      this.isolate.dispose();
    } catch {
      // Already torn down by V8 (memory limit) between the check and the call.
    }
  }
}
