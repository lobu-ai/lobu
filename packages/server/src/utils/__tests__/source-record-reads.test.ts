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

it.each(["readSourceRecordActivity", "readSourceRecordLinks"] as const)(
  "%s preserves the Automation identity across source pages",
  async (method) => {
    readPage.mockResolvedValue({ rows: [] });
    const options = { limit: 10, automationId: 42 };
    await reads[method](scope, record, options);
    expect(readPage).toHaveBeenCalledWith(
      expect.anything(), expect.any(Number), scope, undefined, 42
    );
  }
);

it("does not attribute another event kind just because it shares an identity path", async () => {
  readPage.mockResolvedValue({
    row_cursors: ["valid", "unrelated"],
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
  { "1:metadata.account_id": {} },
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
    row_cursors: ["valid"],
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
    undefined,
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

/** A source-native keyset remains valid after its last row is deleted. */
function sourcePage(rows: Array<Record<string, unknown>>, limit: number, cursor?: string) {
  const key = (row: Record<string, unknown>) => [String(row.occurred_at ?? ""), String(row.origin_id)];
  const after = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) as string[] : null;
  const remaining = rows.filter((row) => {
    const [time, id] = key(row);
    return !after || time < after[0] || (time === after[0] && id < after[1]);
  });
  const page = remaining.slice(0, Math.min(limit, 2));
  const cursors = page.map((row) => Buffer.from(JSON.stringify(key(row))).toString("base64url"));
  return { rows: page, row_cursors: cursors, ...(remaining.length > page.length ? { next_cursor: cursors.at(-1) } : {}) };
}

function pagedSource(rowsByFeed: Record<number, Array<Record<string, unknown>>>) {
  readPage.mockImplementation(async (read: { feed_id: number; limit: number; cursor?: string }) =>
    sourcePage(rowsByFeed[read.feed_id] ?? [], read.limit, read.cursor)
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
  readPage.mockImplementation(async (read: { match: { path: string }; limit: number; cursor?: string }) => sourcePage(
    read.match.path === "metadata.parent_id"
      ? [both, { ...both, origin_id: "parent-only", occurred_at: "2026-01-01T00:00:00Z", metadata: { account_id: "a9", parent_id: "a1" } }]
      : [both], read.limit, read.cursor,
  ));
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

it("reads a stream shared by several relationships once and reports its failure once", async () => {
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
  pagedSource({ 1: [linked("rel", "2026-01-01T00:00:00Z", "c7")] });
  const result = await reads.readSourceRecordLinks(scope, record, { limit: 10 });
  expect(result.links.map((link) => link.relationship_type).sort()).toEqual(["knows", "owns"]);
  expect(readPage).toHaveBeenCalledOnce();

  readPage.mockClear();
  readPage.mockRejectedValueOnce(new Error("source down"));
  const failed = await reads.readSourceRecordLinks(scope, record, { limit: 10 });
  expect(failed.failures).toEqual([{ feed_id: 1, error: "source down" }]);
  expect(readPage).toHaveBeenCalledOnce();
});

it("neither repeats nor skips a row when the source changes between pages", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  const a = [linked("a10", "2026-01-10T00:00:00Z"), linked("a8", "2026-01-08T00:00:00Z")];
  const b = [linked("b9", "2026-01-09T00:00:00Z"), linked("b7", "2026-01-07T00:00:00Z")];
  pagedSource({ 1: a, 2: b });
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

it.each([
  ["a newer row is inserted", (rows: Array<Record<string, unknown>>) => rows.unshift(linked("e5", "2026-01-05T00:00:00Z"))],
  ["a returned row is deleted", (rows: Array<Record<string, unknown>>) => rows.shift()],
])("pages a keyset source exactly once across a full page boundary when %s", async (_case, mutate) => {
  const rows = ["e4", "e3", "e2", "e1"].map((id, index) => linked(id, `2026-01-0${4 - index}T00:00:00Z`));
  pagedSource({ 1: rows });
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 2 });
  expect(first.events.map((event) => event.origin_id)).toEqual(["e4", "e3"]);
  mutate(rows);
  const second = await reads.readSourceRecordActivity(scope, record, { limit: 2, cursor: first.next_cursor });
  expect(second.events.map((event) => event.origin_id)).toEqual(["e2", "e1"]);
  expect(second.next_cursor).toBeUndefined();
});

it("resumes a partially consumed stream after a deleted anchor among equal timestamps", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  const rows = {
    1: ["a3", "a2", "a1"].map((id) => linked(id, "2026-01-01T00:00:00Z")),
    2: [linked("b1", "2026-01-02T00:00:00Z")],
  };
  readPage.mockImplementation(async (read: { feed_id: 1 | 2; limit: number; cursor?: string }) => {
    const remaining = rows[read.feed_id].filter((row) => !read.cursor || row.origin_id < read.cursor);
    const page = remaining.slice(0, read.limit);
    return {
      rows: page,
      row_cursors: page.map((row) => row.origin_id),
      ...(remaining.length > page.length ? { next_cursor: page.at(-1)!.origin_id } : {}),
    };
  });
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 3 });
  expect(first.events.map((event) => event.origin_id)).toEqual(["b1", "a3", "a2"]);
  rows[1].splice(1, 1);
  const second = await reads.readSourceRecordActivity(scope, record, { limit: 3, cursor: first.next_cursor });
  expect(second.events.map((event) => event.origin_id)).toEqual(["a1"]);
  expect(second.next_cursor).toBeUndefined();
});

it.each([
  ["a newer row is inserted", (rows: Array<Record<string, unknown>>) => rows.unshift(linked("e5", "2026-01-05T00:00:00Z"))],
  ["the last returned row is deleted", (rows: Array<Record<string, unknown>>) => rows.splice(1, 1)],
])("uses row checkpoints instead of provider offsets at full page boundaries when %s", async (_case, mutate) => {
  const rows = ["e4", "e3", "e2", "e1"].map((id, index) => linked(id, `2026-01-0${4 - index}T00:00:00Z`));
  readPage.mockImplementation(async (read: { limit: number; cursor?: string }) => {
    const remaining = read.cursor?.startsWith("offset:")
      ? rows.slice(Number(read.cursor.slice("offset:".length)))
      : rows.filter((row) => !read.cursor || row.origin_id < read.cursor);
    const page = remaining.slice(0, read.limit);
    return {
      rows: page,
      row_cursors: page.map((row) => row.origin_id),
      ...(remaining.length > page.length ? { next_cursor: `offset:${rows.length - remaining.length + page.length}` } : {}),
    };
  });
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 2 });
  expect(first.events.map((event) => event.origin_id)).toEqual(["e4", "e3"]);
  mutate(rows);
  const second = await reads.readSourceRecordActivity(scope, record, { limit: 2, cursor: first.next_cursor });
  expect(second.events.map((event) => event.origin_id)).toEqual(["e2", "e1"]);
  expect(second.next_cursor).toBeUndefined();
});

it("reports page-only feeds as unsupported for merged activity without breaking their read path", async () => {
  readPage.mockResolvedValue({ rows: [linked("e1", "2026-01-01T00:00:00Z")], next_cursor: "provider-page-2" });
  const result = await reads.readSourceRecordActivity(scope, record, { limit: 2 });
  expect(result.events).toEqual([]);
  expect(result.failures).toEqual([{ feed_id: 1, error: expect.stringContaining("exact row cursors") }]);
  expect(result.next_cursor).toBeDefined();
});
