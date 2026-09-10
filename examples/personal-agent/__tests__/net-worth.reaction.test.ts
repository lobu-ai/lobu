import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import runNetWorthSnapshot, {
  buildFinancialSnapshot,
  type ComponentEventRow,
  dedupeFinancialRows,
  type FinancialEventRow,
  type FinancialSnapshot,
  isoWeekInTimeZone,
  type QuoteRow,
} from "../net-worth.reaction";

function eventRow(
  id: number,
  connectorKey: "midas" | "revolut",
  originId: string,
  metadata: Record<string, unknown>,
  occurredAt = "2026-08-10T08:00:00.000Z"
): FinancialEventRow {
  return {
    id,
    connector_key: connectorKey,
    connection_id: connectorKey === "midas" ? 11 : 12,
    connection_slug: connectorKey,
    origin_id: originId,
    occurred_at: occurredAt,
    metadata,
  };
}

function midas(
  id: number,
  symbol: string,
  overrides: Record<string, unknown> = {}
): FinancialEventRow {
  return eventRow(id, "midas", `midas-holding-US-${symbol}`, {
    symbol,
    type: "US",
    shares: 2,
    price: 100,
    avg_cost: 80,
    value: 200,
    currency: "USD",
    status: "active",
    ...overrides,
  });
}

function revolutPosition(
  id: number,
  portfolioId: string,
  ref: string,
  value: number,
  currency: string
): FinancialEventRow {
  return eventRow(
    id,
    "revolut",
    `revolut-investment-position-${portfolioId}-${ref}`,
    {
      portfolio_id: portfolioId,
      account_type: "Stocks & Shares ISA",
      ref,
      ticker: ref,
      instrument_type: "ETF",
      quantity: 10,
      current_price: value / 10,
      price_currency: currency,
      value,
      value_currency: currency,
      allocation: 0.8,
    }
  );
}

function revolutBalance(
  id: number,
  portfolioId: string,
  balance: number,
  cash: number,
  currency: string
): FinancialEventRow {
  return eventRow(
    id,
    "revolut",
    `revolut-investment-portfolio-${portfolioId}`,
    {
      portfolio_id: portfolioId,
      account_type: "Stocks & Shares ISA",
      balance,
      cash_balance: cash,
      currency,
      position_count: 1,
    }
  );
}

function quote(
  id: string,
  price: number,
  currency: string,
  symbol = id
): QuoteRow {
  return {
    status: "quoted",
    id,
    market: id.startsWith("FX:") ? "FX" : "US",
    symbol,
    provider_symbol: symbol,
    provider: "yahoo",
    price,
    currency,
    as_of: "2026-08-12T08:58:00.000Z",
    stale: false,
    tier: "delayed",
  };
}

function component(
  id: number,
  componentKey: string,
  value: number,
  currency: string,
  overrides: Record<string, unknown> = {}
): ComponentEventRow {
  return {
    id,
    origin_id: `net-worth-component:${componentKey}`,
    occurred_at: "2026-08-10T08:00:00.000Z",
    metadata: {
      schema: "net-worth-component/v1",
      component_key: componentKey,
      source: componentKey.split("-")[0],
      institution: componentKey,
      account_key: componentKey,
      account_type: "balance-sheet",
      asset_class: "cash",
      currency,
      value,
      freshness_days: 30,
      ...overrides,
    },
  };
}

const ctx: ReactionContext = {
  extracted_data: { summary: "Run the deterministic valuation." },
  entities: [],
  window: {
    run_id: 300,
    automation_id: 45,
    window_start: "2026-08-12T08:59:00.000Z",
    window_end: "2026-08-12T09:00:00.000Z",
    granularity: "week",
    content_analyzed: 0,
  },
  automation: {
    id: 45,
    slug: "midas-net-worth",
    name: "Net worth",
    version: 2,
  },
  organization_id: "org-buremba",
  organization_slug: "buremba",
};

describe("financial snapshot builder", () => {
  test("consolidates Midas and Revolut without adding the portfolio total twice", () => {
    const snapshot = buildFinancialSnapshot({
      midasRows: [midas(1, "AAPL")],
      revolutPositionRows: [revolutPosition(2, "isa", "VUAG", 1_000, "GBP")],
      revolutBalanceRows: [revolutBalance(3, "isa", 1_200, 200, "GBP")],
      componentRows: [],
      quoteRows: [
        quote("US:AAPL", 125, "USD", "AAPL"),
        quote("FX:USD:DIRECT", 0.8, "GBP", "USDGBP=X"),
      ],
      previous: null,
      calculatedAt: "2026-08-12T09:00:00.000Z",
    });

    expect(snapshot.schema).toBe("net-worth-snapshot/v4");
    expect(snapshot.net_worth_gbp).toBe(1_400);
    expect(snapshot.positions).toHaveLength(3);
    expect(
      snapshot.positions.find((position) => position.symbol === "AAPL")
    ).toMatchObject({
      source: "midas",
      native_value: 250,
      fx_to_gbp: 0.8,
      value_gbp: 200,
      price_source: "market_quote",
    });
    expect(
      snapshot.sources.find((source) => source.source === "revolut")
    ).toMatchObject({
      position_count: 2,
      portfolio_balance_gbp: 1_200,
      portfolio_reconciliation_residual_gbp: 0,
    });
    expect(snapshot.breakdowns.by_source).toEqual([
      { key: "midas", value_gbp: 200 },
      { key: "revolut", value_gbp: 1_200 },
    ]);
  });

  test("uses broker marks for missing security quotes but never invents FX", () => {
    const fallback = buildFinancialSnapshot({
      midasRows: [midas(1, "NOQUOTE")],
      revolutPositionRows: [],
      revolutBalanceRows: [],
      componentRows: [],
      quoteRows: [quote("FX:USD:DIRECT", 0.8, "GBP", "USDGBP=X")],
      previous: null,
      calculatedAt: "2026-08-12T09:00:00.000Z",
    });
    expect(fallback.positions[0]).toMatchObject({
      price_source: "broker_snapshot",
      native_value: 200,
      value_gbp: 160,
    });
    expect(fallback.sources[0]).toMatchObject({ broker_marked: 1, quoted: 0 });

    expect(() =>
      buildFinancialSnapshot({
        midasRows: [midas(1, "NOQUOTE")],
        revolutPositionRows: [],
        revolutBalanceRows: [],
        componentRows: [],
        quoteRows: [],
        previous: null,
        calculatedAt: "2026-08-12T09:00:00.000Z",
      })
    ).toThrow(/missing a defensible USD.to.GBP FX rate/i);
  });

  test("inverts a GBP-native FX pair and records the fetched symbol", () => {
    const snapshot = buildFinancialSnapshot({
      midasRows: [midas(1, "GARAN", { currency: "TRY", type: "TR" })],
      revolutPositionRows: [],
      revolutBalanceRows: [],
      componentRows: [],
      quoteRows: [
        quote("TR:GARAN", 120, "TRY", "GARAN.IS"),
        quote("FX:TRY:INVERSE", 64, "TRY", "GBPTRY=X"),
      ],
      previous: null,
      calculatedAt: "2026-08-12T09:00:00.000Z",
    });

    expect(snapshot.fx).toContainEqual(
      expect.objectContaining({
        currency: "TRY",
        provider_symbol: "GBPTRY=X",
        inverted: true,
        rate: 0.015625,
      })
    );
  });

  test("adds current balance-sheet observations and preserves valuation ranges", () => {
    const snapshot = buildFinancialSnapshot({
      midasRows: [],
      revolutPositionRows: [],
      revolutBalanceRows: [],
      componentRows: [
        component(1, "chase-cash", 300_000, "GBP"),
        component(2, "kartal-property", 4_500_000, "TRY", {
          source: "property",
          asset_class: "property",
          value_low: 3_500_000,
          value_high: 5_500_000,
          valuation_basis: "market_range_midpoint",
          freshness_days: 365,
        }),
      ],
      quoteRows: [quote("FX:TRY:DIRECT", 0.015, "GBP", "TRYGBP=X")],
      previous: null,
      calculatedAt: "2026-08-12T09:00:00.000Z",
    });

    expect(snapshot.scope).toBe("household_balance_sheet");
    expect(snapshot.net_worth_gbp).toBe(367_500);
    expect(snapshot.net_worth_range_gbp).toEqual({
      low: 352_500,
      high: 382_500,
    });
    expect(snapshot.breakdowns.by_asset_class).toEqual([
      { key: "cash", value_gbp: 300_000 },
      { key: "property", value_gbp: 67_500 },
    ]);
  });

  test("dedupes forked connections by stable source identity, never event id identity", () => {
    const older = midas(10, "AAPL", { value: 100 });
    const newer = {
      ...midas(12, "AAPL", { value: 240 }),
      connection_id: 99,
      connection_slug: "midas-reconnected",
    };
    const distinct = midas(11, "MSFT");

    expect(dedupeFinancialRows([newer, distinct, older])).toEqual([
      distinct,
      newer,
    ]);
  });

  test("a fork that closes a position beats the stale active row from the old connection", () => {
    const staleActive = midas(10, "AAPL", { value: 100 });
    const newerClosed = {
      ...midas(12, "AAPL", { status: "closed" }),
      connection_id: 99,
      connection_slug: "midas-reconnected",
    };
    const snapshot = buildFinancialSnapshot({
      midasRows: [staleActive, newerClosed, midas(11, "MSFT")],
      revolutPositionRows: [],
      revolutBalanceRows: [],
      componentRows: [],
      quoteRows: [quote("FX:USD:DIRECT", 0.8, "GBP", "USDGBP=X")],
      previous: null,
      calculatedAt: "2026-08-12T09:00:00.000Z",
    });

    expect(snapshot.positions.map((position) => position.symbol)).toEqual([
      "MSFT",
    ]);
  });

  test("attributes quantity, price, FX, additions, and disposals exactly to the penny", () => {
    const previous: FinancialSnapshot = buildFinancialSnapshot({
      midasRows: [midas(1, "AAPL", { shares: 1, price: 100, value: 100 })],
      revolutPositionRows: [revolutPosition(2, "isa", "SOLD", 50, "GBP")],
      revolutBalanceRows: [revolutBalance(3, "isa", 50, 0, "GBP")],
      componentRows: [],
      quoteRows: [
        quote("US:AAPL", 100, "USD", "AAPL"),
        quote("FX:USD:DIRECT", 0.8, "GBP", "USDGBP=X"),
      ],
      previous: null,
      calculatedAt: "2026-08-05T09:00:00.000Z",
    });
    const current = buildFinancialSnapshot({
      midasRows: [
        midas(4, "AAPL", { shares: 2, price: 120, value: 240 }),
        midas(5, "NEW", { shares: 1, price: 25, value: 25 }),
      ],
      revolutPositionRows: [],
      revolutBalanceRows: [],
      componentRows: [],
      quoteRows: [
        quote("US:AAPL", 120, "USD", "AAPL"),
        quote("US:NEW", 25, "USD", "NEW"),
        quote("FX:USD:DIRECT", 0.75, "GBP", "USDGBP=X"),
      ],
      previous: { event_id: 900, snapshot: previous },
      calculatedAt: "2026-08-12T09:00:00.000Z",
    });

    expect(current.net_worth_gbp).toBe(198.75);
    expect(current.previous).toMatchObject({
      event_id: 900,
      net_worth_gbp: 130,
    });
    expect(current.attribution).toEqual({
      quantity_gbp: 48.75,
      price_gbp: 32,
      fx_gbp: -12,
      additions_gbp: 18.75,
      disposals_gbp: -50,
      total_gbp: 68.75,
    });
    expect(
      current.attribution.quantity_gbp +
        current.attribution.price_gbp +
        current.attribution.fx_gbp
    ).toBe(current.attribution.total_gbp);
    expect(current.attribution.total_gbp).toBe(
      current.net_worth_gbp - previous.net_worth_gbp
    );
  });

  test("keeps the telescoping attribution invariant across varied position inputs", () => {
    let state = 0x5eed1234;
    const next = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let index = 0; index < 200; index += 1) {
      const q0 = 0.25 + next() * 20;
      const q1 = 0.25 + next() * 20;
      const p0 = 5 + next() * 300;
      const p1 = 5 + next() * 300;
      const fx0 = 0.5 + next();
      const fx1 = 0.5 + next();
      const previous = buildFinancialSnapshot({
        midasRows: [
          midas(1, "PROP", { shares: q0, price: p0, value: q0 * p0 }),
        ],
        revolutPositionRows: [],
        revolutBalanceRows: [],
        componentRows: [],
        quoteRows: [
          quote("US:PROP", p0, "USD", "PROP"),
          quote("FX:USD:DIRECT", fx0, "GBP", "USDGBP=X"),
        ],
        previous: null,
        calculatedAt: "2026-08-05T09:00:00.000Z",
      });
      const current = buildFinancialSnapshot({
        midasRows: [
          midas(2, "PROP", { shares: q1, price: p1, value: q1 * p1 }),
        ],
        revolutPositionRows: [],
        revolutBalanceRows: [],
        componentRows: [],
        quoteRows: [
          quote("US:PROP", p1, "USD", "PROP"),
          quote("FX:USD:DIRECT", fx1, "GBP", "USDGBP=X"),
        ],
        previous: { event_id: 900 + index, snapshot: previous },
        calculatedAt: "2026-08-12T09:00:00.000Z",
      });
      expect(
        Math.round(
          (current.attribution.quantity_gbp +
            current.attribution.price_gbp +
            current.attribution.fx_gbp) *
            100
        )
      ).toBe(Math.round(current.attribution.total_gbp * 100));
      expect(Math.round(current.attribution.total_gbp * 100)).toBe(
        Math.round((current.net_worth_gbp - previous.net_worth_gbp) * 100)
      );
    }
  });

  test("uses one Europe/London ISO-week key across a manually retriggered week", () => {
    expect(isoWeekInTimeZone("2026-08-10T00:01:00.000Z", "Europe/London")).toBe(
      "2026-W33"
    );
    expect(isoWeekInTimeZone("2026-08-16T22:59:00.000Z", "Europe/London")).toBe(
      "2026-W33"
    );
    expect(isoWeekInTimeZone("2026-08-16T23:01:00.000Z", "Europe/London")).toBe(
      "2026-W34"
    );
  });
});

describe("weekly net-worth reaction", () => {
  test("reads both active sources, fetches quotes under run-scoped keys, and saves one versioned snapshot per week", async () => {
    const queries: string[] = [];
    const operationInputs: Array<{
      idempotency_key: string;
      input: { symbols: Array<Record<string, unknown>> };
    }> = [];
    const saved: Array<Record<string, unknown>> = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("connector_key = 'midas'")) return [midas(1, "AAPL")];
        if (sql.includes("semantic_type = 'investment_position'")) {
          return [revolutPosition(2, "isa", "VUAG", 1_000, "GBP")];
        }
        if (sql.includes("semantic_type = 'investment_balance'")) {
          return [revolutBalance(3, "isa", 1_200, 200, "GBP")];
        }
        if (sql.includes("net-worth-component/v1")) return [];
        if (sql.includes("net-worth-snapshot/v4")) return [];
        throw new Error(`Unexpected query: ${sql}`);
      },
      connections: {
        list: async () => ({
          connections: [
            {
              id: 77,
              slug: "market-quotes",
              connector_key: "market.quotes",
              status: "active",
            },
          ],
        }),
      },
      operations: {
        execute: async (input: {
          idempotency_key: string;
          input: { symbols: Array<Record<string, unknown>> };
        }) => {
          operationInputs.push(input);
          return {
            status: "completed",
            output: {
              quotes: input.input.symbols.map((symbol) => {
                const id = String(
                  symbol.id ?? `${symbol.market}:${symbol.symbol}`
                );
                return id.startsWith("FX:USD")
                  ? quote(
                      id,
                      id.endsWith("DIRECT") ? 0.8 : 1.25,
                      id.endsWith("DIRECT") ? "GBP" : "USD",
                      String(symbol.provider_symbol)
                    )
                  : quote(id, 125, "USD", String(symbol.symbol));
              }),
            },
          };
        },
      },
      knowledge: {
        save: async (input: Record<string, unknown>) => {
          saved.push(input);
          return { id: 501, created: true, metadata: input.metadata };
        },
      },
      notifications: {
        send: async () => ({ notified_count: 1, event_id: 502, url: null }),
      },
      log: () => undefined,
    } as unknown as ReactionClient;

    await runNetWorthSnapshot(ctx, client);

    expect(queries).toHaveLength(5);
    expect(queries[0]).toContain("JOIN connections");
    expect(queries[0]).toContain("connections.status = 'active'");
    // Row state is filtered after the write-time dedupe, never in SQL — a
    // prefilter would resurrect a stale active row when the newest fork
    // version of the same identity is closed.
    expect(queries[0]).not.toContain("metadata->>'status'");
    expect(queries[1]).not.toContain("metadata->>'closed'");
    expect(queries[2]).not.toContain("metadata->>'closed'");
    expect(queries[4]).toContain("metadata->>'week' <> '2026-W33'");
    expect(operationInputs.flatMap((input) => input.input.symbols)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ market: "US", symbol: "AAPL" }),
        expect.objectContaining({
          id: "FX:USD:DIRECT",
          provider_symbol: "USDGBP=X",
        }),
        expect.objectContaining({
          id: "FX:USD:INVERSE",
          provider_symbol: "GBPUSD=X",
        }),
      ])
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      semantic_type: "summary",
      title: "Net worth snapshot · 2026-W33",
      idempotency_key: "net-worth:v4:snapshot:week:2026-W33",
      metadata: {
        schema: "net-worth-snapshot/v4",
        week: "2026-W33",
        net_worth_gbp: 1_400,
      },
    });
    // An action idempotency key binds to the parent run that first used it, so
    // a retry of this run must reuse its key while the next run in the same
    // week must not. The snapshot event has no such binding and stays weekly.
    await runNetWorthSnapshot(ctx, client);
    await runNetWorthSnapshot(
      { ...ctx, window: { ...ctx.window, run_id: ctx.window.run_id + 1 } },
      client
    );
    expect(operationInputs.map((input) => input.idempotency_key)).toEqual([
      "net-worth:v4:quotes:run:300:batch:1",
      "net-worth:v4:quotes:run:300:batch:1",
      "net-worth:v4:quotes:run:301:batch:1",
    ]);
    expect(saved.map((row) => row.idempotency_key)).toEqual([
      "net-worth:v4:snapshot:week:2026-W33",
      "net-worth:v4:snapshot:week:2026-W33",
      "net-worth:v4:snapshot:week:2026-W33",
    ]);
  });

  test("fails closed when quotes are needed but the market-quotes connection is absent", async () => {
    const saved: unknown[] = [];
    const client = {
      query: async (sql: string) => {
        if (sql.includes("connector_key = 'midas'")) return [midas(1, "AAPL")];
        return [];
      },
      connections: { list: async () => ({ connections: [] }) },
      knowledge: {
        save: async (input: unknown) => {
          saved.push(input);
          return { id: 501, created: true, metadata: {} };
        },
      },
      log: () => undefined,
    } as unknown as ReactionClient;

    await expect(runNetWorthSnapshot(ctx, client)).rejects.toThrow(
      /active market-quotes connection/i
    );
    expect(saved).toHaveLength(0);
  });
});
