import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_FEED_READ_ACTION_KEY,
  guardedSourceReadScrubAssignments,
  sourceReadOnlyScrubAssignments,
  sourceReadScrubAssignments,
  sourceReadScrubAssignmentsSql,
} from './device-feed-read-protocol';

function collectSql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((text, part, index) => text + String(values[index - 1]) + part);
}

describe('source-read scrub SQL', () => {
  it('renders the standard three-arm assignments', () => {
    expect(sourceReadScrubAssignments(collectSql).split('\n')).toMatchSnapshot();
  });

  it.each([true, false])('renders guarded assignments with guard=%s', (guard) => {
    expect(guardedSourceReadScrubAssignments(collectSql, guard).split('\n')).toMatchSnapshot();
  });

  it('renders source-read-only assignments with the supplied receipt', () => {
    const sql = vi.fn(collectSql);
    expect(sourceReadOnlyScrubAssignments(sql,
      '{"scrubbed":true,"feed_key":"requested-feed"}',
    ).split('\n')).toMatchSnapshot();
    expect(sql.mock.calls.some(([, ...values]) => values.includes(DEVICE_FEED_READ_ACTION_KEY))).toBe(false);
  });

  it('renders raw reaper assignments with the $5 binding', () => {
    expect(sourceReadScrubAssignmentsSql('$5').split('\n')).toMatchSnapshot();
  });
});
