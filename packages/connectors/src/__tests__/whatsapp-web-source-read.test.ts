import { describe, expect, it } from "bun:test";
import { whatsAppWebAdapterProgram } from "../whatsapp-web-adapter.js";
import { WHATSAPP_ADAPTER_VERSION } from "../whatsapp-web-helpers.js";

function sourceRow(
  rowId: number,
  body = `message ${rowId}`,
  group = false,
  remote = group ? "synthetic-group@g.us" : "15550000000@c.us"
) {
  const serialized = `false_${remote}_synthetic-${rowId}`;
  const key = { id: `synthetic-${rowId}`, remote, fromMe: false, toString: () => serialized };
  return { rowId, id: serialized, model: { id: key, attributes: {
    id: key, from: remote, t: 1_787_358_200 + rowId, type: "chat", body,
  } } };
}

function install(
  rows: ReturnType<typeof sourceRow>[],
  missingDatabase = false,
  chats: string[] = [],
  lidToPhone: Record<string, string> = {},
) {
  const requested: string[][] = [];
  let visited = 0;
  let account = "15550000001@c.us";
  let cursorHook = () => {};
  let canceled = false;
  let omit = false;
  let closed = 0;
  let creationAborted = false;
  const db = {
    close: () => { closed++; },
    transaction: (name: string, mode: string) => {
      expect(name).toBe("message");
      expect(mode).toBe("readonly");
      return { objectStore: () => ({ index: (index: string) => {
        expect(index).toBe("rowId");
        return { openCursor: (range: { upper?: number; lower?: number; open: boolean } | null, direction: string,
              ) => {
          expect(["prev", "next"]).toContain(direction);
          const selected = rows.filter((row) => !range || (range.upper !== undefined ? row.rowId < range.upper : range.open
                          ? row.rowId > range.lower!
                          : row.rowId >= range.lower!),
                  )
            .sort((a, b) => direction === "prev" ? b.rowId - a.rowId : a.rowId - b.rowId,
                  );
          const request: any = {};
          let offset = 0;
          const advance = () => queueMicrotask(() => {
                    cursorHook();
            const row = selected[offset++];
            if (row) visited++;
            request.result = row ? { key: row.rowId, value: { id: row.id, rowId: row.rowId, t: row.model.attributes.t, type: row.model.attributes.type }, continue: advance } : null;
            request.onsuccess();
          });
          advance();
      return request;
        },
            };
      },
        }),
      };
    },
  };
  const globals: Record<string, any> = {};
  const page = {
    globalThis: globals,
    window: { require: (name: string) => {
      if (name === "WAWebUserPrefsMeUser")
          return { getMaybeMePnUser: () => account };
      if (name === "WAWebMsgKey") return { fromString: (id: string) => rows.find((row) => row.id === id)!.model.id };
      if (name === "WAWebLidMigrationUtils") return { toPn: async (id: string) => lidToPhone[id] };
      if (name === "WAWebCollections") return {
        Chat: { _models: chats.map((id) => ({ id })) }, Contact: { _models: [] }, Msg: {
          _models: [],
          getMessagesById: async (ids: string[]) => {
            requested.push(ids);
            return { canceled, messages: omit ? [] : ids.map((id) => rows.find((row) => row.id === id)!.model) };
          },
        },
      };
      return null;
    },
    },
    indexedDB: { open: (name: string) => {
      expect(name).toBe("model-storage");
      const request: any = { result: db };
      request.transaction = { abort: () => { creationAborted = true; } };
      queueMicrotask(() => missingDatabase ? request.onupgradeneeded() : request.onsuccess());
      return request;
    },
    },
    IDBKeyRange: { lowerBound: (lower: number, open: boolean) => ({ lower, open }), upperBound: (upper: number, open: boolean) => {
      expect(open).toBe(true);
      return { upper, open };
    },
    },
  };
  new Function(...Object.keys(page), `(${whatsAppWebAdapterProgram.toString()})();`)(...Object.values(page));
  return {
    read: (input: Record<string, unknown> = {}) => globals.__owlettoWhatsAppAdapterV1.invoke({
      op: "read_messages",
        account_id: "15550000001@c.us",
        adapter_version: WHATSAPP_ADAPTER_VERSION, input,
    }),
    changeAccount: () => {
      account = "15550000002@c.us";
    },
    onCursor: (hook: () => void) => {
      cursorHook = hook;
    },
    requested,
    visited: () => visited,
    observe: (input: Record<string, unknown> = {}) => globals.__owlettoWhatsAppAdapterV1.invoke({
      op: "observe_messages",
        account_id: "15550000001@c.us", adapter_version: WHATSAPP_ADAPTER_VERSION, input,
    }),
    cancel: () => { canceled = true; },
    omit: () => { omit = true; },
    closed: () => closed,
    creationAborted: () => creationAborted,
  };
}

describe("WhatsApp source-owned history reads", () => {
  it.each([
    20, 1200,
  ])("rebases a replaced store ending at %i and retains one stable gap", async (size) => {
    const original = sourceRow(1000);
    const old = await install([original]).observe();
    const rows = Array.from({ length: size }, (_, index) =>
      sourceRow(index + 1, "private", false, "15550009999@c.us"),
    );
    const page = install(rows);
    const input = {
      after: old.after,
      anchor: old.anchor,
      started_at: 1_787_358_200,
    };
    const first = await page.observe(input);
    expect(first.gaps).toHaveLength(1);
    expect(first.gaps[0].event_type).toBe("source.gap");
    expect((await page.observe(input)).gaps).toEqual(first.gaps);
    const ids = first.references.map((row: any) => row.id);
    let current = first;
    while (current.hasMore) {
      current = await page.observe({
        ...input,
        after: current.after,
        anchor: current.anchor,
      });
      expect(current.gaps).toEqual([]);
      ids.push(...current.references.map((row: any) => row.id));
    }
    expect(new Set(ids).size).toBe(size);
    expect(page.requested).toHaveLength(0);
  });

  it("reports missing legacy continuity and recovers even an empty rebuilt store", async () => {
    const page = install([]);
    const first = await page.observe({ after: 1000, started_at: 1 });
    expect(first).toMatchObject({
      ok: true,
      after: 0,
      anchor: null,
      references: [],
      hasMore: false,
    });
    expect(first.gaps).toHaveLength(1);
    expect(
      (await page.observe({ after: 0, anchor: first.anchor, started_at: 1 }))
        .gaps,
    ).toEqual([]);
  });

  it("detects another store replacement during paged recovery", async () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      sourceRow(index + 1),
    );
    const page = install(rows);
    const first = await page.observe({
      after: 1000,
      anchor: "lost",
      started_at: 1,
    });
    rows.splice(
      0,
      rows.length,
      sourceRow(1, "replacement", false, "15550009999@c.us"),
    );
    const next = await page.observe({
      after: first.after,
      anchor: first.anchor,
      started_at: 1,
    });
    expect(next.gaps).toHaveLength(1);
    expect(next.references).toHaveLength(1);
    expect(next.after).toBe(1);
  });

  it("retains a placeholder through many newer pages and only removes it with its reference", async () => {
    const rows = Array.from({ length: 1200 }, (_, index) =>
      sourceRow(index + 1),
    );
    rows[0]!.model.attributes.t = 0;
    const page = install(rows);
    let current = await page.observe({ after: 0, started_at: 1 });
    const pending = current.unresolved;
    while (current.hasMore)
      current = await page.observe({ ...current, started_at: 1 });
    expect(current.unresolved).toEqual(pending);
    rows[0]!.model.attributes.t = 1_787_358_201;
    const input = { ...current, started_at: 1 };
    const resolved = await page.observe(input);
    expect(resolved.references.map((row: any) => row.id)).toEqual([
      "synthetic-1",
    ]);
    expect(resolved.unresolved).toEqual([]);
    // Losing the final checkpoint must retry the same native identity.
    expect((await page.observe(input)).references).toEqual(resolved.references);
  });

  it.each([
    "disappeared",
    "expired",
    "capacity",
  ])("reports a gap before losing a %s placeholder", async (kind) => {
    const rows = Array.from(
      { length: kind === "capacity" ? 33 : 1 },
      (_, index) => sourceRow(index + 1),
    );
    for (const row of rows) row.model.attributes.t = 0;
    const page = install(rows);
    const first = await page.observe({ after: 0, started_at: 1 });
    if (kind === "capacity") {
      expect(first.unresolved).toHaveLength(32);
      expect(first.gaps).toHaveLength(1);
      return;
    }
    if (kind === "disappeared") rows.length = 0;
    else first.unresolved[0].first_seen = 1;
    const next = await page.observe({ ...first, started_at: 1 });
    expect(next.unresolved).toEqual([]);
    expect(
      next.gaps.some((gap: any) =>
        gap.resource_ref.includes(
          `placeholder-${kind === "expired" ? "expired" : "unavailable"}`,
        ),
      ),
    ).toBe(true);
  });

  it("tracks a zero-timestamp head in the initial snapshot", async () => {
    const row = sourceRow(1);
    row.model.attributes.t = 0;
    const page = install([row]);
    const baseline = await page.observe();
    expect(baseline.unresolved).toHaveLength(1);
    row.model.attributes.t = 1_787_358_201;
    expect(
      (await page.observe({ ...baseline, started_at: 1 })).references,
    ).toHaveLength(1);
  });

  it.each([
    "read",
    "observe",
  ])("fences %s when the saved account changes during IndexedDB callbacks", async (method) => {
      const page = install([sourceRow(1)]);
    page.onCursor(page.changeAccount);
    const result =
      method === "read"
        ? await page.read()
        : await page.observe({ after: 0, started_at: 1 });
      expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("message 1");
    expect(result.references).toBeUndefined();
    expect(result.results).toBeUndefined();
  });

  it("rejects the saved-account mismatch before even the initial snapshot", async () => {
      const page = install([sourceRow(1)]);
    page.changeAccount();
    const result = await page.observe();
      expect(result.ok).toBe(false);
    expect(page.visited()).toBe(0);
    expect(result.after).toBeUndefined();
  });

  it("rejects a read cursor bound to another account without loading bodies", async () => {
    const page = install([sourceRow(1), sourceRow(2)]);
    const first = await page.read({ limit: 1 });
    const cursor = JSON.parse(first.nextCursor);
    cursor.account = "15550000002@c.us";
    const before = page.requested.length;
    expect((await page.read({ limit: 1, cursor: JSON.stringify(cursor) })).ok).toBe(false);
    expect(page.requested.length).toBe(before);
  });

  it("recovers retained inserts after the local rowId sequence resets", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => sourceRow(index + 1));
    const page = install(rows);
    const result = await page.observe({
      after: 1000,
      started_at: 1_787_358_200,
      chat_filter: "all",
    });
    expect(result.references?.map((row: { id: string }) => row.id)).toEqual(
      rows.map((row) => row.model.id.id),
    );
    expect(page.requested).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("message 1");
  });

  it("rechecks a placeholder hydrated behind an accepted replay cursor", async () => {
    const placeholder = sourceRow(1, "private delayed body");
    placeholder.model.attributes.t = 0;
    const page = install([placeholder, sourceRow(2)]);
    const first = await page.observe({ after: 0, started_at: 1_787_358_200 });
    expect(first.references.map((row: { id: string }) => row.id)).toEqual([
      "synthetic-2",
    ]);
    placeholder.model.attributes.t = 1_787_358_201;
    const hydrated = await page.observe({
      after: first.after,
      anchor: first.anchor,
      unresolved: first.unresolved,
      started_at: 1_787_358_200,
    });
    expect(hydrated.references?.map((row: { id: string }) => row.id)).toEqual([
      "synthetic-1",
    ]);
    expect(page.requested).toHaveLength(0);
    expect(JSON.stringify(hydrated)).not.toContain("private delayed body");
  });

  it("replays inserts after a source cursor across reconnects without exporting content", async () => {
    const rows = [sourceRow(1)];
    const page = install(rows);
    expect(await page.observe()).toMatchObject({ after: 1, references: [] });
    expect(page.requested).toHaveLength(0);
    rows.push(sourceRow(2, "private offline message"));
    const reconnected = install(rows);
    const result = await reconnected.observe({ after: 1,
      anchor: rows[0]!.id,
      started_at: 1_787_358_200, chat_filter: "all",
    });
    expect(result).toMatchObject({ ok: true, after: 2, hasMore: false, references: [
      { id: "synthetic-2", timestamp: 1_787_358_202, is_group: false },
    ] });
    expect(JSON.stringify(result)).not.toContain("private offline message");
    expect(reconnected.requested).toHaveLength(0);
    expect((await reconnected.observe({ after: 2,
          anchor: rows[1]!.id,
          started_at: 1_787_358_200,
        })).references,
    ).toEqual([]);
  });

  it("pages a reconnect burst without skipping messages", async () => {
    const page = install(Array.from({ length: 501 }, (_, i) => sourceRow(i + 1)));
    const first = await page.observe({ after: 0, started_at: 1_787_358_200 });
    expect(first).toMatchObject({ after: 500, hasMore: true });
    expect(first.references).toHaveLength(500);
    const last = await page.observe({ after: first.after,
      anchor: first.anchor,
      started_at: 1_787_358_200,
    });
    expect(last).toMatchObject({ after: 501, hasMore: false, references: [{ id: "synthetic-501" }] });
  });

  it("does not let a timestamp-zero placeholder block later message references", async () => {
    const placeholder = sourceRow(1);
    placeholder.model.attributes.t = 0;
    const page = install([placeholder, sourceRow(2)]);
    expect(await page.observe({ after: 0, started_at: 1_787_358_200 }),
    ).toMatchObject({
      ok: true, after: 2, references: [{ id: "synthetic-2" }], hasMore: false,
    });
  });

  it("skips status entries during replay without requesting private message models", async () => {
    const status = sourceRow(1);
    status.model.id.remote = "status@broadcast";
    const page = install([status, sourceRow(2)]);
    page.omit(); // Native message loading is deliberately unavailable.
    expect(await page.observe({ after: 0, started_at: 1_787_358_200 }),
    ).toMatchObject({
      ok: true, after: 2, references: [{ id: "synthetic-2" }], hasMore: false,
    });
    expect(page.requested).toHaveLength(0);
  });
  it("refuses to create an empty database when source history is unavailable", async () => {
    const page = install([], true);
    const result = await page.read();
    expect(result.ok).toBe(false);
    expect(result.error.reason).toContain("source history database is unavailable");
    expect(page.creationAborted()).toBe(true);
    expect(page.requested).toHaveLength(0);
  });

  it("hydrates unloaded messages and pages without including concurrent inserts", async () => {
    const rows = [sourceRow(1), sourceRow(2), sourceRow(3)];
    const page = install(rows);
    const first = await page.read({ limit: 2 });
    expect(first).toMatchObject({ ok: true, hasMore: true, results: [
      { id: "synthetic-3", body: "message 3" }, { id: "synthetic-2", body: "message 2" },
    ] });
    rows.push(sourceRow(4));
    const last = await page.read({ limit: 2, cursor: first.nextCursor });
    expect(last).toMatchObject({ ok: true, hasMore: false, results: [{ id: "synthetic-1" }] });
    expect(last.nextCursor).toBeUndefined();
    expect(page.requested.map((ids) => ids.length)).toEqual([2, 1]);
    expect(page.closed()).toBe(2);
  });

  it("continues past empty filtered pages and enforces chat scope", async () => {
    const page = install([sourceRow(1, "needle"), sourceRow(2, "needle", true), sourceRow(3, "other")]);
    const first = await page.read({ limit: 1, query: "needle", chat_filter: "individual" });
    expect(first).toMatchObject({ ok: true, results: [], hasMore: true });
    const second = await page.read({ limit: 1, query: "needle", chat_filter: "individual", cursor: first.nextCursor });
    expect(second).toMatchObject({ ok: true, results: [], hasMore: true });
    const third = await page.read({ limit: 1, query: "needle", chat_filter: "individual", cursor: second.nextCursor });
    expect(third).toMatchObject({ ok: true, results: [{ id: "synthetic-1" }], hasMore: false });
  });

  it("can resolve a durable raw message reference without reading other bodies", async () => {
    const page = install([sourceRow(1), sourceRow(2)]);
    const result = await page.read({ query: "id:synthetic-1" });
    expect(result).toMatchObject({ ok: true, results: [{ id: "synthetic-1" }] });
    expect(page.requested).toEqual([["false_15550000000@c.us_synthetic-1"]]);
  });

  it("finds an exact message id beyond the first storage page", async () => {
    const page = install([sourceRow(1), sourceRow(2), sourceRow(3)]);
    const result = await page.read({ query: "id:synthetic-1", limit: 1 });
    expect(result).toMatchObject({ ok: true, hasMore: false, results: [{ id: "synthetic-1" }] });
    expect(result.nextCursor).toBeUndefined();
    expect(page.requested).toEqual([["false_15550000000@c.us_synthetic-1"]]);
  });

  it("reads one chat's newest messages across pages without matching text", async () => {
    const other = "15550000001@c.us";
    const rows = [sourceRow(1), sourceRow(2, "x", false, other), sourceRow(3), sourceRow(4, "y", false, other)];
    const page = install(rows, false, ["15550000000@c.us", other]);
    const first = await page.read({ query: "chat:15550000000@c.us", limit: 1 });
    expect(first).toMatchObject({ ok: true, hasMore: true, results: [{ id: "synthetic-3" }] });
    rows.push(sourceRow(5));
    const last = await page.read({ query: "chat:15550000000@c.us", limit: 1, cursor: first.nextCursor });
    expect(last).toMatchObject({ ok: true, hasMore: false, results: [{ id: "synthetic-1" }] });
    expect(page.requested).toEqual([["false_15550000000@c.us_synthetic-3"], ["false_15550000000@c.us_synthetic-1"]]);
    expect(await page.read({ query: "chat:15559999999@c.us" })).toMatchObject({ ok: false });
    expect(await page.read({ query: `chat:${other}`, cursor: first.nextCursor })).toMatchObject({ ok: false });
  });

  it("answers a chat read in one scan and caps how much history it examines", async () => {
    const other = "15550000001@c.us";
    const rows = [sourceRow(1), ...Array.from({ length: 20_001 }, (_, i) => sourceRow(i + 2, "x", false, other))];
    const page = install(rows, false, ["15550000000@c.us"]);
    const first = await page.read({ query: "chat:15550000000@c.us", limit: 5 });
    expect(first).toMatchObject({ ok: true, hasMore: true, results: [] });
    expect(page.visited()).toBe(20_001);
    expect(page.requested).toEqual([]);
    const last = await page.read({ query: "chat:15550000000@c.us", limit: 5, cursor: first.nextCursor });
    expect(last).toMatchObject({ ok: true, hasMore: false, results: [{ id: "synthetic-1" }] });
  });

  it("matches phone and LID history regardless of the loaded chat's ID form", async () => {
    const phone = "15550000000@c.us";
    const canonical = "15550000000@s.whatsapp.net";
    const lid = "99000000000001@lid";
    const unrelatedLid = "99000000000002@lid";
    for (const chat of [phone, canonical, lid]) {
      for (const query of [phone, canonical, lid]) {
        const rows = [phone, canonical, lid, unrelatedLid].map((remote, i) => sourceRow(i + 1, "private", false, remote));
        const page = install(rows, false, [chat], { [lid]: phone });
        expect(await page.read({ query: `chat:${query}` })).toMatchObject({
          ok: true, hasMore: false,
          results: [{ id: "synthetic-3" }, { id: "synthetic-2" }, { id: "synthetic-1" }],
        });
        expect(page.requested).toEqual([[rows[2].id, rows[1].id, rows[0].id]]);
      }
    }
  });

  it("keeps unresolved LIDs distinct and applies the feed's group scope", async () => {
    const lid = "99000000000001@lid";
    const rows = [sourceRow(1), sourceRow(2, "private", false, lid), sourceRow(3, "group", true)];
    const page = install(rows, false, ["15550000000@c.us", lid, "synthetic-group@g.us"]);
    expect(await page.read({ query: `chat:${lid}` })).toMatchObject({ ok: true, results: [{ id: "synthetic-2" }] });
    expect(await page.read({ query: "chat:synthetic-group@g.us", chat_filter: "group" })).toMatchObject({ ok: true, results: [{ id: "synthetic-3" }] });
    page.requested.length = 0;
    expect(await page.read({ query: "chat:synthetic-group@g.us", chat_filter: "individual" })).toMatchObject({ ok: true, results: [] });
    expect(await page.read({ query: `chat:${lid}`, chat_filter: "group" })).toMatchObject({ ok: true, results: [] });
    expect(page.requested).toEqual([]);
  });

  it("rejects a cursor reused with a different query or scope", async () => {
    const page = install([sourceRow(1), sourceRow(2)]);
    const first = await page.read({ limit: 1, query: "hello" });
    for (const input of [{ query: "changed" }, { query: "hello", chat_filter: "group" }]) {
      expect(await page.read({ ...input, cursor: first.nextCursor })).toMatchObject({ ok: false });
    }
    expect(await page.read({ cursor: '{"v":1,"before":-1}' })).toMatchObject({ ok: false });
  });

  it("skips placeholder rows without a timestamp instead of pinning the cursor", async () => {
    const placeholder = sourceRow(2);
    placeholder.model.attributes.t = 0;
    const page = install([sourceRow(1), placeholder]);
    const first = await page.read({ limit: 1 });
    expect(first).toMatchObject({ ok: true, results: [], hasMore: true });
    const second = await page.read({ limit: 1, cursor: first.nextCursor });
    expect(second).toMatchObject({ ok: true, results: [{ id: "synthetic-1" }], hasMore: false });
  });

  it("fails closed on missing or canceled native message loads", async () => {
    for (const failure of ["omit", "cancel"] as const) {
      const page = install([sourceRow(1)]);
      page[failure]();
      const result = await page.read();
      expect(result.ok).toBe(false);
      expect(result.error.reason).toContain("Source message");
    }
  });
});
