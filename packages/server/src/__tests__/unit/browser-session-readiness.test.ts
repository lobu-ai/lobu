import { afterEach, describe, expect, mock, test } from 'bun:test';
import { getBrowserSessionReadiness, summarizeBrowserSessionAuthData } from '../../utils/auth-profiles';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('browser session readiness after external CDP retirement', () => {
  test('a legacy endpoint cannot make a profile usable or trigger network discovery', async () => {
    const fetch = mock(async () => Response.json({
      Browser: 'Chrome/Test',
      webSocketDebuggerUrl: 'ws://127.0.0.1:49221/devtools/browser/synthetic',
    }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const readiness = await getBrowserSessionReadiness({ cdp_url: 'http://127.0.0.1:49221' });
    expect(readiness.usable).toBe(false);
    expect(readiness.auth_mode).toBe('empty');
    expect(fetch).not.toHaveBeenCalled();
    expect(readiness).not.toHaveProperty('cdp_url');
    expect(readiness).not.toHaveProperty('resolved_cdp_url');
  });

  test('cookie-backed custom connector sessions retain their readiness checks', async () => {
    const active = { cookies: [{ name: 'session_token', expires: Date.now() / 1000 + 3600 }] };
    expect((await getBrowserSessionReadiness(active)).usable).toBe(true);
    expect(summarizeBrowserSessionAuthData(active).auth_mode).toBe('cookies');
    expect((await getBrowserSessionReadiness({ cookies: [{ name: 'session_token', expires: 1 }] })).usable).toBe(false);
  });
});
