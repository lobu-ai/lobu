/**
 * Finding #12 reproducer: the sync embedding path must batch a whole event
 * chunk into ONE embedding call (one HTTP round-trip / vectorized pass), not
 * one call per event, while still mapping each vector back to its source event.
 *
 * Strategy: mock `executeCompiledConnector` to invoke `onCommit` with a
 * 3-event page, mock `batchGenerateEmbeddings` to return distinguishable
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

let capturedHooks:
  | { onCommit: (events: unknown[], checkpoint: unknown) => Promise<void> }
  | undefined;

const executeCompiledConnectorMock = mock<AnyFn>(async (args: { hooks: typeof capturedHooks }) => {
  capturedHooks = args.hooks;
  return { mode: 'sync', status: 'complete' };
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
      await capturedHooks!.onCommit([
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
      ], null);
      return { mode: 'sync', status: 'complete' };
    });

    const job = {
      run_id: 500,
      run_type: 'sync',
      connector_key: 'fake',
      feed_key: 'feed',
      compiled_code: 'compiled-code',
      // biome-ignore lint/suspicious/noExplicitAny: minimal job shape
    } as any;

    // default generateEmbeddings=true.
    // biome-ignore lint/suspicious/noExplicitAny: minimal env
    const result = await executeRun(client as any, job, {} as any, {
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
