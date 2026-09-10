/**
 * Automation run arm.
 *
 * The connector-worker daemon claims connector sync/action/auth/embed jobs. For
 * `run_type='automation'` (device mode only — the gateway never hands an
 * automation run to a trusted fleet worker), the daemon now spawns the user's
 * local agent CLI (`claude`, `codex`, …) the same way the Mac app's
 * `AutomationDispatcher` does: build the prompt from the poll envelope, spawn
 * headless, heartbeat, then post the process exit to `/complete-automation` and
 * honour the server's `resume` decision.
 *
 * Ported from `packages/owletto`'s `AutomationDispatcher` (AgentSpec routing,
 * `SpecExecutor` subprocess supervision, and the finalize/resume loop). The
 * prompt and the `AgentSpec` table now live in
 * `@lobu/core/contracts/worker/device-automation`, so the two runtimes cannot
 * drift.
 *
 * Unlike connector children (which inherit a small system-env allowlist), the
 * spawned agent CLI runs in the user's environment (PATH, HOME) minus the
 * `WORKER_API_TOKEN` env var, so the child cannot act as the worker/poll loop.
 * Its Lobu credential is the poll envelope's per-run `agent_session` when the
 * server minted one (see `resolveDeviceAgentRunAccess`): the run authenticates
 * as the run's assigned agent, not as the daemon or the user's ambient CLI
 * session. Capable standalone Mac daemons fail closed when that session is
 * absent; legacy workers retain the pre-session fallback.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { PROVIDER_BALANCE_EXHAUSTED } from '@lobu/core';
import {
  type AgentKind,
  type AgentSpec,
  buildDeviceAutomationPrompt,
  DEVICE_AGENT_SPECS_BY_KIND,
} from '@lobu/core/contracts/worker/device-automation';
import type {
  AutomationPollPayload,
  CompleteAutomationResponse,
  PollResponse,
  WorkerExitReason,
} from '@lobu/core/contracts/worker/protocol';
import { redactOutput } from '../executor/redact.js';
import { locateBinary, searchDirs } from './agent-binaries.js';
import {
  releaseSupervisor,
  spawnSupervisedCli,
  terminateChild,
  waitForTargetExit,
  waitForTargetExitAfterTermination,
} from './automation-process.js';
import type { ExecutorClient } from './client.js';
import { WorkerDecodeError, WorkerHttpError } from './client.js';
import { log } from './log.js';
import {
  attachedInteractiveSession,
  handoffToInteractiveSession,
  type InteractiveSession,
} from './interactive-session.js';
import {
  AcpTranscript,
  type AcpAgentKind,
  type AutomationAcpAdapters,
  runAcpTurn,
} from './automation-acp.js';

/**
 * The slice of the daemon's `ExecutorConfig` the automation arm reads.
 *
 * Declared narrowly so a caller that only executes automations — the one-shot
 * `executeClaimedAutomationRun` entry point — does not have to fabricate
 * connector-sync fields (`batchSize`, `generateEmbeddings`)
 * that this arm never touches. The daemon's full `ExecutorConfig` is
 * structurally assignable to it.
 */
export interface AutomationExecutorConfig {
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Stops a pending interactive handoff during daemon shutdown. */
  shutdownSignal?: AbortSignal;
  /** Standalone Mac daemons must never use the device PAT for MCP writes. */
  requireRunScopedSession?: boolean;
  /** Test-only override; production deliberately uses the 15-second default. */
  terminalHeartbeatGraceMs?: number;
  /**
   * Agent to use when the Automation names no `agent_kind`.
   *
   * The device, not the server, owns this choice: `agent_kind` is optional on
   * the wire (`AutomationPollMetaSchema`), and which CLIs are actually
   * installed is a property of the machine. The Mac app has always resolved it
   * from the user's menubar pick; without it here, every Automation created
   * without an explicit kind fails on the device with "no local agent executor
   * configured".
   */
  defaultAgentKind?: AgentKind;
  /**
   * Explicit per-agent binary paths (else PATH lookup). Lets an operator point
   * at a non-PATH CLI install, and is the injection seam the automation tests
   * use to drive a fake binary.
   */
  binaryOverrides?: Partial<Record<AgentKind, string>>;
  /** Maintained ACP entrypoints keyed by the local agent kind they drive. */
  acpAdapters?: AutomationAcpAdapters;
}

/** Shared liveness/cancellation control for every device-local agent run. */
export function monitorDeviceAgentRun(
  client: ExecutorClient,
  runId: number,
  cfg: AutomationExecutorConfig,
  label: string,
) {
  const abortController = new AbortController();
  const terminalController = new AbortController();
  let shutdownRequested = false;
  const onShutdown = () => {
    shutdownRequested = true;
    abortController.abort();
  };
  cfg.shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
  if (cfg.shutdownSignal?.aborted) onShutdown();

  const heartbeat = setInterval(() => {
    client.heartbeat(runId).catch((error) => {
      if (error instanceof WorkerHttpError && error.status === 409) {
        if (!abortController.signal.aborted) {
          log.info(
            `[executor] ${label} run ${runId} is no longer active; stopping the local CLI`,
          );
          terminalController.abort();
          abortController.abort();
          clearInterval(heartbeat);
        }
        return;
      }
      log.debug(`[executor] ${label} heartbeat failed:`, error);
    });
  }, cfg.heartbeatIntervalMs ?? 30_000);

  return {
    abortController,
    terminalSignal: terminalController.signal,
    shutdownRequested: () => shutdownRequested,
    stop: () => {
      clearInterval(heartbeat);
      cfg.shutdownSignal?.removeEventListener('abort', onShutdown);
    },
  };
}

/** Local-CLI run result, mirrored from the Mac app's `ExecutorResult`. */
export interface ExecutorResult {
  output: string;
  error: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitReason: WorkerExitReason;
  durationMs: number;
  /** Present for an ACP turn; cumulative across finalize rounds. */
  transcriptJsonl?: string;
}

const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 1 * 1024 * 1024;
/** Rolling OpenCode diagnostics needed only until a terminal retry is found. */
const OPENCODE_DIAGNOSTIC_CAP = 32 * 1024;
/**
 * How long the account-limit diagnostic must go unanswered before the run is
 * interrupted. OpenCode logs the line and then sleeps for the provider's reset
 * window, so silence is the actual stall signal. A CLI that writes anything
 * further — or exits — inside this window was still making progress and keeps
 * its own exit; without the window, a run that logged the line and recovered
 * was killed and its output discarded.
 */
const OPENCODE_DIAGNOSTIC_SETTLE_MS = 1_500;
/** Wall-clock cap for a device-local agent CLI without a per-run override. */
export const DEFAULT_DEVICE_AGENT_TIMEOUT_MS = 600_000;
/** Cap on the CLI-output tail folded into `runs.error_message`. */
const DETAIL_TAIL_CHARS = 500;
const LOCAL_MAX_ROUNDS = 8;
const EXIT_REPORT_DELIVERY_ATTEMPTS = 3;
const EXIT_REPORT_RETRY_DELAY_MS = 2000;
const TRANSCRIPT_DELIVERY_ATTEMPTS = 3;
const TRANSCRIPT_RETRY_DELAY_MS = 250;
const TERMINAL_HEARTBEAT_GRACE_MS = 15_000;

/** Sentinel for "binary not on PATH" so it maps to a distinct exit reason. */
class ExecutableNotFoundError extends Error {
  constructor(name: string) {
    super(`${name} binary not found on PATH`);
    this.name = 'ExecutableNotFoundError';
  }
}

/** The server has already finalized or released this claimed run. */
class AutomationRunNoLongerActiveError extends Error {
  constructor() {
    super('automation run is no longer active');
    this.name = 'AutomationRunNoLongerActiveError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drain a child stream to a byte-capped buffer; stop at EOF. */
function drain(stream: Readable, capBytes: number): Promise<{ data: Buffer; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    stream.on('data', (chunk: Buffer) => {
      if (total < capBytes) {
        const room = capBytes - total;
        if (chunk.length > room) {
          truncated = true;
          chunks.push(chunk.subarray(0, room));
          total += room;
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      } else {
        truncated = true;
      }
    });
    const settle = () => resolve({ data: Buffer.concat(chunks), truncated });
    stream.on('end', settle);
    stream.on('error', settle);
    // `close` covers the forced-destroy path below, which emits neither.
    stream.on('close', settle);
  });
}

/**
 * Extract the provider reason from OpenCode's structured error log, but only
 * for deterministic account limits. Generic stream errors remain owned by the
 * CLI and its own retry loop.
 *
 * The wording accepted here must stay a subset of what the server's
 * `deviceProviderQuotaResetNotBefore` recognizes as quota evidence. Killing a
 * run the server will not park just moves the same failure to the next cron
 * tick, which is the waste this path exists to stop.
 */
function openCodeTerminalRetryDiagnostic(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!/\blevel=ERROR\b/.test(line) || !/\bmessage="stream error"/.test(line)) continue;
    const encoded = line.match(/\berror\.error=("(?:\\.|[^"\\])*")/)?.[1];
    if (!encoded) continue;

    let detail: string;
    try {
      detail = JSON.parse(encoded);
    } catch {
      continue;
    }
    detail = detail.replace(/^AI_[A-Za-z]+Error:\s*/, '').trim();
    const isTerminalAccountLimit =
      PROVIDER_BALANCE_EXHAUSTED.test(detail) ||
      (/\b(?:daily|weekly|monthly) usage limit reached\b/i.test(detail) &&
        /\breset(?:s)?\s+in\s+\d+(?:\.\d+)?\s*(?:hours?|days?|weeks?)\b/i.test(detail));
    if (isTerminalAccountLimit) return redactOutput(detail);
  }
  return null;
}

/**
 * Await a drain with a hard deadline. A grandchild that inherited the child's
 * pipes can hold the read end open after the child is reaped, so an unbounded
 * wait here would hang the run forever — claimed, heartbeating, never swept.
 * Past the deadline, force-close the pipe and take what was flushed.
 */
async function awaitDrain(
  pending: Promise<{ data: Buffer; truncated: boolean }>,
  stream: Readable,
  deadlineMs: number
): Promise<{ data: Buffer; truncated: boolean }> {
  const expired = Symbol('drain-deadline');
  const outcome = await Promise.race([
    pending,
    new Promise<typeof expired>((resolve) => {
      setTimeout(() => resolve(expired), deadlineMs).unref?.();
    }),
  ]);
  if (outcome !== expired) return outcome;
  stream.destroy();
  return pending;
}

/** Assemble argv from the spec + execution config, mirroring `SpecExecutor`. */
export function buildArguments(
  spec: AgentSpec,
  prompt: string,
  config: AutomationPollPayload['automation']['execution_config'],
  mcpArgs: string[],
  timeoutSeconds: number
): string[] {
  const args: string[] = [];
  let trailingPrompt: string | undefined;
  if (spec.promptDelivery.kind === 'flag') {
    args.push(spec.promptDelivery.flag, prompt);
  } else {
    args.push(...spec.promptDelivery.subcommand);
    trailingPrompt = prompt;
  }
  args.push(...spec.headlessArgs);
  args.push(...mcpArgs);
  if (spec.timeoutFlag) {
    const seconds = Math.max(1, Math.trunc(timeoutSeconds));
    args.push(spec.timeoutFlag.flag, `${seconds}${spec.timeoutFlag.suffix}`);
  }
  if (config) {
    if (config.model && config.model !== '' && spec.modelFlag) {
      args.push(spec.modelFlag, config.model);
    }
    if (config.max_budget_usd && config.max_budget_usd > 0 && spec.budgetFlag) {
      args.push(spec.budgetFlag, String(config.max_budget_usd));
    }
    if (config.permission_mode && config.permission_mode !== '' && spec.permissionModeFlag) {
      args.push(spec.permissionModeFlag, config.permission_mode);
    }
    if (config.effort && config.effort !== '' && spec.effortFlag) {
      args.push(
        spec.effortFlag,
        spec.effortConfigKey
          ? `${spec.effortConfigKey}=${JSON.stringify(config.effort)}`
          : config.effort,
      );
    }
  }
  args.push(...spec.trailingArgs);
  if (trailingPrompt !== undefined) args.push(trailingPrompt);
  return args;
}

/** Build the MCP wiring args/env for the spawned CLI (if the client has any). */
function buildMcp(
  spec: AgentSpec,
  mcpWiring: { url: string; bearer?: string } | undefined
): { mcpArgs: string[]; mcpEnv: Record<string, string>; cleanup: () => void } {
  const mcpArgs: string[] = [];
  const mcpEnv: Record<string, string> = {};
  let cleanup = () => {};
  if (!mcpWiring) return { mcpArgs, mcpEnv, cleanup };

  const bearer = mcpWiring.bearer ?? '';
  if (spec.mcpDelivery.kind === 'claude-config-file') {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-automation-mcp-'));
    const file = path.join(dir, 'mcp.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          lobu: {
            type: 'http',
            url: mcpWiring.url,
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      }),
      { mode: 0o600 }
    );
    mcpArgs.push(spec.mcpDelivery.flag, file, ...spec.mcpDelivery.extraArgs);
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  } else if (spec.mcpDelivery.kind === 'opencode-config-env') {
    mcpEnv[spec.mcpDelivery.variable] = JSON.stringify({
      mcp: {
        lobu: {
          type: 'remote',
          url: mcpWiring.url,
          headers: { Authorization: `Bearer ${bearer}` },
          enabled: true,
        },
      },
    });
  }
  return { mcpArgs, mcpEnv, cleanup };
}

/** The run-scoped credential set used by any spawned local agent CLI. */
export interface DeviceAgentRunAccess {
  /** Lobu MCP wiring for the CLI's mcp config (buildMcp). */
  wiring: { url: string; bearer?: string } | undefined;
  /** Extra env for the child process (LOBU_API_TOKEN / LOBU_MEMORY_URL). */
  env: Record<string, string>;
}

function claudeSessionMeta(
  base: Record<string, unknown> | undefined,
  maxBudgetUsd: number | undefined
): Record<string, unknown> | undefined {
  if (!base && !(maxBudgetUsd != null && maxBudgetUsd > 0)) return undefined;
  const claudeCode =
    base?.claudeCode != null && typeof base.claudeCode === 'object'
      ? (base.claudeCode as Record<string, unknown>)
      : {};
  const options =
    claudeCode.options != null && typeof claudeCode.options === 'object'
      ? (claudeCode.options as Record<string, unknown>)
      : {};
  return {
    ...base,
    claudeCode: {
      ...claudeCode,
      options: {
        ...options,
        ...(maxBudgetUsd != null && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
      },
    },
  };
}

/**
 * Resolve what credential the spawned CLI runs with — the boundary shared by
 * Automation and device-chat CLIs. When the poll envelope carries a per-run
 * `agent_session`, the CLI authenticates as the run's assigned agent for
 * exactly this run: the session token goes into the MCP wiring AND into
 * LOBU_API_TOKEN/LOBU_MEMORY_URL, which `lobu memory` prefers
 * over the device's ambient CLI session — so an unattended run never acts as
 * the human user or the daemon. Without a session (older server, or a run with
 * no usable assigned agent) fall back to the daemon's own wiring, the
 * pre-session dispatch path.
 */
export function resolveDeviceAgentRunAccess(
  session: AutomationPollPayload['context']['agent_session'],
  daemonWiring: { url: string; bearer?: string } | undefined
): DeviceAgentRunAccess {
  if (!session) return { wiring: daemonWiring, env: {} };
  return {
    wiring: { url: session.mcp_url, bearer: session.token },
    env: {
      LOBU_API_TOKEN: session.token,
      LOBU_MEMORY_URL: session.mcp_url,
    },
  };
}

/** Interactive delivery requires the run kind and run-scoped access to match. */
export function isInteractiveSessionEligible(
  kind: AgentKind,
  session: InteractiveSession | undefined,
  payload: AutomationPollPayload
): boolean {
  return (
    session?.kind === kind &&
    payload.context.agent_session != null
  );
}

/** Spawn one CLI run and classify how it ended. */
export async function runCli(
  spec: AgentSpec,
  prompt: string,
  config: AutomationPollPayload['automation']['execution_config'],
  access: DeviceAgentRunAccess,
  timeoutMs: number,
  binaryPath?: string,
  abortSignal?: AbortSignal,
  shutdownSignal?: AbortSignal,
  terminalHeartbeatGraceMs = TERMINAL_HEARTBEAT_GRACE_MS
): Promise<ExecutorResult> {
  // One AbortController spans every finalize/resume round. If a terminal 409
  // landed while the prior exit report was in flight, do not start stale work.
  if (abortSignal?.aborted) throw new AutomationRunNoLongerActiveError();

  const binary = binaryPath ?? locateBinary(spec.binaryName);
  if (!binary || !existsSync(binary)) throw new ExecutableNotFoundError(spec.binaryName);

  const { mcpArgs, mcpEnv, cleanup } = buildMcp(spec, access.wiring);
  let supervisor: ChildProcess | undefined;
  let supervisorSettled = false;
  try {
    const args = buildArguments(spec, prompt, config, mcpArgs, timeoutMs / 1000);
    const started = Date.now();

    // Inherit the user's environment (PATH, HOME, CLI credentials) but drop
    // WORKER_API_TOKEN so the child cannot act as the worker/poll loop itself.
    // The run's bearer is wired into the child's MCP config on purpose
    // (buildMcp above) — that is how the spawned CLI reaches Lobu tools, same
    // as the Mac `AutomationDispatcher`; what we withhold is the daemon role.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.WORKER_API_TOKEN;
    for (const [key, value] of Object.entries(mcpEnv)) env[key] = value;
    for (const [key, value] of Object.entries(access.env)) env[key] = value;
    // GUI/app-launched daemons can have a stripped PATH; re-add common installs.
    const extraPath = searchDirs().join(':');
    const currentPath = env.PATH ?? '/usr/bin:/bin';
    if (!currentPath.includes('/.local/bin')) {
      env.PATH = `${extraPath}:${currentPath}`;
    }

    const supervised = spawnSupervisedCli(binary, args, env);
    const proc = supervised.supervisor;
    supervisor = proc;
    const { stdout, stderr } = proc;
    if (!stdout || !stderr) {
      throw new Error('automation supervisor spawned without stdio pipes');
    }

    const stdoutPromise = drain(stdout, STDOUT_CAP);
    const stderrPromise = drain(stderr, STDERR_CAP);

    // OpenCode can sleep for the provider's full account reset window and
    // otherwise emits no headless progress. Observe its error-level diagnostic
    // while the normal capped drain keeps collecting output, then interrupt
    // only the deterministic account-limit class.
    //
    // The wait is aborted by two unrelated causes that end the run differently:
    // the server's 409 is an intentional stop that keeps the graceful grace
    // window and reports `ok`, while a diagnostic stop is a provider failure.
    // `diagnosticStop` records which one fired, so a 409 that races a quota log
    // is still handled as a cancellation.
    let terminalDiagnostic: string | null = null;
    let diagnosticStop = false;
    let diagnosticBuffer = '';
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const waitAbort = new AbortController();
    const forwardAbort = () => waitAbort.abort();
    abortSignal?.addEventListener('abort', forwardAbort, { once: true });
    if (abortSignal?.aborted) forwardAbort();
    const observeDiagnostic = (chunk: Buffer | string) => {
      // Any stderr byte after the diagnostic is progress: cancel the pending
      // stop, then re-arm only while the rolling diagnostics still contain the
      // account-limit reason.
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      diagnosticBuffer = (diagnosticBuffer + chunk.toString()).slice(-OPENCODE_DIAGNOSTIC_CAP);
      terminalDiagnostic = openCodeTerminalRetryDiagnostic(diagnosticBuffer);
      if (!terminalDiagnostic || abortSignal?.aborted) return;
      settleTimer = setTimeout(() => {
        if (abortSignal?.aborted) return;
        diagnosticStop = true;
        waitAbort.abort();
      }, OPENCODE_DIAGNOSTIC_SETTLE_MS);
      settleTimer.unref?.();
    };
    const initialExit = await (async () => {
      if (spec.kind === 'opencode') stderr.on('data', observeDiagnostic);
      try {
        return await waitForTargetExit(supervised.targetExit, timeoutMs, waitAbort.signal);
      } finally {
        stderr.off('data', observeDiagnostic);
        if (settleTimer) clearTimeout(settleTimer);
        abortSignal?.removeEventListener('abort', forwardAbort);
      }
    })();
    const { timedOut, aborted } = initialExit;
    let target = initialExit.target;
    let cancelled = false;
    let intentionalCancellation = false;
    let killedSignal: string | null = null;
    let cleanupSignal: string | null = null;
    let diagnosticSignal: string | null = null;
    // Authoritative: the wait must actually have been aborted BY the diagnostic.
    // A late stderr chunk can set `diagnosticStop` after the target already
    // exited on its own, and that run keeps its real exit.
    const diagnosticInterrupted = aborted && diagnosticStop && terminalDiagnostic != null;
    if (diagnosticInterrupted) {
      const treeSignal = await terminateChild(proc);
      supervisorSettled = true;
      target =
        (await waitForTargetExitAfterTermination(supervised.targetExit)) ?? undefined;
      diagnosticSignal = target && target.signalCode !== 'SIGKILL' ? 'SIGTERM' : treeSignal;
    } else if (aborted) {
      const shutdownCancelled = shutdownSignal?.aborted === true;
      intentionalCancellation = shutdownCancelled;
      // A 409 is also the normal post-complete_window state. Let a CLI that is
      // already winding down exit and report its device-side metadata. The
      // supervisor remains the non-reusable tree owner throughout the grace,
      // so a normally exiting leader cannot orphan its remaining descendants.
      const gracefulExit = shutdownCancelled
        ? { target: undefined }
        : await waitForTargetExit(supervised.targetExit, terminalHeartbeatGraceMs);
      target = gracefulExit.target;
      // Either way the tree must go: a CLI that exited still leaves the
      // supervisor and any descendants it spawned holding the group.
      cancelled = shutdownCancelled || !target;
      const treeSignal = await terminateChild(proc);
      supervisorSettled = true;
      target ??=
        (await waitForTargetExitAfterTermination(supervised.targetExit)) ?? undefined;
      cleanupSignal = target && target.signalCode !== 'SIGKILL' ? 'SIGTERM' : treeSignal;
    } else if (timedOut) {
      const treeSignal = await terminateChild(proc);
      supervisorSettled = true;
      target =
        (await waitForTargetExitAfterTermination(supervised.targetExit)) ?? undefined;
      killedSignal = target && target.signalCode !== 'SIGKILL' ? 'SIGTERM' : treeSignal;
    } else {
      await releaseSupervisor(proc);
      supervisorSettled = true;
    }

    // A SIGKILLed child gets a short flush window; a clean exit gets a long one.
    const drainDeadlineMs =
      cancelled ||
      killedSignal === 'SIGKILL' ||
      cleanupSignal === 'SIGKILL' ||
      diagnosticSignal === 'SIGKILL'
        ? 2000
        : 60_000;
    // Both pipes must race the SAME clock. Awaiting them in sequence gave
    // stderr a fresh deadline only after stdout's had expired, so a grandchild
    // holding both ends cost 2x the deadline (measured: 120s for a child that
    // had already exited cleanly), not the one window the constant describes.
    const [
      { data: stdoutData, truncated: stdoutTruncated },
      { data: stderrData },
    ] = await Promise.all([
      awaitDrain(stdoutPromise, stdout, drainDeadlineMs),
      awaitDrain(stderrPromise, stderr, drainDeadlineMs),
    ]);

    const label = spec.binaryName;
    const exitCode = target?.exitCode ?? null;
    const targetSignal = target?.signalCode ?? null;
    // Once the target exits, cleanupSignal belongs only to its supervisor or
    // descendants and must not overwrite the target's own exit metadata.
    const exitSignal =
      diagnosticSignal ??
      killedSignal ??
      (cancelled ? cleanupSignal : null) ??
      (targetSignal != null ? `signal:${targetSignal}` : null);

    let exitReason: WorkerExitReason;
    let errorMessage: string | null;
    // The last thing the CLI said before it stopped. Prefer stderr, but fall
    // back to stdout. `claude` prints its fatal on stdout ("Credit balance is
    // too low") and leaves stderr empty, so reading stderr alone reported the
    // most likely real failure as a bare "exited with non-zero status 1" with
    // the cause only in output_tail; `opencode` logs to stderr instead. The
    // supervisor's error is the last resort: on SIGKILL escalation the whole
    // group dies before the supervisor can report, and its synthetic message
    // must not mask what the CLI actually wrote. Bounded because this lands in
    // `runs.error_message`, and stderr is capped at 1 MiB.
    const detail = (
      stderrData.toString('utf8').trim() ||
      stdoutData.toString('utf8').trim() ||
      target?.error ||
      ''
    ).slice(-DETAIL_TAIL_CHARS);
    if (diagnosticInterrupted) {
      // Only the diagnostic-interrupted run is reclassified. A CLI that logged
      // the same line and then exited on its own — recovering, or failing for
      // another reason — keeps the exit it actually reported.
      exitReason = 'error_message';
      errorMessage = `${label} provider error: ${terminalDiagnostic}`;
    } else if (cancelled) {
      // The server owns the terminal outcome, but complete-automation remains
      // terminal-safe so it can retain device provenance and duration. Report
      // this intentional local stop as clean instead of inventing a failure.
      exitReason = intentionalCancellation ? 'cancelled' : 'ok';
      errorMessage = null;
    } else if (timedOut) {
      exitReason = 'timeout';
      const deadline = `${label} exited via ${killedSignal ?? 'SIGTERM'} after ${Math.trunc(timeoutMs / 1000)}s timeout`;
      // The deadline alone says nothing about WHY the CLI stalled, and a
      // stalled CLI usually wrote nothing to stdout — so `output_tail` is NULL
      // and this message is the only surviving evidence. Prod #71 failed this
      // way 39 consecutive times and left no diagnosis behind.
      errorMessage = detail === '' ? deadline : `${deadline}: ${detail}`;
    } else if (exitCode === 0) {
      exitReason = 'ok';
      errorMessage = null;
    } else if (targetSignal != null) {
      exitReason = 'crash';
      errorMessage = `${label} exited via signal (status=${targetSignal})`;
    } else {
      exitReason = 'error_message';
      errorMessage =
        detail === ''
          ? `${label} exited with non-zero status ${exitCode}`
          : `${label} exited with status ${exitCode}: ${detail}`;
    }

    let output = stdoutData.toString('utf8');
    if (stdoutTruncated) output += '\n[output truncated]';
    const durationMs = Date.now() - started;

    return {
      output,
      error: errorMessage,
      exitCode,
      exitSignal,
      exitReason,
      durationMs,
    };
  } finally {
    if (
      supervisor &&
      !supervisorSettled &&
      supervisor.exitCode === null &&
      supervisor.signalCode === null
    ) {
      await terminateChild(supervisor).catch(() => {
        try {
          supervisor?.kill('SIGKILL');
        } catch {}
      });
    }
    cleanup();
  }
}

/**
 * A delivery failure's retry classification: HTTP 5xx/429 and transport errors
 * are retriable; a server answer we could not read (decode) or a 4xx is not.
 */
function isRetriableDeliveryFailure(err: unknown): boolean {
  if (err instanceof WorkerHttpError) return err.status >= 500 || err.status === 429;
  if (err instanceof WorkerDecodeError) return false;
  return true;
}

/** The CLI spawn + exit-report seams the resume loop drives. Injecting them is
 * how the loop is tested without spawning a real CLI or hitting the network —
 * the same seam `AutomationDispatcher` exposes via its `LocalAgentExecutor`
 * protocol. */
export interface AutomationRunIo {
  /** Spawn one CLI run (with any finalize nudge appended) and classify its exit. */
  run: (finalizeNudge: string | undefined) => Promise<ExecutorResult>;
  /** Post one exit report, retrying on retriable failures; null = unknown. */
  deliver: (
    result: ExecutorResult,
    finalizeAttempt: number
  ) => Promise<CompleteAutomationResponse | null>;
  /** Best-effort local-failure report so the run does not sit `running`. */
  reportError: (error: string, reason: WorkerExitReason) => Promise<void>;
}

/**
 * Execute a device automation run: spawn the local CLI per its AgentSpec, then
 * post the exit report and honour the server's `resume` decision.
 */
export async function executeAutomationRun(
  client: ExecutorClient,
  job: PollResponse,
  cfg: AutomationExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const runId = job.run_id;
  const payload = job.payload;
  if (runId == null) {
    return { itemsCollected: 0, error: 'automation run missing run_id' };
  }
  if (!payload) {
    const message = 'automation run missing payload envelope';
    await completeAutomationWithError(client, runId, message, 'error_message');
    return { itemsCollected: 0, error: message };
  }
  if (!('automation' in payload)) {
    const message = 'automation run received a non-automation payload envelope';
    await completeAutomationWithError(client, runId, message, 'error_message');
    return { itemsCollected: 0, error: message };
  }

  if (cfg.requireRunScopedSession && !payload.context.agent_session) {
    const message = 'macOS Automation run is missing its required run-scoped agent session';
    await completeAutomationWithError(client, runId, message, 'error_message');
    return { itemsCollected: 0, error: message };
  }

  // The Automation's explicit kind wins; the caller's device-level default is
  // the fallback, matching how the Mac app has always resolved an unset kind.
  const kind = payload.automation.agent_kind ?? cfg.defaultAgentKind ?? null;
  const spec = kind != null ? DEVICE_AGENT_SPECS_BY_KIND.get(kind as AgentKind) : undefined;
  if (!spec) {
    const message = `no local agent executor configured for agent_kind='${kind ?? '(unset)'}'`;
    log.info(`[executor] Automation run ${runId}: ${message}`);
    await completeAutomationWithError(client, runId, message, 'error_message');
    return { itemsCollected: 0, error: message };
  }

  log.info(
    `[executor] Starting automation run ${runId} (agent=${spec.binaryName})`
  );

  const configuredTimeout = payload.automation.execution_config?.timeout_seconds;
  const timeoutMs =
    configuredTimeout != null && configuredTimeout > 0
      ? configuredTimeout * 1000
      : (cfg.timeoutMs ?? DEFAULT_DEVICE_AGENT_TIMEOUT_MS);

  // Daemon startup detects the inherited session once and attaches it
  // internally; per-run detection is not repeated here.
  const interactiveSession = attachedInteractiveSession(cfg);
  const agentSession = payload.context.agent_session;
  const acpAdapter = cfg.acpAdapters?.[spec.kind as AcpAgentKind];
  let acpSessionId = agentSession?.resume_session_id;
  const acpTranscript = acpAdapter ? new AcpTranscript(process.cwd()) : undefined;
  const selectedSession = isInteractiveSessionEligible(spec.kind, interactiveSession, payload)
    ? interactiveSession
    : undefined;
  let executionRoute: 'undecided' | 'interactive' | 'subprocess' = selectedSession
    ? 'undecided'
    : 'subprocess';

  const monitor = monitorDeviceAgentRun(client, runId, cfg, 'Automation');
  const runAbort = monitor.abortController;

  const io: AutomationRunIo = {
    run: async (finalizeNudge) => {
      if (runAbort.signal.aborted) {
        if (!monitor.shutdownRequested()) {
          throw new AutomationRunNoLongerActiveError();
        }
        return {
          output: '',
          error: null,
          exitCode: null,
          exitSignal: 'SIGTERM',
          exitReason: 'cancelled',
          durationMs: 0,
        };
      }
      let prompt = buildDeviceAutomationPrompt(payload, runId);
      if (finalizeNudge && finalizeNudge !== '') {
        prompt += `\n\n---\nFINALIZE NUDGE (prior attempt did not complete the window):\n${finalizeNudge}\n`;
      }
      if (selectedSession && agentSession && executionRoute !== 'subprocess') {
        const handoff = await handoffToInteractiveSession({
          session: selectedSession,
          runId,
          prompt,
          token: agentSession.token,
          memoryUrl: agentSession.mcp_url,
          timeoutMs,
          terminalSignal: monitor.terminalSignal,
          ...(selectedSession.kind === 'codex' && cfg.binaryOverrides?.codex
            ? { codexCommand: cfg.binaryOverrides.codex }
            : {}),
          ...(cfg.shutdownSignal ? { shutdownSignal: cfg.shutdownSignal } : {}),
        });
        if (handoff.kind === 'handed-off') {
          executionRoute = 'interactive';
          log.info(
            `[executor] Automation run ${runId} handed to interactive ${selectedSession.kind} session (${handoff.certainty})`
          );
          const completion = await handoff.completion;
          if (completion.kind === 'completed') {
            return {
              output: completion.output,
              error: null,
              exitCode: 0,
              exitSignal: null,
              exitReason: 'ok',
              durationMs: completion.durationMs,
            };
          }
          if (completion.kind === 'terminal') {
            // Heartbeat 409 proves the server owns this run's terminal outcome.
            // A follow-up exit report can only stamp first-report device
            // provenance on a completed run or ack idempotently; it cannot
            // overwrite that outcome. Report the intentional local stop as clean
            // rather than inventing a timeout the session never hit.
            return {
              output: '',
              error: null,
              exitCode: null,
              exitSignal: null,
              exitReason: 'ok',
              durationMs: completion.durationMs,
            };
          }
          // No child process ran, so there is no exit code or OS signal to
          // report — `error` carries why the handoff ended.
          return {
            output: '',
            error: completion.error,
            exitCode: null,
            exitSignal: null,
            exitReason: completion.kind === 'timeout' ? 'timeout' : 'crash',
            durationMs: completion.durationMs,
          };
        }

        if (executionRoute === 'interactive') {
          // A prior message may have reached the session. Never mix in a subprocess,
          // even if a later finalize-nudge delivery fails before writing.
          return {
            output: '',
            error: `interactive ${selectedSession.kind} delivery failed: ${handoff.reason}`,
            exitCode: null,
            exitSignal: null,
            exitReason: 'crash',
            durationMs: 0,
          };
        }
        executionRoute = 'subprocess';
        log.info(
          `[executor] Automation run ${runId}: interactive ${selectedSession.kind} unavailable before delivery; using subprocess`
        );
      }
      if (acpAdapter && agentSession && acpTranscript) {
        const executionConfig = payload.automation.execution_config;
        const sessionMeta =
          spec.kind === 'claude-code'
            ? claudeSessionMeta(acpAdapter.sessionMeta, executionConfig?.max_budget_usd)
            : acpAdapter.sessionMeta;
        const result = await runAcpTurn({
          agentKind: spec.kind as AcpAgentKind,
          adapter: acpAdapter,
          cwd: process.cwd(),
          prompt,
          mcp: { url: agentSession.mcp_url, bearer: agentSession.token },
          ...(acpSessionId ? { resumeSessionId: acpSessionId } : {}),
          ...(spec.kind === 'claude-code' && executionConfig?.permission_mode
            ? { mode: executionConfig.permission_mode }
            : {}),
          ...(executionConfig?.model
            ? { model: executionConfig.model }
            : {}),
          ...(executionConfig?.effort
            ? { effort: executionConfig.effort }
            : {}),
          ...(sessionMeta ? { sessionMeta } : {}),
          timeoutMs,
          abortSignal: runAbort.signal,
          transcript: acpTranscript,
          onSessionReady: async (sessionId) => {
            await client.heartbeat(runId, undefined, {
              protocol: 'acp',
              agent_kind: spec.kind as AcpAgentKind,
              session_id: sessionId,
            });
          },
        });
        acpSessionId = result.sessionId;
        return result;
      }
      return runCli(
        spec,
        prompt,
        payload.automation.execution_config,
        resolveDeviceAgentRunAccess(
          payload.context.agent_session,
          client.mcpWiring
        ),
        timeoutMs,
        cfg.binaryOverrides?.[spec.kind],
        runAbort.signal,
        cfg.shutdownSignal,
        cfg.terminalHeartbeatGraceMs
      );
    },
    deliver: async (result, finalizeAttempt) => {
      const report = await deliverExitReport(client, runId, result, finalizeAttempt);
      if (report && report.status !== 'resume' && result.transcriptJsonl && agentSession) {
        const terminalStatus =
          report.status === 'completed'
            ? 'completed'
            : report.status === 'cancelled' || result.exitReason === 'cancelled'
              ? 'cancelled'
              : result.exitReason === 'timeout'
                ? 'timeout'
                : 'failed';
        let transcriptError: unknown;
        for (let attempt = 0; attempt < TRANSCRIPT_DELIVERY_ATTEMPTS; attempt++) {
          try {
            await client.writeAutomationTranscript(
              runId,
              agentSession.token,
              terminalStatus,
              result.transcriptJsonl
            );
            transcriptError = undefined;
            break;
          } catch (error) {
            transcriptError = error;
            if (attempt + 1 < TRANSCRIPT_DELIVERY_ATTEMPTS) {
              await sleep(TRANSCRIPT_RETRY_DELAY_MS);
            }
          }
        }
        if (transcriptError) {
          log.info(
            `[executor] Automation run ${runId}: terminal ACP transcript upload failed: ${transcriptError instanceof Error ? transcriptError.message : String(transcriptError)}`
          );
        }
      }
      return report;
    },
    reportError: (error, reason) =>
      completeAutomationWithError(client, runId, error, reason),
  };

  try {
    return await dispatchAutomationResumeLoop(io);
  } finally {
    monitor.stop();
  }
}

/** Spawn → exit report → resume loop, mirroring `AutomationDispatcher.dispatch`. */
export async function dispatchAutomationResumeLoop(
  io: AutomationRunIo
): Promise<{ itemsCollected: number; error?: string }> {
  let finalizeNudge: string | undefined;
  let finalizeAttempt = 0;

  for (let round = 0; round < LOCAL_MAX_ROUNDS; round++) {
    let result: ExecutorResult;
    try {
      result = await io.run(finalizeNudge);
    } catch (err) {
      if (err instanceof AutomationRunNoLongerActiveError) {
        // The terminal heartbeat landed before this round spawned, so there is
        // no local process exit or device metadata to report.
        return { itemsCollected: 0 };
      }
      // Unambiguous: nothing has been reported yet. Missing binary is a
      // configuration problem, not a crash.
      const reason: WorkerExitReason =
        err instanceof ExecutableNotFoundError ? 'error_message' : 'crash';
      const message = err instanceof Error ? err.message : String(err);
      await io.reportError(message, reason);
      return { itemsCollected: 0, error: message };
    }

    const report = await io.deliver(result, finalizeAttempt);
    if (!report) {
      // Outcome unknown after the retry budget. Leave the run claimed and say
      // nothing: heartbeats stop when we return, so the server's heartbeat-stale
      // reaper reclaims it in minutes if the report never landed.
      log.info(
        '[executor] Automation run exit report undelivered — leaving the run to the server sweep'
      );
      return { itemsCollected: 0 };
    }

    if (report.status === 'resume') {
      finalizeNudge =
        report.nudge ??
        report.error ??
        'Prior attempt did not call completeWindow. Finalize via lobu CLI or MCP.';
      finalizeAttempt = report.attempt ?? finalizeAttempt + 1;
      continue;
    }
    return { itemsCollected: 0 };
  }

  // Every path out of the loop is a delivered report that came back `resume`:
  // the server granted past its own budget. Report the honest description.
  const message = `device finalize resume loop exceeded local safety cap (${LOCAL_MAX_ROUNDS})`;
  await io.reportError(message, 'error_message');
  return { itemsCollected: 0, error: message };
}

/** Post one exit report, re-sending on retriable failures. */
export async function deliverExitReport(
  client: ExecutorClient,
  runId: number,
  result: ExecutorResult,
  finalizeAttempt: number
): Promise<CompleteAutomationResponse | null> {
  for (let attempt = 0; attempt < EXIT_REPORT_DELIVERY_ATTEMPTS; attempt++) {
    try {
      return await client.completeAutomation(runId, {
        worker_id: client.id,
        output: result.output,
        error: result.error ?? undefined,
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        exit_signal: result.exitSignal,
        exit_reason: result.exitReason,
        finalize_attempt: finalizeAttempt,
      });
    } catch (err) {
      const retriable = isRetriableDeliveryFailure(err);
      log.debug(
        `[executor] Automation run=${runId} exit report delivery failed ` +
          `(try ${attempt + 1}/${EXIT_REPORT_DELIVERY_ATTEMPTS}, retriable=${retriable ? 'yes' : 'no'}): ` +
          (err instanceof Error ? err.message : String(err))
      );
      if (!retriable) return null;
      if (attempt + 1 < EXIT_REPORT_DELIVERY_ATTEMPTS) {
        await sleep(EXIT_REPORT_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  return null;
}

/** Best-effort: tell the server this run failed locally so it does not sit
 * `running` forever. */
async function completeAutomationWithError(
  client: ExecutorClient,
  runId: number,
  error: string,
  exitReason: WorkerExitReason
): Promise<void> {
  try {
    await client.completeAutomation(runId, {
      worker_id: client.id,
      output: '',
      error,
      duration_ms: 0,
      exit_reason: exitReason,
    });
  } catch {
    // Swallowed — the run times out server-side via the heartbeat watchdog.
  }
}
