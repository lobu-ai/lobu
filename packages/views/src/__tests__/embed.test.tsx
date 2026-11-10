/**
 * `<EmbeddedView>` slots: the guest reports where each slot is, never renders
 * the child itself, shows the host's refusal or lack of support in place, and
 * passes keyboard focus into and back out of the host-mounted child.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider } from "../api.js";
import { ViewBridge } from "../bridge.js";
import { EmbeddedView } from "../embed.js";

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
}

const DEF = defineView({ key: "dashboard", attach: [] });

let dom: JSDOM;
let root: Root | null = null;
let bridge: ViewBridge | null = null;
let parent: FakeParent;
let container: HTMLElement;
let setRegion: (region: string) => void = () => undefined;

function hostSend(data: unknown): void {
  const w = (globalThis as unknown as { window: Window }).window;
  const Ctor = (w as unknown as { MessageEvent: typeof MessageEvent })
    .MessageEvent;
  const ev = new Ctor("message", { data });
  Object.defineProperty(ev, "source", { value: w });
  w.dispatchEvent(ev);
}

async function frames(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

function Dashboard() {
  const [region, set] = useState("emea");
  setRegion = set;
  return (
    <div>
      <button type="button">before</button>
      <EmbeddedView id="left" view="pipeline" params={{ region, page: 0 }} />
      <EmbeddedView id="right" view="pipeline" params={{ region: "amer" }} />
      <button type="button">after</button>
    </div>
  );
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
  g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  g.IS_REACT_ACT_ENVIRONMENT = true;
  parent = new FakeParent();
  bridge = new ViewBridge(parent as unknown as Window, null, {
    requestTimeoutMs: 10_000,
  });
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  bridge?.close();
  bridge = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    "window",
    "document",
    "navigator",
    "MessageEvent",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ])
    delete g[key];
  dom.window.close();
});

async function connect(): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <Dashboard />
      </Provider>
    );
    await frames();
  });
  const init = parent.posted.find((m) => m.method === "ui/initialize") as {
    id: number;
  };
  await act(async () => {
    hostSend({ jsonrpc: "2.0", id: init.id, result: { hostContext: {} } });
    await frames();
  });
}

type Sync = {
  id: number;
  params: { embeds: Array<Record<string, unknown>> };
};
const syncs = () =>
  parent.posted.filter((m) => m.method === "lobu/embeds/sync") as Sync[];

async function answer(request: { id: number }, result: unknown) {
  await act(async () => {
    hostSend({ jsonrpc: "2.0", id: request.id, result });
    await frames();
  });
}

const slot = (id: string) =>
  container.querySelector(`[data-lobu-embed="${id}"]`) as HTMLElement;

describe("EmbeddedView", () => {
  test("reports every slot as its own instance and follows the host's answer", async () => {
    await connect();
    const first = syncs().at(-1)!;
    expect(first.params.embeds.map((e) => [e.id, e.view, e.params])).toEqual([
      ["left", "pipeline", { region: "emea", page: 0 }],
      ["right", "pipeline", { region: "amer" }],
    ]);
    expect(first.params.embeds[0].rect).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    // Nothing of the child renders in this frame.
    expect(container.querySelector("iframe")).toBeNull();

    await answer(first, {
      embeds: [
        { id: "left", status: "mounted" },
        { id: "right", status: "refused", reason: "cycle" },
      ],
    });
    expect(slot("left").dataset.state).toBe("mounted");
    expect(slot("right").textContent).toContain("already contains it");

    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        method: "lobu/notifications/embed-size",
        params: { id: "left", height: 312 },
      });
      await frames();
    });
    expect(slot("left").style.height).toBe("312px");

    // A changed starting param re-reports that slot; the other is unchanged.
    await act(async () => {
      setRegion("apac");
    });
    // Effects flush when act ends; the sync goes out on the next frame.
    await act(frames);
    expect(
      syncs()
        .at(-1)!
        .params.embeds.map((e) => e.params)
    ).toEqual([{ region: "apac", page: 0 }, { region: "amer" }]);
  });

  test("says so in the slot when the host does not mount embedded views", async () => {
    await connect();
    const request = syncs().at(-1)!;
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
      await frames();
    });
    expect(slot("left").dataset.state).toBe("unsupported");
    expect(slot("left").textContent).toContain(
      "Open this page in the Lobu app"
    );
    // No further syncs to a host that cannot answer them.
    const count = syncs().length;
    await act(async () => {
      setRegion("apac");
    });
    // Effects flush when act ends; the sync goes out on the next frame.
    await act(frames);
    expect(syncs()).toHaveLength(count);
  });

  test("moves keyboard focus into the child and back out on either side", async () => {
    await connect();
    await answer(syncs().at(-1)!, {
      embeds: [
        { id: "left", status: "mounted" },
        { id: "right", status: "mounted" },
      ],
    });
    const enter = slot("left").querySelector("button") as HTMLElement;
    await act(async () => {
      enter.focus();
      await frames();
    });
    const focus = parent.posted.filter((m) => m.method === "lobu/embeds/focus");
    expect(focus.map((m) => m.params)).toEqual([
      { id: "left", direction: "forward" },
    ]);

    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        method: "lobu/notifications/embed-focus",
        params: { id: "left", direction: "forward" },
      });
      await frames();
    });
    const doc = dom.window.document;
    expect(slot("left").contains(doc.activeElement)).toBe(true);
    expect(doc.activeElement?.getAttribute("tabindex")).toBe("-1");

    // Backward lands on the slot's entry without re-entering the child.
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        method: "lobu/notifications/embed-focus",
        params: { id: "left", direction: "backward" },
      });
      await frames();
    });
    expect(doc.activeElement).toBe(enter);
    expect(
      parent.posted.filter((m) => m.method === "lobu/embeds/focus")
    ).toHaveLength(1);
  });
});
