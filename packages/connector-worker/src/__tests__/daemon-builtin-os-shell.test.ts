import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from '../daemon/executor.js';
import { executeDaemonBuiltin, hasDaemonBuiltin } from '../daemon/builtins/index.js';
import { runShellBuiltin } from '../daemon/builtins/os-shell.js';

function processIsLive(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3);
      return state !== 'Z';
    }
    process.kill(pid, 0);
    if (process.platform === 'darwin') {
      // A zombie still answers kill(pid, 0), so ask `ps` for the real state --
      // the same check the sibling suite uses. Between the signal probe and
      // this call the pid can be reaped, and `ps` then exits 1 with no stdout,
      // which execFileSync raises as an error carrying a `status` rather than
      // an ESRCH/ENOENT `code`; the handler below would rethrow it and fail
      // the test. A pid `ps` cannot find is not an error here: it is the
      // definition of not live.
      let state: string;
      try {
        state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return false;
      }
      return state !== '' && !state.startsWith('Z');
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return false;
    throw error;
  }
}

function forceKill(pid: number, group = false): void {
  try {
    process.kill(group ? -pid : pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function stubClient() {
  const completions: Array<Record<string, unknown>> = [];
  return {
    client: {
      id: 'headless:test',
      async heartbeat() {},
      async completeAction(input: Record<string, unknown>) {
        completions.push(input);
      },
      // A non-action run terminates through the generic completion instead;
      // without it a rejected sync run reports nowhere and the test would pass
      // on the returned error alone.
      async complete(input: Record<string, unknown>) {
        completions.push(input);
      },
    },
    completions,
  };
}

describe('daemon-builtin os.shell', () => {
  test('uses a minimal child environment and does not inherit control-plane env', async () => {
    const sentinels = {
      WORKER_API_TOKEN: process.env.WORKER_API_TOKEN,
      LOBU_API_TOKEN: process.env.LOBU_API_TOKEN,
      LOBU_MEMORY_URL: process.env.LOBU_MEMORY_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      LOBU_ENCRYPTION_KEY: process.env.LOBU_ENCRYPTION_KEY,
      AUTH_SECRET: process.env.AUTH_SECRET,
      PROVIDER_API_KEY: process.env.PROVIDER_API_KEY,
    };
    Object.assign(process.env, {
      WORKER_API_TOKEN: 'worker-secret',
      LOBU_API_TOKEN: 'api-secret',
      LOBU_MEMORY_URL: 'https://memory.invalid',
      DATABASE_URL: 'postgres://secret',
      LOBU_ENCRYPTION_KEY: 'encryption-secret',
      AUTH_SECRET: 'auth-secret',
      PROVIDER_API_KEY: 'provider-secret',
    });
    try {
      const result = await runShellBuiltin({
        command: 'printf "PATH=%s\\nHOME=%s\\nTMPDIR=%s\\n" "$PATH" "$HOME" "$TMPDIR"; env',
        cwd: process.cwd(),
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toMatch(/PATH=.+/);
      expect(result.stdout).toMatch(/HOME=.+/);
      expect(result.stdout).toMatch(/TMPDIR=.+/);
      for (const name of Object.keys(sentinels)) expect(result.stdout).not.toMatch(new RegExp(`^${name}=`, 'm'));
      expect(result.stdout).toContain('LC_ALL=C');
    } finally {
      for (const [name, value] of Object.entries(sentinels)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('force-kills SIGTERM-ignoring descendants in its process group', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lobu-shell-test-'));
    let descendantPid = 0;
    try {
      const output = await runShellBuiltin({
        command: `node -e 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); fs.writeFileSync("./ready", String(process.pid)); setTimeout(() => {}, 10000)' >/dev/null 2>&1 & while [ ! -s ./ready ]; do sleep 0.01; done; cat ./ready; wait`,
        cwd: testDir,
        timeout_ms: 300,
      });
      descendantPid = Number(output.stdout.trim());

      expect(output.timed_out).toBe(true);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(processIsLive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 0 && processIsLive(descendantPid)) forceKill(descendantPid);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('bounds settlement without claiming ownership of a detached session', async () => {
    if (process.platform !== 'linux') return;

    let escapedPid = 0;
    try {
      const started = Date.now();
      const output = await runShellBuiltin({
        command: `setsid bash -c 'trap "" TERM; (sleep 0.1; printf detached-trailing-output >&2) & sleep 10' & echo $!; wait`,
        cwd: process.cwd(),
        timeout_ms: 300,
      });
      escapedPid = Number(output.stdout.trim());

      expect(output.timed_out).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_500);
      expect(output.stderr).toContain('detached-trailing-output');
      expect(Number.isInteger(escapedPid)).toBe(true);
      // A deliberately new session is outside the supervisor's owned group;
      // the test owns this exact PID/group and cleans it up below.
      expect(processGroupExists(escapedPid)).toBe(true);
    } finally {
      if (escapedPid > 0) forceKill(escapedPid, true);
    }
  });

  test('does not reject when the command exits before consuming stdin', async () => {
    const output = await runShellBuiltin({
      command: 'exit 0',
      cwd: process.cwd(),
      stdin: 'x'.repeat(1_000_000),
    });

    expect(output.success).toBe(true);
    expect(output.exit_code).toBe(0);
  });

  test('drains output emitted as the supervisor closes', async () => {
    const output = await runShellBuiltin({
      command: `node -e 'process.stdout.write("stdout-at-close"); process.stderr.write("stderr-at-close"); process.exit(0)'`,
      cwd: process.cwd(),
    });

    expect(output).toMatchObject({
      success: true,
      stdout: 'stdout-at-close',
      stderr: 'stderr-at-close',
      exit_code: 0,
    });
  });

  test('preserves a signal instead of collapsing it to exit code -1', async () => {
    if (process.platform === 'win32') return;

    const result = await executeDaemonBuiltin({
      connectorKey: 'os.shell',
      actionKey: 'run',
      input: { command: 'kill -TERM $$', cwd: process.cwd() },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'operation_execution_failed',
      error: 'Shell command terminated by SIGTERM',
      output: {
        exit_code: -1,
        exit_signal: 'SIGTERM',
        process_stage: 'target_exit',
      },
    });
  });

  test('keeps short-lived command outcomes stable under process churn', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const output = await runShellBuiltin({
        command: "printf 'lobu-shell-self-check\\n'",
        cwd: process.cwd(),
      });
      expect(output).toMatchObject({
        success: true,
        stdout: 'lobu-shell-self-check\n',
        stderr: '',
        exit_code: 0,
      });
    }
  });

  test('executes without compiled connector code or connector SDK resolution', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(
      client as never,
      {
        run_id: 464,
        run_type: 'action',
        connector_key: 'os.shell',
        connector_version: '0.2.0',
        connector_manifest_hash: 'test-manifest-hash',
        action_key: 'run',
        action_input: {
          command: "printf 'lobu-shell-ok\\n'",
          cwd: process.cwd(),
        },
      },
      {},
      { heartbeatIntervalMs: 5_000 }
    );

    expect(result).toEqual({ itemsCollected: 0 });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      run_id: 464,
      worker_id: 'headless:test',
      status: 'success',
      action_output: {
        stdout: 'lobu-shell-ok\n',
        stderr: '',
        exit_code: 0,
        success: true,
        timed_out: false,
      },
    });
  });

  // Routing is the daemon's own decision, taken from its registry, so an
  // unregistered pair can never be dispatched here by mistake. The registry
  // still fails closed if one is asked for directly.
  test('fails closed when a built-in is not registered', async () => {
    expect(hasDaemonBuiltin('os.shell', 'run')).toBe(true);
    expect(hasDaemonBuiltin('os.shell', 'not_an_action')).toBe(false);
    expect(hasDaemonBuiltin('missing.builtin', 'run')).toBe(false);

    const result = await executeDaemonBuiltin({
      connectorKey: 'missing.builtin',
      actionKey: 'run',
      input: {},
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('operation_backend_unavailable');
  });

  // A connector the daemon implements ships no code, so a run of any other kind
  // has nothing to fall through to; naming the real fault beats failing later
  // in the compiled path for want of a bundle.
  test('refuses a non-action run for a connector it implements', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(
      client as never,
      {
        run_id: 465,
        run_type: 'sync',
        connector_key: 'os.shell',
        feed_key: 'anything',
        action_input: {},
      },
      {}
    );

    expect(result.error).toStartWith('operation_backend_unavailable:');
    expect(result.error).toContain('action runs only');
    expect(completions[0]).toMatchObject({ run_id: 465, status: 'failed' });
  });

  test('rejects a contradictory compiled payload', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(
      client as never,
      {
        run_id: 466,
        run_type: 'action',
        connector_key: 'os.shell',
        compiled_code: 'must not execute',
        action_key: 'run',
        action_input: { command: 'exit 0' },
      },
      {}
    );

    expect(result.error).toContain('must not contain compiled_code');
    expect(completions[0]).toMatchObject({ status: 'failed' });
  });

  test('bounds timeout while killing descendants in the owned process group', async () => {
    const { client, completions } = stubClient();
    const started = Date.now();
    const result = await executeRun(
      client as never,
      {
        run_id: 467,
        run_type: 'action',
        connector_key: 'os.shell',
        connector_version: '0.2.0',
        connector_manifest_hash: 'test-manifest-hash',
        action_key: 'run',
        action_input: {
          command: 'sleep 10 & wait',
          cwd: process.cwd(),
          timeout_ms: 300,
        },
      },
      {},
      { heartbeatIntervalMs: 5_000 }
    );

    expect(result.itemsCollected).toBe(0);
    expect(result.error).toStartWith('operation_execution_failed:');
    expect(Date.now() - started).toBeLessThan(5_500);
    expect(completions[0]?.status).toBe('failed');
    expect(completions[0]?.error_message).toStartWith('operation_execution_failed: Shell command timed out after ');
    expect(completions[0]?.action_output).toMatchObject({
      stdout: '', stderr: '', timed_out: true, success: false,
    });
  });

  test('preserves structured output for nonzero builtin results', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(client as never, {
      run_id: 468,
      run_type: 'action',
      connector_key: 'os.shell',
      connector_version: '0.2.0',
      action_key: 'run',
      action_input: { command: "printf out; printf err >&2; exit 7", cwd: process.cwd() },
    }, {}, { heartbeatIntervalMs: 5_000 });
    expect(result.error).toContain('operation_execution_failed: Shell command exited with code 7');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      status: 'failed',
      action_output: { stdout: 'out', stderr: 'err', exit_code: 7, timed_out: false, success: false },
    });
  });

  test('retries one immutable success payload after terminal delivery loss', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const client = {
      id: 'headless:test',
      async heartbeat() {},
      async completeAction(input: Record<string, unknown>) {
        payloads.push(structuredClone(input));
        attempts += 1;
        if (attempts === 1) throw new Error('response lost');
      },
    };
    await expect(executeRun(client as never, {
      run_id: 469,
      run_type: 'action',
      connector_key: 'os.shell',
      connector_version: '0.2.0',
      action_key: 'run',
      action_input: { command: 'printf success', cwd: process.cwd() },
    }, {}, { heartbeatIntervalMs: 5_000 })).resolves.toEqual({ itemsCollected: 0 });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[0]).toMatchObject({ status: 'success', action_output: { stdout: 'success' } });
  });

  test('retries one immutable failed payload after terminal delivery loss', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const client = {
      id: 'headless:test',
      async heartbeat() {},
      async completeAction(input: Record<string, unknown>) {
        payloads.push(structuredClone(input));
        attempts += 1;
        if (attempts === 1) throw new Error('response lost');
      },
    };
    await expect(executeRun(client as never, {
      run_id: 470,
      run_type: 'action',
      connector_key: 'os.shell',
      connector_version: '0.2.0',
      action_key: 'run',
      action_input: { command: 'printf err >&2; exit 7', cwd: process.cwd() },
    }, {}, { heartbeatIntervalMs: 5_000 })).resolves.toMatchObject({ itemsCollected: 0, error: expect.stringContaining('exited with code 7') });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[0]).toMatchObject({ status: 'failed', action_output: { stderr: 'err', exit_code: 7 } });
  });

  test('ignores poisoned Bash function state while enforcing timeout reaping', async () => {
    const previousBashFunction = process.env['BASH_FUNC_sleep%%'];
    const previousBashEnv = process.env.BASH_ENV;
    process.env['BASH_FUNC_sleep%%'] = '() { :; }';
    process.env.BASH_ENV = '/tmp/does-not-exist-lobu-shell-test';
    try {
      const started = Date.now();
      const result = await runShellBuiltin({
        command: 'trap "" TERM; sleep 30 & descendant=$!; echo "$descendant"; wait',
        cwd: process.cwd(),
        timeout_ms: 100,
      });
      expect(result.success).toBe(false);
      expect(result.timed_out).toBe(true);
      if (process.platform !== 'darwin') expect(processIsLive(Number(result.stdout.trim()))).toBe(false);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      if (previousBashFunction === undefined) delete process.env['BASH_FUNC_sleep%%'];
      else process.env['BASH_FUNC_sleep%%'] = previousBashFunction;
      if (previousBashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previousBashEnv;
    }
  });

  test('daemon abort kills a long-lived child and grandchild process tree', async () => {
    const shutdown = new AbortController();
    const started = Date.now();
    const pending = runShellBuiltin({
      command: 'sleep 30 & child=$!; sleep 30 & grandchild=$!; wait "$child" "$grandchild"',
      cwd: process.cwd(),
      timeout_ms: 150_000,
    }, shutdown.signal);
    setTimeout(() => shutdown.abort(), 100);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.timed_out).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  // #3629: a successful command that backgrounds a child still has that child
  // inside the supervisor's owned process group, so the group SIGKILL on target
  // exit reaps it. Reaping is correct -- the daemon must not leak processes --
  // but reporting exit 0 with nothing said about it is what made this look like
  // a nondeterministic disappearance an operation later. The caller has to be
  // able to SEE that backgrounded work did not survive.
  test('reports descendants reaped on a successful exit instead of reaping silently', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lobu-shell-reap-'));
    let descendantPid = 0;
    try {
      const output = await runShellBuiltin({
        command: `nohup node -e 'const fs = require("node:fs"); fs.writeFileSync("./ready", String(process.pid)); setInterval(() => {}, 1000)' >/dev/null 2>&1 & while [ ! -s ./ready ]; do sleep 0.01; done; cat ./ready`,
        cwd: testDir,
        timeout_ms: 10_000,
      });
      descendantPid = Number(output.stdout.trim());
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(descendantPid).toBeGreaterThan(0);

      // The command itself succeeded, and that stays true: the shell exited 0.
      expect(output.exit_code).toBe(0);
      expect(output.timed_out).toBe(false);

      // The owned-group cleanup still happens -- no leaked daemon.
      expect(processIsLive(descendantPid)).toBe(false);

      // ...and the caller is told, rather than inferring it a minute later.
      expect(output.reaped_descendants).toBe(true);
      expect(output.process_stage).toBe('descendants_reaped');
      expect(output.success).toBe(false);
    } finally {
      if (descendantPid > 0 && processIsLive(descendantPid)) forceKill(descendantPid);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // A reaped run exits 0, so the operation error must not fall through to the
  // exit-code default and report "exited with code 0" as the failure reason.
  test('explains the reaping in the operation error instead of reporting exit 0', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lobu-shell-reap-msg-'));
    let descendantPid = 0;
    try {
      const result = await executeDaemonBuiltin({
        connectorKey: 'os.shell',
        actionKey: 'run',
        input: {
          command: `nohup node -e 'const fs = require("node:fs"); fs.writeFileSync("./ready", String(process.pid)); setInterval(() => {}, 1000)' >/dev/null 2>&1 & while [ ! -s ./ready ]; do sleep 0.01; done; cat ./ready`,
          cwd: testDir,
          timeout_ms: 10_000,
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a failed builtin result');
      descendantPid = Number((result.output?.stdout as string)?.trim());

      expect(result.code).toBe('operation_execution_failed');
      expect(result.error).toContain('left background processes running');
      expect(result.error).not.toBe('Shell command exited with code 0');
      // The structured output still travels with it.
      expect(result.output).toMatchObject({ exit_code: 0, reaped_descendants: true });
    } finally {
      if (descendantPid > 0 && processIsLive(descendantPid)) forceKill(descendantPid);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // A death that names its own cause keeps it: the signal is the reason the
  // run failed, and the reaping travels as structured output rather than
  // displacing either the message or the real lifecycle stage.
  test('reports a signal death ahead of the reaping it also caused', async () => {
    if (process.platform === 'win32') return;
    const result = await executeDaemonBuiltin({
      connectorKey: 'os.shell',
      actionKey: 'run',
      input: {
        command: 'sleep 30 & kill -KILL $$',
        cwd: process.cwd(),
        timeout_ms: 10_000,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed builtin result');

    expect(result.error).toBe('Shell command terminated by SIGKILL');
    expect(result.output).toMatchObject({
      exit_signal: 'SIGKILL',
      process_stage: 'target_exit',
      reaped_descendants: true,
    });
  });

  // The ordinary path must not acquire a false positive: a command whose
  // children have all exited reports a plain success with no reaping claim.
  test('does not claim reaping when the command leaves nothing behind', async () => {
    const output = await runShellBuiltin({
      command: 'sleep 0.05 & wait; printf done',
      cwd: process.cwd(),
      timeout_ms: 10_000,
    });

    expect(output.stdout).toBe('done');
    expect(output.success).toBe(true);
    expect(output.exit_code).toBe(0);
    expect(output.reaped_descendants).toBeUndefined();
    expect(output.process_stage).toBeUndefined();
  });

  test('rejects a timeout that exceeds the caller truth budget', async () => {
    await expect(runShellBuiltin({
      command: 'printf nope',
      cwd: process.cwd(),
      timeout_ms: 150_001,
    })).rejects.toThrow('between 100 and 150000');
  });

  test('separates an argument fault from a spawn fault', async () => {
    const badArgument = await executeDaemonBuiltin({
      connectorKey: 'os.shell',
      actionKey: 'run',
      input: { command: 'printf nope', timeout_ms: 150_001 },
    });
    expect(badArgument).toMatchObject({ ok: false, code: 'invalid_operation_input' });

    // A cwd that exists but is a FILE clears the builtin's own checks and then
    // fails inside spawn with ENOTDIR. Reporting that as bad input would send
    // the caller off to fix a payload that was fine.
    const dir = mkdtempSync(join(tmpdir(), 'os-shell-cwd-'));
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'x');
    try {
      const spawnFault = await executeDaemonBuiltin({
        connectorKey: 'os.shell',
        actionKey: 'run',
        input: { command: 'printf nope', cwd: file },
      });
      expect(spawnFault).toMatchObject({
        ok: false,
        code: 'operation_execution_failed',
        output: {
          exit_code: -1,
          process_stage: 'supervisor_spawn',
          process_error_code: 'ENOTDIR',
        },
      });
      if (!spawnFault.ok) {
        expect(spawnFault.error).toContain('Shell supervisor failed to start');
        expect(spawnFault.error).toContain('ENOTDIR');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
