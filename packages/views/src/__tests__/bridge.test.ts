import { afterEach, describe, expect, test } from "bun:test";
import { ViewBridge } from "../bridge.js";

/** Minimal window stand-in: listener registry plus a captured outbox. */
class FakeWindow {
  listeners = new Map<
    string,
    Set<(e: { data: unknown; source: unknown }) => void>
  >();
  posted: unknown[] = [];
  innerWidth = 1024;

  addEventListener(
    type: string,
    fn: (e: { data: unknown; source: unknown }) => void
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(
    type: string,
    fn: (e: { data: unknown; source: unknown }) => void
  ): void {
    this.listeners.get(type)?.delete(fn);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  /** Deliver an inbound message as the host would. */
  dispatch(data: unknown, source: unknown): void {
    for (const fn of [...(this.listeners.get("message") ?? [])]) {
      fn({ data, source });
    }
  }

  lastPost(): Record<string, unknown> {
    return this.posted[this.posted.length - 1] as Record<string, unknown>;
  }
}

const REAL_WINDOW = (globalThis as Record<string, unknown>).window;

afterEach(() => {
  (globalThis as Record<string, unknown>).window = REAL_WINDOW;
});

function setup(): {
  guest: FakeWindow;
  parent: FakeWindow;
  bridge: ViewBridge;
} {
  const guest = new FakeWindow();
  const parent = new FakeWindow();
  (globalThis as Record<string, unknown>).window = guest;
  // Target + expected source are both the parent, like the sandboxed frame.
  const bridge = new ViewBridge(
    parent as unknown as Window,
    parent as unknown as Window,
    { requestTimeoutMs: 500 }
  );
  return { guest, parent, bridge };
}

function answerInitialize(
  parent: FakeWindow,
  guest: FakeWindow,
  hostContext = {}
): void {
  const init = parent.lastPost() as { id: number };
  guest.dispatch(
    { jsonrpc: "2.0", id: init.id, result: { hostContext } },
    parent
  );
}

describe("ViewBridge handshake", () => {
  test("connect sends ui/initialize then the initialized notification", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    const init = parent.lastPost() as Record<string, unknown>;
    expect(init.method).toBe("ui/initialize");
    expect((init.params as Record<string, unknown>).protocolVersion).toBe(
      "2026-01-26"
    );
    expect(bridge.isConnected()).toBe(false);
    answerInitialize(parent, guest, { theme: "dark" });
    const ctx = await connected;
    expect(ctx.theme).toBe("dark");
    expect(bridge.isConnected()).toBe(true);
    const announced = parent.lastPost() as Record<string, unknown>;
    expect(announced.method).toBe("ui/notifications/initialized");
    bridge.close();
  });

  test("connect rejects when the host answers with an error", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    const init = parent.lastPost() as { id: number };
    guest.dispatch(
      { jsonrpc: "2.0", id: init.id, error: { code: -32000, message: "nope" } },
      parent
    );
    await expect(connected).rejects.toThrow("nope");
    bridge.close();
  });

  test("ignores messages from an unknown source", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    answerInitialize(parent, guest);
    await connected;
    let calls = 0;
    bridge.onToolInput(() => calls++);
    guest.dispatch(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: {} },
      },
      {}
    );
    expect(calls).toBe(0);
    expect(bridge.hasToolInput()).toBe(false);
    guest.dispatch(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: {} },
      },
      parent
    );
    expect(calls).toBe(1);
    expect(bridge.hasToolInput()).toBe(true);
    bridge.close();
  });
});

describe("ViewBridge requests", () => {
  test("callTool posts tools/call and resolves the full result", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    answerInitialize(parent, guest);
    await connected;
    const call = bridge.callTool("manage_connections", { action: "list" });
    const posted = parent.lastPost() as Record<string, unknown>;
    expect(posted.method).toBe("tools/call");
    expect(posted.params).toEqual({
      name: "manage_connections",
      arguments: { action: "list" },
    });
    guest.dispatch(
      {
        jsonrpc: "2.0",
        id: posted.id,
        result: { structuredContent: { connections: [] }, content: [] },
      },
      parent
    );
    const result = await call;
    expect(result.structuredContent).toEqual({ connections: [] });
    bridge.close();
  });

  test("callTool rejects on host error and on timeout", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    answerInitialize(parent, guest);
    await connected;
    const failing = bridge.callTool("query_sql", { sql: "SELECT 1" });
    const posted = parent.lastPost() as Record<string, unknown>;
    guest.dispatch(
      {
        jsonrpc: "2.0",
        id: posted.id,
        error: { code: -32603, message: "denied" },
      },
      parent
    );
    await expect(failing).rejects.toThrow("denied");
    await expect(
      bridge.callTool("query_sql", { sql: "SELECT 2" })
    ).rejects.toThrow("timed out");
    bridge.close();
  });

  test("readResourceText returns the first text payload, else throws", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    answerInitialize(parent, guest);
    await connected;
    const read = bridge.readResourceText("ui://lobu/views/pipeline");
    const posted = parent.lastPost() as Record<string, unknown>;
    expect(posted.method).toBe("resources/read");
    guest.dispatch(
      {
        jsonrpc: "2.0",
        id: posted.id,
        result: { contents: [{ text: "<html></html>" }] },
      },
      parent
    );
    expect(await read).toBe("<html></html>");
    const empty = bridge.readResourceText("ui://lobu/views/missing");
    const posted2 = parent.lastPost() as Record<string, unknown>;
    guest.dispatch(
      { jsonrpc: "2.0", id: posted2.id, result: { contents: [] } },
      parent
    );
    await expect(empty).rejects.toThrow("no text content");
    bridge.close();
  });
});

describe("ViewBridge inbound host requests", () => {
  test("ping is answered, unknown methods get -32601", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    answerInitialize(parent, guest);
    await connected;
    parent.posted.length = 0;
    guest.dispatch({ jsonrpc: "2.0", id: 99, method: "ping" }, parent);
    expect(parent.lastPost()).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
    guest.dispatch({ jsonrpc: "2.0", id: 100, method: "tools/list" }, parent);
    const err = parent.lastPost() as Record<string, unknown>;
    expect(err.id).toBe(100);
    expect((err.error as Record<string, unknown>).code).toBe(-32601);
    bridge.close();
  });

  test("non-JSON-RPC inbox traffic is ignored", async () => {
    const { guest, parent, bridge } = setup();
    let calls = 0;
    bridge.onToolInput(() => calls++);
    guest.dispatch({ hello: "host" }, parent);
    guest.dispatch("just a string", parent);
    guest.dispatch(
      { jsonrpc: "1.0", method: "ui/notifications/tool-input" },
      parent
    );
    expect(calls).toBe(0);
    bridge.close();
  });

  test("host-context-changed merges and notifies", async () => {
    const { guest, parent, bridge } = setup();
    const connected = bridge.connect();
    answerInitialize(parent, guest, { theme: "light" });
    await connected;
    let seen: unknown = null;
    bridge.onHostContext((ctx) => (seen = ctx));
    guest.dispatch(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "dark" },
      },
      parent
    );
    expect(seen).toEqual({ theme: "dark" });
    expect(bridge.getHostContext().theme).toBe("dark");
    bridge.close();
  });
});

describe("ViewBridge loader handoff", () => {
  function setupWithHandoff(handoff: unknown): {
    guest: FakeWindow;
    parent: FakeWindow;
    bridge: ViewBridge;
  } {
    const guest = new FakeWindow();
    const parent = new FakeWindow();
    (guest as unknown as Record<string, unknown>).__lobuViewHandoff = handoff;
    (globalThis as Record<string, unknown>).window = guest;
    const bridge = new ViewBridge(
      parent as unknown as Window,
      parent as unknown as Window,
      { requestTimeoutMs: 500 }
    );
    return { guest, parent, bridge };
  }

  test("adopts cached input, context, queue and request numbering", async () => {
    const args = { scope: { type: "deal" }, params: { q: "x" } };
    const { guest, parent, bridge } = setupWithHandoff({
      v: 1,
      hostContext: { theme: "dark" },
      toolInput: args,
      queue: [
        {
          method: "ui/notifications/tool-result",
          params: { content: [] },
        },
        { method: "ui/notifications/sandbox-resource-ready", params: {} },
        { method: "nope", params: {} },
      ],
      nextId: 7,
    });
    let input: unknown = null;
    bridge.onToolInput((a) => (input = a));
    let results = 0;
    bridge.onToolResult(() => results++);
    const connected = bridge.connect();
    // Fresh initialize result keeps precedence for context.
    answerInitialize(parent, guest, { displayMode: "inline" });
    const ctx = await connected;
    expect(ctx).toEqual({ theme: "dark", displayMode: "inline" });
    // No live tool-input was ever dispatched, yet the gate is satisfied
    // through the normal listener path.
    expect(bridge.hasToolInput()).toBe(true);
    expect(input).toEqual(args);
    expect(results).toBe(1);
    // Next request continues the loader's numbering, not 1 or 2.
    const call = bridge.callTool("query_sql", { sql: "SELECT 1" });
    const posted = parent.lastPost() as { id: number };
    expect(posted.id).toBeGreaterThanOrEqual(7);
    guest.dispatch(
      { jsonrpc: "2.0", id: posted.id, result: { structuredContent: {} } },
      parent
    );
    await call;
    bridge.close();
  });

  test("consumes the handoff once and ignores malformed blobs", async () => {
    const guest = new FakeWindow();
    const parent = new FakeWindow();
    (guest as unknown as Record<string, unknown>).__lobuViewHandoff = "nope";
    (globalThis as Record<string, unknown>).window = guest;
    const bridge = new ViewBridge(
      parent as unknown as Window,
      parent as unknown as Window,
      { requestTimeoutMs: 500 }
    );
    const connected = bridge.connect();
    answerInitialize(parent, guest, {});
    await connected;
    expect(bridge.hasToolInput()).toBe(false);
    expect(
      (guest as unknown as Record<string, unknown>).__lobuViewHandoff
    ).toBeUndefined();
    bridge.close();
  });
});
