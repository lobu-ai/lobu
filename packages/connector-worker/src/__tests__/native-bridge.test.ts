import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'bun:test';
import {
  MutableWorkerAdvertisementProvider,
  WorkerClient,
} from '../daemon/client';
import { NativeBridgeClient } from '../daemon/native-bridge/client';
import {
  decodeNativeBridgeBody,
  encodeNativeBridgeFrame,
  NativeBridgeFrameDecoder,
  NativeBridgeProtocolError,
  NATIVE_BRIDGE_MAX_FRAME_BYTES,
  NATIVE_BRIDGE_PROTOCOL,
  NATIVE_BRIDGE_PROTOCOL_VERSION,
} from '../daemon/native-bridge/protocol';

const frame = (overrides: Record<string, unknown> = {}) =>
  encodeNativeBridgeFrame({
    version: NATIVE_BRIDGE_PROTOCOL_VERSION,
    kind: 'ping',
    request_id: 'request-1',
    payload: {},
    ...overrides,
  } as never);

describe('native bridge framing', () => {
  test('decodes fragmented and coalesced frames', () => {
    const first = frame();
    const second = frame({ request_id: 'request-2' });
    const decoder = new NativeBridgeFrameDecoder();

    expect(decoder.append(first.subarray(0, 2))).toEqual([]);
    expect(decoder.append(Buffer.alloc(0))).toEqual([]);
    expect(decoder.append(Buffer.concat([first.subarray(2), second]))).toMatchObject([
      { request_id: 'request-1' },
      { request_id: 'request-2' },
    ]);
  });

  test('fails closed on short headers, malformed JSON, oversized frames, unknown kinds, versions, and IDs', () => {
    const decoder = new NativeBridgeFrameDecoder();
    decoder.append(Buffer.from([1, 2, 3]));
    expect(() => decoder.finish()).toThrow(NativeBridgeProtocolError);
    expect(() => decodeNativeBridgeBody(Buffer.from('{'))).toThrow('malformed JSON');

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(NATIVE_BRIDGE_MAX_FRAME_BYTES + 1, 0);
    expect(() => new NativeBridgeFrameDecoder().append(oversized)).toThrow('exceeds');
    expect(() => decodeNativeBridgeBody(Buffer.from(JSON.stringify({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'unknown',
      request_id: 'r',
      payload: {},
    })))).toThrow('unsupported');
    expect(() => decodeNativeBridgeBody(Buffer.from(JSON.stringify({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION - 1,
      kind: 'ping',
      request_id: 'r',
      payload: {},
    })))).toThrow('unsupported');
    expect(() => decodeNativeBridgeBody(Buffer.from(JSON.stringify({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'ping',
      payload: {},
    })))).toThrow('request_id');
    expect(() => decodeNativeBridgeBody(Buffer.from(JSON.stringify({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'ping',
      request_id: 'r',
    })))).toThrow('payload');

    const bounded = new NativeBridgeFrameDecoder();
    expect(() => bounded.append(Buffer.concat(Array.from({ length: 129 }, (_, index) => frame({ request_id: `r-${index}` }))))).toThrow('queue');
  });

  test('accepts a bounded large action result frame', () => {
    const image = 'x'.repeat(1_100_000);
    const encoded = frame({
      kind: 'complete',
      run_id: 1,
      payload: { action_output: { image_base64: image } },
    });
    expect(encoded.byteLength).toBeGreaterThan(1_000_000);
    expect(new NativeBridgeFrameDecoder().append(encoded)[0]?.payload).toMatchObject({
      action_output: { image_base64: image },
    });
  });
});

function helloFrame(workerId = 'mac:test', generation: number | null = 4) {
  return encodeNativeBridgeFrame({
    version: NATIVE_BRIDGE_PROTOCOL_VERSION,
    kind: 'hello',
    request_id: 'hello-1',
    payload: {
      protocol: NATIVE_BRIDGE_PROTOCOL,
      protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      app_build: 'app-build-1',
      daemon_build: 'daemon-build-1',
      worker_id: workerId,
      nonce: 'nonce-1',
      capabilities: { 'os.files': true },
      connector_manifests: [{ key: 'apple.files', version: '1.0.0' }],
      ...(generation === null ? {} : { generation }),
    },
  });
}

describe('native bridge handshake', () => {
  test('accepts an omitted generation with the supervised daemon seed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({
      capabilities: {},
      manifests: [],
      generation: 0,
    });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    input.write(helloFrame('mac:test', null));
    await expect(bridge.handshake()).resolves.toBeUndefined();
    expect(provider.snapshot().generation).toBe(1);
    input.destroy();
    output.destroy();
  });

  test('rejects a forged worker ownership marker', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1', 50);
    input.write(helloFrame('mac:forged'));
    await expect(bridge.handshake()).rejects.toThrow('worker_id does not match');
    input.destroy();
    output.destroy();
  });

  test('does not emit a run before hello, then acknowledges nonce/build and owns the run', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({
      capabilities: {},
      manifests: [],
      generation: 0,
    });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    const outputDecoder = new NativeBridgeFrameDecoder();
    const runPromise = bridge.run({
      operation: 'action',
      job: { run_id: 42, connector_key: 'apple.files' },
      requestId: 'run-1',
    });

    await Bun.sleep(5);
    expect(output.read()).toBeNull();
    input.write(helloFrame());
    await bridge.handshake();
    const handshakeFrames = [];
    while (handshakeFrames.length < 2) {
      const chunk = output.read();
      if (chunk) {
        handshakeFrames.push(...outputDecoder.append(chunk as Buffer));
      } else {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const acknowledgement = handshakeFrames[0]!;
    expect(acknowledgement).toMatchObject({
      kind: 'hello_ack',
      request_id: 'hello-1',
      payload: {
        protocol: NATIVE_BRIDGE_PROTOCOL,
        daemon_build: 'daemon-build-1',
        nonce: 'nonce-1',
        worker_id: 'mac:test',
      },
    });
    const runFrame = handshakeFrames[1]!;
    expect(runFrame).toMatchObject({ kind: 'run', request_id: 'run-1', run_id: 42 });
    expect(runFrame.payload).toMatchObject({ operation: 'action' });

    input.write(encodeNativeBridgeFrame({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'complete',
      request_id: 'run-1',
      run_id: 42,
      payload: { action_output: { ok: true } },
    }));
    await expect(runPromise).resolves.toMatchObject({ action_output: { ok: true } });
    input.destroy();
    output.destroy();
  });

  test('keeps other runs alive when one stream callback fails', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    const transportFailures: Error[] = [];
    bridge.onTransportFailure((error) => transportFailures.push(error));
    input.write(helloFrame());
    await bridge.handshake();
    output.read();

    const failedRun = bridge.run({
      operation: 'action',
      requestId: 'stream-failure:one',
      job: { run_id: 51 },
      onStream: async () => {
        throw new Error('owning stream failed');
      },
    });
    const healthyRun = bridge.run({
      operation: 'action',
      requestId: 'healthy-run',
      job: { run_id: 52 },
    });
    await Bun.sleep(5);
    output.read();

    input.write(Buffer.concat([
      encodeNativeBridgeFrame({
        version: NATIVE_BRIDGE_PROTOCOL_VERSION,
        kind: 'stream',
        request_id: 'stream-failure:one',
        run_id: 51,
        sequence: 0,
        payload: {},
      }),
      encodeNativeBridgeFrame({
        version: NATIVE_BRIDGE_PROTOCOL_VERSION,
        kind: 'complete',
        request_id: 'healthy-run',
        run_id: 52,
        payload: { action_output: { ok: true } },
      }),
    ]));

    await expect(failedRun).rejects.toThrow('owning stream failed');
    await expect(healthyRun).resolves.toMatchObject({ action_output: { ok: true } });
    expect(transportFailures).toEqual([]);
    input.destroy();
    output.destroy();
  });

  test('rejects non-monotonic stream sequences', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    input.write(helloFrame());
    await bridge.handshake();
    output.read();
    const runPromise = bridge.run({
      operation: 'action',
      requestId: 'sequence-run',
      job: { run_id: 53 },
      onStream: async () => undefined,
    });
    await Bun.sleep(5);
    output.read();
    input.write(encodeNativeBridgeFrame({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'stream',
      request_id: 'sequence-run',
      run_id: 53,
      sequence: 1,
      payload: {},
    }));
    input.write(encodeNativeBridgeFrame({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'stream',
      request_id: 'sequence-run',
      run_id: 53,
      sequence: 0,
      payload: {},
    }));
    await expect(runPromise).rejects.toThrow('not monotonic');
    input.destroy();
    output.destroy();
  });

  test('rejects a second terminal frame for the same run', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    const failures: Error[] = [];
    bridge.onTransportFailure((error) => failures.push(error));
    input.write(helloFrame());
    await bridge.handshake();
    output.read();
    const runPromise = bridge.run({ operation: 'action', requestId: 'terminal-run', job: { run_id: 54 } });
    await Bun.sleep(5);
    output.read();
    const terminal = encodeNativeBridgeFrame({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'complete',
      request_id: 'terminal-run',
      run_id: 54,
      payload: {},
    });
    input.write(Buffer.concat([terminal, terminal]));
    await expect(runPromise).resolves.toEqual({});
    await Bun.sleep(5);
    expect(failures[0]?.message).toContain('more than one terminal frame');
    input.destroy();
    output.destroy();
  });

  test('preserves ordinary path-like and pat-containing job keys while redacting PAT fields', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    input.write(helloFrame());
    await bridge.handshake();
    const decoder = new NativeBridgeFrameDecoder();
    decoder.append(output.read() as Buffer);
    const runPromise = bridge.run({
      operation: 'action',
      requestId: 'sanitize-run',
      job: {
        run_id: 55,
        config: {
          path: '/tmp/docs',
          patterns: ['*.md'],
          dispatch: 'refresh',
          compatibility: true,
          pat: 'secret-pat',
          auth_profile: 'secret-profile',
        },
      },
    });
    await Bun.sleep(5);
    const runBytes = output.read();
    expect(runBytes).not.toBeNull();
    const frames = decoder.append(runBytes as Buffer);
    expect(frames[0]?.payload).toMatchObject({
      job: { config: { path: '/tmp/docs', patterns: ['*.md'], dispatch: 'refresh', compatibility: true } },
    });
    expect((frames[0]?.payload as { job: { config: Record<string, unknown> } }).job.config.pat).toBeUndefined();
    expect((frames[0]?.payload as { job: { config: Record<string, unknown> } }).job.config.auth_profile).toBeUndefined();
    input.write(encodeNativeBridgeFrame({
      version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      kind: 'complete',
      request_id: 'sanitize-run',
      run_id: 55,
      payload: {},
    }));
    await expect(runPromise).resolves.toEqual({});
    input.destroy();
    output.destroy();
  });

  test('refreshes the worker advertisement used by subsequent polls', async () => {
    const calls: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ next_poll_seconds: 5 }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = new MutableWorkerAdvertisementProvider({
        capabilities: { old: true },
        manifests: [{ key: 'old' }],
        generation: 1,
      });
      const client = new WorkerClient({
        apiUrl: 'https://example.test',
        workerId: 'mac:test',
        capabilities: { daemon: true, shared: false },
        advertisementProvider: provider,
      });
      await client.poll();
      provider.update({ capabilities: { fresh: true }, manifests: [{ key: 'fresh' }], generation: 2 });
      await client.poll();
      expect(calls.map((call) => [call.capabilities, call.connector_manifests])).toEqual([
        [{ daemon: true, shared: false, old: true, feed_delivery: true }, [{ key: 'old' }]],
        [{ daemon: true, shared: false, fresh: true, feed_delivery: true }, [{ key: 'fresh' }]],
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('sends an explicit empty manifest refresh and rejects changed equal generations', async () => {
    const calls: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ next_poll_seconds: 5 }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = new MutableWorkerAdvertisementProvider({
        capabilities: { old: true },
        manifests: [{ key: 'old' }],
        generation: 4,
      });
      const client = new WorkerClient({
        apiUrl: 'https://example.test',
        workerId: 'mac:test',
        advertisementProvider: provider,
      });
      provider.update({ capabilities: {}, manifests: [], generation: 5 });
      await client.poll();
      expect(calls[0]?.connector_manifests).toEqual([]);
      expect(() => provider.update({ capabilities: { changed: true }, manifests: [], generation: 5 })).toThrow(
        'must increase',
      );
      expect(() => provider.update({ capabilities: {}, manifests: [], generation: 4 })).toThrow(
        'monotonic',
      );
      expect(() => provider.update({ capabilities: {}, manifests: [], generation: 5 })).not.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('cancels an active run once and fails it on app EOF without replay', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    const outputDecoder = new NativeBridgeFrameDecoder();
    input.write(helloFrame());
    await bridge.handshake();
    outputDecoder.append(output.read() as Buffer);
    const runPromise = bridge.run({ operation: 'action', requestId: 'run-cancel', job: { run_id: 43 } });
    await Bun.sleep(5);
    outputDecoder.append(output.read() as Buffer);

    await bridge.cancelActiveRuns();
    await bridge.cancelActiveRuns();
    const cancelFrame = outputDecoder.append(output.read() as Buffer)[0]!;
    expect(cancelFrame).toMatchObject({ kind: 'cancel', request_id: 'run-cancel', run_id: 43 });
    expect(output.read()).toBeNull();
    input.end();
    await expect(runPromise).rejects.toThrow('app EOF');
    await expect(
      bridge.run({ operation: 'action', requestId: 'run-after-eof', job: { run_id: 44 } }),
    ).rejects.toThrow('app EOF');
    output.destroy();
  });

  test('abandons a timed-out run so ignored late frames cannot retain its owner', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    const outputDecoder = new NativeBridgeFrameDecoder();
    input.write(helloFrame());
    await bridge.handshake();
    outputDecoder.append(output.read() as Buffer);
    const transportFailures: Error[] = [];
    const removeTransportFailureHandler = bridge.onTransportFailure((error) => {
      transportFailures.push(error);
    });

    const runPromise = bridge.run({ operation: 'action', requestId: 'run-timeout', job: { run_id: 46 } });
    await Bun.sleep(5);
    outputDecoder.append(output.read() as Buffer);
    expect(bridge.activeRunCount).toBe(1);

    const timeoutError = new Error('native bridge run timed out');
    await bridge.cancelAndAbandon('run-timeout', 46, timeoutError);
    expect(bridge.activeRunCount).toBe(0);
    await expect(runPromise).rejects.toThrow(timeoutError.message);
    input.write(frame({
      kind: 'complete',
      request_id: 'run-timeout',
      run_id: 46,
      payload: { action_output: { ok: true } },
    }));
    await Bun.sleep(5);
    expect(bridge.activeRunCount).toBe(0);
    expect(transportFailures).toEqual([]);
    removeTransportFailureHandler();
    input.destroy();
    output.destroy();
  });

  test('rejects a run when the dequeued frame fails during output drain', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let writes = 0;
    const originalWrite = output.write.bind(output);
    output.write = ((chunk: Uint8Array) => {
      writes += 1;
      if (writes === 2) {
        queueMicrotask(() => output.emit('error', new Error('output failed')));
        return false;
      }
      return originalWrite(chunk);
    }) as typeof output.write;
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    input.write(helloFrame());
    await bridge.handshake();
    const runPromise = bridge.run({ operation: 'action', requestId: 'run-write-failure', job: { run_id: 45 } });
    await expect(runPromise).rejects.toThrow('output failed');
    await expect(bridge.run({ operation: 'action', requestId: 'run-after-write-failure', job: { run_id: 46 } })).rejects.toThrow(
      'output failed',
    );
    input.destroy();
    output.destroy();
  });

  test('rejects a pending run when the output reaches a terminal stream state', async () => {
    for (const event of ['close', 'finish', 'end'] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
      const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
      input.write(helloFrame());
      await bridge.handshake();
      output.read();
      const runPromise = bridge.run({ operation: 'action', requestId: `run-${event}`, job: { run_id: 48 } });
      output.emit(event);
      await expect(runPromise).rejects.toThrow(event === 'close' ? 'closed' : event === 'finish' ? 'finished' : 'EOF');
      input.destroy();
      output.destroy();
    }
  });

  test('rejects and cleans drain listeners when the output closes while draining', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const originalWrite = output.write.bind(output);
    let writes = 0;
    output.write = ((chunk: Uint8Array) => {
      writes += 1;
      if (writes === 2) {
        queueMicrotask(() => output.emit('close'));
        return false;
      }
      return originalWrite(chunk);
    }) as typeof output.write;
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    input.write(helloFrame());
    await bridge.handshake();
    const runPromise = bridge.run({ operation: 'action', requestId: 'run-drain-close', job: { run_id: 50 } });
    await expect(runPromise).rejects.toThrow('closed');
    expect(output.listenerCount('drain')).toBe(0);
    expect(output.listenerCount('error')).toBe(1);
    expect(output.listenerCount('close')).toBe(1);
    expect(output.listenerCount('finish')).toBe(1);
    expect(output.listenerCount('end')).toBe(1);
    input.destroy();
    output.destroy();
  });

  test('rejects a bridge created from an already closed output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.destroy();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1');
    await expect(bridge.run({ operation: 'action', job: { run_id: 49 } })).rejects.toThrow('closed');
    input.destroy();
  });

  test('times out a missing hello and never starts a poll-capable run', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const provider = new MutableWorkerAdvertisementProvider({ capabilities: {}, manifests: [], generation: 0 });
    const bridge = new NativeBridgeClient(input, output, provider, 'mac:test', 'daemon-build-1', 10);
    await expect(bridge.handshake()).rejects.toThrow(`timed out after 10ms`);
    await expect(bridge.run({ operation: 'action', job: { run_id: 47 } })).rejects.toThrow('timed out');
    input.destroy();
    output.destroy();
  });
});
