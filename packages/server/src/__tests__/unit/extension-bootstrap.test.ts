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

function harness(hash = '#token=synthetic-token&worker=synthetic-worker') {
  const requests: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; options: RequestInit }> = [];
  const timers = new Map<number, () => void>();
  const paragraphs = [{ textContent: '' }, { textContent: '' }];
  const buttons: Record<string, { onclick?: () => void }> = {};
  const body = {
    textContent: '', markup: '',
    set innerHTML(value: string) {
      this.markup = value;
      for (const id of ['owl-retry', 'owl-settings']) if (value.includes(id)) buttons[id] = {};
    },
  };
  const redirects: string[] = [];
  const stored: string[] = [];
  let fragmentCleared = false;
  let timerId = 0;
  runInNewContext(script, {
    URLSearchParams, AbortController,
    location: { hash, pathname: '/api/extension-bootstrap', replace: (url: string) => redirects.push(url) },
    history: { replaceState() { fragmentCleared = true; } },
    document: { body, querySelectorAll: () => paragraphs, getElementById: (id: string) => buttons[id] },
    sessionStorage: { setItem: (_key: string, value: string) => stored.push(value) },
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch: (_url: string, options: RequestInit) => {
      expect(fragmentCleared).toBe(true);
      return new Promise((resolve, reject) => requests.push({ resolve, reject, options }));
    },
  });
  return { requests, timers, paragraphs, buttons, redirects, stored, body, fragmentCleared };
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
  });
});
