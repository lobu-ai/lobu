import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const readFeed = vi.fn();
const scope = { organizationId: 'cursor-test-org', principal: 'cursor-test-user' };
let readPage: typeof import('./source-feed-page').readSourceFeedPage;
beforeAll(async () => {
  vi.resetModules();
  vi.doMock('./connector-pushdown', () => ({ readSourceFeed: readFeed }));
  readPage = (await import('./source-feed-page')).readSourceFeedPage;
});
beforeEach(() => { readFeed.mockReset(); });
afterAll(() => {
  vi.doUnmock('./connector-pushdown');
  vi.resetModules();
});

it('wraps an exact row checkpoint with the same feed and match binding as a page cursor', async () => {
  const match = { path: 'metadata.account_id', values: ['a1'] };
  readFeed.mockResolvedValueOnce({ rows: [{ id: 'e3' }, { id: 'e2' }], rowCursors: ['after-e3', 'after-e2'], nextCursor: 'after-e2' });
  const first = await readPage({ feed_id: 1, match, limit: 2 }, 1000, scope);
  expect(first.row_cursors).toHaveLength(2);
  expect(first.row_cursors![1]).toBe(first.next_cursor);
  readFeed.mockResolvedValueOnce({ rows: [{ id: 'e2' }, { id: 'e1' }], rowCursors: ['after-e2', 'after-e1'] });
  const next = await readPage({ feed_id: 1, match, cursor: first.row_cursors![0], limit: 2 }, 1000, scope);
  expect(readFeed).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'after-e3', offset: 0, match, scope }));
  expect(next.next_cursor).toBeUndefined();
  await expect(readPage({ feed_id: 2, match, cursor: first.row_cursors![0] }, 1000, scope)).rejects.toThrow(/does not match/);
  await expect(readPage({ feed_id: 1, match: { ...match, values: ['a2'] }, cursor: first.row_cursors![0] }, 1000, scope)).rejects.toThrow(/does not match/);
  expect(readFeed).toHaveBeenCalledTimes(2);
});

it.each([null, {}, [], ['only-one'], ['a', 'a'], ['', 'b'], ['a', 2]])('rejects malformed row checkpoints: %j', async (rowCursors) => {
  readFeed.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }], rowCursors });
  await expect(readPage({ feed_id: 1 }, 1000, scope)).rejects.toThrow(/malformed row cursors/);
});

it('rejects a row checkpoint that does not advance past the supplied source cursor', async () => {
  readFeed.mockResolvedValueOnce({ rows: [{ id: 1 }], nextCursor: 'page-2' });
  const first = await readPage({ feed_id: 1 }, 1000, scope);
  readFeed.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCursors: ['page-2'] });
  await expect(readPage({ feed_id: 1, cursor: first.next_cursor }, 1000, scope)).rejects.toThrow(/malformed row cursors/);
});

it('keeps opaque provider page tokens working without row checkpoints', async () => {
  readFeed.mockResolvedValueOnce({ rows: [{ id: 1 }], nextCursor: 'opaque-provider-page-2' });
  const first = await readPage({ feed_id: 1 }, 1000, scope);
  expect(first.row_cursors).toBeUndefined();
  readFeed.mockResolvedValueOnce({ rows: [{ id: 2 }] });
  const last = await readPage({ feed_id: 1, cursor: first.next_cursor }, 1000, scope);
  expect(readFeed).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'opaque-provider-page-2' }));
  expect(last.next_cursor).toBeUndefined();
});

it('cancels a pending source read at the caller boundary', async () => {
  readFeed.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const controller = new AbortController();
  const pending = readPage({ feed_id: 1 }, 1000, scope, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});
