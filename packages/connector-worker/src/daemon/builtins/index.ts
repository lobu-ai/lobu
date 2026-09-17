import { ShellInputError, type ShellRunOutput, runShellBuiltin } from './os-shell.js';

export type DaemonBuiltinErrorCode =
  | 'invalid_operation_input'
  | 'operation_backend_unavailable'
  | 'operation_execution_failed';

export type DaemonBuiltinResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; code: DaemonBuiltinErrorCode; error: string; output?: Record<string, unknown> };

function describeShellFailure(output: ShellRunOutput): string {
  if (output.timed_out) {
    return `Shell command timed out after ${output.duration_ms}ms`;
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
  (input: Record<string, unknown>, shutdownSignal?: AbortSignal) => Promise<ShellRunOutput>
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
    const output = await builtin(params.input, params.shutdownSignal);
    if (!output.success) {
      return {
        ok: false,
        code: 'operation_execution_failed',
        error: describeShellFailure(output),
        output: { ...output },
      };
    }
    return { ok: true, output: { ...output } };
  } catch (error) {
    // Only the builtin's own argument checks are input faults. Anything else
    // reaching here -- a spawn failure, an ENOTDIR on a cwd that turned out to
    // be a file -- is an execution fault, and reporting it as bad input would
    // send the caller off to fix a payload that was fine.
    return {
      ok: false,
      code: error instanceof ShellInputError ? 'invalid_operation_input' : 'operation_execution_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
