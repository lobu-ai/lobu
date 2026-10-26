/**
 * Generic views loader shell: the standard handshake and the delivery source
 * gate, proven with fake host frames.
 */
import { describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import {
  renderViewShell,
  renderViewsLoaderShell,
  type StoredView,
  viewRuntimeScript,
} from "../../views/views";

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
  class Element {
    children: Element[] = [];
    id = ''; value = ''; textContent = ''; className = ''; disabled = false;
    handlers: Record<string, () => void> = {};
    attributes: Record<string, string> = {};
    constructor(readonly tag: string) {}
    appendChild(child: Element) { this.children.push(child); return child; }
    replaceChildren() { this.children = []; }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    focus() { fakeDocument.activeElement = this; }
    addEventListener(type: string, callback: () => void) { this.handlers[type] = callback; }
    all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
    querySelectorAll(selector: string) { return this.all().filter(el => selector.split(',').includes(el.tag)); }
  }
  const root = new Element('div'); root.id = 'root';
  const status = new Element('div'); status.id = 'lobu-views-status'; root.appendChild(status);
  const classes = new Set<string>();
  const variables: Record<string, string> = {};
  const timers: Array<() => void> = [];
  const fakeDocument = {
    activeElement: null as Element | null,
    createElement: (tag: string) => new Element(tag),
    documentElement: {
      classList: { toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) },
      style: { setProperty: (key: string, value: string) => { variables[key] = value; } },
    },
    open: () => {},
    write: (chunk: string) => {
      written.push(chunk);
    },
    close: () => {},
    getElementById: (id: string) => root.all().find(el => el.id === id) ?? null,
  };
  new Function("window", "document", "setTimeout", script)(fakeWindow, fakeDocument, (fn: () => void) => timers.push(fn));
  return { listeners, announced, hostParent, written, root, fakeDocument, classes, variables, timers };
}

function message(
  listeners: Record<string, Array<(event: unknown) => void>>,
  source: unknown,
  data: unknown
): void {
  for (const fn of listeners.message ?? []) fn({ source, data });
}

describe("views loader shell", () => {
  it('opens the picker from an empty tool input and requests an explicit workspace before a view', () => {
    const h = runLoader();
    const deliver = (method: string, params: unknown) => message(h.listeners, h.hostParent, { jsonrpc: '2.0', method, params });
    const picker = { workspaces: [{ slug: 'sample', name: 'Sample workspace' }], views: [] };
    deliver('ui/notifications/tool-input', { arguments: {} });
    deliver('ui/notifications/tool-result', { structuredContent: { picker } });
    expect(h.root.all().find(el => el.textContent === 'Lobu views')).toBeDefined();
    const select = h.fakeDocument.getElementById('picker-workspace')!;
    select.value = 'sample'; select.handlers.change();
    const call = h.announced.at(-1) as any;
    expect(call.params).toEqual({ name: 'open_view', arguments: { organization: 'sample' } });
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', id: call.id, result: { structuredContent: {
      picker: { ...picker, organization: 'sample', views: [{ key: 'home', name: '<img src=x>', description: 'Saved project context' }] },
    } } });
    expect(h.root.all().some(el => el.tag === 'img')).toBe(false);
    expect(h.root.all().some(el => el.textContent === '<img src=x>')).toBe(true);
    const button = h.root.all().find(el => el.tag === 'li')!.children[0];
    button.handlers.click();
    const open = h.announced.at(-1) as any;
    expect(open.params.arguments).toEqual({ organization: 'sample', key: 'home' });
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', id: open.id, result: { structuredContent: { view: 'home' } } });
    const read = h.announced.at(-1) as any;
    expect(read.params.uri).toBe('ui://lobu/views/home?organization=sample');
    expect(h.fakeDocument.getElementById('picker-search')!.disabled).toBe(true);
    expect(h.fakeDocument.getElementById('picker-loading')!.textContent).toContain('Loading');
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', id: read.id, result: { contents: [{ text: '<html><head></head><body>Home</body></html>' }] } });
    expect(h.written[0]).toContain('"organization":"sample"');
    // The opened result rides the handoff queue, as a host-driven open would.
    expect(h.written[0]).toContain('"method":"ui/notifications/tool-result"');
    expect(h.written[0]).toContain('"view":"home"');
    expect(h.written[0]).toContain('<body>Home</body>');
  });

  it('restores the displayed workspace after failure and keeps keyboard focus after a successful switch', () => {
    const h = runLoader();
    const picker = { organization: 'sample', workspaces: [{ slug: 'sample', name: 'Sample' }, { slug: 'other', name: 'Other' }], views: [] };
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { picker } } });
    const select = h.fakeDocument.getElementById('picker-workspace')!;
    select.focus(); select.value = 'other'; select.handlers.change();
    let call = h.announced.at(-1) as any;
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', id: call.id, error: { message: 'unavailable' } });
    expect(select.value).toBe('sample');
    expect(h.fakeDocument.getElementById('picker-error')!.textContent).toContain('Other');
    expect(h.fakeDocument.getElementById('picker-loading')!.textContent).toBe('');
    select.value = 'other'; select.handlers.change();
    call = h.announced.at(-1) as any;
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', id: call.id, result: { structuredContent: { picker: { ...picker, organization: 'other' } } } });
    const replacement = h.fakeDocument.getElementById('picker-workspace')!;
    expect(replacement.value).toBe('other');
    expect(h.fakeDocument.activeElement).toBe(replacement);
    expect(replacement.disabled).toBe(false);
  });

  it('keeps picker errors recoverable, filters views, and applies live host theme variables', () => {
    const h = runLoader();
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
      structuredContent: { picker: { organization: 'sample', workspaces: [{ slug: 'sample', name: 'Sample' }], views: [{ key: 'home', name: 'Home', description: '' }] } },
    } });
    const search = h.fakeDocument.getElementById('picker-search')!;
    search.value = 'missing'; search.handlers.input();
    expect(h.root.all().some(el => el.textContent === 'No views match your search.')).toBe(true);
    search.value = ''; search.handlers.input();
    const button = h.root.all().find(el => el.tag === 'li')!.children[0];
    button.handlers.click();
    const call = h.announced.at(-1) as any;
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', id: call.id, result: { isError: true } });
    expect(button.disabled).toBe(false);
    expect(h.fakeDocument.getElementById('picker-error')!.textContent).toContain('Try again');
    message(h.listeners, h.hostParent, { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: {
      theme: 'dark', styles: { variables: { '--color-text-primary': '#eee', invalid: 'bad' } },
    } });
    expect(h.classes.has('dark')).toBe(true);
    expect(h.variables).toEqual({ '--color-text-primary': '#eee' });
  });

  it('shows an empty grant state and ignores forged picker results', () => {
    const h = runLoader();
    const notification = { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { picker: { workspaces: [], views: [] } } } };
    message(h.listeners, {}, notification);
    expect(h.fakeDocument.getElementById('picker-workspace')).toBeNull();
    message(h.listeners, h.hostParent, notification);
    expect(h.fakeDocument.getElementById('picker-workspace')!.disabled).toBe(true);
    expect(h.root.all().some(el => el.textContent.includes('No authorized workspaces'))).toBe(true);
    h.timers.at(-1)!();
    expect(h.root.all().some(el => el.textContent.includes('No authorized workspaces'))).toBe(true);
  });

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

describe("view shell runtime", () => {
  it("publishes the installed runtime before executing the view bundle", async () => {
    const pending = viewRuntimeScript();
    expect(viewRuntimeScript()).toBe(pending);
    const runtime = await pending;
    const html = renderViewShell({
      key: "probe",
      name: "Probe",
      content_hash: "test",
      compiled_code: "globalThis.viewReact = globalThis.__lobuViews.react;",
    } as StoredView, "https://app.example/acme/", runtime);
    const context = createContext({});
    // Inlined code never contains a closing tag (the shell escapes it), so
    // each one ends a script; the runtime may itself contain "<script>".
    const scripts = html
      .split("</script>")
      .slice(0, -1)
      .map((chunk) => chunk.slice(chunk.indexOf("<script>") + "<script>".length));
    expect(scripts).toHaveLength(2);
    for (const code of scripts) runInContext(code, context);
    const modules = context.__lobuViews;
    expect(context.viewReact).toBe(modules.react);
    expect(Object.isFrozen(modules)).toBe(true);
    expect(typeof modules.react.useState).toBe("function");
    expect(typeof modules["react/jsx-runtime"].jsx).toBe("function");
    expect(typeof modules["react-dom"].createPortal).toBe("function");
    expect(typeof modules["react-dom/client"].createRoot).toBe("function");
    expect(typeof modules["@lobu/views"].mountView).toBe("function");
    expect(typeof modules["@lobu/views/components"].DataTable).toBe("function");
    expect(runtime).not.toMatch(/(?:\/Users\/|\/home\/|file:\/\/|file%3A%2F%2F)/i);
  });

  it("keeps a successful retry cached after concurrent callers see a failed build", async () => {
    // Isolate the esbuild mock from other suites sharing Bun's module registry.
    const child = Bun.spawn([process.execPath, "-e", `
      import { mock } from "bun:test";
      import * as esbuild from "esbuild";
      const original = { ...esbuild };
      let builds = 0;
      let fail;
      mock.module("esbuild", () => ({ ...original, build: () => {
        builds++;
        return builds === 1
          ? new Promise((_, reject) => { fail = reject; })
          : Promise.resolve({ outputFiles: [{ text: "runtime" }] });
      } }));
      const { viewRuntimeScript } = await import(${JSON.stringify(new URL("../../views/views.ts", import.meta.url).href)});
      const first = viewRuntimeScript();
      const retry = first.catch(() => viewRuntimeScript());
      const concurrent = viewRuntimeScript();
      fail(new Error("first build failed"));
      const results = await Promise.allSettled([retry, concurrent]);
      const cached = await viewRuntimeScript();
      console.log(JSON.stringify({ builds, results, cached }));
    `], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.builds).toBe(2);
    expect(result.results[0]).toEqual({ status: "fulfilled", value: "runtime" });
    expect(result.results[1].status).toBe("rejected");
    expect(result.cached).toBe("runtime");
  });
});

describe("view shell theme tokens", () => {
  const view = {
    key: "health",
    name: "Health",
    content_hash: "hash-1",
    compiled_code: "",
  } as StoredView;

  it("derives every kit token from the MCP Apps standard variable, keeping Lobu's palette as the fallback", () => {
    const html = renderViewShell(view, "https://app.example/acme/", "");
    for (const token of [
      "--fg:var(--color-text-primary,#0a0a0a)",
      "--muted:var(--color-text-secondary,#6b7280)",
      "--border:var(--color-border-primary,#e5e7eb)",
      "--accent:var(--color-text-info,#2563eb)",
      "--font:var(--font-sans,system-ui,",
      "--radius:var(--border-radius-md,6px)",
      "--radius-lg:var(--border-radius-lg,8px)",
      // Dark fallbacks still flip with the host's theme class.
      "--fg:var(--color-text-primary,#fafafa)",
      "--border:var(--color-border-primary,#27272a)",
    ]) {
      expect(html).toContain(token);
    }
    expect(html).toContain("font:13px/1.45 var(--font)");
    // The frame shows the host's surface, never an opaque canvas.
    expect(html).toContain("background:transparent");
  });

  it("names the workspace a view's relative links resolve against, escaped", () => {
    expect(renderViewShell(view, "https://app.example/acme/", "")).toContain(
      '<meta name="lobu-workspace" content="https://app.example/acme/">'
    );
    expect(renderViewShell(view, 'https://app.example/a"<b/', "")).toContain(
      'content="https://app.example/a&quot;&lt;b/"'
    );
  });

  it("gives the loader shell the same tokens", () => {
    expect(renderViewsLoaderShell()).toContain(
      "--fg:var(--color-text-primary,#0a0a0a)"
    );
  });
});
