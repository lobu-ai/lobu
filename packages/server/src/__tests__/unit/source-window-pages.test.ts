import { describe, expect, test } from 'bun:test';
import { assertCompleteSourceWindowPages } from '../../automations/source-window-pages';
import type { SourceWindowPage } from '../../utils/jwt';

const required = [{ name: 'alpha', feed_id: 1 }, { name: 'beta', feed_id: 2 }];
const a: SourceWindowPage = { name: 'alpha', feed_id: 1, axis: 'updated_at', revision: 'config-a', returned: 0, next_cursor: 'a-next' };
const aEnd: SourceWindowPage = { ...a, before_cursor: 'a-next', next_cursor: undefined, returned: 2 };
const b: SourceWindowPage = { name: 'beta', feed_id: 2, axis: 'received_at', revision: 'config-b', returned: 1 };
const proof = (pages: SourceWindowPage[]) => [{ required_sources: required, source_pages: pages }];

describe('source window completion proof', () => {
  test('allows shuffled pages and an empty intermediate provider page', () => {
    expect(assertCompleteSourceWindowPages(proof([aEnd, b, a]), required)).toEqual([
      { name: 'alpha', feed_id: 1, axis: 'updated_at', rows: 2 },
      { name: 'beta', feed_id: 2, axis: 'received_at', rows: 1 },
    ]);
  });
  test.each([
    ['missing source', [a, aEnd]],
    ['missing page', [a, b]],
    ['missing root', [aEnd, b]],
    ['duplicate root', [a, a, aEnd, b]],
    ['duplicate continuation', [a, aEnd, aEnd, b]],
    ['disconnected page', [a, aEnd, b, { ...aEnd, before_cursor: 'unseen' }]],
    ['changed configuration', [a, { ...aEnd, revision: 'changed' }, b]],
    ['changed time axis', [a, { ...aEnd, axis: 'created_at' }, b]],
    ['wrong feed', [a, { ...aEnd, feed_id: 3 }, b]],
    ['cycle', [a, { ...aEnd, next_cursor: 'a-next' }, b]],
  ] as const)('rejects %s', (_name, pages) => {
    expect(() => assertCompleteSourceWindowPages(proof([...pages]), required)).toThrow(/Incomplete/);
  });
  test('cannot replace the required source roster with a caller-selected subset', () => {
    expect(() => assertCompleteSourceWindowPages([{ required_sources: [required[0]], source_pages: [a, aEnd] }], required)).toThrow(/pinned/);
    expect(() => assertCompleteSourceWindowPages([{}], required)).toThrow(/pinned/);
  });
});
