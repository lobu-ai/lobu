import { runSync } from "./sync-harness";
/**
 * Revolut connector — transaction replay and structured Invest snapshots.
 *
 * The bug this guards against: the old DOM-scrape path parsed amounts out of
 * rendered row text and produced corrupt values (a coffee read as £180,611).
 * The retail API returns `amount` as a SIGNED MINOR-UNIT integer, so the fix is
 * `amount / 10^exponent`. The investment cases cover the API/DOM join,
 * completeness checks, stable events, checkpoint closures, and auth failures.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

type RevolutModule = typeof import("../revolut-transactions.connector");
type RevolutTransaction =
  import("../revolut-transactions.connector").RevolutTransaction;

let RevolutTransactionsConnector: RevolutModule["default"];
let filterTransactionsSinceCheckpoint: RevolutModule["filterTransactionsSinceCheckpoint"];
let investmentSnapshotsToEvents: RevolutModule["investmentSnapshotsToEvents"];
let minorToMajor: RevolutModule["minorToMajor"];
let parseInvestmentDomSnapshot: RevolutModule["parseInvestmentDomSnapshot"];
let parseTransactionsResponse: RevolutModule["parseTransactionsResponse"];
let transactionToEvent: RevolutModule["transactionToEvent"];

beforeAll(async () => {
  const mod = await import("../revolut-transactions.connector");
  RevolutTransactionsConnector = mod.default;
  filterTransactionsSinceCheckpoint = mod.filterTransactionsSinceCheckpoint;
  investmentSnapshotsToEvents = mod.investmentSnapshotsToEvents;
  minorToMajor = mod.minorToMajor;
  parseInvestmentDomSnapshot = mod.parseInvestmentDomSnapshot;
  parseTransactionsResponse = mod.parseTransactionsResponse;
  transactionToEvent = mod.transactionToEvent;
});

const INVESTMENT_ACCOUNTS = {
  created: [{ id: "portfolio-gia", accountType: "GIA" }],
  available: [],
};

const INVESTMENT_DOM_ACCOUNTS = [
  {
    accountType: "GIA",
    totalValue: "£72,670.69",
    cashValue: "£6,400.52",
    positions: [
      {
        ref: "S:nvda",
        instrumentType: "EQUITY",
        quantity: "400 NVDA",
        currentPrice: "US$223.93",
        value: "£66,270.17",
        allocation: "27.16%",
      },
    ],
  },
];

const INVESTMENT_RESPONSES = [
  {
    url: "https://invest.revolut.com/api/retail/trading/accounts",
    status: 200,
    body: JSON.stringify(INVESTMENT_ACCOUNTS),
  },
];

// A `transactions/last` array in the shape Revolut actually returns — verified
// against a live authenticated capture (125-row response, conn 369): a JSON
// array of objects with `id`, `type`, `state`, `startedDate` (epoch-ms),
// `currency`, `amount` (SIGNED MINOR-UNIT integer), `description`, and
// `merchant.name`. The live response carries NO `balance` field, so none of
// these rows do either; one row keeps a synthetic balance to exercise the
// optional-balance path. Amounts mirror the prod-corrupt merchants (Whole
// Foods, Whoop) at realistic minor-unit magnitudes.
const SAMPLE_RESPONSE = [
  {
    id: "txn-wholefoods",
    type: "CARD_PAYMENT",
    state: "COMPLETED",
    startedDate: 1_717_000_000_000, // 2024-05-29
    currency: "GBP",
    amount: -19052, // → £190.52, NOT £19,052 (the prod corruption)
    description: "Whole Foods Market",
    category: "groceries",
    countryCode: "GB",
    fee: 0,
    rate: 1,
    merchant: {
      name: "Whole Foods Market",
      mcc: "5411",
      category: "groceries",
      country: "GB",
    },
  },
  {
    id: "txn-coffee",
    type: "CARD_PAYMENT",
    state: "COMPLETED",
    startedDate: 1_717_100_000_000,
    currency: "GBP",
    amount: -480, // → £4.80, NOT £180,611
    description: "Redemption Roasters",
  },
  {
    // A DECLINED card payment — these appear in the live feed (e.g. xAI/Whoop).
    // Kept (not dropped); `state` is stamped so the metric layer can exclude it.
    id: "txn-whoop-declined",
    type: "CARD_PAYMENT",
    state: "DECLINED",
    startedDate: 1_717_150_000_000,
    currency: "GBP",
    amount: -16900, // → £169.00
    merchant: { name: "Whoop" },
    description: "Whoop",
  },
  {
    id: "txn-salary",
    type: "TRANSFER",
    state: "COMPLETED",
    startedDate: 1_717_200_000_000,
    currency: "GBP",
    amount: 350000, // → +£3,500.00 money IN
    balance: 412345, // synthetic — exercises the optional-balance path
    description: "Salary",
  },
  {
    id: "txn-tokyo",
    type: "CARD_PAYMENT",
    state: "COMPLETED",
    startedDate: 1_717_300_000_000,
    currency: "JPY",
    amount: -500, // JPY exponent 0 → ¥500, NOT ¥5
    merchant: { name: "Lawson" },
  },
];

describe("minorToMajor", () => {
  test("divides by 10^2 for default currencies", () => {
    expect(minorToMajor(-19052, "GBP")).toBeCloseTo(-190.52, 2);
    expect(minorToMajor(350000, "USD")).toBeCloseTo(3500, 2);
  });
  test("zero-exponent currencies are whole units", () => {
    expect(minorToMajor(-500, "JPY")).toBe(-500);
    expect(minorToMajor(1500, "KRW")).toBe(1500);
  });
  test("three-exponent currencies divide by 1000", () => {
    expect(minorToMajor(-23450, "KWD")).toBeCloseTo(-23.45, 3);
  });
});

describe("parseTransactionsResponse", () => {
  let txns: RevolutTransaction[];

  beforeAll(() => {
    txns = parseTransactionsResponse(SAMPLE_RESPONSE);
  });

  test("parses all well-formed rows (declines included)", () => {
    expect(txns).toHaveLength(5);
  });

  test("declined transactions are kept and stamped, not dropped", () => {
    const declined = txns.find((t) => t.id === "txn-whoop-declined");
    expect(declined).toBeDefined();
    expect(declined?.state).toBe("DECLINED");
    expect(declined?.amount).toBeCloseTo(169, 2);
  });

  test("amounts are major units — the corruption is gone", () => {
    const byId = Object.fromEntries(txns.map((t) => [t.id, t]));
    expect(byId["txn-wholefoods"].amount).toBeCloseTo(190.52, 2);
    expect(byId["txn-wholefoods"].direction).toBe("out");
    expect(byId["txn-coffee"].amount).toBeCloseTo(4.8, 2);
    expect(byId["txn-salary"].amount).toBeCloseTo(3500, 2);
    expect(byId["txn-salary"].direction).toBe("in");
    expect(byId["txn-tokyo"].amount).toBe(500); // JPY whole units
  });

  test("captures rich fields (category, mcc, country, fee, fx) the API carries", () => {
    const wf = txns.find(
      (t) => t.id === "txn-wholefoods"
    ) as RevolutTransaction;
    expect(wf.category).toBe("groceries");
    expect(wf.mcc).toBe("5411");
    expect(wf.countryCode).toBe("GB");
    expect(wf.merchantCountry).toBe("GB");
    expect(wf.fee).toBe(0);
    expect(wf.fxRate).toBe(1);
    const ev = transactionToEvent(wf);
    expect(ev.metadata).toMatchObject({
      category: "groceries",
      mcc: "5411",
      country_code: "GB",
      merchant_country: "GB",
    });
  });

  test("maps currency, date, state, type, description", () => {
    const wf = txns.find(
      (t) => t.id === "txn-wholefoods"
    ) as RevolutTransaction;
    expect(wf.currency).toBe("GBP");
    expect(wf.state).toBe("COMPLETED");
    expect(wf.type).toBe("CARD_PAYMENT");
    expect(wf.description).toBe("Whole Foods Market"); // merchant.name preferred
    expect(wf.date).toBe(
      new Date(1_717_000_000_000).toISOString().slice(0, 10)
    );
  });

  test("balance is parsed when present, omitted when absent (real shape)", () => {
    const salary = txns.find(
      (t) => t.id === "txn-salary"
    ) as RevolutTransaction;
    const wf = txns.find(
      (t) => t.id === "txn-wholefoods"
    ) as RevolutTransaction;
    expect(salary.balance).toBeCloseTo(4123.45, 2);
    expect(wf.balance).toBeUndefined(); // live rows carry no balance
  });

  test("description falls back to `description` then type", () => {
    const coffee = txns.find(
      (t) => t.id === "txn-coffee"
    ) as RevolutTransaction;
    expect(coffee.description).toBe("Redemption Roasters");
  });

  test("auth-wall error body → [] (so the sync raises the wall)", () => {
    expect(
      parseTransactionsResponse({
        code: 9001,
        message: "Phone and/or passcode are incorrect",
      })
    ).toEqual([]);
  });

  test("skips rows missing id / amount / currency / date", () => {
    const parsed = parseTransactionsResponse([
      { type: "CARD_PAYMENT", amount: -100, currency: "GBP", startedDate: 1 }, // no id
      { id: "x", currency: "GBP", startedDate: 1 }, // no amount
      { id: "y", amount: -100, startedDate: 1 }, // no currency
      { id: "z", amount: -100, currency: "GBP" }, // no date
    ]);
    expect(parsed).toEqual([]);
  });
});

describe("filterTransactionsSinceCheckpoint", () => {
  let txns: RevolutTransaction[];

  beforeAll(() => {
    txns = parseTransactionsResponse(SAMPLE_RESPONSE);
  });

  test("no checkpoint → all (deduped)", () => {
    expect(filterTransactionsSinceCheckpoint(txns, null)).toHaveLength(5);
  });

  test("drops the exact checkpoint id and strictly-older rows", () => {
    const cp = {
      last_transaction_id: "txn-coffee",
      last_timestamp: new Date(1_717_100_000_000).toISOString(),
    };
    const kept = filterTransactionsSinceCheckpoint(txns, cp);
    const ids = kept.map((t) => t.id);
    expect(ids).not.toContain("txn-coffee"); // exact id dropped
    expect(ids).not.toContain("txn-wholefoods"); // older minute dropped
    expect(ids).toContain("txn-salary"); // newer kept
    expect(ids).toContain("txn-tokyo");
  });

  test("backfill mode (null checkpoint) re-emits rows a checkpoint would drop", () => {
    // The connector's `backfill` config passes `null` here so historical rows
    // older than the stored checkpoint are re-ingested (gateway dedups by id).
    const cp = {
      last_transaction_id: "txn-salary",
      last_timestamp: new Date(1_717_200_000_000).toISOString(),
    };
    const incremental = filterTransactionsSinceCheckpoint(txns, cp);
    const backfill = filterTransactionsSinceCheckpoint(txns, null);
    expect(incremental.length).toBeLessThan(backfill.length);
    expect(backfill).toHaveLength(5);
  });
});

describe("transactionToEvent", () => {
  test("origin_id, payload, and metadata match the transaction shape", () => {
    const [wf] = parseTransactionsResponse([SAMPLE_RESPONSE[0]]);
    const ev = transactionToEvent(wf);
    expect(ev.origin_id).toBe("revolut-txn-wholefoods");
    expect(ev.semantic_type).toBe("transaction");
    expect(ev.payload_text).toContain("Whole Foods Market");
    expect(ev.payload_text).toContain("-£190.52");
    expect(ev.metadata).toMatchObject({
      amount: wf.amount,
      direction: "out",
      currency: "GBP",
      transaction_type: "CARD_PAYMENT",
      state: "COMPLETED",
    });
  });
});

describe("Revolut Finance snapshots", () => {
  test("joins stable account ids to structured investment table values", () => {
    const snapshots = parseInvestmentDomSnapshot(
      INVESTMENT_RESPONSES,
      INVESTMENT_DOM_ACCOUNTS
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      portfolioId: "portfolio-gia",
      accountType: "GIA",
      totalValue: 72670.69,
      valueCurrency: "GBP",
      cashValue: 6400.52,
      positions: [
        {
          ref: "S:nvda",
          ticker: "NVDA",
          instrumentType: "EQUITY",
          quantity: 400,
          currentPrice: 223.93,
          priceCurrency: "USD",
          value: 66270.17,
          valueCurrency: "GBP",
          allocation: 0.2716,
        },
      ],
    });
  });

  test("emits one stable portfolio total and stable position events", () => {
    const [snapshot] = parseInvestmentDomSnapshot(
      INVESTMENT_RESPONSES,
      INVESTMENT_DOM_ACCOUNTS
    );
    const occurredAt = new Date("2026-08-12T17:25:00.000Z");
    const events = investmentSnapshotsToEvents([snapshot], occurredAt);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      origin_id: "revolut-investment-portfolio-portfolio-gia",
      semantic_type: "investment_balance",
      occurred_at: occurredAt,
      metadata: {
        portfolio_id: "portfolio-gia",
        account_type: "GIA",
        balance: 72670.69,
        currency: "GBP",
        cash_balance: 6400.52,
        position_count: 1,
      },
    });
    expect(events[1]).toMatchObject({
      origin_id: "revolut-investment-position-portfolio-gia-S:nvda",
      semantic_type: "investment_position",
      occurred_at: occurredAt,
      metadata: {
        portfolio_id: "portfolio-gia",
        ticker: "NVDA",
        quantity: 400,
        current_price: 223.93,
        value: 66270.17,
      },
    });
  });

  test("supersedes holdings and portfolios that vanished since the last sync", () => {
    // Lobu upserts on (connection_id, origin_id). A poll that simply omits a
    // sold holding leaves the previous row standing as current forever, so a
    // disappearance has to be emitted, not implied.
    const [snapshot] = parseInvestmentDomSnapshot(
      INVESTMENT_RESPONSES,
      INVESTMENT_DOM_ACCOUNTS
    );
    const occurredAt = new Date("2026-08-12T17:30:00.000Z");
    const previous = [
      {
        portfolio_id: "portfolio-gia",
        account_type: "GIA",
      },
      {
        portfolio_id: "portfolio-gia",
        account_type: "GIA",
        ref: "S:nvda",
        ticker: "NVDA",
      },
      // Sold between syncs.
      {
        portfolio_id: "portfolio-gia",
        account_type: "GIA",
        ref: "S:tsla",
        ticker: "TSLA",
      },
      // Whole portfolio closed between syncs.
      {
        portfolio_id: "portfolio-isa",
        account_type: "TAX_ADVANTAGED",
      },
    ];

    const events = investmentSnapshotsToEvents(
      [snapshot],
      occurredAt,
      previous
    );
    const byId = new Map(events.map((event) => [event.origin_id, event]));

    // Still held: unchanged, and emitted exactly once.
    expect(
      events.filter(
        (e) =>
          e.origin_id === "revolut-investment-position-portfolio-gia-S:nvda"
      )
    ).toHaveLength(1);
    expect(
      byId.get("revolut-investment-position-portfolio-gia-S:nvda")?.metadata
    ).toMatchObject({ quantity: 400, value: 66270.17 });

    // Sold: superseded under the SAME origin id, so the stale row is replaced.
    expect(
      byId.get("revolut-investment-position-portfolio-gia-S:tsla")
    ).toMatchObject({
      semantic_type: "investment_position",
      occurred_at: occurredAt,
      metadata: {
        closed: true,
        quantity: 0,
        value: 0,
        portfolio_id: "portfolio-gia",
        ref: "S:tsla",
        ticker: "TSLA",
      },
    });

    // Closed portfolio: same treatment on the balance stream.
    expect(
      byId.get("revolut-investment-portfolio-portfolio-isa")
    ).toMatchObject({
      semantic_type: "investment_balance",
      occurred_at: occurredAt,
      metadata: {
        closed: true,
        balance: 0,
        position_count: 0,
        portfolio_id: "portfolio-isa",
        account_type: "TAX_ADVANTAGED",
      },
    });
  });

  test("emits no closure events when there is no prior sync to compare", () => {
    const [snapshot] = parseInvestmentDomSnapshot(
      INVESTMENT_RESPONSES,
      INVESTMENT_DOM_ACCOUNTS
    );

    for (const previous of [undefined, []]) {
      const events = investmentSnapshotsToEvents(
        [snapshot],
        new Date("2026-08-12T17:25:00.000Z"),
        previous
      );
      expect(events).toHaveLength(2);
      expect(events.some((e) => e.metadata?.closed === true)).toBe(false);
    }
  });

  test("rejects a partial response set when an active account is missing", () => {
    const partial = INVESTMENT_RESPONSES.map((response) =>
      response.url.endsWith("/trading/accounts")
        ? {
            ...response,
            body: JSON.stringify({
              created: [
                { id: "portfolio-gia", accountType: "GIA" },
                { id: "portfolio-isa", accountType: "TAX_ADVANTAGED" },
              ],
            }),
          }
        : response
    );

    expect(
      parseInvestmentDomSnapshot(partial, INVESTMENT_DOM_ACCOUNTS)
    ).toEqual([]);
  });

  test("accepts repeated identical account responses from one reload", () => {
    const repeated = [...INVESTMENT_RESPONSES, ...INVESTMENT_RESPONSES];

    expect(
      parseInvestmentDomSnapshot(repeated, INVESTMENT_DOM_ACCOUNTS)
    ).toHaveLength(1);
  });

  test("rejects a half-rendered position table", () => {
    const partial = [
      {
        ...INVESTMENT_DOM_ACCOUNTS[0],
        totalValue: "£140,000.00",
      },
    ];

    expect(parseInvestmentDomSnapshot(INVESTMENT_RESPONSES, partial)).toEqual(
      []
    );
  });

  // The extension supplies both arguments across a process boundary, so their
  // declared shapes are claims. These fail closed rather than throwing.
  test("skips intercepted responses with no url instead of throwing", () => {
    const malformed = [{ status: 200 }, null, ...INVESTMENT_RESPONSES] as never;

    expect(
      parseInvestmentDomSnapshot(malformed, INVESTMENT_DOM_ACCOUNTS)
    ).toHaveLength(1);
  });

  test("rejects a dom account whose positions never rendered", () => {
    const noPositions = [
      { ...INVESTMENT_DOM_ACCOUNTS[0], positions: undefined },
    ] as never;

    expect(
      parseInvestmentDomSnapshot(INVESTMENT_RESPONSES, noPositions)
    ).toEqual([]);
  });

  test("sync targets the real Invest app and never stores the raw response", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      async dispatch(action: string, input: Record<string, unknown>) {
        calls.push({ action, input });
        if (action === "navigate") return { tab_id: 42 };
        if (action === "network_intercept_start") {
          return { session_id: "invest-session" };
        }
        if (action === "network_intercept_drain") {
          return { responses: INVESTMENT_RESPONSES };
        }
        if (action === "evaluate") {
          return {
            value: {
              authed: true,
              ready: true,
              host: "invest.revolut.com",
              path: "/home",
              accounts: INVESTMENT_DOM_ACCOUNTS,
            },
          };
        }
        return {};
      },
    };
    const connector = new RevolutTransactionsConnector();

    const result = await runSync(connector, {
      feedKey: "balances",
      sessionState: { chrome_dispatcher: dispatcher },
      checkpoint: {
        investment_refs: [
          {
            portfolio_id: "portfolio-gia",
            account_type: "GIA",
            ref: "S:tsla",
            ticker: "TSLA",
          },
        ],
      },
    } as never);

    expect(
      calls.some(
        (call) =>
          call.action === "navigate" &&
          call.input.url === "https://invest.revolut.com/home"
      )
    ).toBe(true);
    expect(result.events.map((event) => event.semantic_type)).toEqual([
      "investment_balance",
      "investment_position",
      "investment_position",
    ]);
    expect(result.events[2]).toMatchObject({
      origin_id: "revolut-investment-position-portfolio-gia-S:tsla",
      metadata: { closed: true, quantity: 0, value: 0 },
    });
    expect(result.checkpoint).toEqual({
      investment_refs: [
        {
          portfolio_id: "portfolio-gia",
          account_type: "GIA",
        },
        {
          portfolio_id: "portfolio-gia",
          account_type: "GIA",
          ref: "S:nvda",
          ticker: "NVDA",
        },
      ],
    });
    expect(JSON.stringify(result.events)).not.toContain("created");

    const domExpression = calls.find(
      (call) =>
        call.action === "evaluate" &&
        String(call.input.expression).includes("stock-logo/")
    )?.input.expression;
    expect(typeof domExpression).toBe("string");

    const dom = new JSDOM(
      `<main>
        <section>
          <div id="gia-summary"><span>General Investment</span><span>£72,670.69</span></div>
          <table data-state="ready">
            <tbody><tr aria-rowindex="1"><td id="cash" data-column-id="totalBalance">£6,400.52</td></tr></tbody>
          </table>
          <table data-state="ready">
            <tbody><tr aria-rowindex="1">
              <td data-column-id="ASSET"><span style="background-image: url('https://assets.revolut.com/stock-logo/S:nvda-40x40.png')"></span></td>
              <td id="type" data-column-id="TYPE">EQUITY</td>
              <td id="quantity" data-column-id="QUANTITY">400 NVDA</td>
              <td id="price" data-column-id="CURRENT_PRICE">US$223.93</td>
              <td id="value" data-column-id="MARKET_VALUE">£66,270.17</td>
              <td id="allocation" data-column-id="ALLOCATION">27.16%</td>
            </tr></tbody>
          </table>
        </section>
      </main>`,
      {
        url: "https://invest.revolut.com/home",
        runScripts: "outside-only",
      }
    );
    const renderedText: Record<string, string> = {
      "gia-summary": "General Investment\n£72,670.69",
      cash: "£6,400.52",
      type: "EQUITY",
      quantity: "400 NVDA",
      price: "US$223.93",
      value: "£66,270.17",
      allocation: "27.16%",
    };
    for (const [id, innerText] of Object.entries(renderedText)) {
      Object.defineProperty(
        dom.window.document.getElementById(id),
        "innerText",
        {
          configurable: true,
          value: innerText,
        }
      );
    }

    const domResult = await dom.window.eval(domExpression as string);
    expect(domResult).toMatchObject({
      authed: true,
      ready: true,
      accounts: INVESTMENT_DOM_ACCOUNTS,
    });
  });

  test("does not report success when interception cleanup fails", async () => {
    const dispatcher = {
      async dispatch(action: string) {
        if (action === "navigate") return { tab_id: 42 };
        if (action === "network_intercept_start") {
          return { session_id: "invest-session" };
        }
        if (action === "network_intercept_drain") {
          return { responses: INVESTMENT_RESPONSES };
        }
        if (action === "network_intercept_stop") {
          throw new Error("debugger cleanup failed");
        }
        if (action === "evaluate") {
          return {
            value: {
              authed: true,
              ready: true,
              accounts: INVESTMENT_DOM_ACCOUNTS,
            },
          };
        }
        return {};
      },
    };
    const connector = new RevolutTransactionsConnector();

    await expect(
      runSync(connector, {
        feedKey: "balances",
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow("debugger cleanup failed");
  });

  test("surfaces the original failure, not the cleanup failure, when both fail", async () => {
    const dispatcher = {
      async dispatch(action: string) {
        if (action === "navigate") return { tab_id: 42 };
        if (action === "network_intercept_start") {
          return { session_id: "invest-session" };
        }
        if (action === "network_intercept_drain") {
          throw new Error("drain exploded");
        }
        if (action === "network_intercept_stop") {
          throw new Error("debugger cleanup failed");
        }
        if (action === "evaluate") {
          return {
            value: {
              authed: true,
              ready: true,
              accounts: INVESTMENT_DOM_ACCOUNTS,
            },
          };
        }
        return {};
      },
    };
    const connector = new RevolutTransactionsConnector();

    // A throw inside `finally` replaces the in-flight exception. The drain
    // failure is the actionable one; the cleanup failure must not mask it.
    await expect(
      runSync(connector, {
        feedKey: "balances",
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow("drain exploded");
  });

  test("stops interception and requests login after a redirect", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    let evaluateCount = 0;
    const dispatcher = {
      async dispatch(action: string, input: Record<string, unknown>) {
        calls.push({ action, input });
        if (action === "navigate") return { tab_id: 42 };
        if (action === "network_intercept_start") {
          return { session_id: "invest-session" };
        }
        if (action === "network_intercept_drain") return { responses: [] };
        if (action === "evaluate") {
          evaluateCount += 1;
          return {
            value:
              evaluateCount === 1
                ? {
                    authed: true,
                    href: "https://invest.revolut.com/home",
                  }
                : {
                    authed: false,
                    href: "https://sso.revolut.com/passcode",
                  },
          };
        }
        return {};
      },
    };
    const connector = new RevolutTransactionsConnector();

    await expect(
      runSync(connector, {
        feedKey: "balances",
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/no investment data returned/);
    expect(calls.some((call) => call.action === "network_intercept_stop")).toBe(
      true
    );
    expect(calls.some((call) => call.action === "focus_tab")).toBe(true);
    expect(calls.some((call) => call.action === "show_notification")).toBe(
      true
    );
  });

  test("turns an Invest API 401 into a visible auth failure", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      async dispatch(action: string, input: Record<string, unknown>) {
        calls.push({ action, input });
        if (action === "navigate") return { tab_id: 42 };
        if (action === "network_intercept_start") {
          return { session_id: "invest-session" };
        }
        if (action === "network_intercept_drain") {
          return {
            responses: [
              {
                url: INVESTMENT_RESPONSES[0].url,
                status: 401,
                body: '{"code":9001}',
              },
            ],
          };
        }
        if (action === "evaluate") {
          return {
            value: {
              authed: true,
              ready: true,
              href: "https://invest.revolut.com/home",
              accounts: [],
            },
          };
        }
        return {};
      },
    };
    const connector = new RevolutTransactionsConnector();

    await expect(
      runSync(connector, {
        feedKey: "balances",
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/no investment data returned/);
    expect(calls.some((call) => call.action === "network_intercept_stop")).toBe(
      true
    );
    expect(calls.some((call) => call.action === "focus_tab")).toBe(true);
    expect(calls.some((call) => call.action === "show_notification")).toBe(
      true
    );
  });

  test("fails visibly instead of storing an empty snapshot", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    let evaluateCount = 0;
    const dispatcher = {
      async dispatch(action: string, input: Record<string, unknown>) {
        calls.push({ action, input });
        if (action === "navigate") return { tab_id: 42 };
        if (action === "network_intercept_start") {
          return { session_id: "invest-session" };
        }
        if (action === "network_intercept_drain") return { responses: [] };
        if (action === "evaluate") {
          evaluateCount += 1;
          return {
            value: {
              authed: true,
              ready: evaluateCount === 1,
              href: "https://invest.revolut.com/home",
            },
          };
        }
        return {};
      },
    };
    const connector = new RevolutTransactionsConnector();

    await expect(
      runSync(connector, {
        feedKey: "balances",
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/No balance was stored/);
    expect(calls.some((call) => call.action === "network_intercept_stop")).toBe(
      true
    );
  });

  test("focuses the Invest passcode wall and requests login", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      async dispatch(action: string, input: Record<string, unknown>) {
        calls.push({ action, input });
        if (action === "navigate") return { tab_id: 42 };
        if (action === "evaluate") {
          return {
            value: {
              authed: false,
              href: "https://sso.revolut.com/passcode",
            },
          };
        }
        return {};
      },
    };
    const connector = new RevolutTransactionsConnector();

    await expect(
      runSync(connector, {
        feedKey: "balances",
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/needs sign-in \(no investment data returned/);
    expect(calls.some((call) => call.action === "focus_tab")).toBe(true);
    expect(calls.some((call) => call.action === "show_notification")).toBe(
      true
    );
  });
});
