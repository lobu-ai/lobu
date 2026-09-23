import { runSync } from "./sync-harness";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

let GoogleMapsConnector: any;

beforeAll(async () => {
  const mod = await import("../gmaps.connector");
  GoogleMapsConnector = mod.default;
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("GoogleMapsConnector.sync", () => {
  test("searches by business_name then fetches details via the http client", async () => {
    const connector = new GoogleMapsConnector();
    const urls: string[] = [];
    // Override the class-field client with a fake `raw()` (the SDK mock returns
    // an inert client at construction).
    connector.http = {
      raw: async (url: string) => {
        urls.push(url);
        if (url.includes("findplacefromtext")) {
          return jsonResponse({ candidates: [{ place_id: "PID" }] });
        }
        return jsonResponse({
          status: "OK",
          result: {
            name: "Acme",
            url: "https://maps/acme",
            reviews: [
              {
                author_name: "Reviewer",
                rating: 5,
                text: "Great place",
                time: 1_700_000_000,
              },
            ],
          },
        });
      },
    };

    const result = await runSync(connector, {
      feedKey: "reviews",
      config: { GOOGLE_MAPS_API_KEY: "key", business_name: "Acme" },
      checkpoint: null,
    });

    expect(urls[0]).toContain("findplacefromtext");
    expect(urls[1]).toContain("place_id=PID");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload_text).toBe("Great place");
  });

  test("throws with the place-details status when the API returns non-ok", async () => {
    const connector = new GoogleMapsConnector();
    connector.http = {
      raw: async () => jsonResponse({}, 500),
    };

    await expect(
      runSync(connector, {
        feedKey: "reviews",
        config: { GOOGLE_MAPS_API_KEY: "key", place_id: "PID" },
        checkpoint: null,
      })
    ).rejects.toThrow(/Google Places details failed \(500\)/);
  });
});
