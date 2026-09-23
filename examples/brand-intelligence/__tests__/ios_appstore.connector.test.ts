import { runSync } from "./sync-harness";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

let IOSAppStoreConnector: any;

beforeAll(async () => {
  const mod = await import("../ios_appstore.connector");
  IOSAppStoreConnector = mod.default;
});

function reviewEntry(id: string, updated: string, rating = "5") {
  return {
    id: { label: id },
    title: { label: `t-${id}` },
    content: { label: `body-${id}` },
    author: { name: { label: "Author" } },
    updated: { label: updated },
    "im:rating": { label: rating },
  };
}

function feedResponse(entries: unknown[], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ feed: { entry: entries } }),
    text: async () => "body",
  } as unknown as Response;
}

describe("IOSAppStoreConnector.sync", () => {
  test("page 1 non-ok throws via the adopted http client", async () => {
    const connector = new IOSAppStoreConnector();
    connector.http = { raw: async () => feedResponse([], 503) };

    await expect(
      runSync(connector, {
        feedKey: "reviews",
        config: { app_id: "123", country: "US" },
        checkpoint: {},
      })
    ).rejects.toThrow(/RSS feed returned 503/);
  });

  test("a non-ok response past page 1 ends the feed (break, not throw)", async () => {
    const connector = new IOSAppStoreConnector();
    let page = 0;
    connector.http = {
      raw: async () => {
        page++;
        if (page === 1)
          return feedResponse([reviewEntry("r1", "2026-03-01T00:00:00Z")]);
        return feedResponse([], 500); // page 2 fails -> treated as end of feed
      },
    };

    const result = await runSync(connector, {
      feedKey: "reviews",
      config: { app_id: "123", country: "US" },
      checkpoint: {},
    });

    // Page 1's review survives; the page-2 failure stopped paging without error.
    expect(result.events).toHaveLength(1);
    expect(result.events[0].origin_id).toBe("r1");
  });
});
