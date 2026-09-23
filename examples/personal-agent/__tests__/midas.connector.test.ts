import { runSync } from "./sync-harness";
/**
 * Midas connector — extension dispatcher wiring + dashboard DOM text parsing.
 *
 * Guards:
 *  - prod chrome_dispatcher injection (not ctx.channel)
 *  - Atlas TR "Pozisyonlar" table layout (live capture fixture)
 *  - European number format for both USD and TRY on the TR UI
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ChromeActionDispatcher } from "@lobu/connector-sdk";
import type { MidasCheckpoint } from "../midas.connector";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let MidasConnector: typeof import("../midas.connector").default;
let requireExtensionDispatcher: typeof import("../midas.connector").requireExtensionDispatcher;
let isMidasAuthWall: typeof import("../midas.connector").isMidasAuthWall;
let parseAtlasAmount: typeof import("../midas.connector").parseAtlasAmount;
let parseShares: typeof import("../midas.connector").parseShares;
let parseMidasDashboardText: typeof import("../midas.connector").parseMidasDashboardText;
let holdingToEvent: typeof import("../midas.connector").holdingToEvent;
let balanceToEvent: typeof import("../midas.connector").balanceToEvent;
let MIDAS_DASHBOARD_URL: typeof import("../midas.connector").MIDAS_DASHBOARD_URL;
let MIDAS_ALLOWED_ORIGINS: typeof import("../midas.connector").MIDAS_ALLOWED_ORIGINS;
let MIDAS_DASHBOARD_TEXT_EXPRESSION: typeof import("../midas.connector").MIDAS_DASHBOARD_TEXT_EXPRESSION;

beforeAll(async () => {
  const mod = await import("../midas.connector");
  MidasConnector = mod.default;
  requireExtensionDispatcher = mod.requireExtensionDispatcher;
  isMidasAuthWall = mod.isMidasAuthWall;
  parseAtlasAmount = mod.parseAtlasAmount;
  parseShares = mod.parseShares;
  parseMidasDashboardText = mod.parseMidasDashboardText;
  holdingToEvent = mod.holdingToEvent;
  balanceToEvent = mod.balanceToEvent;
  MIDAS_DASHBOARD_URL = mod.MIDAS_DASHBOARD_URL;
  MIDAS_ALLOWED_ORIGINS = mod.MIDAS_ALLOWED_ORIGINS;
  MIDAS_DASHBOARD_TEXT_EXPRESSION = mod.MIDAS_DASHBOARD_TEXT_EXPRESSION;
});

function dispatcherFor(bodyText: string) {
  return {
    dispatch: async (action: string) =>
      action === "navigate"
        ? { tab_id: 42, current_url: MIDAS_DASHBOARD_URL }
        : { value: bodyText },
  };
}

function syncWith(bodyText: string, checkpoint: MidasCheckpoint | null = {}) {
  return runSync(new MidasConnector(), {
    feedKey: "assets",
    config: {},
    checkpoint,
    sessionState: { chrome_dispatcher: dispatcherFor(bodyText) },
  } as never);
}

// Synthetic Atlas TR "Pozisyonlar" capture — layout mirrors production, values
// are fabricated (no real holdings/quantities/prices) to avoid committing PII.
const DASHBOARD_FIXTURE = readFileSync(
  path.join(import.meta.dir, "fixtures/midas-dashboard-positions.txt"),
  "utf8"
);

const DASHBOARD_WITHOUT_NOVA = DASHBOARD_FIXTURE.replace(
  "\nNOVA\nBIST Hisseleri",
  "\nBIST Hisseleri"
)
  .replace("\n3\n$10.000,00", "\n2\n$3.000,00")
  .replace(
    "\n25\n$280,00\n$260,00\n$7.000,00\n%70,00\n$70,00(%1,00)\n$400,00(%6,00)",
    ""
  );

const DRIFTED_DASHBOARD_FIXTURE = [
  "ABD Hisseleri",
  "ACME",
  "GLOB",
  "2",
  "$1.000,00",
  "$10,00(%1,00)",
  "$100,00(%10,00)",
  "10",
  "$50,00",
  "$40,00",
  "$500,00",
  "%50,00",
  "$5,00(%1,00)",
  "$50,00(%12,50)",
  "n/a",
  "n/a",
  "n/a",
  "n/a",
  "n/a",
  "n/a",
  "n/a",
].join("\n");

// Progressive SPA render: both market headers are painted and each market's
// declared position count is present, but only one ticker row has been
// appended under each. The declared counts (3 US, 2 TR) contradict the single
// row rendered per market, which is what distinguishes this from a portfolio
// where the other holdings were genuinely sold.
const PARTIAL_ROWS_DASHBOARD_FIXTURE = DASHBOARD_FIXTURE.replace(
  "\nGLOB\nNOVA\nBIST",
  "\nBIST"
)
  .replace("\nBANKX\nGOLD.S1", "\nGOLD.S1")
  .replace(
    "\n2,25\n$400,00\n$350,00\n$900,00\n%9,00\n-$20,00(-%2,00)\n$100,00(%12,50)",
    ""
  )
  .replace(
    "\n25\n$280,00\n$260,00\n$7.000,00\n%70,00\n$70,00(%1,00)\n$400,00(%6,00)",
    ""
  )
  .replace(
    "\n1.000\n₺3,00\n₺2,50\n₺3.000,00\n%60,00\n₺30,00(%1,00)\n₺500,00(%20,00)",
    ""
  );

const US_ONLY_DASHBOARD_FIXTURE = [
  "Pozisyonlar",
  "ABD Hisseleri",
  "ACME",
  "1",
  "$2.100,00",
  "$50,00(%1,00)",
  "$500,00(%25,00)",
  "10,5",
  "$200,00",
  "$150,00",
  "$2.100,00",
  "%100,00",
  "$50,00(%1,00)",
  "$500,00(%25,00)",
].join("\n");

const US_ONLY_WITHOUT_COUNT_FIXTURE = US_ONLY_DASHBOARD_FIXTURE.replace(
  "\n1\n$2.100,00",
  "\n$2.100,00"
);

describe("Midas dashboard settle", () => {
  test("waits for numeric position data after headings render", async () => {
    const headingsOnly = [
      "Pozisyonlar",
      "ABD Hisseleri",
      "BIST Hisseleri",
    ].join("\n");
    let reads = 0;
    const document = {
      body: {
        get innerText() {
          reads += 1;
          return reads <= 2 ? headingsOnly : DASHBOARD_FIXTURE;
        },
      },
    };
    const evaluate = Function(
      "document",
      "setTimeout",
      `return ${MIDAS_DASHBOARD_TEXT_EXPRESSION}`
    ) as (
      document: object,
      setTimeout: (callback: () => void) => number
    ) => Promise<string>;

    const result = await evaluate(document, (callback) => {
      callback();
      return 0;
    });

    expect(result).toBe(DASHBOARD_FIXTURE);
    expect(reads).toBeGreaterThan(2);
    // A handful of reads means the loop exited via readiness. Thousands would
    // mean ready() never matched the fixture and the 12s deadline bailed us
    // out — which must fail, not pass slowly.
    expect(reads).toBeLessThan(10);
  });
});

describe("requireExtensionDispatcher", () => {
  test("throws when chrome_dispatcher is missing (the prod failure mode)", () => {
    expect(() => requireExtensionDispatcher({ sessionState: {} })).toThrow(
      /chrome_dispatcher/
    );
    expect(() => requireExtensionDispatcher({ sessionState: null })).toThrow(
      /chrome_dispatcher/
    );
    expect(() => requireExtensionDispatcher({})).toThrow(/chrome_dispatcher/);
  });

  test("does not accept ctx.channel — only sessionState.chrome_dispatcher", () => {
    const channelish = { dispatch: async () => ({}) };
    expect(() =>
      requireExtensionDispatcher({
        sessionState: { channel: channelish } as Record<string, unknown>,
      })
    ).toThrow(/chrome_dispatcher/);
  });

  test("returns the injected chrome_dispatcher handle", () => {
    const handle: ChromeActionDispatcher = {
      dispatch: async () => ({}) as never,
    };
    expect(
      requireExtensionDispatcher({
        sessionState: { chrome_dispatcher: handle },
      })
    ).toBe(handle);
  });
});

describe("isMidasAuthWall", () => {
  test("dashboard is not an auth wall", () => {
    expect(isMidasAuthWall(MIDAS_DASHBOARD_URL)).toBe(false);
    expect(isMidasAuthWall("https://atlas.getmidas.com/dashboard?x=1")).toBe(
      false
    );
  });

  test("login / sso paths are auth walls", () => {
    expect(isMidasAuthWall("https://atlas.getmidas.com/login")).toBe(true);
    expect(isMidasAuthWall("https://atlas.getmidas.com/signin")).toBe(true);
    expect(isMidasAuthWall("https://sso.getmidas.com/oauth")).toBe(true);
    expect(isMidasAuthWall("https://atlas.getmidas.com/auth/callback")).toBe(
      true
    );
  });

  test("does not treat arbitrary substrings as auth walls", () => {
    expect(
      isMidasAuthWall("https://atlas.getmidas.com/dashboard/authorizations")
    ).toBe(false);
  });
});

describe("parseAtlasAmount", () => {
  test("European USD amounts (Atlas TR UI)", () => {
    expect(parseAtlasAmount("$123,45")).toBeCloseTo(123.45, 2);
    expect(parseAtlasAmount("$12.345,67")).toBeCloseTo(12_345.67, 2);
    expect(parseAtlasAmount("$1.000,00")).toBeCloseTo(1_000, 2);
    expect(parseAtlasAmount("$99,90")).toBeCloseTo(99.9, 2);
  });

  test("European TRY amounts", () => {
    expect(parseAtlasAmount("₺45,60")).toBeCloseTo(45.6, 2);
    expect(parseAtlasAmount("₺1.234.567,89")).toBeCloseTo(1_234_567.89, 2);
    expect(parseAtlasAmount("₺2.000.000,00")).toBeCloseTo(2_000_000, 2);
  });

  test("signed amounts and percent annotations", () => {
    expect(parseAtlasAmount("-$1.500,50(-%2,00)")).toBeCloseTo(-1_500.5, 2);
    expect(parseAtlasAmount("$40,00(%0,10)")).toBeCloseTo(40, 2);
    expect(parseAtlasAmount("-₺2.500,75(-%1,50)")).toBeCloseTo(-2_500.75, 2);
  });

  test("must not treat commas as US thousands (old bug)", () => {
    // Old path: strip commas → 12345. New path: 123.45.
    expect(parseAtlasAmount("$123,45")).not.toBeCloseTo(12_345, 0);
    expect(parseAtlasAmount("$123,45")).toBeCloseTo(123.45, 2);
  });
});

describe("parseShares", () => {
  test("fractional US shares use comma decimal", () => {
    expect(parseShares("12,345678")).toBeCloseTo(12.345678, 6);
    expect(parseShares("0,5")).toBeCloseTo(0.5, 6);
  });

  test("TR whole shares use thousand dots", () => {
    expect(parseShares("1.000")).toBe(1_000);
    expect(parseShares("2.500")).toBe(2_500);
    expect(parseShares("10.000")).toBe(10_000);
  });
});

describe("parseMidasDashboardText (synthetic fixture)", () => {
  const snap = () => parseMidasDashboardText(DASHBOARD_FIXTURE);

  test("finds all US + TR holdings from the fixture", () => {
    const s = snap();
    // 3 US + 2 TR synthetic holdings preserving the Atlas TR layout.
    expect(s.holdings).toHaveLength(5);
    const us = s.holdings.filter((h) => h.type === "US");
    const tr = s.holdings.filter((h) => h.type === "TR");
    expect(us).toHaveLength(3);
    expect(tr).toHaveLength(2);
    expect(us.map((h) => h.symbol)).toContain("ACME");
    expect(us.map((h) => h.symbol)).toContain("NOVA");
    expect(tr.map((h) => h.symbol)).toEqual(["BANKX", "GOLD.S1"]);
  });

  test("ACME row: shares, price, avg_cost, value (not the old corrupt mapping)", () => {
    const acme = snap().holdings.find((h) => h.symbol === "ACME");
    expect(acme).toBeDefined();
    expect(acme?.currency).toBe("USD");
    expect(acme?.shares).toBeCloseTo(10.5, 5);
    expect(acme?.price).toBeCloseTo(200, 2);
    expect(acme?.avg_cost).toBeCloseTo(150, 2);
    expect(acme?.value).toBeCloseTo(2_100, 2);
    // Guard against the previous off-by-one that set shares=0, price=avg_cost.
    expect(acme?.shares).toBeGreaterThan(1);
    expect(acme?.price).toBeLessThan(1000);
  });

  test("BANKX TR row uses thousand-grouped shares", () => {
    const y = snap().holdings.find((h) => h.symbol === "BANKX");
    expect(y).toBeDefined();
    expect(y?.currency).toBe("TRY");
    expect(y?.shares).toBe(1_000);
    expect(y?.price).toBeCloseTo(3, 2);
    expect(y?.avg_cost).toBeCloseTo(2.5, 2);
    expect(y?.value).toBeCloseTo(3_000, 2);
  });

  test("section totals", () => {
    const s = snap();
    expect(s.total_usd).toBeCloseTo(10_000, 2);
    expect(s.total_try).toBeCloseTo(5_000, 2);
  });

  test("position value ≈ shares × price for ACME", () => {
    const acme = snap().holdings.find((h) => h.symbol === "ACME");
    expect(acme).toBeDefined();
    if (!acme) return;
    expect(acme.shares * acme.price).toBeCloseTo(acme.value, 0);
  });

  test("empty / unrelated text yields empty snapshot", () => {
    expect(parseMidasDashboardText("nothing here")).toEqual({
      holdings: [],
      total_usd: 0,
      total_try: 0,
      positions_complete: false,
      markets_observed: [],
      markets_complete: [],
    });
  });

  test("malformed rows are skipped, not emitted as zero-valued holdings", () => {
    // Second holding row is non-numeric (layout drift). The parser must stop
    // rather than push a corrupt { shares: 0, price: 0, value: 0 } holding.
    const s = parseMidasDashboardText(DRIFTED_DASHBOARD_FIXTURE);
    expect(s.holdings.map((h) => h.symbol)).toEqual(["ACME"]);
    expect(s.holdings.every((h) => h.value > 0)).toBe(true);
    expect(s.markets_complete).toEqual([]);
  });

  test("does not mistake a section total for an omitted position count", () => {
    const s = parseMidasDashboardText(US_ONLY_WITHOUT_COUNT_FIXTURE);
    expect(s.holdings).toEqual([
      expect.objectContaining({
        type: "US",
        symbol: "ACME",
        shares: 10.5,
        price: 200,
        value: 2_100,
      }),
    ]);
    expect(s.total_usd).toBe(2_100);
    expect(s.markets_complete).toEqual([]);
  });
});

describe("event mapping", () => {
  test("holding origin_id is namespaced by market and carries avg_cost", () => {
    const us = holdingToEvent({
      type: "US",
      symbol: "ACME",
      shares: 10.5,
      price: 200,
      avg_cost: 150,
      value: 2_100,
      currency: "USD",
    });
    expect(us.origin_id).toBe("midas-holding-US-ACME");
    expect(us.metadata).toMatchObject({
      shares: 10.5,
      price: 200,
      avg_cost: 150,
      value: 2_100,
      currency: "USD",
    });
  });

  test("balance event carries both totals", () => {
    const ev = balanceToEvent({
      total_usd: 10_000,
      total_try: 5_000,
    });
    expect(ev.origin_id).toBe("midas-balance");
    expect(ev.metadata).toMatchObject({
      balance: 10_000,
      currency: "USD",
      total_try: 5_000,
    });
  });
});

describe("MidasConnector.sync", () => {
  test("uses sessionState.chrome_dispatcher and emits holdings + balance", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      dispatch: async (action: string, input: Record<string, unknown>) => {
        calls.push({ action, input });
        if (action === "navigate") {
          return {
            tab_id: 42,
            current_url: MIDAS_DASHBOARD_URL,
          };
        }
        if (action === "evaluate") {
          return { value: DASHBOARD_FIXTURE };
        }
        return {};
      },
    };

    const connector = new MidasConnector();
    const res = await runSync(connector, {
      feedKey: "assets",
      config: {},
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    } as never);

    expect(calls[0].action).toBe("navigate");
    expect(calls[0].input.url).toBe(MIDAS_DASHBOARD_URL);
    expect(calls[0].input.wait_for_load).toBe(true);
    expect(calls[0].input.allowed_origins).toEqual([...MIDAS_ALLOWED_ORIGINS]);
    expect(calls[1].action).toBe("evaluate");
    expect(calls[1].input.tab_id).toBe(42);

    // 5 holdings + 1 balance
    expect(res.events).toHaveLength(6);
    const acme = res.events.find(
      (e) => e.origin_id === "midas-holding-US-ACME"
    );
    expect(acme).toBeDefined();
    const acmeMeta = (acme?.metadata ?? {}) as {
      shares?: number;
      price?: number;
      avg_cost?: number;
      value?: number;
    };
    expect(typeof acmeMeta.shares).toBe("number");
    expect(typeof acmeMeta.price).toBe("number");
    expect(acmeMeta.shares as number).toBeCloseTo(10.5, 5);
    expect(acmeMeta.price as number).toBeCloseTo(200, 2);
    expect(acmeMeta.avg_cost as number).toBeCloseTo(150, 2);
    expect(acmeMeta.value as number).toBeCloseTo(2_100, 2);

    const bal = res.events.find((e) => e.origin_id === "midas-balance");
    expect(bal).toBeDefined();
    const balMeta = (bal?.metadata ?? {}) as { balance?: number };
    expect(balMeta.balance as number).toBeCloseTo(10_000, 2);

    expect(res.metadata).toMatchObject({
      holdings: 5,
      backend: "extension-dom",
    });
  });

  test("emits a closed superseding observation when a holding disappears", async () => {
    const first = await syncWith(DASHBOARD_FIXTURE, {});
    const second = await syncWith(DASHBOARD_WITHOUT_NOVA, first.checkpoint);

    expect(
      second.events.filter(
        (event) => event.origin_id === "midas-holding-US-NOVA"
      )
    ).toEqual([
      expect.objectContaining({
        semantic_type: "financial_asset",
        metadata: expect.objectContaining({
          type: "US",
          symbol: "NOVA",
          shares: 0,
          price: 0,
          avg_cost: 0,
          value: 0,
          currency: "USD",
          status: "closed",
        }),
      }),
    ]);

    const third = await syncWith(DASHBOARD_WITHOUT_NOVA, second.checkpoint);
    expect(
      third.events.filter(
        (event) => event.origin_id === "midas-holding-US-NOVA"
      )
    ).toEqual([]);
  });

  test("does not close omitted holdings from partially rendered markets", async () => {
    const first = await syncWith(DASHBOARD_FIXTURE, {});
    const second = await syncWith(
      PARTIAL_ROWS_DASHBOARD_FIXTURE,
      first.checkpoint
    );

    expect(
      second.events
        .filter((event) => event.metadata?.status === "closed")
        .map((event) => event.origin_id)
    ).toEqual([]);
    expect(second.metadata).toMatchObject({
      holdings: 2,
      markets_complete: [],
    });
    expect(
      second.checkpoint?.active_holdings
        ?.map(({ type, symbol }) => `${type}:${symbol}`)
        .sort()
    ).toEqual(["TR:BANKX", "TR:GOLD.S1", "US:ACME", "US:GLOB", "US:NOVA"]);
  });

  test("does not close positions from an incomplete dashboard parse", async () => {
    const first = await syncWith(DASHBOARD_FIXTURE);

    await expect(
      syncWith(DRIFTED_DASHBOARD_FIXTURE, first.checkpoint)
    ).rejects.toThrow(/incomplete/i);
  });

  test("preserves checkpoint positions when their market section is absent", async () => {
    const first = await syncWith(DASHBOARD_FIXTURE);
    const second = await syncWith(US_ONLY_DASHBOARD_FIXTURE, first.checkpoint);

    const closedOrigins = second.events
      .filter((event) => event.metadata?.status === "closed")
      .map((event) => event.origin_id);
    expect(closedOrigins).toEqual([
      "midas-holding-US-GLOB",
      "midas-holding-US-NOVA",
    ]);
    expect(second.checkpoint?.active_holdings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "TR", symbol: "BANKX" }),
        expect.objectContaining({ type: "TR", symbol: "GOLD.S1" }),
      ])
    );
  });

  test("throws a clear error when chrome_dispatcher is missing", async () => {
    const connector = new MidasConnector();
    await expect(
      runSync(connector, {
        feedKey: "assets",
        config: {},
        checkpoint: {},
        sessionState: {},
      } as never)
    ).rejects.toThrow(/chrome_dispatcher/);
  });

  test("throws on auth-wall landing URL and notifies", async () => {
    const calls: string[] = [];
    const dispatcher = {
      dispatch: async (action: string, _input: Record<string, unknown>) => {
        calls.push(action);
        if (action === "navigate") {
          return {
            tab_id: 1,
            current_url: "https://atlas.getmidas.com/login",
          };
        }
        return {};
      },
    };
    const connector = new MidasConnector();
    await expect(
      runSync(connector, {
        feedKey: "assets",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/sign-in/i);
    expect(calls).toContain("show_notification");
  });

  test("throws on unknown feed", async () => {
    const dispatcher = { dispatch: async () => ({}) };
    const connector = new MidasConnector();
    await expect(
      runSync(connector, {
        feedKey: "nope",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/does not support sync/);
  });

  test("throws when dashboard text cannot be parsed", async () => {
    const dispatcher = {
      dispatch: async (action: string) => {
        if (action === "navigate") {
          return { tab_id: 1, current_url: MIDAS_DASHBOARD_URL };
        }
        return { value: "empty shell, no sections" };
      },
    };
    const connector = new MidasConnector();
    await expect(
      runSync(connector, {
        feedKey: "assets",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/Failed to parse Midas dashboard/);
  });
});
