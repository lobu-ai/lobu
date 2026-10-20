/**
 * Mount-stability regression for the documented filter pattern: the focused
 * filter input must survive a query round-trip. In production the trigger is
 * typing (each keystroke updates params and re-queries); the test drives the
 * identical loading → response cycle through refetch, which jsdom cannot
 * distinguish from a param change. An early return on loading/error unmounts
 * the input mid-cycle and loses focus — this test pins the mounted-input contract instead.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider, sql, useParams, useQuery } from "../api.js";
import { ViewBridge } from "../bridge.js";
import {
  Card,
  DataTable,
  FilterBar,
  LoadingState,
  SearchField,
} from "../components.js";

let dom: JSDOM;
let root: Root | null = null;
let bridge: ViewBridge | null = null;
let el: HTMLElement;

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  toolsCalls(): Array<Record<string, unknown>> {
    return this.posted.filter((m) => m.method === "tools/call");
  }
}

let parent: FakeParent;
/** Latest refetch, captured so the test can drive a re-query on demand. */
let refetchFn: (() => void) | null = null;

const DEF = defineView({
  key: "focusprobe",
  attach: [{ type: "deal" }],
  params: { stage: { type: "string", default: "open" } },
});

function Pipeline() {
  const [params, setParams] = useParams();
  const deals = useQuery<Array<{ id: number; title: string }>>(
    sql`SELECT id, title FROM deal WHERE stage = ${params.stage}`
  );
  refetchFn = deals.refetch;
  return (
    <Card title="t">
      <FilterBar>
        <SearchField
          label="Stage"
          value={String(params.stage)}
          onChange={(v) => setParams({ stage: v })}
        />
      </FilterBar>
      {deals.loading && <LoadingState text="Loading…" />}
      <DataTable
        columns={[{ key: "title", header: "Title" }]}
        rows={deals.data ?? []}
        keyOf={(r) => r.id}
      />
    </Card>
  );
}

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
  refetchFn = null;
  bridge = new ViewBridge(parent as unknown as Window, null, {
    requestTimeoutMs: 1_000,
  });
  el = dom.window.document.createElement("div");
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
  refetchFn = null;
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.navigator;
  delete g.MessageEvent;
  delete g.IS_REACT_ACT_ENVIRONMENT;
  dom.window.close();
});

describe("documented filter pattern", () => {
  test("focused filter input survives a query round-trip", async () => {
    await act(async () => {
      root?.render(
        <Provider def={DEF} bridge={bridge ?? undefined}>
          <Pipeline />
        </Provider>
      );
      await tick();
    });
    // Handshake + opening tool-input seeds scope/params.
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
        params: { arguments: { scope: {}, params: { stage: "open" } } },
      });
      await tick();
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(1);
    const first = parent.toolsCalls()[0] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: first.id,
        result: {
          structuredContent: { rows: [{ id: 1, title: "A" }] },
          content: [],
        },
      });
      await tick();
    });
    expect(el.innerHTML).toContain("A");
    const input = el.querySelector("input[type='search']") as HTMLInputElement;
    input.focus();
    expect(dom.window.document.activeElement).toBe(input);

    // Same cycle typing would produce: loading re-run, then a response.
    // The input element must survive both renders.
    expect(typeof refetchFn).toBe("function");
    await act(async () => {
      refetchFn?.();
      await tick();
      await tick();
    });
    expect(parent.toolsCalls()).toHaveLength(2);
    expect(dom.window.document.activeElement).toBe(input);
    expect(input.value).toBe("open");

    const second = parent.toolsCalls()[1] as { id: number };
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: second.id,
        result: {
          structuredContent: { rows: [{ id: 2, title: "B" }] },
          content: [],
        },
      });
      await tick();
    });
    expect(el.innerHTML).toContain("B");
    expect(dom.window.document.activeElement).toBe(input);
    expect(el.querySelector("input[type='search']")).toBe(input);
  });
});
