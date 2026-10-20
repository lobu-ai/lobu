/**
 * A view that throws while rendering must not take the host bridge down with
 * it. The Provider owns the handshake, so an uncaught render error used to
 * unmount it before its effect ran: the guest never sent `ui/initialize`,
 * never reported a size, and the host showed a blank frame with no error.
 *
 * The common trigger is reading scope before the host's opening tool-input:
 * scope is `{}` on the first render, so `sql\`… ${Number(scope.entity)}\``
 * binds NaN and throws. The view must recover once the scope arrives, and an
 * error that persists must be shown, not swallowed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider, sql, useScope } from "../api.js";
import { ViewBridge } from "../bridge.js";

function NeedsEntity() {
  const scope = useScope();
  const query = sql`SELECT name FROM entities WHERE id = ${Number(scope.entity)}`;
  return <p data-testid="ok">{query.text}</p>;
}

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
}

const DEF = defineView({ key: "render-error-probe", attach: [] });

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

async function mount(): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <NeedsEntity />
      </Provider>
    );
    await tick();
  });
}

describe("a view that throws while rendering", () => {
  test("still connects, then renders once the host supplies the scope", async () => {
    await mount();
    // The first render threw (no scope yet), yet the handshake went out.
    expect(parent.posted.some((m) => m.method === "ui/initialize")).toBe(true);

    await handshake({ type: "flat", entity: 3 });
    expect(container.querySelector("[data-testid=ok]")?.textContent).toContain(
      "SELECT name FROM entities WHERE id ="
    );
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  test("shows the error when it persists after the scope arrives", async () => {
    await mount();
    await handshake({ type: "flat" });
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain(
      "sql: only finite numbers can be bound"
    );
    expect(container.querySelector("[data-testid=ok]")).toBeNull();
  });
});
