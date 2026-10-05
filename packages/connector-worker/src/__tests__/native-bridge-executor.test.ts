import { describe, expect, test } from 'bun:test';
import { executeNativeBridgeRun } from '../daemon/native-bridge/executor';

const item = (id: string) => ({
  id,
  payload_text: id,
  occurred_at: '2026-08-22T00:00:00Z',
});

function fakeClient() {
  const calls: Record<string, unknown[]> = {
    stream: [],
    complete: [],
    completeAction: [],
    completeAuth: [],
    completeAutomation: [],
    heartbeat: [],
  };
  return {
    id: 'mac:test',
    calls,
    heartbeat: async (runId: number) => calls.heartbeat.push(runId),
    stream: async (value: unknown) => calls.stream.push(value),
    complete: async (value: unknown) => calls.complete.push(value),
    completeAction: async (value: unknown) => calls.completeAction.push(value),
    completeAuth: async (value: unknown) => calls.completeAuth.push(value),
    completeAutomation: async (runId: number, value: unknown) => calls.completeAutomation.push({ runId, value }),
  } as never;
}

describe('native bridge run forwarding', () => {
  test('preserves server attribution separately from caller-controlled input', async () => {
    const source = { agent_id: 'synthetic-agent', agent_name: 'Research agent', client_name: 'Registered client' };
    let forwarded: Record<string, unknown> | undefined;
    const bridge = {
      run: async ({ job }: { job: Record<string, unknown> }) => {
        forwarded = job;
        return {};
      },
    } as never;
    await executeNativeBridgeRun(fakeClient(), bridge, {
      run_id: 41,
      run_type: 'action',
      action_key: 'observe',
      source_attribution: source,
      action_input: { source_attribution: { agent_name: 'Impersonated agent' }, status_message: 'Checking a window' },
    } as never);
    expect(forwarded?.source_attribution).toEqual(source);
    expect(forwarded?.action_input).toEqual({
      source_attribution: { agent_name: 'Impersonated agent' }, status_message: 'Checking a window',
    });
  });

  test('forwards sync chunks in order and completes once with the final checkpoint', async () => {
    const client = fakeClient() as {
      calls: Record<string, unknown[]>;
      id: string;
      stream: (value: unknown) => Promise<void>;
    };
    const bridge = {
      run: async (options: { operation: string; onStream?: (payload: Record<string, unknown>, sequence: number) => Promise<void> }) => {
        expect(options.operation).toBe('sync');
        await options.onStream?.({ items: [item('a')] }, 1);
        await options.onStream?.({ items: [item('b')], checkpoint: { cursor: '2' } }, 2);
        return { checkpoint: { cursor: '2' } };
      },
    } as never;

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 9,
      run_type: 'sync',
      connector_key: 'apple.files',
      connector_version: '1.0.0',
      config: {},
    } as never);

    expect(result).toEqual({ itemsCollected: 2 });
    expect(client.calls.stream).toHaveLength(2);
    expect((client.calls.stream[0] as { items: { id: string }[] }).items.map((entry) => entry.id)).toEqual(['a']);
    expect((client.calls.stream[1] as { items: { id: string }[] }).items.map((entry) => entry.id)).toEqual(['b']);
    expect(client.calls.complete).toEqual([
      expect.objectContaining({ run_id: 9, status: 'success', items_collected: 2, checkpoint: { cursor: '2' } }),
    ]);
  });

  test('completes an action exactly once and never retries after bridge failure', async () => {
    const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
    let runCalls = 0;
    const bridge = {
      run: async (options: { operation: string }) => {
        expect(options.operation).toBe('action');
        runCalls++;
        throw new Error('app EOF');
      },
    } as never;

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 10,
      run_type: 'action',
      action_key: 'open',
      action_input: {},
    } as never);

    expect(result.error).toBe('app EOF');
    expect(runCalls).toBe(1);
    expect(client.calls.completeAction).toEqual([
      expect.objectContaining({ run_id: 10, status: 'failed', error_message: 'app EOF' }),
    ]);
  });

  test('retries terminal delivery after the first completion request fails', async () => {
    const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
    let completionAttempts = 0;
    client.completeAction = async (value: unknown) => {
      completionAttempts += 1;
      client.calls.completeAction.push(value);
      if (completionAttempts === 1) throw new Error('terminal delivery failed');
    };
    const bridge = {
      run: async () => ({}),
    } as never;

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 10,
      run_type: 'action',
      action_key: 'open',
      action_input: {},
    } as never);

    expect(result).toEqual({ itemsCollected: 0 });
    expect(completionAttempts).toBe(2);
    expect(client.calls.completeAction).toHaveLength(2);
    expect(client.calls.completeAction[0]).toEqual(client.calls.completeAction[1]);
    expect(client.calls.completeAction[1]).toEqual(
      expect.objectContaining({ run_id: 10, status: 'success', action_output: {} }),
    );
  });

  test('does not advance or commit a checkpoint from a failed stream', async () => {
    const client = fakeClient() as {
      calls: Record<string, unknown[]>;
      id: string;
      stream: (value: unknown) => Promise<void>;
    };
    const bridge = {
      run: async (options: { operation: string; onStream?: (payload: Record<string, unknown>, sequence: number) => Promise<void> }) => {
        expect(options.operation).toBe('sync');
        await options.onStream?.({ items: [item('a')], checkpoint: { cursor: '1' } }, 1);
        await options.onStream?.({ items: [item('b')], checkpoint: { cursor: '2' } }, 2);
        return { checkpoint: { cursor: '2' } };
      },
    } as never;
    let streamCalls = 0;
    client.stream = async (value: unknown) => {
      streamCalls += 1;
      if (streamCalls === 2) throw new Error('stream delivery failed');
      client.calls.stream.push(value);
    };

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 11,
      run_type: 'sync',
      connector_key: 'apple.files',
    } as never);

    expect(result.error).toBe('stream delivery failed');
    expect(client.calls.complete).toEqual([
      expect.objectContaining({ run_id: 11, status: 'failed', items_collected: 1 }),
    ]);
    expect((client.calls.complete[0] as Record<string, unknown>).checkpoint).toBeUndefined();
  });

  test('completes auth exactly once with bridge credentials and metadata', async () => {
    const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
    const bridge = {
      run: async (options: { operation: string }) => {
        expect(options.operation).toBe('auth');
        return {
          credentials: { access_token: 'scoped-result' },
          metadata: { profile: 'device' },
        };
      },
    } as never;

    await expect(
      executeNativeBridgeRun(client as never, bridge, {
        run_id: 12,
        run_type: 'auth',
        connector_key: 'apple.files',
      } as never),
    ).resolves.toEqual({ itemsCollected: 0 });
    expect(client.calls.completeAuth).toEqual([
      expect.objectContaining({
        run_id: 12,
        status: 'success',
        credentials: { access_token: 'scoped-result' },
        metadata: { profile: 'device' },
      }),
    ]);
  });

  test('uses one explicit read operation for filtered and unfiltered feed reads', async () => {
    const operations: string[] = [];
    const client = fakeClient();
    const bridge = {
      run: async (options: { operation: string }) => {
        operations.push(options.operation);
        return {};
      },
    } as never;

    for (const actionInput of [{}, { query: 'ada' }]) {
      await executeNativeBridgeRun(client as never, bridge, {
        run_id: actionInput.query ? 14 : 13,
        run_type: 'action',
        action_key: '__lobu_feed_read',
        action_input: actionInput,
      } as never);
    }

    expect(operations).toEqual(['read', 'read']);
  });

  test('rejects automation and embed_backfill runs without using completeAction', async () => {
    const client = fakeClient() as {
      calls: Record<string, unknown[]>;
      id: string;
    };
    const bridge = {
      run: async () => {
        throw new Error('must not execute');
      },
    } as never;

    const automation = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 17,
      run_type: 'automation',
    } as never);
    const embedBackfill = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 18,
      run_type: 'embed_backfill',
    } as never);

    expect(automation.error).toContain('native bridge does not execute run_type automation');
    expect(embedBackfill.error).toContain('native bridge does not execute run_type embed_backfill');
    expect(client.calls.completeAction).toEqual([]);
    expect(client.calls.completeAutomation).toEqual([
      expect.objectContaining({ runId: 17, value: expect.objectContaining({ error: automation.error }) }),
    ]);
    expect(client.calls.complete).toEqual([
      expect.objectContaining({ run_id: 18, status: 'failed', error_message: embedBackfill.error }),
    ]);
  });

  test('times out a hung native run, cancels its owner, and reports failure', async () => {
    const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
    const cancellations: Array<[string, number]> = [];
    const abandonments: Array<[string, number]> = [];
    const bridge = {
      run: async () => new Promise<never>(() => undefined),
      cancel: async (requestId: string, runId: number) => {
        cancellations.push([requestId, runId]);
      },
      cancelAndAbandon: async (requestId: string, runId: number) => {
        abandonments.push([requestId, runId]);
      },
    } as never;

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 19,
      run_type: 'action',
      action_key: 'hang',
    } as never, 5);

    expect(result.error).toBe('native bridge run timed out after 5ms');
    expect(cancellations).toEqual([]);
    expect(abandonments).toEqual([[expect.any(String), 19]]);
    expect(client.calls.completeAction).toEqual([
      expect.objectContaining({ run_id: 19, status: 'failed', error_message: result.error }),
    ]);
  });

  test('heartbeats a long native run and clears the heartbeat after terminal completion', async () => {
    const scheduled: Array<() => Promise<void> | void> = [];
    const cleared: unknown[] = [];
    const intervals: unknown[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: () => Promise<void> | void, delayMs?: number) => {
      scheduled.push(callback);
      intervals.push(delayMs);
      return scheduled.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: unknown) => {
      cleared.push(id);
    }) as typeof clearInterval;

    try {
      const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
      const bridge = {
        run: async () => {
          await scheduled[0]?.();
          await scheduled[0]?.();
          return {};
        },
      } as never;

      await expect(executeNativeBridgeRun(client as never, bridge, {
        run_id: 15,
        run_type: 'action',
        action_key: 'long_operation',
      } as never)).resolves.toEqual({ itemsCollected: 0 });
      expect(client.calls.heartbeat).toEqual([15, 15]);
      expect(intervals).toEqual([30_000]);
      expect(cleared).toEqual([1]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test('heartbeats a long sync run and stops after terminal completion', async () => {
    const scheduled: Array<() => Promise<void> | void> = [];
    const cleared: unknown[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: () => Promise<void> | void) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: unknown) => {
      cleared.push(id);
    }) as typeof clearInterval;

    try {
      const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
      const bridge = {
        run: async (options: { operation: string }) => {
          expect(options.operation).toBe('sync');
          await scheduled[0]?.();
          return { checkpoint: { cursor: 'done' } };
        },
      } as never;

      await expect(executeNativeBridgeRun(client as never, bridge, {
        run_id: 16,
        run_type: 'sync',
        connector_key: 'apple.files',
      } as never)).resolves.toEqual({ itemsCollected: 0 });
      expect(client.calls.heartbeat).toEqual([16]);
      expect(cleared).toEqual([1]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
