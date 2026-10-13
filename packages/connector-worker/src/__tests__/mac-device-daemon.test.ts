import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bridgeImplementsRun,
  createMacDeviceDaemonShutdown,
  executeAdvertisedConnectorRun,
  macDeviceDaemonMetadata,
  selectMacDeviceDaemonAgentKind,
  validateMacDeviceDaemonOptions,
} from '../daemon/mac-device-daemon';
import { MutableWorkerAdvertisementProvider } from '../daemon/client';
import { executeAutomationRun } from '../daemon/automation';
import { NATIVE_BRIDGE_PROTOCOL } from '../daemon/native-bridge/protocol';
import {
  createWorkerPollLoopShutdownHandler,
  shouldHandleWorkerPollLoopStdinEof,
  WorkerPollLoop,
} from '../daemon/poll-loop';

describe('Mac device daemon options', () => {
  test('emits versioned protocol metadata', () => {
    expect(macDeviceDaemonMetadata('15.8.0')).toMatchObject({
      name: 'lobu-device-daemon',
      version: '15.8.0',
      protocol: NATIVE_BRIDGE_PROTOCOL,
      platform: 'macos',
      artifact: 'standalone-bun-macho-arm64',
    });
  });

  test('allows no-poll metadata mode without credentials', () => {
    expect(
      validateMacDeviceDaemonOptions({ version: '15.8.0', noPoll: true })
    ).toMatchObject({ noPoll: true, apiUrl: '', workerApiToken: '' });
  });

  test('requires an absolute HTTP URL and durable PAT for polling', () => {
    expect(() =>
      validateMacDeviceDaemonOptions({ version: '15.8.0' })
    ).toThrow('--api-url or API_URL is required');
    expect(() =>
      validateMacDeviceDaemonOptions({
        version: '15.8.0',
        apiUrl: 'file:///tmp/api',
        workerApiToken: 'owl_pat_1234567890123456789012345678',
      })
    ).toThrow('expected an http(s) URL');
    expect(() =>
      validateMacDeviceDaemonOptions({
        version: '15.8.0',
        apiUrl: 'https://example.test',
        workerApiToken: 'session-token',
      })
    ).toThrow('owl_pat_');
  });

  test('rejects malformed identity and concurrency settings', () => {
    const base = {
      version: '15.8.0',
      apiUrl: 'https://example.test',
      workerApiToken: 'owl_pat_12345678901234567890123456789012',
    };
    expect(() => validateMacDeviceDaemonOptions({ ...base, workerId: 'bad id' })).toThrow(
      'invalid --worker-id'
    );
    expect(() =>
      validateMacDeviceDaemonOptions({ ...base, maxConcurrentJobs: 0 })
    ).toThrow('--max-concurrent-jobs');
    expect(() =>
      validateMacDeviceDaemonOptions({ ...base, defaultAgentKind: 'not-an-agent' as never })
    ).toThrow('--default-agent-kind');
    expect(() =>
      validateMacDeviceDaemonOptions({ ...base, workerApiToken: 'owl_pat_' })
    ).toThrow('32 base64url characters');
  });

  test('selects the first runnable kind in canonical order and rejects unavailable overrides', () => {
    expect(selectMacDeviceDaemonAgentKind(['pi', 'codex'])).toBe('pi');
    expect(selectMacDeviceDaemonAgentKind(['codex', 'pi'], 'pi')).toBe('pi');
    expect(() => selectMacDeviceDaemonAgentKind(['codex'], 'pi')).toThrow('not runnable');
  });

  test('defaults to half the host threads, preserves overrides, and keeps supervised stdio opt-in', () => {
    const base = {
      version: '15.8.0',
      apiUrl: 'https://example.test',
      workerApiToken: 'owl_pat_12345678901234567890123456789012',
    };
    expect(validateMacDeviceDaemonOptions(base, 8).maxConcurrentJobs).toBe(4);
    expect(validateMacDeviceDaemonOptions(base, 24).maxConcurrentJobs).toBe(8);
    for (const maxConcurrentJobs of [1, 2, 8]) {
      expect(
        validateMacDeviceDaemonOptions({ ...base, maxConcurrentJobs }, 24).maxConcurrentJobs
      ).toBe(maxConcurrentJobs);
    }
    expect(validateMacDeviceDaemonOptions({ ...base }).supervisedStdio).toBeUndefined();
    expect(validateMacDeviceDaemonOptions({ ...base, supervisedStdio: true }).supervisedStdio).toBe(
      true
    );
  });

  test('treats stdin EOF as opt-in for the signal installer', () => {
    expect(shouldHandleWorkerPollLoopStdinEof()).toBe(false);
    expect(shouldHandleWorkerPollLoopStdinEof({ stdinEof: false })).toBe(false);
    expect(shouldHandleWorkerPollLoopStdinEof({ stdinEof: true })).toBe(true);
  });

  test('aborts Automation execution before stopping the poll loop', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => events.push('abort'));
    const loop = { stop: () => events.push('stop') } as never;

    await createMacDeviceDaemonShutdown(controller, loop)();

    expect(events).toEqual(['stop', 'abort']);
  });

  test('awaits native bridge cancellation, terminal reporting, and shutdown in order', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const loop = {
      stop: () => events.push('stop'),
      waitForActiveJobs: async () => {
        events.push('wait');
        return true;
      },
    } as unknown as WorkerPollLoop;
    const bridge = {
      cancelActiveRuns: async () => events.push('cancel'),
      shutdown: async () => events.push('shutdown'),
      close: () => events.push('close'),
    } as never;

    await createMacDeviceDaemonShutdown(controller, loop, bridge)();

    expect(events).toEqual(['stop', 'cancel', 'shutdown', 'close']);
  });

  test('bounds native cancellation and shutdown without a duplicate active-job wait', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const loop = {
      stop: () => events.push('stop'),
      waitForActiveJobs: async () => {
        events.push('wait');
        return true;
      },
    } as unknown as WorkerPollLoop;
    const bridge = {
      cancelActiveRuns: () => new Promise<void>(() => undefined),
      shutdown: async () => events.push('shutdown'),
      close: () => events.push('close'),
    } as never;

    await expect(createMacDeviceDaemonShutdown(controller, loop, bridge, 1)()).rejects.toThrow(
      'timed out',
    );
    expect(events).toEqual(['stop', 'shutdown', 'close']);
  });
});

describe('WorkerPollLoop', () => {
  test('fails closed when a capable daemon receives no run-scoped session', async () => {
    let report: Record<string, unknown> | undefined;
    const client = {
      id: 'mac-worker',
      completeAutomation: async (_runId: number, req: Record<string, unknown>) => {
        report = req;
        return { status: 'completed' } as never;
      },
    } as never;
    const result = await executeAutomationRun(
      client,
      {
        run_id: 7,
        run_type: 'automation',
        payload: {
          automation: { id: 'automation-7', agent_kind: 'pi' },
          event: { fired_at: '2026-08-22T00:00:00Z' },
          context: { device: { worker_id: 'mac-worker' }, user: {} },
        },
      } as never,
      { requireRunScopedSession: true }
    );

    expect(result.error).toContain('required run-scoped agent session');
    expect(report?.error).toContain('required run-scoped agent session');
  });

  test('honors the server idle delay instead of hot-looping at the local interval', async () => {
    let polls = 0;
    const client = {
      healthCheck: async () => true,
      poll: async () => {
        polls++;
        return { next_poll_seconds: 0.05 } as never;
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 1,
      execute: async () => undefined,
    });

    const started = loop.start();
    await Bun.sleep(10);
    expect(polls).toBe(1);
    loop.stop();
    await started;
  });

  test('can cap an idle server delay for short-deadline device reads', async () => {
    let polls = 0;
    let loop: WorkerPollLoop;
    const client = {
      healthCheck: async () => true,
      poll: async () => {
        polls++;
        if (polls === 2) loop.stop();
        return { next_poll_seconds: 10 } as never;
      },
    } as never;
    loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 10_000,
      maxIdleDelayMs: 1,
      execute: async () => undefined,
    });

    await loop.start();

    expect(polls).toBe(2);
  });

  test('stops polling and waits for the active job during shutdown', async () => {
    let polls = 0;
    let release!: () => void;
    const jobFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      healthCheck: async () => true,
      poll: async () => {
        polls++;
        return { run_id: 1, run_type: 'automation' } as never;
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 1000,
      maxConcurrentJobs: 1,
      execute: async () => jobFinished,
    });

    const started = loop.start();
    await Bun.sleep(10);
    expect(polls).toBe(1);
    loop.stop();
    release();
    expect(await loop.waitForActiveJobs(1000, 1)).toBe(true);
    await started;
  });

  test('drains a poll result claimed while shutdown begins', async () => {
    let releasePoll!: (job: unknown) => void;
    let executions = 0;
    const pollResult = new Promise((resolve) => {
      releasePoll = resolve;
    });
    const client = {
      healthCheck: async () => true,
      poll: async () => pollResult,
    } as never;
    const loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 1,
      execute: async () => {
        executions++;
      },
    });

    const started = loop.start();
    await Bun.sleep(5);
    loop.stop();
    releasePoll({ run_id: 2, run_type: 'action' });
    await started;

    expect(await loop.waitForActiveJobs(1000, 1)).toBe(true);
    expect(executions).toBe(1);
  });

  test('releases the active-job slot when execution throws synchronously', async () => {
    let polled = false;
    const client = {
      healthCheck: async () => true,
      poll: async () => {
        if (!polled) {
          polled = true;
          return { run_id: 1, run_type: 'automation' } as never;
        }
        return { next_poll_seconds: 1 } as never;
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 1,
      maxConcurrentJobs: 1,
      execute: () => {
        throw new Error('synchronous executor failure');
      },
    });

    const started = loop.start();
    await Bun.sleep(10);
    loop.stop();
    await started;

    expect(await loop.waitForActiveJobs(10, 1)).toBe(true);
  });

  test('runs the daemon stop callback before draining active jobs', async () => {
    const events: string[] = [];
    const loop = {
      waitForActiveJobs: async () => {
        events.push('wait');
        return true;
      },
    } as unknown as WorkerPollLoop;
    const handler = createWorkerPollLoopShutdownHandler(
      loop,
      () => events.push('daemon-stop'),
      (code) => events.push(`exit:${code}`)
    );

    await handler('SIGTERM');

    expect(events).toEqual(['daemon-stop', 'wait', 'exit:0']);
  });
});

// The Mac daemon routes every sync/action/auth run through this predicate, and
// it is the ONLY thing standing between a claimed run and the native bridge.
// It replaced a routing marker the gateway derived from the connector manifest
// — which is what forced the implementation into the manifest, and therefore
// into the contract hash, so one contract could not be served by two endpoints.
describe('bridgeImplementsRun', () => {
  const provider = new MutableWorkerAdvertisementProvider({
    capabilities: {},
    manifests: [{ key: 'os.shell', version: '0.3.0' }, { key: 'apple.calendar' }],
    generation: 1,
  });

  test('routes a run whose connector the app declared over the bridge', () => {
    for (const run_type of ['sync', 'action', 'auth'] as const) {
      expect(
        bridgeImplementsRun({ run_id: 1, run_type, connector_key: 'os.shell' } as never, provider)
      ).toBe(true);
    }
  });

  test('refuses a connector the app never advertised', () => {
    expect(
      bridgeImplementsRun(
        { run_id: 2, run_type: 'action', connector_key: 'apple.photos' } as never,
        provider
      )
    ).toBe(false);
  });

  // The gateway ships code only for connectors the device does NOT implement,
  // so a compiled payload is never bridge work however the inventory reads.
  test('refuses a compiled payload and a run with no connector', () => {
    expect(
      bridgeImplementsRun(
        {
          run_id: 3,
          run_type: 'action',
          connector_key: 'os.shell',
          compiled_code: 'must-not-execute',
        } as never,
        provider
      )
    ).toBe(false);
    expect(bridgeImplementsRun({ run_id: 4, run_type: 'action' } as never, provider)).toBe(false);
  });

  // A daemon started without the app's advertisement channel knows of no
  // implementation at all, so it must claim none rather than assume one.
  test('refuses everything when no advertisement provider is attached', () => {
    expect(
      bridgeImplementsRun(
        { run_id: 5, run_type: 'action', connector_key: 'os.shell' } as never,
        undefined
      )
    ).toBe(false);
  });
});

// os.shell runs in the daemon's own builtin; every other advertised connector
// stays native app work over the bridge.
describe('executeAdvertisedConnectorRun', () => {
  function recordingClient() {
    const completions: Array<Record<string, unknown>> = [];
    return {
      completions,
      client: {
        id: 'macos:test',
        async heartbeat() {},
        async completeAction(input: Record<string, unknown>) {
          completions.push(input);
        },
      },
    };
  }
  const advertising = (key: string) =>
    new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [{ key }], generation: 1 });

  test.skipIf(!existsSync('/bin/zsh'))('runs os.shell through the daemon builtin, not the bridge', async () => {
    // An empty ZDOTDIR keeps the developer's own zsh profile out of stdout.
    const profileDir = mkdtempSync(join(tmpdir(), 'lobu-mac-shell-profile-'));
    const savedZdotdir = process.env.ZDOTDIR;
    process.env.ZDOTDIR = profileDir;
    try {
      const { client, completions } = recordingClient();
      const bridge = {
        run() {
          throw new Error('os.shell must not reach the native bridge');
        },
      };
      await executeAdvertisedConnectorRun(
        client as never,
        {
          run_id: 71,
          run_type: 'action',
          connector_key: 'os.shell',
          action_key: 'run',
          action_input: { command: '[[ -o login ]] && echo login', cwd: process.cwd() },
        },
        { advertisementProvider: advertising('os.shell'), bridge: bridge as never }
      );
      expect(completions).toEqual([
        expect.objectContaining({ run_id: 71, status: 'success', action_output: expect.objectContaining({ stdout: 'login\n' }) }),
      ]);
    } finally {
      if (savedZdotdir === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = savedZdotdir;
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('keeps other advertised actions on the native bridge', async () => {
    const { client, completions } = recordingClient();
    const calls: Array<Record<string, unknown>> = [];
    const bridge = {
      async run(input: Record<string, unknown>) {
        calls.push(input);
        return { action_output: { native: true } };
      },
    };
    await executeAdvertisedConnectorRun(
      client as never,
      { run_id: 73, run_type: 'action', connector_key: 'apple.computer_use', action_key: 'click' },
      { advertisementProvider: advertising('apple.computer_use'), bridge: bridge as never }
    );
    expect(calls).toEqual([expect.objectContaining({ operation: 'action' })]);
    expect(completions).toEqual([expect.objectContaining({ status: 'success', action_output: { native: true } })]);
  });
});
