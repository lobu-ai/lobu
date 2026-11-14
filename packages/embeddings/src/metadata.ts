/** Embedding configuration without loading a model or the ONNX runtime. */
const DEFAULT_MODEL_NAME = 'Xenova/bge-base-en-v1.5';
export const DEFAULT_DIMENSIONS = 768;
/**
 * Texts per local forward pass. The inference worker only switches requests
 * between passes, so a search query waits for the pass already running: at 32
 * long texts that was 10-15 s on prod CPUs. On CPU, batching buys no
 * throughput (256 long texts embed in ~22 s at every size from 1 to 32), so a
 * small pass keeps the wait short at no cost.
 */
export const DEFAULT_BATCH_SIZE = 4;
export function getLocalModelName(): string {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL_NAME;
}
export { validateEmbeddingDimensions } from './embedding-utils.js';
