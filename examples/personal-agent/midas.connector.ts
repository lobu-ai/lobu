import {
  type ChromeActionDispatcher,
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

/** Atlas web app dashboard — holdings live here when the user is signed in. */
export const MIDAS_DASHBOARD_URL = "https://atlas.getmidas.com/dashboard";

/**
 * Origins the Owletto extension may touch for this connector. Forwarded on
 * every chrome action so the extension's origin gate stays locked down.
 */
export const MIDAS_ALLOWED_ORIGINS = [
  "getmidas.com",
  "*.getmidas.com",
] as const;

/**
 * Runs inside the Atlas page via the extension's `evaluate` action. Atlas
 * paints the "Pozisyonlar" headings before appending the numeric rows, so
 * readiness requires a market heading AND a currency amount on its own line
 * within the section — a heading alone is a partial render. Returns the body
 * text either way once the 12s deadline passes.
 */
export const MIDAS_DASHBOARD_TEXT_EXPRESSION = `(async () => {
  const deadline = Date.now() + 12000;
  const bodyText = () => (document.body ? document.body.innerText : "");
  const ready = () => {
    const t = bodyText();
    const positionsStart = t.indexOf("Pozisyonlar");
    if (positionsStart === -1) return false;
    const positions = t.slice(positionsStart);
    const hasMarket =
      positions.includes("ABD Hisseleri") ||
      positions.includes("BIST Hisseleri");
    const hasSectionTotal =
      /(?:^|\\n)(?:\\$|₺)\\d[\\d.]*,\\d{2}(?:\\n|$)/.test(positions);
    return hasMarket && hasSectionTotal;
  };
  while (Date.now() < deadline && !ready()) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return bodyText();
})()`;

export type MidasMarket = "US" | "TR";

export interface MidasHolding {
  type: MidasMarket;
  symbol: string;
  shares: number;
  price: number;
  /** Average cost basis per share (Ort. Maliyet). */
  avg_cost: number;
  /** Mark-to-market position value (Pozisyon). */
  value: number;
  currency: "USD" | "TRY";
}

export interface MidasDashboardSnapshot {
  holdings: MidasHolding[];
  total_usd: number;
  total_try: number;
  /**
   * True when every visible ticker row parsed successfully. False on holding
   * row layout drift, or when no market section header was found at all.
   */
  positions_complete: boolean;
  /** Market sections actually present in this scrape. */
  markets_observed: MidasMarket[];
  /**
   * Markets whose ticker labels and parsed rows match Atlas's rendered position
   * count. Only these are safe to reconcile closures against — a header alone
   * proves the section started rendering, not that it finished.
   */
  markets_complete: MidasMarket[];
}

export interface MidasHoldingIdentity {
  type: MidasMarket;
  symbol: string;
  currency: "USD" | "TRY";
}

export interface MidasCheckpoint {
  last_run?: string;
  /**
   * Open-position book as of the last successful sync. Markets absent from or
   * incomplete in a scrape carry prior identities forward until fully rendered.
   */
  active_holdings?: MidasHoldingIdentity[];
}

/**
 * Pull the chrome action dispatcher from sessionState.
 *
 * The connector-worker host splices a live
 * `chrome_dispatcher` object onto every sync's sessionState; `dispatch()`
 * rides IPC up to the daemon and out through the gateway chrome-action
 * bridge to a paired Owletto extension. Looking at `ctx.channel` is wrong —
 * that field is the chat/channel facet, not the extension bridge (prod failure:
 * "MidasConnector requires a ChromeActionDispatcher" with Owletto online).
 */
export function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = (
    ctx.sessionState as Record<string, unknown> | null | undefined
  )?.chrome_dispatcher as ChromeActionDispatcher | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "Midas connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge."
    );
  }
  return handle;
}

/**
 * True when navigate landed on a sign-in / SSO wall rather than the dashboard.
 * Atlas redirects unauthenticated users off `/dashboard`.
 */
export function isMidasAuthWall(url: string | null | undefined): boolean {
  if (!url) return false;
  let pathname: string;
  let host = "";
  try {
    const u = new URL(url);
    pathname = u.pathname.toLowerCase();
    host = u.hostname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  if (host.includes("sso.") || host.includes("login.")) return true;
  // Path segments only — avoid substring false-positives on unrelated routes.
  const segments = pathname.split("/").filter(Boolean);
  return segments.some((seg) =>
    [
      "login",
      "signin",
      "sign-in",
      "signup",
      "sign-up",
      "register",
      "auth",
      "oauth",
      "sso",
    ].includes(seg)
  );
}

/**
 * Parse a number as rendered by Atlas's Turkish UI.
 *
 * Atlas uses European grouping for BOTH USD and TRY on the TR locale
 * (illustrative, synthetic values):
 *   `$123,45` → 123.45
 *   `$12.345,67` → 12345.67
 *   `₺1.234.567,89` → 1234567.89
 *   `12,345678` → 12.345678 (fractional shares)
 *   `1.000` → 1000 (thousand-grouped whole shares)
 *   `-$1.500,50(-%2,00)` → -1500.5 (trailing % annotation ignored)
 *
 * US-style `$1,234.56` is NOT used on this UI; do not strip commas as thousands.
 */
export function parseAtlasAmount(raw: string | null | undefined): number {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  // Drop parenthetical annotations: $40,86(%0,13) / -$11.492,08(-%1,18)
  s = s.replace(/\([^)]*\)/g, "").trim();

  // Optional leading sign after currency symbol: -$1.234,56 or $-1.234,56
  const sign = /^-|^\$-|^₺-|^€-|^£-/.test(s.replace(/\s/g, "")) ? -1 : 1;

  // Keep digits + separators only.
  const num = s.replace(/[^\d.,]/g, "");
  if (!num) return 0;

  // European: dots = thousands, last comma = decimal (if present).
  let normalized: string;
  if (num.includes(",")) {
    normalized = num.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(num)) {
    // 14.000 / 1.273.667 — pure thousand groups, no decimal part.
    normalized = num.replace(/\./g, "");
  } else {
    // Bare integer or single-dot decimal without grouping.
    normalized = num;
  }

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? sign * n : 0;
}

/** Share quantity — same European rendering as money on Atlas TR. */
export function parseShares(raw: string | null | undefined): number {
  return parseAtlasAmount(raw);
}

/**
 * A holding-row cell (shares / price / value) is structurally valid only if it
 * carries at least one digit. This distinguishes a genuine zero value (`$0,00`,
 * still has a digit) from a malformed / drifted cell (a label, blank, or dash),
 * so we skip corrupt rows instead of emitting zero-valued holdings.
 */
function hasNumericCell(line: string | undefined): boolean {
  return typeof line === "string" && /\d/.test(line);
}

/**
 * True when a dashboard line looks like a numeric section marker, not a ticker.
 * Tickers may include digits (`3M`, `BRK.B`); counts/money/percents may not be
 * pure symbol tokens.
 */
function looksLikeNumberLine(line: string): boolean {
  // Alphanumeric symbol token (letters required) → ticker, never a section marker.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line) && /[A-Za-z]/.test(line)) {
    return false;
  }
  // Counts ("17"), money ("$333,69", "₺50.000,00"), percents ("%3,31").
  return /\d/.test(line);
}

/**
 * Rows in the Pozisyonlar table after the section total:
 *   count
 *   section_total
 *   section_daily_return   ← skip
 *   section_total_return   ← skip
 *   per holding × 7:
 *     shares, price, avg_cost, value, allocation%, daily_return, total_return
 *
 * Verified against a live Atlas TR capture (2026-07-18).
 */
const SECTION_SUMMARY_LINES = 2; // daily + total return after section total
const HOLDING_ROW_LINES = 7;

/**
 * Parse the Atlas dashboard body text into holdings + totals.
 *
 * Layout (Turkish Atlas UI, "Pozisyonlar" module):
 *
 *   ABD Hisseleri
 *   <US tickers…>
 *   BIST Hisseleri
 *   <TR tickers…>
 *   <usCount>
 *   <totalUsd>
 *   <section daily return>
 *   <section total return>
 *   per US holding × 7: shares, price, avg_cost, value, alloc%, daily, total
 *   <trCount>
 *   <totalTry>
 *   <section daily return>
 *   <section total return>
 *   per TR holding × 7 (same shape)
 *
 * Pure function so unit tests can fixture the DOM text without Owletto.
 */
export function parseMidasDashboardText(text: string): MidasDashboardSnapshot {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const usStartIdx = lines.indexOf("ABD Hisseleri");
  const trStartIdx = lines.indexOf("BIST Hisseleri");

  const usTickers: string[] = [];
  const trTickers: string[] = [];

  if (usStartIdx !== -1 && trStartIdx !== -1) {
    for (let i = usStartIdx + 1; i < trStartIdx; i++) {
      if (!looksLikeNumberLine(lines[i])) usTickers.push(lines[i]);
    }
  } else if (usStartIdx !== -1) {
    for (let i = usStartIdx + 1; i < lines.length; i++) {
      if (looksLikeNumberLine(lines[i])) break;
      usTickers.push(lines[i]);
    }
  }

  if (trStartIdx !== -1) {
    for (let i = trStartIdx + 1; i < lines.length; i++) {
      if (looksLikeNumberLine(lines[i])) break;
      trTickers.push(lines[i]);
    }
  }

  // Numeric blocks start immediately after the ticker name lists.
  // Order is always US then TR (matches section header order).
  let currentIdx = 0;
  if (trStartIdx !== -1) {
    currentIdx = trStartIdx + 1 + trTickers.length;
  } else if (usStartIdx !== -1) {
    currentIdx = usStartIdx + 1 + usTickers.length;
  }

  const holdings: MidasHolding[] = [];
  let totalUsd = 0;
  let totalTry = 0;

  const completeMarkets = new Set<MidasMarket>();

  const readBlock = (
    tickers: string[],
    market: MidasMarket,
    currency: "USD" | "TRY"
  ): number => {
    if (currentIdx >= lines.length || tickers.length === 0) return 0;

    // Optional holdings-count line: advance past it when the current line is a
    // bare positive integer, otherwise treat the current line as the section total.
    const countRaw = lines[currentIdx];
    const declaredCount = /^[1-9]\d*$/.test(countRaw)
      ? Number.parseInt(countRaw, 10)
      : null;
    if (declaredCount !== null) {
      currentIdx += 1;
    }

    const total = parseAtlasAmount(lines[currentIdx]);
    currentIdx += 1;

    // Section daily return + total return (not per-holding).
    currentIdx += SECTION_SUMMARY_LINES;

    const holdingsBefore = holdings.length;
    for (const symbol of tickers) {
      if (currentIdx + HOLDING_ROW_LINES - 1 >= lines.length) break;
      // Reject drifted layouts: a real row has numeric shares/price/value.
      // Stop rather than emit corrupt zero-valued holdings from mis-aligned
      // cells (a genuine $0,00 still passes — it carries a digit).
      if (
        !hasNumericCell(lines[currentIdx]) ||
        !hasNumericCell(lines[currentIdx + 1]) ||
        !hasNumericCell(lines[currentIdx + 3])
      ) {
        break;
      }
      const shares = parseShares(lines[currentIdx]);
      const price = parseAtlasAmount(lines[currentIdx + 1]);
      const avgCost = parseAtlasAmount(lines[currentIdx + 2]);
      const value = parseAtlasAmount(lines[currentIdx + 3]);
      holdings.push({
        symbol,
        shares,
        price,
        avg_cost: avgCost,
        value,
        currency,
        type: market,
      });
      currentIdx += HOLDING_ROW_LINES;
    }
    if (
      declaredCount === tickers.length &&
      holdings.length - holdingsBefore === tickers.length
    ) {
      completeMarkets.add(market);
    }
    return total;
  };

  totalUsd = readBlock(usTickers, "US", "USD");
  totalTry = readBlock(trTickers, "TR", "TRY");

  return {
    holdings,
    total_usd: totalUsd,
    total_try: totalTry,
    positions_complete:
      (usStartIdx !== -1 || trStartIdx !== -1) &&
      holdings.length === usTickers.length + trTickers.length,
    markets_observed: [
      ...(usStartIdx !== -1 ? (["US"] as const) : []),
      ...(trStartIdx !== -1 ? (["TR"] as const) : []),
    ],
    markets_complete: [
      ...(completeMarkets.has("US") ? (["US"] as const) : []),
      ...(completeMarkets.has("TR") ? (["TR"] as const) : []),
    ],
  };
}

export function holdingOriginId(
  holding: Pick<MidasHoldingIdentity, "type" | "symbol">
): string {
  return `midas-holding-${holding.type}-${holding.symbol}`;
}

export function holdingToEvent(
  h: MidasHolding,
  occurredAt: Date = new Date()
): EventEnvelope {
  // Namespace by market so a dual-listed ticker cannot collide on origin_id.
  return {
    origin_id: holdingOriginId(h),
    title: `Midas Holding: ${h.symbol}`,
    payload_text: `${h.symbol} (${h.type}): ${h.shares} @ ${h.price} ${h.currency} = ${h.value} ${h.currency} (avg ${h.avg_cost})`,
    occurred_at: occurredAt,
    semantic_type: "financial_asset",
    source_url: MIDAS_DASHBOARD_URL,
    metadata: {
      type: h.type,
      symbol: h.symbol,
      shares: h.shares,
      price: h.price,
      avg_cost: h.avg_cost,
      value: h.value,
      currency: h.currency,
      status: "active",
    },
  };
}

function closedHoldingToEvent(
  holding: MidasHoldingIdentity,
  occurredAt: Date
): EventEnvelope {
  return {
    origin_id: holdingOriginId(holding),
    title: `Midas Holding Closed: ${holding.symbol}`,
    payload_text: `${holding.symbol} (${holding.type}) is no longer present in the Midas portfolio.`,
    occurred_at: occurredAt,
    semantic_type: "financial_asset",
    source_url: MIDAS_DASHBOARD_URL,
    metadata: {
      type: holding.type,
      symbol: holding.symbol,
      shares: 0,
      price: 0,
      avg_cost: 0,
      value: 0,
      currency: holding.currency,
      status: "closed",
    },
  };
}

function checkpointHoldings(
  checkpoint: MidasCheckpoint | null
): MidasHoldingIdentity[] {
  if (!Array.isArray(checkpoint?.active_holdings)) return [];

  const byOrigin = new Map<string, MidasHoldingIdentity>();
  for (const candidate of checkpoint.active_holdings) {
    if (
      !candidate ||
      (candidate.type !== "US" && candidate.type !== "TR") ||
      typeof candidate.symbol !== "string" ||
      candidate.symbol.trim() === "" ||
      (candidate.currency !== "USD" && candidate.currency !== "TRY") ||
      (candidate.type === "US" && candidate.currency !== "USD") ||
      (candidate.type === "TR" && candidate.currency !== "TRY")
    ) {
      continue;
    }
    const holding = { ...candidate, symbol: candidate.symbol.trim() };
    byOrigin.set(holdingOriginId(holding), holding);
  }
  return [...byOrigin.values()];
}

export function balanceToEvent(
  snapshot: Pick<MidasDashboardSnapshot, "total_usd" | "total_try">,
  occurredAt: Date = new Date()
): EventEnvelope {
  return {
    origin_id: "midas-balance",
    title: "Midas Balance",
    payload_text: `Midas totals: $${snapshot.total_usd} USD / ₺${snapshot.total_try} TRY`,
    occurred_at: occurredAt,
    semantic_type: "balance_raw",
    source_url: MIDAS_DASHBOARD_URL,
    metadata: {
      balance: snapshot.total_usd,
      currency: "USD",
      total_try: snapshot.total_try,
    },
  };
}

/**
 * Reduce a URL to `origin + pathname` for diagnostics. Auth callbacks may carry
 * `code`, `state`, tokens, etc. in the query/fragment; those must never reach
 * notifications, thrown errors, or logs.
 */
export function safeDiagnosticUrl(url: string | null | undefined): string {
  if (!url) return MIDAS_DASHBOARD_URL;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Not a full URL — coarse-strip anything after the first ? or #.
    return String(url).split(/[?#]/)[0] || MIDAS_DASHBOARD_URL;
  }
}

async function notifyMidasAuthWall(
  dispatcher: ChromeActionDispatcher,
  landedUrl: string
): Promise<void> {
  // Never forward raw query params (may contain OAuth code/state/tokens).
  const safeLanded = safeDiagnosticUrl(landedUrl);
  try {
    await dispatcher.dispatch("show_notification", {
      notification_id: "midas-auth-wall",
      title: "Midas needs sign-in",
      message:
        "Sign in to Midas in the focused Chrome window, then re-run the sync.",
      landed_url: safeLanded,
      // Fixed, safe destination — never a callback URL with sensitive params.
      click_url: MIDAS_DASHBOARD_URL,
    });
  } catch {
    // Best-effort UX; never mask the auth-wall error.
  }
}

export default class MidasConnector extends ConnectorRuntime<MidasCheckpoint> {
  readonly definition: RuntimeConnectorDefinition<MidasCheckpoint> = {
    key: "midas",
    name: "Midas",
    description:
      "Syncs Midas portfolio holdings via the Owletto Chrome extension.",
    version: "1.1.0",
    faviconDomain: "atlas.getmidas.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      assets: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "assets",
        name: "Midas Holdings",
        description:
          "Scrapes Midas portfolio holdings from atlas.getmidas.com.",
        configSchema: { type: "object", properties: {} },
        eventKinds: {
          financial_asset: {
            description: "A financial asset holding",
            metadataSchema: {
              type: "object",
              properties: {
                type: { type: "string" },
                symbol: { type: "string" },
                shares: { type: "number" },
                price: { type: "number" },
                avg_cost: { type: "number" },
                value: { type: "number" },
                currency: { type: "string" },
                status: { type: "string", enum: ["active", "closed"] },
              },
            },
          },
          balance_raw: {
            description: "Midas Total Balance",
            metadataSchema: {
              type: "object",
              properties: {
                balance: { type: "number" },
                currency: { type: "string" },
                total_try: { type: "number" },
              },
            },
          },
        },
      },
    },
    optionsSchema: { type: "object", properties: {} },
  };

  private async syncFeed(
    ctx: SyncContext<MidasCheckpoint>
  ): Promise<SyncResult> {
    if (ctx.feedKey !== "assets") {
      throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }

    const dispatcher = requireExtensionDispatcher(ctx);

    const nav = await dispatcher.dispatch<{
      tab_id: number;
      current_url?: string;
    }>("navigate", {
      url: MIDAS_DASHBOARD_URL,
      persistent: true,
      window_focused: false,
      // Wait for frame stop — better than a blind 5s sleep that still races SPAs.
      wait_for_load: true,
      allowed_origins: [...MIDAS_ALLOWED_ORIGINS],
    });

    const landedUrl = nav.current_url ?? MIDAS_DASHBOARD_URL;
    if (isMidasAuthWall(landedUrl)) {
      await notifyMidasAuthWall(dispatcher, landedUrl);
      // Redact query/fragment: an auth-wall URL may carry code/state/tokens.
      throw new Error(
        `Midas session needs sign-in (landed on ${safeDiagnosticUrl(
          landedUrl
        )}). Sign in at atlas.getmidas.com in this Chrome profile, then re-run the sync.`
      );
    }

    if (typeof nav.tab_id !== "number") {
      throw new Error(
        "Midas navigate did not return a tab_id — Owletto may have failed to open the dashboard."
      );
    }

    // SPA settle: headings paint before Atlas appends the numeric rows. Wait
    // for a section total inside Pozisyonlar, not just for an early marker.
    const textObs = await dispatcher.dispatch<{ value?: string }>("evaluate", {
      tab_id: nav.tab_id,
      expression: MIDAS_DASHBOARD_TEXT_EXPRESSION,
      allowed_origins: [...MIDAS_ALLOWED_ORIGINS],
    });

    const bodyText = textObs.value ?? "";
    const snapshot = parseMidasDashboardText(bodyText);

    if (
      snapshot.holdings.length === 0 &&
      snapshot.total_usd === 0 &&
      snapshot.total_try === 0
    ) {
      // Empty portfolio is rare; more often the UI language/layout changed or
      // the session is soft-logged-out without a hard redirect.
      if (/giriş yap|sign in|log in|login/i.test(bodyText)) {
        await notifyMidasAuthWall(dispatcher, landedUrl);
        throw new Error(
          "Failed to parse Midas dashboard — page looks unauthenticated. Sign in at atlas.getmidas.com and re-run."
        );
      }
      throw new Error(
        'Failed to parse Midas dashboard (no holdings or totals found). Confirm the Atlas UI still shows "ABD Hisseleri" / "BIST Hisseleri" under Pozisyonlar, or capture body text for a parser update.'
      );
    }

    if (!snapshot.positions_complete) {
      throw new Error(
        "Incomplete Midas dashboard parse — one or more visible holding rows were malformed. No events or closed positions were emitted."
      );
    }

    const occurredAt = new Date();
    const activeHoldings: MidasHoldingIdentity[] = snapshot.holdings.map(
      ({ type, symbol, currency }) => ({ type, symbol, currency })
    );
    const previousHoldings = checkpointHoldings(ctx.checkpoint);
    const completeMarkets = new Set(snapshot.markets_complete);
    const currentOrigins = new Set(activeHoldings.map(holdingOriginId));
    const closedEvents = previousHoldings
      .filter(
        (holding) =>
          completeMarkets.has(holding.type) &&
          !currentOrigins.has(holdingOriginId(holding))
      )
      .map((holding) => closedHoldingToEvent(holding, occurredAt));
    // A missing market may be empty or not rendered yet; a present market short
    // of its declared count cannot prove omitted holdings are closed. Preserve
    // prior identities not present until a later scrape renders the full market.
    const preservedHoldings = previousHoldings.filter(
      (holding) =>
        !completeMarkets.has(holding.type) &&
        !currentOrigins.has(holdingOriginId(holding))
    );
    const events: EventEnvelope[] = [
      ...snapshot.holdings.map((h) => holdingToEvent(h, occurredAt)),
      ...closedEvents,
      balanceToEvent(snapshot, occurredAt),
    ];

    const checkpoint: MidasCheckpoint = {
      last_run: occurredAt.toISOString(),
      active_holdings: [...activeHoldings, ...preservedHoldings],
    };

    await ctx.commit(events, checkpoint);
    return {
      status: "complete",
      metadata: {
        items_found: events.length,
        holdings: snapshot.holdings.length,
        holdings_closed: closedEvents.length,
        markets_observed: snapshot.markets_observed,
        markets_complete: snapshot.markets_complete,
        total_usd: snapshot.total_usd,
        total_try: snapshot.total_try,
        backend: "extension-dom",
      },
    };
  }
}
