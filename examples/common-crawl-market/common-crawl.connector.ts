import {
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

// Local spike only: no registration, credentials, graph writes or new platform contracts.
// A company is an explicit source-backed Market candidate, not an inferred owner.
export interface CrawlConfig {
  crawl: string;
  company: { id: string; name: string; domain: string; source_url: string };
}
export interface CrawlCheckpoint {
  scope: string;
  next_page: number;
  pages: number;
}
interface Capture {
  urlkey: string;
  timestamp: string;
  url: string;
  status: string;
  mime: string;
  digest: string;
  filename: string;
  offset: string;
  length: string;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 5000;

function captureHost(url: URL): string {
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("Expected an HTTP(S) URL without credentials");
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function host(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  const name = captureHost(url);
  if (url.port) throw new Error("Expected a domain without port");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error("Expected a DNS domain");
  }
  return name;
}

function checkedConfig(config: CrawlConfig): CrawlConfig {
  if (!/^CC-MAIN-20\d{2}-\d{2}$/.test(config.crawl))
    throw new Error("Explicit crawl ID required");
  const company = config.company;
  if (!company?.id || !company.name || !company.source_url)
    throw new Error("Market source evidence required");
  const domain = host(company.domain);
  const parsed = new URL(`https://${company.domain}`);
  if (
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    company.domain.includes(":")
  )
    throw new Error("Company domain must be a bare hostname");
  const ref = new URL(company.source_url);
  if (ref.protocol !== "https:" || ref.username || ref.password)
    throw new Error("Invalid company source reference");
  return {
    crawl: config.crawl,
    company: {
      id: company.id,
      name: company.name,
      domain,
      source_url: company.source_url,
    },
  };
}

function indexUrl(config: CrawlConfig, page?: number): string {
  const url = new URL(`https://index.commoncrawl.org/${config.crawl}-index`);
  url.search = new URLSearchParams({
    // Pagination metadata is JSON already; *.domain is the documented shorthand.
    ...(page === undefined
      ? {
          url: `*.${config.company.domain}`,
          showNumPages: "true",
          pageSize: "1",
        }
      : {
          url: config.company.domain,
          matchType: "domain",
          output: "json",
          pageSize: "1",
          page: String(page),
        }),
  }).toString();
  return url.href;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing index response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES)
        throw new Error("Index page exceeds 8 MiB; no checkpoint advanced");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function captureDate(timestamp: string): Date {
  if (!/^\d{14}$/.test(timestamp)) throw new Error("Invalid capture timestamp");
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw new Error("Invalid capture date");
  return date;
}

function parseCapture(value: unknown, config: CrawlConfig): Capture {
  if (!value || typeof value !== "object")
    throw new Error("Invalid CDX record");
  const row = value as Record<string, unknown>;
  for (const key of [
    "urlkey",
    "timestamp",
    "url",
    "status",
    "mime",
    "digest",
    "filename",
    "offset",
    "length",
  ]) {
    if (typeof row[key] !== "string" || !row[key])
      throw new Error(`Missing CDX ${key}`);
  }
  const c = row as unknown as Capture;
  if (
    !/^\d+$/.test(c.offset) ||
    !/^[1-9]\d*$/.test(c.length) ||
    !/^\d{3}$/.test(c.status)
  )
    throw new Error("Invalid CDX location/status");
  if (
    !c.filename.startsWith(`crawl-data/${config.crawl}/`) ||
    !/^[a-zA-Z0-9/_\-.]+\.warc\.gz$/.test(c.filename) ||
    c.filename.split("/").includes("..")
  )
    throw new Error("Invalid WARC location");
  captureDate(c.timestamp);
  // Captured URLs can contain ports and underscore subdomains. Keep their exact
  // source URL while matching the parsed hostname; strict DNS rules are for config.
  const hostname = captureHost(new URL(c.url));
  if (
    hostname !== config.company.domain &&
    !hostname.endsWith(`.${config.company.domain}`)
  )
    throw new Error("CDX domain mismatch");
  // Retain only the documented fields; volatile provider additions cannot supersede a replay.
  return {
    urlkey: c.urlkey,
    timestamp: c.timestamp,
    url: c.url,
    status: c.status,
    mime: c.mime,
    digest: c.digest,
    filename: c.filename,
    offset: c.offset,
    length: c.length,
  };
}

async function stableId(parts: string[]): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts))
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export default class CommonCrawlConnector extends ConnectorRuntime<
  CrawlCheckpoint,
  CrawlConfig
> {
  constructor(private readonly fetcher: Fetcher = fetch) {
    super();
  }
  readonly definition = {
    key: "common-crawl-market-spike",
    name: "Common Crawl Market spike",
    version: "0.1.1",
    authSchema: { methods: [{ type: "none" as const }] },
    feeds: {
      captures: {
        key: "captures",
        name: "Domain capture observations",
        eventKinds: {
          domain_capture: {
            description:
              "An archived URL associated with an explicit Market domain candidate; not proof of ownership or business change.",
          },
        },
        sync: (ctx: SyncContext<CrawlCheckpoint, CrawlConfig>) =>
          this.syncCaptures(ctx),
      },
    },
  };

  private async request(url: string, stage: string): Promise<string | null> {
    // Serial requests, fixed provider host, no redirects, automatic retries or WARC downloads.
    const response = await this.fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": "LobuCommonCrawl/0.1 (+https://github.com/lobu-ai/lobu)",
      },
    });
    if (response.status === 404) {
      const body = await boundedText(response);
      // pywb has no typed error code beyond 404. Recognize its exact JSON
      // no-captures message for this query, not generic missing routes/collections.
      // https://github.com/commoncrawl/cdx_toolkit/blob/main/cdx_toolkit/__init__.py
      try {
        const error = JSON.parse(body);
        const expected = `No Captures found for: ${new URL(url).searchParams.get("url")}`;
        if (error?.error === expected || error?.message === expected)
          return null;
      } catch {
        // Non-JSON error responses leave coverage unknown as well.
      }
      throw new Error(`Common Crawl ${stage} HTTP 404; coverage unknown`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Common Crawl ${stage} HTTP ${response.status}; coverage unknown`
      );
    }
    return boundedText(response);
  }

  private async syncCaptures(
    ctx: SyncContext<CrawlCheckpoint, CrawlConfig>
  ): Promise<SyncResult> {
    const config = checkedConfig(ctx.config);
    const scope = await stableId(["cc-domain-v1", JSON.stringify(config)]);
    let checkpoint = ctx.checkpoint?.scope === scope ? ctx.checkpoint : null;
    if (
      checkpoint &&
      (!Number.isSafeInteger(checkpoint.pages) ||
        checkpoint.pages < 0 ||
        checkpoint.pages > 10000 ||
        !Number.isSafeInteger(checkpoint.next_page) ||
        checkpoint.next_page < 0 ||
        checkpoint.next_page > checkpoint.pages)
    )
      throw new Error("Invalid crawl checkpoint");
    if (!checkpoint) {
      const metadata = await this.request(indexUrl(config), "pagination");
      const info =
        metadata === null ? { pages: 0, pageSize: 1 } : JSON.parse(metadata);
      if (
        !Number.isSafeInteger(info.pages) ||
        info.pages < 0 ||
        info.pages > 10000 ||
        info.pageSize !== 1
      )
        throw new Error("Invalid CDX pagination metadata");
      checkpoint = { scope, next_page: 0, pages: info.pages };
      // The crawl is pinned. Retain its validated page plan even if page zero
      // fails, so retries do not depend on another pagination request. No
      // captures have been accepted and next_page must remain zero here.
      if (checkpoint.pages > 0) await ctx.commit([], checkpoint);
    }
    if (checkpoint.next_page === checkpoint.pages) {
      await ctx.commit([], checkpoint);
      return { status: "complete" };
    }
    const url = indexUrl(config, checkpoint.next_page);
    const text = await this.request(url, `page ${checkpoint.next_page}`);
    const lines = text === null ? [] : text.trim().split("\n");
    if ((text !== null && !text.trim()) || lines.length > MAX_RECORDS)
      throw new Error("Empty or oversized CDX page; coverage unknown");
    const captures = lines.map((line, index) => {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error(
          `Invalid CDX JSON at page ${checkpoint.next_page}, line ${index + 1}; coverage unknown`
        );
      }
      return parseCapture(row, config);
    });
    const events: EventEnvelope[] = [];
    const identities = new Map<string, string>();
    for (const capture of captures) {
      const captureId = await stableId([
        config.crawl,
        capture.filename,
        capture.offset,
      ]);
      const originId = `cc:${await stableId([captureId, config.company.id])}`;
      const encoded = JSON.stringify(capture);
      const prior = identities.get(originId);
      if (prior && prior !== encoded)
        throw new Error("Conflicting CDX capture identity");
      if (prior) continue;
      identities.set(originId, encoded);
      events.push({
        origin_id: originId,
        origin_type: "domain_capture",
        semantic_type: "observation",
        title: `Common Crawl capture: ${capture.url}`,
        payload_text: `Common Crawl observed ${capture.url} at ${capture.timestamp} (HTTP ${capture.status}). Domain association with ${config.company.name} is source evidence, not verified ownership or a business change.`,
        source_url: capture.url,
        occurred_at: captureDate(capture.timestamp),
        metadata: {
          company: config.company,
          crawl: config.crawl,
          capture_id: captureId,
          capture,
          index_url: `https://index.commoncrawl.org/${config.crawl}-index?${new URLSearchParams({ url: capture.url, matchType: "exact", output: "json" })}`,
          warc_url: `https://data.commoncrawl.org/${capture.filename}`,
          match:
            captureHost(new URL(capture.url)) === config.company.domain
              ? "exact_host"
              : "subdomain",
        },
      });
    }
    const next = { ...checkpoint, next_page: checkpoint.next_page + 1 };
    await ctx.commit(events, next);
    return { status: next.next_page < next.pages ? "more" : "complete" };
  }
}

// Evidence over the fetched subset only. Missing URLs never become deletions/new pages.
// Compare exact source URLs (including scheme/query); no lossy SURT or www merging.
export function compareCaptures(
  before: EventEnvelope[],
  after: EventEnvelope[]
) {
  const latest = (events: EventEnvelope[]) => {
    const rows = new Map<string, { capture: Capture; ambiguous: boolean }>();
    for (const event of events) {
      const capture = event.metadata?.capture as Capture;
      const old = rows.get(capture.url);
      if (!old || capture.timestamp > old.capture.timestamp)
        rows.set(capture.url, { capture, ambiguous: false });
      else if (
        capture.timestamp === old.capture.timestamp &&
        (capture.digest !== old.capture.digest ||
          capture.status !== old.capture.status ||
          capture.mime !== old.capture.mime)
      )
        old.ambiguous = true;
    }
    return rows;
  };
  const a = latest(before),
    b = latest(after);
  let shared = 0,
    comparable = 0,
    same = 0,
    different = 0;
  for (const [url, leftEntry] of a) {
    const rightEntry = b.get(url);
    if (!rightEntry) continue;
    shared++;
    if (leftEntry.ambiguous || rightEntry.ambiguous) continue;
    const left = leftEntry.capture,
      right = rightEntry.capture;
    if (
      left.status !== "200" ||
      right.status !== "200" ||
      left.mime !== "text/html" ||
      right.mime !== "text/html" ||
      left.digest === "-" ||
      right.digest === "-"
    )
      continue;
    comparable++;
    if (left.digest === right.digest) same++;
    else different++;
  }
  return {
    before_urls: a.size,
    after_urls: b.size,
    shared_urls: shared,
    comparable_urls: comparable,
    digest_same: same,
    digest_different: different,
    only_before: a.size - shared,
    only_after: b.size - shared,
  };
}
