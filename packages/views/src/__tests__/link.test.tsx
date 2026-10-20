/**
 * The frame is sandboxed, so a view can only navigate by asking the host.
 * `Link` sends `ui/open-link` with its href untouched (the host resolves
 * workspace-relative paths) and never lets the iframe follow the anchor.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider, useHost } from "../api.js";
import { ViewBridge } from "../bridge.js";
import { Link } from "../components.js";

let opened: Promise<unknown> | null = null;

function OpensProgrammatically() {
  const { openLink } = useHost();
  return (
    <button
      type="button"
      onClick={() => {
        opened = openLink("flat/moda-3").then(
          () => null,
          (error: unknown) => error
        );
      }}
    >
      open
    </button>
  );
}

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
}

const DEF = defineView({ key: "link-probe", attach: [] });

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
  opened = null;
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

async function connect(): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <Link href="flat/moda-3">Moda 3+1</Link>
        <OpensProgrammatically />
      </Provider>
    );
    await tick();
  });
  const init = parent.posted.find((m) => m.method === "ui/initialize") as
    | { id: number }
    | undefined;
  await act(async () => {
    hostSend({ jsonrpc: "2.0", id: init?.id, result: { hostContext: {} } });
    await tick();
  });
}

function openRequests(): Array<{ id: number; params: { url: string } }> {
  return parent.posted.filter((m) => m.method === "ui/open-link") as Array<{
    id: number;
    params: { url: string };
  }>;
}

describe("links", () => {
  test("a Link click asks the host to open its href and stays in the frame", async () => {
    await connect();
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("flat/moda-3");
    const click = new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      anchor?.dispatchEvent(click);
      await tick();
    });
    expect(click.defaultPrevented).toBe(true);
    expect(openRequests().map((r) => r.params.url)).toEqual(["flat/moda-3"]);
  });

  test("openLink rejects with the host's reason when it declines", async () => {
    await connect();
    await act(async () => {
      container.querySelector("button")?.click();
      await tick();
    });
    const [request] = openRequests();
    expect(request?.params.url).toBe("flat/moda-3");
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        id: request?.id,
        result: { isError: true, content: [{ type: "text", text: "blocked" }] },
      });
      await tick();
    });
    expect(((await opened) as Error).message).toBe("blocked");
  });
});
