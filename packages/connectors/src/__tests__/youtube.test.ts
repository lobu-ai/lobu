import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let YouTubeConnector: any;

beforeAll(async () => {
  const mod = await import('../youtube');
  YouTubeConnector = mod.default;
});

function fakeHttp(handlers: Record<string, (url: URL) => unknown>) {
  return {
    raw: async (url: string) => {
      const u = new URL(url);
      const key = u.pathname.split('/').pop() ?? '';
      const handler = handlers[key];
      if (!handler) {
        return {
          ok: false,
          status: 404,
          text: async () => `no handler for ${key}`,
        } as Response;
      }
      const body = handler(u);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    },
  };
}

describe('YouTubeConnector personal feeds', () => {
  test('liked_videos resolves the Likes playlist and emits liked_video events', async () => {
    const connector = new YouTubeConnector();
    connector.http = fakeHttp({
      channels: () => ({
        items: [{ contentDetails: { relatedPlaylists: { likes: 'LLlikes' } } }],
      }),
      playlistItems: (u) => ({
        items: [
          {
            snippet: {
              publishedAt: '2026-07-01T10:00:00Z',
              title: 'Great talk',
              channelTitle: 'Channel A',
              playlistId: 'LLlikes',
              resourceId: { kind: 'youtube#video', videoId: 'vid1' },
            },
            contentDetails: { videoId: 'vid1', videoPublishedAt: '2026-06-01T10:00:00Z' },
          },
        ],
      }),
    });

    const result = await runSync(connector, {
      feedKey: 'liked_videos',
      credentials: { accessToken: 'token' },
      config: { max_results: 10 },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].origin_type).toBe('liked_video');
    expect(result.events[0].origin_id).toBe('yt_liked_vid1');
    expect(result.events[0].title).toBe('Great talk');
  });

  test('playlists emits playlist and playlist_item events', async () => {
    const connector = new YouTubeConnector();
    connector.http = fakeHttp({
      playlists: () => ({
        items: [
          {
            id: 'PL1',
            snippet: {
              title: 'Favourites',
              description: 'Saved stuff',
              publishedAt: '2026-01-01T00:00:00Z',
              channelTitle: 'Me',
            },
            contentDetails: { itemCount: 1 },
          },
        ],
      }),
      playlistItems: (u) => {
        const playlistId = u.searchParams.get('playlistId');
        if (playlistId === 'PL1') {
          return {
            items: [
              {
                snippet: {
                  publishedAt: '2026-02-01T00:00:00Z',
                  title: 'Inside item',
                  channelTitle: 'Channel B',
                  playlistId: 'PL1',
                  resourceId: { kind: 'youtube#video', videoId: 'vid2' },
                },
                contentDetails: { videoId: 'vid2' },
              },
            ],
          };
        }
        return { items: [] };
      },
    });

    const result = await runSync(connector, {
      feedKey: 'playlists',
      credentials: { accessToken: 'token' },
      config: { max_playlists: 5, include_items: true, max_items_per_playlist: 10 },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(2);
    expect(result.events.find((e: { origin_type: string }) => e.origin_type === 'playlist')?.title).toBe(
      'Favourites'
    );
    expect(
      result.events.find((e: { origin_type: string }) => e.origin_type === 'playlist_item')?.origin_parent_id
    ).toBe('yt_playlist_PL1');
  });

  test('subscriptions emits channel_subscription events', async () => {
    const connector = new YouTubeConnector();
    connector.http = fakeHttp({
      subscriptions: () => ({
        items: [
          {
            id: 'sub1',
            snippet: {
              publishedAt: '2026-01-02T00:00:00Z',
              title: 'Creator Channel',
              description: 'Channel description',
              resourceId: { kind: 'youtube#channel', channelId: 'UC123' },
            },
            contentDetails: {
              totalItemCount: 42,
              newItemCount: 2,
              activityType: 'all',
            },
          },
        ],
      }),
    });

    const result = await runSync(connector, {
      feedKey: 'subscriptions',
      credentials: { accessToken: 'token' },
      config: { max_results: 10 },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].origin_type).toBe('channel_subscription');
    expect(result.events[0].origin_id).toBe('yt_subscription_UC123');
    expect(result.events[0].title).toBe('Creator Channel');
    expect(result.events[0].source_url).toBe('https://www.youtube.com/channel/UC123');
    expect(result.events[0].metadata?.channel_id).toBe('UC123');
  });

  test('liked_videos requires OAuth', async () => {
    const connector = new YouTubeConnector();
    await expect(
      runSync(connector, {
        feedKey: 'liked_videos',
        credentials: {},
        config: { YOUTUBE_API_KEY: 'key-only' },
        checkpoint: {},
      })
    ).rejects.toThrow(/requires OAuth/i);
  });

  test('subscriptions requires OAuth', async () => {
    const connector = new YouTubeConnector();
    await expect(
      runSync(connector, {
        feedKey: 'subscriptions',
        credentials: {},
        config: { YOUTUBE_API_KEY: 'key-only' },
        checkpoint: {},
      })
    ).rejects.toThrow(/requires OAuth/i);
  });
});

describe('YouTubeConnector actions', () => {
  test('search returns public video summaries', async () => {
    const connector = new YouTubeConnector();
    connector.http = fakeHttp({
      search: (u) => ({
        items: [
          {
            id: { kind: 'youtube#video', videoId: 'vid9' },
            snippet: {
              publishedAt: '2026-07-01T10:00:00Z',
              channelId: 'ch1',
              title: 'Public hit',
              description: 'desc',
              channelTitle: 'Channel Z',
            },
          },
        ],
      }),
      videos: () => ({
        items: [
          {
            id: 'vid9',
            snippet: {
              publishedAt: '2026-07-01T10:00:00Z',
              channelId: 'ch1',
              title: 'Public hit',
              description: 'desc',
              channelTitle: 'Channel Z',
            },
            statistics: { viewCount: '100', likeCount: '5', commentCount: '1' },
            contentDetails: { duration: 'PT5M' },
          },
        ],
      }),
    });

    const result = await connector.execute({
      actionKey: 'search',
      credentials: { accessToken: 'token' },
      config: {},
      input: { query: 'public hit', max_results: 5 },
    });

    expect(result.success).toBe(true);
    expect(result.output?.videos).toHaveLength(1);
    expect(result.output?.videos[0].video_id).toBe('vid9');
    expect(result.output?.videos[0].title).toBe('Public hit');
  });

  test('search_liked_videos filters by title', async () => {
    const connector = new YouTubeConnector();
    connector.http = fakeHttp({
      channels: () => ({
        items: [{ contentDetails: { relatedPlaylists: { likes: 'LLlikes' } } }],
      }),
      playlistItems: (u) => {
        if (u.searchParams.get('playlistId') === 'LLlikes') {
          return {
            items: [
              {
                snippet: {
                  publishedAt: '2026-07-01T10:00:00Z',
                  title: 'Immigration podcast',
                  channelTitle: 'Law Channel',
                  playlistId: 'LLlikes',
                  resourceId: { kind: 'youtube#video', videoId: 'a' },
                },
                contentDetails: { videoId: 'a' },
              },
              {
                snippet: {
                  publishedAt: '2026-07-02T10:00:00Z',
                  title: 'Cooking tips',
                  channelTitle: 'Food Channel',
                  playlistId: 'LLlikes',
                  resourceId: { kind: 'youtube#video', videoId: 'b' },
                },
                contentDetails: { videoId: 'b' },
              },
            ],
          };
        }
        return { items: [] };
      },
    });

    const result = await connector.execute({
      actionKey: 'search_liked_videos',
      credentials: { accessToken: 'token' },
      config: {},
      input: { query: 'immigration' },
    });

    expect(result.success).toBe(true);
    expect(result.output?.videos).toHaveLength(1);
    expect(result.output?.videos[0].video_id).toBe('a');
  });

  test('get_video accepts a watch URL', async () => {
    const connector = new YouTubeConnector();
    connector.http = fakeHttp({
      videos: () => ({
        items: [
          {
            id: 'abc12345678',
            snippet: {
              publishedAt: '2026-06-01T10:00:00Z',
              channelId: 'ch',
              title: 'One video',
              description: 'body',
              channelTitle: 'Creator',
            },
            statistics: { viewCount: '1', likeCount: '0', commentCount: '0' },
          },
        ],
      }),
    });

    const result = await connector.execute({
      actionKey: 'get_video',
      credentials: { accessToken: 'token' },
      config: {},
      input: {
        video_id: 'https://www.youtube.com/watch?v=abc12345678',
        include_transcript: false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.output?.video.video_id).toBe('abc12345678');
  });

  test('list_playlists returns playlist summaries', async () => {
    const connector = new YouTubeConnector();
    connector.http = fakeHttp({
      playlists: () => ({
        items: [
          {
            id: 'PL9',
            snippet: {
              title: 'Saved',
              description: 'My list',
              publishedAt: '2026-01-01T00:00:00Z',
              channelTitle: 'Me',
            },
            contentDetails: { itemCount: 3 },
          },
        ],
      }),
    });

    const result = await connector.execute({
      actionKey: 'list_playlists',
      credentials: { accessToken: 'token' },
      config: {},
      input: {},
    });

    expect(result.success).toBe(true);
    expect(result.output?.playlists[0].playlist_id).toBe('PL9');
    expect(result.output?.playlists[0].item_count).toBe(3);
  });

  test('search_liked_videos requires OAuth', async () => {
    const connector = new YouTubeConnector();
    const result = await connector.execute({
      actionKey: 'search_liked_videos',
      credentials: {},
      config: { YOUTUBE_API_KEY: 'key-only' },
      input: { query: 'test' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires OAuth/i);
  });
});

describe('YouTubeConnector stale page-token recovery', () => {
  /**
   * Serves search.list. The first request is rejected with `rejection`; every
   * later request succeeds. Records each request's pageToken so the test can
   * assert the dead cursor was dropped rather than replayed forever.
   */
  function searchHttp(rejection: { status: number; body: string }) {
    const pageTokens: Array<string | null> = [];
    let call = 0;
    return {
      pageTokens,
      http: {
        raw: async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith('/search')) {
            pageTokens.push(u.searchParams.get('pageToken'));
            call++;
            if (call === 1) {
              return {
                ok: false,
                status: rejection.status,
                text: async () => rejection.body,
                json: async () => JSON.parse(rejection.body),
              } as unknown as Response;
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                items: [
                  {
                    id: { videoId: 'vid1' },
                    snippet: { publishedAt: '2026-07-01T10:00:00Z', title: 'Recovered' },
                  },
                ],
              }),
              text: async () => '',
            } as unknown as Response;
          }
          // videos.list — details for the recovered video.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [
                {
                  id: 'vid1',
                  snippet: {
                    publishedAt: '2026-07-01T10:00:00Z',
                    title: 'Recovered',
                    channelTitle: 'Chan',
                    description: '',
                  },
                  statistics: { viewCount: '1', likeCount: '0', commentCount: '0' },
                  contentDetails: { duration: 'PT1M' },
                },
              ],
            }),
            text: async () => '',
          } as unknown as Response;
        },
      },
    };
  }

  const INVALID_PAGE_TOKEN = JSON.stringify({
    error: {
      code: 400,
      message: "Request contains an invalid argument.",
      errors: [{ reason: 'invalidPageToken' }],
    },
  });

  test('a rejected persisted pageToken is dropped and the search restarts from page one', async () => {
    const connector = new YouTubeConnector();
    const { http, pageTokens } = searchHttp({ status: 400, body: INVALID_PAGE_TOKEN });
    connector.http = http;

    const result = await connector.syncSearchVideos(
      {
        config: {
          search_query: 'lobu',
          max_results: 5,
          include_transcripts: false,
          include_comments: false,
        },
        credentials: { accessToken: 'tok' },
        checkpoint: { next_page_token: 'DEAD_TOKEN' },
      },
      { accessToken: 'tok' }
    );

    // Dead cursor tried once, then abandoned for a first-page request.
    expect(pageTokens[0]).toBe('DEAD_TOKEN');
    expect(pageTokens[1]).toBeNull();
    // Recovery actually produced events instead of throwing.
    expect(result.events.length).toBeGreaterThan(0);
  });

  test('a quota 403 is not treated as a stale cursor and still throws', async () => {
    const connector = new YouTubeConnector();
    const quota = JSON.stringify({
      error: { code: 403, errors: [{ reason: 'quotaExceeded' }] },
    });
    const { http, pageTokens } = searchHttp({ status: 403, body: quota });
    connector.http = http;

    await expect(
      connector.syncSearchVideos(
        {
          config: { search_query: 'lobu', max_results: 5 },
          credentials: { accessToken: 'tok' },
          checkpoint: { next_page_token: 'GOOD' },
        },
        { accessToken: 'tok' }
      )
    ).rejects.toThrow(/quotaExceeded/);

    // No blind restart was attempted.
    expect(pageTokens).toHaveLength(1);
  });

  /**
   * Serves search.list for a feed whose cursor dies *mid*-pagination: page one
   * always succeeds and always advertises `DEAD` as its next page, but `DEAD`
   * is always rejected. This is the shape that turns a naive "restart from page
   * one" recovery into an infinite loop — the restart re-fetches page one,
   * which hands the dead cursor straight back to the paginator.
   */
  function midPaginationHttp(rejection: { status: number; body: string }) {
    const pageTokens: Array<string | null> = [];
    return {
      pageTokens,
      http: {
        raw: async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith('/search')) {
            const token = u.searchParams.get('pageToken');
            pageTokens.push(token);
            // Runaway guard: fail loudly instead of hanging until the timeout.
            if (pageTokens.length > 20) {
              throw new Error(`runaway pagination: ${JSON.stringify(pageTokens)}`);
            }
            if (token === 'DEAD') {
              return {
                ok: false,
                status: rejection.status,
                text: async () => rejection.body,
                json: async () => JSON.parse(rejection.body),
              } as unknown as Response;
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                nextPageToken: 'DEAD',
                items: [
                  {
                    id: { videoId: 'vid1' },
                    snippet: { publishedAt: '2026-07-01T10:00:00Z', title: 'Page one' },
                  },
                ],
              }),
              text: async () => '',
            } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [
                {
                  id: 'vid1',
                  snippet: {
                    publishedAt: '2026-07-01T10:00:00Z',
                    title: 'Page one',
                    channelTitle: 'Chan',
                    description: '',
                  },
                  statistics: { viewCount: '1', likeCount: '0', commentCount: '0' },
                  contentDetails: { duration: 'PT1M' },
                },
              ],
            }),
            text: async () => '',
          } as unknown as Response;
        },
      },
    };
  }

  test('a cursor rejected mid-pagination terminates instead of looping back into it', async () => {
    const connector = new YouTubeConnector();
    const { http, pageTokens } = midPaginationHttp({ status: 400, body: INVALID_PAGE_TOKEN });
    connector.http = http;

    const result = await connector.syncSearchVideos(
      {
        config: {
          search_query: 'lobu',
          max_results: 50,
          include_transcripts: false,
          include_comments: false,
        },
        credentials: { accessToken: 'tok' },
        checkpoint: {},
      },
      { accessToken: 'tok' }
    );

    // page one (null) -> DEAD rejected -> restart at page one -> page one hands
    // back DEAD again, which is already known-dead, so the sync stops.
    expect(pageTokens).toEqual([null, 'DEAD', null]);
    expect(result.events.length).toBeGreaterThan(0);
    // The dead cursor must NOT be persisted, or the next run starts wedged.
    expect(result.checkpoint.next_page_token).toBeUndefined();
  });

  test('subscriptions pagination is bounded even when the API never stops paging', async () => {
    const connector = new YouTubeConnector();
    // Drop the politeness delay: 200 pages x 200ms would blow the test timeout.
    connector.RATE_LIMIT_MS = 0;
    let calls = 0;
    connector.http = {
      raw: async () => {
        calls++;
        // Runaway guard well above the 200-page ceiling: without maxPages this
        // endpoint would page forever, since it always advertises a new cursor
        // and the caller's item budget (5000) is never reached.
        if (calls > 400) throw new Error(`runaway pagination: ${calls} requests`);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            nextPageToken: `page${calls}`,
            items: [
              {
                id: `sub${calls}`,
                snippet: {
                  publishedAt: '2026-01-02T00:00:00Z',
                  title: `Channel ${calls}`,
                  resourceId: { kind: 'youtube#channel', channelId: `UC${calls}` },
                },
              },
            ],
          }),
          text: async () => '',
        } as unknown as Response;
      },
    };

    const result = await runSync(connector, {
      feedKey: 'subscriptions',
      credentials: { accessToken: 'tok' },
      config: { max_results: 5000 },
      checkpoint: {},
    });

    // Stopped by the page ceiling, not by the item budget.
    expect(calls).toBe(200);
    expect(result.events).toHaveLength(200);
  });

  test('the recovered run persists a checkpoint free of the rejected cursor', async () => {
    const connector = new YouTubeConnector();
    const { http } = searchHttp({ status: 400, body: INVALID_PAGE_TOKEN });
    connector.http = http;

    const result = await connector.syncSearchVideos(
      {
        config: {
          search_query: 'lobu',
          max_results: 5,
          include_transcripts: false,
          include_comments: false,
        },
        credentials: { accessToken: 'tok' },
        checkpoint: { next_page_token: 'DEAD_TOKEN' },
      },
      { accessToken: 'tok' }
    );

    // The restart page carried no nextPageToken, so the stored cursor clears
    // rather than persisting the rejected one for the next run to choke on.
    expect(result.checkpoint.next_page_token).toBeUndefined();
  });
});
