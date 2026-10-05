import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const readPage = vi.fn();
const account = {
  name: "account",
  target: {
    entityType: "account",
    identities: [{ namespace: "account", eventPath: "metadata.account_id" }],
  },
};
const contact = {
  name: "contact",
  target: {
    entityType: "contact",
    identities: [{ namespace: "contact", eventPath: "metadata.contact_id" }],
  },
};
const feed = {
  feed_id: 1,
  connector_key: "test_source",
  feed_schema: {
    matchPaths: ["metadata.account_id"],
    eventKinds: {
      linked: {
        attributions: [account, contact],
        relationships: [
          { type: "has_contact", from: "account", to: "contact" },
        ],
      },
    },
  },
};
let feeds: Array<typeof feed> = [feed];
const sql = Object.assign(
  vi.fn(async () => [{ backing_sql: "SELECT 1" }]),
  { unsafe: vi.fn(async () => feeds) }
);
const scope = {
  organizationId: "record-test-org",
  principal: "record-test-user",
};
const record = { type: "account", key: "a1" };
let reads: typeof import("../source-record-reads");

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../db/client", async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getDb: () => sql,
  }));
  vi.doMock("../../lib/source-feed-page", async (original) => ({
    ...(await original<Record<string, unknown>>()),
    readSourceFeedPage: readPage,
  }));
  reads = await import("../source-record-reads");
});
beforeEach(() => {
  vi.clearAllMocks();
  feeds = [feed];
});
afterAll(() => {
  vi.doUnmock("../../db/client");
  vi.doUnmock("../../lib/source-feed-page");
  vi.resetModules();
});

it("does not attribute another event kind just because it shares an identity path", async () => {
  readPage.mockResolvedValue({
    rows: [
      {
        origin_id: "valid",
        origin_type: "linked",
        metadata: { account_id: "a1" },
      },
      {
        origin_id: "unrelated",
        origin_type: "other",
        metadata: { account_id: "a1" },
      },
    ],
  });
  const result = await reads.readSourceRecordActivity(scope, record, {
    limit: 10,
  });
  expect(result.events.map((event) => event.origin_id)).toEqual(["valid"]);
});

it("does not invent relationships for an event with no declaring kind", async () => {
  readPage.mockResolvedValue({
    rows: [
      {
        origin_id: "untyped",
        metadata: { account_id: "a1", contact_id: "c1" },
      },
    ],
  });
  const result = await reads.readSourceRecordLinks(scope, record, {
    limit: 10,
  });
  expect(result.links).toEqual([]);
});

it.each([
  {},
  { "1:metadata.account_id": 1 },
  { "1:metadata.account_id": null },
])("rejects malformed cursor streams: %j", async (cursor) => {
  await expect(
    reads.readSourceRecordActivity(scope, record, {
      limit: 10,
      cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
    })
  ).rejects.toThrow(/Invalid record activity cursor/);
  expect(readPage).not.toHaveBeenCalled();
});

it("keeps a failed stream in the continuation so a retry resumes it", async () => {
  readPage.mockRejectedValueOnce(new Error("source timed out"));
  const failed = await reads.readSourceRecordActivity(scope, record, {
    limit: 10,
  });
  expect(failed.failures).toEqual([{ feed_id: 1, error: "source timed out" }]);
  expect(failed.next_cursor).toBeDefined();

  readPage.mockResolvedValueOnce({
    rows: [
      {
        origin_id: "valid",
        origin_type: "linked",
        metadata: { account_id: "a1" },
      },
    ],
  });
  const retried = await reads.readSourceRecordActivity(scope, record, {
    limit: 10,
    cursor: failed.next_cursor,
  });
  expect(readPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: undefined }),
    expect.anything(),
    scope,
    undefined
  );
  expect(retried.events.map((event) => event.origin_id)).toEqual(["valid"]);
  expect(retried.next_cursor).toBeUndefined();
});

const linked = (origin_id: string, occurred_at: string, contact_id = "c1") => ({
  origin_id,
  origin_type: "linked",
  occurred_at,
  metadata: { account_id: "a1", contact_id },
});

/** A source that pages its rows by offset, at most two per page. */
function pagedSource(rowsByFeed: Record<number, Array<Record<string, unknown>>>) {
  readPage.mockImplementation(
    async (read: { feed_id: number; limit: number; cursor?: string }) => {
      const rows = rowsByFeed[read.feed_id] ?? [];
      const offset = read.cursor ? Number(read.cursor) : 0;
      const page = rows.slice(offset, offset + Math.min(read.limit, 2));
      const end = offset + page.length;
      return { rows: page, ...(end < rows.length ? { next_cursor: String(end) } : {}) };
    }
  );
}

it("pages newest first across feeds without exceeding the limit or skipping rows", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  pagedSource({
    1: [linked("jan10", "2026-01-10T00:00:00Z"), linked("jan9", "2026-01-09T00:00:00Z")],
    2: [linked("jan2", "2026-01-02T00:00:00Z"), linked("jan1", "2026-01-01T00:00:00Z")],
  });
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 6; page += 1) {
    const result = await reads.readSourceRecordActivity(scope, record, { limit: 1, cursor });
    expect(result.events.length).toBeLessThanOrEqual(1);
    seen.push(...result.events.map((event) => String(event.origin_id)));
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  expect(seen).toEqual(["jan10", "jan9", "jan2", "jan1"]);
  expect(cursor).toBeUndefined();
});

it("does not return rows past a stream that has more pages but no rows left", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  pagedSource({
    1: [linked("old", "2026-01-01T00:00:00Z")],
    2: [
      linked("b5", "2026-01-05T00:00:00Z"),
      linked("b4", "2026-01-04T00:00:00Z"),
      linked("b3", "2026-01-03T00:00:00Z"),
    ],
  });
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 5 });
  expect(first.events.map((event) => event.origin_id)).toEqual(["b5", "b4"]);
  const second = await reads.readSourceRecordActivity(scope, record, {
    limit: 5,
    cursor: first.next_cursor,
  });
  expect(second.events.map((event) => event.origin_id)).toEqual(["b3", "old"]);
  expect(second.next_cursor).toBeUndefined();
});

it("finds a relationship declared only on a later source page", async () => {
  pagedSource({
    1: [
      { origin_id: "x", origin_type: "other", occurred_at: "2026-01-09T00:00:00Z", metadata: { account_id: "a1" } },
      { origin_id: "y", origin_type: "other", occurred_at: "2026-01-08T00:00:00Z", metadata: { account_id: "a1" } },
      linked("rel", "2026-01-01T00:00:00Z", "c7"),
    ],
  });
  const result = await reads.readSourceRecordLinks(scope, record, { limit: 10 });
  expect(result.failures).toEqual([]);
  expect(result.links.map((link) => link.key)).toEqual(["c7"]);
});

it("reports a relationship read that hits its page cap instead of an empty list", async () => {
  readPage.mockResolvedValue({ rows: [], next_cursor: "more" });
  const result = await reads.readSourceRecordLinks(scope, record, { limit: 10 });
  expect(result.links).toEqual([]);
  expect(result.failures).toEqual([
    { feed_id: 1, error: expect.stringMatching(/were not read/) },
  ]);
});

it("returns an event reachable through two of the record's paths once across pages", async () => {
  const twoPaths = {
    ...feed,
    feed_schema: {
      matchPaths: ["metadata.account_id", "metadata.parent_id"],
      eventKinds: {
        linked: {
          attributions: [
            account,
            {
              name: "parent",
              target: {
                entityType: "account",
                identities: [{ namespace: "account", eventPath: "metadata.parent_id" }],
              },
            },
          ],
        },
      },
    },
  };
  feeds = [twoPaths as typeof feed];
  const both = {
    origin_id: "both",
    origin_type: "linked",
    occurred_at: "2026-01-05T00:00:00Z",
    metadata: { account_id: "a1", parent_id: "a1" },
  };
  readPage.mockImplementation(async (read: { match: { path: string } }) => ({
    rows: read.match.path === "metadata.parent_id"
      ? [both, { ...both, origin_id: "parent-only", occurred_at: "2026-01-01T00:00:00Z", metadata: { account_id: "a9", parent_id: "a1" } }]
      : [both],
  }));
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await reads.readSourceRecordActivity(scope, record, { limit: 1, cursor });
    seen.push(...result.events.map((event) => String(event.origin_id)));
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  expect(seen).toEqual(["both", "parent-only"]);
});

it("filters relationships by type and direction before the limit", async () => {
  feeds = [
    {
      ...feed,
      feed_schema: {
        ...feed.feed_schema,
        eventKinds: {
          linked: {
            attributions: [account, contact],
            relationships: [
              { type: "knows", from: "account", to: "contact" },
              { type: "owns", from: "contact", to: "account" },
            ],
          },
        },
      },
    },
  ];
  pagedSource({
    1: [linked("new", "2026-01-09T00:00:00Z", "c-new"), linked("old", "2026-01-01T00:00:00Z", "c-old")],
  });
  const owns = await reads.readSourceRecordLinks(scope, record, {
    limit: 1,
    relationshipType: "owns",
  });
  expect(owns.links.map((link) => [link.relationship_type, link.direction])).toEqual([["owns", "incoming"]]);
  const outgoing = await reads.readSourceRecordLinks(scope, record, {
    limit: 5,
    direction: "outgoing",
  });
  expect(new Set(outgoing.links.map((link) => link.relationship_type))).toEqual(new Set(["knows"]));
});

it("neither repeats nor skips a row when the source changes between pages", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  const a = [linked("a10", "2026-01-10T00:00:00Z"), linked("a8", "2026-01-08T00:00:00Z")];
  const b = [linked("b9", "2026-01-09T00:00:00Z"), linked("b7", "2026-01-07T00:00:00Z")];
  // A keyset-like source: every read returns the current rows from the top.
  readPage.mockImplementation(async (read: { feed_id: number; limit: number }) => ({
    rows: (read.feed_id === 1 ? a : b).slice(0, read.limit),
  }));
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 2 });
  expect(first.events.map((event) => event.origin_id)).toEqual(["a10", "b9"]);

  a.unshift(linked("a11", "2026-01-11T00:00:00Z"));
  const afterInsert = await reads.readSourceRecordActivity(scope, record, {
    limit: 2,
    cursor: first.next_cursor,
  });
  expect(afterInsert.events.map((event) => event.origin_id)).toEqual(["a8", "b7"]);

  a.splice(0, 2);
  const deleted = await reads.readSourceRecordActivity(scope, record, {
    limit: 2,
    cursor: first.next_cursor,
  });
  expect(deleted.events.map((event) => event.origin_id)).toEqual(["a8", "b7"]);
});

it("keeps its place when new rows push the last returned row past the re-read page", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  const rows: Record<number, Array<Record<string, unknown>>> = {
    1: [linked("a10", "2026-01-10T00:00:00Z"), linked("a8", "2026-01-08T00:00:00Z"), linked("a6", "2026-01-06T00:00:00Z")],
    2: [linked("b9", "2026-01-09T00:00:00Z"), linked("b7", "2026-01-07T00:00:00Z")],
  };
  // Offset pages over the source's current rows, re-read from the top.
  pagedSource(rows);
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 2 });
  expect(first.events.map((event) => event.origin_id)).toEqual(["a10", "b9"]);
  rows[1].unshift(
    linked("a13", "2026-01-13T00:00:00Z"),
    linked("a12", "2026-01-12T00:00:00Z"),
    linked("a11", "2026-01-11T00:00:00Z")
  );
  const seen = first.events.map((event) => String(event.origin_id));
  let cursor = first.next_cursor;
  for (let page = 0; cursor && page < 20; page += 1) {
    const result = await reads.readSourceRecordActivity(scope, record, { limit: 2, cursor });
    seen.push(...result.events.map((event) => String(event.origin_id)));
    cursor = result.next_cursor;
  }
  expect(cursor).toBeUndefined();
  expect(seen).toEqual(["a10", "b9", "a8", "b7", "a6"]);
});
