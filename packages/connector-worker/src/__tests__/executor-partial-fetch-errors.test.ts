/**
 * Executor failure logging: when a run of any type throws, the daemon log keeps
 * the stack for diagnosis but scrubs credentials out of the message and stack.
 */

import { expect, mock, spyOn, test } from 'bun:test';

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

test.each(['sync', 'action', 'auth', 'embed_backfill'])('%s failure retains its scrubbed stack in daemon logs', async (run_type) => {
  const error = new Error('fetch https://example.test/path?token=synthetic-secret');
  error.stack = `${error.message}\n    at syntheticOperation (worker.js:12:3)`;
  executeCompiledConnectorMock.mockImplementation(async () => { throw error; });
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await executeRun(
      { ...makeStubClient(), async fetchEventsForEmbedding() { throw error; } } as any,
      { ...baseJob, run_type, action_key: 'synthetic_action', action_input: { event_ids: [1] } } as any,
      {} as any,
      { executor: { execute: executeCompiledConnectorMock } },
    );
    expect(result.error).toBe(error.message);
    const failures = stderr.mock.calls.map(([line]) => JSON.parse(String(line)))
      .filter((record) => record.level === 'error');
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).toContain('syntheticOperation');
    expect(JSON.stringify(failures[0])).not.toContain('synthetic-secret');
  } finally {
    stderr.mockRestore();
  }
});
