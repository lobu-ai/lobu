import type { FeedObserveResult } from './connector-types.js';

const fields = new Set(['event_type', 'resource_ref', 'delivery_id', 'resource_type', 'occurred_at']);

/** Fail before acknowledging a batch that cannot be safely delivered. */
export function assertFeedObservation(result: FeedObserveResult<unknown>): void {
  if (!result || !Array.isArray(result.changes) || result.changes.length > 1000) {
    throw new Error('Feed observation must return at most 1000 changes');
  }
  for (const change of result.changes) {
    if (!change || typeof change !== 'object' || Object.keys(change).some(key => !fields.has(key))) {
      throw new Error('Feed observation changes may contain only source reference metadata');
    }
    for (const key of ['event_type', 'resource_ref', 'delivery_id'] as const) {
      if (typeof change[key] !== 'string' || !change[key].trim() || change[key].length > 2048) {
        throw new Error(`Invalid feed observation ${key}`);
      }
    }
    if (change.resource_type !== undefined &&
        (typeof change.resource_type !== 'string' || !change.resource_type.trim() || change.resource_type.length > 256)) {
      throw new Error('Invalid feed observation resource_type');
    }
    if (change.occurred_at !== undefined &&
        (typeof change.occurred_at !== 'string' || !Number.isFinite(Date.parse(change.occurred_at)))) {
      throw new Error('Invalid feed observation occurred_at');
    }
  }
  if (result.checkpoint !== null &&
      (typeof result.checkpoint !== 'object' || Array.isArray(result.checkpoint))) {
    throw new Error('Feed observation checkpoint must be an object or null');
  }
  if (JSON.stringify(result.checkpoint).length > 262144) {
    throw new Error('Feed observation checkpoint exceeds 256 KiB');
  }
  if (result.hasMore !== undefined && typeof result.hasMore !== 'boolean') {
    throw new Error('Invalid feed observation hasMore');
  }
}
