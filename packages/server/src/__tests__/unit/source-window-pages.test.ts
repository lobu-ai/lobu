import { describe, expect, test } from 'bun:test';
import { summarizeSourceWindowPages } from '../../automations/source-window-pages';
import type { SourceWindowPage } from '../../utils/jwt';

const required = [{ name: 'alpha', feed_id: 1 }, { name: 'beta', feed_id: 2 }];
const a: SourceWindowPage = { name: 'alpha', feed_id: 1, axis: 'updated_at', revision: 'config-a', returned: 0, next_cursor: 'a-next' };
const aEnd: SourceWindowPage = { ...a, before_cursor: 'a-next', next_cursor: undefined, returned: 2 };
const b: SourceWindowPage = { name: 'beta', feed_id: 2, axis: 'received_at', revision: 'config-b', returned: 1 };
const proof = (pages: SourceWindowPage[]) => [{ required_sources: required, source_pages: pages }];

describe('source window coverage', () => {
  test('follows shuffled pages and an empty intermediate provider page', () => {
    expect(summarizeSourceWindowPages(proof([aEnd, b, a]), required)).toEqual([
      { name: 'alpha', feed_id: 1, axis: 'updated_at', rows: 2, complete: true },
      { name: 'beta', feed_id: 2, axis: 'received_at', rows: 1, complete: true },
    ]);
  });
  test.each([
    ['missing source', [a, aEnd], { alpha: [2, true], beta: [0, false] }],
    ['missing page', [a, b], { alpha: [0, false], beta: [1, true] }],
    ['missing root', [aEnd, b], { alpha: [0, false], beta: [1, true] }],
    ['duplicate root', [a, { ...a }, aEnd, b], { alpha: [0, false], beta: [1, true] }],
    ['duplicate continuation', [a, aEnd, { ...aEnd }, b], { alpha: [0, false], beta: [1, true] }],
    ['disconnected page', [a, aEnd, b, { ...aEnd, before_cursor: 'unseen' }], { alpha: [2, false], beta: [1, true] }],
    ['changed configuration', [a, { ...aEnd, revision: 'changed' }, b], { alpha: [0, false], beta: [1, true] }],
    ['changed time axis', [a, { ...aEnd, axis: 'created_at' }, b], { alpha: [0, false], beta: [1, true] }],
    ['cycle', [a, { ...aEnd, next_cursor: 'a-next' }, b], { alpha: [2, false], beta: [1, true] }],
  ] as const)('records a partial read instead of refusing it: %s', (_name, pages, expected) => {
    const coverage = summarizeSourceWindowPages(proof([...pages]), required);
    expect(Object.fromEntries(coverage.map((source) => [source.name, [source.rows, source.complete]]))).toEqual(expected);
  });
  test('cannot replace the required source roster with a caller-selected subset', () => {
    expect(() => summarizeSourceWindowPages([{ required_sources: [required[0]], source_pages: [a, aEnd] }], required)).toThrow(/pinned/);
    expect(() => summarizeSourceWindowPages([{}], required)).toThrow(/pinned/);
  });
  test('rejects a receipt from a source this Automation does not pin', () => {
    expect(() => summarizeSourceWindowPages(proof([a, { ...aEnd, feed_id: 3 }, b]), required)).toThrow(/unexpected source receipt/);
  });
});
