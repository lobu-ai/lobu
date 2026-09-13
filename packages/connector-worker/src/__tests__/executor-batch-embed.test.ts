/**
 * Finding #12 reproducer: the sync embedding path must batch a whole event
 * chunk into ONE embedding call (one HTTP round-trip / vectorized pass), not
 * one call per event, while still mapping each vector back to its source event.
 *
 * Strategy: mock `executeCompiledConnector` to invoke `onEventChunk` with a
 * 3-event chunk, mock `batchGenerateEmbeddings` to return distinguishable
 * vectors, and assert:
 *   - batchGenerateEmbeddings was called exactly ONCE (not 3x),
 *   - it received all 3 chunk texts in one call,
 *   - each streamed ContentItem carries the vector for its own text + the model
 *     stamp,
 *   - an event with empty text gets no embedding (per-event association held).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: test seam — module mocks need loose types
type AnyFn = (...args: any[]) => any;

// Return a vector derived from the text so we can assert per-event mapping.
const batchGenerateEmbeddingsMock = mock<AnyFn>(async (texts: string[]) => ({
  embeddings: texts.map((t) => [t.length, 0, 0]),
  model: 'stub-model-v1',
}));

let capturedHooks: { onEventChunk: (events: unknown[]) => Promise<void> } | undefined;

const executeCompiledConnectorMock = mock<AnyFn>(async (args: { hooks: typeof capturedHooks }) => {
  capturedHooks = args.hooks;
  return { mode: 'sync', checkpoint: null };
});

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


import type { ContentItem } from '../daemon/client.js';
import { executeRun } from '../daemon/executor.js';

function makeStubClient() {
  const streamed: ContentItem[] = [];
  const client = {
    id: 'test-worker',
    version: 'test',
    streamed,
    async heartbeat() {},
    async stream(batch: { items: ContentItem[] }) {
      streamed.push(...batch.items);
    },
    async complete() {},
    async completeAction() {},
    async completeEmbeddings() {},
    async completeAuth() {},
    async emitAuthArtifact() {},
    async pollAuthSignal() {
      return { signal: null };
    },
    async fetchEventsForEmbedding() {
      return [];
    },
  };
  return client;
}

describe('sync embedding path batches per chunk (Finding #12)', () => {
  beforeEach(() => {
    capturedHooks = undefined;
    executeCompiledConnectorMock.mockClear();
    batchGenerateEmbeddingsMock.mockClear();
  });

  afterEach(() => {
    batchGenerateEmbeddingsMock.mockClear();
  });

  test('one chunk of N events triggers exactly one batch call with all texts mapped back', async () => {
    const client = makeStubClient();

    executeCompiledConnectorMock.mockImplementationOnce(async (args: { hooks: typeof capturedHooks }) => {
      capturedHooks = args.hooks;
      // One chunk, three events. The third has empty text (no embeddable
      // content) — it must still stream through, just without a vector.
      await capturedHooks!.onEventChunk([
        {
          origin_id: 'a',
          payload_type: 'media',
          payload_text: 'aa',
          payload_data: { layout: 'gallery' },
          payload_template: { type: 'image-grid' },
          attachments: [{ kind: 'image', url: 'https://example.test/photo.jpg' }],
          occurred_at: new Date(),
          origin_type: 'post',
        },
        { origin_id: 'b', payload_text: 'bbbb', occurred_at: new Date(), origin_type: 'post' },
        { origin_id: 'c', payload_text: '', title: '', occurred_at: new Date(), origin_type: 'post' },
      ]);
      return { mode: 'sync', checkpoint: null };
    });

    const job = {
      run_id: 500,
      run_type: 'sync',
      connector_key: 'fake',
      feed_key: 'feed',
      compiled_code: 'compiled-code',
      // biome-ignore lint/suspicious/noExplicitAny: minimal job shape
    } as any;

    // batchSize=10 so the chunk does not flush mid-loop; default generateEmbeddings=true.
    // biome-ignore lint/suspicious/noExplicitAny: minimal env
    const result = await executeRun(client as any, job, {} as any, {
      batchSize: 10,
      executor: { execute: executeCompiledConnectorMock },
    });
    expect(result.error).toBeUndefined();

    // (1) exactly ONE batch call for the whole chunk — not one per event.
    expect(batchGenerateEmbeddingsMock).toHaveBeenCalledTimes(1);

    // (2) the call received only the embeddable texts ('a'+'b'; 'c' is empty).
    const callArgs = batchGenerateEmbeddingsMock.mock.calls[0]![0] as string[];
    expect(callArgs).toEqual(['aa', 'bbbb']);

    // (3) per-event mapping: 'aa' (len 2) and 'bbbb' (len 4) get their own
    //     vectors + the model stamp; the empty event gets no embedding.
    const byId = new Map(client.streamed.map((it) => [it.id, it]));
    expect(byId.get('a')!.embedding).toEqual([2, 0, 0]);
    expect(byId.get('a')!.embedding_model).toBe('stub-model-v1');
    expect(byId.get('a')).toMatchObject({
      payload_type: 'media',
      payload_data: { layout: 'gallery' },
      payload_template: { type: 'image-grid' },
      attachments: [{ kind: 'image', url: 'https://example.test/photo.jpg' }],
    });
    expect(byId.get('b')!.embedding).toEqual([4, 0, 0]);
    expect(byId.get('b')!.embedding_model).toBe('stub-model-v1');
    expect(byId.get('c')!.embedding).toBeUndefined();
    expect(byId.get('c')!.embedding_model).toBeUndefined();
  });
});


describe('delivery checkpoints follow committed event batches', () => {
  for (const failStreamAt of [0, 1, 2]) {
    test(`preserves delivery input and fails closed at stream ${failStreamAt}`, async () => {
      const streams: Array<{ items: ContentItem[]; checkpoint?: unknown }> = [];
      const completions: unknown[] = [];
      const delivery = { id: 'synthetic-batch', event: 'records', payload: { records: [{ id: 'a' }] } };
      const checkpoint = { source_ack: { binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', records: [{ id: 'a', revision: 1 }] } };
      let calls = 0;
      const client = {
        ...makeStubClient(),
        async stream(batch: { items: ContentItem[]; checkpoint?: unknown }) {
          calls++;
          if (calls === failStreamAt) throw new Error('synthetic persistence failure');
          streams.push(batch);
        },
        async complete(completion: unknown) { completions.push(completion); },
      };
      executeCompiledConnectorMock.mockImplementationOnce(async (args) => {
        expect(args.job.delivery).toEqual(delivery);
        await args.hooks.onEventChunk([{ origin_id: 'a', origin_type: 'message', payload_text: 'message', occurred_at: new Date() }]);
        await args.hooks.onCheckpointUpdate(checkpoint);
        return { mode: 'sync', checkpoint };
      });
      const result = await executeRun(client as never, {
        run_id: 501, run_type: 'sync', connector_key: 'synthetic.connector',
        feed_key: 'items', compiled_code: 'compiled-code', delivery,
      }, {}, { generateEmbeddings: false, batchSize: 10, executor: { execute: executeCompiledConnectorMock } });
      if (failStreamAt) {
        expect(result.error).toContain('synthetic persistence failure');
        expect(completions).toEqual([expect.objectContaining({ status: 'failed' })]);
        expect(completions[0]).not.toHaveProperty('checkpoint');
      } else {
        expect(result).toEqual({ itemsCollected: 1 });
        expect(streams).toHaveLength(2);
        expect(streams[0]?.items.map((item) => item.id)).toEqual(['a']);
        expect(streams[0]?.checkpoint).toBeUndefined();
        expect(streams[1]).toEqual(expect.objectContaining({ items: [], checkpoint }));
        expect(completions).toEqual([expect.objectContaining({ status: 'success', checkpoint })]);
      }
    });
  }
});
