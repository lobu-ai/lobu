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
  test("retains validated pagination across a failed or truncated first page", async () => {
    for (const failure of [
      new Response("gateway timeout", { status: 504 }),
      new Response('{"url": "truncated'),
    ]) {
      let saved: CrawlCheckpoint | null = null;
      const stored: EventEnvelope[] = [];
      const broken = new CommonCrawlConnector(source([[capture()]], failure));
      await expect(
        broken.sync({
          feedKey: "captures",
          config,
          checkpoint: null,
          credentials: null,
          entityIds: [],
          commit: async (events, next) => {
            stored.push(...events);
            saved = next;
          },
        })
      ).rejects.toThrow();
      expect(stored).toEqual([]);
      expect(saved).toMatchObject({ next_page: 0, pages: 1 });
      const resumed = new CommonCrawlConnector(async (input) => {
        if (new URL(input).searchParams.has("showNumPages"))
          return new Response("pagination is now unavailable", { status: 504 });
        return new Response(JSON.stringify(capture()));
      });
      const result = await run(resumed, saved);
      expect(result.status).toBe("complete");
      expect(result.events).toHaveLength(1);
      expect(result.checkpoint?.next_page).toBe(1);
    }
  });
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
      "https://user:secret@example.com/",
      "https://a_b.example.com.evil.test:8080/",
    ]) {
      await expect(
        run(new CommonCrawlConnector(source([[capture({ url })]])))
      ).rejects.toThrow();
    }
  });

  test("preserves in-domain captures with ports and underscore subdomains", async () => {
    const urls = [
      "http://example.com:8080/",
      "https://a_b.example.com/",
      "https://a_b.example.com:8443/path",
      "https://example.com/",
    ];
    const connector = new CommonCrawlConnector(
      source([urls.map((url, i) => capture({ url, offset: String(i) }))])
    );
    const result = await run(connector);
    expect(result.status).toBe("complete");
    expect(result.events.map((e) => e.source_url)).toEqual(urls);
    expect(result.events.map((e) => e.metadata?.match)).toEqual([
      "exact_host",
      "subdomain",
      "subdomain",
      "exact_host",
    ]);
    expect((await run(connector)).events).toEqual(result.events);
    expect((await run(connector, result.checkpoint)).events).toEqual([]);
  });

  test("confirmed no-captures metadata completes and persists an empty checkpoint", async () => {
    for (const key of ["error", "message"]) {
      const connector = new CommonCrawlConnector(async (input) =>
        Response.json(
          {
            [key]: `No Captures found for: ${new URL(input).searchParams.get("url")}`,
          },
          { status: 404 }
        )
      );
      const result = await run(connector);
      expect(result.status).toBe("complete");
      expect(result.events).toEqual([]);
      expect(result.checkpoint).toMatchObject({ pages: 0, next_page: 0 });
      expect((await run(connector, result.checkpoint)).events).toEqual([]);
    }
  });

  test("an empty index block advances only that page and retains later captures", async () => {
    const pages = source([[capture()], [], [capture({ offset: "999" })]]);
    const connector = new CommonCrawlConnector(async (input) => {
      const url = new URL(input);
      if (url.searchParams.get("page") === "1")
        return Response.json(
          { error: "No Captures found for: example.com" },
          { status: 404 }
        );
      return pages(input);
    });
    const first = await run(connector);
    const empty = await run(connector, first.checkpoint);
    expect(empty.status).toBe("more");
    expect(empty.events).toEqual([]);
    expect(empty.checkpoint?.next_page).toBe(2);
    const last = await run(connector, empty.checkpoint);
    expect(last.status).toBe("complete");
    expect(last.events).toHaveLength(1);
    expect(last.events[0]?.origin_id).not.toBe(first.events[0]?.origin_id);
  });

  test("unrecognized or mismatched 404 bodies cannot commit empty coverage", async () => {
    for (const body of [
      "",
      "<html>Not found</html>",
      "{",
      JSON.stringify({ error: "No such collection" }),
      JSON.stringify({ error: "No Captures found for: unrelated.example" }),
      JSON.stringify({
        error: "No Captures found for: example.com",
        detail: "proxy",
      }),
    ]) {
      let committed = false;
      await expect(
        new CommonCrawlConnector(
          async () => new Response(body, { status: 404 })
        ).sync({
          feedKey: "captures",
          config,
          checkpoint: null,
          credentials: null,
          entityIds: [],
          commit: async () => {
            committed = true;
          },
        })
      ).rejects.toThrow("coverage unknown");
      expect(committed).toBe(false);
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
          if (!events.length) return;
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
