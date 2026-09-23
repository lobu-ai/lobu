/**
 * Reddit Connector (V1 runtime)
 *
 * Fetches posts and comments from Reddit subreddits or search queries.
 * Supports both authenticated (OAuth) and unauthenticated (public JSON API) modes.
 */

import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  createHttpClient,
  type EventEnvelope,
  HttpStatusError,
  paginateByCursor,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Reddit API types
// ---------------------------------------------------------------------------

interface RedditPost {
  name: string;
  id: string;
  title: string;
  selftext: string;
  author: string;
  permalink: string;
  url: string;
  created_utc: number;
  score: number;
  ups: number;
  num_comments: number;
  upvote_ratio: number;
  is_self: boolean;
  domain: string;
  subreddit: string;
  crosspost_parent?: string;
  thumbnail?: string;
}

interface RedditComment {
  name: string;
  id: string;
  body: string;
  author: string;
  permalink: string;
  created_utc: number;
  score: number;
  ups: number;
  parent_id: string;
  link_id: string;
  subreddit: string;
}

interface RedditListingResponse {
  data: {
    children: Array<{
      kind: string;
      data: RedditPost & RedditComment;
    }>;
    after: string | null;
  };
}

interface RedditCheckpoint {
  last_timestamp?: string;
  pagination_token?: string;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class RedditConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'reddit',
    name: 'Reddit',
    description: 'Fetches posts and comments from Reddit subreddits or search queries.',
    version: '1.0.0',
    faviconDomain: 'reddit.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'reddit',
          requiredScopes: ['identity', 'read', 'history'],
          setupInstructions:
            'Create a Reddit app at https://www.reddit.com/prefs/apps — choose "web app" as the type. Set the redirect URI to {{redirect_uri}}, then copy the client ID and secret below.',
        },
        {
          type: 'none',
        },
      ],
    },
    feeds: {
      posts: {
        key: 'posts',
        name: 'Posts',
        sync: (ctx) => this.syncFeed(ctx),
        description: 'Fetch posts from subreddits or search queries.',
        displayNameTemplate: 'r/{subreddit} posts',
        configSchema: {
          type: 'object',
          properties: {
            subreddit: {
              type: 'string',
              description: 'Subreddit name without r/ prefix (e.g., "programming").',
            },
            search_terms: {
              type: 'string',
              description: 'Search terms to query across Reddit.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Number of days to look back for historical data.',
            },
          },
        },
        eventKinds: {
          post: {
            description: 'A Reddit post (self-post or link)',
            metadataSchema: {
              type: 'object',
              properties: {
                subreddit: { type: 'string' },
                score: { type: 'number', description: 'Reddit score (upvotes - downvotes)' },
                num_comments: { type: 'number' },
                upvote_ratio: { type: 'number' },
                is_self: {
                  type: 'boolean',
                  description: 'True for text posts, false for link/media posts',
                },
                domain: {
                  type: 'string',
                  description: 'Content domain (e.g., "i.redd.it", "self.programming")',
                },
                thumbnail: { type: 'string', format: 'uri', description: 'Preview thumbnail URL' },
                media_url: {
                  type: 'string',
                  format: 'uri',
                  description: 'Linked content URL for non-self posts (image, video, article)',
                },
              },
            },
          },
        },
      },
      comments: {
        key: 'comments',
        name: 'Comments',
        sync: (ctx) => this.syncFeed(ctx),
        description: 'Fetch comments from subreddits.',
        displayNameTemplate: 'r/{subreddit} comments',
        configSchema: {
          type: 'object',
          properties: {
            subreddit: {
              type: 'string',
              description: 'Subreddit name without r/ prefix (e.g., "programming").',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Number of days to look back for historical data.',
            },
          },
        },
        eventKinds: {
          comment: {
            description: 'A Reddit comment',
            metadataSchema: {
              type: 'object',
              properties: {
                subreddit: { type: 'string' },
                score: { type: 'number', description: 'Reddit score (upvotes - downvotes)' },
              },
            },
          },
        },
      },
      user_activity: {
        key: 'user_activity',
        name: 'User activity',
        sync: (ctx) => this.syncFeed(ctx),
        description:
          "Fetch a Reddit user's posts and comments interleaved. Defaults to the connected user.",
        displayNameTemplate: 'u/{username} activity',
        configSchema: {
          type: 'object',
          properties: {
            username: {
              type: 'string',
              description:
                "Reddit username without u/ prefix. Leave empty to use the connected account's identity.",
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Number of days to look back for historical activity.',
            },
          },
        },
        eventKinds: {
          post: {
            description: 'A Reddit post authored by the user',
            metadataSchema: {
              type: 'object',
              properties: {
                subreddit: { type: 'string' },
                score: { type: 'number', description: 'Reddit score (upvotes - downvotes)' },
                num_comments: { type: 'number' },
                upvote_ratio: { type: 'number' },
                is_self: { type: 'boolean' },
                domain: { type: 'string' },
              },
            },
          },
          comment: {
            description: 'A Reddit comment authored by the user',
            metadataSchema: {
              type: 'object',
              properties: {
                subreddit: { type: 'string' },
                score: { type: 'number', description: 'Reddit score (upvotes - downvotes)' },
              },
            },
          },
        },
      },
    },
  };

  private readonly MAX_PAGES = 10;
  private readonly RATE_LIMIT_MS = 1000;
  private readonly USER_AGENT = 'Lobu-Connector/1.0.0';

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const subreddit = ctx.config.subreddit as string | undefined;
    const searchTerms = ctx.config.search_terms as string | undefined;
    const isUserFeed = ctx.feedKey === 'user_activity';
    const contentType = isUserFeed ? 'overview' : ctx.feedKey === 'comments' ? 'comment' : 'post';
    const lookbackDays = (ctx.config.lookback_days as number) ?? 365;

    // Resolve access token: user OAuth > app-only OAuth > unauthenticated
    const userAccessToken = ctx.credentials?.accessToken ?? null;
    let accessToken: string | undefined = userAccessToken ?? undefined;
    if (!accessToken) {
      accessToken = await this.getAppOnlyToken(ctx);
    }
    const baseUrl = accessToken ? 'https://oauth.reddit.com' : 'https://www.reddit.com';

    let username: string | undefined;
    if (isUserFeed) {
      if (!userAccessToken) {
        throw new Error(
          'user_activity feed requires user OAuth. Connect Reddit with read+history scopes.'
        );
      }
      username = await this.resolveUsername(ctx, userAccessToken);
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

    const http = createHttpClient({
      token: accessToken,
      headers: { 'User-Agent': this.USER_AGENT },
      errorPrefix: 'Reddit API',
    });

    const events: EventEnvelope[] = [];
    let after: string | null = null;
    let reachedCutoff = false;

    const pages = paginateByCursor<RedditListingResponse['data']['children'][number], string>(
      async (cursor) => {
        const url = this.buildFetchUrl({
          baseUrl,
          subreddit,
          searchTerms,
          username,
          contentType,
          after: cursor,
          isOAuth: !!accessToken,
        });

        let listing: RedditListingResponse;
        try {
          listing = await http.get<RedditListingResponse>(url);
        } catch (error) {
          if (error instanceof HttpStatusError) {
            if (error.status === 404) {
              throw new Error('Subreddit or resource not found. Please check the subreddit name.');
            }
            if (error.status === 403) {
              throw new Error('Access forbidden. The subreddit may be private or banned.');
            }
          }
          throw error;
        }

        const children = listing.data.children;
        if (children.length > 0) after = listing.data.after;
        return { items: children, nextCursor: children.length > 0 ? listing.data.after : null };
      },
      { maxPages: this.MAX_PAGES, delayMs: this.RATE_LIMIT_MS }
    );

    for await (const children of pages) {
      if (children.length === 0) break;

      for (const child of children) {
        const itemData = child.data;
        const itemDate = new Date(itemData.created_utc * 1000);

        if (itemDate < cutoffDate) {
          reachedCutoff = true;
          break;
        }

        // Filter deleted/removed items
        if (itemData.author === '[deleted]') continue;

        // Use actual Reddit API kind (t3=post, t1=comment) instead of config
        const isPost = child.kind === 't3';
        const isComment = child.kind === 't1';

        if (isPost) {
          const post = itemData as RedditPost;
          if (post.crosspost_parent) continue;
          if (post.selftext === '[removed]' || post.selftext === '[deleted]') continue;

          events.push(this.transformPost(post));
        } else if (isComment) {
          const comment = itemData as RedditComment;
          if (!comment.body || comment.body === '[removed]' || comment.body === '[deleted]')
            continue;

          events.push(this.transformComment(comment));
        }
      }

      if (reachedCutoff) break;
    }

    const checkpoint: RedditCheckpoint = {
      last_timestamp: new Date().toISOString(),
      pagination_token: after ?? undefined,
    };

    await ctx.commit(events, checkpoint as Record<string, unknown>);
    return {
      status: 'complete',
      metadata: {
        items_found: events.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // App-only OAuth
  // -------------------------------------------------------------------------

  private appOnlyToken: string | null = null;

  private async getAppOnlyToken(ctx: SyncContext): Promise<string | undefined> {
    if (this.appOnlyToken) return this.appOnlyToken;

    const clientId = (ctx.config as Record<string, unknown>).REDDIT_CLIENT_ID as string | undefined;
    const clientSecret = (ctx.config as Record<string, unknown>).REDDIT_CLIENT_SECRET as
      | string
      | undefined;
    if (!clientId || !clientSecret) return undefined;

    const userAgent =
      ((ctx.config as Record<string, unknown>).REDDIT_USER_AGENT as string) || this.USER_AGENT;
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'User-Agent': userAgent,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      console.error(
        `Reddit app-only auth failed (${response.status}), falling back to unauthenticated`
      );
      return undefined;
    }

    const data = (await response.json()) as { access_token?: string };
    if (data.access_token) {
      this.appOnlyToken = data.access_token;
      return data.access_token;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Username resolution
  // -------------------------------------------------------------------------

  private async resolveUsername(ctx: SyncContext, userAccessToken: string): Promise<string> {
    const configured = (ctx.config.username as string | undefined)?.trim();
    if (configured) return configured.replace(/^u\//, '');

    const response = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        'User-Agent': this.USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to resolve Reddit username via /api/v1/me (${response.status}). ` +
          'Set "username" in feed config or re-authenticate.'
      );
    }
    const data = (await response.json()) as { name?: string };
    if (!data.name) {
      throw new Error('Reddit /api/v1/me returned no username.');
    }
    return data.name;
  }

  // -------------------------------------------------------------------------
  // URL building
  // -------------------------------------------------------------------------

  private buildFetchUrl(params: {
    baseUrl: string;
    subreddit?: string;
    searchTerms?: string;
    username?: string;
    contentType: string;
    after: string | null;
    isOAuth: boolean;
  }): string {
    const { baseUrl, subreddit, searchTerms, username, contentType, after, isOAuth } = params;
    const jsonSuffix = isOAuth ? '' : '.json';
    const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
    const subredditPath = subreddit ? encodeURIComponent(subreddit) : undefined;

    if (contentType === 'overview') {
      if (!username) {
        throw new Error('user_activity feed requires a resolved username.');
      }
      return `${baseUrl}/user/${encodeURIComponent(username)}/overview${jsonSuffix}?limit=100&sort=new${afterParam}`;
    }

    if (contentType === 'comment') {
      // Comments from a subreddit
      if (subredditPath) {
        return `${baseUrl}/r/${subredditPath}/comments${jsonSuffix}?limit=100${afterParam}`;
      }
      // Comments aren't searchable via Reddit search API, fall back to r/all
      return `${baseUrl}/r/all/comments${jsonSuffix}?limit=100${afterParam}`;
    }

    // Posts mode. The sync loop stops at the first item older than the lookback
    // cutoff, so a listing has to come back newest-first: under `sort=relevance`
    // one old-but-relevant hit ends the sync and hides the newer matches behind
    // it. `t=all` because lookback_days allows up to 730.
    if (searchTerms) {
      const query = encodeURIComponent(searchTerms);
      if (subredditPath) {
        return `${baseUrl}/r/${subredditPath}/search${jsonSuffix}?q=${query}&restrict_sr=on&sort=new&t=all&limit=100${afterParam}`;
      }
      return `${baseUrl}/search${jsonSuffix}?q=${query}&sort=new&t=all&limit=100${afterParam}`;
    }

    // Subreddit listing. `/new` is already chronological and takes no time
    // window, so a `t=` here would either be ignored or cap the lookback.
    if (subredditPath) {
      return `${baseUrl}/r/${subredditPath}/new${jsonSuffix}?limit=100${afterParam}`;
    }

    // Fallback to r/all
    return `${baseUrl}/r/all/new${jsonSuffix}?limit=100${afterParam}`;
  }

  // -------------------------------------------------------------------------
  // Transform helpers
  // -------------------------------------------------------------------------

  private transformPost(post: RedditPost): EventEnvelope {
    const engagementScore = calculateEngagementScore('reddit', {
      score: post.score,
      reply_count: post.num_comments,
      upvotes: post.ups,
    });

    // For non-self posts, the Reddit `url` field points to the linked content (image, article, etc.)
    const mediaUrl = !post.is_self ? post.url : undefined;
    const thumbnail =
      post.thumbnail && !['self', 'default', 'nsfw', 'spoiler', ''].includes(post.thumbnail)
        ? post.thumbnail
        : undefined;

    return {
      origin_id: `reddit_post_${post.name}`,
      title: post.title,
      payload_text: (post.selftext ?? '').trim(),
      author_name: post.author,
      source_url: `https://reddit.com${post.permalink}`,
      occurred_at: new Date(post.created_utc * 1000),
      origin_type: 'post',
      score: engagementScore,
      metadata: {
        subreddit: post.subreddit,
        score: post.score,
        num_comments: post.num_comments,
        upvote_ratio: post.upvote_ratio,
        is_self: post.is_self,
        domain: post.domain,
        ...(thumbnail && { thumbnail }),
        ...(mediaUrl && { media_url: mediaUrl }),
      },
    };
  }

  private transformComment(comment: RedditComment): EventEnvelope {
    const engagementScore = calculateEngagementScore('reddit', {
      score: comment.score,
      upvotes: comment.ups,
    });

    let parentExternalId: string | undefined;
    if (comment.parent_id) {
      if (comment.parent_id.startsWith('t1_')) {
        // Parent is another comment
        parentExternalId = `reddit_comment_${comment.parent_id}`;
      } else if (comment.parent_id.startsWith('t3_')) {
        // Parent is a post
        parentExternalId = `reddit_post_${comment.parent_id}`;
      }
    }

    return {
      origin_id: `reddit_comment_${comment.name}`,
      payload_text: comment.body ?? '',
      author_name: comment.author,
      source_url: `https://reddit.com${comment.permalink}`,
      occurred_at: new Date(comment.created_utc * 1000),
      origin_type: 'comment',
      score: engagementScore,
      origin_parent_id: parentExternalId,
      metadata: {
        subreddit: comment.subreddit,
        score: comment.score,
      },
    };
  }

}
