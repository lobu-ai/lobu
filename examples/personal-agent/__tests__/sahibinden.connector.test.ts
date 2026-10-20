import { describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

const {
  default: SahibindenConnector,
  fullSizePhotoUrl,
  LISTING_EXPRESSION,
  parseListingDate,
  parseListingUrl,
  parsePrice,
  readListing,
  toListingRead,
} = await import("../sahibinden.connector");

const LISTING_URL =
  "https://www.sahibinden.com/ilan/emlak-konut-satilik-deniz-manzarali-2-plus1-daire-1000000001/detay";
const PHOTO = "https://i0.shbdn.com/photos/00/00/01/x5_1000000001abc.jpg";

const page = {
  path: "/ilan/emlak-konut-satilik-deniz-manzarali-2-plus1-daire-1000000001/detay",
  title: "DENİZ MANZARALI 2+1 DAİRE",
  price_text: "12.600.000 TL",
  location_links: ["Antalya", "Kaş", "Andifli Mah."],
  lat: "36.1961",
  lng: "29.6519",
  attributes: {
    "İlan No": "1000000001",
    "İlan Tarihi": "15 Ekim 2026",
    "m² (Net)": "85",
    Kimden: "Emlak Ofisinden",
  },
  description: "Full sea view.",
  photos: [
    PHOTO,
    "https://i0.shbdn.com/photos/00/00/01/thmb_1000000001abc.jpg",
    "https://i0.shbdn.com/photos/00/00/01/x16_1000000001abc.avif",
  ],
  seller_name: "Example Emlak",
  removed: false,
};

describe("parseListingUrl", () => {
  test("canonicalizes a listing link from an alert email", () => {
    expect(parseListingUrl(`${LISTING_URL}/?utm_source=emailing`)).toEqual({
      url: LISTING_URL,
      listing_no: "1000000001",
    });
  });

  test("rejects other hosts and non-listing paths", () => {
    expect(parseListingUrl(LISTING_URL.replace("www.", "secure."))).toBeNull();
    expect(parseListingUrl("https://www.sahibinden.com/arama?x=1")).toBeNull();
    expect(
      parseListingUrl("https://www.sahibinden.com/ilan/no-number-here/detay")
    ).toBeNull();
  });
});

describe("value parsing", () => {
  test("reads Turkish grouped prices", () => {
    expect(parsePrice("12.600.000 TL")).toEqual({
      amount: 12_600_000,
      currency: "TRY",
    });
    expect(parsePrice("Fiyat bilgisi yok")).toBeNull();
  });

  test("reads Turkish listing dates", () => {
    expect(parseListingDate("15 Ekim 2026")).toBe("2026-10-15");
    expect(parseListingDate("1 Şubat 2027")).toBe("2027-02-01");
    expect(parseListingDate("yesterday")).toBeNull();
    expect(parseListingDate("31 Şubat 2027")).toBeNull();
    expect(parseListingDate("1  Şubat 2027")).toBe("2027-02-01");
  });

  test("keeps only the full-size JPEG of each photo", () => {
    expect(
      fullSizePhotoUrl(
        "https://i0.shbdn.com/photos/00/00/01/thmb_1000000001abc.jpg"
      )
    ).toBe(PHOTO);
    expect(
      fullSizePhotoUrl(
        "https://i0.shbdn.com/photos/00/00/01/x16_1000000001abc.avif"
      )
    ).toBeNull();
  });
});

describe("toListingRead", () => {
  test("shapes the page read", () => {
    const read = toListingRead(
      { url: LISTING_URL, listing_no: "1000000001" },
      page
    );
    expect(read).toEqual({
      listing_no: "1000000001",
      url: LISTING_URL,
      title: "DENİZ MANZARALI 2+1 DAİRE",
      price: { amount: 12_600_000, currency: "TRY" },
      price_text: "12.600.000 TL",
      location: {
        city: "Antalya",
        district: "Kaş",
        quarter: "Andifli Mah.",
        lat: 36.1961,
        lng: 29.6519,
      },
      attributes: { "m² (Net)": "85", Kimden: "Emlak Ofisinden" },
      description: "Full sea view.",
      photos: [PHOTO],
      seller: { name: "Example Emlak", type: "agency" },
      listed_on: "2026-10-15",
      removed: false,
    });
  });

  test("marks an owner listing", () => {
    const read = toListingRead(
      { url: LISTING_URL, listing_no: "1000000001" },
      { ...page, attributes: { Kimden: "Sahibinden" } }
    );
    expect(read.seller.type).toBe("owner");
  });
});

function dispatcher(evaluate: () => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    dispatcher: {
      dispatch: async (action: string) => {
        calls.push(action);
        if (action === "navigate") return { tab_id: 9 };
        if (action === "evaluate") return evaluate();
        return { ok: true };
      },
    } as import("@lobu/connector-sdk").ChromeActionDispatcher,
  };
}

describe("readListing", () => {
  test("rejects a different listing after navigation", async () => {
    for (const wrongPage of [
      { ...page, path: page.path.replace("1000000001", "1000000002") },
      { ...page, attributes: { ...page.attributes, "İlan No": "1000000002" } },
    ]) {
      const { dispatcher: d, calls } = dispatcher(async () => ({
        value: wrongPage,
      }));
      await expect(
        readListing(d, { url: LISTING_URL, listing_no: "1000000001" })
      ).rejects.toThrow("requested listing");
      expect(calls.at(-1)).toBe("close_tab");
    }
  });

  test("retries an evaluate detached by the bot-check reload, then closes the tab", async () => {
    let attempts = 0;
    const { dispatcher: d, calls } = dispatcher(async () => {
      attempts++;
      if (attempts === 1) throw new Error("Detached while handling command.");
      return { value: page };
    });
    const read = await readListing(d, {
      url: LISTING_URL,
      listing_no: "1000000001",
    });
    expect(read.title).toBe("DENİZ MANZARALI 2+1 DAİRE");
    expect(calls).toEqual(["navigate", "evaluate", "evaluate", "close_tab"]);
  });

  test("names the bot check instead of returning an empty listing", async () => {
    const { dispatcher: d, calls } = dispatcher(async () => ({
      value: { path: "/cs/checkLoading", blocked: true, title: "" },
    }));
    await expect(
      readListing(d, { url: LISTING_URL, listing_no: "1000000001" })
    ).rejects.toThrow("bot check");
    expect(calls.at(-1)).toBe("close_tab");
  });
});

describe("removed listings", () => {
  test("requires an explicit removal notice on redirected pages", async () => {
    const evaluate = new Function(
      "location",
      "document",
      "Date",
      `return ${LISTING_EXPRESSION}`
    );
    for (const pathname of [
      "/satilik-arsa/antalya-kas-kas",
      "/kullanici-girisi",
    ]) {
      let now = 0;
      const read = await evaluate(
        { hostname: "www.sahibinden.com", pathname },
        {
          body: { innerText: "Sign in or browse listings" },
          querySelector: () => null,
          querySelectorAll: () => [],
        },
        { now: () => (now += 21_000) }
      );
      expect(read.removed).toBe(false);
    }
    let now = 0;
    const removed = await evaluate(
      {
        hostname: "www.sahibinden.com",
        pathname: "/satilik-arsa/antalya-kas-kas",
      },
      {
        body: { innerText: "Bu ilan yayından kaldırılmıştır" },
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      { now: () => (now += 21_000) }
    );
    expect(removed.removed).toBe(true);
  });

  test("reports a taken-down listing instead of failing", async () => {
    const { dispatcher: d } = dispatcher(async () => ({
      value: {
        path: "/satilik-arsa/antalya-kas-kas",
        blocked: false,
        removed: true,
        title: "",
      },
    }));
    const read = await readListing(d, {
      url: LISTING_URL,
      listing_no: "1000000001",
    });
    expect(read.removed).toBe(true);
  });
});

describe("fetch_photos", () => {
  test("refuses URLs off the photo CDN without fetching", async () => {
    const connector = new SahibindenConnector();
    const result = await connector.execute({
      actionKey: "fetch_photos",
      input: { urls: ["https://example.com/photos/x5_1.jpg"] },
      credentials: null,
      config: {},
    });
    expect(result).toEqual({
      success: false,
      error: "urls must be sahibinden photo URLs",
    });
  });

  test("returns fetched photos as attachments", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      })) as unknown as typeof fetch;
    try {
      const connector = new SahibindenConnector();
      const result = await connector.execute({
        actionKey: "fetch_photos",
        input: { urls: [PHOTO, PHOTO] },
        credentials: null,
        config: {},
      });
      expect(result).toEqual({
        success: true,
        output: {
          fetched: 1,
          failed: [],
          attachments: [
            {
              filename: "x5_1000000001abc.jpg",
              mime_type: "image/jpeg",
              data: "AQID",
              size_bytes: 3,
            },
          ],
        },
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
