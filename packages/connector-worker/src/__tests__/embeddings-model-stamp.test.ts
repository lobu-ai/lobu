/**
 * Finding #3 reproducer (part a): embeddings must be version-stamped so a
 * same-dimension model swap can't silently mix incompatible vector spaces.
 *
 * `resolveServiceModel` is the guard that `fetchEmbeddingsFromService` applies
 * to every service response. Asserted directly (pure function) so the check is
 * immune to bun's process-global `mock.module` of '../embeddings.js' in the
 * sibling executor tests.
 *
 *   - a service `model` that differs from the worker's expectation throws
 *     (fail loud) — the exact silent-mixing case, even at equal dimensionality;
 *   - a matching `model` resolves to that stamp;
 *   - an omitted `model` falls back to the worker's expectation.
 *
 * Part (b) — persistence of the stamp onto event_embeddings — is asserted
 * server-side in packages/server/src/__tests__/integration/events/
 * embedding-model-swap-e2e.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { resolveServiceModel } from '../embeddings-model.js';

const EXPECTED = 'Xenova/bge-base-en-v1.5';

describe('embeddings model version stamp guard (Finding #3)', () => {
  test('rejects a same-dimension model mismatch (fail loud)', () => {
    expect(() => resolveServiceModel('some-other-model-v2', EXPECTED)).toThrow(
      /returned model 'some-other-model-v2' but this worker expects/
    );
  });

  test('resolves to the service model on a match', () => {
    expect(resolveServiceModel(EXPECTED, EXPECTED)).toBe(EXPECTED);
  });

  test('falls back to the expected model when the service omits one', () => {
    expect(resolveServiceModel(undefined, EXPECTED)).toBe(EXPECTED);
  });
});
