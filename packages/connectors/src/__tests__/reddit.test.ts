import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let RedditConnector: any;

beforeAll(async () => {
  RedditConnector = (await import('../reddit')).default;
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function redditPost(id: string, createdUtc = Date.now() / 1000) {
  return {
    kind: 't3',
    data: {
      name: `t3_${id}`,
      id,
      title: `Post ${id}`,
      selftext: `Body ${id}`,
      author: 'author',
      permalink: `/r/lobu/comments/${id}/post/`,
      url: `https://reddit.com/r/lobu/comments/${id}/post/`,
      created_utc: createdUtc,
      score: 5,
      ups: 6,
      num_comments: 2,
      upvote_ratio: 0.9,
      is_self: true,
      domain: 'self.lobu',
      subreddit: 'lobu',
    },
  };
}

function redditComment(id: string, parentId: string) {
  return {
    kind: 't1',
    data: {
      name: `t1_${id}`,
      id,
      body: `Comment ${id}`,
      author: 'commenter',
      permalink: `/r/lobu/comments/post/comment/${id}/`,
      created_utc: Date.now() / 1000,
      score: 3,
      ups: 4,
      parent_id: parentId,
      link_id: 't3_post',
      subreddit: 'lobu',
    },
  };
}

function listing(children: unknown[], after: string | null = null) {
  return Response.json({ data: { children, after } });
}

describe('RedditConnector runtime', () => {
  test('uses chronological all-time search so lookback cutoff cannot skip newer matches', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return listing([redditPost('result')]);
    }) as typeof fetch;

    const connector = new RedditConnector();
    const result = await runSync(connector, {
      feedKey: 'posts',
      config: { subreddit: 'lobu', search_terms: 'agent memory', lookback_days: 730 },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    const request = new URL(urls[0]);
    expect(request.pathname).toBe('/r/lobu/search');
    expect(request.searchParams.get('q')).toBe('agent memory');
    expect(request.searchParams.get('sort')).toBe('new');
    expect(request.searchParams.get('t')).toBe('all');
    expect(result.events[0].origin_id).toBe('reddit_post_t3_result');
  });

  test('treats subreddit as one encoded path segment', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return listing([]);
    }) as typeof fetch;

    const connector = new RedditConnector();
    await runSync(connector, {
      feedKey: 'posts',
      config: { subreddit: 'programming/new?limit=1' },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    expect(new URL(urls[0]).pathname).toBe('/r/programming%2Fnew%3Flimit%3D1/new');
  });

  test('keeps comment parent ids aligned with emitted stable origin ids', async () => {
    globalThis.fetch = (async () =>
      listing([
        redditComment('child', 't1_parent'),
        redditComment('parent', 't3_post'),
      ])) as typeof fetch;

    const connector = new RedditConnector();
    const result = await runSync(connector, {
      feedKey: 'comments',
      config: { subreddit: 'lobu' },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        origin_id: 'reddit_comment_t1_child',
        origin_parent_id: 'reddit_comment_t1_parent',
        origin_type: 'comment',
      }),
      expect.objectContaining({
        origin_id: 'reddit_comment_t1_parent',
        origin_parent_id: 'reddit_post_t3_post',
        origin_type: 'comment',
      }),
    ]);
  });

  // The first item older than the cutoff ends the whole sync, not just that
  // item — which is why the listing has to be newest-first. A trailing fresh
  // item and an unconsumed second page both prove the stop rather than a filter.
  test('stops the sync at the first item older than the lookback cutoff', async () => {
    const twoYearsAgo = Date.now() / 1000 - 730 * 24 * 60 * 60;
    let pages = 0;
    globalThis.fetch = (async () => {
      pages++;
      return pages === 1
        ? listing(
            [redditPost('fresh'), redditPost('stale', twoYearsAgo), redditPost('trailing')],
            't3_next'
          )
        : listing([redditPost('secondpage')]);
    }) as typeof fetch;

    const connector = new RedditConnector();
    const result = await runSync(connector, {
      feedKey: 'posts',
      config: { subreddit: 'lobu', lookback_days: 30 },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    expect(result.events.map((event: { origin_id: string }) => event.origin_id)).toEqual([
      'reddit_post_t3_fresh',
    ]);
    expect(pages).toBe(1);
  });

  test('confines a pagination cursor to a single query parameter', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return urls.length === 1
        ? listing([redditPost('first')], 't3_next&limit=1')
        : listing([redditPost('second')]);
    }) as typeof fetch;

    const connector = new RedditConnector();
    const result = await runSync(connector, {
      feedKey: 'posts',
      config: { subreddit: 'lobu' },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    const second = new URL(urls[1]);
    expect(second.searchParams.get('after')).toBe('t3_next&limit=1');
    expect(second.searchParams.getAll('limit')).toEqual(['100']);
    expect(result.events).toHaveLength(2);
  });

  test('names the subreddit in the error raised for a 404 listing', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const connector = new RedditConnector();
    await expect(
      runSync(connector, {
        feedKey: 'posts',
        config: { subreddit: 'missing' },
        credentials: { accessToken: 'token' },
        checkpoint: {},
      })
    ).rejects.toThrow('Subreddit or resource not found');
  });
});
