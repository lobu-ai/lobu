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

test('front-page schema accepts every story and reply kind the mapper emits', async () => {
  const { default: HackerNewsConnector } = await import('../hackernews');
  const connector = new HackerNewsConnector();

  expect(Object.keys(connector.definition.feeds.front_page.eventKinds ?? {}).sort()).toEqual([
    'ask_hn',
    'comment',
    'show_hn',
    'story',
  ]);
});

// Front-page post pages read replies as child events of the story on the same
// connection (origin_parent_id = the story's origin_id). Replies are fetched
// for a bounded number of stories per sync from the Algolia items endpoint.
function frontPageHit(id: string, numComments: number) {
  return {
    objectID: id,
    created_at: '2026-01-01T00:00:00Z',
    created_at_i: 1_767_225_600,
    author: 'poster',
    title: `Story ${id}`,
    url: `https://example.com/${id}`,
    points: 10, // below the enrichment threshold: no article fetches
    num_comments: numComments,
    story_id: Number(id),
    _tags: ['story', 'front_page'],
  };
}

function comment(id: number, author: string | null, text: string | null, children: unknown[] = []) {
  return { id, type: 'comment', author, text, created_at_i: 1_767_225_600 + id, children };
}

function storyItem(id: number) {
  return {
    id,
    type: 'story',
    author: 'poster',
    text: null,
    created_at_i: 1_767_225_600,
    children: [
      // No replies: ranks below the busier thread despite being older.
      comment(101, 'alice', 'Quiet <i>one</i>'),
      comment(102, 'bob', 'It&#x27;s a &gt; b<p>See <a href="https://example.com/a/very/long/path" rel="nofollow">https://example.com/a/very/lo...</a>', [
        comment(201, 'carol', 'Reply to bob', [comment(301, 'dave', 'Too deep')]),
        comment(202, null, null), // deleted
        comment(203, 'erin', '<pre><code>  indented\n  code</code></pre>'),
        comment(204, 'frank', 'Over the nested cap'),
      ]),
      // Ties alice on thread size but is newer, so it is the one over the cap.
      comment(103, 'gina', 'Third top-level, over the cap'),
    ],
  };
}

function mockFrontPage(hits: ReturnType<typeof frontPageHit>[]) {
  const itemFetches: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.pathname === '/api/v1/search') {
      return Response.json({ hits, nbHits: hits.length, page: 0, nbPages: 1, hitsPerPage: 100 });
    }
    if (url.pathname.startsWith('/api/v1/items/')) {
      const id = Number(url.pathname.split('/').at(-1));
      itemFetches.push(String(id));
      return Response.json(storyItem(id));
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return itemFetches;
}

const replyCaps = {
  reply_posts_per_sync: 1,
  max_top_level_replies: 2,
  max_nested_replies: 2,
  max_reply_depth: 2,
  reply_refresh_min_new_comments: 20,
};

test('front page stores bounded replies as child events of the most-commented story', async () => {
  const itemFetches = mockFrontPage([frontPageHit('1', 0), frontPageHit('2', 40), frontPageHit('3', 120)]);
  const { default: HackerNewsConnector } = await import('../hackernews');
  const result = await runSync(new HackerNewsConnector(), {
    feedKey: 'front_page',
    config: replyCaps,
    checkpoint: null,
    // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
  } as any);

  expect(itemFetches).toEqual(['3']);
  const replies = result.events.filter((event) => event.origin_type === 'comment');
  // Ranked by thread size: bob's thread before alice; gina is over the
  // top-level cap, the deleted reply is skipped, frank is over the nested cap
  // and dave is below max_reply_depth.
  expect(replies.map((event) => event.origin_id)).toEqual([
    'hn_comment_102',
    'hn_comment_201',
    'hn_comment_203',
    'hn_comment_101',
  ]);
  for (const reply of replies) expect(reply.origin_parent_id).toBe('hn_story_3');

  const [bob, carol, erin, alice] = replies;
  expect(bob).toMatchObject({
    author_name: 'bob',
    payload_text: "It's a > b\n\nSee https://example.com/a/very/long/path",
    source_url: 'https://news.ycombinator.com/item?id=102',
    occurred_at: new Date((1_767_225_600 + 102) * 1000),
  });
  expect(bob.metadata).not.toHaveProperty('parent_comment_author');
  expect(carol.metadata).toMatchObject({
    parent_comment_author: 'bob',
    parent_comment_origin_id: 'hn_comment_102',
    reply_depth: 2,
  });
  expect(erin.payload_text).toBe('  indented\n  code');
  expect(alice.payload_text).toBe('Quiet one');
  expect(result.checkpoint?.reply_counts).toEqual({ hn_story_3: 120 });

  // Every emitted kind is declared on the feed, so ingestion accepts the batch.
  const kinds = Object.keys(new HackerNewsConnector().definition.feeds.front_page.eventKinds ?? {});
  for (const event of result.events) expect(kinds).toContain(event.origin_type);
});

test('front page skips stored threads until their comment count grows enough', async () => {
  const { default: HackerNewsConnector } = await import('../hackernews');
  const checkpoint = { reply_counts: { hn_story_3: 120, hn_story_2: 40, hn_story_gone: 5 } };
  const run = (hits: ReturnType<typeof frontPageHit>[]) => {
    const itemFetches = mockFrontPage(hits);
    return runSync(new HackerNewsConnector(), {
      feedKey: 'front_page',
      config: { ...replyCaps, reply_posts_per_sync: 2 },
      checkpoint,
      // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
    } as any).then((result) => ({ result, itemFetches }));
  };

  // Unchanged and slightly grown threads are not re-read; a new story is.
  const quiet = await run([frontPageHit('2', 50), frontPageHit('3', 120), frontPageHit('4', 7)]);
  expect(quiet.itemFetches).toEqual(['4']);
  expect(quiet.result.checkpoint?.reply_counts).toEqual({ hn_story_2: 40, hn_story_3: 120, hn_story_4: 7 });

  // New stories go first, then the thread that grew past the refresh threshold.
  const grown = await run([frontPageHit('2', 45), frontPageHit('3', 150), frontPageHit('5', 3)]);
  expect(grown.itemFetches).toEqual(['5', '3']);
  expect(grown.result.checkpoint?.reply_counts).toEqual({ hn_story_2: 40, hn_story_3: 150, hn_story_5: 3 });
});

test('reply_posts_per_sync 0 turns front-page reply sync off', async () => {
  const itemFetches = mockFrontPage([frontPageHit('3', 120)]);
  const { default: HackerNewsConnector } = await import('../hackernews');
  const result = await runSync(new HackerNewsConnector(), {
    feedKey: 'front_page',
    config: { reply_posts_per_sync: 0 },
    checkpoint: null,
    // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
  } as any);
  expect(itemFetches).toEqual([]);
  expect(result.events.map((event) => event.origin_id)).toEqual(['hn_story_3']);
});

test('stories and searched comments store HN HTML as plain text', async () => {
  const html = 'It&#x27;s &lt;fine&gt;<p>See <a href="https://example.com/full">https://example.com/fu...</a>';
  const plain = "It's <fine>\n\nSee https://example.com/full";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const isComment = url.searchParams.get('tags') === 'comment';
    const hit = isComment
      ? { ...frontPageHit('7', 0), _tags: ['comment'], comment_text: html, story_id: 1, parent_id: 1 }
      : { ...frontPageHit('7', 0), _tags: ['story', 'ask_hn'], story_text: html };
    return Response.json({ hits: [hit], nbHits: 1, page: 0, nbPages: 1, hitsPerPage: 100 });
  }) as typeof fetch;
  const { default: HackerNewsConnector } = await import('../hackernews');

  for (const feedKey of ['stories', 'comments']) {
    const result = await runSync(new HackerNewsConnector(), {
      feedKey,
      config: { search_query: 'x', story_type: 'ask_hn' },
      checkpoint: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
    } as any);
    expect(result.events[0]?.payload_text).toBe(plain);
  }
});
