/**
 * Client for an external text-classification service.
 *
 * Any server that implements `POST {CLASSIFIER_SERVICE_URL}/v1/classify` works:
 * a hosted API such as classifier.dev, a self-hosted Jev model, or a local shim
 * in front of any other model. The contract is the single-label subset of the
 * classifier.dev v1 API:
 *
 *   request:  { inputs: string[], labels: string[], instructions?: string }
 *   response: { results: [{ label, confidence: number|null, scores: {label: number}|null, model? }] }
 *
 * `results` must be in input order, one per input, and every `label` must be
 * one of the supplied labels. `confidence: null` is an explicitly unscored
 * answer. Anything else is rejected rather than half-applied.
 */

import type { Env } from '../index';

/** Largest batch sent in one request. classifier.dev accepts 1,000; local models often less. */
const CLASSIFIER_SERVICE_BATCH_SIZE = 100;
// Bound the serialized UTF-8 body, including the rubric and JSON escaping.
const MAX_REQUEST_BYTES = 1_000_000;

const DEFAULT_TIMEOUT_MS = 30000;

interface ServicePrediction {
  label: string;
  confidence: number | null;
  scores: Record<string, number> | null;
  model: string | null;
}

class ClassifierServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ClassifierServiceError';
  }
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePrediction(value: unknown, labels: string[]): ServicePrediction | null {
  if (!isRecord(value) || typeof value.label !== 'string' || !labels.includes(value.label)) {
    return null;
  }
  const confidence = value.confidence;
  if (confidence !== null && !probability(confidence)) return null;
  const scores = value.scores ?? null;
  if (scores !== null) {
    if (!isRecord(scores)) return null;
    for (const [label, score] of Object.entries(scores)) {
      if (!labels.includes(label) || !probability(score)) return null;
    }
  }
  return {
    label: value.label,
    confidence,
    scores: scores as Record<string, number> | null,
    model: typeof value.model === 'string' && value.model.trim() ? value.model : null,
  };
}

async function classifyBatch(
  url: string,
  env: Env,
  inputs: string[],
  labels: string[],
  instructions: string | undefined
): Promise<ServicePrediction[]> {
  const parsedTimeout = Number.parseInt(env.CLASSIFIER_SERVICE_TIMEOUT_MS || '', 10);
  const timeoutMs = Number.isFinite(parsedTimeout) ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const token = env.CLASSIFIER_SERVICE_TOKEN?.trim();

  let response: Response;
  try {
    response = await fetch(`${url}/v1/classify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ inputs, labels, ...(instructions ? { instructions } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ClassifierServiceError(
      `Classifier service unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ClassifierServiceError(
      `Classifier service returned HTTP ${response.status}: ${body.slice(0, 300)}`,
      response.status
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;
  const results = isRecord(body) && Array.isArray(body.results) ? body.results : null;
  if (!results || results.length !== inputs.length) {
    throw new ClassifierServiceError(
      `Classifier service returned ${results ? results.length : 'no'} results for ${inputs.length} inputs`
    );
  }
  const topModel = isRecord(body) && typeof body.model === 'string' ? body.model : null;
  return results.map((raw, index) => {
    const prediction = parsePrediction(raw, labels);
    if (!prediction) {
      throw new ClassifierServiceError(
        `Classifier service returned an invalid result at index ${index}: ${JSON.stringify(raw).slice(0, 200)}`
      );
    }
    return { ...prediction, model: prediction.model ?? topModel };
  });
}

/**
 * Classify `inputs` against `labels`, batching as needed. Resolves to one
 * prediction per input, in order, or rejects with a ClassifierServiceError —
 * never a partial list.
 */
export async function classifyViaService(
  inputs: string[],
  labels: string[],
  instructions: string | undefined,
  env: Env
): Promise<ServicePrediction[]> {
  const url = env.CLASSIFIER_SERVICE_URL?.trim().replace(/\/+$/, '');
  if (!url) {
    throw new ClassifierServiceError(
      'CLASSIFIER_SERVICE_URL is not configured. Point it at any server implementing POST /v1/classify (for example https://classifier.dev or a local model).'
    );
  }
  const predictions: ServicePrediction[] = [];
  const encoder = new TextEncoder();
  const envelopeBytes = encoder.encode(
    JSON.stringify({ inputs: [], labels, ...(instructions ? { instructions } : {}) })
  ).byteLength;
  let batch: string[] = [];
  let batchBytes = envelopeBytes;
  for (const input of inputs) {
    const inputBytes = encoder.encode(JSON.stringify(input)).byteLength;
    if (envelopeBytes + inputBytes > MAX_REQUEST_BYTES) {
      throw new ClassifierServiceError(
        'Classifier service input and rubric exceed the 1 MB request limit'
      );
    }
    if (
      batch.length > 0 &&
      (batch.length === CLASSIFIER_SERVICE_BATCH_SIZE || batchBytes + inputBytes + 1 > MAX_REQUEST_BYTES)
    ) {
      predictions.push(...(await classifyBatch(url, env, batch, labels, instructions)));
      batch = [];
      batchBytes = envelopeBytes;
    }
    batchBytes += inputBytes + (batch.length > 0 ? 1 : 0);
    batch.push(input);
  }
  if (batch.length > 0) {
    predictions.push(...(await classifyBatch(url, env, batch, labels, instructions)));
  }
  return predictions;
}
