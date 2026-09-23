// #1365: the stories sync must not stall on a broad query with blocked egress.
// We import the REAL SDK (no process-global mock.module — that leaks across the
// run) and stub only global.fetch: one Algolia page of high-engagement stories,
// then content fetches that always fail (egress down). The connector must
// short-circuit enrichment after a few consecutive failures instead of grinding
// through every story at ~5s each.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runSync } from './sync-harness';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function algoliaPage(n: number) {
  return {
    hits: Array.from({ length: n }, (_, i) => ({
      objectID: String(i),
      created_at: '2026-01-01T00:00:00Z',
      created_at_i: 1_767_225_600,
      author: 'someone',
      title: `Story ${i}`,
      url: `https://example.com/article-${i}`,
      points: 200, // > ENGAGEMENT_THRESHOLD (50) so each is an enrichment candidate
      num_comments: 10,
      story_id: i,
      _tags: ['story'],
    })),
    nbHits: n,
    page: 0,
    nbPages: 1, // single page → pagination stops immediately
    hitsPerPage: 100,
  };
}

let contentFetches = 0;
beforeEach(() => {
  contentFetches = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (new URL(url).hostname === 'hn.algolia.com') {
      return new Response(JSON.stringify(algoliaPage(20)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Content enrichment fetch → simulate blocked egress (always fails).
    contentFetches++;
    throw new Error('network unreachable');
  }) as typeof fetch;
});

test('stories enrichment short-circuits after consecutive egress failures', async () => {
  const { default: HackerNewsConnector } = await import('../hackernews');
  const connector = new HackerNewsConnector();
  const ctx = {
    feedKey: 'stories',
    config: { search_query: 'AI agents' },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
  const result = await runSync(connector, ctx as any);

  // All 20 stories are still returned — enrichment is best-effort.
  expect(result.events.length).toBe(20);
  // But we stopped fetching content after the consecutive-failure threshold (3),
  // not after all 20 — that's the anti-stall guard.
  expect(contentFetches).toBeLessThanOrEqual(3);
}, 20_000);

test('non-HTML/non-OK results do NOT trip the egress short-circuit', async () => {
  // First three content fetches succeed at the HTTP level but return non-article
  // content (PDF, image, 404); the fourth is a real HTML article. Egress is
  // fine, so enrichment must continue and enrich the fourth — these are skips,
  // not network failures.
  let nthContent = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (new URL(url).hostname === 'hn.algolia.com') {
      return new Response(JSON.stringify(algoliaPage(5)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    contentFetches++;
    nthContent++;
    if (nthContent === 1)
      return new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (nthContent === 2)
      return new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } });
    if (nthContent === 3) return new Response('nope', { status: 404 });
    // 4th: a real HTML article long enough to survive the >=100-char filter.
    return new Response(
      `<html><body><article><h1>Real Article</h1><p>${'lorem ipsum dolor sit amet '.repeat(20)}</p></article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
  }) as typeof fetch;

  const { default: HackerNewsConnector } = await import('../hackernews');
  const connector = new HackerNewsConnector();
  // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
  const result = await runSync(connector, { feedKey: 'stories', config: { search_query: 'x' } } as any);

  // Reached the 4th fetch (would be <=3 if non-HTML wrongly tripped the guard).
  expect(contentFetches).toBeGreaterThanOrEqual(4);
  // The 4th story got real content; the first three did not.
  expect(result.events[3]?.payload_text).toBeTruthy();
  expect(result.events[0]?.payload_text).toBeFalsy();
}, 20_000);

test('front-page schema accepts every story kind the mapper emits', async () => {
  const { default: HackerNewsConnector } = await import('../hackernews');
  const connector = new HackerNewsConnector();

  expect(Object.keys(connector.definition.feeds.front_page.eventKinds ?? {}).sort()).toEqual([
    'ask_hn',
    'show_hn',
    'story',
  ]);
});
