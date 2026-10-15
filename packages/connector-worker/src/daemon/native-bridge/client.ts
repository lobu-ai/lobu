import { randomUUID } from 'node:crypto';
import type { WorkerAdvertisementSnapshot, MutableWorkerAdvertisementProvider } from '../client.js';
import {
  encodeNativeBridgeFrame,
  NativeBridgeFrameDecoder,
  NativeBridgeProtocolError,
  type NativeBridgeFrame,
  NATIVE_BRIDGE_MAX_OUTBOUND_FRAMES,
  NATIVE_BRIDGE_MAX_OUTBOUND_FRAMES_PER_RUN,
  NATIVE_BRIDGE_MAX_RETAINED_RUN_KEYS,
  NATIVE_BRIDGE_PROTOCOL,
  NATIVE_BRIDGE_PROTOCOL_VERSION,
} from './protocol.js';

const MAX_NATIVE_RUN_PAYLOAD_BYTES = 512 * 1024;
export const NATIVE_BRIDGE_HELLO_TIMEOUT_MS = 5000;

export interface NativeBridgeRunResult {
  checkpoint?: Record<string, unknown>;
  action_output?: Record<string, unknown>;
  auth_update?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeBridgeRunOptions {
  requestId?: string;
  operation: 'sync' | 'action' | 'auth' | 'read';
  job: Record<string, unknown>;
  onStream?: (payload: Record<string, unknown>, sequence: number) => Promise<void>;
}

interface PendingRun {
  requestId: string;
  runId: number;
  lastSequence: number;
  terminal: boolean;
  cancelSent: boolean;
  onStream?: NativeBridgeRunOptions['onStream'];
  resolve: (result: NativeBridgeRunResult) => void;
  reject: (error: Error) => void;
}

interface QueuedFrame {
  frame: NativeBridgeFrame;
  runKey?: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class NativeBridgeClient {
  private readonly decoder = new NativeBridgeFrameDecoder();
  private readonly writer: NativeBridgeFrameWriter;
  private readonly pending = new Map<string, PendingRun>();
  private readonly terminalRuns = new Set<string>();
  private readonly ignoredRuns = new Set<string>();
  private reading = false;
  private handshakeComplete = false;
  private handshakePromise?: Promise<void>;
  private handshakeReject?: (error: Error) => void;
  private failure?: Error;
  private readonly transportFailureHandlers = new Set<(error: Error) => void>();

  constructor(
    private readonly input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    private readonly provider: MutableWorkerAdvertisementProvider,
    private readonly expectedWorkerId: string,
    private readonly daemonBuild: string,
    private readonly handshakeTimeoutMs = NATIVE_BRIDGE_HELLO_TIMEOUT_MS,
  ) {
    this.writer = new NativeBridgeFrameWriter(output, (error) => {
      // Defer notification so the writer is fully assigned before a stream
      // that was already closed reports its terminal state.
      queueMicrotask(() => this.failBridge(error));
    });
  }

  async handshake(): Promise<void> {
    if (this.handshakeComplete) return;
    if (this.failure) throw this.failure;
    if (!this.handshakePromise) {
      this.handshakePromise = new Promise<void>((resolve, reject) => {
        this.handshakeReject = reject;
        void this.readLoop(resolve);
      });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.handshakePromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new NativeBridgeProtocolError(
              `native bridge hello timed out after ${this.handshakeTimeoutMs}ms`,
            );
            this.failBridge(error);
            reject(error);
          }, this.handshakeTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async run(options: NativeBridgeRunOptions): Promise<NativeBridgeRunResult> {
    await this.handshake();
    if (this.failure) throw this.failure;
    const runId = readPositiveInteger(options.job.run_id);
    if (runId == null) throw new Error('native bridge run is missing a valid run_id');
    const requestId = options.requestId ?? randomUUID();
    if (this.pending.has(requestId)) throw new Error(`native bridge request '${requestId}' is already active`);

    const payload = {
      operation: options.operation,
      job: sanitizeNativeJob(options.job),
    };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_NATIVE_RUN_PAYLOAD_BYTES) {
      throw new Error('native bridge run envelope exceeds its bounded payload limit');
    }

    const promise = new Promise<NativeBridgeRunResult>((resolve, reject) => {
      this.pending.set(requestId, {
        requestId,
        runId,
        lastSequence: -1,
        terminal: false,
        cancelSent: false,
        onStream: options.onStream,
        resolve,
        reject,
      });
    });
    try {
      await this.send({
        version: NATIVE_BRIDGE_PROTOCOL_VERSION,
        kind: 'run',
        request_id: requestId,
        run_id: runId,
        payload,
      }, { requestId, runKey: requestId + ':' + runId });
    } catch (error) {
      this.rejectPending(requestId, asError(error));
    }
    return promise;
  }

  async cancel(requestId: string, runId: number): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending || pending.runId !== runId || pending.terminal || pending.cancelSent) return;
    pending.cancelSent = true;
    await this.send({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'cancel',
      request_id: requestId,
      run_id: runId,
      payload: { reason: 'daemon_shutdown' },
    }, { requestId, runKey: requestId + ':' + runId });
  }

  async cancelAndAbandon(requestId: string, runId: number, error: Error): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending || pending.runId !== runId || pending.terminal) return;
    pending.cancelSent = true;
    // Reject and mark the owner ignored before attempting the cancel write.
    // The write can fail because the bounded outbound queue or transport is
    // already unavailable; late terminal frames must still be harmless in
    // that case, and the timeout error remains the owning run's result.
    this.rejectPending(requestId, error, true);
    try {
      await this.send({
        version: NATIVE_BRIDGE_PROTOCOL_VERSION,
        kind: 'cancel',
        request_id: requestId,
        run_id: runId,
        payload: { reason: 'native_bridge_timeout' },
      }, { requestId, runKey: requestId + ':' + runId });
    } catch {
      // The timeout has already terminalized the owning run. A failed cancel
      // write is transport cleanup, not a replacement error for that run.
    }
  }

  async cancelActiveRuns(): Promise<void> {
    const cancellations = [...this.pending.values()].map((pending) =>
      this.cancel(pending.requestId, pending.runId),
    );
    await Promise.allSettled(cancellations);
  }

  /**
   * Tell the app how many runs this daemon is executing. The app holds staged
   * updates while any are live: work the daemon runs itself (shell commands,
   * Automations, chat) never passes through the app's own run table.
   */
  async reportActivity(activeRuns: number): Promise<void> {
    if (!this.handshakeComplete || this.failure) return;
    await this.send({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'activity',
      request_id: randomUUID(),
      payload: { active_runs: activeRuns },
    });
  }

  async shutdown(): Promise<void> {
    if (!this.handshakeComplete || this.failure) return;
    await this.send({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'shutdown',
      request_id: randomUUID(),
      payload: { reason: 'daemon_shutdown' },
    });
  }

  close(error = new NativeBridgeProtocolError('native bridge closed')): void {
    this.failBridge(error);
  }

  onTransportFailure(handler: (error: Error) => void): () => void {
    if (this.failure) {
      handler(this.failure);
      return () => undefined;
    }
    this.transportFailureHandlers.add(handler);
    return () => this.transportFailureHandlers.delete(handler);
  }

  get activeRunCount(): number {
    return this.pending.size;
  }

  private async readLoop(resolveHandshake: () => void): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      for await (const raw of this.input as AsyncIterable<Buffer | string>) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const frames = this.decoder.append(chunk);
        for (const frame of frames) await this.receive(frame, resolveHandshake);
      }
      this.decoder.finish();
      throw new NativeBridgeProtocolError('native bridge app EOF');
    } catch (error) {
      const failure = asError(error);
      this.failBridge(failure);
    } finally {
      this.reading = false;
    }
  }

  private async receive(
    frame: NativeBridgeFrame,
    resolveHandshake: () => void,
  ): Promise<void> {
    if (!this.handshakeComplete) {
      if (frame.kind !== 'hello') {
        throw new NativeBridgeProtocolError('native bridge requires hello before any other frame');
      }
      try {
        const hello = parseHello(frame.payload);
        if (hello.worker_id !== this.expectedWorkerId) {
          throw new NativeBridgeProtocolError('native bridge hello worker_id does not match launch identity');
        }
        if (hello.daemon_build !== this.daemonBuild) {
          throw new NativeBridgeProtocolError('native bridge hello daemon_build does not match the launched daemon');
        }
        const snapshot: WorkerAdvertisementSnapshot = {
          capabilities: hello.capabilities,
          manifests: hello.connector_manifests,
          // Legacy hello frames predate generation. Advance the seeded
          // snapshot so the first real advertisement can replace it.
          generation: hello.generation ?? this.provider.snapshot().generation + 1,
        };
        this.provider.update(snapshot);
        await this.send({
          version: NATIVE_BRIDGE_PROTOCOL_VERSION,
          kind: 'hello_ack',
          request_id: frame.request_id,
          payload: {
            protocol: NATIVE_BRIDGE_PROTOCOL,
            protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
            daemon_build: this.daemonBuild,
            app_build: hello.app_build,
            worker_id: hello.worker_id,
            nonce: hello.nonce,
            capability_generation: snapshot.generation,
          },
        });
        this.handshakeComplete = true;
        resolveHandshake();
      } catch (error) {
        const failure = asError(error);
        this.failBridge(failure);
        throw failure;
      }
      return;
    }

    if (frame.kind === 'capabilities') {
      const generation = readNonNegativeInteger(frame.payload.generation);
      if (generation == null) throw new NativeBridgeProtocolError('capabilities frame is missing generation');
      this.provider.update({
        capabilities: readCapabilities(frame.payload.capabilities),
        manifests: readManifests(frame.payload.connector_manifests),
        generation,
      });
      return;
    }
    if (frame.kind === 'ping') {
      await this.send({
        version: NATIVE_BRIDGE_PROTOCOL_VERSION,
        kind: 'ping',
        request_id: frame.request_id,
        payload: { ok: true },
      });
      return;
    }
    if (frame.kind === 'diagnostic' || frame.kind === 'hello_ack') return;

    const pending = this.pending.get(frame.request_id);
    if (!pending) {
      const runKey = `${frame.request_id}:${frame.run_id ?? ''}`;
      if (this.ignoredRuns.has(runKey)) return;
      if (this.terminalRuns.has(runKey)) {
        if (frame.kind === 'complete' || frame.kind === 'failed') {
          throw new NativeBridgeProtocolError('native bridge emitted more than one terminal frame');
        }
        if (frame.kind === 'cancel') return;
      }
      throw new NativeBridgeProtocolError(`native bridge frame has no active owner '${frame.request_id}'`);
    }
    if (frame.run_id !== pending.runId) {
      throw new NativeBridgeProtocolError('native bridge frame run_id does not match request owner');
    }
    if (frame.sequence !== undefined) {
      if (frame.sequence <= pending.lastSequence) {
        throw new NativeBridgeProtocolError('native bridge request sequence is not monotonic');
      }
      pending.lastSequence = frame.sequence;
    }
    if (frame.kind === 'stream') {
      if (frame.sequence == null) {
        throw new NativeBridgeProtocolError('native bridge stream frame is missing sequence');
      }
      try {
        await pending.onStream?.(frame.payload, frame.sequence);
      } catch (error) {
        const failure = asError(error);
        try {
          await this.cancel(frame.request_id, pending.runId);
        } catch {
          // Best-effort cancellation; the owning run still fails locally.
        }
        this.rejectPending(frame.request_id, failure, true);
      }
      return;
    }
    if (frame.kind === 'cancel') return;
    if (frame.kind !== 'complete' && frame.kind !== 'failed') {
      throw new NativeBridgeProtocolError(`unexpected native bridge frame '${frame.kind}' for a run`);
    }
    if (pending.terminal) throw new NativeBridgeProtocolError('native bridge emitted more than one terminal frame');
    pending.terminal = true;
    this.pending.delete(frame.request_id);
    this.terminalRuns.add(`${frame.request_id}:${pending.runId}`);
    if (this.terminalRuns.size > NATIVE_BRIDGE_MAX_RETAINED_RUN_KEYS) {
      const oldest = this.terminalRuns.values().next().value;
      if (oldest) this.terminalRuns.delete(oldest);
    }
    if (frame.kind === 'failed') {
      pending.reject(new Error(readErrorMessage(frame.payload)));
    } else {
      pending.resolve(parseRunResult(frame.payload));
    }
  }

  private async send(
    frame: NativeBridgeFrame,
    owner?: { requestId: string; runKey: string },
  ): Promise<void> {
    if (this.failure) throw this.failure;
    try {
      await this.writer.enqueue(frame, owner?.runKey);
    } catch (error) {
      if (owner) this.rejectPending(owner.requestId, asError(error));
      throw error;
    }
  }

  private rejectPending(requestId: string, error: Error, ignoreFutureFrames = false): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    pending.terminal = true;
    this.pending.delete(requestId);
    if (ignoreFutureFrames) {
      const runKey = `${requestId}:${pending.runId}`;
      this.ignoredRuns.add(runKey);
      if (this.ignoredRuns.size > NATIVE_BRIDGE_MAX_RETAINED_RUN_KEYS) {
        const oldest = this.ignoredRuns.values().next().value;
        if (oldest) this.ignoredRuns.delete(oldest);
      }
    }
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      pending.terminal = true;
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private failBridge(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.writer.fail(error);
    this.failAll(error);
    this.handshakeReject?.(error);
    for (const handler of this.transportFailureHandlers) handler(error);
    this.transportFailureHandlers.clear();
  }
}

class NativeBridgeFrameWriter {
  private readonly queue: QueuedFrame[] = [];
  private readonly perRun = new Map<string, number>();
  private writing = false;
  private failed?: Error;
  private active?: QueuedFrame;

  constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly onFailure: (error: Error) => void,
  ) {
    output.on('error', (error) => {
      this.fail(asError(error));
    });
    output.on('close', () => {
      this.fail(new NativeBridgeProtocolError('native bridge output closed'));
    });
    output.on('finish', () => {
      this.fail(new NativeBridgeProtocolError('native bridge output finished'));
    });
    output.on('end', () => {
      this.fail(new NativeBridgeProtocolError('native bridge output reached EOF'));
    });
    const state = output as NodeJS.WritableStream & {
      closed?: boolean;
      destroyed?: boolean;
      writableEnded?: boolean;
      writableFinished?: boolean;
    };
    if (state.closed || state.destroyed || state.writableEnded || state.writableFinished) {
      this.fail(new NativeBridgeProtocolError('native bridge output is already closed'));
    }
  }

  fail(error: Error): void {
    if (!this.failed) {
      this.failed = error;
      this.onFailure(error);
    }
    this.active?.reject(this.failed);
    this.active = undefined;
    for (const queued of this.queue.splice(0)) queued.reject(this.failed);
    this.perRun.clear();
  }

  enqueue(frame: NativeBridgeFrame, runKey?: string): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    const runCount = runKey ? this.perRun.get(runKey) ?? 0 : 0;
    if (this.queue.length >= NATIVE_BRIDGE_MAX_OUTBOUND_FRAMES || runCount >= NATIVE_BRIDGE_MAX_OUTBOUND_FRAMES_PER_RUN) {
      return Promise.reject(new Error('native bridge outbound queue exceeded its bound'));
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ frame, runKey, resolve, reject });
      if (runKey) this.perRun.set(runKey, runCount + 1);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const queued = this.queue.shift()!;
        this.active = queued;
        if (queued.runKey) {
          const count = this.perRun.get(queued.runKey) ?? 1;
          if (count <= 1) this.perRun.delete(queued.runKey);
          else this.perRun.set(queued.runKey, count - 1);
        }
        const encoded = encodeNativeBridgeFrame(queued.frame);
        const accepted = this.output.write(encoded);
        if (!accepted) await this.waitForDrain();
        queued.resolve();
        this.active = undefined;
      }
    } catch (error) {
      const failure = asError(error);
      this.fail(failure);
    } finally {
      this.writing = false;
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(asError(error));
      };
      const onTerminal = (message: string) => {
        cleanup();
        reject(new NativeBridgeProtocolError(message));
      };
      const cleanup = () => {
        this.output.off('drain', onDrain);
        this.output.off('error', onError);
        this.output.off('close', onClose);
        this.output.off('finish', onFinish);
        this.output.off('end', onEnd);
      };
      const onClose = () => onTerminal('native bridge output closed while draining');
      const onFinish = () => onTerminal('native bridge output finished while draining');
      const onEnd = () => onTerminal('native bridge output reached EOF while draining');
      this.output.once('drain', onDrain);
      this.output.once('error', onError);
      this.output.once('close', onClose);
      this.output.once('finish', onFinish);
      this.output.once('end', onEnd);
    });
  }
}

function parseHello(payload: Record<string, unknown>): {
  app_build: string;
  daemon_build: string;
  worker_id: string;
  nonce: string;
  capabilities: Record<string, boolean>;
  connector_manifests: unknown[];
  generation?: number;
} {
  const appBuild = readNonEmptyString(payload.app_build, 'hello.app_build');
  const daemonBuild = readNonEmptyString(payload.daemon_build, 'hello.daemon_build');
  const workerId = readNonEmptyString(payload.worker_id, 'hello.worker_id');
  const nonce = readNonEmptyString(payload.nonce, 'hello.nonce');
  const protocolVersion = readNonNegativeInteger(payload.protocol_version);
  if (protocolVersion !== NATIVE_BRIDGE_PROTOCOL_VERSION) {
    throw new NativeBridgeProtocolError('hello protocol_version does not match the frame version');
  }
  if (payload.protocol !== NATIVE_BRIDGE_PROTOCOL) {
    throw new NativeBridgeProtocolError('hello protocol does not match the native bridge protocol');
  }
  return {
    app_build: appBuild,
    daemon_build: daemonBuild,
    worker_id: workerId,
    nonce,
    capabilities: readCapabilities(payload.capabilities),
    connector_manifests: readManifests(payload.connector_manifests),
    generation:
      readNonNegativeInteger(payload.generation) ??
      readNonNegativeInteger(payload.capability_generation),
  };
}

function sanitizeNativeJob(job: Record<string, unknown>): Record<string, unknown> {
  const forbidden = /(?:credential|password|secret|token|access[_-]?key|auth[_-]?profile|(?:^|[_-])pat(?:$|[_-]))/i;
  const sanitize = (value: unknown, key?: string): unknown => {
    if (key && (forbidden.test(key) || key === 'compiled_code')) return undefined;
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .map(([entryKey, entry]) => [entryKey, sanitize(entry, entryKey)] as const)
          .filter(([, entry]) => entry !== undefined),
      );
    }
    return value;
  };
  return sanitize(job) as Record<string, unknown>;
}

function parseRunResult(payload: Record<string, unknown>): NativeBridgeRunResult {
  return {
    checkpoint: optionalRecord(payload.checkpoint),
    action_output: optionalRecord(payload.action_output),
    auth_update: optionalRecord(payload.auth_update),
    credentials: optionalRecord(payload.credentials),
    metadata: optionalRecord(payload.metadata),
  };
}

function readCapabilities(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) throw new NativeBridgeProtocolError('native bridge capabilities must be an object');
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'boolean') throw new NativeBridgeProtocolError(`native bridge capability '${key}' is not boolean`);
    result[key] = entry;
  }
  return result;
}

function readManifests(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new NativeBridgeProtocolError('native bridge connector_manifests must be an array');
  return [...value];
}

function readErrorMessage(payload: Record<string, unknown>): string {
  return typeof payload.error_message === 'string' && payload.error_message.trim()
    ? payload.error_message
    : 'native bridge run failed';
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new NativeBridgeProtocolError(`${field} is required`);
  return value;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
