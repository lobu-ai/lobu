/**
 * HackerNews Connector (V1 runtime)
 *
 * Searches Hacker News stories and comments via the Algolia HN Search API.
 * No authentication required.
 */

import TurndownService from 'turndown';
import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventEnvelope,
  sleep,
  type SyncContext,
  type SyncResult,
  validatePublicUrl,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Algolia HN API types
// ---------------------------------------------------------------------------

interface AlgoliaHit {
  objectID: string;
  created_at: string;
  created_at_i: number;
  author: string;
  title?: string;
  story_text?: string;
  comment_text?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  story_id?: number;
  parent_id?: number;
  _tags: string[];
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
}

// ---------------------------------------------------------------------------
// Content-type tag mapping
// ---------------------------------------------------------------------------

const CONTENT_TYPE_TAG: Record<string, string> = {
  story: 'story',
  comment: 'comment',
  ask_hn: 'ask_hn',
  show_hn: 'show_hn',
};

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class HackerNewsConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'hackernews',
    name: 'Hacker News',
    description: 'Searches Hacker News stories and comments via Algolia API.',
    version: '1.0.1',
    faviconDomain: 'news.ycombinator.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      stories: {
        key: 'stories',
        name: 'Stories',
        sync: (ctx) => this.syncFeed(ctx),
        description: 'Search HN for stories, Ask HN, and Show HN posts.',
        configSchema: {
          type: 'object',
          required: ['search_query'],
          properties: {
            search_query: {
              type: 'string',
              minLength: 1,
              description: 'Search term',
            },
            story_type: {
              type: 'string',
              enum: ['story', 'ask_hn', 'show_hn'],
              default: 'story',
              description: 'Story type filter',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Lookback window in days',
            },
            search_fields: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['title', 'url', 'story_text'],
              },
              default: ['title'],
              description:
                'Algolia fields to search in. Defaults to title only. Add url and/or story_text for broader matching (may increase noise for common words like "notion" or "linear").',
            },
          },
        },
        eventKinds: {
          story: {
            description: 'A Hacker News story',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string', description: 'story, ask_hn, or show_hn' },
                tags: { type: 'array', items: { type: 'string' } },
                external_url: { type: 'string', format: 'uri' },
                score: { type: 'number', description: 'HN points' },
                reply_count: { type: 'number' },
              },
            },
          },
          ask_hn: {
            description: 'An Ask HN post',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
          show_hn: {
            description: 'A Show HN post',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                external_url: { type: 'string', format: 'uri' },
                score: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
        },
      },
      front_page: {
        key: 'front_page',
        name: 'Front Page',
        sync: (ctx) => this.syncFeed(ctx),
        description:
          'The current Hacker News front page — the live homepage, not a keyword search. No search query.',
        configSchema: {
          type: 'object',
          properties: {
            min_score: {
              type: 'integer',
              minimum: 0,
              default: 0,
              description: 'Only include front-page stories with at least this many points.',
            },
          },
        },
        eventKinds: {
          story: {
            description: 'A Hacker News front-page story',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string', description: 'story, ask_hn, or show_hn' },
                tags: { type: 'array', items: { type: 'string' } },
                external_url: { type: 'string', format: 'uri' },
                score: { type: 'number', description: 'HN points' },
                reply_count: { type: 'number' },
              },
            },
          },
          ask_hn: {
            description: 'An Ask HN post on the front page',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
          show_hn: {
            description: 'A Show HN post on the front page',
            metadataSchema: {
              type: 'object',
              properties: {
                story_type: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                external_url: { type: 'string', format: 'uri' },
                score: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
        },
      },
      comments: {
        key: 'comments',
        name: 'Comments',
        sync: (ctx) => this.syncFeed(ctx),
        description: 'Search HN for comments.',
        configSchema: {
          type: 'object',
          required: ['search_query'],
          properties: {
            search_query: {
              type: 'string',
              minLength: 1,
              description: 'Search term',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Lookback window in days',
            },
            search_fields: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['comment_text', 'author'],
              },
              default: ['comment_text'],
              description: 'Algolia fields to search in. Defaults to comment_text.',
            },
          },
        },
        eventKinds: {
          comment: {
            description: 'A Hacker News comment',
            metadataSchema: {
              type: 'object',
              properties: {
                story_id: { type: 'number' },
                parent_id: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };

  private readonly BASE_URL = 'https://hn.algolia.com/api/v1';
  private readonly ENGAGEMENT_THRESHOLD = 50;
  private readonly CONTENT_FETCH_TIMEOUT = 5000;
  private readonly MAX_PAGES = 50;
  private readonly PAGE_DELAY_MS = 1000;
  private readonly FETCH_DELAY_MS = 2000;
  // Hard wall-clock budget for a single sync. A broad query (up to 50 pages ×
  // 1s) plus per-article content enrichment (5s timeout each) could otherwise
  // run for many minutes — or effectively never finish on a box with blocked
  // egress where every content fetch times out. On hitting the budget we return
  // what we have; the next scheduled run continues (the window is re-queried,
  // the connector isn't incremental).
  private readonly SYNC_BUDGET_MS = 4 * 60_000;
  // Cap external content enrichment so a large result set can't burn minutes on
  // per-article fetches, and bail once egress is clearly down.
  private readonly MAX_CONTENT_FETCHES = 25;
  private readonly MAX_CONSECUTIVE_FETCH_FAILURES = 3;
  private turndownService: TurndownService;

  constructor() {
    super();
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
  }

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    // Front page is the live HN homepage (Algolia `tags=front_page`): no search
    // query, no lookback — it returns the stories currently ranked on the front
    // page. Everything else is a keyword search over the Algolia archive.
    const isFrontPage = ctx.feedKey === 'front_page';
    const searchQuery = ctx.config.search_query as string;
    const contentType =
      ctx.feedKey === 'comments' ? 'comment' : ((ctx.config.story_type as string) ?? 'story');
    const lookbackDays = (ctx.config.lookback_days as number) ?? 365;
    const minScore = (ctx.config.min_score as number) ?? 0;
    const searchFields =
      (ctx.config.search_fields as string[] | undefined) ??
      (contentType === 'comment' ? ['comment_text'] : ['title']);

    const lookbackTimestamp = Math.floor((Date.now() - lookbackDays * 86400000) / 1000);
    const tag = isFrontPage ? 'front_page' : (CONTENT_TYPE_TAG[contentType] ?? 'story');

    const events: EventEnvelope[] = [];
    let page = 0;
    let hasMore = true;
    const deadline = Date.now() + this.SYNC_BUDGET_MS;

    while (hasMore && page < this.MAX_PAGES && Date.now() < deadline) {
      const url = isFrontPage
        ? `${this.BASE_URL}/search?tags=front_page&hitsPerPage=100&page=${page}` +
          (minScore > 0 ? `&numericFilters=${encodeURIComponent(`points>=${minScore}`)}` : '')
        : `${this.BASE_URL}/search?query=${encodeURIComponent(searchQuery)}` +
          `&tags=${tag}&hitsPerPage=100&page=${page}` +
          '&typoTolerance=false' +
          `&restrictSearchableAttributes=${encodeURIComponent(searchFields.join(','))}` +
          `&numericFilters=${encodeURIComponent(`created_at_i>${lookbackTimestamp}`)}`;

      const response = await fetch(url);

      // Honor Algolia's rate-limit response so we don't hammer them and turn
      // a transient 429 into "Unexpected token < in JSON" when the next call
      // returns an HTML error page.
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? Math.min(60_000, Math.max(1, Number(retryAfter)) * 1000) : 5000;
        await sleep(Number.isFinite(waitMs) ? waitMs : 5000);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Algolia API error (${response.status}): ${text}`);
      }

      // Algolia normally returns JSON, but proxies/captive portals occasionally
      // return HTML. Surface a useful error instead of a bare SyntaxError that
      // makes the connector look broken when the upstream is at fault.
      let data: AlgoliaResponse;
      try {
        data = (await response.json()) as AlgoliaResponse;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Algolia API returned non-JSON response: ${message}`);
      }

      if (!data || !Array.isArray(data.hits)) {
        throw new Error('Algolia API returned an unexpected response shape');
      }

      for (const hit of data.hits) {
        if (contentType === 'comment') {
          const event = this.transformComment(hit);
          if (event) events.push(event);
        } else {
          events.push(this.transformStory(hit));
        }
      }

      hasMore = data.page < data.nbPages - 1 && data.hits.length > 0;
      page++;

      if (hasMore) {
        await sleep(this.PAGE_DELAY_MS);
      }
    }

    // Enrich high-engagement stories with external content (bounded by the
    // remaining time budget + a fetch cap; skipped entirely if it's exhausted).
    if (contentType !== 'comment') {
      await this.enrichStoriesWithExternalContent(events, deadline);
    }

    await ctx.commit(events, { last_sync_at: new Date().toISOString() });
    return { status: 'complete', metadata: { items_found: events.length } };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Transform helpers
  // -------------------------------------------------------------------------

  private transformStory(hit: AlgoliaHit): EventEnvelope {
    const isAskHN = hit._tags.includes('ask_hn');
    const isShowHN = hit._tags.includes('show_hn');

    let storyType = 'story';
    let originType = 'story';
    if (isAskHN) {
      storyType = 'ask_hn';
      originType = 'ask_hn';
    } else if (isShowHN) {
      storyType = 'show_hn';
      originType = 'show_hn';
    }

    const engagementData = {
      score: hit.points ?? 0,
      reply_count: hit.num_comments ?? 0,
    };

    return {
      origin_id: `hn_story_${hit.objectID}`,
      title: hit.title ?? '',
      payload_text: (hit.story_text ?? '').trim(),
      author_name: hit.author,
      source_url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      occurred_at: new Date(hit.created_at_i * 1000),
      origin_type: originType,
      score: calculateEngagementScore('hackernews', engagementData),
      metadata: {
        type: 'story',
        story_type: storyType,
        tags: hit._tags,
        external_url: hit.url,
        created_at_i: hit.created_at_i,
        score: hit.points ?? 0,
        reply_count: hit.num_comments ?? 0,
      },
    };
  }

  private transformComment(hit: AlgoliaHit): EventEnvelope | null {
    let parentExternalId: string | undefined;
    if (hit.parent_id != null && hit.story_id != null && hit.parent_id !== hit.story_id) {
      parentExternalId = `hn_comment_${hit.parent_id}`;
    } else if (hit.story_id != null) {
      parentExternalId = `hn_story_${hit.story_id}`;
    }

    if (!hit.comment_text) return null;

    return {
      origin_id: `hn_comment_${hit.objectID}`,
      payload_text: hit.comment_text,
      author_name: hit.author,
      source_url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      occurred_at: new Date(hit.created_at_i * 1000),
      origin_type: 'comment',
      score: calculateEngagementScore('hackernews', { score: 0 }),
      origin_parent_id: parentExternalId,
      metadata: {
        type: 'comment',
        story_id: hit.story_id,
        parent_id: hit.parent_id,
        created_at_i: hit.created_at_i,
        tags: hit._tags,
      },
    };
  }

  // -------------------------------------------------------------------------
  // External content enrichment
  // -------------------------------------------------------------------------

  private async enrichStoriesWithExternalContent(
    events: EventEnvelope[],
    deadline: number
  ): Promise<void> {
    let fetches = 0;
    let consecutiveFailures = 0;
    for (const event of events) {
      if (fetches >= this.MAX_CONTENT_FETCHES) break;
      if (Date.now() >= deadline) {
        break;
      }

      const externalUrl = event.metadata?.external_url as string | undefined;
      const points = event.metadata?.score as number | undefined;

      if (!event.payload_text && externalUrl && points != null && points >= this.ENGAGEMENT_THRESHOLD) {
        fetches++;
        const res = await this.fetchExternalContent(externalUrl);
        if (res.ok) {
          consecutiveFailures = 0;
          event.payload_text = res.content;
          event.metadata = {
            ...event.metadata,
            fetched_content: true,
            original_url: externalUrl,
          };
        } else if (res.network) {
          // A run of genuine network/timeout failures means egress is
          // blocked/unreachable; stop instead of burning ~5s (the fetch
          // timeout) per remaining story.
          consecutiveFailures++;
          if (consecutiveFailures >= this.MAX_CONSECUTIVE_FETCH_FAILURES) {
            break;
          }
        } else {
          // Non-network skip (non-HTML, non-OK, SSRF-blocked, too short) — the
          // story just has no usable article content. Don't let it trip the
          // egress guard, or a few PDFs/images in a row would halt enrichment.
          consecutiveFailures = 0;
        }

        await sleep(this.FETCH_DELAY_MS);
      }
    }
  }

  // Returns the article markdown on success. On failure, `network` distinguishes
  // a genuine egress failure (timeout/abort/connection — the case that stalls a
  // sync) from a non-network skip (SSRF-blocked, non-OK, non-HTML, too short),
  // so only real egress failures trip the consecutive-failure short-circuit.
  private async fetchExternalContent(
    url: string
  ): Promise<{ ok: true; content: string } | { ok: false; network: boolean }> {
    // SSRF guard — `url` is supplied by whoever submitted the HN story and is
    // therefore attacker-controllable. Refuse private/internal addresses
    // (loopback, 169.254.169.254 cloud metadata, RFC1918, etc.). Not an egress
    // failure.
    try {
      validatePublicUrl(url);
    } catch {
      return { ok: false, network: false };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.CONTENT_FETCH_TIMEOUT);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HNBot/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch {
      // Timeout/abort/DNS/connection refused — a genuine egress failure.
      return { ok: false, network: true };
    } finally {
      clearTimeout(timeoutId);
    }

    try {
      if (!response.ok) return { ok: false, network: false };

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) return { ok: false, network: false };

      const html = await response.text();

      // Strip non-article elements
      const stripTags = [
        'script',
        'style',
        'noscript',
        'nav',
        'header',
        'footer',
        'aside',
        'iframe',
        'svg',
        'canvas',
        'video',
        'audio',
        'menu',
        'dialog',
        'embed',
        'object',
      ];
      let cleanHtml = html;
      for (const tag of stripTags) {
        cleanHtml = cleanHtml.replace(
          new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'),
          ''
        );
      }
      cleanHtml = cleanHtml.replace(/<(link|meta|input)\b[^>]*\/?>/gi, '');

      const markdown = this.turndownService.turndown(cleanHtml);
      const trimmed = markdown.trim().substring(0, 2000);

      return trimmed.length >= 100
        ? { ok: true, content: trimmed }
        : { ok: false, network: false };
    } catch {
      // A body-read/parse error after a successful response isn't an egress
      // outage — treat as a skip, not a network failure.
      return { ok: false, network: false };
    }
  }
}
