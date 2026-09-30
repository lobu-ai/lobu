import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

let MarketQuotesConnector: typeof import("../market_quotes").default;
let normalizeSymbolInput: typeof import("../market_quotes").normalizeSymbolInput;
let parseYahooChartBody: typeof import("../market_quotes").parseYahooChartBody;
let quoteMany: typeof import("../market_quotes").quoteMany;
let toProviderSymbol: typeof import("../market_quotes").toProviderSymbol;

beforeAll(async () => {
  const mod = await import("../market_quotes");
  MarketQuotesConnector = mod.default;
  normalizeSymbolInput = mod.normalizeSymbolInput;
  parseYahooChartBody = mod.parseYahooChartBody;
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

  test("exposes a read-only action and declares no feeds", () => {
    const connector = new MarketQuotesConnector();
    const action = connector.definition.actions?.quote;
    expect(action?.kind).toBe("read");
    expect(action?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(connector.definition.feeds).toBeUndefined();
  });
});
