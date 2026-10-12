import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'bun:test';

const routes = readFileSync(new URL('../../auth/routes.ts', import.meta.url), 'utf8');
const start = routes.indexOf("credentialRoutes.get('/extension-bootstrap'");
let html = '';
runInNewContext(routes.slice(start, routes.indexOf('\n/**', start)), {
  credentialRoutes: { get: (_path: string, handler: Function) => handler({ header() {}, html(value: string) { html = value; } }) },
});
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];

function harness(hash = '#token=synthetic-token&worker=synthetic-worker', postMessageThrows = false) {
  const requests: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; options: RequestInit }> = [];
  const timers = new Map<number, () => void>();
  const paragraphs = [{ textContent: '' }, { textContent: '' }];
  const buttons: Record<string, { onclick?: () => void; remove: () => void }> = {};
  const body = {
    textContent: '', markup: '',
    set innerHTML(value: string) {
      this.markup = value;
      for (const id of ['owl-retry', 'owl-settings']) {
        if (value.includes(id)) buttons[id] = { remove: () => { delete buttons[id]; } };
      }
    },
  };
  const redirects: string[] = [];
  const stored: string[] = [];
  const posted: unknown[] = [];
  const delays = new Map<number, number>();
  type Listener = (event: { source?: unknown; data?: unknown }) => void;
  const listenersByType = new Map<string, Set<Listener>>();
  const listenersOf = (type: string) => {
    if (!listenersByType.has(type)) listenersByType.set(type, new Set());
    return listenersByType.get(type)!;
  };
  const listeners = listenersOf('message');
  const location = { hash, pathname: '/api/extension-bootstrap', replace: (url: string) => redirects.push(url) };
  let fragmentCleared = false;
  let timerId = 0;
  const parent = { postMessage(data: unknown) {
    if (postMessageThrows) throw new Error('parent unavailable');
    posted.push(data);
  } };
  // What the side panel (or anything else) posts into this frame.
  const receive = (source: unknown, data: unknown) => { for (const listener of [...listeners]) listener({ source, data }); };
  // The panel re-pointing this frame at a new credential: only the fragment
  // changes, so the browser fires hashchange instead of reloading.
  const navigateFragment = (next: string) => {
    location.hash = next;
    for (const listener of [...listenersOf('hashchange')]) listener({});
  };
  runInNewContext(script, {
    URLSearchParams, AbortController,
    location,
    history: { replaceState() { fragmentCleared = true; location.hash = ''; } },
    document: { body, querySelectorAll: () => paragraphs, getElementById: (id: string) => buttons[id] },
    sessionStorage: { setItem: (_key: string, value: string) => stored.push(value) },
    setTimeout(callback: () => void, ms: number) {
      const id = ++timerId;
      delays.set(id, ms);
      timers.set(id, () => { timers.delete(id); callback(); });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    window: {
      parent,
      addEventListener: (type: string, listener: Listener) => listenersOf(type).add(listener),
      removeEventListener: (type: string, listener: Listener) => listenersOf(type).delete(listener),
    },
    fetch: (_url: string, options: RequestInit) => {
      expect(fragmentCleared).toBe(true);
      return new Promise((resolve, reject) => requests.push({ resolve, reject, options }));
    },
  });
  return { requests, timers, paragraphs, buttons, redirects, stored, body, fragmentCleared, posted, delays, listeners, receive, parent, navigateFragment };
}

async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function success(request: ReturnType<typeof harness>['requests'][number]) {
  request.resolve({ ok: true, json: async () => ({ session_token: 'synthetic-session' }) });
}

describe('extension bootstrap', () => {
  it('bounds a stalled request, shows retry, and ignores its late success', async () => {
    const h = harness();
    expect(h.timers.size).toBe(1);
    [...h.timers.values()][0]();
    expect(h.requests[0].options.signal?.aborted).toBe(true);
    expect(h.paragraphs[1].textContent).toContain('timed out');
    expect(h.buttons['owl-retry']).toBeDefined();
    success(h.requests[0]);
    await flush();
    expect(h.redirects).toEqual([]);
    expect(h.stored).toEqual([]);
  });

  it('keeps only the latest retry active and preserves the deep link', async () => {
    const h = harness('#token=synthetic-token&agent=synthetic-agent&thread=synthetic-thread&message=synthetic-message');
    h.requests[0].reject(new Error('offline'));
    await flush();
    const retry = h.buttons['owl-retry'].onclick!;
    retry();
    retry();
    expect(h.timers.size).toBe(1);
    expect(h.requests[1].options.signal?.aborted).toBe(true);
    success(h.requests[1]);
    await flush();
    expect(h.redirects).toEqual([]);
    success(h.requests[2]);
    await flush();
    expect(h.redirects).toEqual(['/#agent=synthetic-agent&thread=synthetic-thread&message=synthetic-message']);
    expect(h.stored).toEqual(['synthetic-session']);
    expect(h.timers.size).toBe(0);
  });

  it.each(['network', 'token'])('offers recovery on %s failure', async (failure) => {
    const h = harness();
    if (failure === 'network') h.requests[0].reject(new Error('offline'));
    else h.requests[0].resolve({ ok: false });
    await flush();
    expect(h.buttons['owl-retry']).toBeDefined();
    expect(h.body.markup).toContain('Lobu');
    expect(h.timers.size).toBe(0);
    expect(h.redirects).toEqual([]);
  });

  it('opens the device after success and strips the fragment before exchange', async () => {
    const h = harness();
    success(h.requests[0]);
    await flush();
    expect(h.redirects).toEqual(['/#worker=synthetic-worker']);
    expect(h.fragmentCleared).toBe(true);
    expect(h.timers.size).toBe(0);
    expect(h.posted).toEqual([]);
  });

  it.each(['insufficient_scope', 'invalid_token'])('waits for panel recovery after %s before showing the fallback', async (error) => {
    const h = harness();
    h.requests[0].resolve({ ok: false, status: error === 'invalid_token' ? 401 : 403, json: async () => ({ error }) });
    await flush();
    expect(h.body.textContent).toBe('Reconnecting\u2026');
    expect(h.body.markup).toBe('');
    expect(h.posted).toEqual([{ owletto: 'session-rejected' }]);
    expect(h.redirects).toEqual([]);
    expect(h.stored).toEqual([]);
    expect(h.timers.size).toBe(1);
    const [id, expire] = [...h.timers.entries()][0];
    expect(h.delays.get(id)).toBe(4000);
    expire();
    expect(h.timers.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    if (error === 'insufficient_scope') {
      expect(h.paragraphs[1].textContent).toContain('Re-pair to sign in');
      expect(h.buttons['owl-retry']).toBeUndefined();
      h.buttons['owl-settings'].onclick!();
      expect(h.posted).toEqual([{ owletto: 'session-rejected' }, { owletto: 'open-settings' }]);
    } else {
      expect(h.paragraphs[1].textContent).toContain('expired');
      h.buttons['owl-retry'].onclick!();
      success(h.requests[1]);
      await flush();
      expect(h.redirects).toEqual(['/#worker=synthetic-worker']);
      expect(h.stored).toEqual(['synthetic-session']);
      expect(h.timers.size).toBe(0);
    }
  });

  it('shows recovery immediately and clears the wait when notifying the panel throws', async () => {
    const h = harness('#token=synthetic-token', true);
    h.requests[0].resolve({ ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) });
    await flush();
    expect(h.paragraphs[1].textContent).toContain('expired');
    expect(h.buttons['owl-retry']).toBeDefined();
    expect(h.timers.size).toBe(0);
  });

  it('shows recovery as soon as the panel reports it could not refresh, ignoring other senders', async () => {
    const h = harness();
    h.requests[0].resolve({ ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) });
    await flush();
    expect(h.body.textContent).toBe('Reconnecting\u2026');
    // Only the panel that embeds this frame can end the wait.
    h.receive({}, { owletto: 'session-refresh-failed' });
    h.receive(h.parent, { owletto: 'something-else' });
    expect(h.body.markup).toBe('');
    h.receive(h.parent, { owletto: 'session-refresh-failed' });
    expect(h.paragraphs[1].textContent).toContain('expired');
    expect(h.timers.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });

  it('signs in with the fresh token the panel hands over after a rejection', async () => {
    const h = harness('#token=expired-session');
    h.requests[0].resolve({ ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) });
    await flush();
    expect(h.body.textContent).toBe('Reconnecting\u2026');
    expect(h.posted).toEqual([{ owletto: 'session-rejected' }]);

    h.navigateFragment('#token=fresh-session');
    // The new attempt replaces the wait: no stale timer or listener can show
    // the old error over it.
    expect(h.listeners.size).toBe(0);
    expect(h.requests).toHaveLength(2);
    expect(new URLSearchParams(String(h.requests[1].options.body)).get('token')).toBe('fresh-session');
    expect([...h.timers.keys()].map((id) => h.delays.get(id))).not.toContain(4000);

    success(h.requests[1]);
    await flush();
    expect(h.redirects).toEqual(['/']);
    expect(h.stored).toEqual(['synthetic-session']);
    expect(h.timers.size).toBe(0);
  });

  it('ignores a fragment change that carries no token', async () => {
    const h = harness('#token=synthetic-token');
    h.navigateFragment('#something-else');
    expect(h.requests).toHaveLength(1);
  });
});
