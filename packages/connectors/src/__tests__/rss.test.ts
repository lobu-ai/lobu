// Silent-failure regression (live-verified on prod): a per-feed fetch failure
// was only console.warn'd, so a run where EVERY feed failed reported
// `completed, 0 items, no error` — indistinguishable from a genuinely empty
// feed. Contract under test:
//   - all configured feed_urls fail  → sync() throws with per-URL errors
//   - some fail                      → successful items are returned and the
//     failures surface in SyncResult.metadata (fetch_errors / feeds_failed)

import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let RSSConnector: any;
beforeAll(async () => {
  RSSConnector = (await import('../rss')).default;
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog</title>
<item><title>Hello</title><link>https://blog.example.com/hello</link><guid>post-1</guid><pubDate>Wed, 01 Jul 2026 10:00:00 GMT</pubDate><description>First post</description></item>
</channel></rss>`;

function ctxFor(urls: string[]) {
  // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
  return { feedKey: 'articles', config: { feed_urls: urls }, checkpoint: null } as any;
}

test('all feed URLs failing → sync throws with per-URL errors, not a clean empty run', async () => {
  globalThis.fetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }) as typeof fetch;

  const connector = new RSSConnector();
  const promise = runSync(
    connector,
    ctxFor(['https://down-a.example.com/feed.xml', 'https://down-b.example.com/feed.xml'])
  );

  await expect(promise).rejects.toThrow(/down-a\.example\.com/);
  await expect(promise).rejects.toThrow(/down-b\.example\.com/);
  await expect(promise).rejects.toThrow(/ENOTFOUND/);
});

test('partial failure → good feed items returned, failures surfaced in metadata', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (new URL(url).hostname === 'ok.example.com') {
      return new Response(FEED_XML, { status: 200 });
    }
    return new Response('boom', { status: 503, statusText: 'Service Unavailable' });
  }) as typeof fetch;

  const connector = new RSSConnector();
  const result = await runSync(
    connector,
    ctxFor(['https://ok.example.com/feed.xml', 'https://down.example.com/feed.xml'])
  );

  // The healthy feed's item still comes through.
  expect(result.events).toHaveLength(1);
  expect(result.events[0].origin_id).toBe('post-1');

  // The failed feed is visible on the result, not just in a console.warn.
  expect(result.metadata?.feeds_fetched).toBe(1);
  expect(result.metadata?.feeds_failed).toBe(1);
  const fetchErrors = result.metadata?.fetch_errors as Array<{ url: string; error: string }>;
  expect(fetchErrors).toHaveLength(1);
  expect(fetchErrors[0].url).toBe('https://down.example.com/feed.xml');
  expect(fetchErrors[0].error).toContain('503');
});

test('all feeds healthy → no failure keys in metadata', async () => {
  globalThis.fetch = (async () => new Response(FEED_XML, { status: 200 })) as typeof fetch;

  const connector = new RSSConnector();
  const result = await runSync(connector, ctxFor(['https://ok.example.com/feed.xml']));

  expect(result.events).toHaveLength(1);
  expect(result.metadata?.feeds_fetched).toBe(1);
  expect(result.metadata?.feeds_failed).toBeUndefined();
  expect(result.metadata?.fetch_errors).toBeUndefined();
});
