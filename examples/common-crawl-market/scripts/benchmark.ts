/**
 * bun examples/common-crawl-market/scripts/benchmark.ts <companies.json> <report.json>
 * Input: CrawlConfig["company"][], exported by a bounded read-only Market lookup.
 * No defaults containing live records. Output stays local; never calls a Lobu write API.
 * One ZipNum block/page, at most two pages per domain/crawl, six companies maximum.
 * Replay uses recorded responses: no extra load on the public index.
 */
import { writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { file } from "bun";
import CommonCrawlConnector, {
  compareCaptures,
  type CrawlCheckpoint,
  type CrawlConfig,
} from "../common-crawl.connector";
import type { EventEnvelope } from "@lobu/connector-sdk";

const [input, output] = process.argv.slice(2);
if (!input || !output || resolve(input) === resolve(output)) {
  throw new Error(
    "Usage: benchmark.ts <companies.json> <distinct-report.json>"
  );
}
if (await file(output).exists())
  throw new Error("Refusing to overwrite an existing report");
const companies: CrawlConfig["company"][] = await file(input).json();
if (!Array.isArray(companies) || !companies.length || companies.length > 6)
  throw new Error("Provide 1–6 explicit Market companies");
const crawls = ["CC-MAIN-2026-39", "CC-MAIN-2026-43"];
const samples: Array<{
  config: CrawlConfig;
  elapsed_ms: number;
  status: string;
  error?: string;
  checkpoint: CrawlCheckpoint | null;
  events: EventEnvelope[];
  replay_identical?: boolean;
  replay_ms?: number;
  completed_rerun_events?: number;
  requests: Array<{
    url: string;
    status?: number;
    elapsed_ms: number;
    response_headers_ms?: number;
    bytes?: number;
    error?: string;
  }>;
}> = [];
const report = {
  started_at: new Date().toISOString(),
  limits: {
    companies: companies.length,
    pages_per_domain_crawl: 2,
    bytes_per_page: 8 * 1024 * 1024,
    timeout_ms: 20000,
  },
  persistence:
    "Local report only. Replay checks envelope identity; it is not a Postgres ingestion proof.",
  interpretation:
    "Domain evidence is not verified ownership. Exact URL digest differences are payload differences, not business changes. Missing records are unknown coverage, not additions/removals. Bounded pages are not a representative sample.",
  samples,
  comparisons: [] as Array<Record<string, unknown>>,
};
const save = async () => {
  await writeFile(`${output}.tmp`, JSON.stringify(report, null, 2));
  await rename(`${output}.tmp`, output);
};
for (const company of companies) {
  for (const crawl of crawls) {
    const config = { company, crawl };
    const recorded = new Map<string, { status: number; text: string }>();
    const sample: (typeof samples)[number] = {
      config,
      elapsed_ms: 0,
      status: "running",
      checkpoint: null,
      events: [],
      requests: [],
    };
    samples.push(sample);
    const fetcher = async (url: string, init?: RequestInit) => {
      const start = performance.now();
      try {
        const res = await fetch(url, init);
        const request = {
          url,
          status: res.status,
          elapsed_ms: performance.now() - start,
          response_headers_ms: performance.now() - start,
          bytes: 0,
        };
        sample.requests.push(request);
        // Tee through the connector's bounded reader; don't unboundedly buffer the provider.
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        const body = res.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > 8 * 1024 * 1024)
                throw new Error("Response exceeds recording budget");
              chunks.push(chunk);
              controller.enqueue(chunk);
            },
            flush() {
              request.elapsed_ms = performance.now() - start;
              request.bytes = bytes;
              const data = new Uint8Array(bytes);
              let offset = 0;
              for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.length;
              }
              recorded.set(url, {
                status: res.status,
                text: new TextDecoder().decode(data),
              });
            },
          })
        );
        return new Response(body, { status: res.status });
      } catch (error) {
        sample.requests.push({
          url,
          elapsed_ms: performance.now() - start,
          error: String(error),
        });
        throw error;
      }
    };
    const started = performance.now();
    const connector = new CommonCrawlConnector(fetcher);
    try {
      for (let page = 0; page < 2; page++) {
        const result = await connector.sync({
          feedKey: "captures",
          config,
          checkpoint: sample.checkpoint,
          credentials: null,
          entityIds: [],
          commit: async (events, checkpoint) => {
            sample.events.push(...events);
            sample.checkpoint = checkpoint;
          },
        });
        sample.status = result.status;
        if (result.status === "complete") break;
      }
    } catch (error) {
      sample.status = "failed";
      sample.error = String(error);
    }
    sample.elapsed_ms = performance.now() - started;
    const replayStarted = performance.now();
    try {
      // Run the same source pages through the real ConnectorRuntime entrypoint again.
      const replay = new CommonCrawlConnector(async (url) => {
        const response = recorded.get(url);
        if (!response)
          throw new Error("Replay requested an unrecorded source page");
        return new Response(response.text, { status: response.status });
      });
      const replayed: EventEnvelope[] = [];
      let checkpoint: CrawlCheckpoint | null = null;
      // A later upstream failure does not prevent replaying earlier committed pages.
      for (let page = 0; page < (sample.checkpoint?.next_page ?? 0); page++) {
        const result = await replay.sync({
          feedKey: "captures",
          config,
          checkpoint,
          credentials: null,
          entityIds: [],
          commit: async (events, next) => {
            replayed.push(...events);
            checkpoint = next;
          },
        });
        if (result.status === "complete") break;
      }
      sample.replay_identical =
        sample.checkpoint !== null &&
        JSON.stringify(replayed) === JSON.stringify(sample.events);
      if (sample.checkpoint && !sample.replay_identical)
        throw new Error("Replay changed capture identities or provenance");
      if (sample.status === "complete") {
        sample.completed_rerun_events = 0;
        await replay.sync({
          feedKey: "captures",
          config,
          checkpoint,
          credentials: null,
          entityIds: [],
          commit: async (events) => {
            sample.completed_rerun_events = events.length;
          },
        });
      }
    } catch (error) {
      sample.status = "failed";
      sample.error = String(error);
    }
    sample.replay_ms = performance.now() - replayStarted;
    for (const request of sample.requests) {
      const response = recorded.get(request.url);
      if (response)
        request.bytes = new TextEncoder().encode(response.text).length;
    }
    console.log(
      JSON.stringify({
        domain: company.domain,
        crawl,
        status: sample.status,
        elapsed_ms: sample.elapsed_ms,
        captures: sample.events.length,
        error: sample.error,
      })
    );
    await save();
  }
  const pair = samples.slice(-2);
  const before = pair[0],
    after = pair[1];
  if (before && after)
    report.comparisons.push({
      domain: company.domain,
      coverage:
        before.status === "complete" && after.status === "complete"
          ? "complete_index_query"
          : "partial_or_failed",
      ...compareCaptures(before.events, after.events),
    });
  await save();
}
if (
  samples.some(
    (s) => s.status !== "complete" || !s.events.length || !s.replay_identical
  )
)
  process.exitCode = 1;
