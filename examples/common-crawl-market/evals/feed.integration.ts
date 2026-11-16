import type { Context } from "hono";
import { gzipSync } from "node:zlib";
import { beforeEach, expect, it } from "vitest";
import type { Env } from "../../../packages/server/src/index";
import { streamContent } from "../../../packages/server/src/worker-api";
import { envelopeToContentItem } from "../../../packages/connector-worker/src/executor/runtime";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import { createTestOrganization } from "../../../packages/server/src/__tests__/setup/test-fixtures";
import CommonCrawlConnector, {
  type CrawlCheckpoint,
  type CrawlConfig,
} from "../common-crawl.connector";

beforeEach(cleanupTestDatabase);

it("stores replayed and incremental capture observations through the worker entrypoint without duplicates", async () => {
  const sql = getTestDb();
  const org = await createTestOrganization();
  const [connection] = await sql`
    INSERT INTO connections (organization_id, connector_key, status, visibility, slug)
    VALUES (${org.id}, 'common-crawl-market-spike', 'active', 'org', 'synthetic-crawl') RETURNING id
  `;
  const [feed] = await sql`
    INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule)
    VALUES (${org.id}, ${connection.id}, 'captures', 'active', '0 0 * * *') RETURNING id
  `;
  const [run] = await sql`
    INSERT INTO runs (organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, claimed_by)
    VALUES (${org.id}, 'sync', ${feed.id}, ${connection.id}, 'common-crawl-market-spike', '0.1.0', 'running', 'synthetic-crawl-worker') RETURNING id
  `;
  const config: CrawlConfig = {
    crawl: "CC-MAIN-2026-43",
    company: {
      id: "synthetic:company:1",
      name: "Synthetic Company",
      domain: "example.com",
      source_url: "https://graph.example.test/company/1",
    },
  };
  let failFirstPage = true;
  let paginationUnavailable = false;
  let connector = new CommonCrawlConnector(async (input) => {
    const url = new URL(input);
    if (
      config.company.domain === "empty.example" ||
      url.searchParams.get("page") === "1"
    )
      return Response.json(
        { message: `No Captures found for: ${url.searchParams.get("url")}` },
        { status: 404 }
      );
    if (url.searchParams.has("showNumPages"))
      return paginationUnavailable
        ? new Response("unavailable", { status: 504 })
        : Response.json({ pages: 3, pageSize: 1 });
    const page = Number(url.searchParams.get("page"));
    if (failFirstPage) return new Response("unavailable", { status: 504 });
    return new Response(
      JSON.stringify({
        urlkey: "com,example)/",
        url: page ? "https://a_b.example.com/" : "http://example.com:8080/",
        timestamp: page ? "20261007120000" : "20261006120000",
        status: "200",
        mime: "text/html",
        digest: page ? "DIFFERENT" : "SYNTHETIC",
        filename: `crawl-data/${config.crawl}/segments/synthetic/warc/part.warc.gz`,
        offset: String(100 + page),
        length: "456",
      })
    );
  });
  const sync = async (checkpoint: CrawlCheckpoint | null) => {
    return connector.sync({
      feedKey: "captures",
      config,
      checkpoint,
      credentials: null,
      entityIds: [],
      commit: async (events, next) => {
        const ctx = {
          req: {
            json: async () => ({
              run_id: Number(run.id),
              worker_id: "synthetic-crawl-worker",
              checkpoint: next,
              items: events.map(envelopeToContentItem),
            }),
          },
          var: {},
          json: (body: unknown, status = 200) => ({ body, status }),
        } as unknown as Context<{ Bindings: Env }>;
        const response = (await streamContent(ctx)) as unknown as {
          status: number;
          body: unknown;
        };
        expect(response, JSON.stringify(response.body)).toMatchObject({
          status: 200,
        });
      },
    });
  };
  const stored = () =>
    sql`SELECT origin_id, payload_text, metadata, occurred_at, superseded_by FROM events WHERE connection_id = ${connection.id} ORDER BY origin_id`;
  await expect(sync(null)).rejects.toThrow("page 0 HTTP 504");
  expect(await stored()).toEqual([]);
  const [planned] =
    await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(planned.checkpoint).toMatchObject({ pages: 3, next_page: 0 });
  failFirstPage = false;
  paginationUnavailable = true;
  await sync(planned.checkpoint);
  const first = await stored();
  expect(first).toHaveLength(1);
  expect(first[0].metadata).toMatchObject({
    company: config.company,
    crawl: config.crawl,
    capture: { offset: "100" },
  });
  const [saved] = await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(saved.checkpoint.next_page).toBe(1);
  paginationUnavailable = false;
  await sync(null); // lost acknowledgment / explicit recollect
  expect(await stored()).toEqual(first); // includes historical rows: no silent supersede
  await sync(saved.checkpoint);
  expect(await stored()).toEqual(first); // empty block commits progress without losing captures
  const [emptyPage] =
    await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(emptyPage.checkpoint.next_page).toBe(2);
  await sync(emptyPage.checkpoint);
  expect(await stored()).toHaveLength(2);
  const [completed] =
    await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(completed.checkpoint.next_page).toBe(3);
  await sync(completed.checkpoint);
  expect(await stored()).toHaveLength(2);
  config.crawl = "CC-MAIN-2026-39"; // new source collection, same URLs: separate observations
  await sync(completed.checkpoint);
  const rows = await stored();
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.superseded_by === null)).toBe(true);
  config.company.domain = "empty.example";
  await sync(completed.checkpoint);
  const [emptyCrawl] =
    await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(emptyCrawl.checkpoint).toMatchObject({ pages: 0, next_page: 0 });
  await sync(emptyCrawl.checkpoint);
  expect(await stored()).toEqual(rows); // no-captures never removes earlier evidence
  // Switch source access through the same worker ingestion entrypoint. The
  // observation identity and payload must not depend on how CDX was retrieved.
  config.company.domain = "example.com";
  config.crawl = "CC-MAIN-2026-43";
  config.index_access = "files";
  const body = gzipSync(
    `com,example)/ 20261006120000 ${JSON.stringify({
      url: "http://example.com:8080/",
      status: "200",
      mime: "text/html",
      digest: "SYNTHETIC",
      filename: `crawl-data/${config.crawl}/segments/synthetic/warc/part.warc.gz`,
      offset: "100",
      length: "456",
    })}\n`
  );
  const index = new TextEncoder().encode(
    `com,example)/ 20261006120000\tcdx-00000.gz\t0\t${body.length}\t1\n`
  );
  let failBlock = true;
  connector = new CommonCrawlConnector(async (input, init) => {
    const data = input.endsWith("cluster.idx") ? index : body;
    if (data === body && failBlock)
      return new Response("unavailable", { status: 503 });
    const match = new Headers(init?.headers)
      .get("Range")!
      .match(/^bytes=(\d+)-(\d+)$/)!;
    const start = Number(match[1]),
      end = Math.min(Number(match[2]), data.length - 1);
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${data.length}` },
    });
  });
  await expect(sync(null)).rejects.toThrow("range HTTP 503");
  const [filePlan] =
    await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(filePlan.checkpoint).toMatchObject({
    pages: 1,
    next_page: 0,
    blocks: [{ file: "cdx-00000.gz" }],
  });
  expect(await stored()).toEqual(rows);
  failBlock = false;
  await sync(filePlan.checkpoint);
  expect(await stored()).toEqual(rows);
  const [fileComplete] =
    await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(fileComplete.checkpoint.next_page).toBe(1);
  await sync(null); // same captures via a fresh file lookup do not supersede API evidence
  await sync(fileComplete.checkpoint);
  expect(await stored()).toEqual(rows);
});
