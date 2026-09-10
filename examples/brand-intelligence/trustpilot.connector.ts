/**
 * Trustpilot Connector (V1 runtime)
 *
 * Reads business reviews through the paired Owletto Chrome extension.
 *
 * Connector code runs in a V8 isolate with no browser in it, and Trustpilot
 * fronts its review pages with bot protection. `extensionDomScrape` reads the
 * DOM in the user's own Chrome through a content script, driven by the same
 * `data-service-review-*` hooks the previous in-page extract used.
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

const TRUSTPILOT_ALLOWED_ORIGINS = ["trustpilot.com", "*.trustpilot.com"];

const REVIEW_SCRAPE_CONFIG = {
  scroll: { max: 6, stall: 3, waitMs: 1200, deep: true },
  rowSelector: "[data-service-review-card-paper]",
  requireFields: ["text"],
  fields: {
    // The score is the attribute's own value, not the element's text.
    rating: {
      selector: "[data-service-review-rating]",
      take: "attr",
      attr: "data-service-review-rating",
    },
    title: {
      selector: "[data-service-review-title-typography]",
      take: "text",
      firstLine: true,
    },
    text: { selector: "[data-service-review-text-typography]", take: "text" },
    date: { selector: "time", take: "attr", attr: "datetime" },
    author: {
      selector: "[data-consumer-name-typography]",
      take: "text",
      firstLine: true,
    },
  },
} as const;

/** One scraped row: every field is a string or absent. */
interface TrustpilotRow {
  rating?: string;
  title?: string;
  text?: string;
  date?: string;
  author?: string;
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
      "Trustpilot connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — run on a connector-worker with the dispatcher bridge and an online extension."
    );
  }
  return handle;
}

interface TrustpilotReview {
  rating: number;
  title: string;
  text: string;
  date: string;
  author: string;
}

const configSchema = {
  type: "object",
  properties: {
    business_url: {
      type: "string",
      format: "uri",
      description:
        'Full Trustpilot review URL (e.g., "https://www.trustpilot.com/review/spotify.com")',
    },
    business_name: {
      type: "string",
      minLength: 1,
      description: "Business name for search-based lookup",
    },
    lookback_days: {
      type: "integer",
      minimum: 1,
      maximum: 730,
      default: 365,
      description:
        "Number of days to look back for historical data. Default: 365 (1 year). Maximum: 730 (2 years).",
    },
  },
};

export default class TrustpilotConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "trustpilot",
    name: "Trustpilot",
    description:
      "Reads business reviews from Trustpilot through the paired Chrome extension.",
    version: "2.0.0",
    faviconDomain: "trustpilot.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      reviews: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "reviews",
        name: "Business Reviews",
        description: "Scrape reviews for a business on Trustpilot.",
        configSchema,
        eventKinds: {
          review: {
            description: "A Trustpilot business review",
            metadataSchema: {
              type: "object",
              properties: {
                rating: { type: "number", description: "Star rating (1-5)" },
                helpful_count: { type: "number" },
                title: { type: "string", description: "Review headline" },
              },
            },
          },
        },
      },
    },
  };

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const businessUrl = ctx.config.business_url as string | undefined;
    const businessName = ctx.config.business_name as string | undefined;

    if (!businessUrl && !businessName) {
      throw new Error("Either business_url or business_name is required");
    }

    // encodeURIComponent the user-supplied businessName so a value like
    // "../search?foo=bar" can't escape the /review/ path on trustpilot.com.
    const baseUrl =
      businessUrl ||
      `https://www.trustpilot.com/review/${encodeURIComponent(businessName ?? "")}`;

    const dispatcher = requireExtensionDispatcher(ctx);
    const { items: rows } = await extensionDomScrape<TrustpilotRow>({
      dispatcher,
      url: baseUrl,
      config: REVIEW_SCRAPE_CONFIG,
      parseRows: (raw) => raw as TrustpilotRow[],
      allowedOrigins: TRUSTPILOT_ALLOWED_ORIGINS,
    });

    // Reviews with meaningful content (more than 10 chars).
    const reviews: TrustpilotReview[] = rows
      .map((row) => ({
        rating: Number.parseInt(row.rating ?? "0", 10) || 0,
        title: row.title?.trim() ?? "",
        text: row.text?.trim() ?? "",
        date: row.date?.trim() ?? "",
        author: row.author?.trim() ?? "",
      }))
      .filter((review) => review.text.length > 10);

    // Drop rows whose `date` attribute was missing/invalid in the DOM —
    // `new Date("")` yields an Invalid Date, which downstream sorting and
    // checkpointing then can't compare, and an empty `date` made `origin_id`
    // collide on `-<author>` across rows.
    const events: EventEnvelope[] = reviews.flatMap((review) => {
      const content = review.title
        ? `${review.title}\n\n${review.text}`
        : review.text;
      const parsedDate = review.date ? new Date(review.date) : null;
      if (!parsedDate || Number.isNaN(parsedDate.getTime())) return [];

      return [
        {
          origin_id: `${review.date}-${review.author}`,
          payload_text: content,
          author_name: review.author,
          occurred_at: parsedDate,
          origin_type: "review",
          score: calculateEngagementScore("trustpilot", {
            rating: review.rating,
            helpful_count: 0,
          }),
          source_url: baseUrl,
          metadata: {
            rating: review.rating,
            helpful_count: 0,
            title: review.title,
          },
        },
      ];
    });

    return {
      events,
      checkpoint: { ...(ctx.checkpoint ?? {}), last_page: 1 },
      metadata: { items_found: reviews.length },
    };
  }
}
