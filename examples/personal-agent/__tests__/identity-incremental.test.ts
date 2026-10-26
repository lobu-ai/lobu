import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { runIncrementalIdentity } from "../identity-incremental.ts";

const binding = {
  provider: "linkedin" as const,
  account_scope: "synthetic-saved-account",
  connection_id: 202,
  feed_id: 101,
  source_scope: "synthetic-source-scope",
};
const request = {
  workspace: "synthetic-workspace",
  reader_id: "external-client-a",
  automation_id: 303,
  sources: [binding],
};
const reference = {
  connection_id: 202,
  feed_id: 101,
  created_at: "2026-01-01T00:00:00Z",
  metadata: {
    observation_id: "observation-a",
    resource_ref: "native-message-a",
    resource_type: "message",
    source_scope: binding.source_scope,
  },
};

function fixture() {
  const entities = new Map<number, Record<string, any>>();
  let writes = 0,
    reads = 0,
    sourceReads = 0;
  let changes: any = {
    content: [reference],
    page: { has_more: false },
    resume_cursor: "cursor-b",
  };
  let result: any = {
    feed_id: 101,
    ok: true,
    rows: [
      {
        id: "native-message-a",
        sender_member_id: "1234567",
        sender_slug: "synthetic-contact",
        from_me: false,
        text: "private-body-never-persist",
      },
    ],
  };
  const workspace = {
    query: async (sql: string) =>
      [...entities.values()].filter((row) => sql.includes(`'${row.slug}'`)),
    entities: {
      create: async (input: any) => {
        writes++;
        const entity = structuredClone({ ...input, id: entities.size + 1 });
        entities.set(entity.id, entity);
        return { entity };
      },
      get: async ({ entity_id }: any) => ({
        entity: structuredClone(entities.get(entity_id)),
      }),
      update: async (input: any) => {
        writes++;
        Object.assign(entities.get(input.entity_id)!, structuredClone(input));
        return { success: true };
      },
      listLinks: async () => {
        throw new Error("No person or alias links expected");
      },
      link: async () => {
        throw new Error("No person or alias links expected");
      },
    },
    knowledge: {
      read: async (_input: any) => {
        reads++;
        return structuredClone(changes);
      },
    },
    feeds: {
      get: async (_input: any) => ({
        feed: {
          id: 101,
          connection_id: 202,
          feed_key: "live_messages",
          config: {},
          operations: ["read"],
        },
      }),
      readMany: async (_input: any) => {
        sourceReads++;
        return { results: [structuredClone(result)] };
      },
    },
  };
  return {
    client: { org: async () => workspace },
    entities,
    workspace,
    setChanges: (next: any) => {
      changes = next;
    },
    setResult: (next: any) => {
      result = next;
    },
    counts: () => ({ writes, reads, sourceReads }),
  };
}

test("poll projects metadata and leaves the accepted cursor unchanged until import and verify", async () => {
  const f = fixture();
  const prepared = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
  });
  expect(f.counts().writes).toBe(0);
  expect(prepared.state.cursor).toBeUndefined();
  expect(prepared.state.pending?.next_cursor).toBe("cursor-b");
  expect(JSON.stringify(prepared)).not.toContain("private-body");
  const imported = await runIncrementalIdentity(f.client, {
    ...request,
    action: "advance",
    state: prepared.state,
  });
  expect(imported.state.cursor).toBeUndefined();
  const verified = await runIncrementalIdentity(f.client, {
    ...request,
    action: "advance",
    state: imported.state,
  });
  expect(verified.state.pending).toBeUndefined();
  expect(verified.state.cursor).toBe("cursor-b");
  expect(f.entities.size).toBe(2);
  expect(
    [...f.entities.values()].every(
      (row) => row.metadata.provider === "linkedin"
    )
  ).toBe(true);
  expect(JSON.stringify([...f.entities.values()])).not.toContain(
    "private-body"
  );
});

test("lost import response replays the same pending batch with zero additional writes", async () => {
  const f = fixture();
  const prepared = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
  });
  await runIncrementalIdentity(f.client, {
    ...request,
    action: "advance",
    state: prepared.state,
  });
  const before = f.counts().writes;
  await runIncrementalIdentity(f.client, {
    ...request,
    action: "advance",
    state: prepared.state,
  });
  expect(f.counts().writes).toBe(before);
  expect(prepared.state.pending?.phase).toBe("import");
});

test("missing native rows remain durable and retryable without inventing people", async () => {
  const f = fixture();
  f.setResult({ feed_id: 101, ok: true, rows: [] });
  const result = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
  });
  expect(result.state.cursor).toBe("cursor-b");
  expect(result.state.unresolved).toHaveLength(1);
  expect(result.state.unresolved[0].status).toBe("native_unavailable");
  expect(f.counts().writes).toBe(0);
  f.setChanges({
    content: [],
    page: { has_more: false },
    resume_cursor: "cursor-c",
  });
  f.setResult({
    feed_id: 101,
    ok: true,
    rows: [{ id: "native-message-a", sender_member_id: "1234567" }],
  });
  const retried = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
    state: result.state,
  });
  expect(retried.state.pending).toBeDefined();
  expect(retried.state.unresolved).toHaveLength(1); // removed only after verified acceptance
});

test("notifications are reviewed without fetching bodies or creating identities", async () => {
  const f = fixture();
  f.setChanges({
    content: [
      {
        ...reference,
        metadata: { ...reference.metadata, resource_type: "notification" },
      },
    ],
    page: { has_more: false },
    resume_cursor: "cursor-b",
  });
  const result = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
  });
  expect(result.state.cursor).toBe("cursor-b");
  expect(f.counts()).toMatchObject({ writes: 0, sourceReads: 0 });
});

test.each([
  {
    provider: "whatsapp" as const,
    sender_jid: "441234567890@s.whatsapp.net",
    sender_phone: "441234567890",
  },
  { provider: "x" as const, sender_id: "1234567", sender_handle: "synthetic" },
])("repeated $provider senders keep one alias and every observation", async ({
  provider,
  ...sender
}) => {
  const f = fixture();
  f.setChanges({
    content: [
      reference,
      {
        ...reference,
        metadata: {
          ...reference.metadata,
          observation_id: "observation-b",
          resource_ref: "native-message-b",
        },
      },
    ],
    page: { has_more: false },
    resume_cursor: "cursor-b",
  });
  f.workspace.feeds.readMany = async ({ reads }) => ({
    results: [
      {
        feed_id: 101,
        ok: true,
        rows: [{ id: reads[0].query.slice(3), ...sender, from_me: false }],
      },
    ],
  });
  const result = await runIncrementalIdentity(f.client, {
    ...request,
    sources: [{ ...binding, provider }],
    action: "poll",
  });
  expect(result.state.pending?.input.aliases).toHaveLength(1);
  expect(result.state.pending?.input.observations).toHaveLength(4);
  expect(
    new Set(
      result.state.pending?.input.observations.flatMap((item) =>
        item.source_refs.map((ref) => ref.origin_id)
      )
    ).size
  ).toBe(2);
  if (provider === "x") {
    f.workspace.feeds.readMany = async ({ reads }) => ({
      results: [
        {
          feed_id: 101,
          ok: true,
          rows: [
            {
              id: reads[0].query.slice(3),
              sender_id: "1234567",
              sender_handle: reads[0].query.endsWith("-a")
                ? "synthetic"
                : "different",
              from_me: false,
            },
          ],
        },
      ],
    });
    await expect(
      runIncrementalIdentity(f.client, {
        ...request,
        sources: [{ ...binding, provider }],
        action: "poll",
      })
    ).rejects.toThrow("conflicting alias evidence");
  }
});

test("a group identifier alone does not resolve a missing WhatsApp sender", async () => {
  const f = fixture();
  f.setResult({
    feed_id: 101,
    ok: true,
    rows: [
      { id: "native-message-a", is_group: true, chat_jid: "123456789@g.us" },
    ],
  });
  const result = await runIncrementalIdentity(f.client, {
    ...request,
    sources: [{ ...binding, provider: "whatsapp" }],
    action: "poll",
  });
  expect(result.state.unresolved[0]?.status).toBe(
    "unsupported_participant_metadata"
  );
  expect(result.state.pending).toBeUndefined();
});

test("missing participant identifiers remain unresolved while outgoing messages are accepted", async () => {
  for (const from_me of [false, true]) {
    const f = fixture();
    f.setResult({
      feed_id: 101,
      ok: true,
      rows: [{ id: "native-message-a", from_me }],
    });
    const result = await runIncrementalIdentity(f.client, {
      ...request,
      action: "poll",
    });
    expect(result.state.unresolved).toHaveLength(from_me ? 0 : 1);
    if (!from_me)
      expect(result.state.unresolved[0].status).toBe(
        "unsupported_participant_metadata"
      );
  }
});

test("notification references must belong to the bound source", async () => {
  const f = fixture();
  f.setChanges({
    content: [
      {
        ...reference,
        metadata: {
          ...reference.metadata,
          resource_type: "notification",
          source_scope: "different-scope",
        },
      },
    ],
    page: { has_more: false },
    resume_cursor: "cursor-b",
  });
  await expect(
    runIncrementalIdentity(f.client, { ...request, action: "poll" })
  ).rejects.toThrow("source scope");
});

test("observation IDs are scoped to their source and checked against all saved unresolved references", async () => {
  const f = fixture();
  const secondBinding = { ...binding, feed_id: 102, connection_id: 203 };
  const refs = [
    reference,
    { ...reference, feed_id: 102, connection_id: 203 },
  ].map((row) => ({
    ...row,
    metadata: { ...row.metadata, resource_type: "source_gap" },
  }));
  f.setChanges({
    content: refs,
    page: { has_more: false },
    resume_cursor: "cursor-b",
  });
  const result = await runIncrementalIdentity(f.client, {
    ...request,
    sources: [binding, secondBinding],
    action: "poll",
  });
  expect(result.state.unresolved).toHaveLength(2);
  const state = structuredClone(result.state);
  state.unresolved = Array.from({ length: 6 }, (_, i) => ({
    reference: {
      ...refs[0],
      metadata: { ...refs[0].metadata, observation_id: `saved-${i}` },
    },
    status: "source_gap_or_unsupported",
  }));
  f.setChanges({
    content: [
      {
        ...state.unresolved[5].reference,
        metadata: {
          ...state.unresolved[5].reference.metadata,
          resource_ref: "changed",
        },
      },
    ],
    page: { has_more: false },
    resume_cursor: "cursor-c",
  });
  await expect(
    runIncrementalIdentity(f.client, {
      ...request,
      sources: [binding, secondBinding],
      action: "poll",
      state,
    })
  ).rejects.toThrow("Observation identity changed");
});

test("source errors, malformed pages and changed account scope fail without advancing caller state", async () => {
  const f = fixture();
  f.setResult({
    feed_id: 101,
    ok: false,
    error_code: "PERMISSION",
    error: "private error text",
  });
  await expect(
    runIncrementalIdentity(f.client, { ...request, action: "poll" })
  ).rejects.toThrow("PERMISSION");
  f.setChanges({ content: [], page: { has_more: true } });
  await expect(
    runIncrementalIdentity(f.client, { ...request, action: "poll" })
  ).rejects.toThrow("cursor");
  const g = fixture();
  const prepared = await runIncrementalIdentity(g.client, {
    ...request,
    action: "poll",
  });
  await expect(
    runIncrementalIdentity(g.client, {
      ...request,
      sources: [{ ...binding, account_scope: "different-account" }],
      action: "advance",
      state: prepared.state,
    })
  ).rejects.toThrow("scope");
  expect(g.counts().writes).toBe(0);
});

test("native IDs, result arity, source scopes and changing feed configs fail closed", async () => {
  const wrong = fixture();
  wrong.setResult({
    feed_id: 101,
    ok: true,
    rows: [{ id: "different-message" }],
  });
  await expect(
    runIncrementalIdentity(wrong.client, { ...request, action: "poll" })
  ).rejects.toThrow("identity mismatch");
  const missing = fixture();
  missing.workspace.feeds.readMany = async () => ({ results: [] });
  await expect(
    runIncrementalIdentity(missing.client, { ...request, action: "poll" })
  ).rejects.toThrow("Incomplete");
  const scope = fixture();
  scope.setChanges({
    content: [
      {
        ...reference,
        metadata: { ...reference.metadata, source_scope: "different-scope" },
      },
    ],
    page: { has_more: false },
    resume_cursor: "cursor-b",
  });
  await expect(
    runIncrementalIdentity(scope.client, { ...request, action: "poll" })
  ).rejects.toThrow("source scope");
  const moving = fixture();
  const get = moving.workspace.feeds.get;
  let calls = 0;
  moving.workspace.feeds.get = async (input) => {
    const result = await get(input);
    result.feed.config = { revision: ++calls };
    return result;
  };
  await expect(
    runIncrementalIdentity(moving.client, { ...request, action: "poll" })
  ).rejects.toThrow("configuration changed");
  expect(
    [wrong, missing, scope, moving].every((f) => f.counts().writes === 0)
  ).toBe(true);
});

test("duplicate observations dedupe before native reads and contradictory IDs stop", async () => {
  const f = fixture();
  f.setChanges({
    content: [
      reference,
      reference,
      {
        ...reference,
        metadata: { ...reference.metadata, observation_id: "observation-b" },
      },
    ],
    page: { has_more: false },
    resume_cursor: "cursor-b",
  });
  const prepared = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
  });
  expect(f.counts().sourceReads).toBe(1);
  expect(prepared.state.pending?.input.observations).toHaveLength(4);
  f.setChanges({
    content: [
      reference,
      {
        ...reference,
        metadata: { ...reference.metadata, resource_ref: "changed" },
      },
    ],
    page: { has_more: false },
    resume_cursor: "cursor-b",
  });
  await expect(
    runIncrementalIdentity(f.client, { ...request, action: "poll" })
  ).rejects.toThrow("Observation identity changed");
});

test("pending input tampering and verify failures preserve the accepted cursor", async () => {
  const f = fixture();
  const prepared = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
  });
  const tampered = structuredClone(prepared.state);
  tampered.pending!.next_cursor = "forged";
  await expect(
    runIncrementalIdentity(f.client, {
      ...request,
      action: "advance",
      state: tampered,
    })
  ).rejects.toThrow("Pending batch changed");
  const imported = await runIncrementalIdentity(f.client, {
    ...request,
    action: "advance",
    state: prepared.state,
  });
  f.entities.clear();
  await expect(
    runIncrementalIdentity(f.client, {
      ...request,
      action: "advance",
      state: imported.state,
    })
  ).rejects.toThrow();
  expect(imported.state.cursor).toBeUndefined();
  expect(imported.state.pending?.phase).toBe("verify");
});

test("gap dispositions remain explicit and unresolved retries rotate within the budget", async () => {
  const f = fixture();
  const gap = (index: number) => ({
    ...reference,
    metadata: {
      ...reference.metadata,
      observation_id: `gap-${index}`,
      resource_type: "source_gap",
    },
  });
  f.setChanges({
    content: Array.from({ length: 10 }, (_, i) => gap(i)),
    page: { has_more: true },
    next_cursor: "cursor-b",
  });
  const first = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
  });
  expect(first.state.unresolved).toHaveLength(10);
  f.setChanges({
    content: [],
    page: { has_more: false },
    resume_cursor: "cursor-c",
  });
  const second = await runIncrementalIdentity(f.client, {
    ...request,
    action: "poll",
    state: first.state,
  });
  expect(second.state.unresolved[0].reference.metadata.observation_id).toBe(
    "gap-5"
  );
  expect(
    second.state.unresolved.every(
      (entry) => entry.status === "source_gap_or_unsupported"
    )
  ).toBe(true);
  expect(f.counts()).toMatchObject({ writes: 0, sourceReads: 0 });
  const overflow = structuredClone(first.state);
  overflow.unresolved = Array.from({ length: 65 }, (_, i) => ({
    reference: gap(i),
    status: "source_gap_or_unsupported",
  }));
  await expect(
    runIncrementalIdentity(f.client, {
      ...request,
      action: "poll",
      state: overflow,
    })
  ).rejects.toThrow("Unresolved source limit");
});

test("published incremental asset runs without Node/Bun/filesystem and matches the source implementation", async () => {
  const asset = readFileSync(
    new URL("../identity-incremental.mcp.js", import.meta.url),
    "utf8"
  );
  expect(
    asset.replace(/%([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  ).not.toMatch(
    /\/(?:Users|home)\/|file:\/\/|[a-z]:\\|sourceMappingURL|require\(/i
  );
  const execute = runInNewContext(
    `${asset.replace(/export\s*\{runIncrementalIdentity\};?\s*$/, "globalThis.execute = runIncrementalIdentity;")};execute`,
    {},
    { timeout: 3000 }
  );
  const source = fixture(),
    bundled = fixture();
  const expected = await runIncrementalIdentity(source.client, {
    ...request,
    action: "poll",
  });
  const prepared = await execute(bundled.client, {
    ...request,
    action: "poll",
  });
  expect(JSON.parse(JSON.stringify(prepared))).toEqual(expected);
  const imported = await execute(bundled.client, {
    ...request,
    action: "advance",
    state: prepared.state,
  });
  expect(
    await execute(bundled.client, {
      ...request,
      action: "advance",
      state: imported.state,
    })
  ).toMatchObject({ phase: "accepted", state: { cursor: "cursor-b" } });
  expect(bundled.entities.size).toBe(2);
});
