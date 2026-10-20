import { describe, expect, test } from "bun:test";
import type {
  AutomationScriptContext,
  ReactionClient,
  ReactionContext,
} from "@lobu/connector-sdk";
import ingest, { listingLinks } from "../sahibinden-alerts.script";
import storeReviews, {
  pricePerM2,
  reviews,
} from "../sahibinden-review.reaction";

describe("listingLinks", () => {
  test("reads each listing once from a markdown alert body", () => {
    const body = [
      "[sahibinden.com](https://www.sahibinden.com/?utm_source=emailing)",
      "[DENİZ MANZARALI 2+1](https://www.sahibinden.com/ilan/emlak-konut-satilik-deniz-2-plus1-1000000001/detay/)",
      "#1000000001 Fiyat: 12.600.000 TL",
      "https://www.sahibinden.com/ilan/emlak-konut-satilik-deniz-2-plus1-1000000001/detay?x=1",
      "[arsa](https://www.sahibinden.com/ilan/emlak-arsa-satilik-kas-1000000002/detay/)",
    ].join("\n");
    expect(listingLinks(body, "msg-1")).toEqual([
      {
        url: "https://www.sahibinden.com/ilan/emlak-konut-satilik-deniz-2-plus1-1000000001/detay",
        listing_no: "1000000001",
        email_message_id: "msg-1",
      },
      {
        url: "https://www.sahibinden.com/ilan/emlak-arsa-satilik-kas-1000000002/detay",
        listing_no: "1000000002",
        email_message_id: "msg-1",
      },
    ]);
  });

  test("ignores links that are not listing details", () => {
    expect(
      listingLinks(
        "https://www.sahibinden.com/ilan/no-number/detay https://www.sahibinden.com/ilan/a/b-1/detay",
        "msg-1"
      )
    ).toEqual([]);
  });
});

const listingNo = "1000000001";
const listingUrl = `https://www.sahibinden.com/ilan/fixture-${listingNo}/detay`;
const snapshot = {
  id: 101,
  created_at: "2026-10-20T08:00:00Z",
  metadata: {
    listing_no: listingNo,
    url: listingUrl,
    photos: [],
    price: { amount: 100, currency: "TRY" },
    location: { city: "Antalya", lat: null, lng: null },
  },
};
const reviewItem = { listing_no: listingNo, name: "Fixture apartment" };

describe("review persistence", () => {
  const context = (assets: unknown[]) =>
    ({
      extracted_data: { assets },
      window: { automation_id: 71, run_id: 901 },
    }) as ReactionContext;

  test("creates only once for a repeated listing and calls a pinless location approximate", async () => {
    const created: Array<Record<string, any>> = [];
    const client = {
      query: async (sql: string) =>
        sql.includes("FROM events") ? [snapshot] : [],
      entities: {
        create: async (input: Record<string, any>) => {
          created.push(input);
          return { entity: { id: 301 } };
        },
      },
    } as unknown as ReactionClient;
    await storeReviews(context([reviewItem, reviewItem]), client);
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata.location.precision).toBe("approximate");
  });

  test("preserves other listing links and matches IDs within their portal", async () => {
    const other = {
      portal: "other",
      listing_no: listingNo,
      url: "https://example.com/property",
    };
    const sibling = {
      portal: "sahibinden",
      listing_no: "1000000002",
      url: "https://example.com/sibling",
    };
    const updated: Array<Record<string, any>> = [];
    const client = {
      query: async (sql: string) =>
        sql.includes("FROM events")
          ? [snapshot]
          : [
              {
                id: 301,
                listings: [
                  { portal: "sahibinden", listing_no: listingNo },
                  sibling,
                  other,
                ],
              },
              { id: 302, listings: [other] },
            ],
      entities: {
        update: async (input: Record<string, any>) => updated.push(input),
      },
    } as unknown as ReactionClient;
    await storeReviews(context([reviewItem]), client);
    expect(updated[0]?.entity_id).toBe(301);
    expect(updated[0]?.metadata.listings).toContainEqual(sibling);
    expect(updated[0]?.metadata.listings).toContainEqual(other);
    expect(updated[0]?.metadata.stage).toBeUndefined();
  });

  test("does not create assets for removed snapshots", async () => {
    let writes = 0;
    const client = {
      query: async (sql: string) =>
        sql.includes("FROM events")
          ? [{ ...snapshot, metadata: { ...snapshot.metadata, removed: true } }]
          : [],
      entities: {
        create: async () => {
          writes++;
        },
      },
    } as unknown as ReactionClient;
    await storeReviews(context([reviewItem]), client);
    expect(writes).toBe(0);
  });
});

describe("alert ingestion", () => {
  test("does not treat malformed completed operation results as an empty inbox", async () => {
    const client = {
      connections: {
        list: async () => ({
          connections: [
            { id: 1, connector_key: "google.gmail", status: "active" },
            { id: 2, connector_key: "sahibinden", status: "active" },
          ],
        }),
      },
      operations: {
        execute: async () => ({ status: "completed", output: {} }),
      },
      query: async () => [],
    } as unknown as ReactionClient;
    await expect(
      ingest(
        {
          automation: { id: 71 },
          window: { run_id: 901 },
        } as AutomationScriptContext,
        client
      )
    ).rejects.toThrow("messages");
  });

  test("records removed listings so they cannot consume every later run's read budget", async () => {
    const saved: Array<Record<string, any>> = [];
    const client = {
      connections: {
        list: async () => ({
          connections: [
            { id: 1, connector_key: "google.gmail", status: "active" },
            { id: 2, connector_key: "sahibinden", status: "active" },
          ],
        }),
      },
      operations: {
        execute: async ({ operation_key }: { operation_key: string }) => ({
          status: "completed",
          output:
            operation_key === "search"
              ? { messages: [{ thread_id: "thread-1" }] }
              : operation_key === "get_thread"
                ? { messages: [{ id: "message-1", body: listingUrl }] }
                : { ...snapshot.metadata, removed: true, title: "" },
        }),
      },
      query: async () => [],
      knowledge: {
        save: async (input: Record<string, any>) => saved.push(input),
      },
    } as unknown as ReactionClient;
    await ingest(
      {
        automation: { id: 71 },
        window: { run_id: 901 },
      } as AutomationScriptContext,
      client
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]?.metadata.removed).toBe(true);
    expect(saved[0]?.title).toBe(`sahibinden #${listingNo}`);
    expect(saved[0]?.idempotency_key).toBe(
      `sahibinden:listing.snapshot:${listingNo}`
    );
  });
});

describe("reviews", () => {
  test("keeps valid fields and drops malformed ones", () => {
    const [review] = reviews([
      {
        listing_no: "1000000001",
        name: "2+1 flat, Andifli – Kaş",
        category: "castle",
        area_m2: { net: 85, gross: -1, used: "plot" },
        flags: [
          { kind: "no_elevator", note: "Stairs only.", severity: "urgent" },
          { kind: "x" },
        ],
        corrections: [
          {
            field: "building_age",
            seller_said: "1",
            actual: "15+",
            evidence: "tiles",
          },
          { field: "" },
        ],
        highlights: ["a", "b", "c", "d", "e", "f"],
        agent_summary: " Sea view is real. ",
      },
      { name: "missing number" },
    ]);
    expect(review).toMatchObject({
      category: "other",
      area_m2: { net: 85, gross: undefined, used: "net" },
      flags: [{ kind: "no_elevator", note: "Stairs only.", severity: "low" }],
      corrections: [
        {
          field: "building_age",
          seller_said: "1",
          actual: "15+",
          evidence: "tiles",
        },
      ],
      highlights: ["a", "b", "c", "d", "e"],
      agent_summary: "Sea view is real.",
    });
    expect(reviews([{ name: "missing number" }])).toEqual([]);
  });
});

describe("pricePerM2", () => {
  test("prices TL listings by the chosen area", () => {
    expect(
      pricePerM2(
        { amount: 12_600_000, currency: "TRY" },
        { net: 85, gross: 90, used: "net" }
      )
    ).toBe(148_235);
    expect(
      pricePerM2({ amount: 100, currency: "USD" }, { net: 85, used: "net" })
    ).toBeNull();
    expect(
      pricePerM2(
        { amount: 12_600_000, currency: "TRY" },
        { net: 85, used: "land" }
      )
    ).toBeNull();
  });
});
