/**
 * Hacker News Connector (user-authored, example-only — org-scoped shadow of the
 * built-in `hackernews` connector).
 *
 * This is the full built-in connector (Algolia feeds: stories, front_page,
 * comments) moved into the personal-agent project and extended with one
 * capability the built-in lacks: `prepare_comment`, which stages a reply draft
 * in the paired Owletto Chrome where the human is signed into HN.
 *
 * Write handoff: `prepare_comment` waits for the user to open the exact HN item
 * (`news.ycombinator.com/item?id=<id>`), then fills that page's comment box
 * (`textarea[name="text"]`). The human clicks "add comment" themselves — Lobu
 * never submits.
 *
 * HN has no public comment API and no OAuth. The story comment box lives on the
 * item page itself (a dedicated `/reply?id=<id>` page only serves replying to an
 * individual COMMENT), and commenting requires an HN login in the paired
 * browser.
 */

import TurndownService from "turndown";
import {
  type ActionContext,
  type ActionResult,
  type ChromeActionDispatcher,
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventEnvelope,
  sleep,
  type SyncContext,
  type SyncResult,
  validatePublicUrl,
} from "@lobu/connector-sdk";

const HN_ORIGINS = ["news.ycombinator.com"];

// ---------------------------------------------------------------------------
// Algolia HN API types (mirrors the built-in connector)
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

const CONTENT_TYPE_TAG: Record<string, string> = {
  story: "story",
  comment: "comment",
  ask_hn: "ask_hn",
  show_hn: "show_hn",
};

// ---------------------------------------------------------------------------
// prepare_comment (browser stage, human submits)
// ---------------------------------------------------------------------------

/** Extract a numeric HN item id from an item URL or bare id. */
export function normalizeHnItemId(raw: string): string | null {
  const value = raw.trim();
  if (/^\d+$/.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "news.ycombinator.com") return null;
  if (parsed.pathname === "/item" || parsed.pathname === "/reply") {
    const id = parsed.searchParams.get("id");
    if (id && /^\d+$/.test(id)) return id;
  }
  return null;
}

/** Fill HN's reply textarea via evaluate — a plain element, not a rich editor. */
function fillReplyTextareaExpression(body: string): string {
  return `(() => {
    const ta = document.querySelector('textarea[name="text"]');
    if (!ta) return { ok: false, reason: 'no textarea[name=text]' };
    ta.value = ${JSON.stringify(body)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: ta.value };
  })()`;
}

function chromeOriginsInput() {
  return { allowed_origins: HN_ORIGINS };
}

function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = ctx.sessionState?.chrome_dispatcher as
    | ChromeActionDispatcher
    | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "HackerNews connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState."
    );
  }
  return handle;
}

function isHnAuthWall(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "news.ycombinator.com") return false;
    return /\/login\b/.test(parsed.pathname);
  } catch {
    return false;
  }
}

interface PrepareHnCommentResult {
  prepared: boolean;
  tab_id: number;
  item_url: string;
  body: string;
  method: "evaluate";
  submitted: false;
  message: string;
}

export async function prepareHnComment(
  dispatcher: ChromeActionDispatcher,
  opts: { itemUrl: string; body: string }
): Promise<PrepareHnCommentResult> {
  const body = opts.body.trim();
  if (!body) throw new Error("prepare_comment: body must be non-empty");
  const itemId = normalizeHnItemId(opts.itemUrl);
  if (!itemId) {
    throw new Error(
      `prepare_comment: invalid item URL / id: ${JSON.stringify(opts.itemUrl)}`
    );
  }
  const itemUrl = `https://news.ycombinator.com/item?id=${itemId}`;

  // Refuse accidental submit clicks through the chrome dispatcher.
  const safeDispatch: ChromeActionDispatcher = {
    dispatch: async (action_key, action_input) => {
      if (action_key === "click_ref") {
        throw new Error(
          "prepare_comment: blocked click_ref — never click on HN (no submit path)"
        );
      }
      return dispatcher.dispatch(action_key, action_input);
    },
  };

  // The story's comment box (textarea[name="text"]) lives on the ITEM page —
  // HN's /reply?id= page is only for replying to a specific COMMENT and comes
  // back empty for a story id. So the item page is the page-activation target:
  // the user opens it (via the notification's browser_url) and activation
  // fires here. We navigate to it exactly once and fill the textarea; no tab
  // is auto-opened and the tab is never moved off the activated page.
  const nav = await safeDispatch.dispatch<{
    tab_id?: number;
    current_url?: string;
  }>("navigate", {
    url: itemUrl,
    require_page_activation: true,
    ...chromeOriginsInput(),
  });
  const tabId = nav.tab_id;
  if (typeof tabId !== "number") {
    throw new Error("prepare_comment: navigate did not return tab_id");
  }
  if (isHnAuthWall(nav.current_url)) {
    throw new Error(
      `Not logged into Hacker News (landed on ${nav.current_url}). Sign in to news.ycombinator.com in the paired Chrome profile, then retry.`
    );
  }

  // Give the form a moment to render.
  try {
    await safeDispatch.dispatch("wait_for_selector", {
      tab_id: tabId,
      selector: 'textarea[name="text"]',
      timeout_ms: 8000,
      ...chromeOriginsInput(),
    });
  } catch {
    // The evaluate fallback below can still catch the textarea.
  }

  // Fill via evaluate — HN's textarea is a plain element.
  const evalOut = await safeDispatch.dispatch<{
    value?: { ok?: boolean; reason?: string; value?: string };
    exception?: string;
  }>("evaluate", {
    tab_id: tabId,
    expression: fillReplyTextareaExpression(body),
    await_promise: true,
    ...chromeOriginsInput(),
  });
  const value = evalOut?.value;
  if (!evalOut?.exception && value?.ok) {
    return {
      prepared: true,
      tab_id: tabId,
      item_url: itemUrl,
      body,
      method: "evaluate",
      submitted: false,
      message:
        "Draft staged in the HN reply form. You choose whether to submit.",
    };
  }

  throw new Error(
    "prepare_comment: could not fill the HN reply form (no textarea[name=text]). Is the user signed in and the item still replyable?"
  );
}

// ---------------------------------------------------------------------------
// Connector (built-in feeds + prepare_comment action)
// ---------------------------------------------------------------------------

export default class HackerNewsConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "hackernews",
    name: "Hacker News",
    description:
      "Searches Hacker News stories and comments via Algolia API; prepare_comment stages a reply draft in the reply form for the human to submit.",
    version: "1.1.0",
    faviconDomain: "news.ycombinator.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      stories: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "stories",
        name: "Stories",
        description: "Search HN for stories, Ask HN, and Show HN posts.",
        configSchema: {
          type: "object",
          required: ["search_query"],
          properties: {
            search_query: {
              type: "string",
              minLength: 1,
              description: "Search term",
            },
            story_type: {
              type: "string",
              enum: ["story", "ask_hn", "show_hn"],
              default: "story",
              description: "Story type filter",
            },
            lookback_days: {
              type: "integer",
              minimum: 1,
              maximum: 730,
              default: 365,
              description: "Lookback window in days",
            },
            search_fields: {
              type: "array",
              items: {
                type: "string",
                enum: ["title", "url", "story_text"],
              },
              default: ["title"],
              description:
                'Algolia fields to search in. Defaults to title only. Add url and/or story_text for broader matching (may increase noise for common words like "notion" or "linear").',
            },
          },
        },
        eventKinds: {
          story: {
            description: "A Hacker News story",
            metadataSchema: {
              type: "object",
              properties: {
                story_type: {
                  type: "string",
                  description: "story, ask_hn, or show_hn",
                },
                tags: { type: "array", items: { type: "string" } },
                external_url: { type: "string", format: "uri" },
                score: { type: "number", description: "HN points" },
                reply_count: { type: "number" },
              },
            },
          },
          ask_hn: {
            description: "An Ask HN post",
            metadataSchema: {
              type: "object",
              properties: {
                story_type: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                score: { type: "number" },
                reply_count: { type: "number" },
              },
            },
          },
          show_hn: {
            description: "A Show HN post",
            metadataSchema: {
              type: "object",
              properties: {
                story_type: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                external_url: { type: "string", format: "uri" },
                score: { type: "number" },
                reply_count: { type: "number" },
              },
            },
          },
        },
      },
      front_page: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "front_page",
        name: "Front Page",
        description:
          "The current Hacker News front page — the live homepage, not a keyword search. No search query.",
        configSchema: {
          type: "object",
          properties: {
            min_score: {
              type: "integer",
              minimum: 0,
              default: 0,
              description:
                "Only include front-page stories with at least this many points.",
            },
          },
        },
        eventKinds: {
          story: {
            description: "A Hacker News front-page story",
            metadataSchema: {
              type: "object",
              properties: {
                story_type: {
                  type: "string",
                  description: "story, ask_hn, or show_hn",
                },
                tags: { type: "array", items: { type: "string" } },
                external_url: { type: "string", format: "uri" },
                score: { type: "number", description: "HN points" },
                reply_count: { type: "number" },
              },
            },
          },
          ask_hn: {
            description: "An Ask HN post on the front page",
            metadataSchema: {
              type: "object",
              properties: {
                story_type: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                score: { type: "number" },
                reply_count: { type: "number" },
              },
            },
          },
          show_hn: {
            description: "A Show HN post on the front page",
            metadataSchema: {
              type: "object",
              properties: {
                story_type: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                external_url: { type: "string", format: "uri" },
                score: { type: "number" },
                reply_count: { type: "number" },
              },
            },
          },
        },
      },
      comments: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "comments",
        name: "Comments",
        description: "Search HN for comments.",
        configSchema: {
          type: "object",
          required: ["search_query"],
          properties: {
            search_query: {
              type: "string",
              minLength: 1,
              description: "Search term",
            },
            lookback_days: {
              type: "integer",
              minimum: 1,
              maximum: 730,
              default: 365,
              description: "Lookback window in days",
            },
            search_fields: {
              type: "array",
              items: {
                type: "string",
                enum: ["comment_text", "author"],
              },
              default: ["comment_text"],
              description:
                "Algolia fields to search in. Defaults to comment_text.",
            },
          },
        },
        eventKinds: {
          comment: {
            description: "A Hacker News comment",
            metadataSchema: {
              type: "object",
              properties: {
                story_id: { type: "number" },
                parent_id: { type: "number" },
                tags: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    actions: {
      prepare_comment: {
        key: "prepare_comment",
        name: "Prepare comment",
        description:
          "Stage a reply draft in the HN reply form for the exact item. NEVER submits — the human must click 'add comment'. Requires the user to visit the item page.",
        requiresApproval: false,
        kind: "write",
        annotations: {
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: false,
        },
        inputSchema: {
          type: "object",
          required: ["body"],
          anyOf: [{ required: ["item_url"] }, { required: ["item_id"] }],
          properties: {
            item_url: {
              type: "string",
              description:
                "HN item URL or numeric id (e.g. https://news.ycombinator.com/item?id=42954035 or 42954035).",
            },
            item_id: {
              type: "string",
              description:
                "Numeric HN item id when item_url is omitted (digits).",
            },
            body: {
              type: "string",
              description:
                "Draft reply text. Left in the reply form for the user to edit/submit.",
              minLength: 1,
              maxLength: 2000,
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            prepared: { type: "boolean" },
            tab_id: { type: "integer" },
            item_url: { type: "string" },
            body: { type: "string" },
            method: { type: "string" },
            submitted: { type: "boolean" },
            message: { type: "string" },
          },
        },
      },
    },
  };

  private readonly BASE_URL = "https://hn.algolia.com/api/v1";
  private readonly ENGAGEMENT_THRESHOLD = 50;
  private readonly CONTENT_FETCH_TIMEOUT = 5000;
  private readonly MAX_PAGES = 50;
  private readonly PAGE_DELAY_MS = 1000;
  private readonly FETCH_DELAY_MS = 2000;
  private readonly SYNC_BUDGET_MS = 4 * 60_000;
  private readonly MAX_CONTENT_FETCHES = 25;
  private readonly MAX_CONSECUTIVE_FETCH_FAILURES = 3;
  private turndownService: TurndownService;

  constructor() {
    super();
    this.turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
  }

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const isFrontPage = ctx.feedKey === "front_page";
    const searchQuery = ctx.config.search_query as string;
    const contentType =
      ctx.feedKey === "comments"
        ? "comment"
        : ((ctx.config.story_type as string) ?? "story");
    const lookbackDays = (ctx.config.lookback_days as number) ?? 365;
    const minScore = (ctx.config.min_score as number) ?? 0;
    const searchFields =
      (ctx.config.search_fields as string[] | undefined) ??
      (contentType === "comment" ? ["comment_text"] : ["title"]);

    const lookbackTimestamp = Math.floor(
      (Date.now() - lookbackDays * 86400000) / 1000
    );
    const tag = isFrontPage
      ? "front_page"
      : (CONTENT_TYPE_TAG[contentType] ?? "story");

    const events: EventEnvelope[] = [];
    let page = 0;
    let hasMore = true;
    const deadline = Date.now() + this.SYNC_BUDGET_MS;

    while (hasMore && page < this.MAX_PAGES && Date.now() < deadline) {
      const url = isFrontPage
        ? `${this.BASE_URL}/search?tags=front_page&hitsPerPage=100&page=${page}` +
          (minScore > 0
            ? `&numericFilters=${encodeURIComponent(`points>=${minScore}`)}`
            : "")
        : `${this.BASE_URL}/search?query=${encodeURIComponent(searchQuery)}` +
          `&tags=${tag}&hitsPerPage=100&page=${page}` +
          "&typoTolerance=false" +
          `&restrictSearchableAttributes=${encodeURIComponent(searchFields.join(","))}` +
          `&numericFilters=${encodeURIComponent(`created_at_i>${lookbackTimestamp}`)}`;

      const response = await fetch(url);

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter
          ? Math.min(60_000, Math.max(1, Number(retryAfter)) * 1000)
          : 5000;
        await sleep(Number.isFinite(waitMs) ? waitMs : 5000);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Algolia API error (${response.status}): ${text}`);
      }

      let data: AlgoliaResponse;
      try {
        data = (await response.json()) as AlgoliaResponse;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Algolia API returned non-JSON response: ${message}`);
      }

      if (!data || !Array.isArray(data.hits)) {
        throw new Error("Algolia API returned an unexpected response shape");
      }

      for (const hit of data.hits) {
        if (contentType === "comment") {
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
    // If the wall-clock budget ran out mid-pagination, the next scheduled run
    // continues (the connector re-queries the window; it is not incremental).

    if (contentType !== "comment") {
      await this.enrichStoriesWithExternalContent(events, deadline);
    }

    await ctx.commit(events, { last_sync_at: new Date().toISOString() });
    return { status: "complete", metadata: { items_found: events.length } };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      if (ctx.actionKey !== "prepare_comment") {
        return { success: false, error: `Unknown action: ${ctx.actionKey}` };
      }
      const body =
        typeof ctx.input.body === "string" ? ctx.input.body.trim() : "";
      if (!body) {
        return { success: false, error: "body is required" };
      }
      const itemRaw =
        (typeof ctx.input.item_url === "string" && ctx.input.item_url.trim()) ||
        (typeof ctx.input.item_id === "string" && ctx.input.item_id.trim()) ||
        "";
      if (!itemRaw) {
        return {
          success: false,
          error: "item_url or item_id is required",
        };
      }
      const dispatcher = requireExtensionDispatcher(ctx);
      const output = await prepareHnComment(dispatcher, {
        itemUrl: itemRaw,
        body,
      });
      return { success: true, output: { ...output } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Transform helpers
  // -------------------------------------------------------------------------

  private transformStory(hit: AlgoliaHit): EventEnvelope {
    const isAskHN = hit._tags.includes("ask_hn");
    const isShowHN = hit._tags.includes("show_hn");

    let storyType = "story";
    let originType = "story";
    if (isAskHN) {
      storyType = "ask_hn";
      originType = "ask_hn";
    } else if (isShowHN) {
      storyType = "show_hn";
      originType = "show_hn";
    }

    const engagementData = {
      score: hit.points ?? 0,
      reply_count: hit.num_comments ?? 0,
    };

    return {
      origin_id: `hn_story_${hit.objectID}`,
      title: hit.title ?? "",
      // Link submissions have no story_text; fall back to the title so the
      // row still carries rankable content for consumers (e.g. the radar).
      payload_text: ((hit.story_text ?? "").trim() || hit.title || "").trim(),
      author_name: hit.author,
      source_url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      occurred_at: new Date(hit.created_at_i * 1000),
      origin_type: originType,
      score: calculateEngagementScore("hackernews", engagementData),
      metadata: {
        type: "story",
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
    if (
      hit.parent_id != null &&
      hit.story_id != null &&
      hit.parent_id !== hit.story_id
    ) {
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
      origin_type: "comment",
      score: calculateEngagementScore("hackernews", { score: 0 }),
      origin_parent_id: parentExternalId,
      metadata: {
        type: "comment",
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
      if (Date.now() >= deadline) break;

      const externalUrl = event.metadata?.external_url as string | undefined;
      const points = event.metadata?.score as number | undefined;

      if (
        !event.metadata?.fetched_content &&
        externalUrl &&
        points != null &&
        points >= this.ENGAGEMENT_THRESHOLD
      ) {
        fetches++;
        const res = await this.fetchExternalContent(externalUrl);
        if (res.ok) {
          consecutiveFailures = 0;
          event.metadata = {
            ...event.metadata,
            fetched_content: true,
            original_url: externalUrl,
            article: res.content,
          };
        } else if (res.network) {
          consecutiveFailures++;
          if (consecutiveFailures >= this.MAX_CONSECUTIVE_FETCH_FAILURES) {
            break;
          }
        } else {
          consecutiveFailures = 0;
        }

        await sleep(this.FETCH_DELAY_MS);
      }
    }
  }

  private async fetchExternalContent(
    url: string
  ): Promise<{ ok: true; content: string } | { ok: false; network: boolean }> {
    try {
      validatePublicUrl(url);
    } catch {
      return { ok: false, network: false };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.CONTENT_FETCH_TIMEOUT
    );
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; HNBot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } catch {
      return { ok: false, network: true };
    } finally {
      clearTimeout(timeoutId);
    }

    try {
      if (!response.ok) return { ok: false, network: false };

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html"))
        return { ok: false, network: false };

      const html = await response.text();

      const stripTags = [
        "script",
        "style",
        "noscript",
        "nav",
        "header",
        "footer",
        "aside",
        "iframe",
        "svg",
        "canvas",
        "video",
        "audio",
        "menu",
        "dialog",
        "embed",
        "object",
      ];
      let cleanHtml = html;
      for (const tag of stripTags) {
        cleanHtml = cleanHtml.replace(
          new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
          ""
        );
      }
      cleanHtml = cleanHtml.replace(/<(link|meta|input)\b[^>]*\/?>/gi, "");

      const markdown = this.turndownService.turndown(cleanHtml);
      const trimmed = markdown.trim().substring(0, 2000);

      return trimmed.length >= 100
        ? { ok: true, content: trimmed }
        : { ok: false, network: false };
    } catch {
      return { ok: false, network: false };
    }
  }
}
