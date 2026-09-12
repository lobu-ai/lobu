import { describe, expect, test } from 'bun:test';
import { assertFeedReadWindow, validateFeedReadWindow } from '../feed-read-window';

const window = { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' };
describe('source window contract', () => {
  test('rejects unsupported readers and missing exhaustion', () => {
    expect(() => assertFeedReadWindow({ rows: [], hasMore: false }, window, 'updated_at')).toThrow(/acknowledge/);
    expect(() => assertFeedReadWindow({ rows: [], window: { ...window, axis: 'updated_at' } }, window, 'updated_at')).toThrow(/exhaustion/);
  });
  test('rejects changed bounds, missing axes and contradictory continuation', () => {
    for (const coverage of [{ ...window, start: window.end, axis: 'updated_at' }, { ...window, axis: '' }]) {
      expect(() => assertFeedReadWindow({ rows: [], hasMore: false, window: coverage }, window, 'updated_at')).toThrow();
    }
    expect(() => assertFeedReadWindow({ rows: [], hasMore: false, nextCursor: 'next', window: { ...window, axis: 'updated_at' } }, window, 'updated_at')).toThrow();
    expect(() => assertFeedReadWindow({ rows: [], hasMore: false, window: { ...window, axis: 'created_at' } }, window, 'updated_at')).toThrow(/axis/);
    expect(() => assertFeedReadWindow({ rows: [], hasMore: false, window: { ...window, axis: 'updated_at' } }, window)).toThrow(/declare/);
  });
  test('allows empty pages with authoritative continuation and ordinary unwindowed reads', () => {
    expect(() => assertFeedReadWindow({ rows: [], hasMore: true, nextCursor: 'next', window: { ...window, axis: 'updated_at' } }, window, 'updated_at')).not.toThrow();
    expect(() => assertFeedReadWindow({ rows: [] })).not.toThrow();
  });
  test('rejects invalid and reversed windows', () => {
    expect(() => validateFeedReadWindow({ ...window, end: window.start })).toThrow();
    expect(() => validateFeedReadWindow({ ...window, start: 'invalid' })).toThrow();
  });
});
