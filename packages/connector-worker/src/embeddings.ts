/**
 * Embedding Generation (local or remote)
 *
 * If EMBEDDINGS_SERVICE_URL is set, calls the HTTP embeddings service.
 * Otherwise, uses @lobu/embeddings local pipeline (@xenova/transformers).
 */

import {
  DEFAULT_DIMENSIONS,
  getLocalModelName,
  validateEmbeddingDimensions,
} from '@lobu/embeddings/metadata';
import { pathToFileURL } from 'node:url';
import { MAX_EMBEDDING_TEXT_BYTES, truncateToBytes } from './embeddings-text.js';
import { resolveServiceModel } from './embeddings-model.js';

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 30000;

/** Embeddings plus the model/version stamp that produced them. */
interface EmbeddingResult {
  embeddings: number[][];
  /** Model identifier persisted on each row so different vector spaces never mix. */
  model: string;
}

function getExpectedDimensions(): number {
  const raw = process.env.EMBEDDINGS_DIMENSIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_DIMENSIONS;
  return Number.isFinite(parsed) ? parsed : DEFAULT_DIMENSIONS;
}

/**
 * The model this worker is configured to produce/consume. Both backends read
 * the same env var (with the same default), so this is the authoritative
 * expectation the service must match — see {@link resolveServiceModel}.
 */
function getExpectedEmbeddingModel(): string {
  return getLocalModelName();
}

function getTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.EMBEDDINGS_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TIMEOUT_MS;
}

async function fetchEmbeddingsFromService(texts: string[]): Promise<EmbeddingResult> {
  const baseUrl = process.env.EMBEDDINGS_SERVICE_URL;
  if (!baseUrl) {
    throw new Error('EMBEDDINGS_SERVICE_URL is required for service backend');
  }

  const url = baseUrl.replace(/\/+$/, '');
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (process.env.EMBEDDINGS_SERVICE_TOKEN) {
      headers.Authorization = `Bearer ${process.env.EMBEDDINGS_SERVICE_TOKEN}`;
    }

    const response = await fetch(`${url}/api/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embeddings service error (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      embeddings?: number[][];
      dimensions?: number;
      model?: string;
    };

    if (!Array.isArray(payload.embeddings)) {
      throw new Error('Embeddings service response missing embeddings array');
    }

    if (payload.embeddings.length !== texts.length) {
      throw new Error(
        `Embeddings service returned ${payload.embeddings.length} embeddings for ${texts.length} texts`
      );
    }

    if (payload.dimensions && payload.dimensions !== getExpectedDimensions()) {
      throw new Error(
        `Embeddings service returned ${payload.dimensions} dimensions (expected ${getExpectedDimensions()})`
      );
    }

    // Fail loud on a model mismatch; otherwise resolve the stamp to persist.
    const model = resolveServiceModel(payload.model, getExpectedEmbeddingModel());

    for (const embedding of payload.embeddings) {
      validateEmbeddingDimensions(embedding, getExpectedDimensions(), 'Embeddings service');
    }

    return { embeddings: payload.embeddings, model };
  } finally {
    clearTimeout(timeout);
  }
}

export async function batchGenerateEmbeddings(
  texts: string[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<EmbeddingResult> {
  if (texts.length === 0) {
    return { embeddings: [], model: getExpectedEmbeddingModel() };
  }

  // Clamp each text to the service's per-text byte budget. The model truncates
  // to its max sequence length regardless, so this is lossless for the vector
  // but prevents one oversized item (e.g. a long reddit post body) from 400-ing
  // — and thereby silently dropping — the entire batch. See embeddings-text.ts.
  const clamped = texts.map((t) => truncateToBytes(t, MAX_EMBEDDING_TEXT_BYTES));

  if (process.env.EMBEDDINGS_SERVICE_URL) {
    return fetchEmbeddingsFromService(clamped);
  }

  // The launcher prepares the ONNX component before the worker claims jobs.
  // Keeping this import behind the local branch avoids loading ONNX on remote
  // workers (the old CLI install measured 2 GiB including local inference).
  const entry = process.env.LOBU_RUNTIME_EMBEDDINGS_ENTRY;
  const specifier = entry ? pathToFileURL(entry).href : '@lobu/embeddings';
  const { batchGenerateLocalEmbeddings } = await import(specifier) as typeof import('@lobu/embeddings');
  const embeddings = await batchGenerateLocalEmbeddings(clamped, batchSize);
  for (const embedding of embeddings) {
    validateEmbeddingDimensions(embedding, getExpectedDimensions(), 'Local embeddings');
  }
  return { embeddings, model: getLocalModelName() };
}
