/**
 * Partial-sync visibility: a connector that reports per-source fetch failures
 * on an otherwise-successful sync via `SyncResult.metadata.fetch_errors`
 * ({ url, error }[]) must have them land on the run record. The executor
 * forwards them to `client.complete` through the existing `error_message`
 * field (the gateway persists error_message on successful runs too), so no
 * new protocol field or column is involved. A clean sync keeps
 * error_message unset.
 */

import { expect, mock, test } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: test seam — module mocks need loose types
type AnyFn = (...args: any[]) => any;

const executeCompiledConnectorMock = mock<AnyFn>(async () => ({
  mode: 'sync',
  status: 'complete',
}));

mock.module('../executor/runtime.js', () => ({
  executeCompiledConnector: executeCompiledConnectorMock,
}));

import { executeRun } from '../daemon/executor.js';

function makeStubClient() {
  // biome-ignore lint/suspicious/noExplicitAny: capture buffer
  const completions: any[] = [];
  const client = {
    id: 'test-worker',
    version: 'test',
    completions,
    async heartbeat() {},
    async stream() {},
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
  return client;
}

const baseJob = {
  run_id: 1,
  connector_key: 'rss',
  feed_key: 'articles',
  feed_id: 7,
  config: {},
  checkpoint: null,
  credentials: null,
  compiled_code: 'compiled',
};

test('sync metadata.fetch_errors → forwarded as error_message on the successful completion', async () => {
  executeCompiledConnectorMock.mockImplementation(async () => ({
    mode: 'sync',
    status: 'complete',
    metadata: {
      items_found: 3,
      feeds_failed: 1,
      fetch_errors: [{ url: 'https://down.example.com/feed.xml', error: 'HTTP 503' }],
    },
  }));

  const client = makeStubClient();
  // biome-ignore lint/suspicious/noExplicitAny: stubbed client/job for unit test
  await executeRun(client as any, baseJob as any, {} as any, {
    executor: { execute: executeCompiledConnectorMock },
  });

  expect(client.completions).toHaveLength(1);
  const completion = client.completions[0];
  expect(completion.status).toBe('success');
  expect(completion.error_message).toContain('https://down.example.com/feed.xml');
  expect(completion.error_message).toContain('HTTP 503');
});

test('clean sync → no error_message on the completion', async () => {
  executeCompiledConnectorMock.mockImplementation(async () => ({
    mode: 'sync',
    status: 'complete',
    metadata: { items_found: 3 },
  }));

  const client = makeStubClient();
  // biome-ignore lint/suspicious/noExplicitAny: stubbed client/job for unit test
  await executeRun(client as any, baseJob as any, {} as any, {
    executor: { execute: executeCompiledConnectorMock },
  });

  expect(client.completions).toHaveLength(1);
  expect(client.completions[0].status).toBe('success');
  expect(client.completions[0].error_message).toBeUndefined();
});
