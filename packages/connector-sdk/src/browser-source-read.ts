/**
 * Shared guards and reference-batch splitting for browser-source reads.
 *
 * Browser connectors observe references only (WhatsApp, TikTok inbox,
 * LinkedIn inbox) or take bounded snapshots (TikTok timeline/search): the
 * source owns order and pagination, so offsets, sorts, time windows, and
 * exact-match filters are rejected before touching the page. Each durable
 * browser record is limited to 128 KiB including its checkpoint, so reference
 * batches are capped at 500 events and halved until they fit; only the final
 * batch carries the checkpoint, so an interruption replays instead of
 * skipping.
 *
 * Pure (no `node:`, no `@lobu/core`): the root must stay loadable inside a V8
 * isolate.
 */

import type { FeedReadContext } from "./connector-types.js";

/** Max references per durable browser record. */
export const SOURCE_REFERENCE_BATCH_MAX_EVENTS = 500;
/** Max serialized bytes per durable browser record, checkpoint included. */
export const SOURCE_RECORD_MAX_BYTES = 128 * 1024;

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Split references into ordered batches of at most `maxEvents` references and
 * `maxBytes` serialized bytes. `buildBatch` shapes each record (id,
 * checkpoint on the final batch, `more`); it receives the slice, whether it
 * is the last batch, and the running offset. Throws when a single reference
 * cannot fit even alone.
 */
export function splitReferenceBatches<E>(
  events: E[],
  buildBatch: (
    slice: E[],
    isLast: boolean,
    offset: number,
  ) => Record<string, unknown>,
  opts?: { maxEvents?: number; maxBytes?: number },
): Record<string, unknown>[] {
  const maxEvents = opts?.maxEvents ?? SOURCE_REFERENCE_BATCH_MAX_EVENTS;
  const maxBytes = opts?.maxBytes ?? SOURCE_RECORD_MAX_BYTES;
  const batches: Record<string, unknown>[] = [];
  for (let offset = 0; ; ) {
    const through = (end: number) =>
      buildBatch(events.slice(offset, end), end === events.length, offset);
    let end = Math.min(offset + maxEvents, events.length);
    let batch = through(end);
    while (jsonByteLength(batch) > maxBytes && end - offset > 1) {
      end = offset + Math.floor((end - offset) / 2);
      batch = through(end);
    }
    if (jsonByteLength(batch) > maxBytes) {
      throw new Error(
        "Source reference or checkpoint exceeds the browser record limit",
      );
    }
    batches.push(batch);
    if (end === events.length) return batches;
    offset = end;
  }
}

type ReadShape = Pick<
  FeedReadContext,
  "offset" | "sort" | "window" | "match" | "query" | "cursor" | "limit"
>;

export function assertNoOffsetPaging(
  ctx: Pick<ReadShape, "offset">,
  message: string,
): void {
  if (ctx.offset) throw new Error(message);
}

export function assertNoSort(
  ctx: Pick<ReadShape, "sort">,
  message: string,
): void {
  if (ctx.sort) throw new Error(message);
}

export function assertNoWindow(
  ctx: Pick<ReadShape, "window">,
  message: string,
): void {
  if (ctx.window) throw new Error(message);
}

export function assertNoMatch(
  ctx: Pick<ReadShape, "match">,
  message: string,
): void {
  if (ctx.match) throw new Error(message);
}

export function assertNoQuery(
  ctx: Pick<ReadShape, "query">,
  message: string,
): void {
  if (ctx.query) throw new Error(message);
}

export function assertNoCursor(
  ctx: Pick<ReadShape, "cursor">,
  message: string,
): void {
  if (ctx.cursor) throw new Error(message);
}

export function assertPositiveReadLimit(
  ctx: Pick<ReadShape, "limit">,
  message = "limit must be a positive integer",
): void {
  if (
    ctx.limit !== undefined &&
    (!Number.isInteger(ctx.limit) || (ctx.limit as number) < 1)
  ) {
    throw new Error(message);
  }
}

/**
 * Inbox reads follow source order and the returned cursor; search, offsets,
 * sorting, matching, and time windows are unsupported.
 */
export function assertInboxSourceRead(
  ctx: ReadShape,
  sourceLabel: string,
): void {
  const message =
    `${sourceLabel} inbox reads use source order and the returned cursor; ` +
    `search, offsets, sorting, matching, and time windows are unsupported`;
  assertNoOffsetPaging(ctx, message);
  assertNoSort(ctx, message);
  assertNoWindow(ctx, message);
  assertNoMatch(ctx, message);
  assertNoQuery(ctx, message);
}

/**
 * Bounded snapshot reads support no pagination, sorting, time windows, or
 * exact-match filters.
 */
export function assertSnapshotSourceRead(
  ctx: ReadShape,
  sourceLabel: string,
): void {
  const message =
    `${sourceLabel} snapshot feeds do not support pagination, sorting, ` +
    `time windows, or exact-match filters`;
  assertNoCursor(ctx, message);
  assertNoOffsetPaging(ctx, message);
  assertNoSort(ctx, message);
  assertNoWindow(ctx, message);
  assertNoMatch(ctx, message);
}
