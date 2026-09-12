import type { FeedReadResult, FeedReadWindow } from './connector-types.js';

export function validateFeedReadWindow(window: FeedReadWindow): void {
  if (!Number.isFinite(Date.parse(window.start)) || !Number.isFinite(Date.parse(window.end)) ||
      Date.parse(window.start) >= Date.parse(window.end)) {
    throw new Error('Source read window must have valid start < end bounds.');
  }
}

/** Verify the reader honored the feed's declared window contract. */
export function assertFeedReadWindow(
  result: FeedReadResult,
  window?: FeedReadWindow,
  declaredAxis?: string,
): void {
  if (!window) return;
  validateFeedReadWindow(window);
  if (!declaredAxis?.trim()) {
    throw new Error('Source feed does not declare a window time axis.');
  }
  if (result.window?.start !== window.start || result.window?.end !== window.end ||
      result.window.axis !== declaredAxis) {
    throw new Error('Source reader did not acknowledge the requested window and time axis.');
  }
  if (typeof result.hasMore !== 'boolean' ||
      (result.nextCursor !== undefined && (!result.nextCursor || !result.hasMore))) {
    throw new Error('Windowed source reads must explicitly report page exhaustion.');
  }
}
