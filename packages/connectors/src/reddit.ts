/**
 * Reddit Connector (V1 runtime)
 *
 * Fetches posts and comments from Reddit subreddits or search queries, the
 * connected user's home feed, and inbox notification references. Supports
 * both authenticated (OAuth) and unauthenticated (public JSON API) modes.
 */

import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  createHttpClient,
  type EventEnvelope,
  type FeedReadContext,
  type FeedReadResult,
  HttpStatusError,
  paginateByCursor,
  sleep,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';
import addFormats from 'ajv-formats';

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
  pagination_cutoff?: string;
  inbox_head?: string | null;
}

interface RedditInboxItem {
  kind: string;
  data: {
    name: string;
    author?: string | null;
    subject?: string;
    body?: string;
    context?: string;
    created_utc: number;
    new?: boolean;
  };
}

interface RedditInboxListing {
  data: { children: RedditInboxItem[]; after: string | null };
}

function inboxUrl(item: RedditInboxItem): string {
  const fallback = `https://www.reddit.com/message/messages/${encodeURIComponent(item.data.name.slice(3))}`;
  if (!item.data.context) return fallback;
  try {
    const url = new URL(item.data.context, 'https://www.reddit.com');
    return url.origin === 'https://www.reddit.com' ? url.href : fallback;
  } catch {
    return fallback;
  }
}

// Use the gateway's URI format check: WHATWG URL parsing also accepts non-URI characters.
const isUri = addFormats.get('uri') as (value: string) => boolean;

/** Metadata declares these fields `format: uri`; one bad value rejects the whole batch. */
function httpUrl(value: string | undefined): string | undefined {
  if (!value || !isUri(value) || !URL.canParse(value)) return undefined;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class RedditConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'reddit',
    name: 'Reddit',
    description:
      "Fetches posts and comments from Reddit subreddits or search queries, the connected user's home feed, and inbox notification references.",
    version: '1.3.0',
    faviconDomain: 'reddit.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'reddit',
          requiredScopes: ['identity', 'read', 'history'],
          // Explicit reconnect requests for new scopes use method optionalScopes.
          optionalScopes: ['privatemessages'],
          loginScopes: ['identity'],
          setupInstructions:
            'Create a Reddit app at https://www.reddit.com/prefs/apps — choose "web app" as the type. Set the redirect URI to {{redirect_uri}}, then copy the client ID and secret below.',
        },
        {
          type: 'none',
        },
      ],
    },
    feeds: {
      inbox: {
        key: 'inbox',
        name: 'Inbox notifications',
        description:
          'Capture metadata-only references to the OAuth inbox (comment/post replies, mentions and legacy private messages exposed by Reddit). Read original bodies explicitly from the source. Does not mark messages read. Chat, reactions and the modern notification bell are not covered by this API.',
        requiredScopes: ['privatemessages'],
        sync: (ctx) => this.syncInbox(ctx),
        read: (ctx) => this.readInbox(ctx),
        eventKinds: {
          inbox_notification: {
            description: 'A source reference to an item in the Reddit OAuth inbox',
            metadataSchema: {
              type: 'object',
              properties: {
                source_id: { type: 'string' },
                source_kind: { type: 'string' },
                category: { type: 'string' },
              },
              required: ['source_id', 'source_kind', 'category'],
            },
          },
        },
      },
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
      home_feed: {
        key: 'home_feed',
        name: 'Home feed',
        sync: (ctx) => this.syncFeed(ctx),
        description:
          "Fetch the connected user's personalized home feed (Best). Requires user OAuth.",
        displayNameTemplate: 'Reddit home feed',
        configSchema: {
          type: 'object',
          properties: {
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 30,
              default: 7,
              description: 'Skip home feed posts older than this many days.',
            },
          },
        },
        eventKinds: {
          post: {
            description: "A Reddit post from the connected user's home feed",
            metadataSchema: {
              type: 'object',
              properties: {
                subreddit: { type: 'string' },
                score: { type: 'number', description: 'Reddit score (upvotes - downvotes)' },
                num_comments: { type: 'number' },
                upvote_ratio: { type: 'number' },
                is_self: { type: 'boolean' },
                domain: { type: 'string' },
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
    },
  };

  private readonly MAX_PAGES = 10;
  private readonly RATE_LIMIT_MS = 1000;
  private readonly USER_AGENT = 'Lobu-Connector/1.0.0';

  private async inboxPage(
    ctx: Pick<FeedReadContext, 'credentials'>,
    after?: string,
    limit = 100,
  ): Promise<RedditInboxListing['data']> {
    const token = ctx.credentials?.accessToken;
    if (!token) throw new Error('Reddit inbox requires user OAuth with the privatemessages scope.');
    const params = new URLSearchParams({ limit: String(limit), mark: 'false', raw_json: '1' });
    if (after) params.set('after', after);
    const http = createHttpClient({ token, headers: { 'User-Agent': this.USER_AGENT }, errorPrefix: 'Reddit inbox' });
    const response = await http.get<RedditInboxListing>(`https://oauth.reddit.com/message/inbox?${params}`);
    // An access/error page must not be mistaken for an exhausted inbox.
    if (!response.data || !Array.isArray(response.data.children)
      || !(response.data.after === null || typeof response.data.after === 'string')) {
      throw new Error('Reddit returned an invalid inbox listing.');
    }
    for (const item of response.data.children) {
      if (!item.data || !/^t[14]_[A-Za-z0-9]+$/.test(item.data.name)
        || !item.data.name.startsWith(`${item.kind}_`)
        || !Number.isFinite(item.data.created_utc)) {
        throw new Error('Reddit returned an invalid inbox item identity or date.');
      }
    }
    return response.data;
  }

  private async readInbox(ctx: FeedReadContext): Promise<FeedReadResult> {
    if (ctx.window || ctx.query || ctx.match || (ctx.offset ?? 0) > 0 || ctx.sort) {
      throw new Error('Reddit inbox reads support cursor pagination only; query, window, match, offset and sort are unsupported.');
    }
    const page = await this.inboxPage(ctx, ctx.cursor, Math.max(1, Math.min(100, Math.trunc(ctx.limit ?? 25))));
    if (page.after && page.after === ctx.cursor) throw new Error('Reddit inbox cursor did not advance.');
    return {
      rows: page.children.map(item => ({
        id: item.data.name, kind: item.kind, subject: item.data.subject ?? null,
        body: item.data.body ?? null, author: item.data.author ?? null,
        occurred_at: new Date(item.data.created_utc * 1000).toISOString(),
        unread: item.data.new ?? null, url: inboxUrl(item),
      })),
      nextCursor: page.after ?? undefined,
    };
  }

  private async syncInbox(ctx: SyncContext): Promise<SyncResult> {
    const saved = (ctx.checkpoint?.pagination_token as string | undefined) ?? undefined;
    const previousHead = ctx.checkpoint?.inbox_head;
    let head: string | undefined;
    let catchingUp = !!saved;
    const seenCursors = new Set<string>();
    const seenItems = new Set<string>();
    const events: EventEnvelope[] = [];
    let after: string | undefined;
    let exhausted = false;
    // Old checkpoints have no evidence that the refreshed head meets the tail.
    // Rewalk from the head instead of skipping an unobserved arrival interval.
    let cursorReset = !!saved && !previousHead;
    for (let page = 0; page < this.MAX_PAGES; page++) {
      if (page) await sleep(this.RATE_LIMIT_MS);
      if (after) seenCursors.add(after);
      let listing: RedditInboxListing['data'];
      try {
        listing = await this.inboxPage(ctx, after);
      } catch (error) {
        // A deleted saved anchor must not wedge capture indefinitely. Rewalk
        // the retained inbox once; auth, permission and quota failures propagate.
        if (!cursorReset && after && after === saved && error instanceof HttpStatusError
          && [400, 404].includes(error.status)) {
          cursorReset = true;
          after = undefined;
          seenCursors.clear();
          continue;
        }
        throw error;
      }
      head ??= listing.children[0]?.data.name;
      for (const item of listing.children) {
        if (seenItems.has(item.data.name)) continue;
        seenItems.add(item.data.name);
        const category = item.kind === 't4' ? 'private_message' : 'comment_notification';
        events.push({
          origin_id: `reddit_inbox_${item.data.name}`, origin_type: 'inbox_notification',
          payload_text: '',
          title: item.kind === 't4' ? 'Reddit private message' : 'Reddit comment notification',
          source_url: inboxUrl(item), occurred_at: new Date(item.data.created_utc * 1000),
          metadata: { source_id: item.data.name, source_kind: item.kind, category },
        });
      }
      after = listing.after ?? undefined;
      // Re-read every arrival page through the prior head before resuming the
      // unfinished history sweep. A deleted/missing boundary falls back to a
      // bounded full sweep; occurrence time cannot safely exclude older items.
      if (catchingUp && listing.children.some(item => item.data.name === previousHead)) {
        catchingUp = false;
        if (after && saved) after = saved;
      }
      if (!after) {
        exhausted = true;
        break;
      }
      if (seenCursors.has(after)) throw new Error('Reddit inbox cursor did not advance.');
    }
    await ctx.commit(events, { pagination_token: after ?? null, inbox_head: head ?? null });
    // A reset on the final request leaves no cursor but still needs a new sweep.
    return { status: exhausted ? 'complete' : 'more', metadata: {
      items_found: events.length,
      ...(cursorReset ? { cursor_reset: true } : {}),
    } };
  }

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const subreddit = ctx.config.subreddit as string | undefined;
    const searchTerms = ctx.config.search_terms as string | undefined;
    const isUserFeed = ctx.feedKey === 'user_activity';
    // Best is ranked, not chronological: old posts interleave with new ones and
    // a saved `after` anchor is meaningless once the ranking moves.
    const isHomeFeed = ctx.feedKey === 'home_feed';
    const contentType = isUserFeed
      ? 'overview'
      : isHomeFeed
        ? 'home'
        : ctx.feedKey === 'comments'
          ? 'comment'
          : 'post';
    const lookbackDays = (ctx.config.lookback_days as number) ?? (isHomeFeed ? 7 : 365);

    // Resolve access token: user OAuth > app-only OAuth > unauthenticated
    const userAccessToken = ctx.credentials?.accessToken ?? null;
    let username: string | undefined;
    if (isUserFeed) {
      if (!userAccessToken) {
        throw new Error(
          'user_activity feed requires user OAuth. Connect Reddit with read+history scopes.'
        );
      }
      username = await this.resolveUsername(ctx, userAccessToken);
    }
    if (isHomeFeed && !userAccessToken) {
      throw new Error('home_feed requires user OAuth. Connect Reddit with the read scope.');
    }

    let accessToken: string | undefined = userAccessToken ?? undefined;
    if (!accessToken) {
      accessToken = await this.getAppOnlyToken(ctx);
    }
    const baseUrl = accessToken ? 'https://oauth.reddit.com' : 'https://www.reddit.com';

    const previous = (ctx.checkpoint ?? {}) as RedditCheckpoint;
    const resumeAfter = isHomeFeed ? null : (previous.pagination_token ?? null);
    let cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
    // Keep items eligible for the whole bounded sweep, even across sync runs.
    if (resumeAfter && previous.pagination_cutoff) {
      const savedCutoff = new Date(previous.pagination_cutoff);
      if (Number.isFinite(savedCutoff.getTime())) cutoffDate = savedCutoff;
    }

    const http = createHttpClient({
      token: accessToken,
      headers: { 'User-Agent': this.USER_AGENT },
      errorPrefix: 'Reddit API',
    });

    const events: EventEnvelope[] = [];
    const seenItems = new Set<string>();
    const seenCursors = new Set<string>();
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
            // A saved fullname can disappear from a changing listing. The head
            // was fetched successfully; clear the rejected anchor for next run.
            if (cursor === resumeAfter && cursor && [400, 404].includes(error.status)) {
              after = null;
              return { items: [], nextCursor: null };
            }
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
        if (cursor) seenCursors.add(cursor);
        after = children.length > 0 ? listing.data.after : null;
        // Reject loops (including a provider ignoring `after` and replaying the
        // head). End the sweep so the next run can start with a fresh listing.
        if (after && seenCursors.has(after)) after = null;
        if (cursor === null && after) {
          seenCursors.add(after);
          // Spend one page on fresh arrivals, then resume the unfinished sweep.
          // Arrivals beyond this page are caught by the next full sweep: never
          // use last_timestamp as a high-water mark on these mutable listings.
          after = resumeAfter ?? after;
        }
        return { items: children, nextCursor: after };
      },
      { maxPages: this.MAX_PAGES, delayMs: this.RATE_LIMIT_MS }
    );

    for await (const children of pages) {
      if (children.length === 0) break;

      for (const child of children) {
        const itemData = child.data;
        const itemDate = new Date(itemData.created_utc * 1000);

        if (itemDate < cutoffDate) {
          if (isHomeFeed) continue;
          reachedCutoff = true;
          break;
        }

        // Filter deleted/removed items
        if (itemData.author === '[deleted]') continue;
        if (seenItems.has(itemData.name)) continue;
        seenItems.add(itemData.name);

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
      pagination_token: !reachedCutoff && !isHomeFeed ? (after ?? undefined) : undefined,
      pagination_cutoff:
        !reachedCutoff && !isHomeFeed && after ? cutoffDate.toISOString() : undefined,
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

    if (contentType === 'home') {
      return `${baseUrl}/best${jsonSuffix}?limit=100${afterParam}`;
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
    const mediaUrl = !post.is_self ? httpUrl(post.url) : undefined;
    // `thumbnail` also carries placeholder words ("self", "image", "nsfw", ...).
    const thumbnail = httpUrl(post.thumbnail);

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
