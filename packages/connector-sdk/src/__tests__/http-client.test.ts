import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHttpClient, HttpStatusError } from '../http-client.js';

// All tests stub global fetch — no network access.

const originalFetch = globalThis.fetch;
const originalLogLevel = process.env.LOG_LEVEL;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function stubFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

describe('createHttpClient', () => {
  test('get() sends the Bearer token from getAccessToken and parses JSON', async () => {
    let seenAuth: string | null = null;
    stubFetch(async (_url, init) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return jsonResponse({ ok: true });
    });

    const client = createHttpClient({ getAccessToken: () => 'tok-123' });
    const result = await client.get<{ ok: boolean }>('https://api.example.com/v1/me');
    expect(result).toEqual({ ok: true });
    expect(seenAuth).toBe('Bearer tok-123');
  });

  test('does not overwrite an explicit per-request Authorization header', async () => {
    let seenAuth: string | null = null;
    stubFetch(async (_url, init) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return jsonResponse({});
    });

    const client = createHttpClient({ getAccessToken: () => 'tok-123' });
    await client.get('https://api.example.com/x', {
      headers: { Authorization: 'Basic abc' },
    });
    expect(seenAuth).toBe('Basic abc');
  });

  test('merges static headers with per-request headers (per-request wins)', async () => {
    let seen: Headers | undefined;
    stubFetch(async (_url, init) => {
      seen = new Headers(init?.headers);
      return jsonResponse({});
    });

    const client = createHttpClient({ headers: { 'User-Agent': 'lobu', 'X-A': 'base' } });
    await client.get('https://api.example.com/x', { headers: { 'X-A': 'override' } });
    expect(seen?.get('user-agent')).toBe('lobu');
    expect(seen?.get('x-a')).toBe('override');
  });

  test('post() JSON-serializes the body and sets Content-Type', async () => {
    let seenBody: BodyInit | null | undefined;
    let seenContentType: string | null = null;
    let seenMethod: string | undefined;
    stubFetch(async (_url, init) => {
      seenBody = init?.body;
      seenMethod = init?.method;
      seenContentType = new Headers(init?.headers).get('content-type');
      return jsonResponse({ id: 1 });
    });

    const client = createHttpClient();
    const result = await client.post<{ id: number }>('https://api.example.com/x', { a: 1 });
    expect(result).toEqual({ id: 1 });
    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('{"a":1}');
    expect(seenContentType).toBe('application/json');
  });

  test('throws HttpStatusError with status + truncated body on permanent error (no retry)', async () => {
    const fetchMock = mock(async () => new Response(`nope ${'x'.repeat(600)}`, { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createHttpClient({ errorPrefix: 'Example API' });
    const error = await client.get('https://api.example.com/missing').then(
      () => null,
      (e) => e
    );
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error.status).toBe(404);
    expect(error.message).toContain('Example API GET https://api.example.com/missing failed (404)');
    expect(error.bodyText.length).toBeLessThanOrEqual(501); // 500 chars + ellipsis
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retries transient 503 then succeeds', async () => {
    let attempt = 0;
    const fetchMock = mock(async () => {
      attempt++;
      if (attempt < 2) return new Response('unavailable', { status: 503 });
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createHttpClient();
    const result = await client.get<{ ok: boolean }>('https://api.example.com/x');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 30000);

  test('honors 429 Retry-After bounded by maxRetryAfterMs, then retries', async () => {
    let attempt = 0;
    const fetchMock = mock(async () => {
      attempt++;
      if (attempt < 2) {
        // Retry-After of 1000s must be clamped by maxRetryAfterMs (10ms).
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '1000' } });
      }
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createHttpClient({ maxRetryAfterMs: 10 });
    const started = Date.now();
    const result = await client.get<{ ok: boolean }>('https://api.example.com/x');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Clamped wait: well under the 1000s the header asked for.
    expect(Date.now() - started).toBeLessThan(20000);
  }, 30000);

  test('retry: false disables retrying (503 thrown after a single call)', async () => {
    const fetchMock = mock(async () => new Response('unavailable', { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createHttpClient({ retry: false });
    await expect(client.get('https://api.example.com/x')).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('raw() resolves with the Response for non-transient non-2xx statuses', async () => {
    stubFetch(async () => new Response('forbidden', { status: 403 }));

    const client = createHttpClient();
    const response = await client.raw('https://api.example.com/x');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('forbidden');
  });

  test('retries a GET 503 whose body contains a word that sounds permanent', async () => {
    let attempt = 0;
    const fetchMock = mock(async () => {
      attempt++;
      if (attempt < 2) return new Response('invalid upstream state', { status: 503 });
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createHttpClient().get<{ ok: boolean }>('https://api.example.com/x');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 30000);

  test('does not retry a POST on a 5xx: it may already have been applied', async () => {
    const fetchMock = mock(async () => new Response('unavailable', { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const error = await createHttpClient()
      .post('https://api.example.com/messages/send', { raw: 'x' })
      .then(
        () => null,
        (e) => e
      );
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retries a POST on a 429: the server refused it unprocessed', async () => {
    let attempt = 0;
    const fetchMock = mock(async () => {
      attempt++;
      if (attempt < 2) return new Response('slow down', { status: 429 });
      return jsonResponse({ ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createHttpClient().post<{ ok: boolean }>('https://api.example.com/send', {});
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 30000);

  test('retries a POST the caller marks idempotent (a GraphQL query), and never sends the hint', async () => {
    let attempt = 0;
    const seen: RequestInit[] = [];
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      attempt++;
      if (attempt < 2) return new Response('unavailable', { status: 503 });
      return jsonResponse({ data: { ok: true } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createHttpClient().post<{ data: { ok: boolean } }>(
      'https://api.example.com/graphql',
      { query: '{ ok }' },
      { idempotent: true }
    );
    expect(result).toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen.every((init) => !('idempotent' in init))).toBe(true);
  }, 30000);
});
