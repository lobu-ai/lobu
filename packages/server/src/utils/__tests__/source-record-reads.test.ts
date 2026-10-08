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
  connection_id: 10,
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

it("preserves rich event content without accepting stored identity or action state", async () => {
  const content = {
    semantic_type: "summary",
    payload_type: "json_template",
    payload_data: { summary: "Account summary", items: ["one", "two"] },
    payload_template: { type: "div", children: "{{summary}}" },
    attachments: [{ url: "https://example.test/report.pdf", mime_type: "application/pdf" }],
  };
  readPage.mockResolvedValue({
    row_cursors: ["rich"],
    rows: [{
      ...linked("rich", "2026-01-01T00:00:00Z"), ...content,
      id: 99, feed_id: 999, run_id: 17, automation_id: 18,
      interaction_type: "approval", interaction_status: "pending",
    }],
  });
  const result = await reads.readSourceRecordActivity(scope, record, { limit: 10 });
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({ ...content, feed_id: 1, platform: "test_source", origin_id: "rich" });
  for (const field of ["id", "run_id", "automation_id", "interaction_type", "interaction_status"]) {
    expect(result.events[0]).not.toHaveProperty(field);
  }
});

it("keeps ordinary source events readable when rich envelope fields are omitted", async () => {
  readPage.mockResolvedValue({
    row_cursors: ["plain"],
    rows: [{ ...linked("plain", "2026-01-01T00:00:00Z"), payload_text: "Plain event" }],
  });
  const result = await reads.readSourceRecordActivity(scope, record, { limit: 10 });
  expect(result.events[0]).toMatchObject({
    payload_text: "Plain event", semantic_type: "linked", payload_type: "text",
    payload_data: {}, payload_template: null, attachments: [],
  });
});

it("does not invent relationships for an event with no declaring kind", async () => {
  readPage.mockResolvedValue({
    row_cursors: ["untyped"],
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
  expect(result.failures).toEqual([]);
});

it.each([
  {},
  { "1:metadata.account_id": 1 },
  { "1:metadata.account_id": {} },
])("rejects malformed cursor streams: %j", async (cursor) => {
  readPage.mockRejectedValueOnce(new Error("retry"));
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 10 });
  const payload = JSON.parse(Buffer.from(first.next_cursor!, "base64url").toString("utf8"));
  readPage.mockClear();
  await expect(
    reads.readSourceRecordActivity(scope, record, {
      limit: 10,
      cursor: Buffer.from(JSON.stringify({ ...payload, streams: cursor })).toString("base64url"),
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

it("deduplicates the first relationship page when cursor is omitted", async () => {
  readPage.mockResolvedValue({ rows: [linked("new", "2026-01-02", "c1"), linked("old", "2026-01-01", "c1")], row_cursors: ["new", "old"] });
  const result = await reads.readSourceRecordLinks(scope, record, { limit: 10 });
  expect(result.next_cursor).toBeNull();
  expect(result.links).toHaveLength(1);
  expect(result.links[0].occurred_at).toBe("2026-01-02T00:00:00.000Z");
});

it.each([undefined, null])("starts a bounded first page with cursor %s and resumes without scanning ahead", async (cursor) => {
  const rows = Array.from({ length: 2107 }, (_, n) => linked(`e${3000 - n}`, "2026-01-01", `c${n}`));
  readPage.mockImplementation(async ({ limit, cursor }) => {
    const start = cursor ? rows.findIndex(row => row.origin_id === cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    return { rows: page, row_cursors: page.map(row => row.origin_id), next_cursor: page.at(-1)!.origin_id };
  });
  const first = await reads.readSourceRecordLinks(scope, record, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
  expect(first.failures).toEqual([]);
  expect(first.links.map(link => link.key)).toEqual(["c0", "c1"]);
  expect(first.next_cursor).toEqual(expect.any(String));
  expect(readPage).toHaveBeenCalledOnce();
  expect(readPage).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2, cursor: undefined }), expect.anything(), scope, undefined, undefined);
  const second = await reads.readSourceRecordLinks(scope, record, { limit: 2, cursor: first.next_cursor });
  expect(second.links.map(link => link.key)).toEqual(["c2", "c3"]);
  expect(readPage).toHaveBeenCalledTimes(2);
});

it("pages past the old source scan cap with bounded cursors and no skipped destinations", async () => {
  const rows = Array.from({ length: 2107 }, (_, n) => linked(`e${String(3000 - n).padStart(4, "0")}`, "2026-01-01", `c${n}`));
  readPage.mockImplementation(async ({ limit, cursor }) => {
    const start = cursor ? rows.findIndex(row => row.origin_id === cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    return { rows: page, row_cursors: page.map(row => row.origin_id), ...(start + page.length < rows.length ? { next_cursor: page.at(-1)!.origin_id } : {}) };
  });
  let cursor: string | null = null;
  const seen: string[] = [];
  do {
    const page = await reads.readSourceRecordLinks(scope, record, { limit: 100, cursor });
    expect(page.failures).toEqual([]);
    expect(page.links.length).toBeLessThanOrEqual(100);
    seen.push(...page.links.map(link => link.key));
    cursor = page.next_cursor ?? null;
    if (cursor) expect(cursor.length).toBeLessThan(2000);
  } while (cursor);
  expect(seen).toEqual(rows.map(row => row.metadata.contact_id));
  expect(readPage).toHaveBeenCalledTimes(22);
});

it("resumes all relationships from one event when they cross a page boundary", async () => {
  feeds = [{ ...feed, feed_schema: { ...feed.feed_schema, eventKinds: { linked: {
    ...feed.feed_schema.eventKinds.linked,
    relationships: [{ type: "knows", from: "account", to: "contact" }, { type: "owns", from: "account", to: "contact" }],
  } } } }];
  readPage.mockResolvedValue({ rows: [linked("e1", "2026-01-01")], row_cursors: ["e1"] });
  const first = await reads.readSourceRecordLinks(scope, record, { limit: 1, cursor: null });
  expect(first.links.map(link => link.relationship_type)).toEqual(["knows"]);
  expect(first.next_cursor).toEqual(expect.any(String));
  const second = await reads.readSourceRecordLinks(scope, record, { limit: 1, cursor: first.next_cursor });
  expect(second.links.map(link => link.relationship_type)).toEqual(["owns"]);
  expect(second.next_cursor).toBeNull();
});

it("preserves a failed stream for retry while returning authorized partial links", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  readPage.mockImplementation(async ({ feed_id }) => {
    if (feed_id === 2) throw new Error("source unavailable");
    return { rows: [linked("e1", "2026-01-01")], row_cursors: ["e1"] };
  });
  const first = await reads.readSourceRecordLinks(scope, record, { limit: 10, cursor: null });
  expect(first.links).toHaveLength(1);
  expect(first.failures).toEqual([{ feed_id: 2, error: "source unavailable" }]);
  readPage.mockReset().mockResolvedValue({ rows: [linked("e2", "2026-01-02", "c2")], row_cursors: ["e2"] });
  const second = await reads.readSourceRecordLinks(scope, record, { limit: 10, cursor: first.next_cursor });
  expect(second.links.map(link => link.key)).toEqual(["c2"]);
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(readPage.mock.calls[0][0].feed_id).toBe(2);
});

it("binds relationship cursors to the caller, record and filters", async () => {
  readPage.mockResolvedValue({ rows: [linked("e1", "2026-01-01")], row_cursors: ["e1"], next_cursor: "e1" });
  const first = await reads.readSourceRecordLinks(scope, record, { limit: 1, cursor: null });
  readPage.mockClear();
  for (const [auth, ref, filters] of [
    [{ ...scope, principal: "other" }, record, {}],
    [scope, { ...record, key: "a2" }, {}],
    [scope, record, { direction: "incoming" as const }],
    [scope, record, { relationshipType: "other" }],
  ] as const) {
    await expect(reads.readSourceRecordLinks(auth, ref, { limit: 1, cursor: first.next_cursor, ...filters })).rejects.toThrow(/cursor/i);
  }
  expect(readPage).not.toHaveBeenCalled();
});

it("does not claim exhaustion for an empty source page with a continuation", async () => {
  readPage.mockResolvedValueOnce({ rows: [], next_cursor: "empty-page" });
  const first = await reads.readSourceRecordLinks(scope, record, { limit: 10, cursor: null });
  expect(first.links).toEqual([]);
  expect(first.next_cursor).toEqual(expect.any(String));
  readPage.mockResolvedValueOnce({ rows: [linked("e1", "2026-01-01")], row_cursors: ["e1"] });
  const second = await reads.readSourceRecordLinks(scope, record, { limit: 10, cursor: first.next_cursor });
  expect(second.links).toHaveLength(1);
  expect(second.next_cursor).toBeNull();
});

it("merges relationship streams newest first even when one source uses short pages", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  pagedSource({
    1: [linked("e5", "2026-01-05", "c5"), linked("e3", "2026-01-03", "c3"), linked("e1", "2026-01-01", "c1")],
    2: [linked("e4", "2026-01-04", "c4"), linked("e2", "2026-01-02", "c2")],
  });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page = await reads.readSourceRecordLinks(scope, record, { cursor, limit: 3 });
    seen.push(...page.links.map(link => link.key));
    cursor = page.next_cursor ?? null;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(seen).toEqual(["c5", "c4", "c3", "c2", "c1"]);
});

it("does not apply a deleted row's partial relationship position to its successor", async () => {
  feeds = [{ ...feed, feed_schema: { ...feed.feed_schema, eventKinds: { linked: {
    ...feed.feed_schema.eventKinds.linked,
    relationships: [{ type: "knows", from: "account", to: "contact" }, { type: "owns", from: "account", to: "contact" }],
  } } } }];
  readPage.mockResolvedValueOnce({ rows: [linked("new", "2026-01-02")], row_cursors: ["new"], next_cursor: "new" });
  const first = await reads.readSourceRecordLinks(scope, record, { cursor: null, limit: 1 });
  readPage.mockResolvedValueOnce({ rows: [linked("old", "2026-01-01", "c2")], row_cursors: ["old"] });
  const second = await reads.readSourceRecordLinks(scope, record, { cursor: first.next_cursor, limit: 2 });
  expect(second.links.map(link => [link.relationship_type, link.key])).toEqual([["knows", "c2"], ["owns", "c2"]]);
  expect(second.next_cursor).toBeNull();
});

it("fails explicitly when a source cannot supply per-row checkpoints", async () => {
  readPage.mockResolvedValue({ rows: [linked("e1", "2026-01-01")] });
  const page = await reads.readSourceRecordLinks(scope, record, { cursor: null, limit: 10 });
  expect(page.links).toEqual([]);
  expect(page.failures).toEqual([{ feed_id: 1, error: expect.stringMatching(/per-row/) }]);
  expect(page.next_cursor).toEqual(expect.any(String));
});

it("rejects invented stream keys even when a cursor retains its original request binding", async () => {
  readPage.mockResolvedValue({ rows: [], next_cursor: "more" });
  const first = await reads.readSourceRecordLinks(scope, record, { cursor: null, limit: 10 });
  const payload = JSON.parse(Buffer.from(first.next_cursor!, "base64url").toString());
  payload.streams = { unknown: { after: null, event: null, skip: 0 } };
  readPage.mockClear();
  await expect(reads.readSourceRecordLinks(scope, record, { limit: 10, cursor: Buffer.from(JSON.stringify(payload)).toString("base64url") })).rejects.toThrow(/cursor streams/);
  expect(readPage).not.toHaveBeenCalled();
});

it("rejects an impossible relationship row position instead of retaining a failed stream", async () => {
  readPage.mockResolvedValue({ rows: [], next_cursor: "more" });
  const first = await reads.readSourceRecordLinks(scope, record, { cursor: null, limit: 10 });
  const payload = JSON.parse(Buffer.from(first.next_cursor!, "base64url").toString());
  const stream = Object.keys(payload.streams)[0];
  payload.streams[stream] = { after: null, event: "e1", skip: 999 };
  readPage.mockClear();
  await expect(reads.readSourceRecordLinks(scope, record, {
    limit: 10,
    cursor: Buffer.from(JSON.stringify(payload)).toString("base64url"),
  })).rejects.toMatchObject({ httpStatus: 400 });
  expect(readPage).not.toHaveBeenCalled();
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
  expect(result.links).toEqual([]);
  expect(result.next_cursor).toEqual(expect.any(String));
  const next = await reads.readSourceRecordLinks(scope, record, { limit: 10, cursor: result.next_cursor });
  expect(next.links.map((link) => link.key)).toEqual(["c7"]);
  expect(next.next_cursor).toBeNull();
});

it("returns continuation after an empty source page instead of scanning to a cap", async () => {
  readPage.mockResolvedValue({ rows: [], next_cursor: "more" });
  const result = await reads.readSourceRecordLinks(scope, record, { limit: 10 });
  expect(result.links).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.next_cursor).toEqual(expect.any(String));
  expect(readPage).toHaveBeenCalledOnce();
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

it.each([
  [{ feed_ids: [2] }, [2]],
  [{ connection_ids: [10] }, [1, 3]],
  [{ platforms: ["other_source"] }, [3]],
  [{ platforms: ["test_source"], connection_ids: [10], feed_ids: [1, 2, 3] }, [1]],
  [{ connection_ids: [10], feed_ids: [2] }, []],
  [{ platforms: ["missing_source"] }, []],
  [{ platforms: ["   "] }, [1, 2, 3]],
  [{ connection_ids: [999] }, []],
  [{ feed_ids: [999] }, []],
  [{ platforms: [], connection_ids: [], feed_ids: [] }, [1, 2, 3]],
])("narrows authorized feeds before remote reads: %j", async (filters, expected) => {
  feeds = [feed, { ...feed, feed_id: 2, connection_id: 20 }, { ...feed, feed_id: 3, connector_key: "other_source" }];
  readPage.mockResolvedValue({ rows: [] });
  const result = await reads.readSourceRecordActivity(scope, record, { limit: 10, ...filters });
  expect(readPage.mock.calls.map(([read]) => read.feed_id).sort()).toEqual(expected);
  expect(result.failures).toEqual([]);
});

it("retains selected feeds across exact-cursor pagination", async () => {
  feeds = [feed, { ...feed, feed_id: 2 }];
  pagedSource({
    1: [linked("excluded", "2026-01-09T00:00:00Z")],
    2: [linked("e3", "2026-01-03T00:00:00Z"), linked("e2", "2026-01-02T00:00:00Z"), linked("e1", "2026-01-01T00:00:00Z")],
  });
  const options = { limit: 2, feed_ids: [2], connection_ids: [10], platforms: ["test_source"] };
  const first = await reads.readSourceRecordActivity(scope, record, options);
  const second = await reads.readSourceRecordActivity(scope, record, { ...options, cursor: first.next_cursor });
  expect(first.events.map((row) => row.origin_id)).toEqual(["e3", "e2"]);
  expect(second.events.map((row) => row.origin_id)).toEqual(["e1"]);
  expect(second.next_cursor).toBeUndefined();
  expect(readPage.mock.calls.every(([read]) => read.feed_id === 2)).toBe(true);
});

it.each([
  { record: { type: "account", key: "a2" } },
  { record: { type: "other", key: "a1" } },
  { scope: { ...scope, organizationId: "other-org" } },
  { options: { feed_ids: [1] } },
  { options: { platforms: ["other_source"] } },
  { options: { connection_ids: [20] } },
])("rejects a continuation used with a different record or selection: %j", async (change) => {
  pagedSource({ 1: [linked("e2", "2026-01-02T00:00:00Z"), linked("e1", "2026-01-01T00:00:00Z")] });
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 1 });
  expect(first.next_cursor).toBeDefined();
  readPage.mockClear();
  await expect(reads.readSourceRecordActivity(change.scope ?? scope, change.record ?? record, {
    limit: 1, cursor: first.next_cursor, ...change.options,
  })).rejects.toThrow(/cursor.*record or filters/i);
  expect(readPage).not.toHaveBeenCalled();
});

it("accepts reordered and duplicate filter selections in a continuation", async () => {
  pagedSource({ 1: [linked("e2", "2026-01-02T00:00:00Z"), linked("e1", "2026-01-01T00:00:00Z")] });
  const first = await reads.readSourceRecordActivity(scope, record, { limit: 1, feed_ids: [2, 1, 1], platforms: ["test_source", "other"] });
  const second = await reads.readSourceRecordActivity(scope, record, {
    limit: 2, feed_ids: [1, 2], platforms: ["other", "test_source"], cursor: first.next_cursor,
  });
  expect(second.events.map((row) => row.origin_id)).toEqual(["e1"]);
  expect(second.next_cursor).toBeUndefined();
});
