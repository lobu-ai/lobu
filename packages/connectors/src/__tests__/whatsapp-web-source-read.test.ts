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
        return { openCursor: (range: { upper: number; open: boolean } | null, direction: string) => {
          expect(direction).toBe("prev");
          const selected = rows.filter((row) => !range || row.rowId < range.upper)
            .sort((a, b) => b.rowId - a.rowId);
          const request: any = {};
          let offset = 0;
          const advance = () => queueMicrotask(() => {
            const row = selected[offset++];
            request.result = row ? { key: row.rowId, value: { id: row.id, rowId: row.rowId }, continue: advance } : null;
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
    IDBKeyRange: { upperBound: (upper: number, open: boolean) => {
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
    cancel: () => { canceled = true; },
    omit: () => { omit = true; },
    closed: () => closed,
    creationAborted: () => creationAborted,
  };
}

describe("WhatsApp source-owned history reads", () => {
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
