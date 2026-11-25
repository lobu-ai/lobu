import { classifyToolError, type ToolErrorCode } from '@lobu/core/connector-query-errors';
import { monitorActionRun } from '../action-monitor.js';
import type { ExecutorClient, PollResponse } from '../client.js';
import { log } from '../log.js';
import { completeActionOnce } from '../terminal-delivery.js';
import {
  ShellInputError,
  type ShellPlatform,
  type ShellRunOutput,
  runShellBuiltin,
  shellTimeoutMs,
} from './os-shell.js';

export type DaemonBuiltinErrorCode =
  | 'invalid_operation_input'
  | 'operation_backend_unavailable'
  | 'operation_execution_failed';

export type DaemonBuiltinResult =
  | { ok: true; output: Record<string, unknown> }
  | {
      ok: false;
      code: DaemonBuiltinErrorCode;
      error: string;
      output?: Record<string, unknown>;
      /** The gateway-facing code, when the failure's structure names its cause. */
      errorCode?: ToolErrorCode;
    };

/**
 * The typed cause of a failed shell run, from its exit structure. A command
 * that ran and exited non-zero was refused by its target; one that ran out of
 * its budget timed out, which the shared classifier maps exactly as it does
 * for every other device action. A spawn fault or a signal death is the
 * host's, and stays unclassified.
 */
function shellFailureCode(output: ShellRunOutput): ToolErrorCode | undefined {
  if (output.timed_out) return classifyToolError({ exitReason: 'timeout' });
  if (output.process_error || output.exit_signal) return undefined;
  return output.exit_code !== 0 ? 'ACTION_FAILED' : undefined;
}

function describeShellFailure(output: ShellRunOutput, timeoutMs: number): string {
  if (output.timed_out) {
    // Name the budget the caller set. The wall time also covers the TERM
    // grace before the process group is killed, so reporting it alone reads
    // as a budget a few seconds larger than the one requested.
    return `Shell command timed out after ${timeoutMs}ms (stopped at ${output.duration_ms}ms, including termination grace)`;
  }
  if (output.process_error) {
    const code = output.process_error_code
      ? ` (${output.process_error_code})`
      : '';
    const prefix =
      output.process_stage === 'supervisor_spawn'
        ? 'Shell supervisor failed to start'
        : output.process_stage === 'target_spawn'
          ? 'Shell command failed to start'
          : output.process_stage === 'supervisor_exit'
            ? 'Shell supervisor exited before reporting the command outcome'
            : output.process_stage === 'shutdown'
              ? 'Shell command was aborted during daemon shutdown'
              : 'Shell execution failed';
    return `${prefix}${code}: ${output.process_error}`;
  }
  if (output.exit_signal) {
    return `Shell command terminated by ${output.exit_signal}`;
  }
  // After the failures that name their own cause -- a signal death that also
  // left survivors is reported as the signal death, with `reaped_descendants`
  // still on the output -- but before the exit-code default: a reaped run
  // exits 0, so falling through would report "exited with code 0" as the
  // reason it failed, the silent loss #3629 exists to remove.
  if (output.reaped_descendants) {
    return `Shell command exited with code ${output.exit_code} but left background processes running in its process group; they were killed when the command returned. A command's background work does not outlive the call -- hand a durable process to a host service manager instead.`;
  }
  return `Shell command exited with code ${output.exit_code}`;
}

/**
 * Every connector action this daemon implements in-process, keyed
 * `<connectorKey>/<actionKey>`.
 *
 * This registry is the daemon's ANSWER to "can I run this?", and nothing else
 * is. The gateway used to answer it instead, by shipping a routing marker
 * derived from the connector's manifest — which forced the implementation into
 * the manifest, and therefore into the manifest hash, so the same contract
 * could not be offered by a second endpoint. Routing is local; the contract is
 * shared.
 */
const DAEMON_BUILTINS: Record<
  string,
  (
    input: Record<string, unknown>,
    shutdownSignal: AbortSignal | undefined,
    platform: ShellPlatform
  ) => Promise<ShellRunOutput>
> = {
  'os.shell/run': runShellBuiltin,
};

function builtinId(connectorKey: string, actionKey: string): string {
  return `${connectorKey}/${actionKey}`;
}

/** Whether this daemon implements one exact connector action itself. */
export function hasDaemonBuiltin(connectorKey: string, actionKey: string): boolean {
  return Object.hasOwn(DAEMON_BUILTINS, builtinId(connectorKey, actionKey));
}

/**
 * Whether this daemon implements any action of a connector. A run of another
 * kind (a feed sync, an auth exchange) against such a connector is a routing
 * fault rather than work to attempt over the compiled runtime, which has no
 * code for it.
 */
export function hasDaemonBuiltinConnector(connectorKey: string): boolean {
  const prefix = `${connectorKey}/`;
  return Object.keys(DAEMON_BUILTINS).some((id) => id.startsWith(prefix));
}

export async function executeDaemonBuiltin(params: {
  connectorKey: string;
  actionKey: string;
  input: Record<string, unknown>;
  shutdownSignal?: AbortSignal;
  platform?: ShellPlatform;
}): Promise<DaemonBuiltinResult> {
  const builtin = DAEMON_BUILTINS[builtinId(params.connectorKey, params.actionKey)];
  if (!builtin) {
    return {
      ok: false,
      code: 'operation_backend_unavailable',
      error: `No daemon built-in is registered for '${params.connectorKey}/${params.actionKey}'`,
    };
  }

  try {
    const output = await builtin(params.input, params.shutdownSignal, params.platform ?? 'headless');
    if (!output.success) {
      const errorCode = shellFailureCode(output);
      return {
        ok: false,
        code: 'operation_execution_failed',
        error: describeShellFailure(output, shellTimeoutMs(params.input.timeout_ms)),
        output: { ...output },
        ...(errorCode ? { errorCode } : {}),
      };
    }
    return { ok: true, output: { ...output } };
  } catch (error) {
    // Only the builtin's own argument checks are input faults. Anything else
    // reaching here -- a spawn failure, an ENOTDIR on a cwd that turned out to
    // be a file -- is an execution fault, and reporting it as bad input would
    // send the caller off to fix a payload that was fine.
    const inputFault = error instanceof ShellInputError;
    return {
      ok: false,
      code: inputFault ? 'invalid_operation_input' : 'operation_execution_failed',
      error: error instanceof Error ? error.message : String(error),
      ...(inputFault ? { errorCode: 'VALIDATION' as const } : {}),
    };
  }
}

/** Run one claimed built-in action and report its single terminal result. */
export async function executeDaemonBuiltinActionRun(
  client: ExecutorClient,
  job: PollResponse,
  cfg: { heartbeatIntervalMs: number; shutdownSignal?: AbortSignal; platform?: ShellPlatform }
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

  const monitor = monitorActionRun(client, run_id, cfg);

  try {
    const result = await executeDaemonBuiltin({
      connectorKey: connector_key,
      actionKey: action_key,
      input: (action_input ?? {}) as Record<string, unknown>,
      shutdownSignal: monitor.signal,
      ...(cfg.platform ? { platform: cfg.platform } : {}),
    });
    if (monitor.revoked()) return { itemsCollected: 0 };
    if (!result.ok) {
      const message = `${result.code}: ${result.error}`;
      await completeActionOnce(client, {
        run_id,
        worker_id: client.id,
        status: 'failed',
        error_message: message,
        ...(result.output ? { action_output: result.output } : {}),
        ...(result.errorCode ? { error_code: result.errorCode } : {}),
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
    monitor.stop();
  }
}
