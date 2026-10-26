import type { FeedReadContext, FeedReadResult } from "@lobu/connector-sdk";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;
interface LogRange {
  start: string;
  end: string;
  limit: number;
  scope: string;
  after?: { timestamp: string; id: string };
}

export function logRange(ctx: FeedReadContext, source: string): LogRange {
  if (ctx.window || ctx.offset || ctx.match || ctx.sort)
    throw new Error(
      "Use explicit start/end query bounds and the returned cursor"
    );
  const input = JSON.parse(ctx.query || "null");
  const startMs = Date.parse(input?.start);
  const endMs = Date.parse(input?.end);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    endMs - startMs > 86400000
  )
    throw new Error(
      "query must be JSON with start and end timestamps at most 24 hours apart"
    );
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();
  const limit = ctx.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("limit must be an integer from 1 to 200");
  const scope = JSON.stringify([source, start, end]);
  let after: LogRange["after"];
  if (ctx.cursor) {
    const cursor = JSON.parse(ctx.cursor);
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      cursor.scope !== scope ||
      typeof cursor.timestamp !== "string" ||
      !Number.isFinite(Date.parse(cursor.timestamp)) ||
      typeof cursor.id !== "string" ||
      !cursor.id ||
      cursor.id.length > 200
    )
      throw new Error("Invalid cursor or cursor belongs to a different query");
    after = { timestamp: cursor.timestamp, id: cursor.id };
  }
  return { start, end, limit, scope, after };
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

export function logPage(
  rows: Record<string, unknown>[],
  range: LogRange,
  timestamp: string,
  id: string
): FeedReadResult {
  // A missing source key is an error, never an exhausted page or skipped row.
  for (const row of rows) {
    if (
      typeof row[timestamp] !== "string" ||
      !Number.isFinite(Date.parse(row[timestamp] as string)) ||
      typeof row[id] !== "string" ||
      !row[id]
    )
      throw new Error(
        "Source returned a row without a valid timestamp/source id"
      );
  }
  const hasMore = rows.length > range.limit;
  const page = rows.slice(0, range.limit);
  const cursors = page.map((row) =>
    JSON.stringify({
      scope: range.scope,
      timestamp: row[timestamp],
      id: row[id],
    })
  );
  return {
    rows: page,
    rowCursors: cursors,
    hasMore,
    ...(hasMore ? { nextCursor: cursors.at(-1) } : {}),
  };
}

export async function readLogJson(
  response: Response
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new Error(`Source query failed with HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Source returned no response body");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000)
        throw new Error("Source response exceeds 2 MB; narrow the query range");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
  }
}
