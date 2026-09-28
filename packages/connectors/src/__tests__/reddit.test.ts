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

function mockPostListing(posts: ReturnType<typeof redditPost>[], pageSize = 50) {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    urls.push(url);
    const after = url.searchParams.get('after');
    const start = after ? posts.findIndex((post) => post.data.name === after) + 1 : 0;
    const children = posts.slice(start, start + pageSize);
    return listing(
      children,
      start + children.length < posts.length ? children.at(-1)!.data.name : null
    );
  }) as typeof fetch;
  return urls;
}

const syncOptions = {
  feedKey: 'posts',
  config: { subreddit: 'lobu' },
  credentials: { accessToken: 'token' },
};

describe('RedditConnector runtime', () => {
  test('starts at the head with the null checkpoint used for a first sync', async () => {
    const urls = mockPostListing([redditPost('first')]);
    const result = await runSync(new RedditConnector(), { ...syncOptions, checkpoint: null });
    expect(urls[0].searchParams.get('after')).toBeNull();
    expect(result.events).toHaveLength(1);
    expect(result.checkpoint?.pagination_token).toBeUndefined();
  });

  test('resumes beyond the ten-page cap while fetching newly arrived posts', async () => {
    const now = Date.now() / 1000;
    // `limit` is a maximum; short pages with an after anchor must still advance.
    const posts = Array.from({ length: 550 }, (_, i) => redditPost(`${i}`, now - i));
    const urls = mockPostListing(posts);

    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    const first = await runSync(connector, { ...syncOptions, checkpoint: {} });
    expect(first.events).toHaveLength(500);
    expect(urls).toHaveLength(10);
    expect(first.checkpoint?.pagination_token).toBe('t3_499');

    posts.unshift(redditPost('arrived', now + 1));
    urls.length = 0;
    // JSON round-trip and a new runtime instance model a persisted checkpoint.
    const resumedConnector = new RedditConnector();
    resumedConnector.RATE_LIMIT_MS = 0;
    const second = await runSync(resumedConnector, {
      ...syncOptions,
      checkpoint: JSON.parse(JSON.stringify(first.checkpoint)),
    });
    const ids = second.events.map((event) => event.origin_id);
    expect(ids).toContain('reddit_post_t3_arrived');
    expect(ids.includes('reddit_post_t3_549')).toBe(true);
    expect(urls.some((url) => url.searchParams.get('after') === 't3_499')).toBe(true);
    expect(urls.length).toBeLessThanOrEqual(10);
    expect(second.checkpoint?.pagination_token).toBeUndefined();
    expect(second.checkpoint?.pagination_cutoff).toBeUndefined();
  });

  test('starts another full sweep to collect arrivals beyond the refreshed head page', async () => {
    const now = Date.now() / 1000;
    const posts = Array.from({ length: 550 }, (_, i) => redditPost(`${i}`, now - i));
    const urls = mockPostListing(posts);
    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    const first = await runSync(connector, { ...syncOptions, checkpoint: {} });

    const arrivals = Array.from({ length: 120 }, (_, i) => redditPost(`new${i}`, now + 120 - i));
    posts.unshift(...arrivals);
    const second = await runSync(connector, { ...syncOptions, checkpoint: first.checkpoint! });
    expect(second.checkpoint?.pagination_token).toBeUndefined();

    urls.length = 0;
    const third = await runSync(connector, { ...syncOptions, checkpoint: second.checkpoint! });
    expect(urls[0].searchParams.get('after')).toBeNull();
    expect(urls).toHaveLength(10);
    const ids = third.events.map((event) => event.origin_id);
    for (const arrival of arrivals) expect(ids).toContain(`reddit_post_${arrival.data.name}`);
    expect(third.checkpoint?.pagination_token).toBeDefined();
  });

  test('advances a resumed sweep by nine pages when it hits the cap again', async () => {
    const now = Date.now() / 1000;
    const posts = Array.from({ length: 1000 }, (_, i) => redditPost(`${i}`, now - i));
    const urls = mockPostListing(posts);
    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    const first = await runSync(connector, { ...syncOptions, checkpoint: {} });
    urls.length = 0;
    const second = await runSync(connector, { ...syncOptions, checkpoint: first.checkpoint! });
    expect(urls).toHaveLength(10);
    expect(second.checkpoint?.pagination_token).toBe('t3_949');
    expect(second.checkpoint?.pagination_cutoff).toBe(first.checkpoint?.pagination_cutoff);
    const third = await runSync(connector, { ...syncOptions, checkpoint: second.checkpoint! });
    expect(third.events.map((event) => event.origin_id)).toContain('reddit_post_t3_999');
    expect(third.checkpoint?.pagination_token).toBeUndefined();
  });

  test('keeps the original cutoff while a capped sweep is unfinished', async () => {
    const now = Date.now() / 1000;
    const day = 24 * 60 * 60;
    const savedCutoff = new Date((now - 2 * day) * 1000).toISOString();
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      urls.push(url);
      return url.searchParams.has('after')
        ? listing([redditPost('eligible', now - 1.5 * day)], 't3_eligible')
        : listing([redditPost('fresh')], 't3_fresh');
    }) as typeof fetch;
    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    connector.MAX_PAGES = 2;
    const result = await runSync(connector, {
      ...syncOptions,
      config: { subreddit: 'lobu', lookback_days: 1 },
      checkpoint: { pagination_token: 't3_saved', pagination_cutoff: savedCutoff },
    });
    expect(urls[1].searchParams.get('after')).toBe('t3_saved');
    expect(result.events.map((event) => event.origin_id)).toContain('reddit_post_t3_eligible');
    expect(result.checkpoint?.pagination_token).toBe('t3_eligible');
    expect(result.checkpoint?.pagination_cutoff).toBe(savedCutoff);
  });

  test.each(['posts', 'comments', 'user_activity'])(
    'resumes the %s feed with API after',
    async (feedKey) => {
      const urls: URL[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        urls.push(url);
        const item = url.searchParams.has('after') ? 'older' : 'head';
        return listing(
          [feedKey === 'posts' ? redditPost(item) : redditComment(item, 't3_post')],
          item === 'head' ? 't3_head' : null
        );
      }) as typeof fetch;
      const connector = new RedditConnector();
      connector.RATE_LIMIT_MS = 0;
      const result = await runSync(connector, {
        ...syncOptions,
        feedKey,
        config: { subreddit: 'lobu', username: 'test-user' },
        checkpoint: { pagination_token: 't3_saved&limit=1' },
      });
      expect(urls).toHaveLength(2);
      expect(urls[0].searchParams.get('after')).toBeNull();
      expect(urls[1].searchParams.get('after')).toBe('t3_saved&limit=1');
      expect(urls[1].searchParams.getAll('limit')).toEqual(['100']);
      expect(result.events).toHaveLength(2);
      expect(result.checkpoint?.pagination_token).toBeUndefined();
    }
  );

  test.each(['empty', 'repeated', 'ignored', '400', '404'])(
    'clears a stale saved cursor when the response is %s and restarts next run',
    async (responseKind) => {
      const urls: URL[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        urls.push(url);
        if (!url.searchParams.has('after')) return listing([redditPost('head')], 't3_head');
        if (url.searchParams.get('after') === 't3_head') return listing([redditPost('older')]);
        if (responseKind === 'empty') return listing([], 't3_stale');
        if (responseKind === 'repeated') return listing([redditPost('head')], 't3_stale');
        if (responseKind === 'ignored') return listing([redditPost('head')], 't3_head');
        return new Response('unavailable anchor', { status: Number(responseKind) });
      }) as typeof fetch;
      const connector = new RedditConnector();
      connector.RATE_LIMIT_MS = 0;
      const result = await runSync(connector, {
        ...syncOptions,
        checkpoint: { pagination_token: 't3_stale' },
      });
      expect(urls).toHaveLength(2);
      expect(result.events.map((event) => event.origin_id)).toEqual(['reddit_post_t3_head']);
      expect(result.checkpoint?.pagination_token).toBeUndefined();
      expect(result.checkpoint?.pagination_cutoff).toBeUndefined();

      urls.length = 0;
      await runSync(connector, { ...syncOptions, checkpoint: result.checkpoint! });
      expect(urls[0].searchParams.get('after')).toBeNull();
      expect(urls[1].searchParams.get('after')).toBe('t3_head');
    }
  );

  test.each([401, 403, 429, 500])(
    'does not swallow a resumed HTTP %i failure or move the checkpoint',
    async (status) => {
      globalThis.fetch = (async (input: string | URL | Request) =>
        new URL(input.toString()).searchParams.has('after')
          ? new Response('failed', { status })
          : listing([redditPost('head')], 't3_head')) as typeof fetch;
      const connector = new RedditConnector();
      connector.RATE_LIMIT_MS = 0;
      const commit = mock(async () => {});
      await expect(
        runSync(connector, {
          ...syncOptions,
          checkpoint: { pagination_token: 't3_saved' },
          commit,
        })
      ).rejects.toThrow();
      expect(commit).not.toHaveBeenCalled();
    }
  );

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
    expect(result.checkpoint?.pagination_token).toBeUndefined();
    expect(result.checkpoint?.pagination_cutoff).toBeUndefined();
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
