import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

let MarketQuotesConnector: typeof import("../market_quotes").default;
let normalizeSymbolInput: typeof import("../market_quotes").normalizeSymbolInput;
let parseYahooChartBody: typeof import("../market_quotes").parseYahooChartBody;
let parseYahooHistoryBody: typeof import("../market_quotes").parseYahooHistoryBody;
let quoteMany: typeof import("../market_quotes").quoteMany;
let toProviderSymbol: typeof import("../market_quotes").toProviderSymbol;

beforeAll(async () => {
  const mod = await import("../market_quotes");
  MarketQuotesConnector = mod.default;
  normalizeSymbolInput = mod.normalizeSymbolInput;
  parseYahooChartBody = mod.parseYahooChartBody;
  parseYahooHistoryBody = mod.parseYahooHistoryBody;
  quoteMany = mod.quoteMany;
  toProviderSymbol = mod.toProviderSymbol;
});

describe("market quote symbol mapping", () => {
  test("maps Midas US and Turkish tickers to Yahoo symbols", () => {
    expect(toProviderSymbol("US", "AAPL")).toBe("AAPL");
    expect(toProviderSymbol("TR", "THYAO")).toBe("THYAO.IS");
    expect(normalizeSymbolInput("TR:THYAO")).toEqual({
      id: "TR:THYAO",
      market: "TR",
      symbol: "THYAO",
      provider_symbol: "THYAO.IS",
    });
  });
});

describe("Yahoo chart parsing", () => {
  test("requires a positive price, currency, and market timestamp", () => {
    expect(
      parseYahooChartBody(
        {
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 201.5,
                  currency: "usd",
                  regularMarketTime: 1_700_000_000,
                },
              },
            ],
          },
        },
        "AAPL"
      )
    ).toEqual({
      price: 201.5,
      currency: "USD",
      asOf: "2023-11-14T22:13:20.000Z",
    });

    expect(
      parseYahooChartBody(
        { chart: { result: [{ meta: { regularMarketPrice: 0 } }] } },
        "NOPE"
      )
    ).toEqual({ error: "no usable price for NOPE" });
  });
});

describe("market quote action", () => {
  test("executes one row per input and never invents zero for an unavailable symbol", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      if (String(input).includes("AAPL")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 250,
                    currency: "USD",
                    regularMarketTime: 1_700_000_000,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ chart: { result: [] } }), {
        status: 200,
      });
    };

    const connector = new MarketQuotesConnector();
    connector.fetchImpl = fetchImpl;
    const result = await connector.execute({
      actionKey: "quote",
      input: {
        symbols: [
          { market: "US", symbol: "AAPL" },
          { market: "US", symbol: "NOPE" },
        ],
      },
      credentials: null,
      config: {},
    });
    const rows = result.output?.quotes as Array<Record<string, unknown>>;

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: "quoted",
      id: "US:AAPL",
      price: 250,
      stale: true,
    });
    expect(rows[1]).toMatchObject({
      status: "quote_unavailable",
      id: "US:NOPE",
    });
    expect(rows[1]).not.toHaveProperty("price");
  });

  test("exposes read-only actions and declares no feeds", () => {
    const connector = new MarketQuotesConnector();
    for (const key of ["quote", "history"]) {
      const action = connector.definition.actions?.[key];
      expect(action?.kind).toBe("read");
      expect(action?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
    expect(connector.definition.feeds).toBeUndefined();
  });
});

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1_000);

function historyBody(
  timezone: string,
  points: Array<[string, number | null]>,
  currency = "TRY"
) {
  return {
    chart: {
      result: [
        {
          meta: { currency, exchangeTimezoneName: timezone },
          timestamp: points.map(([iso]) => unix(iso)),
          indicators: { quote: [{ close: points.map(([, close]) => close) }] },
        },
      ],
    },
  };
}

describe("Yahoo history parsing", () => {
  test("skips unusable closes and dates each bar in the exchange timezone", () => {
    const parsed = parseYahooHistoryBody(
      historyBody("Europe/Istanbul", [
        ["2024-01-02T07:00:00Z", 280.5],
        ["2024-01-03T07:00:00Z", null],
        ["2024-01-04T07:00:00Z", 0],
        // 22:00 UTC on Jan 4 is already Jan 5 in Istanbul (UTC+3).
        ["2024-01-04T22:00:00Z", 284.25],
        ["2024-01-08T07:00:00Z", 290],
      ]),
      "THYAO.IS",
      { from: "2024-01-02", to: "2024-01-05" }
    );
    expect(parsed).toEqual({
      currency: "TRY",
      closes: [
        { date: "2024-01-02", close: 280.5 },
        { date: "2024-01-05", close: 284.25 },
      ],
    });
  });

  test("falls back to UTC when the exchange timezone is missing", () => {
    const body = historyBody("", [["2024-01-04T22:00:00Z", 1.27]], "usd");
    expect(
      parseYahooHistoryBody(body, "GBPUSD=X", {
        from: "2024-01-04",
        to: "2024-01-05",
      })
    ).toEqual({
      currency: "USD",
      closes: [{ date: "2024-01-04", close: 1.27 }],
    });
  });

  test("surfaces a provider error", () => {
    expect(
      parseYahooHistoryBody(
        { chart: { error: { description: "No data found" } } },
        "NOPE",
        { from: "2024-01-02", to: "2024-01-05" }
      )
    ).toEqual({ error: "No data found" });
  });
});

describe("market history action", () => {
  const run = (input: Record<string, unknown>, fetchImpl?: typeof fetch) => {
    const connector = new MarketQuotesConnector();
    if (fetchImpl) connector.fetchImpl = fetchImpl;
    return connector.execute({
      actionKey: "history",
      input,
      credentials: null,
      config: {},
    });
  };

  test("rejects invalid ranges and symbol counts", async () => {
    const symbols = ["US:AAPL"];
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ symbols, from: "2024-01-05", to: "2024-01-02" }, "on or before"],
      [{ symbols, from: "2010-01-01", to: "2024-01-01" }, "10 years"],
      [{ symbols, from: "2024-1-2", to: "2024-01-05" }, "YYYY-MM-DD"],
      [{ symbols, from: "2024-02-30", to: "2024-03-05" }, "YYYY-MM-DD"],
      [{ symbols: [], from: "2024-01-02", to: "2024-01-05" }, "symbols"],
      [
        {
          symbols: Array.from({ length: 51 }, (_, i) => `US:S${i}`),
          from: "2024-01-02",
          to: "2024-01-05",
        },
        "50",
      ],
    ];
    for (const [input, message] of cases) {
      const result = await run(input, async () => {
        throw new Error("validation must reject before fetching");
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
    }
  });

  test("accepts exactly a ten-year span", async () => {
    const result = await run(
      { symbols: ["US:AAPL"], from: "2014-01-01", to: "2024-01-01" },
      async () =>
        new Response(
          JSON.stringify(historyBody("America/New_York", [], "USD")),
          { status: 200 }
        )
    );
    expect(result.success).toBe(true);
  });

  test("returns a series per symbol and keeps going when one symbol fails", async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/AAPL?")) {
        return new Response(
          JSON.stringify(
            historyBody(
              "America/New_York",
              [
                ["2024-01-02T14:30:00Z", 185.64],
                ["2024-01-03T14:30:00Z", 184.25],
              ],
              "USD"
            )
          ),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    };

    const result = await run(
      {
        symbols: [{ market: "US", symbol: "AAPL" }, "US:NOPE"],
        from: "2024-01-02",
        to: "2024-01-03",
      },
      fetchImpl as typeof fetch
    );

    expect(result).toEqual({
      success: true,
      output: {
        provider: "yahoo",
        series: [
          {
            status: "history",
            id: "US:AAPL",
            symbol: "AAPL",
            provider_symbol: "AAPL",
            currency: "USD",
            closes: [
              { date: "2024-01-02", close: 185.64 },
              { date: "2024-01-03", close: 184.25 },
            ],
          },
          {
            status: "history_unavailable",
            id: "US:NOPE",
            symbol: "NOPE",
            provider_symbol: "NOPE",
            reason: "quote provider HTTP 404",
          },
        ],
      },
    });
    const period2 = Number(new URL(urls[0] ?? "").searchParams.get("period2"));
    expect(period2).toBeGreaterThanOrEqual(unix("2024-01-04T00:00:00Z"));
  });
});
