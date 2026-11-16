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

// Ranking feeds (GitHub Trending mirrors, charts) re-list the same items every
// edition, often without <guid> or item dates. Sync dedupes them away, so the
// only way to see what the feed lists NOW is a source read.
const RANKING_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Daily Trending</title>
<pubDate>Mon, 16 Nov 2026 07:38:17 GMT</pubDate>
<item><title>acme/alpha</title><link>https://github.com/acme/alpha</link><description>First</description></item>
<item><title>acme/beta</title><link>https://github.com/acme/beta</link><description>Second</description></item>
<item><title>acme/gamma</title><link>https://github.com/acme/gamma</link><description>Third</description></item>
</channel></rss>`;

test('source read lists every current item in document order, even after sync has seen them', async () => {
  globalThis.fetch = (async () => new Response(RANKING_XML, { status: 200 })) as typeof fetch;
  const connector = new RSSConnector();
  const first = await runSync(connector, ctxFor(['https://trending.example.com/daily.xml']));
  const second = await runSync(connector, {
    ...ctxFor(['https://trending.example.com/daily.xml']),
    checkpoint: first.checkpoint,
  });
  // The next edition re-lists all three; sync reports none of them.
  expect(second.events).toHaveLength(0);

  const read = await connector.read({
    feedKey: 'articles',
    config: { feed_urls: ['https://trending.example.com/daily.xml'] },
    credentials: null,
  });

  expect(read.rows.map((r: { title: string }) => r.title)).toEqual([
    'acme/alpha',
    'acme/beta',
    'acme/gamma',
  ]);
  expect(read.rows.map((r: { position: number }) => r.position)).toEqual([1, 2, 3]);
  expect(read.rows[0]).toMatchObject({
    link: 'https://github.com/acme/alpha',
    feed_url: 'https://trending.example.com/daily.xml',
    // The items state no date; the read must not invent one.
    published_at: null,
    feed_published_at: '2026-11-16T07:38:17.000Z',
  });
  expect(read).toMatchObject({ total: 3, hasMore: false });

  const limited = await connector.read({
    feedKey: 'articles',
    config: { feed_urls: ['https://trending.example.com/daily.xml'] },
    credentials: null,
    limit: 2,
  });
  expect(limited.rows).toHaveLength(2);
  expect(limited).toMatchObject({ total: 3, hasMore: true });
});

test('source read fails closed when any feed URL fails, and rejects paging and windows', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    return new URL(url).hostname === 'ok.example.com'
      ? new Response(RANKING_XML, { status: 200 })
      : new Response('boom', { status: 503, statusText: 'Service Unavailable' });
  }) as typeof fetch;
  const connector = new RSSConnector();
  const base = { feedKey: 'articles', credentials: null };

  // A snapshot missing one feed is not the current contents.
  await expect(
    connector.read({
      ...base,
      config: { feed_urls: ['https://ok.example.com/feed.xml', 'https://down.example.com/feed.xml'] },
    })
  ).rejects.toThrow(/1 of 2 feed URL\(s\) failed.*down\.example\.com.*503/);

  const config = { feed_urls: ['https://ok.example.com/feed.xml'] };
  await expect(connector.read({ ...base, config, offset: 10 })).rejects.toThrow(/snapshot/);
  await expect(
    connector.read({ ...base, config, window: { start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' } })
  ).rejects.toThrow(/snapshot/);
  await expect(connector.read({ ...base, config, query: 'alpha' })).rejects.toThrow(/queries/);
});
