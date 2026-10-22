import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

// Capture the fetch handler that server.ts hands to `serve(...)`.
let capturedFetch: ((req: Request) => Response | Promise<Response>) | null = null;

mock.module('@hono/node-server', () => ({
  serve: mock((opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    capturedFetch = opts.fetch;
    return { close: () => undefined };
  }),
}));

// Local inference runs on a worker thread that re-loads server.ts, where
// module mocks do not reach. Point the runtime at a fake component instead
// (768-dim vectors, no model download or native ONNX bindings).
const originalRuntimeEntry = process.env.LOBU_RUNTIME_EMBEDDINGS_ENTRY;
process.env.LOBU_RUNTIME_EMBEDDINGS_ENTRY = join(
  import.meta.dir,
  'fixtures',
  'blocking-local-embeddings.mjs'
);

// Snapshot env so we can restore between tests.
const ENV_KEYS = [
  'EMBEDDINGS_BACKEND',
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_API_URL',
  'EMBEDDINGS_MODEL',
  'EMBEDDINGS_DIMENSIONS',
  'EMBEDDINGS_TIMEOUT_MS',
  'EMBEDDINGS_NORMALIZE',
  'EMBEDDINGS_BATCH_SIZE',
  'EMBEDDINGS_SERVICE_TOKEN',
  'PORT',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
  delete process.env[key];
}
// Local backend by default, with a small expected dimension we can satisfy
// from the fake component.
process.env.EMBEDDINGS_DIMENSIONS = '768';

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  // Importing the module triggers the top-level serve() call, which we have
  // intercepted to grab `app.fetch`.
  await import('../server');
  if (!capturedFetch) {
    throw new Error('server.ts did not register a fetch handler via serve()');
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  if (originalRuntimeEntry === undefined) {
    delete process.env.LOBU_RUNTIME_EMBEDDINGS_ENTRY;
  } else {
    process.env.LOBU_RUNTIME_EMBEDDINGS_ENTRY = originalRuntimeEntry;
  }
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Reset only the env vars individual tests set; leave the dimensions default.
  for (const key of ENV_KEYS) {
    if (key === 'EMBEDDINGS_DIMENSIONS') continue;
    delete process.env[key];
  }
  process.env.EMBEDDINGS_DIMENSIONS = '768';
});

function dispatch(req: Request): Promise<Response> {
  if (!capturedFetch) throw new Error('app.fetch not captured');
  return Promise.resolve(capturedFetch(req));
}

function postJson(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return dispatch(
    new Request('http://localhost/api/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe('GET /health', () => {
  test('returns local backend metadata by default', async () => {
    const res = await dispatch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; backend: string; model: string };
    expect(body.ok).toBe(true);
    expect(body.backend).toBe('local');
    expect(body.model).toBe('Xenova/bge-base-en-v1.5');
  });

  test('reports openai backend and EMBEDDINGS_MODEL when EMBEDDINGS_BACKEND=openai', async () => {
    process.env.EMBEDDINGS_BACKEND = 'openai';
    process.env.EMBEDDINGS_MODEL = 'text-embedding-3-small';
    const res = await dispatch(new Request('http://localhost/health'));
    const body = (await res.json()) as { backend: string; model: string };
    expect(body.backend).toBe('openai');
    expect(body.model).toBe('text-embedding-3-small');
  });

  test('lowercases the backend name', async () => {
    process.env.EMBEDDINGS_BACKEND = 'OPENAI';
    process.env.EMBEDDINGS_MODEL = 'mdl';
    const res = await dispatch(new Request('http://localhost/health'));
    const body = (await res.json()) as { backend: string };
    expect(body.backend).toBe('openai');
  });
});

describe('POST /api/embeddings — auth', () => {
  test('returns 401 when EMBEDDINGS_SERVICE_TOKEN is set and the bearer is missing', async () => {
    process.env.EMBEDDINGS_SERVICE_TOKEN = 'topsecret';
    const res = await postJson({ texts: ['a'] });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  test('returns 401 when the bearer token does not match', async () => {
    process.env.EMBEDDINGS_SERVICE_TOKEN = 'topsecret';
    const res = await postJson({ texts: ['a'] }, { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  test('accepts the request when the bearer token matches (case-insensitive scheme)', async () => {
    process.env.EMBEDDINGS_SERVICE_TOKEN = 'topsecret';
    const res = await postJson({ texts: ['a'] }, { authorization: 'bearer topsecret' });
    expect(res.status).toBe(200);
  });

  test('skips auth check entirely when EMBEDDINGS_SERVICE_TOKEN is unset', async () => {
    const res = await postJson({ texts: ['a'] });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/embeddings — payload validation', () => {
  test('returns 400 on invalid JSON', async () => {
    const res = await dispatch(
      new Request('http://localhost/api/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid JSON payload');
  });

  test('returns 400 when texts is missing', async () => {
    const res = await postJson({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('texts must be an array of strings');
  });

  test('returns 400 when texts contains non-strings', async () => {
    const res = await postJson({ texts: ['a', 42, 'b'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('texts must be an array of strings');
  });

  test('returns 400 when texts contains an empty/whitespace string', async () => {
    const res = await postJson({ texts: ['valid', '   '] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('texts cannot contain empty strings');
  });

  test('returns 400 when texts is an empty array', async () => {
    const res = await postJson({ texts: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('texts cannot be empty');
  });
});

describe('POST /api/embeddings — local backend', () => {
  test('returns local embeddings for a single text', async () => {
    const res = await postJson({ texts: ['hello'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      dimensions: number;
      embeddings: number[][];
    };
    expect(body.dimensions).toBe(768);
    expect(body.embeddings).toHaveLength(1);
    expect(body.embeddings[0]).toHaveLength(768);
    expect(body.model).toBe('Xenova/bge-base-en-v1.5');
  });

  test('returns local embeddings for multiple texts (batched path)', async () => {
    const res = await postJson({ texts: ['a', 'b', 'c'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { embeddings: number[][] };
    expect(body.embeddings).toHaveLength(3);
    for (const v of body.embeddings) {
      expect(v).toHaveLength(768);
    }
  });

  test('trims whitespace from each input before processing', async () => {
    const res = await postJson({ texts: ['  hello  '] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { embeddings: number[][] };
    expect(body.embeddings[0]).toHaveLength(768);
  });

  test('returns 500 when the embedding has the wrong dimensions', async () => {
    process.env.EMBEDDINGS_DIMENSIONS = '999'; // fake extractor returns 768
    const res = await postJson({ texts: ['hello'] });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Local embeddings response');
    expect(body.error).toContain('768');
    expect(body.error).toContain('999');
  });
});

describe('POST /api/embeddings — local inference worker', () => {
  test('returns 500 with the component error message', async () => {
    const res = await postJson({ texts: ['fail'] });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('component failed');
  });

  test('fails the in-flight request and recovers on the next one when the worker dies', async () => {
    const crashed = await postJson({ texts: ['crash'] });
    expect(crashed.status).toBe(500);
    const crashBody = (await crashed.json()) as { error: string };
    expect(crashBody.error).toContain('worker exited');

    const res = await postJson({ texts: ['hello'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { embeddings: number[][] };
    expect(body.embeddings[0]).toHaveLength(768);
  });
});

describe('POST /api/embeddings — openai backend', () => {
  function mockOpenAIFetch(body: unknown, init?: ResponseInit) {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
          ...init,
        })
    ) as unknown as typeof fetch;
  }

  test('returns 500 when EMBEDDINGS_API_KEY is missing', async () => {
    process.env.EMBEDDINGS_BACKEND = 'openai';
    const res = await postJson({ texts: ['a'] });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('EMBEDDINGS_API_KEY is required for openai backend');
  });

  test('returns 500 when no model is configured', async () => {
    process.env.EMBEDDINGS_BACKEND = 'openai';
    process.env.EMBEDDINGS_API_KEY = 'sk';
    const res = await postJson({ texts: ['a'] });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('EMBEDDINGS_MODEL is required for openai backend');
  });

  test('forwards a successful OpenAI response back to the caller', async () => {
    process.env.EMBEDDINGS_BACKEND = 'openai';
    process.env.EMBEDDINGS_API_KEY = 'sk';
    process.env.EMBEDDINGS_MODEL = 'text-embedding-3-small';
    process.env.EMBEDDINGS_DIMENSIONS = '3';
    process.env.EMBEDDINGS_NORMALIZE = 'false';

    mockOpenAIFetch({
      data: [{ embedding: [1, 2, 3], index: 0 }],
    });

    const res = await postJson({ texts: ['hi'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      dimensions: number;
      embeddings: number[][];
    };
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.dimensions).toBe(3);
    expect(body.embeddings).toEqual([[1, 2, 3]]);
  });

  test('per-request payload.model overrides EMBEDDINGS_MODEL', async () => {
    process.env.EMBEDDINGS_BACKEND = 'openai';
    process.env.EMBEDDINGS_API_KEY = 'sk';
    process.env.EMBEDDINGS_MODEL = 'fallback-model';
    process.env.EMBEDDINGS_DIMENSIONS = '3';

    let observedBody: unknown;
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      observedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const res = await postJson({ texts: ['hi'], model: 'override-model' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('override-model');
    expect(observedBody).toEqual({ model: 'override-model', input: ['hi'] });
  });

  test('returns 500 when OpenAI returns an error', async () => {
    process.env.EMBEDDINGS_BACKEND = 'openai';
    process.env.EMBEDDINGS_API_KEY = 'sk';
    process.env.EMBEDDINGS_MODEL = 'm';
    process.env.EMBEDDINGS_DIMENSIONS = '3';

    globalThis.fetch = mock(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof fetch;

    const res = await postJson({ texts: ['hi'] });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('OpenAI embeddings error (500)');
  });
});
