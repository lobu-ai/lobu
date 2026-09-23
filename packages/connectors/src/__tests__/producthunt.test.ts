// Silent-failure regression (same class as rss): with no PRODUCTHUNT_TOKEN the
// API 401s on the first page, which was console.warn'd and turned into an
// empty page — the run completed with 0 items, indistinguishable from "no
// matching posts". The run must fail with an actionable error instead.

import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let ProductHuntConnector: any;
beforeAll(async () => {
  ProductHuntConnector = (await import('../producthunt')).default;
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('missing token + API 401 → sync throws instead of a clean empty run', async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":"unauthorized"}', { status: 401 })) as typeof fetch;

  const connector = new ProductHuntConnector();
  // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
  const ctx = { feedKey: 'posts', config: { search_query: 'ai agents' }, checkpoint: null } as any;

  await expect(runSync(connector, ctx)).rejects.toThrow(/Developer Token/);
});
