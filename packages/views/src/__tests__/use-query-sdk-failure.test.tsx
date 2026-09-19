/**
 * F14 regression: string-mode useQuery must surface query_sdk's documented
 * failure envelope (structuredContent { success:false, error:{...} } without
 * MCP isError) instead of projecting it to { data:null, error:null }.
 *
 * Real hook/runtime coverage: actual Provider + ViewBridge + useQuery with a
 * controlled host. No server/MCP semantic change: named-tool whole-response
 * semantics are preserved (domain success:false is NOT reinterpreted).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider, tool, useQuery } from "../api.js";
import { ViewBridge } from "../bridge.js";

interface Seen {
  loading: boolean;
  data: unknown;
  error: unknown;
}

let latest: Seen | null = null;
let refetchFn: (() => void) | null = null;

function StringProbe({ script }: { script: string }) {
  const res = useQuery(script);
  latest = { loading: res.loading, data: res.data, error: res.error };
  refetchFn = res.refetch;
  return null;
}

function NamedProbe() {
  const res = useQuery(tool("some_tool", { a: 1 }));
  latest = { loading: res.loading, data: res.data, error: res.error };
  refetchFn = res.refetch;
  return null;
}

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  toolsCalls(): Array<Record<string, unknown>> {
    return this.posted.filter((m) => m.method === "tools/call");
  }
}

const DEF = defineView({ key: "f14probe", attach: [] });

let dom: JSDOM;
let root: Root | null = null;
let bridge: ViewBridge | null = null;
let parent: FakeParent;

function hostSend(data: unknown): void {
  const w = (globalThis as unknown as { window: Window }).window;
  const Ctor = (w as unknown as { MessageEvent: typeof MessageEvent })
    .MessageEvent;
  const ev = new Ctor("message", { data });
  Object.defineProperty(ev, "source", { value: w });
  w.dispatchEvent(ev);
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  latest = null;
  refetchFn = null;
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://views.test/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.MessageEvent = dom.window.MessageEvent;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  parent = new FakeParent();
  bridge = new ViewBridge(parent as unknown as Window, null, {
    requestTimeoutMs: 10_000,
  });
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  bridge?.close();
  bridge = null;
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.navigator;
  delete g.MessageEvent;
  delete g.IS_REACT_ACT_ENVIRONMENT;
  dom.window.close();
});

async function ready(): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <StringProbe script="return 1" />
      </Provider>
    );
    await tick();
  });
  expect(parent.toolsCalls()).toHaveLength(0);
  const init = parent.posted.find((m) => m.method === "ui/initialize") as
    | { id: number }
    | undefined;
  expect(init).toBeDefined();
  await act(async () => {
    hostSend({
      jsonrpc: "2.0",
      id: init?.id,
      result: { hostContext: { theme: "light" } },
    });
    await tick();
  });
  await act(async () => {
    hostSend({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { scope: {}, params: {} } },
    });
    await tick();
    await tick();
  });
}

async function readyNamed(): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <NamedProbe />
      </Provider>
    );
    await tick();
  });
  expect(parent.toolsCalls()).toHaveLength(0);
  const init = parent.posted.find((m) => m.method === "ui/initialize") as
    | { id: number }
    | undefined;
  expect(init).toBeDefined();
  await act(async () => {
    hostSend({
      jsonrpc: "2.0",
      id: init?.id,
      result: { hostContext: { theme: "light" } },
    });
    await tick();
  });
  await act(async () => {
    hostSend({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { scope: {}, params: {} } },
    });
    await tick();
    await tick();
  });
}

describe("useQuery string-mode query_sdk failure envelope (F14)", () => {
  test("success:false without isError surfaces the SDK message", async () => {
    await ready();
    expect(parent.toolsCalls()).toHaveLength(1);
    const first = parent.toolsCalls()[0] as { id: number; params: unknown };
    // String shorthand dispatches query_sdk.
    expect(first.params).toMatchObject({
      name: "query_sdk",
    });
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: {
          structuredContent: {
            success: false,
            error: {
              name: "ScriptError",
              message: "SDK_BOOM",
              code: "INTERNAL",
            },
          },
          content: [],
        },
      });
      await tick();
    });
    expect(latest).toEqual({
      loading: false,
      data: null,
      error: "SDK_BOOM",
    });
  });

  test("success control returns return_value with no error", async () => {
    await ready();
    const first = parent.toolsCalls()[0] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: {
          structuredContent: { success: true, return_value: { count: 7 } },
          content: [],
        },
      });
      await tick();
    });
    expect(latest).toEqual({
      loading: false,
      data: { count: 7 },
      error: null,
    });
  });

  test("missing message falls back to 'Query script failed'", async () => {
    await ready();
    const first = parent.toolsCalls()[0] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: {
          structuredContent: { success: false, error: { name: "Oops" } },
          content: [],
        },
      });
      await tick();
    });
    expect(latest).toEqual({
      loading: false,
      data: null,
      error: "Query script failed",
    });
  });

  test("text-JSON fallback follows the same branch", async () => {
    await ready();
    const first = parent.toolsCalls()[0] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: { name: "ScriptError", message: "TEXT_JSON_BOOM" },
              }),
            },
          ],
        },
      });
      await tick();
    });
    expect(latest).toEqual({
      loading: false,
      data: null,
      error: "TEXT_JSON_BOOM",
    });
  });

  test("refetch recovers after a failure", async () => {
    await ready();
    const first = parent.toolsCalls()[0] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: {
          structuredContent: {
            success: false,
            error: { name: "ScriptError", message: "SDK_BOOM" },
          },
          content: [],
        },
      });
      await tick();
    });
    expect(latest?.error).toBe("SDK_BOOM");
    await act(async () => {
      refetchFn?.();
      await tick();
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(2);
    const second = parent.toolsCalls()[1] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: second.id,
        result: {
          structuredContent: { success: true, return_value: { count: 7 } },
          content: [],
        },
      });
      await tick();
    });
    expect(latest).toEqual({
      loading: false,
      data: { count: 7 },
      error: null,
    });
  });

  test("named-tool domain success:false is not reinterpreted", async () => {
    await readyNamed();
    expect(parent.toolsCalls()).toHaveLength(1);
    const first = parent.toolsCalls()[0] as { id: number };
    const body = { success: false, error: { message: "DOMAIN_NO" }, rows: [1] };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: { structuredContent: body, content: [] },
      });
      await tick();
    });
    // Whole-response semantics preserved: body delivered as data, no error.
    expect(latest).toEqual({ loading: false, data: body, error: null });
  });
});
