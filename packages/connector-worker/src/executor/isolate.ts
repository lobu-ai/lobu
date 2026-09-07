/**
 * Isolate Executor
 *
 * Runs a compiled pure-JS connector bundle inside a V8 isolate in the worker
 * process (`isolated-vm`), speaking the `SyncExecutor` contract: `ExecutorJob`
 * in, `ExecutorResult` out, SDK context calls mapped onto `ExecutionHooks`.
 * Unlike the forked child this replaced, the connector gets no filesystem and
 * no module loader, and it opens nothing itself: every effect crosses the
 * boundary as a named host capability, so the host owns the network. Both
 * network capabilities dial through the one egress module: `fetch` (domain
 * allowlist from `@lobu/connector-sdk/egress-policy`, DNS pinning from
 * `@lobu/connector-worker/egress`; the response body streams back to the
 * guest one chunk per `fetchRead`, under a byte cap) and `socketOpen` (the
 * WinterCG `connect` the DB connectors need: a real TCP socket the HOST dials
 * at an address the same transport resolved and validated under the DB egress
 * policy). The job's OAuth access token does not cross into the guest either:
 * it is replaced by a per-run placeholder (`../egress/credentials.ts`) that the
 * host swaps back into the request header at `fetch`, once the egress decision
 * has admitted the destination. The run's other secret channels (`config`,
 * `sessionState`, `previousCredentials`) are not behind that vault yet.
 *
 * This is the only executor `executor/select.ts` builds; a bundle that still
 * requires a Node builtin is rejected before any isolate work with
 * `IsolateLaneIneligibleError`.
 */

import net from 'node:net';
import tls from 'node:tls';
import type { EventEnvelope } from '@lobu/connector-sdk';
import { decideEgress } from '@lobu/connector-sdk/egress-policy';
import { type EgressAddressPolicy, isReservedIp, stripIpv6Brackets } from '@lobu/connector-sdk/ip-reachability';
import { normalizeDomainPattern } from '@lobu/core';
import { CredentialVault } from '../egress/credentials.js';
import {
  EgressDispatcher,
  fetchPublicUrl,
  MalformedHostError,
  parseExemptHosts,
  PrivateAddressError,
  type ResolveAllAddresses,
  resolveEgressAddresses,
} from '../egress/transport.js';
import { IsolateHost, IsolateHostError, type IsolateTerminalState } from '../isolate/bridge.js';
import { assertIsolateEligible } from '../isolate/eligibility.js';
import type { IsolatedVm } from '../isolate/ivm-types.js';
import { isolatedVmUnavailableReason, loadIsolatedVm } from '../isolate/load.js';
import type { AgentTurnEvent } from '../agent-turn/types.js';
import { buildConnectorConfig } from './connector-config.js';
import type {
  ExecutionHooks,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from './interface.js';
import { redactOutput } from './redact.js';
import { RingBuffer, ConnectorExecutionError } from './interface.js';

export type IsolateLogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';

export interface IsolateExecutorOptions {
  /** Wall-clock budget in ms (default 600000 = 10 minutes); `0` disables it. */
  timeoutMs: number;
  /** V8 heap limit in MB (default 512, matching the process lane's old space). */
  memoryMb: number;
  /** Cap on any single message crossing the boundary (default 16 MiB). */
  messageBytes: number;
  /**
   * Cap on the bytes one fetched response body may deliver to the guest
   * (default 16 MiB). Enforced as the guest pulls: the body stream errors
   * with `FetchBodyLimitExceeded` at the chunk that crosses it.
   */
  fetchBodyBytes: number;
  /** Cap on total console output forwarded per run (default 1 MiB). */
  logBytes: number;
  /**
   * Hosts the connector may reach, in the shared egress grammar
   * (`@lobu/connector-sdk/egress-policy`): `example.com` exact,
   * `.example.com` / `*.example.com` the apex and every subdomain, `*`
   * unrestricted. The default is `['*']`: the process lane this replaced had
   * no allowlist, so closing egress by default would take every connector
   * offline rather than preserve a boundary that never existed, and nothing on
   * the wire populates this yet. An EMPTY list denies everything, exactly as
   * it does for every other consumer of the grammar. For `fetch`, reserved and
   * internal addresses are refused under every list except where an EXACT
   * entry names one: `localhost` or `127.0.0.1` is how a self-hosted install
   * reaches its own services and how the fixture suites reach a loopback
   * server; even that exemption keeps cloud metadata refused. Raw sockets do
   * NOT inherit it: a DB socket's address policy is `LOBU_DB_EGRESS_POLICY`
   * plus the operator's `LOBU_DB_EGRESS_ALLOW_HOSTS`, so this list can only
   * ever narrow what a run reaches, never widen the DB boundary.
   */
  allowedDomains: readonly string[];
  /** Where redacted console lines, the lane's egress refusals and its credential spends go (default: the worker's stdout/stderr). */
  logSink: (level: IsolateLogLevel, line: string) => void;
  /**
   * Name resolution for host-dialled sockets and `fetch`. The egress
   * transport's system resolver by default; tests inject one to stage a
   * dual-stack host without touching DNS.
   */
  lookup?: ResolveAllAddresses;
}

const MIB = 1024 * 1024;

const DEFAULT_OPTIONS: IsolateExecutorOptions = {
  timeoutMs: 600_000,
  memoryMb: 512,
  messageBytes: 16 * MIB,
  fetchBodyBytes: 16 * MIB,
  logBytes: MIB,
  allowedDomains: ['*'],
  logSink: (level, line) => {
    const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
    stream.write(`[isolate] ${line}\n`);
  },
};

const STREAM_TAIL_CAP_BYTES = 16 * 1024;
const MAX_REDIRECTS = 20;
/**
 * Responses one run may hold open at once (headers delivered, body not yet
 * drained or cancelled). Each pins an upstream socket and a reader on the
 * host until the guest reads it to the end, cancels it, or the run ends, so
 * the count is bounded here rather than by a guest that fetches and never
 * reads; an honest connector drains or cancels every body it opens.
 */
const MAX_OPEN_FETCHES = 1024;

/** Thrown when a job demands the isolate lane on a host that cannot run one. */
export class IsolateRuntimeUnavailableError extends Error {
  constructor(reason: string | null) {
    const runtime = typeof (process.versions as { bun?: string }).bun === 'string'
      ? `Bun ${process.versions.bun}`
      : `Node ${process.versions.node}`;
    super(
      `isolate lane required but isolated-vm is unavailable on this worker (${runtime})` +
        (reason ? `: ${reason}` : ': the native addon failed to load')
    );
    this.name = 'IsolateRuntimeUnavailableError';
  }
}

interface GuestErrorDescription {
  name?: string;
  message?: string;
  stack?: string;
  httpStatus?: number;
}

type GuestOutcome =
  | { ok: true; result: ExecutorResult }
  | { ok: false; error: GuestErrorDescription };

interface GuestFetchRequest {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  redirect: 'follow' | 'manual' | 'error';
}

/** What `fetchOpen` answers once the headers are in. */
interface HostFetchReply {
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: [string, string][];
  /** Whether a body follows: the guest pulls it through `fetchRead` under the request's own id. False for a body-less response (204, 304, HEAD). */
  hasBody: boolean;
}

/** The upstream response as `hostFetch` hands it to the capability layer: headers now, body still on the wire. */
interface HostFetchResponse extends Omit<HostFetchReply, 'hasBody'> {
  body: ReadableStream<Uint8Array> | null;
}

/** One `fetchRead` answer: a chunk, the end of the body, or the error that ended it. */
interface HostFetchChunk {
  data: Uint8Array | null;
  done: boolean;
  error?: { name: string; message: string };
}

function describeBodyError(error: unknown): NonNullable<HostFetchChunk['error']> {
  if (error instanceof Error) return { name: error.name || 'Error', message: error.message };
  return { name: 'Error', message: String(error) };
}

/**
 * The guest's `executeConnectorRuntime`: mode dispatch, context shapes, and
 * result/error envelopes for a connector run. Runs after the prelude and the
 * connector bundle in one script; its final expression is the promise the host
 * awaits.
 */
const GUEST_RUNNER = String.raw`
(async function () {
  var H = globalThis.__lobuHost;
  var job = JSON.parse(__job_json);
  var mergedConfig = JSON.parse(__config_json);
  var EVENT_CHUNK_SIZE = 100;

  function isConnectorRuntimeClass(val) {
    return typeof val === 'function' && !!(val.prototype && val.prototype.sync) && !!(val.prototype && val.prototype.execute);
  }
  function findRuntimeClass(mod) {
    if (!mod || typeof mod !== 'object') return null;
    var values = Object.values(mod);
    for (var i = 0; i < values.length; i++) if (isConnectorRuntimeClass(values[i])) return values[i];
    if (isConnectorRuntimeClass(mod.default)) return mod.default;
    return null;
  }

  function chromeDispatcher() {
    return {
      dispatch: function (actionKey, actionInput) {
        return H.async('dispatchChromeAction', String(actionKey), JSON.stringify(actionInput === undefined ? {} : actionInput)).then(function (json) {
          return json ? JSON.parse(json) : {};
        });
      }
    };
  }

  function withDispatcher(sessionState) {
    var out = Object.assign({}, sessionState || {});
    out.chrome_dispatcher = chromeDispatcher();
    return out;
  }

  async function emitEvents(events) {
    for (var index = 0; index < events.length; index += EVENT_CHUNK_SIZE) {
      await H.async('emitEvents', JSON.stringify(events.slice(index, index + EVENT_CHUNK_SIZE)));
    }
  }

  async function updateCheckpoint(checkpoint) {
    await H.async('updateCheckpoint', JSON.stringify(checkpoint === undefined ? null : checkpoint));
  }

  async function executeConnectorRuntime(instance) {
    if (job.mode === 'authenticate') {
      var authController = new AbortController();
      var authResult = await instance.authenticate({
        config: job.config,
        previousCredentials: job.previousCredentials,
        emit: async function (artifact) {
          await H.async('emitAuthArtifact', JSON.stringify(artifact === undefined ? {} : artifact));
        },
        awaitSignal: function (name, options) {
          var timeoutMs = options && typeof options.timeoutMs === 'number' ? options.timeoutMs : null;
          return H.async('awaitAuthSignal', String(name), timeoutMs).then(function (json) { return json ? JSON.parse(json) : {}; });
        },
        signal: authController.signal
      });
      if (!authResult || !authResult.credentials) throw new Error('authenticate() returned no credentials');
      return { mode: 'authenticate', auth: { credentials: authResult.credentials, metadata: authResult.metadata } };
    }

    if (job.mode === 'action') {
      var actionResult = await instance.execute({
        actionKey: job.actionKey,
        input: job.actionInput,
        sessionState: withDispatcher(job.sessionState),
        credentials: job.credentials,
        config: mergedConfig
      });
      if (!actionResult || !actionResult.success) {
        throw new Error((actionResult && actionResult.error) || ("Action '" + job.actionKey + "' failed"));
      }
      return { mode: 'action', output: actionResult.output || {} };
    }

    if (job.mode === 'webhook_register') {
      var registration = await instance.registerWebhook({
        config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState, callbackUrl: job.callbackUrl
      });
      if (!registration || !registration.externalId) throw new Error('registerWebhook() returned no externalId');
      var webhookScheme = (instance.definition && instance.definition.webhook) || null;
      return { mode: 'webhook_register', registration: registration, webhookScheme: webhookScheme };
    }

    if (job.mode === 'webhook_unregister') {
      await instance.unregisterWebhook({
        config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState, externalId: job.externalId
      });
      return { mode: 'webhook_unregister' };
    }

    if (job.mode === 'query') {
      var queryResult = await instance.query({
        query: job.query, config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState,
        limit: job.limit, offset: job.offset, sort: job.sort
      });
      return { mode: 'query', rows: (queryResult && queryResult.rows) || [], columns: queryResult && queryResult.columns, total: queryResult && queryResult.total };
    }

    if (job.mode === 'read') {
      var readResult = await instance.read({
        feedId: job.feedId === null ? undefined : job.feedId, feedKey: job.feedKey, query: job.query, cursor: job.cursor,
        config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState,
        limit: job.limit, offset: job.offset, sort: job.sort
      });
      return {
        mode: 'read', rows: (readResult && readResult.rows) || [], columns: readResult && readResult.columns,
        total: readResult && readResult.total, nextCursor: readResult && readResult.nextCursor, hasMore: readResult && readResult.hasMore
      };
    }

    var syncResult = await instance.sync({
      feedKey: job.feedKey,
      feedId: job.feedId,
      config: mergedConfig,
      checkpoint: job.checkpoint,
      credentials: job.credentials,
      entityIds: job.entityIds,
      sessionState: withDispatcher(job.sessionState),
      emitEvents: emitEvents,
      updateCheckpoint: updateCheckpoint
    });
    var trailingEvents = syncResult && Array.isArray(syncResult.events) ? syncResult.events : [];
    await emitEvents(trailingEvents);
    var meta = (syncResult && syncResult.metadata) || {};
    return {
      mode: 'sync',
      checkpoint: syncResult && syncResult.checkpoint !== undefined ? syncResult.checkpoint : null,
      auth_update: syncResult && syncResult.auth_update !== undefined ? syncResult.auth_update : null,
      metadata: Object.assign({
        items_found: typeof meta.items_found === 'number' ? meta.items_found : trailingEvents.length,
        items_skipped: typeof meta.items_skipped === 'number' ? meta.items_skipped : 0
      }, meta)
    };
  }

  // An agent turn does not duck-type a connector class: the bundle is Lobu's
  // own agent-session guest and exports one entry point.
  async function executeAgentTurn(mod) {
    if (!mod || typeof mod.runAgentTurn !== 'function') {
      throw new Error('the agent guest bundle does not export runAgentTurn()');
    }
    // The provider key reaches the guest here and nowhere else: the host has
    // already replaced it with this run's vault placeholder.
    var turnInput = Object.assign({}, job.turn, {
      provider: Object.assign({}, job.turn.provider, {
        apiKey: job.credentials ? job.credentials.accessToken : undefined
      })
    });
    var output = await mod.runAgentTurn(turnInput, function (event) {
      // Fire-and-forget on purpose: a delta must not stall the token stream
      // waiting for the host, and the host reports its own hook failures by
      // terminating the run.
      H.async('emitTurnEvent', JSON.stringify(event));
    }, function () {
      // Synchronous: pi drains steering between model calls, and the answer
      // is whatever the host has parked by then.
      return JSON.parse(H.sync('takeSteering'));
    }, function (request) {
      // A sandbox-pinned conversation's bash: the host runs it remotely.
      return H.async('runtimeExec', JSON.stringify(request)).then(function (json) { return JSON.parse(json); });
    });
    return { mode: 'agent_turn', turn: output };
  }

  try {
    if (job.mode === 'agent_turn') {
      var turnResult = await executeAgentTurn(module.exports);
      return JSON.stringify({ ok: true, result: turnResult });
    }
    var RuntimeClass = findRuntimeClass(module.exports);
    if (!RuntimeClass) throw new Error('No ConnectorRuntime class found. Expected a class with sync() and execute() methods.');
    var instance = new RuntimeClass();
    var result = await executeConnectorRuntime(instance);
    return JSON.stringify({ ok: true, result: result });
  } catch (error) {
    return JSON.stringify({ ok: false, error: H.describeError(error) });
  }
})()
`;

function jsonLiteral(value: unknown): string {
  // A JSON string literal is a valid JS string literal once U+2028/U+2029 are escaped.
  return JSON.stringify(JSON.stringify(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function parseGuestJson(value: unknown, what: string): unknown {
  if (typeof value !== 'string') throw new Error(`${what}: expected a JSON string from the guest, got ${typeof value}`);
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${what}: guest returned malformed JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** The run's console channel: redacted, capped by `logBytes`, and part of the tail an error report carries. */
type RunLog = (level: IsolateLogLevel, line: string) => void;

/** What one run's `fetch` capability dials and resolves with. */
interface RunNetwork {
  egress: EgressDispatcher;
  vault: CredentialVault;
  /** `placeholder\nhost` pairs already logged: one audit line per credential per host, however chatty the connector. */
  spends: Set<string>;
  log: RunLog;
}

/**
 * The job as the guest receives it: the OAuth access token behind a placeholder
 * the vault resolves at `fetch`. The gateway resolves the token per run, so the
 * host holds it only for this run and the guest never holds it at all;
 * `provider`, `expiresAt` and `scope` are bookkeeping a connector may branch on
 * and stay readable. An absent token stays absent rather than becoming a
 * (truthy) placeholder — connectors read `credentials.accessToken` as the "am I
 * authenticated" flag and pick an anonymous endpoint when it is empty.
 */
function concealCredentials(job: ExecutorJob, vault: CredentialVault): ExecutorJob {
  if (!('credentials' in job) || !job.credentials) return job;
  const { provider, accessToken, expiresAt, scope } = job.credentials;
  return {
    ...job,
    credentials: { provider, accessToken: accessToken ? vault.mint(accessToken) : accessToken, expiresAt, scope },
  };
}

/**
 * The lane's egress refusal. Named AND prefixed so a run can tell a policy
 * decision from an upstream failure whichever of the two the guest surfaces.
 * Every refusal is logged once, host-side, through the run's console budget,
 * so a connector looping on a denied host cannot write unbounded stderr.
 */
function refuse(log: RunLog, detail: string): Error {
  log('warn', `egress denied: ${detail}`);
  const denied = new Error(`EgressDenied: ${detail}`);
  denied.name = 'EgressDenied';
  return denied;
}

/** The transport refused the address; `address` is the DNS answer when the name itself was fine. */
function refusedAddress(error: unknown): string | null {
  if (error instanceof PrivateAddressError) return error.address ? ` (${error.address})` : '';
  if (error instanceof MalformedHostError) return '';
  return null;
}

/** Request headers that must not follow a redirect to another origin. */
const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Same text the guest `fetch` uses, so both rejections read alike. */
const UNSUPPORTED_SCHEME_MESSAGE = 'fetch failed: only http: and https: URLs are supported on the isolate lane';

export class IsolateExecutor implements SyncExecutor {
  private readonly options: IsolateExecutorOptions;
  /** Exact allowlist entries: `fetch`'s exemptions from the reserved-address rule (see `allowedDomains`). */
  private readonly exactAllowedHosts: readonly string[];

  constructor(options?: Partial<IsolateExecutorOptions>) {
    const merged: IsolateExecutorOptions = {
      ...DEFAULT_OPTIONS,
      ...Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => v !== undefined)),
    };
    if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a non-negative number, got ${String(merged.timeoutMs)}`);
    }
    if (!Number.isFinite(merged.memoryMb) || merged.memoryMb < 8) {
      throw new RangeError(`memoryMb must be at least 8, got ${String(merged.memoryMb)}`);
    }
    if (!Number.isFinite(merged.messageBytes) || merged.messageBytes < 1024) {
      throw new RangeError(`messageBytes must be at least 1024, got ${String(merged.messageBytes)}`);
    }
    if (!Number.isFinite(merged.fetchBodyBytes) || merged.fetchBodyBytes < 1024) {
      throw new RangeError(`fetchBodyBytes must be at least 1024, got ${String(merged.fetchBodyBytes)}`);
    }
    if (!Number.isFinite(merged.logBytes) || merged.logBytes < 1024) {
      throw new RangeError(`logBytes must be at least 1024, got ${String(merged.logBytes)}`);
    }
    // Normalized once here, the way every other producer of a pattern list
    // does at write time, so the shared matcher only ever sees canonical
    // entries. IPv6 literals lose their brackets so one spelling matches both
    // a bracketed fetch URL and a bare `connect()` host.
    const domains = merged.allowedDomains.map((entry) => stripIpv6Brackets(normalizeDomainPattern(entry)));
    if (domains.some((d) => d.length === 0)) {
      throw new RangeError('allowedDomains entries must be non-empty hosts');
    }
    merged.allowedDomains = domains;
    this.options = merged;
    this.exactAllowedHosts = domains.filter((d) => d !== '*' && !d.startsWith('.'));
  }

  /** The shared allowlist decision for both network capabilities. */
  private async assertHostAllowed(capability: 'fetch' | 'socket', hostname: string, log: RunLog): Promise<void> {
    const decision = await decideEgress({
      hostname: stripIpv6Brackets(hostname),
      global: { allowedDomains: this.options.allowedDomains, deniedDomains: [] },
    });
    if (decision.allowed) return;
    const scope =
      this.options.allowedDomains.length === 0
        ? 'this run has no allowed domains'
        : `this run may reach: ${this.options.allowedDomains.join(', ')}`;
    throw refuse(log, `${capability} to ${hostname} is not permitted (${scope})`);
  }

  private async requireIsolatedVm(): Promise<IsolatedVm> {
    const ivm = await loadIsolatedVm();
    if (!ivm) throw new IsolateRuntimeUnavailableError(isolatedVmUnavailableReason());
    return ivm;
  }

  async execute(
    compiledCode: string,
    job: ExecutorJob,
    hooks?: ExecutionHooks
  ): Promise<ExecutorResult> {
    assertIsolateEligible(compiledCode);
    const ivm = await this.requireIsolatedVm();

    const tail = new RingBuffer(STREAM_TAIL_CAP_BYTES);
    let logBytesUsed = 0;
    let logTruncated = false;
    let hookFailure: unknown = null;
    let guestFatal: GuestErrorDescription | null = null;
    // Hook invocations run one at a time, in arrival order, as the process
    // lane's IPC task chain does.
    let processingChain: Promise<void> = Promise.resolve();
    const runAbort = new AbortController();
    const pendingSleeps = new Set<ReturnType<typeof setTimeout>>();
    interface ActiveFetch {
      controller: AbortController;
      /** The upstream body once the headers have arrived; null before that and for a body-less response. */
      body: ReadableStreamDefaultReader<Uint8Array> | null;
      /** Bytes handed to the guest so far, against `fetchBodyBytes`. */
      received: number;
      url: string;
    }
    /** Every request the guest has open, keyed by its own id, from `fetchOpen` until the body ends or is aborted. */
    const activeFetches = new Map<number, ActiveFetch>();
    const closeFetch = (active: ActiveFetch) => {
      active.controller.abort();
      void active.body?.cancel().catch(() => undefined);
    };
    const closeAllFetches = () => {
      for (const active of activeFetches.values()) closeFetch(active);
      activeFetches.clear();
    };
    // The run's `fetch` transport: block-private, with the exact allowlist
    // entries lowered to the allow-private floor. One per run and destroyed
    // with it, so a worker that builds an executor per job never accumulates
    // idle keep-alive sockets.
    const egress = new EgressDispatcher({ exemptHosts: this.exactAllowedHosts, lookup: this.options.lookup });
    // The run's credential vault: the guest gets placeholders, the host keeps
    // the values and resolves them into request headers at `fetch`. Cleared
    // with the run, so a placeholder that leaks into a checkpoint or a log is
    // dead by the time anyone reads it.
    const vault = new CredentialVault();
    const guestJob = concealCredentials(job, vault);
    let host: IsolateHost | null = null;

    interface ActiveSocket {
      id: number;
      sock: net.Socket;
      chunks: string[];
      pendingReads: Array<(res: { data: string | null; done: boolean; error?: string }) => void>;
      closed: boolean;
      closeError: string | null;
    }
    let nextSocketId = 1;
    const activeSockets = new Map<number, ActiveSocket>();
    const closeAllSockets = () => {
      for (const active of activeSockets.values()) {
        try {
          active.closed = true;
          active.sock.destroy();
          while (active.pendingReads.length > 0) {
            const r = active.pendingReads.shift()!;
            r({ data: null, done: true });
          }
        } catch {
          // ignore
        }
      }
      activeSockets.clear();
    };

    const attachSocketListeners = (sock: net.Socket, active: ActiveSocket) => {
      sock.on('data', (buf: Buffer) => {
        const b64 = buf.toString('base64');
        if (active.pendingReads.length > 0) {
          const r = active.pendingReads.shift()!;
          r({ data: b64, done: false });
        } else {
          active.chunks.push(b64);
        }
      });
      sock.on('end', () => {
        active.closed = true;
        while (active.pendingReads.length > 0) {
          const r = active.pendingReads.shift()!;
          r({ data: null, done: true });
        }
      });
      sock.on('error', (err: Error) => {
        active.closed = true;
        active.closeError = err.message;
        while (active.pendingReads.length > 0) {
          const r = active.pendingReads.shift()!;
          r({ data: null, done: true, error: err.message });
        }
      });
    };

    const terminate = (state: IsolateTerminalState) => {
      runAbort.abort();
      for (const timer of pendingSleeps) clearTimeout(timer);
      pendingSleeps.clear();
      closeAllFetches();
      closeAllSockets();
      vault.clear();
      host?.terminate(state);
    };
    // A caller's abort ends the run the way an uncaught guest error does:
    // the guest is torn down and the pending result rejects with this state.
    const onCancel = () => terminate({ name: 'RunCancelled', message: 'the run was cancelled' });
    if (hooks?.signal?.aborted) onCancel();
    else hooks?.signal?.addEventListener('abort', onCancel, { once: true });

    const queueHook = (task: () => Promise<void> | void): Promise<void> => {
      const next = processingChain.then(async () => {
        await task();
      });
      // Keep the chain alive after a failure so later calls still see the
      // terminal state instead of re-running against a torn-down host.
      processingChain = next.catch(() => undefined);
      next.catch((error: unknown) => {
        if (hookFailure === null) hookFailure = error;
        terminate({ name: 'HookFailure', message: error instanceof Error ? error.message : String(error) });
      });
      return next;
    };

    const log = (level: unknown, text: unknown) => {
      const line = typeof text === 'string' ? text : String(text);
      const lvl: IsolateLogLevel =
        level === 'warn' || level === 'error' || level === 'info' || level === 'debug' ? level : 'log';
      tail.append(`${line}\n`);
      if (logTruncated) return undefined;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (logBytesUsed + bytes > this.options.logBytes) {
        logTruncated = true;
        this.options.logSink('warn', `[console output truncated: exceeded ${this.options.logBytes} bytes]`);
        return undefined;
      }
      logBytesUsed += bytes;
      this.options.logSink(lvl, redactOutput(line));
      return undefined;
    };

    const network: RunNetwork = { egress, vault, spends: new Set<string>(), log };

    const fetchOpen = async (request: unknown, body: unknown): Promise<HostFetchReply> => {
      const req = request as GuestFetchRequest;
      if (!req || typeof req !== 'object' || typeof req.url !== 'string' || typeof req.id !== 'number') {
        throw new TypeError('fetch: malformed request from guest');
      }
      if (activeFetches.has(req.id)) throw new TypeError(`fetch: request ${req.id} is already open`);
      if (activeFetches.size >= MAX_OPEN_FETCHES) {
        throw new TypeError(
          `fetch: this run has ${MAX_OPEN_FETCHES} responses open; read or cancel a body before opening another`
        );
      }
      const active: ActiveFetch = { controller: new AbortController(), body: null, received: 0, url: req.url };
      activeFetches.set(req.id, active);
      let response: HostFetchResponse;
      try {
        response = await this.hostFetch(req, body, active.controller.signal, network);
      } catch (error) {
        activeFetches.delete(req.id);
        throw error;
      }
      if (activeFetches.get(req.id) !== active) {
        // `fetchAbort` or teardown removed it while the headers were in flight.
        await response.body?.cancel().catch(() => undefined);
        const aborted = new Error('This operation was aborted');
        aborted.name = 'AbortError';
        throw aborted;
      }
      const { body: upstream, ...reply } = response;
      if (!upstream) {
        activeFetches.delete(req.id);
        return { ...reply, hasBody: false };
      }
      active.body = upstream.getReader();
      active.url = reply.url;
      return { ...reply, hasBody: true };
    };

    // One upstream chunk per call, so the host never holds more of a body
    // than the guest has asked for, and the cap is applied to what was handed
    // over rather than to a buffer nobody has read yet.
    const fetchRead = async (id: unknown): Promise<HostFetchChunk> => {
      const key = typeof id === 'number' ? id : Number.NaN;
      const active = activeFetches.get(key);
      if (!active?.body) return { data: null, done: true };
      const ended = (error?: HostFetchChunk['error']): HostFetchChunk => {
        activeFetches.delete(key);
        return error ? { data: null, done: true, error } : { data: null, done: true };
      };
      let chunk: Awaited<ReturnType<typeof active.body.read>>;
      try {
        chunk = await active.body.read();
      } catch (error) {
        // `fetchAbort` and teardown cancel the reader through the controller;
        // undici reports that here as an AbortError the guest maps back onto
        // its own signal. Anything else is the upstream failing mid-body.
        return ended(describeBodyError(error));
      }
      if (chunk.done) return ended();
      active.received += chunk.value.byteLength;
      if (active.received > this.options.fetchBodyBytes) {
        closeFetch(active);
        return ended({
          name: 'FetchBodyLimitExceeded',
          message: `fetch response body exceeded the ${this.options.fetchBodyBytes}-byte cap for ${active.url}`,
        });
      }
      return { data: chunk.value, done: false };
    };

    const mergedConfig = job.mode === 'authenticate' ? job.config : buildConnectorConfig(job);

    host = await IsolateHost.create({
      ivm,
      memoryMb: this.options.memoryMb,
      messageBytes: this.options.messageBytes,
      env: job.env,
      sync: {
        log,
        fatal: (description: unknown) => {
          const desc = (description ?? {}) as GuestErrorDescription;
          if (!guestFatal) guestFatal = desc;
          terminate({ name: 'UncaughtException', message: desc.message ?? 'uncaught exception in the connector' });
          return undefined;
        },
        // Before the headers: the request fails with the guest's abort reason.
        // After them: the body stream errors with it, and the upstream socket
        // is released either way.
        // Steering, pulled rather than pushed: the guest asks at the points pi
        // drains steering messages, so nothing has to reach into a running
        // isolate. Empty for every lane but an agent turn with a follow-up.
        takeSteering: () => JSON.stringify(hooks?.takeSteering?.() ?? []),
        fetchAbort: (id: unknown) => {
          const active = typeof id === 'number' ? activeFetches.get(id) : undefined;
          if (active) {
            activeFetches.delete(id as number);
            closeFetch(active);
          }
          return undefined;
        },
      },
      async: {
        sleep: (ms: unknown) => {
          const delay = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, 2_147_483_647) : 0;
          return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              pendingSleeps.delete(timer);
              resolve();
            }, delay);
            pendingSleeps.add(timer);
          });
        },
        emitEvents: async (json: unknown) => {
          const parsed = parseGuestJson(json, 'emitEvents');
          const events: EventEnvelope[] = Array.isArray(parsed) ? (parsed as EventEnvelope[]) : [];
          await queueHook(async () => {
            await hooks?.onEventChunk?.(events);
          });
          return undefined;
        },
        runtimeExec: async (json: unknown) => {
          if (!hooks?.onRuntimeExec) throw new Error('the remote runtime is not available in this execution context');
          const parsed = parseGuestJson(json, 'runtimeExec');
          const request = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          if (typeof request.command !== 'string') throw new Error('runtimeExec: command must be a string');
          const result = await hooks.onRuntimeExec({
            command: request.command,
            ...(typeof request.timeoutMs === 'number' ? { timeoutMs: request.timeoutMs } : {}),
          });
          return JSON.stringify(result);
        },
        emitTurnEvent: async (json: unknown) => {
          const event = parseGuestJson(json, 'emitTurnEvent') as AgentTurnEvent;
          await queueHook(async () => {
            await hooks?.onTurnEvent?.(event);
          });
          return undefined;
        },
        updateCheckpoint: async (json: unknown) => {
          const parsed = parseGuestJson(json, 'updateCheckpoint');
          const checkpoint = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
          await queueHook(async () => {
            await hooks?.onCheckpointUpdate?.(checkpoint);
          });
          return undefined;
        },
        emitAuthArtifact: async (json: unknown) => {
          const parsed = parseGuestJson(json, 'emitAuthArtifact');
          const artifact = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          await queueHook(async () => {
            await hooks?.onAuthArtifact?.(artifact);
          });
          return undefined;
        },
        awaitAuthSignal: async (name: unknown, timeoutMs: unknown) => {
          if (!hooks?.onAwaitAuthSignal) throw new Error('awaitSignal is not supported in this context');
          const signal = await hooks.onAwaitAuthSignal(String(name), {
            timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
          });
          return JSON.stringify(signal ?? {});
        },
        dispatchChromeAction: async (actionKey: unknown, inputJson: unknown) => {
          if (!hooks?.onChromeDispatch) {
            throw new Error('chrome_dispatcher is not available in this execution context (no onChromeDispatch hook)');
          }
          const parsed = parseGuestJson(inputJson, 'dispatchChromeAction');
          const input = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          const keyStr = String(actionKey);
          let timer: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(
                  `chrome_dispatcher.dispatch('${keyStr}') exceeded 120000ms; IPC may be wedged`
                )
              );
            }, 120_000);
          });
          try {
            const output = await Promise.race([
              hooks.onChromeDispatch(keyStr, input),
              timeoutPromise,
            ]);
            return JSON.stringify(output ?? {});
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        fetchOpen,
        fetchRead,
        socketOpen: async (hostParam: unknown, portParam: unknown, optionsJson: unknown) => {
          const rawHost = String(hostParam);
          const hostname = stripIpv6Brackets(rawHost);
          const port = typeof portParam === 'number' ? portParam : parseInt(String(portParam), 10);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port: ${portParam}`);
          }
          const options = (optionsJson ? parseGuestJson(optionsJson, 'socketOpen') : {}) as {
            secureTransport?: 'off' | 'on' | 'starttls';
          };

          await this.assertHostAllowed('socket', hostname, log);

          const mergedConfig = buildConnectorConfig(job);
          // The literal is a fallback for a MALFORMED job, not the shipped
          // default: both job producers always populate the key --
          // `dbEgressConfig()` (server: `feed-sync.ts`, `connector-pushdown.ts`)
          // and `resolveEffectiveEnv` (standalone daemon: `daemon/executor.ts`,
          // over `env.ts`'s worker-derived default), each
          // resolving to 'allow-private' off cloud. Verified live: a postgres
          // feed against a loopback DB syncs under EITHER literal, because the
          // key is set before it is read. So the fallback only decides a job
          // that arrived without one -- or with a misspelt value -- and this is
          // the only place the ADDRESS half of the policy is enforced on this
          // lane (`postgres.ts` applies the TLS half in the guest, which
          // cannot resolve a name), so it fails closed.
          // `||` not `??` on purpose: an empty string is absent, not a choice.
          const rawPolicy =
            (job.env?.LOBU_DB_EGRESS_POLICY as string) ||
            (mergedConfig.LOBU_DB_EGRESS_POLICY as string) ||
            'block-private';
          const policy: EgressAddressPolicy = rawPolicy === 'allow-private' ? 'allow-private' : 'block-private';
          const allowHosts = parseExemptHosts(
            job.env?.LOBU_DB_EGRESS_ALLOW_HOSTS || mergedConfig.LOBU_DB_EGRESS_ALLOW_HOSTS || '',
            'LOBU_DB_EGRESS_ALLOW_HOSTS'
          );

          // Resolve once and dial only what was validated: the transport the
          // gateway uses, with the DB policy on the address axis. Only the
          // OPERATOR's exemptions drop a host to the `allow-private` floor --
          // never below it, so metadata stays refused even for an exempted
          // host -- and the run's own allowlist is deliberately not one of
          // them: it exists to restrict reach, and a producer of it must never
          // be able to widen the DB boundary by naming `10.0.0.5`.
          let candidates: string[];
          try {
            const addresses = await resolveEgressAddresses(hostname, {
              addressPolicy: policy,
              exemptHosts: allowHosts,
              lookup: this.options.lookup,
            });
            candidates = addresses.map((a) => a.address);
          } catch (error) {
            const where = refusedAddress(error);
            if (where === null) throw error;
            throw refuse(log, `socket to ${hostname}${where} is blocked under policy ${policy}`);
          }

          const isTls = options?.secureTransport === 'on';
          const dial = (targetIp: string): Promise<net.Socket> =>
            new Promise<net.Socket>((resolve, reject) => {
              // Direct TLS keeps Node's strict default, unlike the `startTls`
              // upgrade below: that one is relaxed for postgres' BYO-CA reality
              // and nothing dials `secureTransport: 'on'` today, so there is no
              // legitimate certificate this would break.
              const sock = isTls
                ? tls.connect({ host: targetIp, port, servername: hostname })
                : net.createConnection({ host: targetIp, port });
              let settled = false;
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                sock.destroy();
                reject(new Error(`Connection to ${hostname}:${port} timed out`));
              }, 10000);
              sock.once(isTls ? 'secureConnect' : 'connect', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(sock);
              });
              sock.once('error', (err: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                sock.destroy();
                reject(err);
              });
            });

          // Dial every validated address in resolver order until one answers.
          // Node's own `net.connect(hostname)` falls back across families
          // (autoSelectFamily), so a dual-stack host whose AAAA record is
          // unreachable from this machine connected on the process lane and
          // must keep connecting here. Every candidate passed the policy
          // above, so moving to the next one never widens what the run reaches.
          let sock: net.Socket | null = null;
          let lastError: Error | null = null;
          for (const targetIp of candidates) {
            try {
              sock = await dial(targetIp);
              break;
            } catch (err) {
              lastError = err as Error;
            }
          }
          if (!sock) throw lastError ?? new Error(`Connection to ${hostname}:${port} failed`);

          const id = nextSocketId++;
          const active: ActiveSocket = {
            id,
            sock,
            chunks: [],
            pendingReads: [],
            closed: false,
            closeError: null,
          };
          activeSockets.set(id, active);
          attachSocketListeners(sock, active);
          return id;
        },
        socketRead: async (idParam: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (!active) return { data: null, done: true };
          if (active.chunks.length > 0) {
            return { data: active.chunks.shift()!, done: false };
          }
          if (active.closed) {
            return { data: null, done: true, error: active.closeError ?? undefined };
          }
          return await new Promise<{ data: string | null; done: boolean; error?: string }>((resolve) => {
            active.pendingReads.push(resolve);
          });
        },
        socketWrite: async (idParam: unknown, base64Data: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (!active || active.closed) throw new Error('Socket is closed');
          const buf = Buffer.from(String(base64Data), 'base64');
          await new Promise<void>((resolve, reject) => {
            active.sock.write(buf, (err) => (err ? reject(err) : resolve()));
          });
          return true;
        },
        socketClose: async (idParam: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (active) {
            active.closed = true;
            active.sock.destroy();
            while (active.pendingReads.length > 0) {
              const r = active.pendingReads.shift()!;
              r({ data: null, done: true });
            }
            activeSockets.delete(Number(idParam));
          }
          return true;
        },
        socketStartTls: async (idParam: unknown, optionsJson: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (!active || active.closed) throw new Error('Socket is closed');
          const opts = (optionsJson ? parseGuestJson(optionsJson, 'socketStartTls') : {}) as {
            servername?: string;
          };
          // `servername` is the ORIGINAL hostname the connector configured, not
          // the address we dialled, so SNI routing still works after the host
          // resolved the name.
          const oldSock = active.sock;
          oldSock.removeAllListeners('data');
          oldSock.removeAllListeners('end');
          oldSock.removeAllListeners('error');

          return await new Promise<boolean>((resolve, reject) => {
            const tlsSock = tls.connect({
              socket: oldSock,
              servername: opts?.servername,
              // Encrypt without verifying the chain — the same floor
              // `requiredTlsMode` documents (`connectors/src/db-egress-guard.ts`):
              // tenant databases routinely present self-signed or private-CA
              // certificates (RDS regional bundles, on-prem), and there is no
              // per-connection CA upload yet, so verifying here would hard-break
              // most legitimate BYO databases. The guest cannot raise this: the
              // WinterCG `startTls` contract carries only `servername`, so a
              // stricter mode has to arrive with CA upload, as one change.
              // Until then a connector that is ASKED to verify (postgres
              // `sslmode=verify-*`) refuses before dialling rather than
              // connecting unverified here — see `openGuardedPool` in
              // `connectors/src/postgres.ts`. Full verify+CA on this lane is a
              // guest-contract change tracked for a follow-up PR; suppress the
              // scanner here rather than dismiss the finding in the dashboard.
              // codeql[js/disabling-certificate-validation]
              rejectUnauthorized: false,
            });
            tlsSock.once('secureConnect', () => {
              active.sock = tlsSock;
              attachSocketListeners(tlsSock, active);
              resolve(true);
            });
            tlsSock.once('error', reject);
          });
        },
      },
    });

    const redactedTail = () => redactOutput(tail.toString());
    const withTail = (prefix: string) => {
      const t = redactedTail();
      return t ? `${prefix}\n[console]\n${t}` : prefix;
    };

    try {
      const source = `var __job_json = ${jsonLiteral(guestJob)};\nvar __config_json = ${jsonLiteral(mergedConfig)};\n${compiledCode}\n${GUEST_RUNNER}`;
      let raw: unknown;
      try {
        raw = await host.run(source, { timeoutMs: this.options.timeoutMs });
      } catch (error) {
        if (hookFailure !== null) throw hookFailure;
        if (guestFatal) throw this.guestError(guestFatal, redactedTail());
        if (error instanceof IsolateHostError) {
          if (error.kind === 'timeout') {
            throw new ConnectorExecutionError(withTail(`Feed execution timed out after ${this.options.timeoutMs}ms`), {
              exitCode: null,
              exitSignal: null,
              outputTail: redactedTail(),
              exitReason: 'timeout',
            });
          }
          if (error.kind === 'memory') {
            throw new ConnectorExecutionError(withTail(`Isolate out of memory (limit ${this.options.memoryMb} MB)`), {
              exitCode: null,
              exitSignal: null,
              outputTail: redactedTail(),
              exitReason: 'oom',
            });
          }
          throw new ConnectorExecutionError(withTail(error.message), {
            exitCode: null,
            exitSignal: null,
            outputTail: redactedTail(),
            exitReason: 'crash',
          }, { cause: error });
        }
        // The guest threw during module init, before the runner could catch it.
        throw this.guestError(
          error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
          redactedTail()
        );
      }
      // Wait for hooks the guest fired without awaiting (or whose promise the
      // guest dropped) before reporting the result.
      await processingChain;
      if (hookFailure !== null) throw hookFailure;
      const outcome = parseGuestJson(raw, 'result') as GuestOutcome;
      if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
        throw new Error('result: guest returned a malformed outcome envelope');
      }
      if (!outcome.ok) throw this.guestError(outcome.error ?? {}, redactedTail());
      if (!outcome.result || outcome.result.mode !== job.mode) {
        throw new Error(`result: expected mode '${job.mode}', got '${String(outcome.result?.mode)}'`);
      }
      return outcome.result;
    } finally {
      hooks?.signal?.removeEventListener('abort', onCancel);
      runAbort.abort();
      for (const timer of pendingSleeps) clearTimeout(timer);
      pendingSleeps.clear();
      closeAllFetches();
      closeAllSockets();
      vault.clear();
      void egress.destroy().catch(() => undefined);
      host.dispose();
    }
  }

  /** Build the `ConnectorExecutionError` the daemon reports for a guest-thrown error. */
  private guestError(description: GuestErrorDescription, outputTail: string): ConnectorExecutionError {
    const rawMessage = description.message ?? 'Connector reported error';
    const error = new ConnectorExecutionError(redactOutput(String(rawMessage)), {
      exitCode: null,
      exitSignal: null,
      outputTail,
      exitReason: 'error_message',
      httpStatus:
        typeof description.httpStatus === 'number' && description.httpStatus >= 100 && description.httpStatus < 600
          ? description.httpStatus
          : undefined,
    });
    error.name = description.name ? redactOutput(String(description.name)) : 'ConnectorExecutionError';
    if (description.stack) error.stack = redactOutput(String(description.stack));
    return error;
  }

  private async hostFetch(
    request: GuestFetchRequest,
    body: unknown,
    signal: AbortSignal,
    net: RunNetwork
  ): Promise<HostFetchResponse> {
    let url = new URL(request.url);
    // The guest `fetch` rejects other schemes, but `__lobuHost.async('fetchOpen')`
    // is reachable from guest code directly, and a `data:` URL has no host for
    // the allowlist to judge: Node's fetch would resolve it locally.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(UNSUPPORTED_SCHEME_MESSAGE);
    }
    let method = request.method;
    let headers = new Headers(request.headers);
    let requestBody: Uint8Array | null =
      body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : null;
    const redirectMode = request.redirect;
    let redirected = false;
    /** Headers a placeholder was resolved into: they never follow a redirect off this origin, whatever their name. */
    const credentialHeaders = new Set<string>();

    for (let hop = 0; ; hop++) {
      await this.assertHostAllowed('fetch', url.hostname, net.log);
      if (hop === 0) {
        // Placeholders resolve only now, with the destination admitted, and only
        // into a destination that may carry a credential: HTTPS, or the run's
        // own machine -- a loopback or reserved literal (or `localhost`) that the
        // allowlist names exactly, the same exemption that lets a self-hosted
        // install or a fixture reach a local service. A public name stays HTTPS
        // only even when named exactly. Real values exist in `headers` from here
        // on and nowhere the guest can read. A refusal is the lane's egress
        // refusal: logged once host-side and named so the guest can tell it
        // from an upstream failure.
        const bareHost = stripIpv6Brackets(url.hostname);
        let spent: ReturnType<CredentialVault['swapHeaders']>;
        try {
          spent = net.vault.swapHeaders(headers, url, {
            plaintextAllowed:
              this.exactAllowedHosts.includes(bareHost) && (bareHost === 'localhost' || isReservedIp(bareHost)),
          });
        } catch (error) {
          throw refuse(net.log, `fetch to ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const spend of spent) {
          credentialHeaders.add(spend.header);
          const key = `${spend.placeholder}\n${url.hostname}`;
          if (net.spends.has(key)) continue;
          net.spends.add(key);
          net.log('info', `credential ${spend.placeholder.slice(-12)} spent on ${url.hostname} in header ${spend.header}`);
        }
      }
      let response: Response;
      try {
        // The ENFORCING half of the check: a public-looking name may resolve
        // into reserved space. The transport resolves once, refuses the whole
        // answer set if any address is reserved, and pins the socket to what
        // it validated -- there is no separate pre-flight for `fetch`'s own
        // resolver to disagree with. The run's exact allowlist entries are
        // this dispatcher's exemptions (see `allowedDomains`).
        response = await fetchPublicUrl(
          url,
          {
            method,
            headers,
            body: requestBody ? new Uint8Array(requestBody) : undefined,
            signal,
            redirect: 'manual',
          },
          net.egress
        );
      } catch (error) {
        if (signal.aborted) {
          const aborted = new Error('This operation was aborted');
          aborted.name = 'AbortError';
          throw aborted;
        }
        const where = refusedAddress(error);
        if (where !== null) {
          throw refuse(
            net.log,
            `fetch to ${url.hostname}${where} is not permitted (reserved and internal hosts are never reachable)`
          );
        }
        const cause = (error as { cause?: unknown }).cause;
        throw new TypeError(`fetch failed${cause instanceof Error ? `: ${cause.message}` : ''}`);
      }
      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status <= 399 && location !== null;
      if (isRedirect && redirectMode === 'follow') {
        await response.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new TypeError('fetch failed: redirect count exceeded');
        const next = new URL(location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new TypeError('fetch failed: redirect to a non-http(s) URL');
        }
        if (next.origin !== url.origin) {
          headers = new Headers(headers);
          for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(name);
          for (const name of credentialHeaders) headers.delete(name);
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          requestBody = null;
          headers = new Headers(headers);
          for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
            headers.delete(name);
          }
        }
        url = next;
        redirected = true;
        continue;
      }
      if (isRedirect && redirectMode === 'error') {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError('fetch failed: unexpected redirect');
      }
      return {
        status: response.status,
        statusText: response.statusText,
        url: url.href,
        redirected,
        headers: [...response.headers.entries()],
        body: response.body,
      };
    }
  }
}
