import { Gunzip } from "fflate/browser";

// The public CDXJ files are the same source used by the query service.
// https://www.commoncrawl.org/cdxj-index — sorted, independently gzipped blocks.
export interface IndexBlock {
  file: string;
  offset: number;
  length: number;
}
interface Entry extends IndexBlock {
  key: string;
  start: number;
  end: number;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const WINDOW = 8192;
const MAX_BLOCK = 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function checkBlocks(value: IndexBlock[], maxLength = MAX_BLOCK): void {
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("Invalid index block plan");
  for (const b of value) {
    if (
      !b ||
      !/^cdx-\d{5}\.gz$/.test(b.file) ||
      !Number.isSafeInteger(b.offset) ||
      b.offset < 0 ||
      !Number.isSafeInteger(b.length) ||
      b.length < 18 ||
      b.length > maxLength ||
      !Number.isSafeInteger(b.offset + b.length)
    )
      throw new Error("Invalid index block range");
  }
}

function entries(bytes: Uint8Array, start: number): Entry[] {
  const rows: Entry[] = [];
  const firstNewline = bytes.indexOf(10);
  if (start && firstNewline < 0)
    throw new Error("Overlong secondary index row");
  let begin = start === 0 ? 0 : firstNewline + 1;
  for (let i = begin; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    const parts = decoder.decode(bytes.subarray(begin, i)).split("\t");
    if (
      parts.length !== 5 ||
      !/^\S+ \d{14}$/.test(parts[0]!) ||
      !/^\d+$/.test(parts[2]!) ||
      !/^\d+$/.test(parts[3]!)
    )
      throw new Error("Invalid secondary index row");
    const row = {
      key: parts[0]!,
      file: parts[1]!,
      offset: Number(parts[2]),
      length: Number(parts[3]),
      start: start + begin,
      end: start + i + 1,
    };
    checkBlocks([row], Number.MAX_SAFE_INTEGER);
    if (rows.length && rows[rows.length - 1]!.key > row.key)
      throw new Error("Unsorted secondary index");
    rows.push(row);
    begin = i + 1;
  }
  return rows;
}

export class IndexFiles {
  private requests = 0;
  private bytes = 0;
  private size = 0;
  private etag: string | null = null;
  private readonly base: string;
  constructor(
    crawl: string,
    private readonly fetcher: Fetcher
  ) {
    if (!/^CC-MAIN-20\d{2}-\d{2}$/.test(crawl))
      throw new Error("Invalid crawl");
    this.base = `https://data.commoncrawl.org/cc-index/collections/${crawl}/indexes/`;
  }
  private async range(
    file: string,
    start: number,
    end: number
  ): Promise<Uint8Array> {
    if (++this.requests > 32)
      throw new Error("Index request budget exceeded; coverage unknown");
    const response = await this.fetcher(this.base + file, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Range: `bytes=${start}-${end}`,
        "User-Agent": "LobuCommonCrawl/0.1 (+https://github.com/lobu-ai/lobu)",
      },
    });
    const fail = async (message: string): Promise<never> => {
      await response.body?.cancel();
      throw new Error(message);
    };
    if (response.status !== 206)
      return fail(
        `Common Crawl index range HTTP ${response.status}; coverage unknown`
      );
    const match = response.headers
      .get("content-range")
      ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const total = Number(match?.[3]),
      last = Number(match?.[2]);
    if (
      !match ||
      Number(match[1]) !== start ||
      !Number.isSafeInteger(total) ||
      total <= start ||
      last !== Math.min(end, total - 1)
    )
      return fail("Invalid index Content-Range");
    if (file === "cluster.idx") {
      const etag = response.headers.get("etag");
      if (
        total > 1024 * 1024 * 1024 ||
        (this.size && (this.size !== total || this.etag !== etag))
      )
        return fail("Secondary index changed or exceeds size bound");
      this.size = total;
      this.etag = etag;
    }
    const expected = last - start + 1;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing index range body");
    const bytes = new Uint8Array(expected);
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > expected) throw new Error("Oversized index range");
        bytes.set(value, length - value.length);
      }
    } finally {
      await reader.cancel();
    }
    if (length !== expected) throw new Error("Truncated index range");
    this.bytes += length;
    if (this.bytes > 2 * 1024 * 1024)
      throw new Error("Index byte budget exceeded");
    return bytes;
  }

  async plan(domain: string): Promise<IndexBlock[]> {
    // SURT removes a leading www plus optional digits. Broaden only index
    // lookup; captures still require the original exact hostname/subdomain.
    // https://github.com/internetarchive/surt/blob/master/surt/IAURLCanonicalizer.py
    const prefix = domain
      .replace(/^www\d*\./, "")
      .split(".")
      .reverse()
      .join(",");
    // ')' (apex), ',' (subdomains) and ':' (ports) all precede ';'.
    // Other names inside this interval are filtered by the original URL hostname.
    const upper = `${prefix};`;
    const initial = await this.range("cluster.idx", 0, WINDOW - 1);
    const first = entries(initial, 0)[0];
    if (!first) throw new Error("Empty secondary index; coverage unknown");
    let lo = 0,
      hi = this.size;
    let predecessor: Entry | undefined;
    while (hi - lo > WINDOW) {
      const mid = Math.floor((lo + hi) / 2);
      const row = entries(
        await this.range(
          "cluster.idx",
          mid,
          Math.min(this.size - 1, mid + WINDOW - 1)
        ),
        mid
      )[0];
      if (!row) throw new Error("No complete secondary index row");
      if (row.key < prefix) {
        predecessor = row;
        lo = row.end;
      } else {
        if (row.start >= hi)
          throw new Error("Secondary index search made no progress");
        hi = row.start;
      }
    }
    const start = Math.max(0, lo - 1),
      end = Math.min(this.size - 1, hi + 2 * WINDOW - 1);
    const tail = await this.range("cluster.idx", start, end);
    const rows = entries(tail, start);
    const candidates: Entry[] = [];
    let bounded = false;
    for (const row of rows) {
      if (row.key < prefix) {
        predecessor = row;
        continue;
      }
      if (row.key >= upper) {
        bounded = true;
        break;
      }
      candidates.push(row);
    }
    if (!bounded && !(end === this.size - 1 && tail[tail.length - 1] === 10))
      throw new Error("Domain index planning bound exceeded; coverage unknown");
    if (predecessor) candidates.unshift(predecessor);
    const blocks = candidates.map(({ file, offset, length }) => ({
      file,
      offset,
      length,
    }));
    checkBlocks(blocks);
    return blocks;
  }

  async captures(block: IndexBlock, domain: string): Promise<unknown[]> {
    checkBlocks([block]);
    const compressed = await this.range(
      block.file,
      block.offset,
      block.offset + block.length - 1
    );
    const chunks: Uint8Array[] = [];
    let length = 0,
      crc = -1,
      finished = false;
    const gunzip = new Gunzip((chunk, final) => {
      length += chunk.length;
      if (length > MAX_TEXT)
        throw new Error("Expanded index block exceeds 8 MiB");
      for (const byte of chunk) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      chunks.push(chunk);
      finished = final;
    });
    gunzip.onmember = () => {
      throw new Error("Expected one gzip member per index block");
    };
    // Small input chunks bound each inflater allocation even for corrupt streams.
    for (let i = 0; i < compressed.length; i += 1024)
      gunzip.push(
        compressed.subarray(i, i + 1024),
        i + 1024 >= compressed.length
      );
    const footer = new DataView(
      compressed.buffer,
      compressed.byteOffset + compressed.length - 8,
      8
    );
    // fflate does not verify the gzip checksum itself.
    if (
      !finished ||
      footer.getUint32(4, true) !== length ||
      footer.getUint32(0, true) !== (crc ^ -1) >>> 0
    )
      throw new Error("Invalid index gzip checksum or size");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = decoder.decode(bytes);
    if (!text.endsWith("\n")) throw new Error("Truncated CDXJ block");
    const lines = text.trimEnd().split("\n");
    if (lines.length > 5000) throw new Error("Oversized CDXJ block");
    const rows: unknown[] = [];
    for (const line of lines) {
      const match = line.match(/^(\S+) (\d{14}) (\{.*)$/);
      if (!match) throw new Error("Invalid CDXJ row");
      const row = JSON.parse(match[3]!);
      if (typeof row?.url !== "string") throw new Error("Missing CDXJ URL");
      const hostname = new URL(row.url).hostname
        .toLowerCase()
        .replace(/\.$/, "");
      if (hostname === domain || hostname.endsWith(`.${domain}`))
        rows.push({ ...row, urlkey: match[1], timestamp: match[2] });
    }
    return rows;
  }
}
