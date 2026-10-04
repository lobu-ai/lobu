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
const sql = Object.assign(
  vi.fn(async () => [{ backing_sql: "SELECT 1" }]),
  { unsafe: vi.fn(async () => [feed]) }
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
beforeEach(() => vi.clearAllMocks());
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
