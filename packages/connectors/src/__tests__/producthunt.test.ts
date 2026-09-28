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

function postEdge(id: string, ageSeconds: number) {
  return {
    cursor: `cursor-${id}`,
    node: {
      id,
      name: `AI agents ${id}`,
      tagline: 'An agent tool',
      description: '',
      url: `https://example.com/posts/${id}`,
      votesCount: 0,
      commentsCount: 0,
      createdAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
      makers: [],
      topics: { edges: [] },
      comments: { edges: [] },
    },
  };
}

function mockListing(edges: ReturnType<typeof postEdge>[]) {
  const requestedCursors: Array<string | null> = [];
  // Model the documented NEWEST/after contract, without assuming cursor expiry.
  // https://api-v2-docs.producthunt.com/query/posts/
  // https://api-v2-docs.producthunt.com/enum/postsorder/
  globalThis.fetch = (async (_url, init) => {
    const { query, variables } = JSON.parse(init?.body as string);
    expect(query).toContain('order: NEWEST');
    requestedCursors.push(variables.after);
    const sorted = edges
      .filter((edge) => edge.node.createdAt > variables.postedAfter)
      .toSorted((a, b) => b.node.createdAt.localeCompare(a.node.createdAt));
    const start = variables.after
      ? sorted.findIndex((edge) => edge.cursor === variables.after) + 1
      : 0;
    if (variables.after && start === 0) throw new Error('Unknown fixture cursor');
    const page = sorted.slice(start, start + 10);
    return Response.json({
      data: {
        posts: {
          edges: page,
          pageInfo: {
            hasNextPage: start + page.length < sorted.length,
            endCursor: page.at(-1)?.cursor ?? null,
          },
        },
      },
    });
  }) as typeof fetch;
  return requestedCursors;
}

function syncContext(maxPages: number, checkpoint: Record<string, unknown> | null = null) {
  return {
    feedKey: 'posts',
    config: { search_query: 'ai agents', max_pages: maxPages },
    checkpoint,
    credentials: null,
    entityIds: [],
  };
}

test('completed traversal discovers a new post prepended before the old cursor', async () => {
  const listing = Array.from({ length: 11 }, (_, i) => postEdge(`post-${i}`, i + 60));
  const requestedCursors = mockListing(listing);
  const first = await runSync(new ProductHuntConnector(), syncContext(2));
  expect(first.events).toHaveLength(11);
  expect(first.commits).toHaveLength(1);

  listing.unshift(postEdge('new-post', 0));
  const second = await runSync(new ProductHuntConnector(), syncContext(2, first.checkpoint));
  expect(second.events.map((event) => event.origin_id)).toContain('producthunt_post_new-post');
  expect(requestedCursors[2]).toBeNull();
  expect(second.checkpoint?.last_cursor).toBeUndefined();
});

test('page cap preserves pending traversal, then completion clears its cursor', async () => {
  const listing = Array.from({ length: 11 }, (_, i) => postEdge(`post-${i}`, i + 60));
  const requestedCursors = mockListing(listing);
  const first = await runSync(new ProductHuntConnector(), syncContext(1));
  expect(first.events).toHaveLength(10);
  expect(requestedCursors).toEqual([null]);
  expect(first.checkpoint?.last_cursor).toBe(listing[9].cursor);

  const second = await runSync(new ProductHuntConnector(), syncContext(1, first.checkpoint));
  expect(requestedCursors).toEqual([null, listing[9].cursor]);
  expect(second.events.map((event) => event.origin_id)).toEqual(['producthunt_post_post-10']);
  expect(second.checkpoint?.last_cursor).toBeUndefined();
});

test('empty terminal page clears a saved cursor', async () => {
  const listing = [postEdge('last-post', 60)];
  const requestedCursors = mockListing(listing);
  const checkpoint = { last_cursor: listing[0].cursor };
  const result = await runSync(new ProductHuntConnector(), syncContext(1, checkpoint));
  expect(requestedCursors).toEqual([listing[0].cursor]);
  expect(result.events).toEqual([]);
  expect(result.commits).toHaveLength(1);
  expect(result.checkpoint?.last_cursor).toBeUndefined();
});
