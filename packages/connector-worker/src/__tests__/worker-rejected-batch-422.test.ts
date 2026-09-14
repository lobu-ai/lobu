/**
 * Worker contract for a rejected connector batch (gateway 422).
 *
 * The gateway fails a batch containing ANY item that violates the feed's
 * declared `eventKinds`: nothing is ingested and no checkpoint advances, and it
 * says so with HTTP 422 + `rejected_items` instead of the 200 that used to
 * report the offered count as collected. That is a worker-facing response
 * contract, so the worker half needs its own proof:
 *
 *  1. the real `WorkerClient.stream()` turns a 422 into a thrown
 *     `WorkerHttpError` carrying the status and the gateway's body, rather than
 *     swallowing it or retrying, and
 *  2. `executeRun` lets that throw fail the run LOUDLY — exactly one terminal
 *     `complete` with status 'failed' and NO checkpoint, so the gateway keeps
 *     the last good cursor and a corrected connector re-collects the page.
 *
 * Without (2) the 422 would be an invisible stall or a crash loop instead of a
 * failed run an operator can see.
 */

import { expect, mock, test } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: test seam — module mocks need loose types
type AnyFn = (...args: any[]) => any;

const executeCompiledConnectorMock = mock<AnyFn>(async () => ({
  mode: 'sync',
  checkpoint: null,
}));

mock.module('../executor/runtime.js', () => ({
  executeCompiledConnector: executeCompiledConnectorMock,
}));

import { WorkerClient, WorkerHttpError } from '../daemon/client.js';
import { executeRun } from '../daemon/executor.js';

/**
 * A copy of the body `streamContent` (packages/server) answers a rejected batch
 * with, kept verbatim so the assertions below measure the REAL payload against
 * `WorkerHttpError`'s 500-character detail budget: the offending item id sits
 * past the description, and a longer description would push it out of the
 * failed run's `error_message`.
 */
const REJECTED_BODY = {
  error: 'batch_rejected',
  error_description:
    "One or more offered items failed validation; the whole batch was rejected, nothing was ingested and no checkpoint was advanced. Fix the connector's declared eventKinds and re-sync.",
  rejected_items: [
    {
      id: 'invalid-kind-item',
      semantic_type: 'hn_story',
      errors: ["Invalid kind 'hn_story'. Valid kinds: story."],
    },
  ],
};

test('the real WorkerClient turns a gateway 422 into a thrown WorkerHttpError', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify(REJECTED_BODY), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  try {
    const client = new WorkerClient({
      apiUrl: `http://127.0.0.1:${server.port}`,
      workerId: 'test-worker',
      capabilities: {},
    });

    const err = await client
      .stream({
        type: 'batch',
        run_id: 1,
        worker_id: 'test-worker',
        items: [],
        // biome-ignore lint/suspicious/noExplicitAny: minimal batch for the HTTP leg
      } as any)
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(err).toBeInstanceOf(WorkerHttpError);
    const httpErr = err as WorkerHttpError;
    expect(httpErr.status).toBe(422);
    // The rejected items ride the error detail, so the failed run's
    // error_message names the offending kind for the connector author.
    expect(httpErr.message).toContain('invalid-kind-item');
    expect(httpErr.message).toContain('hn_story');
  } finally {
    server.stop(true);
  }
});

test('a 422 on stream fails the sync run loudly, with no checkpoint committed', async () => {
  executeCompiledConnectorMock.mockImplementation(
    // biome-ignore lint/suspicious/noExplicitAny: stubbed runtime args
    async ({ hooks }: any) => {
      // The connector collected a page and offered a fresh cursor alongside it.
      await hooks.onEventChunk([
        {
          origin_id: 'invalid-kind-item',
          origin_type: 'hn_story',
          title: 'Undeclared kind',
          payload_text: 'body',
          payload_type: 'text',
          occurred_at: new Date().toISOString(),
        },
      ]);
      return { mode: 'sync', checkpoint: { cursor: 'after-rejected-page' } };
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: capture buffers
  const completions: any[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: capture buffers
  const streamed: any[] = [];
  let streamCalls = 0;
  const client = {
    id: 'test-worker',
    version: 'test',
    async heartbeat() {},
    // biome-ignore lint/suspicious/noExplicitAny: capture the offered batch
    async stream(batch: any) {
      streamCalls++;
      streamed.push(batch);
      throw new WorkerHttpError(
        422,
        '/api/workers/stream',
        `Unprocessable Entity ${JSON.stringify(REJECTED_BODY)}`
      );
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

  const result = await executeRun(
    // biome-ignore lint/suspicious/noExplicitAny: stubbed client/job for unit test
    client as any,
    {
      run_id: 1,
      connector_key: 'rss',
      feed_key: 'items',
      feed_id: 7,
      config: {},
      checkpoint: { cursor: 'original-cursor' },
      credentials: null,
      compiled_code: 'compiled',
      // biome-ignore lint/suspicious/noExplicitAny: stubbed job
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stubbed env
    {} as any,
    {
      // `executor` only short-circuits `selectExecutor`, which would otherwise
      // demand isolated-vm on this host; the mocked runtime above is what
      // actually drives the hooks. `generateEmbeddings: false` keeps the chunk
      // from loading a real embedding model for a batch the gateway rejects.
      executor: { execute: executeCompiledConnectorMock },
      generateEmbeddings: false,
    }
  );

  // Loud: the run ends failed, not silently successful and not retried.
  expect(streamCalls).toBe(1);
  // The rejected page was offered WITH the connector's fresh cursor — which is
  // exactly the cursor the gateway must refuse to commit.
  expect(streamed[0].items.map((item: { id: string }) => item.id)).toEqual([
    'invalid-kind-item',
  ]);
  expect(streamed[0].checkpoint).toEqual({ cursor: 'after-rejected-page' });
  expect(completions).toHaveLength(1);
  const completion = completions[0];
  expect(completion.status).toBe('failed');
  expect(completion.error_message).toContain('422');
  expect(completion.error_message).toContain('invalid-kind-item');

  // The decisive assertion: the worker commits NO checkpoint on the failed
  // completion, so the gateway keeps 'original-cursor' and the rejected page
  // stays reachable for the next sync.
  expect(completion.checkpoint).toBeUndefined();

  // executeRun returns the error rather than throwing, so the poll loop keeps
  // running: a rejected batch must not take the worker process down.
  expect(result.error).toContain('422');
});
