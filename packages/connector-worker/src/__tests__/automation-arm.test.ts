import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEVICE_AGENT_SPECS_BY_KIND } from '@lobu/core/contracts/worker/device-automation';
import type {
  CompleteAutomationResponse,
} from '@lobu/core/contracts/worker/protocol';
import {
  type AutomationRunIo,
  buildArguments,
  deliverExitReport,
  dispatchAutomationResumeLoop,
  runCli,
  type ExecutorResult,
} from '../daemon/automation.js';
import {
  signalOwnedPosixProcessGroup,
  terminateWindowsProcessTree,
  waitForTargetExitAfterTermination,
} from '../daemon/automation-process.js';
import {
  type ExecutorClient,
  interpretCompleteAutomationResponse,
  WorkerDecodeError,
  WorkerHttpError,
} from '../daemon/client.js';

function okResult(): ExecutorResult {
  return {
    output: 'done',
    error: null,
    exitCode: 0,
    exitSignal: null,
    exitReason: 'ok',
    durationMs: 1,
  };
}

describe('POSIX process-group ownership', () => {
  test('shutdown abort terminates the supervised CLI and reports cancellation', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-shutdown-cli-'));
    const terminated = path.join(dir, 'terminated');
    const fake = path.join(dir, 'pi');
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'started'))}, 'started');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(terminated)}, 'terminated'); process.exit(0); });
setInterval(() => {}, 1000);
`
    );
    chmodSync(fake, 0o755);
    const controller = new AbortController();
    try {
      const running = runCli(
        DEVICE_AGENT_SPECS_BY_KIND.get('pi')!,
        'run',
        undefined,
        { wiring: undefined, env: {} },
        10_000,
        fake,
        controller.signal,
        controller.signal
      );
      for (let attempt = 0; attempt < 80 && !existsSync(path.join(dir, 'started')); attempt += 1) {
        await Bun.sleep(25);
      }
      expect(existsSync(path.join(dir, 'started'))).toBe(true);
      controller.abort();
      const result = await running;
      expect(result.exitReason).toBe('cancelled');
      expect(readFileSync(terminated, 'utf8')).toBe('terminated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('an exited supervisor never signals a numerically reused process group', () => {
    if (process.platform === 'win32') return;
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const sendSignal = ((pid: number, signal: NodeJS.Signals | number) => {
      signals.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    // Model the exact reuse hazard: the old ChildProcess still carries 4242,
    // but exitCode proves its ownership ended and a new group may now own 4242.
    const staleOwner = { pid: 4242, exitCode: 0, signalCode: null };
    expect(signalOwnedPosixProcessGroup(staleOwner, 'SIGKILL', sendSignal)).toBe(false);
    expect(signals).toEqual([]);

    const liveOwner = { pid: 4242, exitCode: null, signalCode: null };
    expect(signalOwnedPosixProcessGroup(liveOwner, 'SIGTERM', sendSignal)).toBe(true);
    expect(signals).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  test('separates a vanished process group from one it may not signal', () => {
    const owner = { pid: 4243, exitCode: null, signalCode: null };
    const failWith = (code: string) =>
      (() => {
        const err = new Error(code) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }) as unknown as typeof process.kill;

    // ESRCH: the group is gone. False retires it, and the caller then skips
    // straight past the grace window — correct, there is nothing to escalate.
    expect(signalOwnedPosixProcessGroup(owner, 'SIGTERM', failWith('ESRCH'))).toBe(false);

    // EPERM: the group is THERE, we just could not signal a member of it.
    // Reporting false here is what leaves a TERM-ignoring tree alive, because
    // `terminateChild` reads false as "no owned group", sends one SIGTERM to
    // the supervisor and returns without ever escalating to SIGKILL.
    expect(signalOwnedPosixProcessGroup(owner, 'SIGTERM', failWith('EPERM'))).toBe(true);

    // Anything else is a real fault and must not be swallowed as either.
    expect(() =>
      signalOwnedPosixProcessGroup(owner, 'SIGTERM', failWith('EINVAL')),
    ).toThrow();
  });
});

describe('terminated target metadata', () => {
  test('an absent supervisor report is bounded by the reap deadline', async () => {
    const lateTarget = new Promise<{
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      error: string | null;
    }>((resolve) => {
      setTimeout(() => resolve({ exitCode: 0, signalCode: null, error: null }), 50);
    });

    const result = await waitForTargetExitAfterTermination(lateTarget, 5);

    expect(result).toBeNull();
  });
});

describe('Windows process-tree termination', () => {
  test('a failed graceful tree kill escalates the tree before touching the supervisor', async () => {
    const treeKillCalls: boolean[] = [];
    const directSignals: NodeJS.Signals[] = [];
    const proc = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: (signal: NodeJS.Signals) => {
        directSignals.push(signal);
        return true;
      },
    } as unknown as ChildProcess;

    const result = await terminateWindowsProcessTree(
      proc,
      async (_owner, force) => {
        treeKillCalls.push(force);
        return force;
      },
      async () => true
    );

    expect(result).toBe('SIGKILL');
    expect(treeKillCalls).toEqual([false, true]);
    expect(directSignals).toEqual([]);
  });
});

/** Scripted resume-loop IO. `deliver` is a single-shot script (the retry logic
 * lives in `deliverExitReport`, tested separately). */
function scriptedIo(replies: (CompleteAutomationResponse | Error)[]) {
  const nudges: (string | undefined)[] = [];
  const attempts: number[] = [];
  let errors = 0;
  const io: AutomationRunIo = {
    run: async (nudge) => {
      nudges.push(nudge);
      return okResult();
    },
    deliver: async (_result, finalizeAttempt) => {
      attempts.push(finalizeAttempt);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next ?? { status: 'completed' };
    },
    reportError: async () => {
      errors += 1;
    },
  };
  return { io, nudges, attempts, errors: () => errors };
}

describe('dispatchAutomationResumeLoop (ported DispatcherResumeTests)', () => {
  test("a granted resume re-spawns with the server's nudge and honours its attempt", async () => {
    // Attempt 2, not 1: after one resume a local `+1` would also yield 1.
    const { io, nudges, attempts } = scriptedIo([
      { status: 'resume', attempt: 2, max_attempts: 3, nudge: 'finalize it' },
      { status: 'completed' },
    ]);
    await dispatchAutomationResumeLoop(io);
    expect(nudges).toEqual([undefined, 'finalize it']);
    expect(attempts).toEqual([0, 2]);
  });

  test('a local safety cap bounds spawns at 8 and posts a final error report', async () => {
    const { io, nudges, attempts, errors } = scriptedIo([
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
    ]);
    await dispatchAutomationResumeLoop(io);
    expect(nudges.length).toBe(8);
    expect(attempts.length).toBe(8);
    expect(errors()).toBe(1);
  });

  test('a spawn throw reports a crash and stops', async () => {
    const { io, errors } = scriptedIo([]);
    const runs: (string | undefined)[] = [];
    const throwingIo: AutomationRunIo = {
      ...io,
      run: async (nudge) => {
        runs.push(nudge);
        throw new Error('boom');
      },
    };
    await dispatchAutomationResumeLoop(throwingIo);
    expect(runs.length).toBe(1);
    expect(errors()).toBe(1);
  });

  test('an unknown delivery outcome (null) leaves the run claimed, no error report', async () => {
    const { io, nudges, errors } = scriptedIo([]);
    const nullDeliver: AutomationRunIo = {
      ...io,
      deliver: async () => null,
    };
    await dispatchAutomationResumeLoop(nullDeliver);
    expect(nudges.length).toBe(1);
    expect(errors()).toBe(0);
  });
});

describe('deliverExitReport (delivery retry + classification)', () => {
  function fakeClient(script: (Error | CompleteAutomationResponse)[]) {
    const calls: number[] = [];
    const client = {
      id: 'wrk_1',
      completeAutomation: async (_runId: number, req: { finalize_attempt?: number }) => {
        calls.push(req.finalize_attempt ?? -1);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next ?? { status: 'completed' };
      },
    } as unknown as ExecutorClient;
    return { client, calls };
  }

  test('a transient failure re-sends the same report, replaying finalize_attempt', async () => {
    const { client, calls } = fakeClient([
      new Error('transport'),
      { status: 'completed' },
    ]);
    const report = await deliverExitReport(client, 7, okResult(), 0);
    expect(report?.status).toBe('completed');
    expect(calls).toEqual([0, 0]);
  });

  test('an HTTP 500 is retried; a 400 is not', async () => {
    const retried = fakeClient([
      new WorkerHttpError(503, '/x', 'upstream'),
      { status: 'completed' },
    ]);
    await deliverExitReport(retried.client, 7, okResult(), 0);
    expect(retried.calls).toEqual([0, 0]);

    const rejected = fakeClient([new WorkerHttpError(400, '/x', 'bad')]);
    const outcome = await deliverExitReport(rejected.client, 7, okResult(), 0);
    expect(outcome).toBeNull();
    expect(rejected.calls).toEqual([0]);
  });

  test('an unreadable 2xx body (decode error) is non-retriable', async () => {
    const { client, calls } = fakeClient([new WorkerDecodeError('garbled')]);
    const outcome = await deliverExitReport(client, 7, okResult(), 0);
    expect(outcome).toBeNull();
    expect(calls).toEqual([0]);
  });
});

describe('interpretCompleteAutomationResponse', () => {
  test('reads a status-carrying body', () => {
    expect(interpretCompleteAutomationResponse({ status: 'resume', nudge: 'x' }).status).toBe('resume');
    expect(interpretCompleteAutomationResponse({ status: 'completed' }).status).toBe('completed');
  });

  test('rejects every body without a `status`', () => {
    expect(() => interpretCompleteAutomationResponse({ ok: true })).toThrow(WorkerDecodeError);
    expect(() => interpretCompleteAutomationResponse({})).toThrow(WorkerDecodeError);
    expect(() => interpretCompleteAutomationResponse({ ok: false })).toThrow(WorkerDecodeError);
    expect(() => interpretCompleteAutomationResponse({ error: 'x' })).toThrow(WorkerDecodeError);
    expect(() => interpretCompleteAutomationResponse('<html>502</html>')).toThrow(WorkerDecodeError);
  });
});

describe('buildArguments (ported AgentSpec table)', () => {
  const claude = DEVICE_AGENT_SPECS_BY_KIND.get('claude-code')!;
  const pi = DEVICE_AGENT_SPECS_BY_KIND.get('pi')!;
  const codex = DEVICE_AGENT_SPECS_BY_KIND.get('codex')!;
  const opencode = DEVICE_AGENT_SPECS_BY_KIND.get('opencode')!;
  const agy = DEVICE_AGENT_SPECS_BY_KIND.get('agy')!;

  test('claude: flag prompt, MCP config, model + budget + permission + effort flags', () => {
    const args = buildArguments(
      claude,
      'the prompt',
      {
        model: 'claude-sonnet-5',
        max_budget_usd: 2,
        permission_mode: 'acceptEdits',
        effort: 'high',
      },
      ['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config', '--allowedTools', 'a,b'],
      600
    );
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('the prompt');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-5');
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('2');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(args).toContain('--mcp-config');
  });

  test('pi: positional prompt goes last, after every flag', () => {
    const args = buildArguments(pi, 'the prompt', undefined, [], 600);
    expect(args[0]).toBe('-p');
    expect(args.at(-1)).toBe('the prompt');
    expect(args).toContain('--no-session');
    expect(args).toContain('--tools');
    expect(args).toContain('read,bash,edit,write');
  });

  test('codex: forwards model and arbitrary effort as a config override', () => {
    const args = buildArguments(codex, 'the prompt', { model: 'test-model', effort: 'xhigh' }, [], 600);
    expect(args).toContain('test-model');
    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(args[args.indexOf('model_reasoning_effort="xhigh"') - 1]).toBe('-c');
  });

  test('codex: positional after `exec` subcommand', () => {
    const args = buildArguments(codex, 'the prompt', undefined, [], 600);
    expect(args[0]).toBe('exec');
    expect(args.at(-1)).toBe('the prompt');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
  });

  test('opencode: positional after `run`, model flag is `-m`', () => {
    const args = buildArguments(opencode, 'the prompt', { model: 'gpt-5' }, [], 600);
    expect(args[0]).toBe('run');
    expect(args).toContain('--print-logs');
    expect(args).toContain('ERROR');
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5');
    expect(args.at(-1)).toBe('the prompt');
  });

  test('agy: timeout flag carries `<seconds>s` suffix', () => {
    const args = buildArguments(agy, 'the prompt', undefined, [], 600);
    expect(args).toContain('--print-timeout');
    expect(args).toContain('600s');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  test('empty strings and zero budget are treated as unset', () => {
    const args = buildArguments(
      claude,
      'the prompt',
      { model: '', max_budget_usd: 0, permission_mode: '', effort: '' },
      [],
      600
    );
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--max-budget-usd');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--effort');
  });
});
