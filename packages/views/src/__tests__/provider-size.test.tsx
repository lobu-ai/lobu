/** The server bootstrap renders Provider directly, so sizing must work without
 * going through mountView. JSDOM has no layout; supply document geometry and
 * drive resize notifications while exercising the real Provider and bridge. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineView, Provider } from "../api.js";
import { ViewBridge } from "../bridge.js";

class FakeParent {
  posted: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    const data = message as Record<string, unknown>;
    this.posted.push(data);
    if (data.method === "ui/initialize") {
      queueMicrotask(() => {
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: dom.window,
            data: { jsonrpc: "2.0", id: data.id, result: { hostContext: {} } },
          })
        );
      });
    }
  }
  sizes(): unknown[] {
    return this.posted
      .filter((m) => m.method === "ui/notifications/size-changed")
      .map((m) => m.params);
  }
}

class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observe = mock((_target: Element) => undefined);
  unobserve = mock((_target: Element) => undefined);
  disconnect = mock(() => undefined);
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  resize(): void {
    this.callback([], this);
  }
}

const DEF = defineView({ key: "sizeprobe", attach: [] });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;
let root: Root | null = null;
let bridge: ViewBridge;
let parent: FakeParent;
let contentHeight: number;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://views.test/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MessageEvent: dom.window.MessageEvent,
    ResizeObserver: FakeResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  FakeResizeObserver.instances = [];
  contentHeight = 720.25;
  Object.defineProperty(dom.window, "innerWidth", { value: 640.25 });
  const doc = dom.window.document.documentElement;
  doc.style.height = "100%";
  doc.getBoundingClientRect = () => {
    expect(doc.style.height).toBe("max-content");
    expect(doc.dataset.mounted).toBe("true");
    expect(doc.textContent).toBe("tall view");
    return new dom.window.DOMRect(0, 0, 640.25, contentHeight);
  };
  parent = new FakeParent();
  bridge = new ViewBridge(parent as unknown as Window, null);
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  bridge.close();
  dom.window.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

async function renderProvider(strict = false): Promise<void> {
  const view = (
    <Provider def={DEF} bridge={bridge}>
      <div>tall view</div>
    </Provider>
  );
  await act(async () => {
    root?.render(strict ? <StrictMode>{view}</StrictMode> : view);
  });
}

describe("Provider size reporting", () => {
  test.each([
    true,
    false,
  ])("reports mounted content with ResizeObserver available=%s", async (available) => {
    if (!available) Reflect.deleteProperty(globalThis, "ResizeObserver");
    await renderProvider();
    expect(parent.sizes()).toEqual([{ width: 641, height: 721 }]);
    expect(document.documentElement.style.height).toBe("100%");
    expect(FakeResizeObserver.instances).toHaveLength(available ? 1 : 0);
  });

  test("reports growth and shrinkage and disconnects on unmount", async () => {
    await renderProvider();
    const observer = FakeResizeObserver.instances[0];
    expect(observer.observe.mock.calls).toEqual([
      [document.documentElement],
      [document.body],
    ]);
    for (const height of [1100.5, 180.25]) {
      contentHeight = height;
      observer.resize();
      expect(parent.sizes().at(-1)).toEqual({
        width: 641,
        height: Math.ceil(height),
      });
      expect(document.documentElement.style.height).toBe("100%");
    }
    await act(async () => root?.unmount());
    root = null;
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  test("StrictMode replaces the cleaned-up observer", async () => {
    await renderProvider(true);
    expect(FakeResizeObserver.instances).toHaveLength(2);
    const [first, active] = FakeResizeObserver.instances;
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(active.disconnect).not.toHaveBeenCalled();
    contentHeight = 950.5;
    active.resize();
    expect(parent.sizes().at(-1)).toEqual({ width: 641, height: 951 });
    await act(async () => root?.unmount());
    root = null;
    expect(active.disconnect).toHaveBeenCalledTimes(1);
  });
});
