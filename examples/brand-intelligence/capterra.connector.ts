/**
 * Capterra Connector
 *
 * Reads software reviews through the paired Owletto Chrome extension.
 *
 * Capterra fronts its review pages with bot protection, and connector code runs
 * in a V8 isolate with no browser in it. `extensionDomScrape` reads the DOM in
 * the user's own Chrome through a content script, driven by the same selectors
 * the previous in-page extract used.
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
} from "@lobu/connector-sdk";

const CAPTERRA_ALLOWED_ORIGINS = ["capterra.com", "*.capterra.com"];

const REVIEW_SCRAPE_CONFIG = {
  scroll: { max: 6, stall: 3, waitMs: 1200, deep: true },
  rowSelector: '[data-test="review-card"], .review-card',
  requireFields: ["text"],
  fields: {
    id: { take: "attr", attr: "data-review-id" },
    // Capterra renders the score as stars; the number lives in the aria-label.
    ratingLabel: {
      selector: '[data-test="rating"], .rating, [aria-label*="star"]',
      take: "attr",
      attr: "aria-label",
    },
    title: {
      selector: '[data-test="review-title"], .review-title, h3, h4',
      take: "text",
      firstLine: true,
    },
    text: {
      selector:
        '[data-test="review-body"], .review-body, .review-content, .review-text',
      take: "text",
    },
    dateAttr: {
      selector: '[data-test="review-date"], .review-date, time',
      take: "attr",
      attr: "datetime",
    },
    dateText: {
      selector: '[data-test="review-date"], .review-date, time',
      take: "text",
      firstLine: true,
    },
    author: {
      selector: '[data-test="reviewer-name"], .reviewer-name, .author',
      take: "text",
      firstLine: true,
    },
    helpful: {
      selector: '[data-test="helpful-count"], .helpful-count',
      take: "text",
      firstLine: true,
    },
  },
} as const;

/** One scraped row: every field is a string or absent. */
interface CapterraRow {
  id?: string;
  ratingLabel?: string;
  title?: string;
  text?: string;
  dateAttr?: string;
  dateText?: string;
  author?: string;
  helpful?: string;
}

/**
 * Capterra dates are frequently relative ("2 weeks ago"). Absolute first, then
 * the relative forms the page uses, then now.
 */
function parseReviewDate(dateAttr?: string, dateText?: string): Date {
  const absolute = dateAttr ? new Date(dateAttr) : null;
  if (absolute && !Number.isNaN(absolute.getTime())) return absolute;

  const text = (dateText ?? "").trim();
  if (!text) return new Date();
  const relative: [RegExp, number][] = [
    [/(\d+)\s+days?\s+ago/i, 24 * 60 * 60 * 1000],
    [/(\d+)\s+weeks?\s+ago/i, 7 * 24 * 60 * 60 * 1000],
    [/(\d+)\s+months?\s+ago/i, 30 * 24 * 60 * 60 * 1000],
  ];
  for (const [pattern, unitMs] of relative) {
    const match = text.match(pattern);
    if (match)
      return new Date(Date.now() - Number.parseInt(match[1], 10) * unitMs);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeReview(row: CapterraRow, index: number): CapterraReview {
  const date = parseReviewDate(row.dateAttr, row.dateText);
  const ratingMatch = (row.ratingLabel ?? "").match(/(\d+(?:\.\d+)?)/);
  return {
    id:
      row.id || `${date.toISOString()}_${index}`.replace(/[^a-zA-Z0-9]/g, "_"),
    rating: ratingMatch ? Number.parseFloat(ratingMatch[1]) : 0,
    title: row.title?.trim() ?? "",
    text: row.text?.trim() ?? "",
    date: date.toISOString(),
    author: row.author?.trim() || "Anonymous",
    helpfulCount:
      Number.parseInt((row.helpful ?? "").replace(/\D/g, ""), 10) || 0,
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
      "Capterra connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — run on a connector-worker with the dispatcher bridge and an online extension."
    );
  }
  return handle;
}

interface CapterraReview {
  id: string;
  rating: number;
  title: string;
  text: string;
  date: string;
  author: string;
  helpfulCount: number;
}

export default class CapterraConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "capterra",
    name: "Capterra",
    version: "2.0.0",
    faviconDomain: "capterra.com",
    description:
      "Reads software reviews from Capterra through the paired Chrome extension.",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      reviews: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "reviews",
        name: "Reviews",
        description: "Capterra software reviews",
        configSchema: {
          type: "object",
          required: ["product_id"],
          properties: {
            product_id: {
              type: "string",
              description: 'Capterra product ID (e.g., "12345")',
              minLength: 1,
            },
            product_name: {
              type: "string",
              description:
                'Product name slug for URL (e.g., "spotify"). Optional - Capterra will redirect without it.',
              minLength: 1,
            },
            vendor_name: {
              type: "string",
              description:
                'Vendor/company name (e.g., "Spotify AB"). Optional but recommended for disambiguation.',
              minLength: 1,
            },
            lookback_days: {
              type: "integer",
              description:
                "Number of days to look back for historical data. Default: 365 (1 year). Maximum: 730 (2 years).",
              minimum: 1,
              maximum: 730,
              default: 365,
            },
          },
        },
        eventKinds: {
          review: {
            description: "A Capterra software review",
            metadataSchema: {
              type: "object",
              properties: {
                rating: { type: "number", description: "Star rating (0-5)" },
                helpful_count: {
                  type: "number",
                  description: "Number of helpful votes",
                },
              },
            },
          },
        },
      },
    },
  };

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const productId = ctx.config.product_id as string;
    const productName = ctx.config.product_name as string | undefined;

    const baseUrl = productName
      ? `https://www.capterra.com/p/${productId}/${productName}/reviews`
      : `https://www.capterra.com/p/${productId}/reviews`;

    const dispatcher = requireExtensionDispatcher(ctx);
    const { items: rows } = await extensionDomScrape<CapterraRow>({
      dispatcher,
      url: baseUrl,
      config: REVIEW_SCRAPE_CONFIG,
      parseRows: (raw) => raw as CapterraRow[],
      allowedOrigins: CAPTERRA_ALLOWED_ORIGINS,
    });

    const reviews = rows
      .map((row, index) => normalizeReview(row, index))
      .filter((review) => review.text.length > 0);

    const events: EventEnvelope[] = reviews.map((review) => {
      const engagementData = {
        rating: review.rating,
        helpful_count: review.helpfulCount,
      };

      return {
        origin_id: review.id,
        title: review.title,
        payload_text: review.text,
        author_name: review.author,
        occurred_at: new Date(review.date),
        origin_type: "review",
        score: calculateEngagementScore("capterra", engagementData),
        source_url: baseUrl,
        metadata: engagementData,
      };
    });

    return {
      events,
      checkpoint: ctx.checkpoint,
      metadata: {
        items_found: events.length,
        items_skipped: rows.length - reviews.length,
      },
    };
  }
}
