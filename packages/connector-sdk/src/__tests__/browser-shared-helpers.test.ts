import { describe, expect, test } from "bun:test";
import {
  assertInboxSourceRead,
  assertPositiveReadLimit,
  assertSnapshotSourceRead,
  SOURCE_RECORD_MAX_BYTES,
  SOURCE_REFERENCE_BATCH_MAX_EVENTS,
  splitReferenceBatches,
} from "../browser-source-read.js";

describe("source-only feed-read guards", () => {
  test("inbox reads reject search, offsets, sorting, matching and windows", () => {
    expect(() =>
      assertInboxSourceRead({ offset: 3 } as never, "TikTok"),
    ).toThrow("TikTok inbox reads use source order");
    expect(() =>
      assertInboxSourceRead({ query: "x" } as never, "LinkedIn"),
    ).toThrow("LinkedIn inbox reads use source order");
    expect(
      assertInboxSourceRead({ cursor: "c", limit: 10 } as never, "TikTok"),
    ).toBeUndefined();
  });

  test("snapshot reads reject cursors, pagination, sorting, windows and matches", () => {
    expect(() =>
      assertSnapshotSourceRead({ cursor: "c" } as never, "TikTok"),
    ).toThrow("TikTok snapshot feeds do not support");
    expect(
      assertSnapshotSourceRead({ limit: 10 } as never, "TikTok"),
    ).toBeUndefined();
  });

  test("limits must be positive integers", () => {
    expect(() => assertPositiveReadLimit({ limit: 0 })).toThrow(
      "limit must be a positive integer",
    );
    expect(() => assertPositiveReadLimit({ limit: 1.5 })).toThrow(
      "limit must be a positive integer",
    );
    expect(assertPositiveReadLimit({ limit: 10 })).toBeUndefined();
    expect(assertPositiveReadLimit({})).toBeUndefined();
  });
});

describe("splitReferenceBatches", () => {
  test("caps batches at 500 events with the checkpoint only on the last", () => {
    expect(SOURCE_REFERENCE_BATCH_MAX_EVENTS).toBe(500);
    expect(SOURCE_RECORD_MAX_BYTES).toBe(128 * 1024);
    const events = Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}` }));
    const batches = splitReferenceBatches(events, (slice, isLast, offset) => ({
      id: `batch:${offset}`,
      events: slice,
      ...(isLast ? { checkpoint: { next: "done" } } : {}),
    }));
    expect(batches).toHaveLength(3);
    expect((batches[0] as { events: unknown[] }).events).toHaveLength(500);
    expect(batches[0]).not.toHaveProperty("checkpoint");
    expect(batches[2]).toHaveProperty("checkpoint");
  });

  test("halves batches until they fit and throws when one reference cannot", () => {
    const big = "x".repeat(SOURCE_RECORD_MAX_BYTES);
    const half = "x".repeat(100 * 1024);
    const batches = splitReferenceBatches(
      [{ id: half }, { id: half }],
      (slice, isLast) => ({
        events: slice,
        ...(isLast ? { checkpoint: true } : {}),
      }),
    );
    expect(batches.length).toBeGreaterThan(1);
    expect(() =>
      splitReferenceBatches([{ id: big }], (slice) => ({ events: slice })),
    ).toThrow("browser record limit");
  });
});
