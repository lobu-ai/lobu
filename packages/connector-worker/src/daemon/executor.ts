/**
 * Run Executor
 *
 * Executes sync and action runs in a V8 isolate from compiled connector code.
 * Generates embeddings and streams results.
 */

import type { Env, EventEnvelope } from '@lobu/connector-sdk';
import type { AgentKind } from '@lobu/core/contracts/worker/device-automation';
import { executeAutomationRun } from './automation.js';
import {
  executeDaemonBuiltin,
  hasDaemonBuiltin,
  hasDaemonBuiltinConnector,
} from './builtins/index.js';
import { executeAgentTurnRun } from './agent-turn.js';
import { executeDeviceChatRun } from './device-chat.js';
import type { ContentItem, ExecutorClient, PollResponse } from './client.js';
import { attachedInteractiveSession, attachInteractiveSession } from './interactive-session.js';
import { log } from './log.js';
import { reportTerminalFailure } from './terminal-failure.js';
import { completeActionOnce } from './terminal-delivery.js';
import type { SyncExecutor, ExecutorResult } from '../executor/interface.js';
import { withoutDeploymentProviderKeys } from '../env.js';

/**
 * Resolve the executable compiled code for a job.
 *
 * The gateway prefers omitting `compiled_code` for fleet workers and
 * relying on this side to find + compile the source locally from
 * `connector_key`. This saves the ~13 MB inline blob in poll responses
 * (lobu#771 postmortem trail; lobu#772 perf fix). Device workers and
 * DB-only user-uploaded connectors still receive `compiled_code`
 * directly — they don't have the connector source on disk.
 *
 * Gateway and worker images have different paths to the bundled source,
 * so the gateway sends only `connector_key` and each side resolves it
 * against its own filesystem.
 *
 * Returns `{ code }` on success or `{ error }` on failure. Callers must
 * surface the error to the gateway via `client.complete*` rather than
 * throwing — the daemon-level catch only logs, leaving runs stuck
 * `running` until stale-run reaping.
 */
type JobCodeResult = { ok: true; code: string } | { ok: false; error: string };

export async function resolveJobCode(job: PollResponse): Promise<JobCodeResult> {
  if (job.compiled_code) return { ok: true, code: job.compiled_code };
  // Inline compiled jobs must not load the optional compiler/SDK graph.
  const { compileConnectorForIsolateFromFile, findBundledConnectorFile } = await import(
    '../compile-connector.js'
  );
  if (!job.connector_key) {
    return { ok: false, error: 'No compiled_code and no connector_key — gateway sent neither.' };
  }
  const localPath = findBundledConnectorFile(job.connector_key);
  if (!localPath) {
    return {
      ok: false,
      error:
        `connector_key '${job.connector_key}' did not resolve to a local source file. ` +
        `Either the connector isn't bundled in this worker image, or the key is malformed.`,
    };
  }
  try {
    // ALWAYS the isolate build: a self-contained CJS bundle with the SDK inlined
    // and Node builtins rejected. `selectExecutor` returns an IsolateExecutor
    // for every job, so compiling anything else hands the isolate a bundle it
    // cannot load -- bare imports with no module loader behind them. A retired
    // `lane` field an older gateway may still stamp is deliberately ignored:
    // there is no second lane to send the job to.
    const code = await compileConnectorForIsolateFromFile(localPath);
    return { ok: true, code };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `esbuild failed for '${job.connector_key}' (${localPath}): ${msg}` };
  }
}

/**
 * Load the executor selector and the runtime, together and on demand.
 *
 * Dynamic on purpose. A daemon whose compiler/SDK artifacts are missing or
 * broken is precisely the case the daemon builtins exist to recover, and a
 * static import here would fail this whole module at load — taking the
 * recovery path down with it. So inline-compiled jobs (which already carry
 * their code) and daemon built-in jobs never reach this graph at all; only
 * source-backed jobs do, and those need both halves anyway. The published-
 * package isolation smoke pins that: it runs both lanes with the source
 * artifacts absent.
 */
async function loadCompiledRuntime() {
  return Promise.all([
    import('../executor/select.js'),
    import('../executor/runtime.js'),
  ]);
}

type JobExecution =
  | { ok: true; code: string; executor: import('../executor/interface.js').SyncExecutor }
  | { ok: false; error: string };

/**
 * Resolve the code and the executor for a claimed run, or the reason it cannot
 * run here. The isolate is the security boundary for organization-supplied
 * code and the only executor, so a host without `isolated-vm` fails the run
 * outright; there is nothing to fall back to.
 */
async function resolveJobExecution(
  select: typeof import('../executor/select.js'),
  job: PollResponse,
  timeoutMs: number,
  customExecutor?: SyncExecutor
): Promise<JobExecution> {
  const codeResult = await resolveJobCode(job);
  if (!codeResult.ok) return codeResult;
  if (customExecutor) {
    return { ok: true, code: codeResult.code, executor: customExecutor };
  }
  try {
    const executor = await select.selectExecutor({ timeoutMs });
    return { ok: true, code: codeResult.code, executor };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ExecutorConfig {
  batchSize: number;
  heartbeatIntervalMs: number;
  /** Test-only override; production deliberately uses the 15-second default. */
  terminalHeartbeatGraceMs?: number;
  generateEmbeddings: boolean;
  timeoutMs: number;
  /** Optional executor override (tests / custom runner). */
  executor?: SyncExecutor;
  /** Daemon lifecycle signal used only by pending interactive handoffs. */
  shutdownSignal?: AbortSignal;
  /** Local agent kind used when an Automation omits agent_kind. */
  defaultAgentKind?: AgentKind;
  /**
   * Explicit per-agent binary paths for the automation arm (else PATH lookup).
   * Lets an operator point the daemon at a non-PATH CLI install, and is the
   * injection seam the automation e2e test uses to drive a fake binary.
   */
  binaryOverrides?: Partial<Record<AgentKind, string>>;
}

/**
 * What a lane runs with when its caller overrides nothing — which is what the
 * fleet entrypoint (`embedded-connector-worker.ts`) does. Exported so a test
 * can assert what a lane does under the SHIPPED configuration instead of a
 * copy of these numbers that is free to drift away from them.
 */
export const DEFAULT_CONFIG: ExecutorConfig = {
  batchSize: 10,
  heartbeatIntervalMs: 30000,
  generateEmbeddings: true,
  timeoutMs: 600000,
};

/**
 * Fold the gateway's authoritative DB egress config into the worker's env.
 *
 * The gateway (which knows cloud mode authoritatively) ships `db_egress_policy`
 * on the poll response. The worker's own `env.LOBU_DB_EGRESS_POLICY` is derived
 * from the worker process's `LOBU_CLOUD_MODE`, which a fleet worker may not have
 * set — leaving it `allow-private` and the SSRF guard silently OFF.
 *
 * We resolve the STRICTER of the two: `block-private` wins over `allow-private`
 * from either side. This makes the gateway able to *raise* the boundary (a
 * block-private gateway forces block-private even on a worker missing the flag)
 * while never letting a stale/misconfigured gateway response *downgrade* a
 * worker that already decided block-private. The result is re-asserted as
 * authoritative `job.env.LOBU_DB_EGRESS_POLICY` by `buildConnectorConfig` in the
 * child so tenant config can't override it either.
 *
 * The gateway allow-host list replaces any worker-local value. A missing list
 * means no exemptions, so a worker cannot widen the gateway's boundary.
 *
 * Deployment provider credentials (`DEPLOYMENT_PROVIDER_ENV_KEYS`) follow the
 * run's PROVENANCE: under block-private a job that arrives with `compiled_code`
 * is organization-supplied (the gateway omits the bytes for connectors the
 * image ships, so this worker compiles those from its own image), and tenant
 * code never sees the operator's provider apps. The keys stay for image-shipped
 * code, which is how a bundled Reddit feed on a shared worker authenticates.
 */
export function resolveEffectiveEnv(env: Env, job: PollResponse): Env {
  const workerPolicy = (env as Record<string, string | undefined>).LOBU_DB_EGRESS_POLICY;
  const gatewayPolicy = job.db_egress_policy;
  // block-private is the strict setting; take it if either side asks for it.
  const effective =
    workerPolicy === 'block-private' || gatewayPolicy === 'block-private'
      ? 'block-private'
      : (gatewayPolicy ?? workerPolicy ?? 'allow-private');
  const merged: Env = {
    ...env,
    LOBU_DB_EGRESS_POLICY: effective,
    LOBU_DB_EGRESS_ALLOW_HOSTS: job.db_egress_allow_hosts ?? '',
  };
  return effective === 'block-private' && job.compiled_code ? withoutDeploymentProviderKeys(merged) : merged;
}

/**
 * Execute a run (sync, action, automation, embed_backfill, or auth).
 *
 * Dispatches by `run_type` and NEVER throws: every lane reports its own
 * terminal state via the lane-appropriate `client.complete*` endpoint, and an
 * unexpected error here is likewise terminated before it can leave a claimed
 * run stuck `running` (the daemon's fire-and-forget `.catch` only logs).
 */
export async function executeRun(
  client: ExecutorClient,
  job: PollResponse,
  workerEnv: Env,
  config: Partial<ExecutorConfig> = {}
): Promise<{ itemsCollected: number; error?: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  // A connector this daemon implements itself ships no code, so any run kind
  // other than an action has nothing to fall through to: the compiled path
  // would fail with a confusing "no connector code" instead of naming the real
  // fault. Routing is decided HERE, from the local registry, never from a
  // marker the gateway sends.
  if (
    job.run_type !== 'action' &&
    job.connector_key &&
    hasDaemonBuiltinConnector(job.connector_key)
  ) {
    const message = `operation_backend_unavailable: '${job.connector_key}' implements action runs only, not '${job.run_type ?? 'unknown'}'`;
    try {
      await reportTerminalFailure(client, job, message, 'error_message');
    } catch (error) {
      log.info('[executor] Failed to reject invalid daemon built-in run:', error);
    }
    return { itemsCollected: 0, error: message };
  }
  // The inherited session rides on a non-enumerable symbol, which a spread
  // drops; re-attach it or every interactive run silently falls back to a
  // subprocess.
  const inheritedSession = attachedInteractiveSession(config);
  if (inheritedSession) attachInteractiveSession(cfg, inheritedSession);
  // Fold the gateway's authoritative egress config in once so every downstream
  // mode handler gets the same non-downgradable policy and operator exemptions.
  const env = resolveEffectiveEnv(workerEnv, job);
  try {
    switch (job.run_type) {
      case 'action':
        return await executeActionRun(client, job, env, cfg);
      case 'automation':
        // Device workers (user-scoped auth) may be handed an automation run when
        // the automation is pinned to their device. Spawn the local agent CLI and
        // report the process exit via /complete-automation. Trusted fleet workers
        // never reach this arm — the poll endpoint's automation claim branch is
        // unreachable for them — but if a run does slip through (deploy skew), the
        // dispatcher reports the failure rather than stomping the run.
        return await executeAutomationRun(client, job, cfg);
      case 'chat_message':
        return await executeDeviceChatRun(client, job, cfg);
      case 'agent_turn':
        return await executeAgentTurnRun(client, job, env, cfg);
      case 'embed_backfill':
        return await executeEmbedBackfillRun(client, job, env, cfg);
      case 'auth':
        return await executeAuthRun(client, job, env, cfg);
      default:
        return await executeSyncRun(client, job, env, cfg);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.info(
      `[executor] Unhandled ${job.run_type ?? 'unknown'} run ${job.run_id} failure:`,
      message
    );
    try {
      await reportTerminalFailure(client, job, message);
    } catch (completeErr) {
      log.info('[executor] Terminal completion after unhandled failure errored:', completeErr);
    }
    return { itemsCollected: 0, error: message };
  }
}

/**
 * Execute a sync run (feed data ingestion)
 */
async function executeSyncRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const [select, { executeCompiledConnector }] = await loadCompiledRuntime();
  const {
    run_id,
    connector_key,
    feed_key,
    feed_id,
    config: feedConfig,
    checkpoint,
    credentials,
  } = job;

  if (!run_id || !connector_key) {
    throw new Error('Invalid run: missing run_id or connector_key');
  }

  const execution = await resolveJobExecution(
    select,
    job,
    cfg.timeoutMs,
    cfg.executor
  );
  if (!execution.ok) {
    const errorMessage = `Run ${run_id} (${connector_key}): ${execution.error}`;
    log.info('[executor]', errorMessage);
    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
      items_collected: 0,
    });
    return { itemsCollected: 0, error: errorMessage };
  }
  const compiled_code = execution.code;
  const laneExecutor = execution.executor;

  log.info(`[executor] Starting sync run ${run_id} (${connector_key}/${feed_key})`);

  // Set up heartbeat interval
  let heartbeatInterval: NodeJS.Timeout | undefined;
  let itemsCollectedSoFar = 0;

  const startHeartbeat = () => {
    heartbeatInterval = setInterval(async () => {
      try {
        await client.heartbeat(run_id, {
          items_collected_so_far: itemsCollectedSoFar,
        });
      } catch (err) {
        log.debug('[executor] Heartbeat failed:', err);
      }
    }, cfg.heartbeatIntervalMs);
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
  };

  startHeartbeat();

  try {
    let batch: ContentItem[] = [];
    let lastCheckpoint = checkpoint as unknown as Record<string, unknown> | null;

    const flushBatch = async () => {
      if (batch.length === 0) return;

      try {
        await client.stream({
          type: 'batch',
          run_id,
          worker_id: client.id,
          items: batch,
          checkpoint: lastCheckpoint ?? undefined,
        });
      } catch (streamErr) {
        const batchIds = batch.map((b) => b.id);
        log.debug(
          `[executor] Stream batch failed for run ${run_id} (${batchIds.length} items lost: ${batchIds.join(', ')}):`,
          streamErr
        );
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        throw new Error(
          `Stream batch failed: ${msg} (lost ${batchIds.length} items: ${batchIds.join(', ')})`
        );
      }

      batch = [];
    };

    const result = await executeCompiledConnector({
      compiledCode: compiled_code,
      executor: laneExecutor,
      job: {
        mode: 'sync',
        config: mergeEnv(env, job.connection_credentials, feedConfig),
        checkpoint: checkpoint as Record<string, unknown> | null,
        env,
        sessionState: (job.session_state ?? null) as Record<string, unknown> | null,
        credentials: credentials ?? null,
        feedKey: feed_key,
        feedId: feed_id,
        entityIds: job.entity_ids ?? [],
      },
      hooks: {
        onCheckpointUpdate: async (nextCheckpoint) => {
          lastCheckpoint = nextCheckpoint;
          if (!lastCheckpoint) return;
          try {
            await client.stream({
              type: 'batch',
              run_id,
              worker_id: client.id,
              items: [],
              checkpoint: lastCheckpoint,
            });
          } catch (err) {
            log.debug('[executor] Checkpoint flush failed:', err);
          }
        },
        onEventChunk: async (events) => {
          const contentItems = await processEventChunk(events, cfg.generateEmbeddings);
          for (const contentItem of contentItems) {
            batch.push(contentItem);
            itemsCollectedSoFar++;

            if (batch.length >= cfg.batchSize) {
              await flushBatch();
            }
          }
        },
        onChromeDispatch: async (actionKey, actionInput) => {
          // Forward to the gateway's dispatch endpoint. The endpoint
          // resolves a paired chrome connection in the same org as run_id,
          // inserts an 'action' run, and waits for the Owletto extension
          // worker to claim + complete. Multi-replica safe — all state in
          // Postgres; either replica can host the wait.
          return client.dispatchChromeAction({
            parent_run_id: run_id,
            worker_id: client.id,
            action_key: actionKey,
            action_input: actionInput,
          });
        },
      },
    });

    if (result.mode !== 'sync') {
      throw new Error(`Expected sync result, got mode=${result.mode}`);
    }
    lastCheckpoint = result.checkpoint;

    await flushBatch();

    stopHeartbeat();

    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'success',
      items_collected: itemsCollectedSoFar,
      checkpoint: lastCheckpoint ?? undefined,
      auth_update: result.auth_update ?? undefined,
      error_message: partialFetchFailureMessage(result.metadata),
    });

    log.info(`[executor] Sync run ${run_id} completed: ${itemsCollectedSoFar} items`);
    return { itemsCollected: itemsCollectedSoFar };
  } catch (error) {
    stopHeartbeat();

    const errorMessage = error instanceof Error ? error.message : String(error);
    log.info(`[executor] Sync run ${run_id} failed:`, errorMessage);

    const diag = extractExecutionDiagnostics(error);

    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      items_collected: itemsCollectedSoFar,
      error_message: errorMessage,
      ...(diag ?? {}),
    });

    return { itemsCollected: itemsCollectedSoFar, error: errorMessage };
  }
}

/**
 * Connectors report per-source failures on an otherwise-successful sync via
 * `SyncResult.metadata.fetch_errors` ({ url, error }[]). Surface them on the
 * run record through the existing `error_message` field — the gateway
 * persists it even for successful runs — so a partial sync is
 * distinguishable from a clean one.
 */
function partialFetchFailureMessage(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  const errors = metadata?.fetch_errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const shown = errors.slice(0, 10).map((entry) => {
    const e = entry as { url?: unknown; error?: unknown };
    return `${String(e.url ?? 'unknown source')}: ${String(e.error ?? 'unknown error')}`;
  });
  const more = errors.length > shown.length ? `; +${errors.length - shown.length} more` : '';
  return `Partial sync — ${errors.length} source(s) failed: ${shown.join('; ')}${more}`;
}

/**
 * Pull diagnostic fields off a ConnectorExecutionError-shaped error so the worker
 * can persist them on the failed run row. Returns `undefined` when the
 * thrown value isn't an execution failure (e.g. a stream/HTTP error).
 */
function extractExecutionDiagnostics(error: unknown):
  | {
      output_tail?: string;
      exit_code?: number | null;
      exit_signal?: string | null;
      exit_reason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
    }
  | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    exitReason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
    exitCode?: number | null;
    exitSignal?: string | null;
    outputTail?: string;
  };
  if (!e.exitReason && e.exitCode === undefined && !e.outputTail) return undefined;
  return {
    output_tail: e.outputTail || undefined,
    exit_code: e.exitCode ?? null,
    exit_signal: e.exitSignal ?? null,
    exit_reason: e.exitReason,
  };
}

/**
 * Execute an action run (async action with approval)
 */
async function executeActionRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const { run_id, connector_key, action_key, action_input, credentials } = job;

  if (!run_id || !connector_key || !action_key) {
    throw new Error('Invalid action run: missing run_id, connector_key, or action_key');
  }

  if (hasDaemonBuiltin(connector_key, action_key)) {
    return await executeDaemonBuiltinActionRun(client, job, cfg);
  }

  const [select, { executeCompiledConnector }] = await loadCompiledRuntime();

  const execution = await resolveJobExecution(
    select,
    job,
    cfg.timeoutMs,
    cfg.executor
  );
  if (!execution.ok) {
    const errorMessage = `Action run ${run_id} (${connector_key}): ${execution.error}`;
    log.info('[executor]', errorMessage);
    await completeActionOnce(client, {
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });
    return { itemsCollected: 0, error: errorMessage };
  }
  const compiled_code = execution.code;
  const laneExecutor = execution.executor;

  log.info(`[executor] Starting action run ${run_id} (${connector_key}/${action_key})`);

  // Heartbeat so the gateway's stale-run reaper doesn't write us off
  // mid-action. Action runs can legitimately take minutes (LLM calls,
  // long Playwright sessions, third-party API rate-limit waits); the
  // reaper's default threshold is 120s, so a 30s heartbeat gives ~3
  // ticks of grace. Without this the row sits "running" until the worker
  // process dies, and the lane was previously excluded from the reaper
  // (lobu#859) because the heartbeat was missing.
  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(run_id);
    } catch (err) {
      log.debug('[executor] Action heartbeat failed:', err);
    }
  }, cfg.heartbeatIntervalMs);
  let terminalPayloadStarted = false;

  try {
    const result = await executeCompiledConnector({
      compiledCode: compiled_code,
      executor: laneExecutor,
      job: {
        mode: 'action',
        // NOTE: unlike the gateway's inline action path (manage_operations
        // `executeLocalActionInline`, which merges the connection's own config
        // so an action can read e.g. a `restaurants_url`), this worker-fleet
        // action path does not yet receive per-connection config (the poll
        // response doesn't carry it). If a future connector needs config on the
        // fleet path, plumb the connection config into the action poll response
        // and merge it here.
        //
        // Chrome: onChromeDispatch is wired the same as sync jobs so
        // prepare_comment / other extension-driving actions can stage UI via
        // the paired Owletto extension (parent_run_id = this action run).
        actionKey: action_key,
        actionInput: (action_input ?? {}) as Record<string, unknown>,
        config: mergeEnv(env, job.connection_credentials, null),
        env,
        sessionState: null,
        credentials: credentials ?? null,
      },
      hooks: {
        onChromeDispatch: async (actionKey, actionInput) => {
          return client.dispatchChromeAction({
            parent_run_id: run_id,
            worker_id: client.id,
            action_key: actionKey,
            action_input: actionInput,
          });
        },
      },
    });

    if (result.mode !== 'action') {
      throw new Error(`Expected action result, got mode=${result.mode}`);
    }
    const actionOutput = result.output;

    terminalPayloadStarted = true;
    await completeActionOnce(client, {
      run_id,
      worker_id: client.id,
      status: 'success',
      action_output: actionOutput,
    });

    log.info(`[executor] Action run ${run_id} completed`);
    return { itemsCollected: 0 };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.info(`[executor] Action run ${run_id} failed:`, errorMessage);

    if (terminalPayloadStarted) {
      return { itemsCollected: 0, error: errorMessage };
    }
    await completeActionOnce(client, {
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });

    return { itemsCollected: 0, error: errorMessage };
  } finally {
    clearInterval(heartbeatInterval);
  }
}

async function executeDaemonBuiltinActionRun(
  client: ExecutorClient,
  job: PollResponse,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const { run_id, connector_key, action_key, action_input } = job;
  if (!run_id || !connector_key || !action_key) {
    throw new Error('Invalid daemon built-in action: missing run_id, connector_key, or action_key');
  }
  if (job.compiled_code) {
    const message =
      'operation_backend_unavailable: a daemon built-in payload must not contain compiled_code';
    await completeActionOnce(client, {
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: message,
    });
    return { itemsCollected: 0, error: message };
  }

  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(run_id);
    } catch (error) {
      log.debug('[executor] Daemon built-in heartbeat failed:', error);
    }
  }, cfg.heartbeatIntervalMs);

  try {
    const result = await executeDaemonBuiltin({
      connectorKey: connector_key,
      actionKey: action_key,
      input: (action_input ?? {}) as Record<string, unknown>,
      shutdownSignal: cfg.shutdownSignal,
    });
    if (!result.ok) {
      const message = `${result.code}: ${result.error}`;
      await completeActionOnce(client, {
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: message,
        ...(result.output ? { action_output: result.output } : {}),
      });
      return { itemsCollected: 0, error: message };
    }

    await completeActionOnce(client, {
      run_id,
      worker_id: client.id,
      status: 'success',
      action_output: result.output,
    });
    return { itemsCollected: 0 };
  } catch (error) {
    // Delivery uncertainty is not an execution failure. The immutable payload
    // was retried above; never send a contradictory terminal result here.
    const message = error instanceof Error ? error.message : String(error);
    log.info(`[executor] Daemon built-in terminal delivery uncertain for ${run_id}:`, message);
    return { itemsCollected: 0, error: message };
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Execute an 'auth' run: drive connector.authenticate() and stream artifacts
 * to the UI via the API. On success, credentials land on the auth profile.
 */
async function executeAuthRun(
  client: ExecutorClient,
  job: PollResponse,
  env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const [select, { executeCompiledConnector }] = await loadCompiledRuntime();
  const { run_id, connector_key, previous_credentials } = job;

  if (!run_id || !connector_key) {
    throw new Error('Invalid auth run: missing run_id or connector_key');
  }
  // Interactive auth runs wait on human input (QR scans, OTP entry, OAuth
  // redirects) — a fixed timeout would kill the pairing mid-flow. Terminate
  // via the UI cancel signal instead (timeoutMs: 0 on either lane).
  const execution = await resolveJobExecution(
    select,
    job,
    0,
    cfg.executor
  );
  if (!execution.ok) {
    const errorMessage = `Auth run ${run_id} (${connector_key}): ${execution.error}`;
    log.info('[executor]', errorMessage);
    await client.completeAuth({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });
    return { itemsCollected: 0, error: errorMessage };
  }
  const compiled_code = execution.code;
  const laneExecutor = execution.executor;

  log.info(`[executor] Starting auth run ${run_id} (${connector_key})`);

  // Heartbeat so the API doesn't time us out while the user is scanning.
  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(run_id);
    } catch (err) {
      log.debug('[executor] Auth heartbeat failed:', err);
    }
  }, cfg.heartbeatIntervalMs);

  try {
    const result = await executeCompiledConnector({
      compiledCode: compiled_code,
      executor: laneExecutor,
      job: {
        mode: 'authenticate',
        config: {},
        previousCredentials: previous_credentials ?? null,
        env,
      },
      hooks: {
        onAuthArtifact: async (artifact) => {
          try {
            await client.emitAuthArtifact({
              run_id,
              worker_id: client.id,
              artifact,
            });
          } catch (err) {
            log.debug('[executor] emitAuthArtifact failed:', err);
          }
        },
        onAwaitAuthSignal: async (name, opts) => {
          const deadline = opts?.timeoutMs ? Date.now() + opts.timeoutMs : null;
          while (true) {
            if (deadline !== null && Date.now() > deadline) {
              throw new Error(`awaitSignal('${name}') timed out`);
            }
            const resp = await client.pollAuthSignal({
              run_id,
              worker_id: client.id,
              signal_name: name,
            });
            if (resp.signal) return resp.signal;
            await delay(1500);
          }
        },
      },
    });

    clearInterval(heartbeatInterval);

    if (result.mode !== 'authenticate' || !result.auth?.credentials) {
      await client.completeAuth({
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: 'authenticate() returned no credentials',
      });
      return { itemsCollected: 0, error: 'no credentials' };
    }

    await client.completeAuth({
      run_id,
      worker_id: client.id,
      status: 'success',
      credentials: result.auth.credentials,
      metadata: result.auth.metadata,
    });

    log.info(`[executor] Auth run ${run_id} completed`);
    return { itemsCollected: 0 };
  } catch (error) {
    clearInterval(heartbeatInterval);
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.info(`[executor] Auth run ${run_id} failed:`, errorMessage);

    const diag = extractExecutionDiagnostics(error);

    try {
      await client.completeAuth({
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: errorMessage,
        ...(diag ?? {}),
      });
    } catch (completeErr) {
      log.debug('[executor] completeAuth after failure errored:', completeErr);
    }
    return { itemsCollected: 0, error: errorMessage };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an embed_backfill run (generate embeddings for events missing them)
 */
async function executeEmbedBackfillRun(
  client: ExecutorClient,
  job: PollResponse,
  _env: Env,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const { run_id, action_input } = job;

  if (!run_id) {
    throw new Error('Invalid embed_backfill run: missing run_id');
  }

  // Parse event_ids from action_input
  let input: Record<string, unknown> | null | undefined;
  if (typeof action_input === 'string') {
    try {
      input = JSON.parse(action_input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMessage = `Invalid action_input JSON: ${msg}`;
      log.info(`[executor] Embed backfill run ${run_id}: invalid action_input JSON:`, msg);
      await client.complete({
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: errorMessage,
      });
      return { itemsCollected: 0, error: errorMessage };
    }
  } else {
    input = action_input;
  }
  const eventIds: number[] = (input?.event_ids as number[]) ?? [];

  if (eventIds.length === 0) {
    log.info(`[executor] Embed backfill run ${run_id}: no event_ids`);
    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: 'No event_ids in action_input',
    });
    return { itemsCollected: 0, error: 'No event_ids' };
  }

  log.info(`[executor] Starting embed_backfill run ${run_id} for ${eventIds.length} events`);

  // Heartbeat so the gateway's stale-run reaper doesn't time us out.
  // Embed backfills can run for minutes on large batches (each embedding
  // call is a network round-trip + GPU/CPU work); the reaper threshold
  // is 120s, so a 30s heartbeat gives ~3 ticks of grace. This lane was
  // excluded from the reaper in lobu#859 because the heartbeat was
  // missing — now folded back in.
  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat(run_id);
    } catch (err) {
      log.debug('[executor] Embed backfill heartbeat failed:', err);
    }
  }, cfg.heartbeatIntervalMs);

  try {
    // Fetch event content from the API
    const events = await client.fetchEventsForEmbedding(eventIds);

    if (events.length === 0) {
      log.info(`[executor] Embed backfill run ${run_id}: all events already have embeddings`);
      await client.completeEmbeddings({
        run_id,
        worker_id: client.id,
        embeddings: [],
        error_message: 'All events already have embeddings',
      });
      return { itemsCollected: 0 };
    }

    // Generate embeddings in batch — backfill runs are explicitly the
    // "lots of events" path, so batch through the service / vectorized local
    // pass instead of one round-trip per event.
    const pending = events
      .map((event) => ({
        event_id: event.id,
        text: [event.title, event.content].filter(Boolean).join(' ').trim(),
      }))
      .filter((p) => p.text.length > 0);

    // Expand phase: one vector per event (chunk_index 0). The schema is ready for
    // multi-vector, but the worker only starts CHUNKING in the contract release —
    // until the PK moves off (event_id), more than one row per event would
    // violate it. So this stays the single vectorized batch pass, tagged chunk 0.
    const results: Array<{
      event_id: number;
      chunk_index: number;
      embedding: number[];
      embedding_model: string;
    }> = [];
    let batchError: string | undefined;
    try {
      // Dynamic: the headless shell package ships without the embeddings
      // provider stack, so a static import would pull it into every daemon
      // bundle. Loaded only when a feed actually has text to embed.
      const { batchGenerateEmbeddings } = await import('../embeddings.js');
      const { embeddings, model } = await batchGenerateEmbeddings(pending.map((p) => p.text));
      for (let i = 0; i < pending.length; i++) {
        const embedding = embeddings[i];
        if (embedding) {
          results.push({
            event_id: pending[i]!.event_id,
            chunk_index: 0,
            embedding,
            embedding_model: model,
          });
        }
      }
    } catch (err) {
      // Do NOT swallow this into a "completed with 0" run. A batch failure here
      // (e.g. the service rejecting an oversized text, or a transient outage)
      // must mark the run FAILED so the same events get re-queued and the
      // failure is visible — otherwise the batch is silently dropped forever.
      batchError = err instanceof Error ? err.message : String(err);
      log.debug(`[executor] Batch embedding failed for run ${run_id}:`, err);
    }

    // Submit embeddings back to the API. When the batch produced nothing because
    // it errored, forward the error so the run is finalized as `failed`
    // (completeEmbeddings marks it failed when given an error_message + empty
    // embeddings) rather than as a no-op success.
    await client.completeEmbeddings({
      run_id,
      worker_id: client.id,
      embeddings: results,
      ...(results.length === 0 && batchError ? { error_message: batchError } : {}),
    });

    if (results.length === 0 && batchError) {
      return { itemsCollected: 0, error: batchError };
    }

    log.info(
      `[executor] Embed backfill run ${run_id} completed: ${results.length}/${events.length} embeddings`
    );
    return { itemsCollected: results.length };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.info(`[executor] Embed backfill run ${run_id} failed:`, errorMessage);

    await client.complete({
      run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: errorMessage,
    });

    return { itemsCollected: 0, error: errorMessage };
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Merge the run-level env, the per-connection stored credentials, and the
 * per-feed config into the single `config` object that the connector's
 * `sync()` / `execute()` sees. Connection credentials override env (per-conn
 * trumps fleet-wide); feed config wins last (per-feed trumps connection).
 */
function mergeEnv(
  env: Env,
  connectionCredentials: Record<string, unknown> | undefined | null,
  feedConfig: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    ...((connectionCredentials ?? {}) as Record<string, unknown>),
    ...((feedConfig ?? {}) as Record<string, unknown>),
  };
}

/**
 * Convert a V1 EventEnvelope (the SDK's standard sync output) into the
 * gateway-bound ContentItem shape (without an embedding).
 */
function toContentItem(event: EventEnvelope): ContentItem {
  const occurredAtIso =
    event.occurred_at instanceof Date
      ? event.occurred_at.toISOString()
      : (event.occurred_at as unknown as string);

  return {
    id: event.origin_id,
    title: event.title,
    payload_type: event.payload_type,
    payload_text: event.payload_text,
    payload_data: event.payload_data,
    payload_template: event.payload_template,
    attachments: event.attachments,
    author_name: event.author_name,
    occurred_at: occurredAtIso,
    source_url: event.source_url ?? undefined,
    score: typeof event.score === 'number' ? event.score : 0,
    metadata: event.metadata ?? {},
    origin_parent_id: event.origin_parent_id ?? undefined,
    origin_type: event.origin_type,
    semantic_type: event.semantic_type ?? event.origin_type,
    automation_signals: event.automation_signals,
  };
}

/**
 * Convert a chunk of events into ContentItems, generating embeddings for the
 * whole chunk in a single batch call (one HTTP round-trip / vectorized local
 * pass) instead of one per event. Vectors are mapped back to their source
 * event by index; events with empty text get no embedding. A batch failure is
 * logged and the items stream through without embeddings (same fail-open
 * semantics as the previous per-event path).
 */
async function processEventChunk(
  events: EventEnvelope[],
  generateEmbeddings: boolean
): Promise<ContentItem[]> {
  const contentItems = events.map(toContentItem);

  if (!generateEmbeddings || contentItems.length === 0) {
    return contentItems;
  }

  // Collect the embeddable texts and remember which ContentItem each maps to,
  // so vectors line up after the batch call even though empty-text items are
  // skipped.
  const targets: number[] = [];
  const texts: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const text = [events[i]!.title, events[i]!.payload_text].filter(Boolean).join(' ').trim();
    if (text) {
      targets.push(i);
      texts.push(text);
    }
  }

  if (texts.length === 0) {
    return contentItems;
  }

  try {
    // Dynamic for the same reason as above: keeps the embeddings provider
    // stack out of the headless shell bundle.
    const { batchGenerateEmbeddings } = await import('../embeddings.js');
    const { embeddings, model } = await batchGenerateEmbeddings(texts);
    for (let j = 0; j < targets.length; j++) {
      const embedding = embeddings[j];
      if (embedding) {
        const item = contentItems[targets[j]!]!;
        item.embedding = embedding;
        item.embedding_model = model;
      }
    }
  } catch (err) {
    log.debug('[executor] Batch embedding generation failed for chunk:', err);
  }

  return contentItems;
}
