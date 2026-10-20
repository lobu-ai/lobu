import {
  type ActionContext,
  type ActionResult,
  type ChromeActionDispatcher,
  ConnectorRuntime,
  type RuntimeConnectorDefinition,
  requireBrowser,
} from "@lobu/connector-sdk";

/** Origins the Owletto extension may touch for listing reads. */
const SAHIBINDEN_ALLOWED_ORIGINS = [
  "sahibinden.com",
  "*.sahibinden.com",
] as const;

/** Public photo CDN. Photos are fetched directly, never through the browser. */
const PHOTO_HOST_SUFFIX = ".shbdn.com";

/** One tool result takes at most 8 images (`MAX_TOOL_IMAGES`). */
const MAX_PHOTOS = 8;
/** Below the 5 MB per-image ceiling an agent turn accepts. */
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO_FETCH_TIMEOUT_MS = 15_000;

interface ListingRead {
  listing_no: string;
  url: string;
  title: string;
  price: { amount: number; currency: string } | null;
  price_text: string;
  location: {
    city: string | null;
    district: string | null;
    quarter: string | null;
    lat: number | null;
    lng: number | null;
  };
  attributes: Record<string, string>;
  description: string;
  photos: string[];
  seller: { name: string | null; type: "agency" | "owner" | null };
  listed_on: string | null;
  removed: boolean;
}

/**
 * Normalize a listing link to its canonical detail URL and listing number.
 * Accepts `/ilan/<slug>-<no>/detay` paths with or without a trailing slash,
 * query or fragment, on www.sahibinden.com only.
 */
export function parseListingUrl(
  raw: string
): { url: string; listing_no: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "www.sahibinden.com") {
    return null;
  }
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "ilan") return null;
  if (segments[2] !== "detay") return null;
  const slug = segments[1];
  const listingNo = slug.slice(slug.lastIndexOf("-") + 1);
  if (!listingNo || ![...listingNo].every((c) => c >= "0" && c <= "9")) {
    return null;
  }
  return {
    url: `https://www.sahibinden.com/ilan/${slug}/detay`,
    listing_no: listingNo,
  };
}

/** `12.600.000 TL` → `{ amount: 12600000, currency: "TRY" }`. */
export function parsePrice(
  text: string
): { amount: number; currency: string } | null {
  const trimmed = text.trim();
  const currencies: Array<[string, string]> = [
    ["TL", "TRY"],
    ["USD", "USD"],
    ["$", "USD"],
    ["EUR", "EUR"],
    ["€", "EUR"],
    ["GBP", "GBP"],
    ["£", "GBP"],
  ];
  const match = currencies.find(([mark]) => trimmed.includes(mark));
  // sahibinden prices are whole amounts with dot grouping.
  const digits = [...trimmed].filter((c) => c >= "0" && c <= "9").join("");
  if (!match || !digits) return null;
  return { amount: Number(digits), currency: match[1] };
}

/**
 * Thumbnails share the full-size path with a `thmb_` prefix. The page also
 * carries AVIF variants (`x16_…avif`); only the x5 JPEG is kept.
 */
export function fullSizePhotoUrl(src: string): string | null {
  const url = src.split("/thmb_").join("/x5_");
  return url.includes("/x5_") && url.endsWith(".jpg") ? url : null;
}

function isPhotoUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.endsWith(PHOTO_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Runs in the listing tab. sahibinden can serve a `/cs/checkLoading`
 * interstitial first, so readiness waits for the detail title.
 */
export const LISTING_EXPRESSION = `(async () => {
  const deadline = Date.now() + 20000;
  // A taken-down listing either says so in place or redirects to its
  // category page with a "not published" notice.
  // A bot check or sign-in page is neither the listing nor proof it is gone.
  const blocked = () => location.hostname !== 'www.sahibinden.com' || location.pathname.startsWith('/cs/');
  const gone = () => !blocked() && !!document.body &&
    ['yayından kaldırılmıştır', 'yayında değildir'].some((t) => document.body.innerText.includes(t));
  const ready = () => document.querySelector('.classifiedDetailTitle h1') || gone();
  while (Date.now() < deadline && !ready()) {
    await new Promise((r) => setTimeout(r, 300));
  }
  const q = (s) => document.querySelector(s);
  const text = (el) => (el ? el.innerText.trim() : '');
  const attributes = {};
  for (const item of document.querySelectorAll('.classifiedInfoList .classifiedInfoItem, .classifiedInfoList li')) {
    const key = text(item.querySelector('dt, strong'));
    const value = text(item.querySelector('dd, span'));
    if (key && value) attributes[key] = value;
  }
  const locationLinks = [...document.querySelectorAll('.classifiedInfo .classifiedLocation a, .classifiedInfo h2 a')].map(text).filter(Boolean);
  const map = q('#gmap');
  const photos = [...document.querySelectorAll('.classifiedDetailMainPhoto img, .megaPhotoThmbItem img, img[data-source]')]
    // The gallery lazy-loads: real URLs sit in data-src behind a blank src.
    .map((img) => img.getAttribute('data-src') || img.getAttribute('data-source') || img.getAttribute('src') || '')
    .filter((src) => src.includes('/photos/'));
  return {
    path: location.pathname,
    blocked: blocked(),
    title: text(q('.classifiedDetailTitle h1')),
    price_text: text(q('.classifiedPriceValue, .classifiedInfo h3')),
    location_links: locationLinks,
    lat: map ? map.getAttribute('data-lat') : null,
    lng: map ? map.getAttribute('data-lon') : null,
    attributes,
    description: text(q('#classifiedDescription')),
    photos,
    seller_name: text(q('.user-info-store-name a, .user-info-module .username-info-area h5')) || null,
    removed: !q('.classifiedDetailTitle h1') && gone(),
  };
})()`;

interface ListingPage {
  path?: string;
  blocked?: boolean;
  title?: string;
  price_text?: string;
  location_links?: string[];
  lat?: string | null;
  lng?: string | null;
  attributes?: Record<string, string>;
  description?: string;
  photos?: string[];
  seller_name?: string | null;
  removed?: boolean;
}

function coordinate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** `20 Ekim 2026` → `2026-10-20`. */
const TURKISH_MONTHS = [
  "ocak",
  "şubat",
  "mart",
  "nisan",
  "mayıs",
  "haziran",
  "temmuz",
  "ağustos",
  "eylül",
  "ekim",
  "kasım",
  "aralık",
];

export function parseListingDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const [day, month, year] = raw.trim().split(" ").filter(Boolean);
  const m = TURKISH_MONTHS.indexOf((month ?? "").toLocaleLowerCase("tr"));
  const d = Number(day);
  const y = Number(year);
  if (m < 0 || !Number.isInteger(d) || !Number.isInteger(y)) return null;
  const date = new Date(Date.UTC(y, m, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function toListingRead(
  target: { url: string; listing_no: string },
  page: ListingPage
): ListingRead {
  const attributes = { ...(page.attributes ?? {}) };
  const listedOn = parseListingDate(attributes["İlan Tarihi"]);
  delete attributes["İlan Tarihi"];
  delete attributes["İlan No"];
  const kimden = attributes.Kimden ?? "";
  const [city, district, quarter] = page.location_links ?? [];
  const photos = [
    ...new Set(
      (page.photos ?? [])
        .map(fullSizePhotoUrl)
        .filter((url): url is string => url !== null && isPhotoUrl(url))
    ),
  ];
  return {
    listing_no: target.listing_no,
    url: target.url,
    title: page.title ?? "",
    price: parsePrice(page.price_text ?? ""),
    price_text: page.price_text ?? "",
    location: {
      city: city ?? null,
      district: district ?? null,
      quarter: quarter ?? null,
      lat: coordinate(page.lat),
      lng: coordinate(page.lng),
    },
    attributes,
    description: page.description ?? "",
    photos,
    seller: {
      name: page.seller_name ?? null,
      type: kimden.includes("Sahibinden") ? "owner" : kimden ? "agency" : null,
    },
    listed_on: listedOn,
    removed: page.removed === true,
  };
}

export async function readListing(
  dispatcher: ChromeActionDispatcher,
  target: { url: string; listing_no: string }
): Promise<ListingRead> {
  const origins = [...SAHIBINDEN_ALLOWED_ORIGINS];
  let tabId: number | undefined;
  try {
    const nav = await dispatcher.dispatch<{ tab_id?: number }>("navigate", {
      url: target.url,
      new_tab: true,
      wait_for_load: true,
      allowed_origins: origins,
    });
    tabId = nav.tab_id;
    if (typeof tabId !== "number") {
      throw new Error("sahibinden listing tab was not created");
    }
    // The bot-check interstitial reloads the tab, which detaches an
    // evaluate that started before it. Retry until the listing page holds.
    let page: ListingPage | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4 && !page; attempt++) {
      try {
        const result = await dispatcher.dispatch<{ value?: ListingPage }>(
          "evaluate",
          {
            tab_id: tabId,
            expression: LISTING_EXPRESSION,
            allowed_origins: origins,
          }
        );
        page = result.value;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (!page) throw lastError ?? new Error("sahibinden listing read failed");
    if (page.blocked) {
      throw new Error(
        "sahibinden is showing a bot check or sign-in page. Open sahibinden.com in this Chrome profile, then re-run."
      );
    }
    const read = toListingRead(target, page);
    if (!read.removed && !read.title) {
      throw new Error(
        "sahibinden listing page did not render its details; the layout may have changed."
      );
    }
    if (!read.removed) {
      const landed = parseListingUrl(
        `https://www.sahibinden.com${page.path ?? ""}`
      );
      const displayedNumber = page.attributes?.["İlan No"];
      if (
        landed?.listing_no !== target.listing_no ||
        (displayedNumber && displayedNumber !== target.listing_no)
      ) {
        throw new Error("sahibinden page does not match the requested listing");
      }
    }
    return read;
  } finally {
    if (typeof tabId === "number") {
      await dispatcher
        .dispatch("close_tab", { tab_id: tabId, allowed_origins: origins })
        .catch(() => undefined);
    }
  }
}

async function fetchPhoto(url: string): Promise<{
  filename: string;
  mime_type: string;
  data: string;
  size_bytes: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok)
      throw new Error(`photo ${url} returned ${response.status}`);
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0];
    if (!mimeType.startsWith("image/")) {
      throw new Error(
        `photo ${url} is not an image (${mimeType || "no type"})`
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_PHOTO_BYTES) {
      throw new Error(`photo ${url} is ${bytes.length} bytes, over the limit`);
    }
    return {
      filename: url.slice(url.lastIndexOf("/") + 1) || "photo.jpg",
      mime_type: mimeType,
      data: Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).toString("base64"),
      size_bytes: bytes.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

export default class SahibindenConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "sahibinden",
    name: "sahibinden.com",
    description:
      "Reads sahibinden.com listings through the paired Chrome and fetches their photos.",
    version: "1.0.3",
    faviconDomain: "sahibinden.com",
    browser: {
      origins: ["https://www.sahibinden.com", "https://secure.sahibinden.com"],
    },
    authSchema: { methods: [{ type: "none" }] },
    feeds: {},
    actions: {
      read_listing: {
        key: "read_listing",
        name: "Read listing",
        description:
          "Open one listing in a scratch tab and return its title, price, location, attributes, description, seller and photo URLs. Closes the tab.",
        kind: "read",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          required: ["url"],
          properties: {
            url: {
              type: "string",
              description:
                "Listing URL, https://www.sahibinden.com/ilan/<slug>-<listing no>/detay",
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            listing_no: { type: "string" },
            url: { type: "string" },
            title: { type: "string" },
            price: { type: ["object", "null"] },
            price_text: { type: "string" },
            location: { type: "object" },
            attributes: { type: "object" },
            description: { type: "string" },
            photos: { type: "array", items: { type: "string" } },
            seller: { type: "object" },
            listed_on: { type: ["string", "null"] },
            removed: { type: "boolean" },
          },
        },
      },
      fetch_photos: {
        key: "fetch_photos",
        name: "Fetch photos",
        description: `Download up to ${MAX_PHOTOS} listing photos from sahibinden's public photo CDN and return them as image attachments, so an agent can look at them.`,
        kind: "read",
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          idempotentHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["urls"],
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: MAX_PHOTOS,
              description:
                "Photo URLs on *.shbdn.com, as returned by read_listing.",
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            fetched: { type: "integer" },
            failed: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    optionsSchema: { type: "object", properties: {} },
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      if (ctx.actionKey === "read_listing") {
        const target = parseListingUrl(String(ctx.input.url ?? ""));
        if (!target) {
          return {
            success: false,
            error: "url must be a sahibinden.com listing URL",
          };
        }
        const read = await readListing(requireBrowser(ctx), target);
        return { success: true, output: { ...read } };
      }
      if (ctx.actionKey === "fetch_photos") {
        const urls = Array.isArray(ctx.input.urls)
          ? ctx.input.urls.map(String)
          : [];
        const valid = [
          ...new Set(
            urls
              .map(fullSizePhotoUrl)
              .filter((url): url is string => url !== null && isPhotoUrl(url))
          ),
        ];
        if (valid.length === 0) {
          return {
            success: false,
            error: "urls must be sahibinden photo URLs",
          };
        }
        const settled = await Promise.allSettled(
          valid.slice(0, MAX_PHOTOS).map(fetchPhoto)
        );
        const attachments = settled.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : []
        );
        const failed = settled.flatMap((r) =>
          r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []
        );
        if (attachments.length === 0) {
          return {
            success: false,
            error: `No photo could be fetched: ${failed.join("; ")}`,
          };
        }
        return {
          success: true,
          output: { fetched: attachments.length, failed, attachments },
        };
      }
      return { success: false, error: `Unknown action: ${ctx.actionKey}` };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
