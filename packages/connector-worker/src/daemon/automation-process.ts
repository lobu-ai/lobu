/**
 * OS process supervision for the device Automation arm.
 *
 * Kept separate from automation.ts so spawn/heartbeat/resume policy does not
 * share a control-flow surface with POSIX group ownership and Windows tree
 * termination.
 */

import { type ChildProcess, spawn } from 'node:child_process';

const SUPPORTS_PROCESS_GROUPS = process.platform !== 'win32';
const TREE_TERM_GRACE_MS = 3000;
const PROCESS_REAP_GRACE_MS = 5000;

/**
 * Keep a process-group leader alive after the actual CLI exits. The daemon can
 * then clean up descendants through an identity that the kernel cannot recycle
 * underneath it. The supervisor deliberately ignores SIGTERM; the CLI and its
 * descendants still receive the group signal, while the supervisor remains the
 * ownership anchor until the daemon releases or SIGKILLs it.
 *
 * POSIX caller contract: run this in a process of its own, spawned with
 * `detached: true`, so the supervisor is the session/process-group leader whose
 * pgid equals its pid. Its parent-loss path uses that invariant for safe
 * negative-pid group signals. Keep the body closure-free: one launch mechanism
 * serializes it through `toString()`.
 */
function runCliSupervisor(spawnChild: typeof spawn, treeTermGraceMs: number, argv: string[]): void {
  const [binary, ...args] = argv;
  let targetFinished = false;
  let parentLost = false;
  let target: ChildProcess | undefined;
  const keepAlive = setInterval(() => {}, 2147483647);
  const send = (message: Record<string, unknown>) => {
    try { process.send?.(message); } catch {}
  };
  const finish = (
    code: number | null,
    signal: NodeJS.Signals | null,
    error: string | null,
    errorCode: string | null,
    stage: TargetExitStage
  ) => {
    if (targetFinished) return;
    targetFinished = true;
    if (!parentLost)
      send({ type: 'target-exit', code, signal, error, errorCode, stage });
  };
  const stopAfterParentLoss = () => {
    if (parentLost) return;
    parentLost = true;
    clearInterval(keepAlive);

    if (process.platform === 'win32') {
      // Keep this process alive as the tree root until taskkill gets its chance.
      // The timer is deliberately ref'ed: parent loss must not let the supervisor
      // exit before the owned CLI tree has been addressed.
      try {
        const killer = spawnChild('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => {});
      } catch {}
      setTimeout(() => {
        try { target?.kill('SIGKILL'); } catch {}
        process.exit(1);
      }, treeTermGraceMs);
      return;
    }

    // This detached supervisor is still the live session/group leader, so its
    // own negative pid cannot have been recycled. Ignore SIGTERM here while the
    // target and descendants get a graceful window, then kill the complete group
    // including this anchor so parent loss cannot leave an immortal orphan.
    try {
      process.kill(-process.pid, 'SIGTERM');
    } catch {
      try { target?.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        try { target?.kill('SIGKILL'); } catch {}
        process.exit(1);
      }
    }, treeTermGraceMs);
  };
  process.on('SIGTERM', () => {});
  process.once('disconnect', stopAfterParentLoss);
  // A broken parent pipe is parent loss for ownership purposes. Do not report
  // the target's normal exit first: the gateway may release the run while the
  // delayed whole-tree SIGKILL is still pending, orphaning TERM-ignoring
  // descendants.
  process.stdin.once('error', stopAfterParentLoss);
  process.on('message', (message: unknown) => {
    if (
      typeof message !== 'object' ||
      message == null ||
      (message as Record<string, unknown>).type !== 'release' ||
      !targetFinished
    ) return;
    clearInterval(keepAlive);
    process.exit(0);
  });
  if (!binary) {
    finish(127, null, 'automation supervisor missing target binary', null, 'target_spawn');
  } else {
    try {
      target = spawnChild(binary, args, {
        env: process.env,
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true,
      });
      if (target.stdin) {
        target.stdin.on('error', () => {});
        process.stdin.pipe(target.stdin);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      finish(
        127,
        null,
        error instanceof Error ? error.message : String(error),
        typeof code === 'string' ? code : null,
        'target_spawn'
      );
    }
    target?.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(
        127,
        null,
        error.message,
        typeof code === 'string' ? code : null,
        'target_spawn'
      );
    });
    target?.once('exit', (code, signal) =>
      finish(code, signal, null, null, 'target_exit')
    );
  }
  setImmediate(() => {
    if (!process.connected) stopAfterParentLoss();
  });
}

export const CLI_SUPERVISOR_SOURCE = `(${runCliSupervisor.toString()})(require('node:child_process').spawn, ${TREE_TERM_GRACE_MS}, process.argv.slice(1));`;

// `-e CLI_SUPERVISOR_SOURCE` needs a runtime that evaluates source from the
// command line, which every host running this package from source or a Node
// bundle has. A `bun build --compile` artifact cannot re-enter itself that way,
// so its entrypoint registers a self-exec command instead: the same supervisor,
// reached through the executable's own internal argument. Set once at startup,
// before any job is admitted, and process-local by construction.
let supervisorCommand: { command: string; prefix: readonly string[] } | undefined;

export function configureCliSupervisorCommand(command: string, prefix: readonly string[]): void {
  supervisorCommand = { command, prefix: [...prefix] };
}

/** Entrypoint-side landing for the self-exec command above. */
export function runPackagedCliSupervisor(argv: string[]): void {
  runCliSupervisor(spawn, TREE_TERM_GRACE_MS, argv);
}

export type TargetExitStage =
  | 'target_exit'
  | 'target_spawn'
  | 'supervisor_spawn'
  | 'supervisor_exit';

export interface TargetExit {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  error: string | null;
  errorCode: string | null;
  stage: TargetExitStage;
}

interface SupervisedCli {
  supervisor: ChildProcess;
  targetExit: Promise<TargetExit>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the supervised CLI to exit, the timeout to lapse, or cancellation. */
export function waitForTargetExit(
  targetExit: Promise<TargetExit>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{ timedOut: boolean; aborted: boolean; target?: TargetExit }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: {
      timedOut: boolean;
      aborted: boolean;
      target?: TargetExit;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => settle({ timedOut: false, aborted: true });
    const timer = setTimeout(() => {
      settle({ timedOut: true, aborted: false });
    }, timeoutMs);
    timer.unref?.();
    targetExit.then((target) => settle({ timedOut: false, aborted: false, target }));
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Await the target metadata after process-tree termination. */
export async function waitForTargetExitAfterTermination(
  targetExit: Promise<TargetExit>,
  timeoutMs = PROCESS_REAP_GRACE_MS
): Promise<TargetExit | null> {
  const { target } = await waitForTargetExit(targetExit, timeoutMs);
  return target ?? null;
}

/** Wait a bounded interval for a signal sent to the child to take effect. */
function waitForSignalledExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    proc.once('exit', onExit);
  });
}

type ProcessGroupOwner = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;

/**
 * Signal a POSIX group only while its supervisor is a live ownership anchor.
 * Once the anchor has exited, its numeric pid/pgid may refer to an unrelated
 * future process group and must never be used as a negative-pid signal target.
 * Exported only so the PID-reuse safety invariant has a direct regression test.
 */
export function signalOwnedPosixProcessGroup(
  owner: ProcessGroupOwner,
  signal: NodeJS.Signals,
  sendSignal: typeof process.kill = process.kill
): boolean {
  if (
    !SUPPORTS_PROCESS_GROUPS ||
    owner.pid == null ||
    owner.exitCode !== null ||
    owner.signalCode !== null
  ) {
    return false;
  }
  try {
    sendSignal(-owner.pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH is the only "there is no group here" answer, and it is the only one
    // that may return false: the caller reads false as "no owned group", skips
    // the grace window and never escalates to SIGKILL.
    if (code === 'ESRCH') return false;
    // EPERM means the opposite — the group EXISTS, we just could not signal any
    // member of it (a setuid'd descendant, say). Reporting that as "gone" would
    // retire the tree from escalation while it is still running, so keep the
    // caller on the owned-group path: the SIGKILL escalation may still land,
    // and the supervisor itself is ours to kill directly if it does not.
    if (code === 'EPERM') return true;
    throw err;
  }
}

/** Ask the supervisor to release its non-reusable group identity and reap it. */
export async function releaseSupervisor(proc: ChildProcess, timeoutMs = 1000): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  let sent = false;
  try {
    if (proc.connected) {
      proc.send?.({ type: 'release' });
      sent = true;
    }
  } catch {}
  if (sent && (await waitForSignalledExit(proc, timeoutMs))) return true;
  // Direct ChildProcess.kill uses the still-owned process handle; never turn a
  // failed release into a negative-pgid signal after the anchor might be gone.
  proc.kill('SIGKILL');
  await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
  return false;
}

/** Windows has no negative-pid process groups; taskkill supplies bounded tree cleanup. */
function taskkillWindowsTree(proc: ChildProcess, force: boolean): Promise<boolean> {
  if (proc.pid == null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const killer = spawn(
      'taskkill',
      ['/PID', String(proc.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true }
    );
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killer.kill();
      settle(false);
    }, 3000);
    timer.unref?.();
    killer.once('error', () => settle(false));
    killer.once('exit', (code) => settle(code === 0));
  });
}

/**
 * Keep the supervisor alive until Windows has had its forced tree-kill chance.
 * Killing only the supervisor after a failed graceful `taskkill /T` would
 * orphan the real CLI and make its numeric tree root unusable. Exported, with
 * its collaborators injectable, only so that ordering is testable off Windows.
 */
export async function terminateWindowsProcessTree(
  proc: ChildProcess,
  terminateTree: typeof taskkillWindowsTree = taskkillWindowsTree,
  waitForExit: typeof waitForSignalledExit = waitForSignalledExit
): Promise<'SIGTERM' | 'SIGKILL'> {
  const gracefulTreeKillSent = await terminateTree(proc, false);
  if (gracefulTreeKillSent && (await waitForExit(proc, TREE_TERM_GRACE_MS))) return 'SIGTERM';

  // If taskkill itself is unavailable, direct ChildProcess.kill remains the
  // best-effort fallback. It cannot guarantee cleanup of an already-orphaned
  // descendant, so use it only after the forced tree attempt has failed.
  if (!(await terminateTree(proc, true))) proc.kill('SIGKILL');
  await waitForExit(proc, PROCESS_REAP_GRACE_MS);
  return 'SIGKILL';
}

/**
 * Stop the complete CLI process tree, escalating to SIGKILL if any POSIX group
 * member ignores SIGTERM. Returns the signal that actually ended it, which the
 * timeout branch reports as `exit_signal`.
 */
export async function terminateChild(proc: ChildProcess): Promise<'SIGTERM' | 'SIGKILL'> {
  if (SUPPORTS_PROCESS_GROUPS) {
    if (!signalOwnedPosixProcessGroup(proc, 'SIGTERM')) {
      proc.kill('SIGTERM');
      await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
      return 'SIGTERM';
    }
    // The supervisor deliberately survives SIGTERM, keeping the pgid owned for
    // the complete grace window. Escalating that still-owned group avoids both
    // PID reuse and the process-table scan/freeze/recount machinery that an
    // early release would require.
    await sleep(TREE_TERM_GRACE_MS);
    if (!signalOwnedPosixProcessGroup(proc, 'SIGKILL')) proc.kill('SIGKILL');
    await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
    return 'SIGKILL';
  }

  return terminateWindowsProcessTree(proc);
}

/** Spawn the real CLI beneath a persistent process-group ownership anchor. */
export function spawnSupervisedCli(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { stdin?: 'ignore' | 'pipe'; cwd?: string } = {}
): SupervisedCli {
  const supervisor = spawn(
    supervisorCommand?.command ?? process.execPath,
    [...(supervisorCommand?.prefix ?? ['-e', CLI_SUPERVISOR_SOURCE, '--']), binary, ...args],
    {
      detached: SUPPORTS_PROCESS_GROUPS,
      env,
      cwd: options.cwd,
      stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }
  );
  const targetExit = new Promise<TargetExit>((resolve) => {
    let settled = false;
    const settle = (target: TargetExit) => {
      if (settled) return;
      settled = true;
      resolve(target);
    };
    supervisor.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message == null) return;
      const value = message as Record<string, unknown>;
      if (value.type !== 'target-exit') return;
      const stage =
        value.stage === 'target_exit' || value.stage === 'target_spawn'
          ? value.stage
          : 'target_exit';
      settle({
        exitCode: typeof value.code === 'number' ? value.code : null,
        signalCode:
          typeof value.signal === 'string'
            ? (value.signal as NodeJS.Signals)
            : null,
        error: typeof value.error === 'string' ? value.error : null,
        errorCode:
          typeof value.errorCode === 'string' ? value.errorCode : null,
        stage,
      });
    });
    supervisor.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      settle({
        exitCode: null,
        signalCode: null,
        error: error.message,
        errorCode: typeof code === 'string' ? code : null,
        stage: 'supervisor_spawn',
      });
    });
    supervisor.once('exit', (code, signal) => {
      settle({
        exitCode: code,
        signalCode: signal,
        error:
          'automation process supervisor exited before reporting the CLI outcome',
        errorCode: null,
        stage: 'supervisor_exit',
      });
    });
  });
  return { supervisor, targetExit };
}
