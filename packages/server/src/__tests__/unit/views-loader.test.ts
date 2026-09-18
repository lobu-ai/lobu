/**
 * Generic views loader shell: the standard handshake and the delivery source
 * gate, proven with fake host frames.
 */
import { describe, expect, it } from "bun:test";
import { renderViewsLoaderShell } from "../../views/views";

function runLoader() {
  const html = renderViewsLoaderShell();
  // The loader source itself contains a "<script>" string literal (the
  // handoff tag), so extract up to the LAST closer, not the first.
  const script = html.slice(
    html.indexOf("<script>") + "<script>".length,
    html.lastIndexOf("</script>")
  );
  if (!script) throw new Error("loader shell has no inline script");
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const announced: unknown[] = [];
  const hostParent = {
    name: "host",
    postMessage: (message: unknown) => {
      announced.push(message);
    },
  };
  const written: string[] = [];
  const fakeWindow = {
    parent: hostParent,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const fakeDocument = {
    open: () => {},
    write: (chunk: string) => {
      written.push(chunk);
    },
    close: () => {},
    getElementById: () => null,
  };
  new Function("window", "document", script)(fakeWindow, fakeDocument);
  return { listeners, announced, hostParent, written };
}

function message(
  listeners: Record<string, Array<(event: unknown) => void>>,
  source: unknown,
  data: unknown
): void {
  for (const fn of listeners.message ?? []) fn({ source, data });
}

describe("views loader shell", () => {
  it("announces via ui/initialize on load, then initialized", () => {
    const { listeners, announced, hostParent } = runLoader();
    const init = announced[0] as Record<string, unknown>;
    expect(init.method).toBe("ui/initialize");
    expect(
      (init.params as Record<string, unknown>).protocolVersion
    ).toBe("2026-01-26");
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      id: init.id,
      result: {},
    });
    expect(announced[1]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
    });
  });

  it("renders the sandbox push from the host frame only", () => {
    const { listeners, hostParent, written, announced } = runLoader();
    const impostor = { name: "impostor", postMessage: () => {} };
    const push = {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<p>evil</p>" },
    };
    message(listeners, impostor, push);
    // A bare message with no JSON-RPC envelope is ignored too.
    message(listeners, hostParent, {
      type: "lobu:views-bundle",
      html: "<p>evil</p>",
    });
    expect(written).toEqual([]);
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<p>ok</p>" },
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("<p>ok</p>");
    // Even the push path carries the handoff tag for the mounted guest.
    expect(written[0]).toContain("window.__lobuViewHandoff=");
    expect(announced.length).toBeGreaterThan(0);
  });

  it("fetches the per-view bundle for the tool-input key", () => {
    const { listeners, hostParent, announced } = runLoader();
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { key: "pipeline" } },
    });
    const read = announced.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).method === "resources/read"
    ) as Record<string, unknown>;
    expect((read.params as Record<string, unknown>).uri).toBe(
      "ui://lobu/views/pipeline"
    );
  });

  it("hands input, context, queue and request state to the mounted guest", () => {
    const { listeners, hostParent, announced, written } = runLoader();
    const init = announced[0] as Record<string, unknown>;
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      id: init.id,
      result: { hostContext: { theme: "dark" } },
    });
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: {
        arguments: {
          key: "probe",
          scope: { type: "deal", entity: 123 },
          params: { q: "O'Reilly" },
        },
      },
    });
    // An event notification arriving before the bundle resolves is queued.
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { content: [] },
    });
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "inline" },
    });
    const read = announced.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).method === "resources/read"
    ) as Record<string, unknown>;
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      id: read.id,
      result: { contents: [{ text: "<html><head></head><body></body></html>" }] },
    });
    expect(written).toHaveLength(1);
    const chunk = written[0] as string;
    const start = chunk.indexOf("window.__lobuViewHandoff=");
    expect(start).toBeGreaterThan(-1);
    const handoff = JSON.parse(
      chunk.slice(start + "window.__lobuViewHandoff=".length, chunk.indexOf(";</script>"))
    ) as Record<string, unknown>;
    expect(handoff.v).toBe(1);
    expect(handoff.toolInput).toEqual({
      key: "probe",
      scope: { type: "deal", entity: 123 },
      params: { q: "O'Reilly" },
    });
    expect(handoff.hostContext).toEqual({ theme: "dark", displayMode: "inline" });
    expect(handoff.queue).toEqual([
      {
        method: "ui/notifications/tool-result",
        params: { content: [] },
      },
    ]);
    // Loader used ids 1 (initialize) and 2 (resources/read).
    expect(handoff.nextId).toBe(3);
  });
  it("sends no read for a tool-input from an impostor source", () => {
    const { listeners, announced } = runLoader();
    const impostor = { name: "impostor", postMessage: () => {} };
    message(listeners, impostor, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { key: "probe" } },
    });
    expect(
      announced.some(
        (m) =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).method === "resources/read"
      )
    ).toBe(false);
  });

  it("escapes any-case script closers in handoff values", () => {
    const { listeners, hostParent, announced, written } = runLoader();
    const init = announced[0] as Record<string, unknown>;
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      id: init.id,
      result: {},
    });
    const evil = `x</SCRIPT><script>alert(1)</script>`;
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { key: "probe", params: { q: evil } } },
    });
    const read = announced.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).method === "resources/read"
    ) as Record<string, unknown>;
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      id: read.id,
      result: { contents: [{ text: "<html><head></head></html>" }] },
    });
    expect(written).toHaveLength(1);
    const chunk = written[0] as string;
    const handoff = JSON.parse(
      chunk.slice(
        chunk.indexOf("window.__lobuViewHandoff=") +
          "window.__lobuViewHandoff=".length,
        chunk.indexOf(";</script>")
      )
    ) as Record<string, unknown>;
    expect(
      ((handoff.toolInput as Record<string, unknown>).params as Record<string, unknown>).q
    ).toBe(evil);
  });

  it("never lets host context pollute the handoff prototype", () => {
    const { listeners, hostParent, announced, written } = runLoader();
    const init = announced[0] as Record<string, unknown>;
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      id: init.id,
      result: {},
    });
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}'),
    });
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { key: "probe" } },
    });
    const read = announced.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).method === "resources/read"
    ) as Record<string, unknown>;
    message(listeners, hostParent, {
      jsonrpc: "2.0",
      id: read.id,
      result: { contents: [{ text: "<html><head></head></html>" }] },
    });
    expect(written).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((written[0] as string)).toContain('"theme":"dark"');
  });
});
