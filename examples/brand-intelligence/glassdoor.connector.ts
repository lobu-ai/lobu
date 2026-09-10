/**
 * Glassdoor Connector (V1 runtime)
 *
 * Reads employee reviews through the paired Owletto Chrome extension.
 *
 * Glassdoor sits behind bot protection that a headless browser does not get
 * past, and connector code runs in a V8 isolate with no browser in it at all.
 * `extensionDomScrape` reads the DOM in the user's own signed-in Chrome via a
 * content script — declarative selectors in, rows out — which is the only path
 * to this page that both works and stays inside the isolate.
 */

import { createHash } from "node:crypto";
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

const GLASSDOOR_ALLOWED_ORIGINS = ["glassdoor.com", "*.glassdoor.com"];

// Derived from the live Glassdoor review DOM. Glassdoor rotates its class
// names, so every field lists the stable `data-test` hook first and falls back
// to the older class selectors the previous Playwright extract also carried.
const REVIEW_SCRAPE_CONFIG = {
  scroll: { max: 6, stall: 3, waitMs: 1200, deep: true },
  loggedOutWhen: { pathRegex: "/(profile/login|member/login)\\b" },
  rowSelector:
    '[data-test="review-list-item"], .empReview, [data-test="employerReview"]',
  requireFields: ["body"],
  fields: {
    // No selector ⇒ read the row element itself. `id` is derived from whichever
    // identity attribute the card carries.
    id: { take: "attr", attr: "data-review-id" },
    rating: {
      selector: '[data-test="overall-rating"], .rating, [class*="rating"]',
      take: "text",
      firstLine: true,
    },
    title: {
      selector: '[data-test="review-title"], .reviewLink, [class*="title"]',
      take: "text",
      firstLine: true,
    },
    pros: { selector: '[data-test="pros"], [data-pros], .pros', take: "text" },
    cons: { selector: '[data-test="cons"], [data-cons], .cons', take: "text" },
    date: {
      selector: '[data-test="review-date"], .date, time',
      take: "attr",
      attr: "datetime",
    },
    dateText: {
      selector: '[data-test="review-date"], .date, time',
      take: "text",
      firstLine: true,
    },
    author: {
      selector: '[data-test="employee-info"], .authorInfo, [class*="author"]',
      take: "text",
      firstLine: true,
    },
    // Whole-card text, so `requireFields` can reject an empty shell row.
    body: { take: "text" },
  },
} as const;

/**
 * Generates a deterministic external ID for a Glassdoor review.
 * Uses the native review ID from the DOM when available, otherwise
 * derives a stable hash from review content to avoid duplicates.
 */
function deriveReviewExternalId(
  companyName: string,
  review: GlassdoorReview
): string {
  if (review.id) return review.id;

  const contentKey = [
    review.date,
    review.author,
    (review.title || review.pros || review.cons).slice(0, 80),
  ]
    .filter(Boolean)
    .join("|");

  const hash = createHash("sha256")
    .update(contentKey)
    .digest("hex")
    .slice(0, 12);
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `glassdoor-${slug}-${hash}`;
}

/**
 * Raw review data extracted from a Glassdoor page
 */
interface GlassdoorReview {
  id: string;
  rating: number;
  title: string;
  pros: string;
  cons: string;
  date: string;
  author: string;
}

interface GlassdoorConfig {
  company_name: string;
  company_id?: string;
  lookback_days?: number;
}

export default class GlassdoorConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "glassdoor",
    name: "Glassdoor",
    description:
      "Reads employee reviews from Glassdoor through the paired Chrome extension.",
    version: "2.0.0",
    faviconDomain: "glassdoor.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      reviews: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "reviews",
        name: "Employee Reviews",
        description: "Reads employee reviews for a given company.",
        configSchema: {
          type: "object",
          required: ["company_name"],
          properties: {
            company_name: {
              type: "string",
              minLength: 1,
              description: "Company name for search-based lookup",
            },
            company_id: {
              type: "string",
              description: "Glassdoor company ID if known",
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
        },
        eventKinds: {
          review: {
            description: "A Glassdoor employee review",
            metadataSchema: {
              type: "object",
              properties: {
                rating: { type: "number", description: "Overall rating (0-5)" },
                title: { type: "string", description: "Review headline" },
                pros: { type: "string" },
                cons: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as GlassdoorConfig;
    const { company_name, company_id } = config;

    if (!company_name) {
      return {
        events: [],
        checkpoint: ctx.checkpoint,
        metadata: { items_found: 0, error: "company_name is required" },
      };
    }

    const baseUrl = company_id
      ? `https://www.glassdoor.com/Reviews/company-reviews-${company_id}.htm`
      : `https://www.glassdoor.com/Reviews/${company_name}-reviews-SRCH_KE0.htm`;

    const dispatcher = requireExtensionDispatcher(ctx);
    const { items: rows, loggedIn } = await extensionDomScrape<GlassdoorRow>({
      dispatcher,
      url: baseUrl,
      config: REVIEW_SCRAPE_CONFIG,
      parseRows: (raw) => raw as GlassdoorRow[],
      allowedOrigins: GLASSDOOR_ALLOWED_ORIGINS,
      // Reviews render for signed-out visitors too, but a signed-in tab sees
      // the full list rather than the teaser, so prefer one the user has open.
    });

    if (!loggedIn) {
      throw new Error(
        "Glassdoor reviews could not be read — a login or bot wall blocked the page. Open glassdoor.com in the paired Chrome profile, sign in, then re-run."
      );
    }

    const reviews = rows
      .map((row) => normalizeReview(row))
      .filter((review) => Boolean(review.pros || review.cons));
    const itemsSkipped = rows.length - reviews.length;

    const events: EventEnvelope[] = reviews.map((review) => {
      const externalId = deriveReviewExternalId(company_name, review);
      const content = `${review.title}\n\nPros: ${review.pros}\n\nCons: ${review.cons}`;

      return {
        origin_id: externalId,
        payload_text: content,
        author_name: review.author || undefined,
        occurred_at: review.date ? new Date(review.date) : new Date(),
        origin_type: "review",
        score: calculateEngagementScore("glassdoor", { rating: review.rating }),
        source_url: `${baseUrl}#review_${review.id}`,
        metadata: {
          rating: review.rating,
          title: review.title,
          pros: review.pros,
          cons: review.cons,
        },
      };
    });

    return {
      events,
      checkpoint: ctx.checkpoint,
      metadata: { items_found: events.length, items_skipped: itemsSkipped },
    };
  }
}

/**
 * One scraped row, as the extension's declarative engine returns it: every
 * field is a string or absent, so the numeric rating and the date are parsed
 * here rather than in the page.
 */
interface GlassdoorRow {
  id?: string;
  rating?: string;
  title?: string;
  pros?: string;
  cons?: string;
  date?: string;
  dateText?: string;
  author?: string;
}

function normalizeReview(row: GlassdoorRow): GlassdoorReview {
  return {
    id: row.id ?? "",
    rating: Number.parseFloat(row.rating ?? "0") || 0,
    title: row.title?.trim() ?? "",
    pros: row.pros?.trim() ?? "",
    cons: row.cons?.trim() ?? "",
    date: (row.date || row.dateText || "").trim(),
    author: row.author?.trim() ?? "",
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
      "Glassdoor connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — run on a connector-worker with the dispatcher bridge and an online extension."
    );
  }
  return handle;
}
