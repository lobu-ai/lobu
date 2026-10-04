/**
 * A host that learns workspace data changed (an event write on any replica)
 * tells the frame with `lobu/notifications/data-changed`; every mounted
 * useQuery re-reads without flashing its loading state.
 *
 * Real hook/runtime coverage: actual Provider + ViewBridge + useQuery with a
 * controlled host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider, useQuery } from "../api.js";
import { ViewBridge } from "../bridge.js";

interface Seen {
  loading: boolean;
  data: unknown;
  error: unknown;
}

let latest: Seen | null = null;

function StringProbe({ script }: { script: string }) {
  const res = useQuery(script);
  latest = { loading: res.loading, data: res.data, error: res.error };
  seen.push(latest);
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

const DEF = defineView({ key: "liveprobe", attach: [] });
const seen: Seen[] = [];

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
  seen.length = 0;
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

function answer(call: Record<string, unknown>, count: number): void {
  hostSend({
    jsonrpc: "2.0",
    id: (call as { id: number }).id,
    result: {
      structuredContent: { success: true, return_value: { count } },
      content: [],
    },
  });
}

describe("useQuery live refresh", () => {
  test("a host data-changed notification re-reads in the background", async () => {
    await ready();
    expect(parent.toolsCalls()).toHaveLength(1);
    await act(async () => {
      answer(parent.toolsCalls()[0], 1);
      await tick();
    });
    expect(latest).toEqual({ loading: false, data: { count: 1 }, error: null });

    const before = seen.length;
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        method: "lobu/notifications/data-changed",
        params: {},
      });
      await tick();
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(2);
    // The previous rows stay on screen while the re-read is in flight.
    expect(seen.slice(before).every((s) => !s.loading)).toBe(true);
    expect(latest?.data).toEqual({ count: 1 });

    await act(async () => {
      answer(parent.toolsCalls()[1], 2);
      await tick();
    });
    expect(latest).toEqual({ loading: false, data: { count: 2 }, error: null });
  });

  test("unrelated host notifications do not re-read", async () => {
    await ready();
    await act(async () => {
      answer(parent.toolsCalls()[0], 1);
      await tick();
    });
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        method: "lobu/notifications/other",
        params: {},
      });
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(1);
  });
});
