/**
 * Finding #3 (server-side guard): the query embedding the search path compares
 * against stored rows MUST come from the configured model. If the embeddings
 * service reports a different model, generateEmbeddings must FAIL LOUD rather
 * than returning vectors that would be compared across incompatible spaces.
 *
 * Also covers resolveEmbeddingModel's validation of the CONFIGURED model (it is
 * inlined into SQL via embeddingModelSqlLiteral, so an unsafe value must be
 * rejected).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  embeddingModelSqlLiteral,
  generateEmbeddings,
  generateQueryEmbedding,
  getConfiguredEmbeddingModel,
  resolveEmbeddingModel,
} from '../../utils/embeddings';

// biome-ignore lint/suspicious/noExplicitAny: minimal Env stub for the util
const ENV = { EMBEDDINGS_SERVICE_URL: 'http://embeddings.test' } as any;

let originalFetch: typeof globalThis.fetch;
let originalModel: string | undefined;

function stubFetch(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;
}

function vec768(): number[] {
  const v = new Array(768).fill(0);
  v[0] = 1;
  return v;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalModel = process.env.EMBEDDINGS_MODEL;
  process.env.EMBEDDINGS_MODEL = 'Xenova/bge-base-en-v1.5';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
  else process.env.EMBEDDINGS_MODEL = originalModel;
});

describe('server generateEmbeddings model guard (Finding #3)', () => {
  it('rejects a service model that differs from the configured model', async () => {
    stubFetch({ model: 'some-other-model-v2', dimensions: 768, embeddings: [vec768()] });
    await expect(generateEmbeddings(['hi'], ENV)).rejects.toThrow(
      /returned model 'some-other-model-v2' but 'Xenova\/bge-base-en-v1\.5' was requested/
    );
  });

  it('accepts a matching service model', async () => {
    stubFetch({ model: getConfiguredEmbeddingModel(), dimensions: 768, embeddings: [vec768()] });
    const out = await generateEmbeddings(['hi'], ENV);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(768);
  });

  it('accepts a response that omits the model (backward compatible)', async () => {
    stubFetch({ dimensions: 768, embeddings: [vec768()] });
    const out = await generateEmbeddings(['hi'], ENV);
    expect(out).toHaveLength(1);
  });
});

describe('embedding input size', () => {
  // The embeddings service's contract: 400 for any text over 32 KiB of UTF-8
  // (MAX_TEXT_BYTES in @lobu/embeddings), otherwise one vector per text.
  let received: string[] = [];
  beforeEach(() => {
    received = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
      received = texts;
      if (texts.some((text) => Buffer.byteLength(text.trim(), 'utf8') > 32 * 1024)) {
        return new Response('{"error":"each text must be at most 32768 bytes"}', { status: 400 });
      }
      return new Response(JSON.stringify({ embeddings: texts.map(() => vec768()) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  });

  it('embeds a query longer than the service accepts by its head', async () => {
    // Three-byte characters, so a byte cut can split one.
    const query = `Recall head ${'€'.repeat(12_000)}`;
    expect(Buffer.byteLength(query, 'utf8')).toBeGreaterThan(32 * 1024);
    expect(await generateQueryEmbedding(query, ENV)).toHaveLength(768);
    const [sent] = received;
    expect(query.startsWith(sent)).toBe(true);
    expect(sent).not.toContain('\uFFFD');
    expect(Buffer.byteLength(sent, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('sends a text within the limit unchanged', async () => {
    await generateEmbeddings(['a short query'], ENV);
    expect(received).toEqual(['a short query']);
  });
});

describe('configured-model SQL literal', () => {
  it('quotes a valid configured model name', () => {
    process.env.EMBEDDINGS_MODEL = 'Xenova/bge-base-en-v1.5';
    expect(embeddingModelSqlLiteral(getConfiguredEmbeddingModel())).toBe(
      "'Xenova/bge-base-en-v1.5'"
    );
  });

  it('rejects an unsafe configured model (SQL-injection / whitespace)', () => {
    process.env.EMBEDDINGS_MODEL = "x'; DROP TABLE event_embeddings; --";
    expect(() => resolveEmbeddingModel()).toThrow(/not a valid model identifier/);
  });
});
