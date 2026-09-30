/**
 * Credential-free market marks for deterministic portfolio valuation.
 *
 * This connector exposes one read-only action and no feeds. Quotes are returned
 * to the caller and are never persisted as raw market-price events.
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

async function fetchYahooQuote(
  providerSymbol: string,
  fetchImpl: FetchLike = fetch
): Promise<
  | { ok: true; price: number; currency: string; asOf: string }
  | { ok: false; reason: string }
> {
  if (!providerSymbol) {
    return { ok: false, reason: "missing symbol" };
  }
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(
    providerSymbol
  )}?interval=1d&range=1d`;
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
    const parsed = parseYahooChartBody(await response.json(), providerSymbol);
    if ("error" in parsed) {
      return { ok: false, reason: parsed.error };
    }
    return {
      ok: true,
      price: parsed.price,
      currency: parsed.currency,
      asOf: parsed.asOf,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function quoteMany(
  inputs: Array<QuoteSymbolInput | string>,
  options?: { fetchImpl?: FetchLike; now?: Date }
): Promise<QuoteRow[]> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const now = options?.now ?? new Date();
  const normalized = inputs.map(normalizeSymbolInput);
  const results = new Array<QuoteRow>(normalized.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < normalized.length) {
      const index = nextIndex++;
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
        continue;
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
        continue;
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
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_QUOTES, normalized.length) },
      () => worker()
    )
  );
  return results;
}

const quoteInputSchema = {
  type: "object",
  required: ["symbols"],
  properties: {
    symbols: {
      type: "array",
      minItems: 1,
      maxItems: 50,
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
    },
  },
} as const;

export default class MarketQuotesConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "market.quotes",
    name: "Market Quotes",
    description:
      "Credential-free current market marks returned on demand without a price feed.",
    version: "1.0.0",
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
    },
    optionsSchema: { type: "object", properties: {} },
  };

  fetchImpl: FetchLike = fetch;

  async execute(ctx: ActionContext): Promise<ActionResult> {
    if (ctx.actionKey !== "quote") {
      return { success: false, error: `Unknown action: ${ctx.actionKey}` };
    }
    const symbols = (ctx.input as { symbols?: unknown }).symbols;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return {
        success: false,
        error: "quote requires a non-empty symbols array",
      };
    }
    if (symbols.length > 50) {
      return { success: false, error: "quote accepts at most 50 symbols" };
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
}
