import { afterEach, expect, test } from "bun:test";
import EtsyConnector, { writeContracts } from "../etsy.connector";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const context = {
  config: {
    ETSY_CLIENT_ID: "synthetic-key",
    ETSY_CLIENT_SECRET: "synthetic-secret",
  },
  credentials: {
    provider: "etsy",
    accessToken: "synthetic-token",
    scope: "shops_r listings_r listings_w transactions_r transactions_w",
  },
  input: {},
  checkpoint: null,
  entityIds: [],
};
const calls: { url: string; init?: RequestInit }[] = [];
function setup(handler: (url: URL, init?: RequestInit) => Response) {
  calls.length = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    if (url.pathname.endsWith("/users/me"))
      return Response.json({ shop_id: 123 });
    if (url.pathname.endsWith("/shops/123"))
      return Response.json({ shop_id: 123 });
    return handler(url, init);
  }) as typeof fetch;
}
const connector = new EtsyConnector();
function execute(
  actionKey: string,
  input: Record<string, unknown>,
  extra = {}
) {
  return connector.execute({ ...context, actionKey, input, ...extra } as never);
}

test("write actions require approval and exact scope", () => {
  for (const [key, contract] of Object.entries(writeContracts)) {
    const action = connector.definition.actions![key]!;
    expect(action.requiresApproval).toBe(true);
    expect(action.requiredScopes).toEqual([contract.scope]);
  }
});
test("invalid body and missing scopes cause no requests", async () => {
  setup(() => Response.json({}));
  expect(
    (
      await execute("update_listing", {
        listing_id: 404,
        body: { secret: "no" },
      })
    ).success
  ).toBe(false);
  expect(
    (
      await execute(
        "update_order",
        { receipt_id: 1, body: { was_paid: true } },
        { credentials: { ...context.credentials, scope: "shops_r" } }
      )
    ).success
  ).toBe(false);
  expect(calls).toHaveLength(0);
});
test("foreign listing is never mutated", async () => {
  setup(() => Response.json({ shop_id: 999 }));
  const result = await execute("update_listing", {
    listing_id: 404,
    body: { title: "Example" },
  });
  expect(result.success).toBe(false);
  expect(calls.every((c) => !c.init?.method)).toBe(true);
});
test("listing patch serializes arrays and false values and preserves omitted fields", async () => {
  setup((_url, init) =>
    Response.json(init?.method ? { listing_id: 404 } : { shop_id: 123 })
  );
  expect(
    (
      await execute("update_listing", {
        listing_id: 404,
        body: { title: "A & B", tags: ["blue", "small"], is_supply: false },
      })
    ).success
  ).toBe(true);
  const request = calls.at(-1)!;
  expect(request.init?.method).toBe("PATCH");
  const body = new URLSearchParams(String(request.init?.body));
  expect(body.get("title")).toBe("A & B");
  expect(body.get("tags")).toBe("blue,small");
  expect(body.get("is_supply")).toBe("false");
  expect(body.has("state")).toBe(false);
});
test("inventory replacement preserves full JSON variation and readiness fields", async () => {
  setup((_url, init) => Response.json(init?.method ? {} : { shop_id: 123 }));
  const body = {
    products: [
      {
        sku: "example",
        property_values: [
          { property_id: 1, value_ids: [2], values: ["Small"] },
        ],
        offerings: [
          {
            price: 12.5,
            quantity: 0,
            is_enabled: false,
            readiness_state_id: 10,
          },
        ],
      },
    ],
    readiness_state_on_property: [1],
  };
  expect(
    (await execute("replace_inventory", { listing_id: 404, body })).success
  ).toBe(true);
  expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual(body);
});
test("ambiguous write is attempted once", async () => {
  setup((_url, init) =>
    init?.method
      ? new Response("private provider details", { status: 503 })
      : Response.json({ shop_id: 123 })
  );
  const result = await execute("add_tracking", {
    receipt_id: 42,
    body: { tracking_code: "TEST", carrier_name: "Test" },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("unknown");
  expect(result.error).not.toContain("private");
  expect(calls.filter((c) => c.init?.method)).toHaveLength(1);
});
test("draft and receipt actions use the authenticated shop path", async () => {
  setup(() => Response.json({}));
  expect(
    (
      await execute("create_draft_listing", {
        body: {
          quantity: 1,
          title: "Draft",
          description: "Example",
          price: 1,
          who_made: "i_did",
          when_made: "made_to_order",
          taxonomy_id: 1,
          shipping_profile_id: 2,
          readiness_state_id: 3,
        },
      })
    ).success
  ).toBe(true);
  expect(calls.at(-1)!.url).toContain("/shops/123/listings");
  expect(
    (
      await execute("update_order", {
        receipt_id: 42,
        body: { was_shipped: true },
      })
    ).success
  ).toBe(true);
  expect(calls.at(-1)!.init?.method).toBe("PUT");
});
test("sync reconciles pages with stable source ids and timestamps", async () => {
  setup((url) =>
    Response.json({
      count: 2,
      results: [
        {
          receipt_id: url.searchParams.get("offset") === "0" ? 1 : 2,
          updated_timestamp: 1700000000,
        },
      ],
    })
  );
  const sync = connector.definition.feeds!.orders!.sync!;
  const result = await sync({ ...context, feedKey: "orders" } as never);
  expect(result.events.map((e) => e.origin_id)).toEqual([
    "etsy:orders:1",
    "etsy:orders:2",
  ]);
  expect(result.events[0]!.occurred_at.toISOString()).toBe(
    "2023-11-14T22:13:20.000Z"
  );
  // The shop is resolved once per run, not once per page: Etsy rate-limits by
  // request count and a bounded sync walks up to 100 pages.
  expect(calls.filter((c) => c.url.endsWith("/users/me"))).toHaveLength(1);
});
test("a sync without the feed scope issues no requests", async () => {
  setup(() => Response.json({}));
  await expect(
    connector.definition.feeds!.orders!.sync!({
      ...context,
      feedKey: "orders",
      credentials: { ...context.credentials, scope: "shops_r listings_r" },
    } as never)
  ).rejects.toThrow("transactions_r");
  expect(calls).toHaveLength(0);
});
test("a later page failure does not return a successful checkpoint", async () => {
  setup((url) =>
    url.searchParams.get("offset") === "0"
      ? Response.json({
          count: 2,
          results: [{ transaction_id: 1, created_timestamp: 1700000000 }],
        })
      : new Response("", { status: 403 })
  );
  await expect(
    connector.definition.feeds!.transactions!.sync!({
      ...context,
      feedKey: "transactions",
    } as never)
  ).rejects.toThrow("denied");
});
test("ledger sync fixes the date window across pages and overlaps the last checkpoint", async () => {
  setup((url) =>
    Response.json({
      count: 2,
      results: [
        {
          entry_id: url.searchParams.get("offset") === "0" ? 1 : 2,
          created_timestamp: 1700000000,
        },
      ],
    })
  );
  await connector.definition.feeds!.ledger!.sync!({
    ...context,
    feedKey: "ledger",
    checkpoint: { through: 1700000000 },
  } as never);
  const pages = calls
    .filter((c) => c.url.includes("ledger-entries"))
    .map((c) => new URL(c.url));
  expect(pages).toHaveLength(2);
  expect(pages[0]!.searchParams.get("min_created")).toBe("1699996400");
  expect(pages[0]!.searchParams.get("max_created")).toBe(
    pages[1]!.searchParams.get("max_created")
  );
});

test("ledger continuation retains its original date window", async () => {
  setup(() => Response.json({ count: 2, results: [{ entry_id: 1 }] }));
  const read = connector.definition.feeds!.ledger!.read!;
  const first = await read({
    ...context,
    feedKey: "ledger",
    limit: 1,
  } as never);
  const cursor = JSON.parse(first.nextCursor!);
  expect(cursor.max_created - cursor.min_created).toBe(30 * 86400);
  await read({
    ...context,
    feedKey: "ledger",
    limit: 1,
    cursor: first.nextCursor,
  } as never);
  const pages = calls
    .filter((c) => c.url.includes("ledger-entries"))
    .map((c) => new URL(c.url));
  expect(pages[0]!.searchParams.get("min_created")).toBe(
    pages[1]!.searchParams.get("min_created")
  );
  expect(pages[0]!.searchParams.get("max_created")).toBe(
    pages[1]!.searchParams.get("max_created")
  );
  await expect(
    read({
      ...context,
      config: { ...context.config, min_created: cursor.min_created + 1 },
      feedKey: "ledger",
      cursor: first.nextCursor,
    } as never)
  ).rejects.toThrow("filters changed");
});

test("physical drafts require shipping and processing profiles before fetching", async () => {
  setup(() => Response.json({}));
  const result = await execute("create_draft_listing", {
    body: {
      quantity: 1,
      title: "Test",
      description: "Example",
      price: 1,
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: 1,
    },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("shipping_profile_id");
  expect(calls).toHaveLength(0);
});

test("invalid success response must not invite blind write retry", async () => {
  setup((_url, init) =>
    init?.method ? new Response("not-json") : Response.json({ shop_id: 123 })
  );
  const result = await execute("update_listing", {
    listing_id: 404,
    body: { title: "Test" },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("accepted the write");
  expect(calls.filter((c) => c.init?.method)).toHaveLength(1);
});

test("activity has a readable summary while retaining the full source record", async () => {
  const row = {
    transaction_id: 1,
    created_timestamp: 1700000000,
    title: "Blue earrings",
    quantity: 2,
    price: { amount: 1200, divisor: 100, currency_code: "GBP" },
    receipt_id: 42,
    synthetic_extra_field: "retained",
  };
  setup(() => Response.json({ count: 1, results: [row] }));
  const result = await connector.definition.feeds!.transactions!.sync!({
    ...context,
    feedKey: "transactions",
  } as never);
  expect(result.events[0]!.title).toBe("Etsy Blue earrings");
  expect(result.events[0]!.payload_data).toEqual(row);
});
