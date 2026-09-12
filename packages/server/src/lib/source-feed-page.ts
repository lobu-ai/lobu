import { createHash } from 'node:crypto';
import type { FeedReadWindow } from '@lobu/connector-sdk';
import type { AuthzScope } from '../authz/scope';
import { readSourceFeed } from './connector-pushdown';

export interface SourceFeedPageRequest {
  feed_id: number;
  query?: string;
  cursor?: string;
  limit?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
  window?: FeedReadWindow;
  sourceRevision?: string;
}

interface SourceCursor {
  v: 1;
  feed_id: number;
  position: number;
  source_cursor?: string;
  request_hash: string;
}

function sourceRequestHash(
  query: string | undefined,
  sort: { column: string; order: 'asc' | 'desc' } | undefined,
  window?: FeedReadWindow,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ query: query?.trim() ?? '', sort: sort ?? null, ...(window ? { window } : {}) }))
    .digest('base64url')
    .slice(0, 16);
}

/**
 * A caller-supplied cursor that does not decode, or does not belong to this
 * (feed, query, sort) request. Marked structurally rather than by message text so the
 * classifier never confuses it with a connector error that merely mentions a
 * cursor.
 */
export class SourceCursorError extends Error {}

function decodeSourceCursor(
  cursor: string | undefined,
  feedId: number,
  query: string | undefined,
  sort: { column: string; order: 'asc' | 'desc' } | undefined,
  window?: FeedReadWindow,
): { position: number; sourceCursor?: string } {
  if (!cursor) return { position: 0 };
  let parsed: SourceCursor;
  try {
    parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as SourceCursor;
  } catch {
    throw new SourceCursorError('Invalid source cursor');
  }
  if (
    parsed.v !== 1 ||
    parsed.feed_id !== feedId ||
    !Number.isSafeInteger(parsed.position) ||
    parsed.position < 0 ||
    (parsed.source_cursor !== undefined &&
      (typeof parsed.source_cursor !== 'string' ||
        parsed.source_cursor.length === 0)) ||
    parsed.request_hash !== sourceRequestHash(query, sort, window)
  ) {
    throw new SourceCursorError(
      'Source cursor does not match this feed read request',
    );
  }
  return {
    position: parsed.position,
    ...(parsed.source_cursor ? { sourceCursor: parsed.source_cursor } : {}),
  };
}

function encodeSourceCursor(
  feedId: number,
  position: number,
  query: string | undefined,
  sort: { column: string; order: 'asc' | 'desc' } | undefined,
  sourceCursor?: string,
  window?: FeedReadWindow,
): string {
  const payload: SourceCursor = {
    v: 1,
    feed_id: feedId,
    position,
    request_hash: sourceRequestHash(query, sort, window),
    ...(sourceCursor ? { source_cursor: sourceCursor } : {}),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sourceReadError(message: string): Error & { exitReason: 'timeout' } {
  return Object.assign(new Error(message), { exitReason: 'timeout' as const });
}

/** Shared bounded pager for direct feed reads and Automation source windows. */
export async function readSourceFeedPage(
  read: SourceFeedPageRequest,
  timeoutMs: number,
  scope: AuthzScope,
  signal?: AbortSignal,
) {
  const page = decodeSourceCursor(
    read.cursor,
    read.feed_id,
    read.query,
    read.sort,
    read.window,
  );
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const onCallerAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (signal?.aborted) onCallerAbort();
  const offset = page.sourceCursor ? 0 : page.position;
  const limit = Math.max(1, Math.min(500, Math.trunc(read.limit ?? 50)));
  const pending = readSourceFeed({
    scope: scope,
    feedId: read.feed_id,
    query: read.query,
    cursor: page.sourceCursor,
    limit,
    offset,
    sort: read.sort,
    window: read.window,
    sourceRevision: read.sourceRevision,
    signal: controller.signal,
    deadlineAt,
  });
  pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        sourceReadError(
          `source read ${read.feed_id} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([pending, deadline]);
    if (!Array.isArray(result.rows) || result.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Source reader returned malformed rows.');
    }
    if (result.rows.length > limit) throw new Error('Source reader exceeded the requested page limit.');
    if (result.nextCursor !== undefined &&
        (typeof result.nextCursor !== 'string' || !result.nextCursor.trim())) {
      throw new Error('Source reader returned a malformed continuation cursor.');
    }
    if (read.window && result.hasMore && !result.nextCursor) {
      throw new Error('Windowed source reader reported more results without a continuation cursor.');
    }
    if (result.nextCursor && result.nextCursor === page.sourceCursor) {
      throw new Error('Source reader returned a non-advancing cursor.');
    }
    const nextPosition = page.position + result.rows.length;
    // Once a source has selected token pagination, absence of a replacement
    // token means exhaustion. Never downgrade that traversal to an offset
    // cursor: token-only providers reject offsets and cannot resume that page.
    let hasMore: boolean;
    if (result.nextCursor !== undefined) {
      hasMore = true;
    } else if (page.sourceCursor !== undefined) {
      hasMore = false;
    } else if (result.hasMore !== undefined) {
      hasMore = result.hasMore;
    } else if (result.total !== undefined) {
      hasMore = nextPosition < result.total;
    } else {
      hasMore = result.rows.length >= limit;
    }
    return {
      feed_id: read.feed_id,
      ok: true as const,
      rows: result.rows,
      columns: result.columns,
      window: result.window,
      sourceRevision: result.sourceRevision,
      ...(result.total === undefined ? {} : { total: result.total }),
      ...(hasMore
        ? {
            next_cursor: encodeSourceCursor(
              read.feed_id,
              nextPosition,
              read.query,
              read.sort,
              result.nextCursor,
              read.window,
            ),
          }
        : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}
