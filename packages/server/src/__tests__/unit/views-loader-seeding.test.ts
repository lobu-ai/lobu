/**
 * The generic views loader's hand-off to the per-view guest.
 *
 * The loader is a distinct document from the view it mounts: it runs the
 * `ui/initialize` handshake, receives the host's ONE-SHOT `tool-input` (which
 * is where `scope` and `params` arrive), then replaces itself with the per-view
 * bundle. Replacing the document tears down the loader's `message` listener
 * and everything it had already received, so whatever the host delivered
 * BEFORE the swap is delivered exactly once and to the wrong document.
 *
 * `@lobu/views` parks every `useQuery` until `tool-input` lands
 * (`bridge.ts: toolInputReceived`), so a guest that never sees it renders an
 * empty state forever. On the MCP-hosted path there is no second `tool-input`
 * to recover with: Claude sends it once per tool result.
 *
 * These cases execute the real loader script against a fake window/document
 * and assert on what the MOUNTED guest can observe — not on the loader's
 * source text, which cannot distinguish "forwards the input" from "mentions
 * the word input".
 */

import { describe, expect, it } from 'bun:test';
import { renderViewsLoaderShell } from '../../views/views';

type Listener = (event: { data: unknown; source: unknown }) => void;

/**
 * Guest window stand-in. Models the two postMessage directions the loader
 * uses, which behave differently in a browser and must here too:
 *  - `parentWindow.postMessage(...)` leaves the frame → captured as an outbox
 *    entry (`posted`), never re-dispatched locally.
 *  - `window.postMessage(...)` targets THIS window → the browser queues a
 *    `message` event on it whose `source` is this window, not the parent.
 *    That is the channel a replay to the mounted guest travels on.
 */
class FakeWindow {
  listeners = new Map<string, Set<Listener>>();
  /** Messages sent OUT to the host. */
  posted: Array<Record<string, unknown>> = [];
  /** Messages this window posted to itself, awaiting dispatch. */
  selfQueue: Array<Record<string, unknown>> = [];
  parent: FakeWindow;

  constructor(parent?: FakeWindow) {
    // A sandboxed frame's `window.parent` is the host; only the outbox leaves.
    this.parent = parent ?? this;
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  /**
   * Self-targeted postMessage. Queued rather than dispatched synchronously,
   * exactly like the browser task queue — which is what makes the replay land
   * after the replacement document has registered its listener.
   */
  postMessage(message: unknown): void {
    this.selfQueue.push(message as Record<string, unknown>);
  }

  /** Drain self-posted messages, dispatching each with `source === this`. */
  drainSelf(): Array<Record<string, unknown>> {
    const drained: Array<Record<string, unknown>> = [];
    while (this.selfQueue.length > 0) {
      const message = this.selfQueue.shift();
      if (!message) break;
      drained.push(message);
      for (const fn of [...(this.listeners.get('message') ?? [])]) {
        fn({ data: message, source: this });
      }
    }
    return drained;
  }

  /** Deliver a host message, as the parent frame. */
  deliver(data: unknown): void {
    for (const fn of [...(this.listeners.get('message') ?? [])]) {
      fn({ data, source: this.parent });
    }
  }

  requestsFor(method: string): Array<Record<string, unknown>> {
    return this.posted.filter((m) => m.method === method);
  }
}

/** Host window: everything the loader posts outward lands in its `posted`. */
class FakeParent extends FakeWindow {}

interface LoaderHarness {
  win: FakeWindow;
  /** HTML handed to the replacement document, if the loader swapped. */
  written(): string;
  /** Messages the loader re-delivered into the replacement document. */
  reseeded(): Array<Record<string, unknown>>;
  allDispatched(): Array<Record<string, unknown>>;
  timers: Array<() => void>;
}

/**
 * Run the loader's inline script with a stubbed DOM. `document.write` is
 * captured rather than parsed: the per-view bundle is React, so the assertion
 * that matters is what the loader hands the new document and what it replays
 * into it, not that React painted.
 */
function runLoader(): LoaderHarness {
  const html = renderViewsLoaderShell();
  const script = html.slice(
    html.lastIndexOf('<script>') + '<script>'.length,
    html.lastIndexOf('</script>')
  );
  expect(script.length).toBeGreaterThan(200);

  const host = new FakeParent();
  const win = new FakeWindow(host);
  // The loader's outbox is the host's inbox; `requestsFor` reads it from the
  // guest side, so point both at one array.
  win.posted = host.posted;
  const statusEl = { textContent: '' };
  let writtenHtml = '';
  const timers: Array<() => void> = [];

  let swapped = false;
  const doc = {
    getElementById: (id: string) =>
      id === 'lobu-views-status' && !swapped ? statusEl : null,
    open: () => {
      swapped = true;
    },
    write: (chunk: string) => {
      writtenHtml += chunk;
    },
    close: () => {},
    addEventListener: () => {},
  };

  // The loader posts OUT through `window.parent.postMessage`, so the guest
  // window needs a distinct parent object.
  const parentWindow = {
    postMessage: (message: unknown) => {
      host.posted.push(message as Record<string, unknown>);
    },
  };
  // Events the loader dispatches back into its own window, with the `source`
  // it chose. The real guest FILTERS on this (`bridge.ts: expectedSource`
  // defaults to `window.parent`), so the harness must record it rather than
  // assume it — a replay whose source is the guest's own window is dropped by
  // a real `@lobu/views` bundle and by Claude's AppBridge alike.
  const dispatched: Array<{ data: Record<string, unknown>; source: unknown }> =
    [];
  const guestWindow = {
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    postMessage: win.postMessage.bind(win),
    dispatchEvent: (event: {
      data: Record<string, unknown>;
      source: unknown;
    }) => {
      dispatched.push({ data: event.data, source: event.source });
      return true;
    },
    parent: parentWindow,
  };
  // `event.source !== window.parent` is the loader's inbound guard, so host
  // deliveries must carry that exact object as their source.
  win.parent = parentWindow as unknown as FakeWindow;

  // Deferred replays run through setTimeout; collecting them lets a test
  // drain the queue the way the browser task loop would.
  const sandbox = {
    window: guestWindow,
    document: doc,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    // The loader constructs a MessageEvent so it can set `source`.
    MessageEvent: class {
      type: string;
      data: Record<string, unknown>;
      source: unknown;
      origin: string;
      constructor(
        type: string,
        init: { data: Record<string, unknown>; source: unknown; origin: string }
      ) {
        this.type = type;
        this.data = init.data;
        this.source = init.source;
        this.origin = init.origin;
      }
    },
  };

  const run = new Function(
    'window',
    'document',
    'setTimeout',
    'clearTimeout',
    'MessageEvent',
    'self',
    'globalThis',
    script
  );
  run(
    sandbox.window,
    sandbox.document,
    sandbox.setTimeout,
    sandbox.clearTimeout,
    sandbox.MessageEvent,
    sandbox.window,
    sandbox
  );

  return {
    win,
    written: () => writtenHtml,
    /**
     * Run the browser task queue, then return the replays the guest would
     * ACTUALLY accept: `source === window.parent`. A replay dispatched with
     * any other source is filtered out here exactly as a real
     * `@lobu/views` guest filters it, so a reseed that looks delivered but
     * carries the wrong source reads as "not delivered" — which is what it is.
     */
    reseeded: () => {
      // Draining may enqueue more work, so keep going until it settles.
      for (let guard = 0; guard < 20 && timers.length > 0; guard++) {
        const batch = timers.splice(0, timers.length);
        for (const fn of batch) fn();
      }
      win.drainSelf();
      return dispatched
        .filter((event) => event.source === parentWindow)
        .map((event) => event.data);
    },
    /** Every replay the loader emitted, whatever source it used. */
    allDispatched: () => dispatched.map((e) => e.data),
    timers,
  };
}

/** The `ui/initialize` request the loader opens with, answered as a host. */
function answerInitialize(
  win: FakeWindow,
  hostContext: Record<string, unknown> = { theme: 'dark', displayMode: 'inline' }
): void {
  const init = win.requestsFor('ui/initialize')[0];
  expect(init).toBeDefined();
  win.deliver({ jsonrpc: '2.0', id: init.id, result: { hostContext } });
}

/** Deliver the host's one-shot tool-input, then its resources/read answer. */
function seedToolInput(
  win: FakeWindow,
  args: Record<string, unknown>,
  viewHtml = '<!doctype html><html><body>view</body></html>'
): void {
  win.deliver({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-input',
    params: { arguments: args },
  });
  const read = win.requestsFor('resources/read').at(-1);
  if (read) {
    win.deliver({
      jsonrpc: '2.0',
      id: read.id,
      result: { contents: [{ text: viewHtml }] },
    });
  }
}

describe('views loader guest seeding', () => {
  it('runs the handshake and mounts the view named by tool-input', () => {
    const h = runLoader();
    answerInitialize(h.win);
    seedToolInput(h.win, { key: 'connection-health' });

    expect(h.written()).toContain('view');
    const read = h.win.requestsFor('resources/read');
    expect(read).toHaveLength(1);
    expect((read[0].params as { uri: string }).uri).toBe(
      'ui://lobu/views/connection-health'
    );
  });

  it('forwards the one-shot tool-input into the mounted guest', () => {
    // The load-bearing case. `tool-input` is what carries scope+params AND
    // what unparks `useQuery`. It arrives once, at the loader, before the
    // guest exists — so unless the loader replays it after the swap, an
    // MCP-hosted view never issues its first read.
    const h = runLoader();
    answerInitialize(h.win);
    seedToolInput(h.win, {
      key: 'connection-health',
      scope: { type: 'engineering-task', entity: 35364 },
      params: { only: 'attention' },
    });

    const replayed = h
      .reseeded()
      .filter((m) => m.method === 'ui/notifications/tool-input');
    expect(replayed).toHaveLength(1);
    const args = (replayed[0].params as { arguments: Record<string, unknown> })
      .arguments;
    expect(args.scope).toEqual({ type: 'engineering-task', entity: 35364 });
    expect(args.params).toEqual({ only: 'attention' });
  });

  it('forwards the host context captured during the handshake', () => {
    // Theme/display mode arrive in the `ui/initialize` RESULT, which only the
    // loader ever sees. A guest that missed it renders light in a dark host.
    const h = runLoader();
    answerInitialize(h.win, { theme: 'dark', displayMode: 'fullscreen' });
    seedToolInput(h.win, { key: 'connection-health' });

    const ctx = h
      .reseeded()
      .filter((m) => m.method === 'ui/notifications/host-context-changed');
    expect(ctx.length).toBeGreaterThanOrEqual(1);
    expect(ctx.at(-1)?.params).toMatchObject({ theme: 'dark' });
  });

  it('forwards notifications queued between tool-input and the swap', () => {
    // `resources/read` is a round trip, so the host can deliver a param
    // change or a host-context change while the bundle is still in flight.
    // Those notifications are addressed to the view, not the loader.
    const h = runLoader();
    answerInitialize(h.win);
    h.win.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { key: 'connection-health', params: { only: 'all' } } },
    });
    const read = h.win.requestsFor('resources/read').at(-1);
    expect(read).toBeDefined();
    // Queued mid-flight:
    h.win.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark' },
    });
    h.win.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: {
        arguments: { key: 'connection-health', params: { only: 'attention' } },
      },
    });
    // ...then the bundle lands.
    h.win.deliver({
      jsonrpc: '2.0',
      id: read?.id,
      result: {
        contents: [{ text: '<!doctype html><html><body>view</body></html>' }],
      },
    });

    // One drain: it dispatches the queue, so read it once and assert on that.
    const replayed = h.reseeded();
    const methods = replayed.map((m) => m.method);
    expect(methods).toContain('ui/notifications/tool-input');
    expect(methods).toContain('ui/notifications/host-context-changed');
    // The guest must end up with the LATEST params, not the stale first one.
    const lastInput = replayed
      .filter((m) => m.method === 'ui/notifications/tool-input')
      .at(-1);
    const args = (lastInput?.params as { arguments: Record<string, unknown> })
      .arguments;
    expect(args.params).toEqual({ only: 'attention' });
  });

  it('answers host requests so the connection never hangs', () => {
    const h = runLoader();
    answerInitialize(h.win);
    h.win.deliver({ jsonrpc: '2.0', id: 'ping-1', method: 'ping', params: {} });

    const ack = h.win.posted.find((m) => m.id === 'ping-1');
    expect(ack).toBeDefined();
    expect(ack?.result).toEqual({});
  });
});
