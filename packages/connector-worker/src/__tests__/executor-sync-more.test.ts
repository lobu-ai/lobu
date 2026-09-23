/**
 * `more` asks the gateway to rerun a feed immediately. The daemon forwards it
 * only when the pass moved the cursor: a connector that says `more` but
 * re-committed the checkpoint it started from (or committed none) would
 * otherwise rerun forever.
 */

import { beforeEach, expect, mock, test } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: test seam — module mocks need loose types
type AnyFn = (...args: any[]) => any;

const executeCompiledConnectorMock = mock<AnyFn>(async () => ({ mode: 'sync', status: 'complete' }));

mock.module('../executor/runtime.js', () => ({
  executeCompiledConnector: executeCompiledConnectorMock,
}));

import { executeRun } from '../daemon/executor.js';

// biome-ignore lint/suspicious/noExplicitAny: capture buffers
let completions: any[] = [];
// biome-ignore lint/suspicious/noExplicitAny: capture buffers
let streamed: any[] = [];

const client = {
  id: 'test-worker',
  version: 'test',
  async heartbeat() {},
  // biome-ignore lint/suspicious/noExplicitAny: capture the streamed page
  async stream(batch: any) {
    streamed.push(batch);
  },
  // biome-ignore lint/suspicious/noExplicitAny: capture complete payloads
  async complete(req: any) {
    completions.push(req);
  },
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

const job = {
  run_id: 1,
  connector_key: 'rss',
  feed_key: 'items',
  feed_id: 7,
  config: {},
  checkpoint: { cursor: 'page-1', source_ack: { through: 'x' } },
  credentials: null,
  compiled_code: 'compiled',
};

/** Run one pass that commits `checkpoints` in order, then returns `status`. */
async function pass(checkpoints: (Record<string, unknown> | null)[], status: 'complete' | 'more') {
  executeCompiledConnectorMock.mockImplementation(
    // biome-ignore lint/suspicious/noExplicitAny: stubbed runtime args
    async ({ hooks }: any) => {
      for (const checkpoint of checkpoints) await hooks.onCommit([], checkpoint);
      return { mode: 'sync', status };
    }
  );
  // biome-ignore lint/suspicious/noExplicitAny: stubbed client/job/env
  await executeRun(client as any, job as any, {} as any, {
    executor: { execute: executeCompiledConnectorMock },
    generateEmbeddings: false,
  });
  expect(completions).toHaveLength(1);
  return completions[0];
}

beforeEach(() => {
  completions = [];
  streamed = [];
});

test('a pass that advanced the cursor and says more asks for an immediate rerun', async () => {
  const completion = await pass([{ cursor: 'page-2' }, { cursor: 'page-3' }], 'more');
  expect(completion.status).toBe('success');
  expect(completion.more).toBe(true);
  expect(completion.checkpoint).toEqual({ cursor: 'page-3' });
  // Each commit was its own page, carrying its own checkpoint.
  expect(streamed.map((batch) => batch.checkpoint)).toEqual([{ cursor: 'page-2' }, { cursor: 'page-3' }]);
});

test('more is dropped when the pass re-committed the cursor it started from', async () => {
  // Key order and the platform-owned source_ack differ; the cursor does not.
  const completion = await pass([{ source_ack: { through: 'y' }, cursor: 'page-1' }], 'more');
  expect(completion.status).toBe('success');
  expect(completion.more).toBeUndefined();
});

test('more is dropped when the pass committed no checkpoint', async () => {
  const completion = await pass([null], 'more');
  expect(completion.more).toBeUndefined();
  expect(completion.checkpoint).toBeUndefined();
});

test('complete never asks for a rerun', async () => {
  const completion = await pass([{ cursor: 'page-2' }], 'complete');
  expect(completion.more).toBeUndefined();
  expect(completion.checkpoint).toEqual({ cursor: 'page-2' });
});
