/**
 * os.shell as a daemon builtin — the ONLY implementation.
 *
 * Every endpoint that offers the shared `os.shell` contract implements it
 * locally: this file on a headless server/VM/pod, the Mac app's own bridge on a
 * Mac. Neither implementation is named in the contract — it is hashed, and a
 * contract that carried its implementation could not be offered by both. There
 * is deliberately no gateway-compiled connector either: shell execution needs a
 * real process, which the isolate lane does not have, and running it on the
 * daemon's own supervisor is what lets a device whose connector compiler is
 * broken still be recovered.
 *
 * Keep the CONTRACT — the argv (`bash --noprofile --norc -c`), the timeout
 * bounds, the 1MB output cap and the returned shape — in step with
 * the generated headless manifest in `../device-manifests.ts`, which is what the
 * gateway and the agent see.
 *
 * This runs in the daemon's own process, so it REPLACES the environment rather
 * than inheriting it: an inherited env would hand the command the daemon's
 * credentials.
 *
 * LIFETIME: a run owns a process group for the duration of the call and no
 * longer. Everything still in that group when the command returns is killed,
 * which is what keeps a daemon from leaking processes, and it means `&`,
 * `nohup` and `setsid` do not buy a caller a surviving daemon. That cleanup is
 * deliberate; what was a bug (#3629) is doing it QUIETLY -- a run used to
 * report exit 0 while the poller it had just launched was being killed, so the
 * loss surfaced as an unrelated failure much later. A run that leaves
 * background work now reports `reaped_descendants` and fails. Callers that
 * need a durable process hand it to a host service manager; this contract
 * deliberately offers no detached-lifetime primitive.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  type TargetExit,
  countOwnedGroupSurvivors,
  releaseSupervisor,
  signalOwnedPosixProcessGroup,
  spawnSupervisedCli,
  terminateChild,
} from '../automation-process.js';

/**
 * A caller-supplied argument the builtin rejects before spawning anything.
 * Distinguishes an input fault from a runtime one so the caller can classify
 * the failure instead of assuming every throw came from validation.
 */
export class ShellInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellInputError';
  }
}

export interface ShellRunOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  exit_signal?: NodeJS.Signals;
  process_error?: string;
  process_error_code?: string;
  process_stage?:
    | TargetExit['stage']
    | 'timeout'
    | 'shutdown'
    | 'descendants_reaped';
  /**
   * Set when the command exited while background work it started was still
   * running inside the owned process group, and that work was therefore killed
   * during cleanup. Absent -- never `false` -- on the ordinary path, so the
   * field only ever appears when there is something to report.
   */
  reaped_descendants?: boolean;
  success: boolean;
  timed_out: boolean;
  duration_ms: number;
}

interface TerminatedShellOutcome {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  error: string | null;
  errorCode: string | null;
  stage: 'timeout' | 'shutdown';
}

const DEFAULT_TIMEOUT_MS = 60_000;
// The requested command budget must leave room inside run_sdk's 180s ceiling
// for 3s TERM grace, up to 5s reaping, up to 15s terminal delivery, and
// bounded network/server grace.
const MAX_TIMEOUT_MS = 150_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_DRAIN_GRACE_MS = 2_000;
const TRUNCATED_MARKER = '\n... (output truncated)';
function appendCapped(current: string, chunk: string): string {
  if (current.endsWith(TRUNCATED_MARKER)) return current;
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= MAX_OUTPUT_BYTES) return next;
  return Buffer.from(next, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + TRUNCATED_MARKER;
}

function readTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > MAX_TIMEOUT_MS) {
    throw new ShellInputError(`timeout_ms must be an integer between 100 and ${MAX_TIMEOUT_MS}`);
  }
  return Number(value);
}

function shellEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
  };
  return env;
}

export async function runShellBuiltin(
  input: Record<string, unknown>,
  shutdownSignal?: AbortSignal
): Promise<ShellRunOutput> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) throw new ShellInputError('command is required');
  if (command.length > 20_000)
    throw new ShellInputError('command must contain at most 20000 characters');

  const cwdValue = input.cwd;
  const cwd = cwdValue === undefined ? homedir() : String(cwdValue);
  if (!isAbsolute(cwd) || !existsSync(cwd)) {
    throw new ShellInputError(`cwd must be an existing absolute path (got '${cwd}')`);
  }
  const timeoutMs = readTimeout(input.timeout_ms);
  const stdin = input.stdin;
  if (stdin !== undefined && typeof stdin !== 'string')
    throw new ShellInputError('stdin must be a string');
  if (typeof stdin === 'string' && stdin.length > 1_000_000) {
    throw new ShellInputError('stdin must contain at most 1000000 characters');
  }

  const startedAt = Date.now();
  return await new Promise<ShellRunOutput>((resolve) => {
    let supervised: ReturnType<typeof spawnSupervisedCli>;
    try {
      supervised = spawnSupervisedCli(
        'bash',
        ['--noprofile', '--norc', '-c', command],
        shellEnvironment(),
        { stdin: 'pipe', cwd }
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      resolve({
        stdout: '',
        stderr: '',
        exit_code: -1,
        process_error: error instanceof Error ? error.message : String(error),
        ...(typeof code === 'string' ? { process_error_code: code } : {}),
        process_stage: 'supervisor_spawn',
        success: false,
        timed_out: false,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }
    const child = supervised.supervisor;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let reapedDescendants = false;
    let settled = false;
    let finishing = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const waitForClose = (
      stream: NodeJS.ReadableStream | null | undefined
    ): Promise<void> => {
      if (
        !stream ||
        (stream as NodeJS.ReadableStream & { destroyed?: boolean }).destroyed
      ) {
        return Promise.resolve();
      }
      return new Promise((resolve) => stream.once('close', resolve));
    };
    const stdoutClosed = waitForClose(child.stdout);
    const stderrClosed = waitForClose(child.stderr);

    const reserveFinish = (): boolean => {
      if (settled || finishing) return false;
      finishing = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      shutdownSignal?.removeEventListener('abort', abortHandler);
      return true;
    };

    const finish = (outcome: TargetExit | TerminatedShellOutcome): void => {
      if (settled) return;
      settled = true;
      resolve({
        stdout,
        stderr,
        exit_code: outcome.exitCode ?? -1,
        ...(outcome.signalCode ? { exit_signal: outcome.signalCode } : {}),
        ...(outcome.error ? { process_error: outcome.error } : {}),
        ...(outcome.errorCode
          ? { process_error_code: outcome.errorCode }
          : {}),
        ...(reapedDescendants
          ? { process_stage: 'descendants_reaped' as const }
          : outcome.stage !== 'target_exit' ||
              outcome.signalCode ||
              outcome.error
            ? { process_stage: outcome.stage }
            : {}),
        ...(reapedDescendants ? { reaped_descendants: true } : {}),
        // Killing work the caller deliberately backgrounded is not a success,
        // whatever the shell's own exit code said. Reporting it as one is the
        // whole of #3629: the caller banked a launch that no longer exists.
        success:
          !timedOut &&
          !reapedDescendants &&
          outcome.exitCode === 0 &&
          outcome.signalCode === null &&
          outcome.error === null,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
      });
    };

    const finishAfterOutputDrain = async (
      outcome: TargetExit | TerminatedShellOutcome
    ): Promise<void> => {
      await Promise.race([
        Promise.all([stdoutClosed, stderrClosed]),
        new Promise((resolve) =>
          setTimeout(resolve, OUTPUT_DRAIN_GRACE_MS).unref()
        ),
      ]);
      if (!settled) child.stdout?.destroy();
      if (!settled) child.stderr?.destroy();
      finish(outcome);
    };

    const terminateAndFinish = (
      stage: TerminatedShellOutcome['stage'],
      error: string | null
    ): void => {
      if (!reserveFinish()) return;
      void terminateChild(child)
        .then((signal) =>
          finishAfterOutputDrain({
            exitCode: child.exitCode,
            signalCode: child.signalCode ?? signal,
            error,
            errorCode: null,
            stage,
          })
        )
        .catch((terminationError) => {
          const code = (terminationError as NodeJS.ErrnoException).code;
          return finishAfterOutputDrain({
            exitCode: child.exitCode,
            signalCode: child.signalCode,
            error:
              terminationError instanceof Error
                ? terminationError.message
                : String(terminationError),
            errorCode: typeof code === 'string' ? code : null,
            stage,
          });
        });
    };

    const abortHandler = () => {
      terminateAndFinish(
        'shutdown',
        'shell execution aborted during daemon shutdown'
      );
    };
    // Let all finish closures initialize before handling an already-aborted
    // signal; this path is common during daemon shutdown.
    if (shutdownSignal?.aborted) queueMicrotask(abortHandler);
    else shutdownSignal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE')
        stderr = appendCapped(stderr, `stdin error: ${error.message}\n`);
    });
    child.stdin?.end(stdin);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateAndFinish('timeout', null);
    }, timeoutMs);

    supervised.targetExit.then((target) => {
      if (!reserveFinish()) return;
      if (target.stage === 'supervisor_spawn') {
        void finishAfterOutputDrain(target);
        return;
      }
      // Only the group this daemon owns. A command that deliberately detaches a
      // new session is outside that ownership contract and belongs to whoever
      // created it: signalling a numeric PGID we no longer own risks hitting a
      // reused one, so ownership ending is the end of our reach.
      if (process.platform !== 'win32') {
        // Ask BEFORE the group SIGKILL: afterwards there is nothing left to
        // count, and the caller would be told a clean exit either way.
        reapedDescendants = countOwnedGroupSurvivors(child) > 0;
        try {
          if (
            child.pid == null ||
            !signalOwnedPosixProcessGroup(child, 'SIGKILL')
          ) {
            child.kill('SIGKILL');
          }
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      } else {
        void terminateChild(child);
      }
      void releaseSupervisor(child).finally(() =>
        finishAfterOutputDrain(target)
      );
    });
  });
}
