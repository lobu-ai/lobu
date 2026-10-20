/**
 * One view renders a summary as a card and the full view on its own surface.
 * The host says which through the standard MCP Apps `displayMode` and
 * `containerDimensions`, and the view asks for fullscreen with
 * `ui/request-display-mode` ("See all"), keeping its mode when declined.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type DisplayMode, defineView, Provider, useHost } from "../api.js";
import { ViewBridge } from "../bridge.js";

let seen: { displayMode: DisplayMode; maxHeight?: number } | null = null;
let granted: Promise<unknown> | null = null;

function Probe() {
  const { displayMode, container, requestDisplayMode } = useHost();
  seen = { displayMode, maxHeight: container.maxHeight };
  return (
    <button
      type="button"
      onClick={() => {
        granted = requestDisplayMode("fullscreen");
      }}
    >
      See all
    </button>
  );
}

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
}

const DEF = defineView({ key: "display-probe", attach: [] });

let dom: JSDOM;
let root: Root | null = null;
let bridge: ViewBridge | null = null;
let parent: FakeParent;
let container: HTMLElement;

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

async function handshake(scope: Record<string, unknown>): Promise<void> {
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
      params: { arguments: { scope, params: {} } },
    });
    await tick();
  });
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
  delete g.window;
  delete g.document;
  delete g.navigator;
  delete g.MessageEvent;
  delete g.IS_REACT_ACT_ENVIRONMENT;
  dom.window.close();
});

async function connect(hostContext: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <Probe />
      </Provider>
    );
    await tick();
  });
  const init = parent.posted.find((m) => m.method === "ui/initialize") as
    | { id: number; params: { appCapabilities: unknown } }
    | undefined;
  expect(init?.params.appCapabilities).toEqual({
    availableDisplayModes: ["inline", "fullscreen"],
  });
  await act(async () => {
    hostSend({ jsonrpc: "2.0", id: init?.id, result: { hostContext } });
    await tick();
  });
}

async function answerModeRequest(mode: string): Promise<unknown> {
  await act(async () => {
    container.querySelector("button")?.click();
    await tick();
  });
  const request = parent.posted.find(
    (m) => m.method === "ui/request-display-mode"
  ) as { id: number; params: { mode: string } } | undefined;
  expect(request?.params).toEqual({ mode: "fullscreen" });
  await act(async () => {
    hostSend({ jsonrpc: "2.0", id: request?.id, result: { mode } });
    await tick();
  });
  return granted;
}

describe("display modes", () => {
  beforeEach(() => {
    seen = null;
    granted = null;
  });

  test("a card reads inline and its height budget from the host", async () => {
    await connect({
      displayMode: "inline",
      containerDimensions: { maxWidth: 850, maxHeight: 320 },
    });
    expect(seen).toEqual({ displayMode: "inline", maxHeight: 320 });
  });

  test("a host that names no mode is a card", async () => {
    await connect({});
    expect(seen?.displayMode).toBe("inline");
  });

  test("See all asks for fullscreen and follows the host's change", async () => {
    await connect({ displayMode: "inline" });
    expect(await answerModeRequest("fullscreen")).toBe("fullscreen");
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode: "fullscreen",
          containerDimensions: { width: 460 },
        },
      });
      await tick();
    });
    expect(seen).toEqual({ displayMode: "fullscreen", maxHeight: undefined });
  });

  test("a declined request keeps the current mode", async () => {
    await connect({ displayMode: "inline" });
    expect(await answerModeRequest("inline")).toBe("inline");
    expect(seen?.displayMode).toBe("inline");
  });
});

describe("size reporting", () => {
  // The server's bootstrap mounts Provider directly (not mountView), so the
  // provider itself must tell the host how tall the view is; otherwise every
  // frame stays at the host's minimum height and a card never clips.
  test("a provider mounted directly reports its document size", async () => {
    await connect({ displayMode: "inline" });
    const sizes = parent.posted.filter(
      (m) => m.method === "ui/notifications/size-changed"
    ) as Array<{ params: { width: number; height: number } }>;
    expect(sizes.length).toBeGreaterThan(0);
    expect(typeof sizes[0]?.params.height).toBe("number");
  });
});
