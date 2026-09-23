import { afterEach, describe, expect, it } from 'bun:test';
import { feedBackoff, shouldHardPauseFeed } from '../../connectors/feed-backoff';

const ENV_CASES = [
  ['FEED_BACKOFF_BASE_MS', () => feedBackoff.baseMs, 60_000],
  ['FEED_BACKOFF_MAX_MS', () => feedBackoff.maxMs, 6 * 60 * 60 * 1000],
  ['FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES', () => feedBackoff.pauseThreshold, 20],
] as const;

describe('feed backoff values from env', () => {
  const previous = new Map(ENV_CASES.map(([key]) => [key, process.env[key]]));
  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('ignores values that are non-positive after rounding', () => {
    for (const [key, read, fallback] of ENV_CASES) {
      for (const value of ['0.4', '5e-324', '0', '-3', 'abc']) {
        process.env[key] = value;
        expect(read()).toBe(fallback);
      }
    }
    expect(shouldHardPauseFeed(0)).toBe(false);
  });

  it('rounds a fractional threshold', () => {
    process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = '2.6';
    expect(feedBackoff.pauseThreshold).toBe(3);
  });
});
