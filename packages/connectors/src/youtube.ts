/**
 * YouTube Connector (V1 runtime)
 *
 * Feeds (indexed sync → events / search_memory):
 *  - `liked_videos` — the authenticated user's liked videos (Likes playlist)
 *  - `playlists` — the user's playlists and their items
 *  - `subscriptions` — channels the authenticated user is subscribed to
 *  - `videos` — optional scheduled ingest of a fixed public keyword search
 *
 * Actions (on-demand via operations.execute — not persisted):
 *  - `search` — public YouTube keyword search
 *  - `get_video` — one video's metadata (+ optional transcript/comments)
 *  - `search_liked_videos` — filter your liked videos by title/channel
 *  - `list_playlists` — list your playlists
 *  - `get_playlist` — list videos in a playlist (optional title filter)
 *
 * Watch history is NOT exposed by the YouTube Data API; use Google Takeout for that.
 */

import {
  type ActionContext,
  type ActionResult,
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  createHttpClient,
  type EventEnvelope,
  paginateByCursor,
  sleep,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

/** What one YouTube sync gathers before it is committed. */
type YouTubeSyncPage = {
  events: EventEnvelope[];
  checkpoint: Record<string, unknown>;
  metadata?: SyncResult['metadata'];
};

// ---------------------------------------------------------------------------
// YouTube API types
// ---------------------------------------------------------------------------

interface YouTubeSearchItem {
  id: {
    kind: string;
    videoId: string;
  };
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    description: string;
    channelTitle: string;
  };
}

interface YouTubeSearchResponse {
  nextPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: YouTubeSearchItem[];
}

interface YouTubeVideoItem {
  id: string;
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    description: string;
    channelTitle: string;
    tags?: string[];
  };
  statistics: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
  contentDetails?: {
    duration?: string;
  };
}

interface YouTubeVideoResponse {
  items: YouTubeVideoItem[];
}

interface YouTubeCommentSnippet {
  videoId: string;
  topLevelComment: {
    id: string;
    snippet: {
      textDisplay: string;
      textOriginal: string;
      authorDisplayName: string;
      authorChannelUrl?: string;
      likeCount: number;
      publishedAt: string;
      updatedAt: string;
    };
  };
  totalReplyCount: number;
}

interface YouTubeCommentThread {
  id: string;
  snippet: YouTubeCommentSnippet;
}

interface YouTubeCommentThreadResponse {
  nextPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: YouTubeCommentThread[];
}

interface YouTubePlaylistItem {
  snippet: {
    publishedAt: string;
    title: string;
    channelTitle: string;
    playlistId: string;
    resourceId: {
      kind: string;
      videoId?: string;
    };
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
}

interface YouTubePlaylistItemResponse {
  nextPageToken?: string;
  items: YouTubePlaylistItem[];
}

interface YouTubePlaylist {
  id: string;
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    channelTitle: string;
  };
  contentDetails: {
    itemCount: number;
  };
}

interface YouTubePlaylistResponse {
  nextPageToken?: string;
  items: YouTubePlaylist[];
}

interface YouTubeChannelResponse {
  items: Array<{
    contentDetails: {
      relatedPlaylists: {
        likes?: string;
        uploads?: string;
      };
    };
  }>;
}

interface YouTubeSubscription {
  id: string;
  snippet: {
    publishedAt: string;
    title: string;
    description?: string;
    channelTitle?: string;
    resourceId: {
      kind: string;
      channelId?: string;
    };
  };
  contentDetails?: {
    totalItemCount?: number;
    newItemCount?: number;
    activityType?: string;
  };
}

interface YouTubeSubscriptionResponse {
  nextPageToken?: string;
  items: YouTubeSubscription[];
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
}

type YouTubeAuth = { accessToken?: string; apiKey?: string };

/** Compact video row returned by on-demand actions. */
interface VideoSummary {
  video_id: string;
  title: string;
  channel_title: string;
  channel_id?: string;
  published_at: string;
  url: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  description?: string;
  transcript?: string;
  duration?: string;
}

interface PlaylistSummary {
  playlist_id: string;
  title: string;
  description: string;
  item_count: number;
  channel_title: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

interface YouTubeCheckpoint {
  last_published_at?: string;
  next_page_token?: string;
}

/**
 * Does this search.list failure mean the persisted `pageToken` is no longer
 * usable? YouTube rejects a stale/foreign page token with 400
 * `invalidPageToken`; 410 GONE is the generic Google "this cursor is dead"
 * signal. Either way the token must be dropped and the sync restarted from the
 * first page, because the run-lifecycle preserves the checkpoint on failure —
 * so a rejected token that keeps throwing wedges the feed permanently.
 *
 * Deliberately narrow: a quota/auth 403 is NOT a token rejection and must keep
 * throwing so the real problem surfaces.
 *
 * Termination is guaranteed by the caller, not by this predicate: every token
 * it rejects is recorded and never requested again, so each distinct cursor can
 * trigger at most one restart and pagination cannot re-enter a dead one.
 */
function isPageTokenRejection(status: number, body: string): boolean {
  if (status === 410) return true;
  return status === 400 && body.includes('invalidPageToken');
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class YouTubeConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'youtube',
    name: 'YouTube',
    description:
      'Syncs liked videos, playlists, and optional keyword search; on-demand actions for public and library search.',
    version: '1.2.1',
    faviconDomain: 'youtube.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
          loginScopes: ['openid', 'email', 'profile'],
          clientIdKey: 'GOOGLE_CLIENT_ID',
          clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          loginProvisioning: {
            autoCreateConnection: false,
          },
        },
      ],
    },
    feeds: {
      liked_videos: {
        key: 'liked_videos',
        name: 'Liked Videos',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        description:
          "Videos the authenticated user has liked. Uses the account's Likes playlist.",
        configSchema: {
          type: 'object',
          properties: {
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 5000,
              default: 500,
              description: 'Maximum liked videos to fetch per sync.',
            },
          },
        },
        eventKinds: {
          liked_video: {
            description: 'A video the user liked on YouTube',
            metadataSchema: {
              type: 'object',
              properties: {
                video_id: { type: 'string' },
                channel_title: { type: 'string' },
                playlist_id: { type: 'string' },
                video_published_at: { type: 'string' },
              },
            },
          },
        },
      },
      playlists: {
        key: 'playlists',
        name: 'Playlists',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        description: "The authenticated user's playlists and the videos in each playlist.",
        configSchema: {
          type: 'object',
          properties: {
            max_playlists: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 100,
              description: 'Maximum playlists to fetch.',
            },
            include_items: {
              type: 'boolean',
              default: true,
              description: 'Whether to fetch videos inside each playlist.',
            },
            max_items_per_playlist: {
              type: 'integer',
              minimum: 1,
              maximum: 5000,
              default: 500,
              description: 'Per-playlist cap on items fetched when include_items is true.',
            },
          },
        },
        eventKinds: {
          playlist: {
            description: 'A YouTube playlist owned by the user',
            metadataSchema: {
              type: 'object',
              properties: {
                item_count: { type: 'number' },
                channel_title: { type: 'string' },
              },
            },
          },
          playlist_item: {
            description: 'A video inside a YouTube playlist',
            metadataSchema: {
              type: 'object',
              properties: {
                playlist_id: { type: 'string' },
                playlist_title: { type: 'string' },
                video_id: { type: 'string' },
                channel_title: { type: 'string' },
                video_published_at: { type: 'string' },
              },
            },
          },
        },
      },
      subscriptions: {
        key: 'subscriptions',
        name: 'Subscriptions',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        description: "Channels the authenticated user's YouTube account subscribes to.",
        configSchema: {
          type: 'object',
          properties: {
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 5000,
              default: 1000,
              description: 'Maximum subscribed channels to fetch per sync.',
            },
          },
        },
        eventKinds: {
          channel_subscription: {
            description: 'A YouTube channel the user is subscribed to',
            metadataSchema: {
              type: 'object',
              properties: {
                channel_id: { type: 'string' },
                channel_title: { type: 'string' },
                total_item_count: { type: 'number' },
                new_item_count: { type: 'number' },
                activity_type: { type: 'string' },
              },
            },
          },
        },
      },
      videos: {
        key: 'videos',
        name: 'Videos',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        description:
          'Scheduled ingest of a fixed public keyword search (metadata, comments, transcripts). For agent-time search use the `search` action instead.',
        configSchema: {
          type: 'object',
          required: ['search_query'],
          properties: {
            search_query: {
              type: 'string',
              minLength: 1,
              description: 'Fixed search term synced on each run (e.g. a topic you monitor).',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: 50,
              description: 'Total videos to fetch per sync (max 200).',
            },
            include_transcripts: {
              type: 'boolean',
              default: true,
              description: 'Whether to fetch video transcripts.',
            },
            include_comments: {
              type: 'boolean',
              default: true,
              description: 'Whether to fetch video comments.',
            },
          },
        },
        eventKinds: {
          video: {
            description: 'A YouTube video with metadata and optional transcript',
            metadataSchema: {
              type: 'object',
              properties: {
                view_count: { type: 'number' },
                like_count: { type: 'number' },
                comment_count: { type: 'number' },
                channel_title: { type: 'string' },
                channel_id: { type: 'string' },
                has_transcript: { type: 'boolean' },
                duration: { type: 'string' },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
          comment: {
            description: 'A comment on a YouTube video',
            metadataSchema: {
              type: 'object',
              properties: {
                video_id: { type: 'string' },
                like_count: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
        },
      },
    },
    actions: {
      search: {
        key: 'search',
		kind: 'read',
        name: 'Search Videos',
        description: 'Search public YouTube by keyword and return matching videos.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'YouTube search keywords (public catalog).',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'Maximum videos to return (default 10).',
            },
            include_transcript: {
              type: 'boolean',
              description: 'Fetch captions when available (default false).',
            },
          },
        },
      },
      get_video: {
        key: 'get_video',
		kind: 'read',
        name: 'Get Video',
        description: 'Fetch metadata for one YouTube video by id or URL.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['video_id'],
          properties: {
            video_id: {
              type: 'string',
              description: 'YouTube video id or watch URL.',
            },
            include_transcript: {
              type: 'boolean',
              description: 'Fetch captions when available (default true).',
            },
            include_comments: {
              type: 'boolean',
              description: 'Include top comment threads (default false).',
            },
          },
        },
      },
      search_liked_videos: {
        key: 'search_liked_videos',
		kind: 'read',
        name: 'Search Liked Videos',
        description:
          "Filter the authenticated user's liked videos by title or channel name (substring match).",
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'Case-insensitive filter on video title or channel name.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Maximum matches to return (default 25).',
            },
          },
        },
      },
      list_playlists: {
        key: 'list_playlists',
		kind: 'read',
        name: 'List Playlists',
        description: "List the authenticated user's YouTube playlists.",
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          properties: {
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Maximum playlists to return (default 25).',
            },
          },
        },
      },
      get_playlist: {
        key: 'get_playlist',
		kind: 'read',
        name: 'Get Playlist',
        description: 'List videos in one of your playlists, with an optional title filter.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['playlist_id'],
          properties: {
            playlist_id: {
              type: 'string',
              description: 'Playlist id or youtube.com/playlist?list= URL.',
            },
            query: {
              type: 'string',
              description: 'Optional case-insensitive filter on video title or channel.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Maximum videos to return (default 50).',
            },
          },
        },
      },
    },
  };

  private readonly BASE_URL = 'https://www.googleapis.com/youtube/v3';
  private readonly RATE_LIMIT_MS = 200;
  private readonly COMMENT_PAGE_LIMIT = 3;
  // Hard ceiling on cursor pagination, matching the Calendar connector's
  // MAX_PAGES. Defensive only: every loop below also stops on its own item
  // budget. This is the backstop for an API that keeps handing back a cursor.
  private readonly MAX_PAGES = 200;
  private readonly http = createHttpClient({ errorPrefix: 'YouTube API' });

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const page = await this.collectFeed(ctx);
    await ctx.commit(page.events, page.checkpoint);
    return { status: 'complete', ...(page.metadata ? { metadata: page.metadata } : {}) };
  }

  private async collectFeed(ctx: SyncContext): Promise<YouTubeSyncPage> {
    const auth = this.resolveAuth(ctx);

    switch (ctx.feedKey) {
      case 'liked_videos':
        return this.syncLikedVideos(ctx, auth);
      case 'playlists':
        return this.syncPlaylists(ctx, auth);
      case 'subscriptions':
        return this.syncSubscriptions(ctx, auth);
      case 'videos':
        return this.syncSearchVideos(ctx, auth);
      default:
        throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }
  }

  private resolveAuth(ctx: SyncContext): YouTubeAuth {
    const accessToken = ctx.credentials?.accessToken as string | undefined;
    const apiKey = (ctx.config.YOUTUBE_API_KEY as string) || undefined;
    if (!accessToken && !apiKey) {
      throw new Error('YouTube requires either OAuth (Google) or a YOUTUBE_API_KEY.');
    }
    return { accessToken, apiKey };
  }

  private requireOAuth(auth: YouTubeAuth, feed: string): string {
    if (!auth.accessToken) {
      throw new Error(
        `YouTube feed '${feed}' requires OAuth (youtube.readonly). Connect a Google account.`
      );
    }
    return auth.accessToken;
  }

  // -------------------------------------------------------------------------
  // execute (on-demand actions)
  // -------------------------------------------------------------------------

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const auth = this.resolveAuthFromAction(ctx);
      switch (ctx.actionKey) {
        case 'search':
          return await this.actionSearchPublic(auth, ctx.input);
        case 'get_video':
          return await this.actionGetVideo(auth, ctx.input);
        case 'search_liked_videos':
          return await this.actionSearchLikedVideos(auth, ctx.input);
        case 'list_playlists':
          return await this.actionListPlaylists(auth, ctx.input);
        case 'get_playlist':
          return await this.actionGetPlaylist(auth, ctx.input);
        default:
          return { success: false, error: `Unknown action: ${ctx.actionKey}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveAuthFromAction(ctx: ActionContext): YouTubeAuth {
    const accessToken = ctx.credentials?.accessToken as string | undefined;
    const apiKey = (ctx.config?.YOUTUBE_API_KEY as string) || undefined;
    if (!accessToken && !apiKey) {
      throw new Error('YouTube requires either OAuth (Google) or a YOUTUBE_API_KEY.');
    }
    return { accessToken, apiKey };
  }

  private async actionSearchPublic(
    auth: YouTubeAuth,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const query = (input.query as string)?.trim();
    if (!query) {
      return { success: false, error: 'query is required.' };
    }
    const maxResults = Math.min(Math.max((input.max_results as number) ?? 10, 1), 50);
    const includeTranscript = (input.include_transcript as boolean) ?? false;
    const videos = await this.searchPublicVideos(auth, query, maxResults, includeTranscript);
    return { success: true, output: { videos } };
  }

  private async actionGetVideo(
    auth: YouTubeAuth,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const videoId = this.parseVideoId(input.video_id as string);
    if (!videoId) {
      return { success: false, error: 'video_id is required.' };
    }
    const includeTranscript = (input.include_transcript as boolean) ?? true;
    const includeComments = (input.include_comments as boolean) ?? false;
    const details = await this.fetchVideoDetails(auth, [videoId]);
    if (details.length === 0) {
      return { success: false, error: `Video '${videoId}' not found.` };
    }
    const video = await this.videoToSummary(details[0], auth, {
      includeTranscript,
      includeComments,
    });
    return { success: true, output: { video } };
  }

  private async actionSearchLikedVideos(
    auth: YouTubeAuth,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    this.requireOAuth(auth, 'search_liked_videos');
    const query = (input.query as string)?.trim();
    if (!query) {
      return { success: false, error: 'query is required.' };
    }
    const maxResults = Math.min(Math.max((input.max_results as number) ?? 25, 1), 100);
    const likesPlaylistId = await this.fetchLikesPlaylistId(auth);
    const videos = await this.searchPlaylistItemsByQuery({
      auth,
      playlistId: likesPlaylistId,
      query,
      maxResults,
    });
    return { success: true, output: { videos } };
  }

  private async actionListPlaylists(
    auth: YouTubeAuth,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    this.requireOAuth(auth, 'list_playlists');
    const maxResults = Math.min(Math.max((input.max_results as number) ?? 25, 1), 100);
    const playlists: PlaylistSummary[] = [];
    const pages = paginateByCursor<YouTubePlaylist, string>(
      async (cursor) => {
        const params = new URLSearchParams({
          part: 'snippet,contentDetails',
          mine: 'true',
          maxResults: '50',
        });
        if (cursor) params.set('pageToken', cursor);
        const response = await this.apiGet(`${this.BASE_URL}/playlists?${params.toString()}`, auth);
        if (!response.ok) {
          throw new Error(
            `YouTube Playlists API error (${response.status}): ${await response.text()}`
          );
        }
        const data = (await response.json()) as YouTubePlaylistResponse;
        return { items: data.items ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES, delayMs: this.RATE_LIMIT_MS }
    );
    for await (const batch of pages) {
      for (const playlist of batch) {
        if (playlists.length >= maxResults) break;
        playlists.push(this.playlistToSummary(playlist));
      }
      if (playlists.length >= maxResults) break;
    }
    return { success: true, output: { playlists } };
  }

  private async actionGetPlaylist(
    auth: YouTubeAuth,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    this.requireOAuth(auth, 'get_playlist');
    const playlistId = this.parsePlaylistId(input.playlist_id as string);
    if (!playlistId) {
      return { success: false, error: 'playlist_id is required.' };
    }
    const query = (input.query as string)?.trim();
    const maxResults = Math.min(Math.max((input.max_results as number) ?? 50, 1), 100);
    const videos = await this.searchPlaylistItemsByQuery({
      auth,
      playlistId,
      query: query || undefined,
      maxResults,
    });
    return { success: true, output: { playlist_id: playlistId, videos } };
  }

  // -------------------------------------------------------------------------
  // Feed: liked_videos
  // -------------------------------------------------------------------------

  private async syncLikedVideos(ctx: SyncContext, auth: YouTubeAuth): Promise<YouTubeSyncPage> {
    this.requireOAuth(auth, 'liked_videos');
    const maxResults = Math.min(Math.max((ctx.config.max_results as number) ?? 500, 1), 5000);
    const likesPlaylistId = await this.fetchLikesPlaylistId(auth);
    const events = await this.collectPlaylistVideoEvents({
      auth,
      playlistId: likesPlaylistId,
      playlistTitle: 'Liked videos',
      maxResults,
      originType: 'liked_video',
      originIdPrefix: 'yt_liked',
    });

    return this.buildListCheckpointResult(events);
  }

  // -------------------------------------------------------------------------
  // Feed: playlists
  // -------------------------------------------------------------------------

  private async syncPlaylists(ctx: SyncContext, auth: YouTubeAuth): Promise<YouTubeSyncPage> {
    this.requireOAuth(auth, 'playlists');
    const maxPlaylists = Math.min(Math.max((ctx.config.max_playlists as number) ?? 100, 1), 500);
    const includeItems = (ctx.config.include_items as boolean) ?? true;
    const maxItemsPerPlaylist = Math.min(
      Math.max((ctx.config.max_items_per_playlist as number) ?? 500, 1),
      5000
    );

    const events: EventEnvelope[] = [];
    let collectedPlaylists = 0;

    const playlistPages = paginateByCursor<YouTubePlaylist, string>(
      async (cursor) => {
        const params = new URLSearchParams({
          part: 'snippet,contentDetails',
          mine: 'true',
          maxResults: '50',
        });
        if (cursor) params.set('pageToken', cursor);
        const response = await this.apiGet(`${this.BASE_URL}/playlists?${params.toString()}`, auth);
        if (!response.ok) {
          throw new Error(
            `YouTube Playlists API error (${response.status}): ${await response.text()}`
          );
        }
        const data = (await response.json()) as YouTubePlaylistResponse;
        return { items: data.items ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES, delayMs: this.RATE_LIMIT_MS }
    );

    for await (const playlists of playlistPages) {
      for (const playlist of playlists) {
        if (collectedPlaylists >= maxPlaylists) break;

        events.push({
          origin_id: `yt_playlist_${playlist.id}`,
          title: playlist.snippet.title,
          payload_text: (playlist.snippet.description ?? '').trim(),
          author_name: playlist.snippet.channelTitle,
          source_url: `https://www.youtube.com/playlist?list=${playlist.id}`,
          occurred_at: new Date(playlist.snippet.publishedAt),
          origin_type: 'playlist',
          metadata: {
            item_count: playlist.contentDetails.itemCount,
            channel_title: playlist.snippet.channelTitle,
          },
        });

        if (includeItems && playlist.contentDetails.itemCount > 0) {
          const itemEvents = await this.collectPlaylistVideoEvents({
            auth,
            playlistId: playlist.id,
            playlistTitle: playlist.snippet.title,
            maxResults: maxItemsPerPlaylist,
            originType: 'playlist_item',
            originIdPrefix: `yt_playlist_item_${playlist.id}`,
          });
          events.push(...itemEvents);
        }

        collectedPlaylists += 1;
      }
      if (collectedPlaylists >= maxPlaylists) break;
    }

    return this.buildListCheckpointResult(events);
  }

  // -------------------------------------------------------------------------
  // Feed: subscriptions
  // -------------------------------------------------------------------------

  private async syncSubscriptions(ctx: SyncContext, auth: YouTubeAuth): Promise<YouTubeSyncPage> {
    this.requireOAuth(auth, 'subscriptions');
    const maxResults = Math.min(Math.max((ctx.config.max_results as number) ?? 1000, 1), 5000);
    const events: EventEnvelope[] = [];

    const pages = paginateByCursor<YouTubeSubscription, string>(
      async (cursor) => {
        const params = new URLSearchParams({
          part: 'snippet,contentDetails',
          mine: 'true',
          maxResults: '50',
          order: 'alphabetical',
        });
        if (cursor) params.set('pageToken', cursor);
        const response = await this.apiGet(
          `${this.BASE_URL}/subscriptions?${params.toString()}`,
          auth
        );
        if (!response.ok) {
          throw new Error(
            `YouTube Subscriptions API error (${response.status}): ${await response.text()}`
          );
        }
        const data = (await response.json()) as YouTubeSubscriptionResponse;
        return { items: data.items ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES, delayMs: this.RATE_LIMIT_MS }
    );

    for await (const subscriptions of pages) {
      for (const subscription of subscriptions) {
        if (events.length >= maxResults) return this.buildListCheckpointResult(events);
        const channelId = subscription.snippet.resourceId.channelId;
        if (!channelId) continue;
        const channelTitle = subscription.snippet.title;
        events.push({
          origin_id: `yt_subscription_${channelId}`,
          title: channelTitle,
          payload_text: [channelTitle, subscription.snippet.description]
            .filter(Boolean)
            .join('\n'),
          author_name: channelTitle,
          source_url: `https://www.youtube.com/channel/${channelId}`,
          occurred_at: new Date(subscription.snippet.publishedAt),
          origin_type: 'channel_subscription',
          metadata: {
            channel_id: channelId,
            channel_title: channelTitle,
            ...(subscription.contentDetails?.totalItemCount != null && {
              total_item_count: subscription.contentDetails.totalItemCount,
            }),
            ...(subscription.contentDetails?.newItemCount != null && {
              new_item_count: subscription.contentDetails.newItemCount,
            }),
            ...(subscription.contentDetails?.activityType && {
              activity_type: subscription.contentDetails.activityType,
            }),
          },
        });
      }
      if (events.length >= maxResults) break;
    }

    return this.buildListCheckpointResult(events);
  }

  // -------------------------------------------------------------------------
  // Feed: videos (keyword search)
  // -------------------------------------------------------------------------

  private async syncSearchVideos(ctx: SyncContext, auth: YouTubeAuth): Promise<YouTubeSyncPage> {
    const searchQuery = ctx.config.search_query as string;
    if (!searchQuery) {
      throw new Error('search_query is required.');
    }

    const maxResults = Math.min((ctx.config.max_results as number) ?? 50, 200);
    const includeTranscripts = (ctx.config.include_transcripts as boolean) ?? true;
    const includeComments = (ctx.config.include_comments as boolean) ?? true;

    const checkpoint = (ctx.checkpoint as YouTubeCheckpoint) ?? {};
    const events: EventEnvelope[] = [];
    const seenIds = new Set<string>();

    let pageToken: string | undefined = checkpoint.next_page_token;
    let totalCollected = 0;
    // Cursors YouTube rejected during this run. Remembering the token itself —
    // not merely "a recovery happened" — is what makes the restart safe: page
    // one legitimately re-advertises the same nextPageToken that just died, so
    // a bare flag would let the paginator walk right back into the dead cursor.
    const rejectedPageTokens = new Set<string>();

    // One page fetch, including the single restart-from-page-one recovery.
    const fetchSearchPage = async (cursor: string | null): Promise<YouTubeSearchResponse> => {
      const pageSize = Math.min(50, maxResults - totalCollected);
      const response = await this.apiGet(
        this.buildSearchUrl(searchQuery, pageSize, cursor ?? undefined),
        auth
      );
      if (response.ok) return (await response.json()) as YouTubeSearchResponse;

      // Read the body exactly once — it drives both the rejection test and the
      // error message, and a Response body cannot be consumed twice.
      const body = await response.text();
      if (!cursor || !isPageTokenRejection(response.status, body)) {
        throw new Error(`YouTube Search API error (${response.status}): ${body}`);
      }

      // Stale cursor: remember it so pagination can never follow it again, then
      // restart from page one so the feed recovers instead of failing forever.
      rejectedPageTokens.add(cursor);
      const restart = await this.apiGet(this.buildSearchUrl(searchQuery, pageSize), auth);
      if (!restart.ok) {
        throw new Error(`YouTube Search API error (${restart.status}): ${await restart.text()}`);
      }
      return (await restart.json()) as YouTubeSearchResponse;
    };

    const searchPages = paginateByCursor<YouTubeSearchItem, string>(
      async (cursor) => {
        const searchData = await fetchSearchPage(cursor);
        // Stop rather than follow a cursor this run has already seen rejected.
        // Page one legitimately re-advertises the token that just died, so
        // without this the restart would walk straight back into it. Dropping
        // it here also keeps it out of the persisted checkpoint below.
        const next =
          searchData.nextPageToken && rejectedPageTokens.has(searchData.nextPageToken)
            ? undefined
            : searchData.nextPageToken;
        pageToken = next;
        return { items: searchData.items, nextCursor: next };
      },
      {
        initialCursor: checkpoint.next_page_token ?? null,
        maxPages: this.MAX_PAGES,
        delayMs: this.RATE_LIMIT_MS,
      }
    );

    for await (const searchItems of searchPages) {
      if (searchItems.length === 0) break;

      const videoIds: string[] = [];
      for (const item of searchItems) {
        const videoId = item.id.videoId;
        if (videoId && !seenIds.has(videoId)) {
          seenIds.add(videoId);
          videoIds.push(videoId);
        }
      }

      if (videoIds.length === 0) continue;

      const videoDetails = await this.fetchVideoDetails(auth, videoIds);

      for (const video of videoDetails) {
        try {
          const viewCount = parseInt(video.statistics.viewCount ?? '0', 10);
          const likeCount = parseInt(video.statistics.likeCount ?? '0', 10);
          const commentCount = parseInt(video.statistics.commentCount ?? '0', 10);

          let transcript: string | null = null;
          if (includeTranscripts) {
            try {
              transcript = await this.fetchTranscript(video.id);
            } catch {
              /* transcript fetch is best-effort */
            }
            await sleep(this.RATE_LIMIT_MS);
          }

          const hasTranscript = transcript != null && transcript.length > 0;

          const engagementScore = calculateEngagementScore('youtube', {
            upvotes: likeCount,
            reply_count: commentCount,
            score: Math.round(viewCount / 100),
          });

          const videoEvent: EventEnvelope = {
            origin_id: `yt_video_${video.id}`,
            title: video.snippet.title,
            payload_text: hasTranscript ? transcript! : (video.snippet.description ?? '').trim(),
            author_name: video.snippet.channelTitle,
            source_url: `https://www.youtube.com/watch?v=${video.id}`,
            occurred_at: new Date(video.snippet.publishedAt),
            origin_type: 'video',
            score: engagementScore,
            metadata: {
              view_count: viewCount,
              like_count: likeCount,
              comment_count: commentCount,
              channel_title: video.snippet.channelTitle,
              channel_id: video.snippet.channelId,
              has_transcript: hasTranscript,
              ...(video.contentDetails?.duration && {
                duration: video.contentDetails.duration,
              }),
              ...(video.snippet.tags &&
                video.snippet.tags.length > 0 && {
                  tags: video.snippet.tags,
                }),
            },
          };

          events.push(videoEvent);

          if (includeComments && commentCount > 0) {
            try {
              const comments = await this.fetchComments(auth, video.id);
              for (const comment of comments) {
                const commentSnippet = comment.snippet.topLevelComment.snippet;

                events.push({
                  origin_id: `yt_comment_${comment.snippet.topLevelComment.id}`,
                  payload_text: commentSnippet.textOriginal,
                  author_name: commentSnippet.authorDisplayName,
                  source_url: `https://www.youtube.com/watch?v=${video.id}&lc=${comment.snippet.topLevelComment.id}`,
                  occurred_at: new Date(commentSnippet.publishedAt),
                  origin_type: 'comment',
                  origin_parent_id: `yt_video_${video.id}`,
                  metadata: {
                    video_id: video.id,
                    like_count: commentSnippet.likeCount,
                    reply_count: comment.snippet.totalReplyCount,
                  },
                });
              }
            } catch {
              /* comment fetch is best-effort */
            }
          }
        } catch {
          /* skip individual video failures */
        }
      }

      totalCollected += videoIds.length;
      if (totalCollected >= maxResults) break;
    }

    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    const latestPublishedAt = events.length > 0 ? events[0].occurred_at.toISOString() : undefined;
    const newCheckpoint: YouTubeCheckpoint = {
      last_published_at: latestPublishedAt ?? checkpoint.last_published_at,
      next_page_token: pageToken,
    };

    return {
      events,
      checkpoint: newCheckpoint as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        videos_collected: seenIds.size,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Shared playlist helpers
  // -------------------------------------------------------------------------

  private async fetchLikesPlaylistId(auth: YouTubeAuth): Promise<string> {
    const params = new URLSearchParams({
      part: 'contentDetails',
      mine: 'true',
    });
    const response = await this.apiGet(`${this.BASE_URL}/channels?${params.toString()}`, auth);
    if (!response.ok) {
      throw new Error(
        `YouTube Channels API error (${response.status}): ${await response.text()}`
      );
    }
    const data = (await response.json()) as YouTubeChannelResponse;
    const likesPlaylistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.likes;
    if (!likesPlaylistId) {
      throw new Error(
        'Could not resolve the Likes playlist for this YouTube account. Ensure the Google account has a YouTube channel.'
      );
    }
    return likesPlaylistId;
  }

  private async collectPlaylistVideoEvents(params: {
    auth: YouTubeAuth;
    playlistId: string;
    playlistTitle: string;
    maxResults: number;
    originType: string;
    originIdPrefix: string;
  }): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    let collected = 0;

    const itemPages = paginateByCursor<YouTubePlaylistItem, string>(
      async (cursor) => {
        const listParams = new URLSearchParams({
          part: 'snippet,contentDetails',
          playlistId: params.playlistId,
          maxResults: '50',
        });
        if (cursor) listParams.set('pageToken', cursor);
        const response = await this.apiGet(
          `${this.BASE_URL}/playlistItems?${listParams.toString()}`,
          params.auth
        );
        if (!response.ok) {
          throw new Error(
            `YouTube PlaylistItems API error (${response.status}): ${await response.text()}`
          );
        }
        const data = (await response.json()) as YouTubePlaylistItemResponse;
        return { items: data.items ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES, delayMs: this.RATE_LIMIT_MS }
    );

    for await (const items of itemPages) {
      for (const item of items) {
        if (collected >= params.maxResults) return events;
        const videoId =
          item.snippet.resourceId.videoId ?? item.contentDetails?.videoId ?? null;
        if (!videoId) continue;

        events.push({
          origin_id: `${params.originIdPrefix}_${videoId}`,
          title: item.snippet.title,
          payload_text: `${item.snippet.title} — ${item.snippet.channelTitle}`,
          author_name: item.snippet.channelTitle,
          source_url: `https://www.youtube.com/watch?v=${videoId}`,
          occurred_at: new Date(item.snippet.publishedAt),
          origin_type: params.originType,
          ...(params.originType === 'playlist_item' && {
            origin_parent_id: `yt_playlist_${params.playlistId}`,
          }),
          metadata: {
            video_id: videoId,
            channel_title: item.snippet.channelTitle,
            playlist_id: params.playlistId,
            ...(params.originType === 'playlist_item' && {
              playlist_title: params.playlistTitle,
            }),
            ...(item.contentDetails?.videoPublishedAt && {
              video_published_at: item.contentDetails.videoPublishedAt,
            }),
          },
        });
        collected += 1;
      }
      if (collected >= params.maxResults) break;
    }

    return events;
  }

  private buildListCheckpointResult(events: EventEnvelope[]): YouTubeSyncPage {
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
    const latest = events.length > 0 ? events[0].occurred_at.toISOString() : undefined;
    return {
      events,
      checkpoint: {
        last_published_at: latest,
      } satisfies YouTubeCheckpoint as Record<string, unknown>,
      metadata: {
        items_found: events.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Shared search / action helpers
  // -------------------------------------------------------------------------

  private parseVideoId(raw: string | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const urlMatch = trimmed.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
    );
    if (urlMatch) return urlMatch[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
    return null;
  }

  private parsePlaylistId(raw: string | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const urlMatch = trimmed.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
    return null;
  }

  private playlistToSummary(playlist: YouTubePlaylist): PlaylistSummary {
    return {
      playlist_id: playlist.id,
      title: playlist.snippet.title,
      description: (playlist.snippet.description ?? '').trim(),
      item_count: playlist.contentDetails.itemCount,
      channel_title: playlist.snippet.channelTitle,
      url: `https://www.youtube.com/playlist?list=${playlist.id}`,
    };
  }

  private async videoToSummary(
    video: YouTubeVideoItem,
    auth: YouTubeAuth,
    options: { includeTranscript: boolean; includeComments: boolean }
  ): Promise<VideoSummary & { comments?: Array<{ text: string; author: string; like_count: number }> }> {
    let transcript: string | undefined;
    if (options.includeTranscript) {
      const text = await this.fetchTranscript(video.id);
      if (text) transcript = text;
    }
    const summary: VideoSummary & {
      comments?: Array<{ text: string; author: string; like_count: number }>;
    } = {
      video_id: video.id,
      title: video.snippet.title,
      channel_title: video.snippet.channelTitle,
      channel_id: video.snippet.channelId,
      published_at: video.snippet.publishedAt,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      view_count: parseInt(video.statistics.viewCount ?? '0', 10),
      like_count: parseInt(video.statistics.likeCount ?? '0', 10),
      comment_count: parseInt(video.statistics.commentCount ?? '0', 10),
      description: (video.snippet.description ?? '').trim() || undefined,
      ...(video.contentDetails?.duration && { duration: video.contentDetails.duration }),
      ...(transcript && { transcript }),
    };
    if (options.includeComments && summary.comment_count && summary.comment_count > 0) {
      const threads = await this.fetchComments(auth, video.id);
      summary.comments = threads.map((c) => ({
        text: c.snippet.topLevelComment.snippet.textOriginal,
        author: c.snippet.topLevelComment.snippet.authorDisplayName,
        like_count: c.snippet.topLevelComment.snippet.likeCount,
      }));
    }
    return summary;
  }

  private matchesLibraryQuery(
    title: string,
    channelTitle: string,
    query: string | undefined
  ): boolean {
    if (!query) return true;
    const needle = query.toLowerCase();
    return (
      title.toLowerCase().includes(needle) || channelTitle.toLowerCase().includes(needle)
    );
  }

  private playlistItemToSummary(item: YouTubePlaylistItem): VideoSummary | null {
    const videoId = item.snippet.resourceId.videoId ?? item.contentDetails?.videoId ?? null;
    if (!videoId) return null;
    return {
      video_id: videoId,
      title: item.snippet.title,
      channel_title: item.snippet.channelTitle,
      published_at: item.snippet.publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  private async searchPlaylistItemsByQuery(params: {
    auth: YouTubeAuth;
    playlistId: string;
    query?: string;
    maxResults: number;
  }): Promise<VideoSummary[]> {
    const videos: VideoSummary[] = [];
    const pages = paginateByCursor<YouTubePlaylistItem, string>(
      async (cursor) => {
        const listParams = new URLSearchParams({
          part: 'snippet,contentDetails',
          playlistId: params.playlistId,
          maxResults: '50',
        });
        if (cursor) listParams.set('pageToken', cursor);
        const response = await this.apiGet(
          `${this.BASE_URL}/playlistItems?${listParams.toString()}`,
          params.auth
        );
        if (!response.ok) {
          throw new Error(
            `YouTube PlaylistItems API error (${response.status}): ${await response.text()}`
          );
        }
        const data = (await response.json()) as YouTubePlaylistItemResponse;
        return { items: data.items ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES, delayMs: this.RATE_LIMIT_MS }
    );
    for await (const items of pages) {
      for (const item of items) {
        if (videos.length >= params.maxResults) return videos;
        if (
          !this.matchesLibraryQuery(
            item.snippet.title,
            item.snippet.channelTitle,
            params.query
          )
        ) {
          continue;
        }
        const summary = this.playlistItemToSummary(item);
        if (summary) videos.push(summary);
      }
      if (videos.length >= params.maxResults) break;
    }
    return videos;
  }

  private async searchPublicVideos(
    auth: YouTubeAuth,
    query: string,
    maxResults: number,
    includeTranscript: boolean
  ): Promise<VideoSummary[]> {
    const searchUrl = this.buildSearchUrl(query, Math.min(maxResults, 50));
    const searchResponse = await this.apiGet(searchUrl, auth);
    if (!searchResponse.ok) {
      throw new Error(
        `YouTube Search API error (${searchResponse.status}): ${await searchResponse.text()}`
      );
    }
    const searchData = (await searchResponse.json()) as YouTubeSearchResponse;
    const videoIds = (searchData.items ?? [])
      .map((item) => item.id.videoId)
      .filter((id): id is string => Boolean(id))
      .slice(0, maxResults);
    if (videoIds.length === 0) return [];

    const details = await this.fetchVideoDetails(auth, videoIds);
    const videos: VideoSummary[] = [];
    for (const video of details) {
      videos.push(
        await this.videoToSummary(video, auth, {
          includeTranscript,
          includeComments: false,
        })
      );
      if (includeTranscript) await sleep(this.RATE_LIMIT_MS);
    }
    return videos;
  }

  // -------------------------------------------------------------------------
  // YouTube API helpers
  // -------------------------------------------------------------------------

  private buildSearchUrl(query: string, maxResults: number, pageToken?: string): string {
    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      order: 'date',
      maxResults: String(maxResults),
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    return `${this.BASE_URL}/search?${params.toString()}`;
  }

  private async fetchVideoDetails(
    auth: YouTubeAuth,
    videoIds: string[]
  ): Promise<YouTubeVideoItem[]> {
    const results: YouTubeVideoItem[] = [];

    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const params = new URLSearchParams({
        part: 'snippet,statistics,contentDetails',
        id: batch.join(','),
      });

      const response = await this.apiGet(`${this.BASE_URL}/videos?${params.toString()}`, auth);
      if (!response.ok) {
        throw new Error(`YouTube Videos API error (${response.status}): ${await response.text()}`);
      }

      const data = (await response.json()) as YouTubeVideoResponse;
      results.push(...data.items);

      if (i + 50 < videoIds.length) {
        await sleep(this.RATE_LIMIT_MS);
      }
    }

    return results;
  }

  private async fetchComments(
    auth: YouTubeAuth,
    videoId: string
  ): Promise<YouTubeCommentThread[]> {
    const allComments: YouTubeCommentThread[] = [];

    const pages = paginateByCursor<YouTubeCommentThread, string>(
      async (cursor) => {
        const params = new URLSearchParams({
          part: 'snippet',
          videoId,
          maxResults: '100',
          order: 'relevance',
        });
        if (cursor) {
          params.set('pageToken', cursor);
        }

        const response = await this.apiGet(
          `${this.BASE_URL}/commentThreads?${params.toString()}`,
          auth
        );

        if (!response.ok) {
          if (response.status === 403) return { items: [], nextCursor: null };
          throw new Error(
            `YouTube Comments API error (${response.status}): ${await response.text()}`
          );
        }

        const data = (await response.json()) as YouTubeCommentThreadResponse;
        return { items: data.items, nextCursor: data.nextPageToken };
      },
      { maxPages: this.COMMENT_PAGE_LIMIT, delayMs: this.RATE_LIMIT_MS }
    );

    for await (const items of pages) {
      allComments.push(...items);
    }

    return allComments;
  }

  // -------------------------------------------------------------------------
  // Transcript fetching (no external packages)
  // -------------------------------------------------------------------------

  private async fetchTranscript(videoId: string): Promise<string | null> {
    try {
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await fetch(watchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) return null;

      const html = await response.text();
      const captionTracks = this.extractCaptionTracks(html);
      if (!captionTracks || captionTracks.length === 0) return null;

      const englishTrack = captionTracks.find(
        (t) => t.languageCode === 'en' || t.languageCode.startsWith('en-')
      );
      const track = englishTrack ?? captionTracks[0];

      const captionResponse = await fetch(track.baseUrl);
      if (!captionResponse.ok) return null;

      const captionXml = await captionResponse.text();
      return this.parseTimedTextXml(captionXml);
    } catch {
      return null;
    }
  }

  private extractCaptionTracks(html: string): CaptionTrack[] | null {
    const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!playerResponseMatch) return null;

    try {
      const playerResponse = JSON.parse(playerResponseMatch[1]) as {
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: Array<{
              baseUrl: string;
              languageCode: string;
            }>;
          };
        };
      };

      const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks || tracks.length === 0) return null;

      return tracks.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
      }));
    } catch {
      return null;
    }
  }

  private parseTimedTextXml(xml: string): string | null {
    const textSegments: string[] = [];
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match: RegExpExecArray | null;

    while ((match = textRegex.exec(xml)) !== null) {
      let text = match[1];
      text = text.replace(
        /&(amp|lt|gt|quot|apos|#39|#(\d+));/g,
        (_match, name, numeric) => {
          switch (name) {
            case 'amp':
              return '&';
            case 'lt':
              return '<';
            case 'gt':
              return '>';
            case 'quot':
              return '"';
            case 'apos':
            case '#39':
              return "'";
            default:
              return numeric ? String.fromCharCode(parseInt(numeric, 10)) : '';
          }
        }
      );
      let previous: string;
      do {
        previous = text;
        text = text.replace(/<[^>]*>/g, '');
      } while (text !== previous);
      const trimmed = text.trim();
      if (trimmed) {
        textSegments.push(trimmed);
      }
    }

    if (textSegments.length === 0) return null;
    return textSegments.join(' ');
  }

  private async apiGet(url: string, auth: YouTubeAuth): Promise<Response> {
    const parsedUrl = new URL(url);
    if (auth.apiKey && !auth.accessToken) {
      parsedUrl.searchParams.set('key', auth.apiKey);
    }
    const headers: Record<string, string> = {};
    if (auth.accessToken) {
      headers.Authorization = `Bearer ${auth.accessToken}`;
    }
    return this.http.raw(parsedUrl.toString(), { headers });
  }
}
