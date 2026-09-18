/**
 * F10 regression: disabling an in-flight useQuery (non-null -> null) must
 * leave the hook idle (loading=false), not stuck loading forever.
 *
 * Real hook/runtime coverage: the component runs through the actual Provider
 * + ViewBridge + useQuery effect with a controlled host. The host holds the
 * first query behind a gate, the test flips the query to null, releases the
 * late response, then re-enables. Asserts:
 *  - no read fires before the opening tool-input (parked readiness gate),
 *  - flipping to null issues zero new reads and reports loading=false,
 *  - the late first response is ignored (no stale adoption),
 *  - a subsequent non-null query fires and succeeds (liveness control).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider, sql, useQuery } from "../api.js";
import { ViewBridge } from "../bridge.js";

interface Seen {
  loading: boolean;
  data: unknown;
  error: unknown;
}

let latest: Seen | null = null;

function Probe({ enabled }: { enabled: boolean }) {
  const res = useQuery(enabled ? sql`SELECT 1` : null);
  latest = { loading: res.loading, data: res.data, error: res.error };
  return null;
}

/** Minimal parent stand-in: captures the guest outbox. */
class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  toolsCalls(): Array<Record<string, unknown>> {
    return this.posted.filter((m) => m.method === "tools/call");
  }
}

const DEF = defineView({ key: "f10probe", attach: [] });

let dom: JSDOM;
let root: Root | null = null;
let bridge: ViewBridge | null = null;
let parent: FakeParent;

function hostSend(data: unknown): void {
  const w = (globalThis as unknown as { window: Window }).window;
  const Ctor = (w as unknown as { MessageEvent: typeof MessageEvent })
    .MessageEvent;
  const ev = new Ctor("message", { data });
  // The bridge allow-lists its expected source (window.parent, i.e. the
  // jsdom window itself here); stamp it like bridge.test.ts's dispatch does.
  Object.defineProperty(ev, "source", { value: w });
  w.dispatchEvent(ev);
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function renderProbe(enabled: boolean): void {
  root?.render(
    <Provider def={DEF} bridge={bridge ?? undefined}>
      <Probe enabled={enabled} />
    </Provider>
  );
}

beforeEach(() => {
  latest = null;
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
  // expectedSource null: the jsdom guest window stays the listener target and
  // no source allow-listing interferes with synthetic host events.
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

describe("useQuery disable while in flight (F10)", () => {
  test("pending -> null goes idle, ignores the late response, re-enable succeeds", async () => {
    // Mount with an active query BEFORE the host seeds scope/params.
    await act(async () => {
      renderProbe(true);
      await tick();
    });
    // Parked: no read fires before the opening tool-input.
    expect(parent.toolsCalls()).toHaveLength(0);

    // Opening handshake + the one-shot tool-input the host sends once.
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
    expect(parent.toolsCalls()).toHaveLength(1);
    expect(latest?.loading).toBe(true);

    // Disable while the first query is still held by the host: zero new
    // reads, and the hook must report idle instead of stuck loading.
    await act(async () => {
      renderProbe(false);
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(1);
    expect(latest?.loading).toBe(false);

    // The held first response arrives late: cancelled, so it must not
    // repopulate the skipped query or flip loading back on.
    const first = parent.toolsCalls()[0] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: { structuredContent: { rows: [{ id: 1 }] }, content: [] },
      });
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(1);
    expect(latest).toEqual({ loading: false, data: null, error: null });

    // Liveness control: re-enabling issues a fresh read that succeeds.
    await act(async () => {
      renderProbe(true);
      await tick();
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(2);
    expect(latest?.loading).toBe(true);
    const second = parent.toolsCalls()[1] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: second.id,
        result: {
          structuredContent: { rows: [{ id: 7 }] },
          content: [{ type: "text", text: "ok" }],
        },
      });
      await tick();
    });
    expect(latest).toEqual({ loading: false, data: [{ id: 7 }], error: null });
  });
});
