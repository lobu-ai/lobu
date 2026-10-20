/**
 * A host's MCP Apps style variables (`hostContext.styles.variables`) reach the
 * view's document root, so the shell tokens derived from them take the host's
 * look. Only standard keys are written; anything else a host sends is ignored.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider } from "../api.js";
import { ViewBridge } from "../bridge.js";

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
}

const DEF = defineView({ key: "host-styles-probe", attach: [] });

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

function rootVar(name: string): string {
  return dom.window.document.documentElement.style.getPropertyValue(name);
}

async function connect(hostContext: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root?.render(
      <Provider def={DEF} bridge={bridge ?? undefined}>
        <p>view</p>
      </Provider>
    );
    await tick();
  });
  const init = parent.posted.find((m) => m.method === "ui/initialize") as
    | { id: number }
    | undefined;
  expect(init).toBeDefined();
  await act(async () => {
    hostSend({ jsonrpc: "2.0", id: init?.id, result: { hostContext } });
    await tick();
  });
}

/** The spec's own key list, read from the installed ext-apps types so the
 *  guest's copy cannot drift from the protocol it claims to speak. */
function specStyleKeys(): string[] {
  const entry = Bun.resolveSync(
    "@modelcontextprotocol/ext-apps",
    import.meta.dir
  );
  const types = readFileSync(join(dirname(entry), "spec.types.d.ts"), "utf8");
  const marker = "export type McpUiStyleVariableKey =";
  const start = types.indexOf(marker) + marker.length;
  const union = types.slice(start, types.indexOf(";", start));
  return union.split("|").map((part) => part.trim().slice(1, -1));
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
  const container = dom.window.document.createElement("div");
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

describe("host style variables", () => {
  test("applies standard keys on connect and ignores anything else", async () => {
    await connect({
      theme: "dark",
      styles: {
        variables: {
          "--color-text-primary": "oklch(0.95 0.02 88)",
          "--color-border-primary": "oklch(0.29 0.01 89)",
          "--font-sans": '"DM Sans", system-ui',
          "--fg": "red",
          "--evil": "url(https://attacker.invalid/x)",
          color: "red",
        },
      },
    });
    expect(rootVar("--color-text-primary")).toBe("oklch(0.95 0.02 88)");
    expect(rootVar("--color-border-primary")).toBe("oklch(0.29 0.01 89)");
    expect(rootVar("--font-sans")).toBe('"DM Sans", system-ui');
    expect(rootVar("--fg")).toBe("");
    expect(rootVar("--evil")).toBe("");
    expect(dom.window.document.documentElement.style.color).toBe("");
    expect(dom.window.document.documentElement.classList.contains("dark")).toBe(
      true
    );
  });

  test("a host-context change updates the variables and clears dropped ones", async () => {
    await connect({
      theme: "light",
      styles: {
        variables: {
          "--color-text-primary": "#141414",
          "--color-text-info": "#2f63e8",
        },
      },
    });
    expect(rootVar("--color-text-info")).toBe("#2f63e8");
    await act(async () => {
      hostSend({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          theme: "dark",
          styles: { variables: { "--color-text-primary": "#f3eee2" } },
        },
      });
      await tick();
    });
    expect(rootVar("--color-text-primary")).toBe("#f3eee2");
    expect(rootVar("--color-text-info")).toBe("");
  });

  test("covers every key the MCP Apps spec standardizes", async () => {
    const keys = specStyleKeys();
    expect(keys.length).toBeGreaterThan(70);
    const variables = Object.fromEntries(keys.map((k) => [k, "1px"]));
    await connect({ styles: { variables } });
    const missing = keys.filter((k) => rootVar(k) !== "1px");
    expect(missing).toEqual([]);
  });
});
