import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTurnAccess } from '@lobu/core';
import { authzScopeFromToolContext } from '../authz/scope';

const adapterRead = vi.fn();
const nativeRead = vi.fn();
const lookup = vi.fn();
let readSourceFeed: typeof import('./connector-pushdown').readSourceFeed;
let feed: Record<string, unknown>;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('../db/client', async () => ({
    ...await vi.importActual('../db/client'),
    getDb: () => ({ unsafe: lookup }),
  }));
  vi.doMock('./source-feed-adapters', () => ({ readSourceFeedFromAdapter: adapterRead }));
  vi.doMock('./device-feed-read', async () => ({
    ...await vi.importActual('./device-feed-read'),
    readDeviceFeed: nativeRead,
  }));
  readSourceFeed = (await import('./connector-pushdown')).readSourceFeed;
});

afterAll(() => {
  vi.doUnmock('../db/client');
  vi.doUnmock('./source-feed-adapters');
  vi.doUnmock('./device-feed-read');
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  feed = {
    id: 1, feed_key: 'items', connection_id: 2, connector_key: 'synthetic.device_reader',
    device_worker_id: 'synthetic-device', device_owner_user_id: 'synthetic-owner',
    feed_status: 'active', feed_operations: ['read'], has_compiled_code: true,
    config: {}, connection_config: {}, runtime: { platforms: ['chrome-extension'] },
  };
  lookup.mockImplementation(async () => [feed]);
  adapterRead.mockResolvedValue({ rows: [{ id: 'row-1' }] });
  nativeRead.mockResolvedValue({ rows: [{ id: 'row-1' }] });
});

function read(chatAccess: ChatTurnAccess | null) {
  return readSourceFeed({
    feedId: 1, deadlineAt: Date.now() + 5000,
    scope: authzScopeFromToolContext({
      organizationId: 'synthetic-org',
      userId: chatAccess === 'member' ? 'synthetic-member' : null,
      sourceContext: chatAccess ? { chatAccess } : null,
    }),
  });
}

describe.each([true, false])('device feed with compiled code: %s', (hasCompiledCode) => {
  it.each(['org_shared', 'public_visitor', 'reply_only'] as const)(
    'refuses %s before executing a source reader', async (chatAccess) => {
      feed.has_compiled_code = hasCompiledCode;
      await expect(read(chatAccess)).rejects.toMatchObject({ code: 'PERMISSION' });
      expect(adapterRead).not.toHaveBeenCalled();
      expect(nativeRead).not.toHaveBeenCalled();
    },
  );

  it.each(['member', null] as const)('allows the %s caller', async (chatAccess) => {
    feed.has_compiled_code = hasCompiledCode;
    expect((await read(chatAccess)).rows).toEqual([{ id: 'row-1' }]);
  });
});

it('allows org-shared chat to read an unpinned cloud source', async () => {
  feed.device_worker_id = null;
  feed.runtime = null;
  expect((await read('org_shared')).rows).toEqual([{ id: 'row-1' }]);
});

it('also gates an unpinned native device source', async () => {
  feed.device_worker_id = null;
  feed.has_compiled_code = false;
  await expect(read('org_shared')).rejects.toMatchObject({ code: 'PERMISSION' });
  expect(nativeRead).not.toHaveBeenCalled();
});

it('refuses org-shared chat even when the read principal is the device owner', async () => {
  await expect(readSourceFeed({
    feedId: 1, deadlineAt: Date.now() + 5000,
    scope: { organizationId: 'synthetic-org', principal: 'synthetic-owner', chatAccess: 'org_shared' },
  })).rejects.toMatchObject({ code: 'PERMISSION' });
  expect(adapterRead).not.toHaveBeenCalled();
  expect(nativeRead).not.toHaveBeenCalled();
});
