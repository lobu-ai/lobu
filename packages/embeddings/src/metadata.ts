/** Embedding configuration without loading a model or the ONNX runtime. */
const DEFAULT_MODEL_NAME = 'Xenova/bge-base-en-v1.5';
export const DEFAULT_DIMENSIONS = 768;
export const DEFAULT_BATCH_SIZE = 32;
export function getLocalModelName(): string {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL_NAME;
}
export { validateEmbeddingDimensions } from './embedding-utils.js';
