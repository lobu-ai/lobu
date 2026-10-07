/**
 * Heartbeat coverage for the action + embed_backfill executor lanes.
 *
 * lobu#860: PR #859 narrowed the gateway's stale-run reaper to lanes that
 * actually emit `client.heartbeat()` (sync, auth). This test asserts the
 * other two connector-worker lanes — `action` (executeActionRun) and
 * `embed_backfill` (executeEmbedBackfillRun) — now heartbeat on the same
 * 30s cadence so the reaper can be widened back to all four lanes.
 *
 * Strategy: mock the heavy collaborators (`executeCompiledConnector`,
 * `batchGenerateEmbeddings`) so the executor body resolves quickly, and
 * drive the registered setInterval manually to simulate the 70s window
 * (the heartbeat fires at t=30 and t=60, so we should see at least 2
 * calls to `client.heartbeat`).
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: test seam — module mocks need loose types
type AnyFn = (...args: any[]) => any;

const executeCompiledConnectorMock = mock<AnyFn>(async () => ({
  mode: 'action',
  output: { ok: true },
}));

const batchGenerateEmbeddingsMock = mock<AnyFn>(async (texts: string[]) => ({
  embeddings: texts.map(() => [0.1, 0.2, 0.3]),
  model: 'test-model',
}));

mock.module('../executor/runtime.js', () => ({
  executeCompiledConnector: executeCompiledConnectorMock,
}));


mock.module('../embeddings.js', () => ({
  batchGenerateEmbeddings: batchGenerateEmbeddingsMock,
  generateEmbedding: async () => [0, 0, 0],
}));

mock.module('../compile-connector.js', () => ({
  // `resolveJobCode` compiles for the isolate and nothing else; a mock that
  // still names the retired non-isolate build would let a real compile run
  // here, and bun's module mocks are process-wide.
  compileConnectorForIsolateFromFile: async () => 'compiled-code',
  findBundledConnectorFile: () => '/fake/path',
}));


import { WorkerHttpError } from '../daemon/client.js';
import { executeRun } from '../daemon/executor.js';

function makeStubClient() {
  const client = {
    id: 'test-worker',
    version: 'test',
    __heartbeats: 0,
    async heartbeat(_runId: number) {
      client.__heartbeats += 1;
    },
    async stream() {},
    async complete() {},
    async completeAction() {},
    async completeEmbeddings() {},
    async completeAuth() {},
    async emitAuthArtifact() {},
    async pollAuthSignal() {
      return { signal: null };
    },
    async fetchEventsForEmbedding(ids: number[]) {
      return ids.map((id) => ({ id, title: 't', content: 'c' }));
    },
  };
  return client;
}

describe('executor heartbeats (lobu#860)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy refs
  let setIntervalSpy: any;
  let scheduledIntervals: Array<{ fn: () => Promise<void> | void; ms: number; id: number }>;
  let intervalsEverScheduledMs: number[];
  let nextId: number;

  beforeEach(() => {
    nextId = 1;
    scheduledIntervals = [];
    executeCompiledConnectorMock.mockClear();
    batchGenerateEmbeddingsMock.mockClear();

    intervalsEverScheduledMs = [];
    setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      ((fn: any, ms: number) => {
        const id = nextId++;
        scheduledIntervals.push({ fn, ms, id });
        intervalsEverScheduledMs.push(ms);
        return id;
        // biome-ignore lint/suspicious/noExplicitAny: cast for setInterval typing
      }) as any
    );
    spyOn(globalThis, 'clearInterval').mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      ((id: any) => {
        scheduledIntervals = scheduledIntervals.filter((s) => s.id !== id);
      }) as () => void
    );
  });

  afterEach(() => {
    setIntervalSpy?.mockRestore();
    // biome-ignore lint/suspicious/noExplicitAny: cleanup
    (globalThis.clearInterval as any).mockRestore?.();
  });

  // Drive each registered interval `tickCount` times by invoking the
  // function directly. The executor's setInterval is the only one we
  // scheduled (via the spy), so this is the heartbeat tick.
  async function fireIntervalTicks(tickCount: number) {
    for (let i = 0; i < tickCount; i++) {
      for (const s of [...scheduledIntervals]) {
        await s.fn();
      }
    }
  }

  test('executeActionRun heartbeats at least twice over a 70s simulated run', async () => {
    const client = makeStubClient();

    // Make executeCompiledConnector return only AFTER 2 heartbeat ticks
    // have fired — simulates the action body taking 60+ seconds.
    executeCompiledConnectorMock.mockImplementationOnce(async () => {
      await fireIntervalTicks(2);
      return { mode: 'action', output: { ok: true } };
    });

    const job = {
      run_id: 100,
      run_type: 'action',
      connector_key: 'fake',
      action_key: 'do_thing',
      action_input: {},
      compiled_code: 'compiled-code',
      // biome-ignore lint/suspicious/noExplicitAny: minimal job shape
    } as any;

    // biome-ignore lint/suspicious/noExplicitAny: minimal env
    const result = await executeRun(client as any, job, {} as any, {
      executor: { execute: executeCompiledConnectorMock },
    });
    expect(result.error).toBeUndefined();
    expect(client.__heartbeats).toBeGreaterThanOrEqual(2);

    // 30s cadence is the contract with the gateway reaper (default
    // RUNS_REAPER_STALE_AFTER_SECONDS=120 ÷ 4 ≈ 30s). Assert that
    // executeActionRun actually used 30_000ms for its setInterval.
    // `intervalsEverScheduledMs` accumulates across the run, so even
    // after `finally` clears the interval the registration is still
    // recorded here.
    expect(intervalsEverScheduledMs).toContain(30_000);
  });

  // The daemon routes from its own registry, so a connector it implements never
  // reaches the compiled path — including when a payload contradicts itself by
  // carrying code for one.
  test('generic compiled executor refuses a contradictory built-in payload', async () => {
    const client = makeStubClient();
    const job = {
      run_id: 101,
      run_type: 'action',
      connector_key: 'os.shell',
      action_key: 'run',
      action_input: { command: 'true' },
      compiled_code: 'must-not-execute',
    } as any;

    const result = await executeRun(client as any, job, {} as any);
    expect(result.error).toContain('must not contain compiled_code');
    expect(executeCompiledConnectorMock).not.toHaveBeenCalled();
  });

  test('revoked action lease aborts a running isolate', async () => {
    const client = makeStubClient();
    client.heartbeat = async () => { throw new WorkerHttpError(409, '/heartbeat', 'Run is not in progress'); };
    let signal: AbortSignal | undefined;
    executeCompiledConnectorMock.mockImplementationOnce(async ({ hooks }) => {
      signal = hooks?.signal;
      await fireIntervalTicks(1);
      return { mode: 'action', output: {} };
    });
    await executeRun(client as any, { run_id: 102, run_type: 'action', connector_key: 'fake', action_key: 'run', compiled_code: 'compiled-code' } as any, {} as any, { executor: { execute: executeCompiledConnectorMock } });
    expect(signal?.aborted).toBe(true);
  });

  test('a transient heartbeat failure does not cancel healthy action work', async () => {
    const client = makeStubClient();
    client.heartbeat = async () => { throw new WorkerHttpError(503, '/heartbeat', 'temporarily unavailable'); };
    let signal: AbortSignal | undefined;
    executeCompiledConnectorMock.mockImplementationOnce(async ({ hooks }) => {
      signal = hooks?.signal;
      await fireIntervalTicks(1);
      return { mode: 'action', output: {} };
    });
    await executeRun(client as any, { run_id: 103, run_type: 'action', connector_key: 'fake', action_key: 'run', compiled_code: 'compiled-code' } as any, {} as any, { executor: { execute: executeCompiledConnectorMock } });
    expect(signal?.aborted).toBe(false);
  });

  test('revoked shell lease terminates the running process before its deadline', async () => {
    const client = makeStubClient();
    client.heartbeat = async () => { throw new WorkerHttpError(409, '/heartbeat', 'Run is not in progress'); };
    const complete = spyOn(client, 'completeAction');
    const started = Date.now();
    const execution = executeRun(client as any, { run_id: 104, run_type: 'action', connector_key: 'os.shell', action_key: 'run', action_input: { command: 'sleep 10', timeout_ms: 15000 } } as any, {} as any);
    await new Promise(resolve => setTimeout(resolve, 100));
    await fireIntervalTicks(1);
    await execution;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(complete).not.toHaveBeenCalled();
  }, 20000);

  test('executeEmbedBackfillRun heartbeats at least twice over a 70s simulated run', async () => {
    const client = makeStubClient();

    batchGenerateEmbeddingsMock.mockImplementationOnce(async (texts: string[]) => {
      await fireIntervalTicks(2);
      return { embeddings: texts.map(() => [0.1, 0.2, 0.3]), model: 'test-model' };
    });

    const job = {
      run_id: 200,
      run_type: 'embed_backfill',
      action_input: { event_ids: [1, 2, 3] },
      compiled_code: 'compiled-code',
      // biome-ignore lint/suspicious/noExplicitAny: minimal job
    } as any;

    // biome-ignore lint/suspicious/noExplicitAny: minimal env
    const result = await executeRun(client as any, job, {} as any);
    expect(result.error).toBeUndefined();
    expect(client.__heartbeats).toBeGreaterThanOrEqual(2);
  });

  test('heartbeat interval is cleared after a successful action run', async () => {
    const client = makeStubClient();
    executeCompiledConnectorMock.mockImplementationOnce(async () => ({
      mode: 'action',
      output: { ok: true },
    }));

    const job = {
      run_id: 300,
      run_type: 'action',
      connector_key: 'fake',
      action_key: 'do_thing',
      action_input: {},
      compiled_code: 'compiled-code',
      // biome-ignore lint/suspicious/noExplicitAny: minimal job
    } as any;

    // biome-ignore lint/suspicious/noExplicitAny: minimal env
    await executeRun(client as any, job, {} as any, {
      executor: { execute: executeCompiledConnectorMock },
    });
    // After the run, the heartbeat interval should be cleared on every
    // path via `finally`.
    expect(scheduledIntervals.length).toBe(0);
  });

  test('heartbeat interval is cleared after a failed action run', async () => {
    const client = makeStubClient();
    executeCompiledConnectorMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const job = {
      run_id: 400,
      run_type: 'action',
      connector_key: 'fake',
      action_key: 'do_thing',
      action_input: {},
      compiled_code: 'compiled-code',
      // biome-ignore lint/suspicious/noExplicitAny: minimal job
    } as any;

    // biome-ignore lint/suspicious/noExplicitAny: minimal env
    const result = await executeRun(client as any, job, {} as any, {
      executor: { execute: executeCompiledConnectorMock },
    });
    expect(result.error).toContain('boom');
    expect(scheduledIntervals.length).toBe(0);
  });
});
