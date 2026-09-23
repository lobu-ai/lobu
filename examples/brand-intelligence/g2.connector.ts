/**
 * G2 Connector (V1 runtime)
 *
 * Reads B2B software reviews through the paired Owletto Chrome extension.
 *
 * Connector code runs in a V8 isolate with no browser in it, and G2 fronts its
 * review pages with bot protection. `extensionDomScrape` reads the DOM in the
 * user's own Chrome through a content script, driven by the same schema.org
 * `itemprop` hooks the previous in-page extract used. Pagination stays in the
 * connector: one dispatch per `?page=N`, stopping at the first empty page.
 */

import {
  type RuntimeConnectorDefinition,
  type ChromeActionDispatcher,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventEnvelope,
  extensionDomScrape,
  type SyncContext,
  type SyncResult,
  sleep,
} from "@lobu/connector-sdk";

const G2_ALLOWED_ORIGINS = ["g2.com", "*.g2.com"];

const REVIEW_SCRAPE_CONFIG = {
  scroll: { max: 4, stall: 3, waitMs: 1200, deep: true },
  rowSelector: '[itemprop="review"]',
  requireFields: ["text"],
  fields: {
    // schema.org values live in `content` attributes, not element text.
    author: {
      selector: '[itemprop="author"] meta[itemprop="name"]',
      take: "attr",
      attr: "content",
    },
    date: {
      selector: 'meta[itemprop="datePublished"]',
      take: "attr",
      attr: "content",
    },
    rating: {
      selector: '[itemprop="ratingValue"]',
      take: "attr",
      attr: "content",
    },
    title: {
      selector: '[itemprop="name"] .elv-font-bold',
      take: "text",
      firstLine: true,
    },
    text: { selector: '[itemprop="reviewBody"]', take: "text" },
    reviewUrl: {
      selector: 'a[href*="survey_responses"]',
      take: "attr",
      attr: "href",
    },
    // The reviewer's job title, industry and company size are three untagged
    // `.elv-text-subtle` divs in document order with nothing to tell them
    // apart. The in-page extract read them positionally off the author block's
    // parent; `objectAll` collects them across the whole card instead, and the
    // same positional heuristic is applied below where it can be read.
    details: {
      selector: ".elv-text-subtle",
      take: "objectAll",
      parts: { text: { take: "text" } },
    },
    badges: {
      selector: '[class*="badge"], [class*="tag"], .elv-rounded-sm.elv-border',
      take: "objectAll",
      parts: { text: { take: "text" } },
    },
  },
} as const;

/** One scraped row: strings and `objectAll` part lists, or absent. */
interface G2Row {
  author?: string;
  date?: string;
  rating?: string;
  title?: string;
  text?: string;
  reviewUrl?: string;
  details?: Array<{ text?: string }>;
  badges?: Array<{ text?: string }>;
}

function partTexts(parts: Array<{ text?: string }> | undefined): string[] {
  return (parts ?? [])
    .map((part) => part.text?.trim() ?? "")
    .filter((text) => text.length > 0);
}

function normalizeReview(row: G2Row): G2Review {
  const details = partTexts(row.details);
  // Three details: job title, industry, company size. Two: job title and
  // company size. One: company size. Same shape the in-page extract assumed.
  const [jobTitle, industry, companySize] =
    details.length >= 3
      ? [details[0], details[1], details[2]]
      : details.length === 2
        ? [details[0], "", details[1]]
        : [".", "", details[0] ?? ""];
  const href = row.reviewUrl ?? "";
  return {
    rating: Number.parseFloat(row.rating ?? "0") || 0,
    title: (row.title ?? "").trim().replace(/^"|"$/g, ""),
    text: (row.text ?? "").trim(),
    author: row.author?.trim() || "Anonymous",
    jobTitle: jobTitle === "." ? "" : jobTitle,
    industry,
    companySize,
    date: row.date?.trim() ?? "",
    badges: partTexts(row.badges)
      .filter((text) => text.length > 3 && text.length < 50)
      .slice(0, 10),
    reviewUrl: href
      ? href.startsWith("http")
        ? href
        : `https://www.g2.com${href}`
      : "",
    helpfulCount: 0,
  };
}

/**
 * Pull the chrome action dispatcher off the sync context. The connector-worker
 * splices a live `chrome_dispatcher` onto `sessionState`; with no online paired
 * Owletto extension in the connection's org there is nothing to splice.
 */
function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = ctx.sessionState?.chrome_dispatcher as
    | ChromeActionDispatcher
    | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "G2 connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — run on a connector-worker with the dispatcher bridge and an online extension."
    );
  }
  return handle;
}

interface G2Review {
  rating: number;
  title: string;
  text: string;
  author: string;
  jobTitle: string;
  industry: string;
  companySize: string;
  date: string;
  badges: string[];
  reviewUrl: string;
  helpfulCount: number;
}

const configSchema = {
  type: "object",
  required: ["product_url"],
  properties: {
    product_url: {
      type: "string",
      description:
        "Full G2 product review URL e.g. https://www.g2.com/products/confluence/reviews",
    },
    lookback_days: {
      type: "integer",
      minimum: 1,
      maximum: 730,
      default: 365,
      description: "Number of days to look back for reviews (default 365)",
    },
  },
};

export default class G2Connector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "g2",
    name: "G2",
    description:
      "Reads B2B software reviews from G2.com through the paired Chrome extension.",
    version: "2.1.0",
    faviconDomain: "g2.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      reviews: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "reviews",
        name: "Product Reviews",
        description: "Scrape reviews for a G2 product listing.",
        configSchema,
        eventKinds: {
          review: {
            description: "A G2 B2B software review",
            metadataSchema: {
              type: "object",
              properties: {
                rating: { type: "number", description: "Star rating (0-5)" },
                helpful_count: { type: "number" },
                job_title: {
                  type: "string",
                  description: "Reviewer job title",
                },
                industry: { type: "string", description: "Reviewer industry" },
                company_size: {
                  type: "string",
                  description: "Reviewer company size",
                },
                badges: {
                  type: "array",
                  items: { type: "string" },
                  description: "Review badges",
                },
              },
            },
          },
        },
      },
    },
  };

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const productUrl = ctx.config.product_url as string;

    if (
      !productUrl?.match(/^https:\/\/www\.g2\.com\/products\/[^/]+\/reviews/)
    ) {
      return {
        status: "complete",
        metadata: { items_found: 0, error: "Invalid product_url" },
      };
    }

    // Extract product key from URL for origin_id generation
    const productMatch = productUrl.match(/\/products\/([^/]+)/);
    const productKey = productMatch ? productMatch[1] : "unknown";

    const baseUrl = productUrl;
    const reviewCardSelector = '[itemprop="review"]';

    const dispatcher = requireExtensionDispatcher(ctx);
    const allEvents: EventEnvelope[] = [];
    const maxPages = 5;
    let pagesCrawled = 0;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const pageUrl = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;
      const { items: rows } = await extensionDomScrape<G2Row>({
        dispatcher,
        url: pageUrl,
        config: REVIEW_SCRAPE_CONFIG,
        parseRows: (raw) => raw as G2Row[],
        allowedOrigins: G2_ALLOWED_ORIGINS,
      });
      pagesCrawled++;

      // Reviews with real content; the in-page extract used the same floor.
      const reviews = rows
        .map((row) => normalizeReview(row))
        .filter((review) => review.text.length >= 50);

      for (const review of reviews) {
        allEvents.push({
          origin_id: `g2-${productKey}-${review.date || "nodate"}-${review.author.replace(/\s+/g, "-")}`,
          title: review.title,
          payload_text: review.text,
          author_name: review.author,
          occurred_at: review.date ? new Date(review.date) : new Date(),
          origin_type: "review",
          score: calculateEngagementScore("g2", {
            rating: review.rating,
            helpful_count: 0,
          }),
          source_url: review.reviewUrl || baseUrl,
          metadata: {
            rating: review.rating,
            helpful_count: review.helpfulCount,
            job_title: review.jobTitle,
            industry: review.industry,
            company_size: review.companySize,
            badges: review.badges,
          },
        });
      }

      // An empty page is the end of the list.
      if (reviews.length === 0) break;

      // Rate limit between pages.
      if (pageNum < maxPages) await sleep(6000);
    }

    await ctx.commit(allEvents, {
      ...(ctx.checkpoint ?? {}),
      pages_crawled: pagesCrawled,
    });
    return { status: "complete", metadata: { items_found: allEvents.length } };
  }
}
