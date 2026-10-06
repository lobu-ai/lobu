import { describe, expect, it } from "bun:test";
import { whatsAppWebAdapterProgram } from "../whatsapp-web-adapter.js";
import { WHATSAPP_ADAPTER_VERSION } from "../whatsapp-web-helpers.js";

function sourceRow(rowId: number, body = `message ${rowId}`, group = false) {
  const remote = group ? "synthetic-group@g.us" : "15550000000@c.us";
  const serialized = `false_${remote}_synthetic-${rowId}`;
  const key = { id: `synthetic-${rowId}`, remote, fromMe: false, toString: () => serialized };
  return { rowId, id: serialized, model: { id: key, attributes: {
    id: key, from: remote, t: 1_787_358_200 + rowId, type: "chat", body,
  } } };
}

function install(rows: ReturnType<typeof sourceRow>[], missingDatabase = false) {
  const requested: string[][] = [];
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
        return { openCursor: (range: { upper?: number; lower?: number; open: boolean } | null, direction: string) => {
          expect(["prev", "next"]).toContain(direction);
          const selected = rows.filter((row) => !range || (range.upper !== undefined ? row.rowId < range.upper : row.rowId > range.lower!))
            .sort((a, b) => direction === "prev" ? b.rowId - a.rowId : a.rowId - b.rowId);
          const request: any = {};
          let offset = 0;
          const advance = () => queueMicrotask(() => {
            const row = selected[offset++];
            request.result = row ? { key: row.rowId, value: { id: row.id, rowId: row.rowId, t: row.model.attributes.t, type: row.model.attributes.type }, continue: advance } : null;
            request.onsuccess();
          });
          advance();
          return request;
        } };
      } }) };
    },
  };
  const globals: Record<string, any> = {};
  const page = {
    globalThis: globals,
    window: { require: (name: string) => {
      if (name === "WAWebMsgKey") return { fromString: (id: string) => rows.find((row) => row.id === id)!.model.id };
      if (name === "WAWebCollections") return {
        Chat: { _models: [] }, Contact: { _models: [] }, Msg: {
          _models: [],
          getMessagesById: async (ids: string[]) => {
            requested.push(ids);
            return { canceled, messages: omit ? [] : ids.map((id) => rows.find((row) => row.id === id)!.model) };
          },
        },
      };
      return null;
    } },
    indexedDB: { open: (name: string) => {
      expect(name).toBe("model-storage");
      const request: any = { result: db };
      request.transaction = { abort: () => { creationAborted = true; } };
      queueMicrotask(() => missingDatabase ? request.onupgradeneeded() : request.onsuccess());
      return request;
    } },
    IDBKeyRange: { lowerBound: (lower: number, open: boolean) => ({ lower, open }), upperBound: (upper: number, open: boolean) => {
      expect(open).toBe(true);
      return { upper, open };
    } },
  };
  new Function(...Object.keys(page), `(${whatsAppWebAdapterProgram.toString()})();`)(...Object.values(page));
  return {
    read: (input: Record<string, unknown> = {}) => globals.__owlettoWhatsAppAdapterV1.invoke({
      op: "read_messages", adapter_version: WHATSAPP_ADAPTER_VERSION, input,
    }),
    requested,
    observe: (input: Record<string, unknown> = {}) => globals.__owlettoWhatsAppAdapterV1.invoke({
      op: "observe_messages", adapter_version: WHATSAPP_ADAPTER_VERSION, input,
    }),
    cancel: () => { canceled = true; },
    omit: () => { omit = true; },
    closed: () => closed,
    creationAborted: () => creationAborted,
  };
}

describe("WhatsApp source-owned history reads", () => {
  it("replays inserts after a source cursor across reconnects without exporting content", async () => {
    const rows = [sourceRow(1)];
    const page = install(rows);
    expect(await page.observe()).toMatchObject({ after: 1, references: [] });
    expect(page.requested).toHaveLength(0);
    rows.push(sourceRow(2, "private offline message"));
    const reconnected = install(rows);
    const result = await reconnected.observe({ after: 1, started_at: 1_787_358_200, chat_filter: "all" });
    expect(result).toMatchObject({ ok: true, after: 2, hasMore: false, references: [
      { id: "synthetic-2", timestamp: 1_787_358_202, is_group: false },
    ] });
    expect(JSON.stringify(result)).not.toContain("private offline message");
    expect(reconnected.requested).toHaveLength(0);
    expect((await reconnected.observe({ after: 2, started_at: 1_787_358_200 })).references).toEqual([]);
  });

  it("pages a reconnect burst without skipping messages", async () => {
    const page = install(Array.from({ length: 501 }, (_, i) => sourceRow(i + 1)));
    const first = await page.observe({ after: 0, started_at: 1_787_358_200 });
    expect(first).toMatchObject({ after: 500, hasMore: true });
    expect(first.references).toHaveLength(500);
    const last = await page.observe({ after: first.after, started_at: 1_787_358_200 });
    expect(last).toMatchObject({ after: 501, hasMore: false, references: [{ id: "synthetic-501" }] });
  });

  it("does not let a timestamp-zero placeholder block later message references", async () => {
    const placeholder = sourceRow(1);
    placeholder.model.attributes.t = 0;
    const page = install([placeholder, sourceRow(2)]);
    expect(await page.observe({ after: 0, started_at: 1_787_358_200 })).toMatchObject({
      ok: true, after: 2, references: [{ id: 'synthetic-2' }], hasMore: false,
    });
  });

  it("skips status entries during replay without requesting private message models", async () => {
    const status = sourceRow(1);
    status.model.id.remote = 'status@broadcast';
    const page = install([status, sourceRow(2)]);
    page.omit(); // Native message loading is deliberately unavailable.
    expect(await page.observe({ after: 0, started_at: 1_787_358_200 })).toMatchObject({
      ok: true, after: 2, references: [{ id: 'synthetic-2' }], hasMore: false,
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
