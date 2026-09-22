import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { HttpStatusError } from '../http-client.js';
import { withHttpRetry } from '../retry.js';

// Speed up tests: p-retry honors minTimeout but tests can still take a few hundred ms.
// We keep retry counts low by either succeeding fast or aborting.

describe('withHttpRetry', () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = 'silent';
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  test('returns the value when fn resolves on the first try', async () => {
    const fn = mock(async () => 'ok');
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (404)', async () => {
    const fn = mock(async () => {
      throw new Error('Resource not found (404)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/not found|404/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (401 unauthorized)', async () => {
    const fn = mock(async () => {
      throw new Error('Unauthorized request (401)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/unauthorized|401/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (403 forbidden)', async () => {
    const fn = mock(async () => {
      throw new Error('Forbidden (403)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/forbidden|403/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (400 bad request)', async () => {
    const fn = mock(async () => {
      throw new Error('Bad Request (400)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/bad request|400/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts on non-retryable, non-permanent error (treated as abort)', async () => {
    const fn = mock(async () => {
      throw new Error('Some random unrelated failure');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/random unrelated/i);
    // Non-retryable, non-permanent errors are also wrapped in AbortError → 1 call.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on retryable network error then succeeds', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw new Error('ECONNRESET socket hangup');
      return 'recovered';
    });
    const onRetry = mock((_e: Error, _attempt: number) => {});
    const result = await withHttpRetry(fn, {
      operation: 'test-op',
      onRetry,
      context: { foo: 'bar' },
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 30000);

  test('retries on rate limit error then succeeds', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw new Error('429 too many requests');
      return 'ok';
    });
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30000);

  test('retries on server error (503) then succeeds', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw new Error('Service unavailable 503');
      return 'ok';
    });
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30000);

  test('retries a database error by its SQLSTATE, not its wording', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }
      return 'ok';
    });
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30000);

  test('does not retry a permanent SQLSTATE even when its text sounds transient', async () => {
    const fn = mock(async () => {
      throw Object.assign(new Error('syntax error at or near "timeout"'), { code: '42601' });
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/syntax error/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('handles non-Error throwable values', async () => {
    const fn = mock(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string error';
    });
    await expect(withHttpRetry(fn)).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // The status an HttpStatusError carries is the whole answer. Its message embeds
  // the URL and response body, and those words used to decide: a 503 whose body
  // happened to say "invalid" was treated as permanent and never retried.
  function statusError(status: number, url: string, bodyText: string) {
    return new HttpStatusError({
      prefix: 'API',
      method: 'GET',
      url,
      status,
      statusText: '',
      bodyText,
    });
  }

  for (const [label, status, url, body] of [
    ['503 whose body says "invalid"', 503, 'https://api.example.com/items', 'invalid request parameter'],
    ['500 whose body says "not found"', 500, 'https://api.example.com/items', 'record not found upstream'],
    ['503 whose URL contains 404', 503, 'https://api.example.com/e/404', 'service unavailable'],
    ['429 whose body says "Bad Request"', 429, 'https://api.example.com/items', 'Bad Request: quota'],
  ] as const) {
    test(`retries a ${label}`, async () => {
      let attempt = 0;
      const fn = mock(async () => {
        attempt++;
        if (attempt < 2) throw statusError(status, url, body);
        return 'ok';
      });
      expect(await withHttpRetry(fn)).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    }, 30000);
  }

  test('does not retry a 404 even when its body sounds transient', async () => {
    const fn = mock(async () => {
      throw statusError(404, 'https://api.example.com/items', 'service unavailable, try again');
    });
    await expect(withHttpRetry(fn)).rejects.toBeInstanceOf(HttpStatusError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a non-repeatable call is not retried on a 5xx: the write may have landed', async () => {
    const fn = mock(async () => {
      throw statusError(503, 'https://api.example.com/send', 'unavailable');
    });
    await expect(withHttpRetry(fn, { repeatable: false })).rejects.toBeInstanceOf(HttpStatusError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a non-repeatable call is not retried on a dropped connection', async () => {
    const fn = mock(async () => {
      throw new TypeError('fetch failed: socket hang up');
    });
    await expect(withHttpRetry(fn, { repeatable: false })).rejects.toThrow(/fetch failed/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a non-repeatable call is still retried on a 429: the server did not act on it', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw statusError(429, 'https://api.example.com/send', 'slow down');
      return 'ok';
    });
    expect(await withHttpRetry(fn, { repeatable: false })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30000);
});
