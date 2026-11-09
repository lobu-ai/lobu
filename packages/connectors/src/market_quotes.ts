/**
 * Credential-free market marks for deterministic portfolio valuation.
 *
 * This connector exposes two read-only actions and no feeds: `quote` for the
 * current mark and `history` for daily closes over a date range. Results are
 * returned to the caller and are never persisted as raw market-price events.
 */
import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
} from "@lobu/connector-sdk";

type QuoteOk = {
  status: "quoted";
  id: string;
  market: string;
  symbol: string;
  provider_symbol: string;
  price: number;
  currency: string;
  as_of: string;
  stale: boolean;
  tier: "delayed";
  provider: string;
};

type QuoteUnavailable = {
  status: "quote_unavailable";
  id: string;
  market: string;
  symbol: string;
  provider_symbol: string | null;
  provider: string;
  reason: string;
};

type QuoteRow = QuoteOk | QuoteUnavailable;

type HistoryClose = { date: string; close: number };

type HistorySeries = {
  status: "history";
  id: string;
  symbol: string;
  provider_symbol: string;
  currency: string;
  closes: HistoryClose[];
};

type HistoryUnavailable = {
  status: "history_unavailable";
  id: string;
  symbol: string;
  provider_symbol: string | null;
  reason: string;
};

type HistoryRow = HistorySeries | HistoryUnavailable;

type HistoryRange = { from: string; to: string };

type QuoteSymbolInput = {
  market?: string;
  symbol?: string;
  id?: string;
  provider_symbol?: string;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart";
const QUOTE_TIMEOUT_MS = 8_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_CONCURRENT_QUOTES = 5;
const MAX_SYMBOLS = 50;
const MAX_HISTORY_YEARS = 10;
const DAY_SECONDS = 24 * 60 * 60;

export function toProviderSymbol(market: string, symbol: string): string {
  const normalizedMarket = market.trim().toUpperCase();
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) return "";
  if (normalizedMarket === "TR" || normalizedMarket === "BIST") {
    return normalizedSymbol.endsWith(".IS")
      ? normalizedSymbol
      : `${normalizedSymbol}.IS`;
  }
  return normalizedSymbol;
}

export function normalizeSymbolInput(raw: QuoteSymbolInput | string): {
  id: string;
  market: string;
  symbol: string;
  provider_symbol: string;
} {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const separator = trimmed.indexOf(":");
    const market = (
      separator >= 0 ? trimmed.slice(0, separator) : "US"
    ).toUpperCase();
    const symbol = (
      separator >= 0 ? trimmed.slice(separator + 1) : trimmed
    ).toUpperCase();
    return {
      id: `${market}:${symbol}`,
      market,
      symbol,
      provider_symbol: toProviderSymbol(market, symbol),
    };
  }

  const idParts = raw.id?.split(":") ?? [];
  const market = (raw.market ?? idParts[0] ?? "US").trim().toUpperCase();
  const symbol = (raw.symbol ?? idParts.slice(1).join(":") ?? "")
    .trim()
    .toUpperCase();
  const id = (raw.id ?? `${market}:${symbol}`).trim().toUpperCase();
  return {
    id,
    market,
    symbol,
    provider_symbol:
      raw.provider_symbol?.trim() ?? toProviderSymbol(market, symbol),
  };
}

export function parseYahooChartBody(
  body: unknown,
  providerSymbol: string
): { price: number; currency: string; asOf: string } | { error: string } {
  const chart = body as {
    chart?: {
      result?: Array<{
        meta?: {
          regularMarketPrice?: number;
          currency?: string;
          regularMarketTime?: number;
        };
      }>;
      error?: { description?: string; code?: string };
    };
  };
  if (chart.chart?.error) {
    return {
      error:
        chart.chart.error.description ??
        chart.chart.error.code ??
        `quote provider error for ${providerSymbol}`,
    };
  }

  const meta = chart.chart?.result?.[0]?.meta;
  if (
    typeof meta?.regularMarketPrice !== "number" ||
    !Number.isFinite(meta.regularMarketPrice) ||
    meta.regularMarketPrice <= 0
  ) {
    return { error: `no usable price for ${providerSymbol}` };
  }
  const currency = meta.currency?.trim().toUpperCase();
  if (!currency) {
    return { error: `no quote currency for ${providerSymbol}` };
  }
  if (
    typeof meta.regularMarketTime !== "number" ||
    !Number.isFinite(meta.regularMarketTime)
  ) {
    return { error: `no market timestamp for ${providerSymbol}` };
  }
  const asOf = new Date(meta.regularMarketTime * 1_000);
  if (!Number.isFinite(asOf.getTime())) {
    return { error: `invalid market timestamp for ${providerSymbol}` };
  }
  return {
    price: meta.regularMarketPrice,
    currency,
    asOf: asOf.toISOString(),
  };
}

/** The calendar date of a bar in the exchange's own timezone (UTC fallback). */
function exchangeDateFormatter(
  timezone: string | undefined
): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const zone = timezone?.trim();
  if (zone) {
    try {
      return new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone });
    } catch {
      // Unknown IANA name: fall through to UTC.
    }
  }
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
}

function formatExchangeDate(
  formatter: Intl.DateTimeFormat,
  epochSeconds: number
): string {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochSeconds * 1_000))
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function parseYahooHistoryBody(
  body: unknown,
  providerSymbol: string,
  range: HistoryRange
): { currency: string; closes: HistoryClose[] } | { error: string } {
  const chart = body as {
    chart?: {
      result?: Array<{
        meta?: { currency?: string; exchangeTimezoneName?: string };
        timestamp?: unknown[];
        indicators?: { quote?: Array<{ close?: unknown[] }> };
      }>;
      error?: { description?: string; code?: string };
    };
  };
  if (chart.chart?.error) {
    return {
      error:
        chart.chart.error.description ??
        chart.chart.error.code ??
        `history provider error for ${providerSymbol}`,
    };
  }
  const result = chart.chart?.result?.[0];
  if (!result) {
    return { error: `no history for ${providerSymbol}` };
  }
  const currency = result.meta?.currency?.trim().toUpperCase();
  if (!currency) {
    return { error: `no quote currency for ${providerSymbol}` };
  }

  const timestamps = result.timestamp ?? [];
  const closeValues = result.indicators?.quote?.[0]?.close ?? [];
  const formatter = exchangeDateFormatter(result.meta?.exchangeTimezoneName);
  const closes: HistoryClose[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i];
    const close = closeValues[i];
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      typeof close !== "number" ||
      !Number.isFinite(close) ||
      close <= 0
    ) {
      continue;
    }
    const date = formatExchangeDate(formatter, timestamp);
    if (date < range.from || date > range.to) continue;
    // Yahoo can repeat the latest bar; keep one close per exchange date.
    if (closes.at(-1)?.date === date) {
      closes[closes.length - 1] = { date, close };
    } else {
      closes.push({ date, close });
    }
  }
  return { currency, closes };
}

async function requestYahooChart(
  providerSymbol: string,
  query: string,
  fetchImpl: FetchLike
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  if (!providerSymbol) {
    return { ok: false, reason: "missing symbol" };
  }
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(
    providerSymbol
  )}?${query}`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "LobuMarketQuotes/1.0 (+https://lobu.ai)",
      },
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, reason: `quote provider HTTP ${response.status}` };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchYahooQuote(
  providerSymbol: string,
  fetchImpl: FetchLike = fetch
): Promise<
  | { ok: true; price: number; currency: string; asOf: string }
  | { ok: false; reason: string }
> {
  const chart = await requestYahooChart(
    providerSymbol,
    "interval=1d&range=1d",
    fetchImpl
  );
  if (!chart.ok) return chart;
  const parsed = parseYahooChartBody(chart.body, providerSymbol);
  if ("error" in parsed) {
    return { ok: false, reason: parsed.error };
  }
  return {
    ok: true,
    price: parsed.price,
    currency: parsed.currency,
    asOf: parsed.asOf,
  };
}

/** Run `task` for every index with at most MAX_CONCURRENT_QUOTES in flight. */
async function forEachConcurrently(
  count: number,
  task: (index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < count) {
      await task(nextIndex++);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_QUOTES, count) }, () =>
      worker()
    )
  );
}

export async function quoteMany(
  inputs: Array<QuoteSymbolInput | string>,
  options?: { fetchImpl?: FetchLike; now?: Date }
): Promise<QuoteRow[]> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const now = options?.now ?? new Date();
  const normalized = inputs.map(normalizeSymbolInput);
  const results = new Array<QuoteRow>(normalized.length);

  await forEachConcurrently(normalized.length, async (index) => {
    const item = normalized[index];
    if (!item?.symbol || !item.provider_symbol) {
      results[index] = {
        status: "quote_unavailable",
        id: item?.id ?? "UNKNOWN",
        market: item?.market ?? "",
        symbol: item?.symbol ?? "",
        provider_symbol: item?.provider_symbol || null,
        provider: "yahoo",
        reason: "missing symbol",
      };
      return;
    }

    const quote = await fetchYahooQuote(item.provider_symbol, fetchImpl);
    if (!quote.ok) {
      results[index] = {
        status: "quote_unavailable",
        id: item.id,
        market: item.market,
        symbol: item.symbol,
        provider_symbol: item.provider_symbol,
        provider: "yahoo",
        reason: quote.reason,
      };
      return;
    }
    results[index] = {
      status: "quoted",
      id: item.id,
      market: item.market,
      symbol: item.symbol,
      provider_symbol: item.provider_symbol,
      price: quote.price,
      currency: quote.currency,
      as_of: quote.asOf,
      stale: now.getTime() - new Date(quote.asOf).getTime() > STALE_AFTER_MS,
      tier: "delayed",
      provider: "yahoo",
    };
  });
  return results;
}

/** Midnight UTC of a strict `YYYY-MM-DD` calendar date, or null. */
function parseCalendarDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  // Round-tripping rejects non-padded forms and impossible days (2024-02-30).
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function validateHistoryRange(
  from: unknown,
  to: unknown
): HistoryRange | { error: string } {
  const fromDate = parseCalendarDate(from);
  const toDate = parseCalendarDate(to);
  if (!fromDate || !toDate) {
    return { error: "history requires from and to as YYYY-MM-DD dates" };
  }
  if (fromDate > toDate) {
    return { error: "history requires from to be on or before to" };
  }
  const limit = new Date(fromDate);
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_HISTORY_YEARS);
  if (toDate > limit) {
    return {
      error: `history spans at most ${MAX_HISTORY_YEARS} years between from and to`,
    };
  }
  return { from: from as string, to: to as string };
}

export async function historyMany(
  inputs: Array<QuoteSymbolInput | string>,
  range: HistoryRange,
  options?: { fetchImpl?: FetchLike }
): Promise<HistoryRow[]> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const normalized = inputs.map(normalizeSymbolInput);
  const results = new Array<HistoryRow>(normalized.length);
  // Widen the window by a day on each side so every exchange timezone's local
  // `from`..`to` days are fully covered; bars are then filtered by local date.
  const period1 = Date.parse(`${range.from}T00:00:00Z`) / 1_000 - DAY_SECONDS;
  const period2 = Date.parse(`${range.to}T00:00:00Z`) / 1_000 + 2 * DAY_SECONDS;
  const query = `interval=1d&period1=${period1}&period2=${period2}`;

  await forEachConcurrently(normalized.length, async (index) => {
    const item = normalized[index];
    const unavailable = (reason: string): HistoryUnavailable => ({
      status: "history_unavailable",
      id: item?.id ?? "UNKNOWN",
      symbol: item?.symbol ?? "",
      provider_symbol: item?.provider_symbol || null,
      reason,
    });
    if (!item?.symbol || !item.provider_symbol) {
      results[index] = unavailable("missing symbol");
      return;
    }
    const chart = await requestYahooChart(
      item.provider_symbol,
      query,
      fetchImpl
    );
    if (!chart.ok) {
      results[index] = unavailable(chart.reason);
      return;
    }
    const parsed = parseYahooHistoryBody(
      chart.body,
      item.provider_symbol,
      range
    );
    if ("error" in parsed) {
      results[index] = unavailable(parsed.error);
      return;
    }
    results[index] = {
      status: "history",
      id: item.id,
      symbol: item.symbol,
      provider_symbol: item.provider_symbol,
      currency: parsed.currency,
      closes: parsed.closes,
    };
  });
  return results;
}

const symbolsSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_SYMBOLS,
  items: {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        properties: {
          market: { type: "string" },
          symbol: { type: "string" },
          id: { type: "string" },
          provider_symbol: { type: "string" },
        },
      },
    ],
  },
} as const;

const quoteInputSchema = {
  type: "object",
  required: ["symbols"],
  properties: { symbols: symbolsSchema },
} as const;

const historyInputSchema = {
  type: "object",
  required: ["symbols", "from", "to"],
  properties: {
    symbols: symbolsSchema,
    from: {
      type: "string",
      description: "First calendar day (YYYY-MM-DD), inclusive.",
    },
    to: {
      type: "string",
      description:
        "Last calendar day (YYYY-MM-DD), inclusive; at most 10 years after from.",
    },
  },
} as const;

/** Shared symbols-array guard for both actions; null when acceptable. */
function symbolsError(action: string, symbols: unknown): string | null {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return `${action} requires a non-empty symbols array`;
  }
  if (symbols.length > MAX_SYMBOLS) {
    return `${action} accepts at most ${MAX_SYMBOLS} symbols`;
  }
  return null;
}

export default class MarketQuotesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "market.quotes",
    name: "Market Quotes",
    description:
      "Credential-free current market marks and daily close history returned on demand without a price feed.",
    version: "1.1.0",
    faviconDomain: "finance.yahoo.com",
    authSchema: { methods: [{ type: "none" }] },
    actions: {
      quote: {
        key: "quote",
        kind: "read",
        name: "Quote symbols",
        description:
          "Return a quoted or quote_unavailable result for every requested symbol.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: quoteInputSchema as unknown as Record<string, unknown>,
        outputSchema: {
          type: "object",
          required: ["quotes", "quoted", "unavailable", "provider"],
          properties: {
            quotes: { type: "array", items: { type: "object" } },
            quoted: { type: "integer" },
            unavailable: { type: "integer" },
            provider: { type: "string" },
          },
        },
      },
      history: {
        key: "history",
        kind: "read",
        name: "Daily close history",
        description:
          "Return daily closes between from and to (inclusive, exchange-local dates) as a history or history_unavailable entry for every requested symbol.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: historyInputSchema as unknown as Record<string, unknown>,
        outputSchema: {
          type: "object",
          required: ["provider", "series"],
          properties: {
            provider: { type: "string" },
            series: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
    optionsSchema: { type: "object", properties: {} },
  };

  fetchImpl: FetchLike = fetch;

  async execute(ctx: ActionContext): Promise<ActionResult> {
    if (ctx.actionKey === "history") {
      return this.history(ctx.input);
    }
    if (ctx.actionKey !== "quote") {
      return { success: false, error: `Unknown action: ${ctx.actionKey}` };
    }
    const symbols = (ctx.input as { symbols?: unknown }).symbols;
    const invalid = symbolsError("quote", symbols);
    if (invalid) {
      return { success: false, error: invalid };
    }

    const quotes = await quoteMany(
      symbols as Array<QuoteSymbolInput | string>,
      { fetchImpl: this.fetchImpl }
    );
    return {
      success: true,
      output: {
        quotes,
        quoted: quotes.filter((quote) => quote.status === "quoted").length,
        unavailable: quotes.filter(
          (quote) => quote.status === "quote_unavailable"
        ).length,
        provider: "yahoo",
      },
    };
  }

  private async history(input: ActionContext["input"]): Promise<ActionResult> {
    const { symbols, from, to } = input as {
      symbols?: unknown;
      from?: unknown;
      to?: unknown;
    };
    const invalid = symbolsError("history", symbols);
    if (invalid) {
      return { success: false, error: invalid };
    }
    const range = validateHistoryRange(from, to);
    if ("error" in range) {
      return { success: false, error: range.error };
    }
    const series = await historyMany(
      symbols as Array<QuoteSymbolInput | string>,
      range,
      { fetchImpl: this.fetchImpl }
    );
    return { success: true, output: { provider: "yahoo", series } };
  }
}
