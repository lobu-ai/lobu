/**
 * Deliveroo Connector — on-demand restaurant search + menu read.
 *
 * Two actions the lunch bot calls at runtime through the paired Owletto Chrome
 * extension (no Playwright, no cookie cache — the office account is already
 * signed into deliveroo.co.uk in that Chrome):
 *
 *   - `search_restaurants({ query })` → restaurants near the office matching the
 *     query, each as `{ name, url }`.
 *   - `read_menu({ restaurant_url })` → that restaurant's menu items
 *     (`{ name, price, price_minor, description, kcal }`).
 *
 * Both are read-only — there is no checkout/order/payment path. The agent picks
 * a restaurant, reads its menu, assembles a per-person order, and a human places
 * it.
 *
 * Deliveroo pages are server-rendered (the list + menu are in the DOM, not a
 * separate XHR), so both actions use `extensionDomScrape` (a content script, no
 * CDP debugger) rather than `extensionNetworkSync`. Actions reach the extension
 * via the `chrome_dispatcher` spliced onto `ctx.sessionState` by the
 * connector-worker — the same bridge syncs use.
 */

import {
  type ActionContext,
  type ActionResult,
  type ChromeActionDispatcher,
  type ConnectorDefinition,
  ConnectorRuntime,
  extensionDomScrape,
} from "@lobu/connector-sdk";

const DELIVEROO_ALLOWED_ORIGINS = ["deliveroo.co.uk", "*.deliveroo.co.uk"];

// ── Restaurant-list scrape (derived from the live deliveroo.co.uk list DOM) ──
//
// Each restaurant on a list/search page renders as an anchor into `/menu/…`
// (`a[href*="/menu/"]`). The name is the first heading/paragraph text inside the
// card; the URL is the anchor's own href (absolute in the live DOM).
const RESTAURANT_SCRAPE_CONFIG = {
  scroll: { max: 8, stall: 3, waitMs: 1000, deep: true },
  loggedOutWhen: { pathRegex: "/(account/login|login)\\b" },
  rowSelector: 'a[href*="/menu/"]',
  requireFields: ["name", "url"],
  fields: {
    // The card has no heading — the restaurant name is a <p> tagged
    // `partner-name` (sibling to a `delivery-time` <p> like "10 min"). Key off
    // the stable testid so we don't grab the delivery time.
    name: {
      selector: 'p[data-testid="partner-name"]',
      take: "text",
      firstLine: true,
    },
    // No selector ⇒ the field reads the row element (the anchor) itself.
    url: { take: "attr", attr: "href" },
  },
} as const;

// ── Menu-item scrape (derived from the live deliveroo.co.uk menu DOM) ────────
//
// Each menu item renders as `div[class*="MenuItemCardV2-"]`. Inner classes are
// hashed (`ccl-*`) with no stable testids, so we grab the name (first <p>) plus
// the whole card text and parse price/kcal/description out of it.
const MENU_SCRAPE_CONFIG = {
  scroll: { max: 12, stall: 4, waitMs: 1200, deep: true },
  loggedOutWhen: { pathRegex: "/(account/login|login)\\b" },
  rowSelector: 'div[class*="MenuItemCardV2-"]',
  requireFields: ["name"],
  fields: {
    name: { selector: "p", take: "text", firstLine: true },
    text: { take: "text" },
  },
} as const;

interface RestaurantRow {
  name?: string;
  url?: string;
}

interface Restaurant {
  name: string;
  url: string;
}

interface MenuRow {
  name?: string;
  text?: string;
}

interface MenuItem {
  name: string;
  /** Display price, e.g. "£18.20" (current price; a struck-through was-price is ignored). */
  price?: string;
  /** Price in pence, for downstream budget math. */
  priceMinor?: number;
  description?: string;
  kcal?: number;
}

/** Normalise a Deliveroo restaurant href to an absolute deliveroo.co.uk URL. */
function absoluteDeliverooUrl(href: string): string | null {
  try {
    const url = new URL(href, "https://deliveroo.co.uk");
    if (!/(^|\.)deliveroo\.co\.uk$/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseRestaurantRows(
  rows: RestaurantRow[],
  query?: string
): Restaurant[] {
  const needle = (query ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const all: Restaurant[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    const url = absoluteDeliverooUrl((row.url ?? "").trim());
    if (!name || !url) continue;
    // De-dupe by restaurant path (the same card can appear in multiple rails).
    const key = new URL(url).pathname.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ name, url });
  }
  if (!needle) return all;
  const matches = all.filter((r) => r.name.toLowerCase().includes(needle));
  // Fall back to the full nearby list when nothing matches the query by name —
  // the agent can still choose, rather than getting an empty result.
  return matches.length > 0 ? matches : all;
}

/**
 * Parse a scraped card into a structured menu item. The card text concatenates
 * name, description, "N kcal", then one or more "£X.XX" prices (the first is the
 * current price; a second is a struck-through original).
 */
export function parseMenuRows(rows: MenuRow[]): MenuItem[] {
  const seen = new Set<string>();
  const items: MenuItem[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const text = (row.text ?? "").replace(/\s+/g, " ").trim();
    const priceMatch = text.match(/£\s?(\d+(?:\.\d{1,2})?)/);
    const kcalMatch = text.match(/(\d+)\s*kcal/i);

    let description = text;
    if (description.startsWith(name))
      description = description.slice(name.length);
    description = description
      .replace(/\d+\s*kcal/gi, "")
      .replace(/£\s?\d+(?:\.\d{1,2})?/g, "")
      .replace(/\s+/g, " ")
      .trim();

    items.push({
      name,
      price: priceMatch ? `£${priceMatch[1]}` : undefined,
      priceMinor: priceMatch
        ? Math.round(Number.parseFloat(priceMatch[1]) * 100)
        : undefined,
      description: description || undefined,
      kcal: kcalMatch ? Number.parseInt(kcalMatch[1], 10) : undefined,
    });
  }
  return items;
}

/**
 * Pull the chrome action dispatcher off a sync OR action context. The
 * connector-worker splices a live `chrome_dispatcher` onto `sessionState` for
 * both run modes; with no online paired Owletto extension in the connection's
 * org the dispatcher throws.
 */
function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = ctx.sessionState?.chrome_dispatcher as
    | ChromeActionDispatcher
    | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "Deliveroo connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — run on a connector-worker with the dispatcher bridge and an online extension."
    );
  }
  return handle;
}

const searchInputSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description:
        'What to search for near the office, e.g. a restaurant name ("Nando\'s") or cuisine word ("sushi"). Matched against restaurant names; an empty/loose query returns the nearby list.',
    },
    location_url: {
      type: "string",
      description:
        "Optional Deliveroo restaurants-list URL to search within (overrides the connection's restaurants_url). Must be a deliveroo.co.uk /restaurants/… page for the office's delivery location.",
    },
  },
};

const readMenuInputSchema = {
  type: "object",
  required: ["restaurant_url"],
  properties: {
    restaurant_url: {
      type: "string",
      description:
        'Deliveroo restaurant menu URL from search_restaurants (e.g. "https://deliveroo.co.uk/menu/London/the-city/nandos-lime-street").',
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      default: 12,
      description:
        "Maximum scroll iterations to load the full menu (default 12).",
    },
  },
};

const connectionConfigSchema = {
  type: "object",
  properties: {
    restaurants_url: {
      type: "string",
      description:
        'Deliveroo restaurants-list URL for the office delivery location (e.g. "https://deliveroo.co.uk/restaurants/london/the-city?fulfillment_method=DELIVERY&geohash=gcpvjcnm9jsv"). search_restaurants scrapes this page; read_menu takes a restaurant URL directly so does not need it.',
    },
  },
};

export default class DeliverooConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "deliveroo",
    name: "Deliveroo",
    description:
      "Search Deliveroo restaurants near the office and read a restaurant's menu, on demand, via the paired Owletto Chrome extension. Auth is implicit (the office account is signed into deliveroo.co.uk in that Chrome). Reading only — no checkout.",
    version: "2.0.1",
    faviconDomain: "deliveroo.co.uk",
    authSchema: { methods: [{ type: "none" }] },
    actions: {
      search_restaurants: {
        key: "search_restaurants",
        name: "Search restaurants",
        description:
          "Search Deliveroo restaurants near the office. Returns matching restaurants as { name, url } — feed a url to read_menu.",
        annotations: { idempotentHint: true, openWorldHint: true },
        inputSchema: searchInputSchema,
      },
      read_menu: {
        key: "read_menu",
        name: "Read menu",
        description:
          "Read a Deliveroo restaurant's menu. Returns items as { name, price, price_minor, description, kcal }.",
        annotations: { idempotentHint: true, openWorldHint: true },
        inputSchema: readMenuInputSchema,
      },
    },
    optionsSchema: connectionConfigSchema,
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      if (ctx.actionKey === "search_restaurants") {
        return await this.searchRestaurants(ctx);
      }
      if (ctx.actionKey === "read_menu") {
        return await this.readMenu(ctx);
      }
      return { success: false, error: `Unknown action '${ctx.actionKey}'` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async searchRestaurants(ctx: ActionContext): Promise<ActionResult> {
    const input = ctx.input as { query?: string; location_url?: string };
    const query = (input.query ?? "").trim();
    const listUrl = (
      input.location_url ??
      (ctx.config.restaurants_url as string | undefined) ??
      ""
    ).trim();
    if (!listUrl) {
      throw new Error(
        "No restaurants list URL — set `restaurants_url` on the Deliveroo connection (the office delivery location) or pass `location_url`."
      );
    }
    const dispatcher = requireExtensionDispatcher(ctx);

    const { items: rows, loggedIn } = await extensionDomScrape<RestaurantRow>({
      dispatcher,
      url: listUrl,
      config: RESTAURANT_SCRAPE_CONFIG,
      parseRows: (raw) => raw as RestaurantRow[],
      allowedOrigins: DELIVEROO_ALLOWED_ORIGINS,
    });

    if (!loggedIn) {
      throw new Error(
        "Deliveroo restaurants list could not be read — a login/age wall blocked the page. Sign into deliveroo.co.uk in the paired Chrome profile, then re-run."
      );
    }

    const restaurants = parseRestaurantRows(rows, query);
    return {
      success: true,
      output: {
        query,
        restaurants_found: restaurants.length,
        restaurants,
      },
    };
  }

  private async readMenu(ctx: ActionContext): Promise<ActionResult> {
    const input = ctx.input as {
      restaurant_url?: string;
      max_scrolls?: number;
    };
    const url = (input.restaurant_url ?? "").trim();
    if (!url) {
      throw new Error("restaurant_url is required");
    }
    const absolute = absoluteDeliverooUrl(url);
    if (!absolute) {
      throw new Error(`Not a deliveroo.co.uk restaurant URL: ${url}`);
    }
    const maxScrolls = input.max_scrolls ?? 12;
    const dispatcher = requireExtensionDispatcher(ctx);

    const { items: rows, loggedIn } = await extensionDomScrape<MenuRow>({
      dispatcher,
      url: absolute,
      config: {
        ...MENU_SCRAPE_CONFIG,
        scroll: { ...MENU_SCRAPE_CONFIG.scroll, max: maxScrolls },
      },
      parseRows: (raw) => raw as MenuRow[],
      allowedOrigins: DELIVEROO_ALLOWED_ORIGINS,
    });

    if (!loggedIn) {
      throw new Error(
        "Deliveroo menu could not be read — a login/age wall blocked the page. Sign into deliveroo.co.uk in the paired Chrome profile, then re-run."
      );
    }

    const items = parseMenuRows(rows).map((item) => ({
      name: item.name,
      price: item.price,
      price_minor: item.priceMinor,
      description: item.description,
      kcal: item.kcal,
    }));

    return {
      success: true,
      output: {
        restaurant_url: absolute,
        items_found: items.length,
        items,
      },
    };
  }
}
