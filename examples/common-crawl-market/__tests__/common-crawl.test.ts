import { describe, expect, test } from "bun:test";
import CommonCrawlConnector, {
  compareCaptures,
  type CrawlCheckpoint,
  type CrawlConfig,
} from "../common-crawl.connector";
import type { EventEnvelope } from "@lobu/connector-sdk";

const config: CrawlConfig = {
  crawl: "CC-MAIN-2026-43",
  company: {
    id: "synthetic:company:1",
    name: "Synthetic Company",
    domain: "example.com",
    source_url: "https://graph.example.test/company/1",
  },
};
const capture = (overrides: Record<string, unknown> = {}) => ({
  urlkey: "com,example)/",
  url: "https://example.com/",
  timestamp: "20261006120000",
  status: "200",
  mime: "text/html",
  digest: "SYNTHETICDIGEST",
  filename: "crawl-data/CC-MAIN-2026-43/segments/synthetic/warc/part.warc.gz",
  offset: "123",
  length: "456",
  ...overrides,
});

function source(pages: unknown[][], badPage?: Response) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.has("showNumPages")) {
      return Response.json({
        pages: pages.length,
        pageSize: 1,
        blocks: pages.length,
      });
    }
    if (badPage) return badPage.clone();
    return new Response(
      pages[Number(url.searchParams.get("page"))]
        ?.map((x) => JSON.stringify(x))
        .join("\n") ?? ""
    );
  };
}

async function run(
  connector: CommonCrawlConnector,
  checkpoint: CrawlCheckpoint | null = null,
  cfg = config
) {
  const events: EventEnvelope[] = [];
  let saved = checkpoint;
  const result = await connector.sync({
    feedKey: "captures",
    config: cfg,
    checkpoint,
    credentials: null,
    entityIds: [],
    commit: async (page, next) => {
      events.push(...page);
      saved = next;
    },
  });
  return { ...result, events, checkpoint: saved };
}

describe("Common Crawl feed spike", () => {
  test("deduplicates identical page rows but rejects conflicting capture identities", async () => {
    expect(
      (await run(new CommonCrawlConnector(source([[capture(), capture()]]))))
        .events
    ).toHaveLength(1);
    await expect(
      run(
        new CommonCrawlConnector(
          source([[capture(), capture({ digest: "CONFLICT" })]])
        )
      )
    ).rejects.toThrow("Conflicting CDX");
  });

  test("rejects invalid scope inputs, checkpoints, pagination and empty pages", async () => {
    for (const domain of [
      "example.com/path",
      "example.com?x=1",
      "https://example.com",
      "127.0.0.1",
      "user@example.com",
      "example.com:443",
    ]) {
      await expect(
        run(new CommonCrawlConnector(source([[capture()]])), null, {
          ...config,
          company: { ...config.company, domain },
        })
      ).rejects.toThrow();
    }
    const connector = new CommonCrawlConnector(source([[capture()]]));
    const first = await run(connector);
    await expect(
      run(connector, { ...first.checkpoint!, next_page: -1 })
    ).rejects.toThrow("checkpoint");
    for (const pages of [-1, 1.5, "1", 10001])
      await expect(
        run(
          new CommonCrawlConnector(async () =>
            Response.json({ pages, pageSize: 1 })
          )
        )
      ).rejects.toThrow("pagination");
    await expect(run(new CommonCrawlConnector(source([[]])))).rejects.toThrow(
      "Empty"
    );
    expect((await run(new CommonCrawlConnector(source([])))).events).toEqual(
      []
    );
  });

  test("conflicting simultaneous captures, missing digests and changed query URLs are not comparable", async () => {
    const first = await run(
      new CommonCrawlConnector(
        source([[capture(), capture({ digest: "CONFLICT", offset: "2" })]])
      )
    );
    const second = await run(new CommonCrawlConnector(source([[capture()]])));
    expect(compareCaptures(first.events, second.events).comparable_urls).toBe(
      0
    );
    const missing = await run(
      new CommonCrawlConnector(source([[capture({ digest: "-" })]]))
    );
    expect(compareCaptures(missing.events, second.events).comparable_urls).toBe(
      0
    );
    const query = await run(
      new CommonCrawlConnector(
        source([[capture({ url: "https://example.com/?v=2" })]])
      )
    );
    expect(compareCaptures(query.events, second.events).shared_urls).toBe(0);
  });
  test("commits bounded pages, resumes and completes without re-emitting", async () => {
    const connector = new CommonCrawlConnector(
      source([[capture()], [capture({ offset: "999" })]])
    );
    const first = await run(connector);
    expect(first.status).toBe("more");
    expect(first.checkpoint?.next_page).toBe(1);
    const second = await run(connector, first.checkpoint);
    expect(second.status).toBe("complete");
    expect(second.events[0]?.origin_id).not.toBe(first.events[0]?.origin_id);
    expect((await run(connector, second.checkpoint)).events).toEqual([]);
    const replay = await run(connector);
    expect(replay.events).toEqual(first.events);
    expect(first.events[0]?.metadata).toMatchObject({
      company: config.company,
      crawl: config.crawl,
      match: "exact_host",
      capture: { offset: "123", length: "456", digest: "SYNTHETICDIGEST" },
    });
    expect(first.events[0]?.occurred_at.toISOString()).toBe(
      "2026-10-06T12:00:00.000Z"
    );
  });

  test("keeps ambiguous domain association as evidence and rejects unrelated hosts", async () => {
    const result = await run(
      new CommonCrawlConnector(
        source([
          [
            capture({ url: "https://www.example.com/", offset: "1" }),
            capture({ url: "https://shop.example.com/", offset: "2" }),
          ],
        ])
      )
    );
    expect(result.events.map((e) => e.metadata?.match)).toEqual([
      "subdomain",
      "subdomain",
    ]);
    for (const url of [
      "https://notexample.com/",
      "https://example.com.evil.test/",
      "https://example.com@evil.test/",
      "file:///example.com",
    ]) {
      await expect(
        run(new CommonCrawlConnector(source([[capture({ url })]])))
      ).rejects.toThrow();
    }
  });

  test.each([
    429, 502, 504, 404,
  ])("HTTP %s never becomes empty coverage or a checkpoint", async (status) => {
    let committed = false;
    const connector = new CommonCrawlConnector(
      async () => new Response("failure", { status })
    );
    await expect(
      connector.sync({
        feedKey: "captures",
        config,
        checkpoint: null,
        credentials: null,
        entityIds: [],
        commit: async () => {
          committed = true;
        },
      })
    ).rejects.toThrow(`HTTP ${status}`);
    expect(committed).toBe(false);
  });

  test("malformed, truncated and oversized responses cannot commit partial progress", async () => {
    for (const body of [
      `${JSON.stringify(capture())}\n{`,
      "x".repeat(8 * 1024 * 1024 + 1),
    ]) {
      await expect(
        run(new CommonCrawlConnector(source([[]], new Response(body))))
      ).rejects.toThrow();
    }
    for (const change of [
      { timestamp: "20260230120000" },
      { offset: "1.5" },
      { filename: "../../secret" },
      { urlkey: null },
    ]) {
      await expect(
        run(new CommonCrawlConnector(source([[capture(change)]])))
      ).rejects.toThrow();
    }
  });

  test("failed commit leaves caller checkpoint reusable with identical identities", async () => {
    const connector = new CommonCrawlConnector(source([[capture()]]));
    let attempted: EventEnvelope[] = [];
    await expect(
      connector.sync({
        feedKey: "captures",
        config,
        checkpoint: null,
        credentials: null,
        entityIds: [],
        commit: async (events) => {
          attempted = events;
          throw new Error("synthetic commit failure");
        },
      })
    ).rejects.toThrow("synthetic commit failure");
    expect((await run(connector)).events).toEqual(attempted);
  });

  test("a different crawl or company mapping replays; IDs describe captures, not mapping or run time", async () => {
    const connector = new CommonCrawlConnector(source([[capture()]]));
    const first = await run(connector);
    const renamed = await run(connector, first.checkpoint, {
      ...config,
      company: { ...config.company, name: "Renamed" },
    });
    expect(renamed.events[0]?.origin_id).toBe(first.events[0]?.origin_id);
    const next = await run(
      new CommonCrawlConnector(
        source([
          [
            capture({
              filename:
                "crawl-data/CC-MAIN-2026-39/segments/synthetic/warc/part.warc.gz",
            }),
          ],
        ])
      ),
      first.checkpoint,
      { ...config, crawl: "CC-MAIN-2026-39" }
    );
    expect(next.events[0]?.origin_id).not.toBe(first.events[0]?.origin_id);
  });

  test("comparison only attributes digest differences to jointly observed successful URLs", async () => {
    const before = await run(
      new CommonCrawlConnector(
        source([
          [capture(), capture({ url: "https://example.com/old", offset: "2" })],
        ])
      )
    );
    const after = await run(
      new CommonCrawlConnector(
        source([
          [
            capture({ digest: "DIFFERENT" }),
            capture({ url: "https://example.com/new", offset: "3" }),
          ],
        ])
      )
    );
    expect(compareCaptures(before.events, after.events)).toMatchObject({
      shared_urls: 1,
      comparable_urls: 1,
      digest_different: 1,
      only_before: 1,
      only_after: 1,
    });
    const errors = await run(
      new CommonCrawlConnector(source([[capture({ status: "404" })]]))
    );
    expect(compareCaptures(before.events, errors.events).comparable_urls).toBe(
      0
    );
  });
});
