import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync, type SyncRun } from './sync-harness';

let sleeps = 0;
mock.module('@lobu/connector-sdk', () => ({
  ...connectorSdkMock(),
  sleep: async () => {
    sleeps++;
  },
}));
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after the SDK mock
let GmailConnector: any;
beforeAll(async () => {
  GmailConnector = (await import('../google_gmail')).default;
});

const mailbox = 'mailbox@example.test';
const saved = (history = '100') => ({
  references: { version: 1, account: mailbox, history_id: history },
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
type Handler = (url: URL) => Response | Promise<Response>;
function fixture(handler?: Handler) {
  const calls: URL[] = [];
  const connector = new GmailConnector();
  connector.createClient = () => ({
    raw: async (raw: string) => {
      const url = new URL(raw);
      calls.push(url);
      if (!/\/users\/me\/(profile|messages|history)$/.test(url.pathname))
        throw new Error(`Reference capture must not request ${url.pathname}`);
      if (handler) return handler(url);
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '100' });
      if (url.pathname.endsWith('/messages'))
        return response({
          messages: [
            {
              id: 'abc',
              threadId: 'abc',
              subject: 'PRIVATE SUBJECT',
              snippet: 'PRIVATE SNIPPET',
              payload: { body: { data: 'PRIVATE BODY' } },
              labelIds: ['TRASH'],
            },
          ],
        });
      if (url.pathname.endsWith('/history'))
        return response({ historyId: '100' });
      throw new Error(`Unexpected ${url.pathname}`);
    },
  });
  const sync = (
    checkpoint: SyncRun['checkpoint'] = null,
    config: Record<string, unknown> = {},
  ) =>
    runSync(connector, {
      feedKey: 'message_references',
      config,
      checkpoint,
      credentials: { accessToken: 'placeholder' },
    });
  return { connector, calls, sync };
}

describe('Gmail reference ingestion', () => {
  test('is opt-in, sync-only and has no person attribution or automatic schedule', () => {
    const feed = new GmailConnector().definition.feeds.message_references;
    expect(feed.userManaged).toBe(true);
    expect(feed.observe).toBeUndefined();
    expect(feed.webhook).toBeUndefined();
    expect(feed.defaultSchedule).toBeUndefined();
    expect(feed.eventKinds.message_reference.attributions).toBeUndefined();
  });
  test('strictly projects minimal metadata and keeps the full-content thread origin separate', async () => {
    const { calls, sync } = fixture();
    const result = await sync();
    expect(result.status).toBe('complete');
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event.origin_id).not.toBe('abc');
    expect(event.origin_type).toBe('message_reference');
    expect(event.payload_text).toBe('');
    expect(event.entities).toBeUndefined();
    expect(event.metadata).toEqual({
      source_id: 'abc',
      thread_id: 'abc',
      source_occurred_at: null,
      timestamp_basis: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(calls.some((url) => /\/messages\//.test(url.pathname))).toBe(false);
    expect(result.events[0].title).toBeUndefined();
    expect(result.events[0].occurred_at).toEqual(new Date(0));
    expect(calls[0].pathname).toEndWith('/profile');
    expect(result.checkpoint?.references).toMatchObject({
      account: mailbox,
      history_id: '100',
    });
  });

  test('a full inventory page uses one list request and zero per-message requests or embedding inputs', async () => {
    const { sync, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '100' });
      if (url.pathname.endsWith('/messages'))
        return response({
          messages: Array.from({ length: 500 }, (_, i) => ({
            id: `m${i}`,
            threadId: `t${i}`,
            snippet: 'PRIVATE',
          })),
        });
      throw new Error('Baseline must not download individual messages');
    });
    const result = await sync(null, { max_results: 500 });
    expect(result.events).toHaveLength(500);
    expect(
      calls.filter((url) => url.pathname.endsWith('/messages')),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => /\/messages\//.test(url.pathname)),
    ).toHaveLength(0);
    expect(
      result.events.every((event) => !event.title && !event.payload_text),
    ).toBe(true);
    expect(
      result.events.every(
        (event) =>
          event.occurred_at?.getTime() === 0 &&
          event.metadata?.source_occurred_at === null &&
          event.metadata?.timestamp_basis === 'unknown',
      ),
    ).toBe(true);
  });

  test('history catches backdated mailbox additions without a received-time window', async () => {
    const { sync, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '201' });
      if (url.pathname.endsWith('/history'))
        return response({
          history: [
            {
              id: '200',
              messagesAdded: [{ message: { id: 'old', threadId: 'thread' } }],
            },
          ],
          historyId: '201',
        });
      throw new Error('History must not fall back to a timestamp search');
    });
    const result = await sync({
      references: { version: 1, account: mailbox, history_id: '100' },
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurred_at).toEqual(new Date(0));
    expect(result.events[0].metadata?.source_occurred_at).toBeNull();
    expect(result.checkpoint?.references).toMatchObject({ history_id: '201' });
    expect(
      calls
        .find((url) => url.pathname.endsWith('/history'))
        ?.searchParams.get('startHistoryId'),
    ).toBe('100');
  });

  test('a saved mailbox rejects a different OAuth account before source reads or commits', async () => {
    const { sync, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({
          emailAddress: 'different@example.test',
          historyId: '300',
        });
      throw new Error('Source must not be read under a different account');
    });
    await expect(
      sync({ references: { version: 1, account: mailbox, history_id: '100' } }),
    ).rejects.toThrow(/account/i);
    expect(calls).toHaveLength(1);
  });

  test('inventory continues across runs from its original baseline, then captures imports arriving during it', async () => {
    let head = '100';
    const { sync, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: head });
      if (url.pathname.endsWith('/messages')) {
        expect(url.searchParams.has('q')).toBe(false);
        if (!url.searchParams.has('pageToken')) {
          head = '201';
          return response({
            messages: [{ id: 'a', threadId: 'thread_a' }],
            nextPageToken: 'second',
          });
        }
        expect(url.searchParams.get('pageToken')).toBe('second');
        return response({ messages: [{ id: 'b', threadId: 'thread_b' }] });
      }
      if (url.pathname.endsWith('/history'))
        return response({
          history: [
            {
              id: '200',
              messagesAdded: [
                { message: { id: 'imported', threadId: 'thread_imported' } },
              ],
            },
          ],
          historyId: '201',
        });
      throw new Error(`Unexpected ${url.pathname}`);
    });
    const first = await sync(null, { max_results: 1 });
    expect(first.status).toBe('more');
    expect(first.checkpoint?.references).toMatchObject({
      history_id: '100',
      inventory: { page_token: 'second' },
    });
    const second = await sync(first.checkpoint, { max_results: 1 });
    expect(second.status).toBe('more');
    expect(second.checkpoint?.references).not.toHaveProperty('inventory');
    expect(second.checkpoint?.references).toMatchObject({ history_id: '100' });
    const third = await sync(second.checkpoint, { max_results: 1 });
    expect(third.status).toBe('complete');
    expect(
      [...first.events, ...second.events, ...third.events].map(
        (event) => event.metadata?.source_id,
      ),
    ).toEqual(['a', 'b', 'imported']);
    expect(
      calls
        .find((url) => url.pathname.endsWith('/history'))
        ?.searchParams.get('startHistoryId'),
    ).toBe('100');
  });

  test('one large record resumes by stable native key across reordering, duplicates and later arrivals', async () => {
    let reverse = false;
    const hugeStart = '900719925474099300000';
    const hugeRecord = '900719925474099300001';
    const nextRecord = '900719925474099300002';
    const { sync, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: nextRecord });
      if (url.pathname.endsWith('/history')) {
        expect(url.searchParams.get('maxResults')).toBe('1');
        expect(url.searchParams.get('historyTypes')).toBe('messageAdded');
        if (url.searchParams.get('startHistoryId') === hugeRecord)
          return response({
            history: [
              {
                id: nextRecord,
                messagesAdded: [{ message: { id: 'd', threadId: 'thread_d' } }],
              },
            ],
            historyId: nextRecord,
          });
        const ids = reverse ? ['c', 'b', 'a', 'a'] : ['a', 'c', 'b'];
        return response({
          history: [
            {
              id: hugeRecord,
              messagesAdded: ids.map((id) => ({
                message: { id, threadId: `thread_${id}` },
              })),
            },
          ],
          nextPageToken: 'later',
          historyId: nextRecord,
        });
      }
      throw new Error(`Unexpected ${url.pathname}`);
    });
    let checkpoint: SyncRun['checkpoint'] = saved(hugeStart);
    const ids: unknown[] = [];
    for (let run = 0; run < 4; run++) {
      const result = await sync(checkpoint, { max_results: 1 });
      ids.push(...result.events.map((event) => event.metadata?.source_id));
      checkpoint = result.checkpoint;
      reverse = true;
      expect(result.status).toBe(run === 3 ? 'complete' : 'more');
      if (run < 2)
        expect(checkpoint?.references).toMatchObject({
          history_id: hugeStart,
          partial: {
            record_id: hugeRecord,
            digest:
              '55ce5e93406b1912e3bafe2a765d9d5b2813b1ff2ef5a9f5cf3f0d8f1cbc6670',
          },
        });
    }
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
    expect(checkpoint?.references).toMatchObject({ history_id: nextRecord });
    expect(checkpoint?.references).not.toHaveProperty('partial');
    expect(
      calls.filter((url) => /\/messages\//.test(url.pathname)),
    ).toHaveLength(0);
  });

  for (const change of ['missing', 'changed'] as const)
    test(`a ${change} partial history anchor records a gap and restarts a bounded inventory`, async () => {
      let mutated = false;
      const { sync } = fixture((url) => {
        if (url.pathname.endsWith('/profile'))
          return response({ emailAddress: mailbox, historyId: '300' });
        if (url.pathname.endsWith('/history'))
          return response({
            history: [
              {
                id: mutated && change === 'missing' ? '201' : '200',
                messagesAdded: (mutated ? ['a', 'c'] : ['a', 'b']).map(
                  (id) => ({ message: { id, threadId: `thread_${id}` } }),
                ),
              },
            ],
            historyId: '300',
          });
        throw new Error(`Unexpected ${url.pathname}`);
      });
      const first = await sync(saved(), { max_results: 1 });
      mutated = true;
      const second = await sync(first.checkpoint, { max_results: 1 });
      expect(second.status).toBe('more');
      expect(second.events).toHaveLength(1);
      expect(second.events[0].origin_type).toBe('source_gap');
      expect(second.events[0].metadata?.reason).toBe(
        change === 'missing'
          ? 'history_anchor_missing'
          : 'history_anchor_changed',
      );
      expect(second.checkpoint?.references).toMatchObject({
        history_id: '300',
        inventory: {},
      });
      expect(second.checkpoint?.references).not.toHaveProperty('partial');
    });

  test('expired history records the discontinuity before recovery, and retains the recovery baseline through retired inventory cursors', async () => {
    let head = '300';
    let expiredInventory = false;
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: head });
      if (url.pathname.endsWith('/history')) {
        if (url.searchParams.get('startHistoryId') === '100')
          return response({}, 404);
        expect(url.searchParams.get('startHistoryId')).toBe('300');
        return response({ historyId: head });
      }
      if (url.pathname.endsWith('/messages')) {
        if (url.searchParams.has('pageToken'))
          return expiredInventory ? response({}, 404) : response({});
        return response({
          messages: [{ id: 'a', threadId: 'thread_a' }],
          nextPageToken: 'stale',
        });
      }
      throw new Error(`Unexpected ${url.pathname}`);
    });
    const gap = await sync(saved(), { max_results: 1 });
    expect(gap.events[0].metadata).toEqual({
      reason: 'history_expired',
      from_history_id: '100',
      to_history_id: '300',
      recovery: 'available_message_inventory',
      source_occurred_at: null,
      timestamp_basis: 'unknown',
    });
    const inventory = await sync(gap.checkpoint, { max_results: 1 });
    expiredInventory = true;
    head = '400';
    const restart = await sync(inventory.checkpoint, { max_results: 1 });
    expect(restart.status).toBe('more');
    expect(restart.checkpoint?.references).toMatchObject({
      history_id: '300',
      inventory: {},
    });
    expect(restart.checkpoint?.references).not.toHaveProperty(
      'inventory.page_token',
    );
    expiredInventory = false;
    const replay = await sync(restart.checkpoint, { max_results: 1 });
    expect(replay.events[0]).toEqual(inventory.events[0]);
    const completed = await sync(replay.checkpoint, { max_results: 1 });
    expect(completed.status).toBe('complete');
    expect(completed.checkpoint?.references).toMatchObject({
      history_id: '400',
    });
    expect(JSON.stringify(gap.events)).not.toContain('PRIVATE');
  });

  for (const status of [401, 403, 429, 500])
    test(`HTTP ${status} does not adopt a new history head or claim a gap`, async () => {
      let commits = 0;
      const { connector } = fixture((url) =>
        url.pathname.endsWith('/profile')
          ? response({ emailAddress: mailbox, historyId: '300' })
          : response({}, status),
      );
      await expect(
        runSync(connector, {
          feedKey: 'message_references',
          config: {},
          checkpoint: saved(),
          credentials: { accessToken: 'placeholder' },
          commit: async () => {
            commits++;
          },
        }),
      ).rejects.toThrow(`(${status})`);
      expect(commits).toBe(0);
    });

  test('account replacement during an asynchronous read rejects the whole fetched batch', async () => {
    let changed = false;
    let commits = 0;
    const { connector } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({
          emailAddress: changed ? 'replacement@example.test' : mailbox,
          historyId: '200',
        });
      changed = true;
      return response({
        history: [
          {
            id: '200',
            messagesAdded: [{ message: { id: 'a', threadId: 'thread_a' } }],
          },
        ],
        historyId: '200',
      });
    });
    await expect(
      runSync(connector, {
        feedKey: 'message_references',
        config: {},
        checkpoint: saved(),
        credentials: { accessToken: 'placeholder' },
        commit: async () => {
          commits++;
        },
      }),
    ).rejects.toThrow(/account changed/);
    expect(commits).toBe(0);
  });

  test('a rejected commit replays the same native reference on reconnect', async () => {
    const { connector, sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '200' });
      if (url.pathname.endsWith('/history'))
        return response({
          history: [
            {
              id: '200',
              messagesAdded: [{ message: { id: 'a', threadId: 'thread_a' } }],
            },
          ],
          historyId: '200',
        });
      throw new Error(`Unexpected ${url.pathname}`);
    });
    let attempted: unknown;
    await expect(
      runSync(connector, {
        feedKey: 'message_references',
        config: {},
        checkpoint: saved(),
        credentials: { accessToken: 'placeholder' },
        commit: async (events) => {
          attempted = events;
          throw new Error('commit interrupted');
        },
      }),
    ).rejects.toThrow('commit interrupted');
    const retry = await sync(saved());
    expect(retry.events).toEqual(attempted);
    expect(retry.checkpoint?.references).toMatchObject({ history_id: '200' });
  });

  test('empty continuation pages preserve the accepted history boundary and bounded cursor progress', async () => {
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '300' });
      expect(url.searchParams.get('startHistoryId')).toBe('100');
      return response({ historyId: '300', nextPageToken: 'unchanged' });
    });
    await expect(sync(saved())).rejects.toThrow(/cursor did not advance/);
  });

  test('empty history pages advance their own cursor without advancing the accepted history head', async () => {
    let observedCheckpoint: unknown;
    const { connector } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '300' });
      if (!url.searchParams.has('pageToken'))
        return response({ nextPageToken: 'empty-tail', historyId: '300' });
      expect(observedCheckpoint).toMatchObject({
        references: {
          ...saved().references,
          history_page: { token: 'empty-tail' },
        },
      });
      return response({ historyId: '300' });
    });
    const result = await runSync(connector, {
      feedKey: 'message_references',
      config: {},
      checkpoint: saved(),
      credentials: { accessToken: 'placeholder' },
      commit: async (_events, checkpoint) => {
        observedCheckpoint = checkpoint;
      },
    });
    expect(result.status).toBe('complete');
    expect(result.checkpoint?.references).toMatchObject({ history_id: '300' });
    expect(result.checkpoint?.references).not.toHaveProperty('history_page');
  });

  for (const status of [400, 404])
    test(`a retired history page token (${status}) retries the saved boundary before declaring a gap`, async () => {
      const { sync } = fixture((url) => {
        if (url.pathname.endsWith('/profile'))
          return response({ emailAddress: mailbox, historyId: '300' });
        if (url.pathname.endsWith('/history')) {
          expect(url.searchParams.get('startHistoryId')).toBe('100');
          if (url.searchParams.has('pageToken')) return response({}, status);
          return response({
            history: [
              {
                id: '200',
                messagesAdded: [{ message: { id: 'a', threadId: 'thread_a' } }],
              },
            ],
            historyId: '300',
          });
        }
        throw new Error('A retired page token must not start a new inventory');
      });
      const restart = await sync({
        references: {
          ...saved().references,
          history_page: { token: 'retired' },
        },
      });
      expect(restart.status).toBe('more');
      expect(restart.events).toHaveLength(0);
      expect(restart.checkpoint?.references).toEqual(saved().references);
      const result = await sync(restart.checkpoint);
      expect(result.events.map((event) => event.metadata?.source_id)).toEqual([
        'a',
      ]);
      expect(result.checkpoint?.references).toMatchObject({
        history_id: '300',
      });
    });

  test('a partial record survives a retired page token and empty pages while finding its anchor again', async () => {
    let retired = false;
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '300' });
      if (url.pathname.endsWith('/history')) {
        expect(url.searchParams.get('startHistoryId')).toBe('100');
        const token = url.searchParams.get('pageToken');
        if (!token)
          return response({
            nextPageToken: retired ? 'fresh' : 'old',
            historyId: '300',
          });
        if (token === 'old' && retired) return response({}, 400);
        return response({
          history: [
            {
              id: '200',
              messagesAdded: ['a', 'b'].map((id) => ({
                message: { id, threadId: `thread_${id}` },
              })),
            },
          ],
          historyId: '300',
        });
      }
      throw new Error(
        'A retired page token must not discard a partial history record',
      );
    });
    const first = await sync(saved(), { max_results: 1 });
    expect(first.events.map((event) => event.metadata?.source_id)).toEqual([
      'a',
    ]);
    retired = true;
    const restart = await sync(first.checkpoint, { max_results: 1 });
    expect(restart.events).toHaveLength(0);
    expect(restart.checkpoint?.references).toMatchObject({
      history_id: '100',
      partial: { record_id: '200', after_message_id: 'a' },
    });
    const result = await sync(restart.checkpoint, { max_results: 1 });
    expect(result.status).toBe('complete');
    expect(result.events.map((event) => event.metadata?.source_id)).toEqual([
      'b',
    ]);
    expect(result.checkpoint?.references).toEqual({
      ...saved().references,
      history_id: '300',
    });
  });

  test('history expiry is still recorded when replay without the page token also fails', async () => {
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '300' });
      expect(url.pathname).toEndWith('/history');
      expect(url.searchParams.get('startHistoryId')).toBe('100');
      return response({}, 404);
    });
    const restart = await sync({
      references: {
        ...saved().references,
        history_page: { token: 'retired' },
      },
    });
    expect(restart.events).toHaveLength(0);
    const result = await sync(restart.checkpoint);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata).toEqual({
      reason: 'history_expired',
      from_history_id: '100',
      to_history_id: '300',
      recovery: 'available_message_inventory',
      source_occurred_at: null,
      timestamp_basis: 'unknown',
    });
    expect(result.checkpoint?.references).toMatchObject({
      history_id: '300',
      inventory: {},
    });
  });

  test('initial empty inventory continuation is resumable and a repeated inventory token fails visibly', async () => {
    let checkpoint: unknown;
    const { connector } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '100' });
      if (url.pathname.endsWith('/messages')) {
        if (url.searchParams.has('pageToken'))
          expect(checkpoint).toMatchObject({
            references: {
              history_id: '100',
              inventory: { page_token: 'empty' },
            },
          });
        return response({ nextPageToken: 'empty' });
      }
      throw new Error('Incomplete inventory must not run history');
    });
    await expect(
      runSync(connector, {
        feedKey: 'message_references',
        config: {},
        checkpoint: null,
        credentials: { accessToken: 'placeholder' },
        commit: async (_events, next) => {
          checkpoint = next;
        },
      }),
    ).rejects.toThrow(/cursor did not advance/);
    expect(checkpoint).toMatchObject({
      references: { history_id: '100', inventory: { page_token: 'empty' } },
    });
  });

  test('a history record without additions makes bounded progress without completing unvisited records', async () => {
    const { sync, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '1000' });
      const start = BigInt(url.searchParams.get('startHistoryId')!);
      return response({
        history: [{ id: String(start + 1n) }],
        historyId: '1000',
        nextPageToken: 'remaining',
      });
    });
    const result = await sync(saved());
    expect(result.status).toBe('more');
    expect(result.checkpoint?.references).toMatchObject({ history_id: '120' });
    expect(
      calls.filter((url) => url.pathname.endsWith('/history')),
    ).toHaveLength(20);
  });

  test('repeated expiry creates another honest gap instead of claiming inventory restored missing history', async () => {
    let head = '200';
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: head });
      if (url.pathname.endsWith('/messages')) return response({});
      return response({}, 404);
    });
    const first = await sync(saved());
    head = '300';
    const second = await sync(first.checkpoint);
    expect(second.status).toBe('more');
    expect(second.events[0].metadata).toMatchObject({
      reason: 'history_expired',
      from_history_id: '200',
      to_history_id: '300',
    });
    expect(second.events[0].origin_id).not.toBe(first.events[0].origin_id);
    expect(second.checkpoint?.references).toMatchObject({
      history_id: '300',
      inventory: {},
    });
  });

  for (const maximum of [0, -1, 501, 1.5])
    test(`invalid budget ${maximum} fails before accessing Gmail`, async () => {
      const { sync, calls } = fixture();
      await expect(sync(saved(), { max_results: maximum })).rejects.toThrow(
        /max_results/,
      );
      expect(calls).toHaveLength(0);
    });
  test('273175 inventory references scale by pages without downloading or embedding email', async () => {
    const total = 273175;
    let observed = 0;
    const startingSleeps = sleeps;
    const { sync, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '100' });
      if (url.pathname.endsWith('/history'))
        return response({ historyId: '100' });
      expect(url.pathname).toEndWith('/messages');
      expect(url.searchParams.get('fields')).toBe(
        'messages(id,threadId),nextPageToken',
      );
      expect(url.searchParams.get('includeSpamTrash')).toBe('true');
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const count = Math.min(
        Number(url.searchParams.get('maxResults')),
        total - offset,
      );
      return response({
        messages: Array.from({ length: count }, (_, i) => ({
          id: `m${offset + i}`,
          threadId: `t${offset + i}`,
        })),
        ...(offset + count < total
          ? { nextPageToken: String(offset + count) }
          : {}),
      });
    });
    let checkpoint: SyncRun['checkpoint'] = null;
    for (let run = 0; run < Math.ceil(total / 500); run++) {
      const result = await sync(checkpoint);
      observed += result.events.length;
      checkpoint = result.checkpoint;
      expect(result.events.length).toBeLessThanOrEqual(500);
      expect(
        result.events.every(
          (event) =>
            !event.title &&
            !event.payload_text &&
            event.occurred_at?.getTime() === 0 &&
            event.metadata?.source_occurred_at === null,
        ),
      ).toBe(true);
      expect(result.status).toBe(
        run === Math.ceil(total / 500) - 1 ? 'complete' : 'more',
      );
    }
    expect(observed).toBe(total);
    expect(
      calls.filter((url) => url.pathname.endsWith('/messages')),
    ).toHaveLength(Math.ceil(total / 500));
    expect(
      calls.filter((url) => /\/messages\//.test(url.pathname)),
    ).toHaveLength(0);
    expect(
      calls.filter((url) => url.pathname.endsWith('/profile')).length,
    ).toBeLessThanOrEqual(2 * Math.ceil(total / 500) + 2);
    expect(sleeps).toBe(startingSleeps);
    expect(checkpoint?.references).toEqual({
      version: 1,
      account: mailbox,
      history_id: '100',
    });
  });

  test('a later policy rejection preserves only the accepted chunk and resumes from that chunk', async () => {
    let accepted: SyncRun['checkpoint'] = null;
    let commits = 0;
    let block = true;
    const { connector, sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '100' });
      if (url.pathname.endsWith('/history'))
        return response({ historyId: '100' });
      const second = url.searchParams.get('pageToken') === 'second';
      return response({
        messages: [{ id: second ? 'b' : 'a', threadId: second ? 'tb' : 'ta' }],
        ...(second ? {} : { nextPageToken: 'second' }),
      });
    });
    await expect(
      runSync(connector, {
        feedKey: 'message_references',
        config: {},
        checkpoint: null,
        credentials: { accessToken: 'placeholder' },
        commit: async (_events, next) => {
          commits++;
          if (block && commits === 3)
            throw new Error('policy now blocks this chunk');
          accepted = next;
        },
      }),
    ).rejects.toThrow('policy now blocks this chunk');
    expect(accepted).toMatchObject({
      references: { history_id: '100', inventory: { page_token: 'second' } },
    });
    block = false;
    const replay = await sync(accepted);
    expect(replay.events.map((event) => event.metadata?.source_id)).toEqual([
      'b',
    ]);
    expect(replay.status).toBe('complete');
  });

  for (const malformed of [
    { id: 'a' },
    { id: '../private', threadId: 'thread' },
    { id: 'a', threadId: '' },
  ])
    test(`malformed native stub cannot advance a history checkpoint: ${JSON.stringify(malformed)}`, async () => {
      let commits = 0;
      const { connector } = fixture((url) =>
        url.pathname.endsWith('/profile')
          ? response({ emailAddress: mailbox, historyId: '200' })
          : response({
              history: [{ id: '200', messagesAdded: [{ message: malformed }] }],
              historyId: '200',
            }),
      );
      await expect(
        runSync(connector, {
          feedKey: 'message_references',
          config: {},
          checkpoint: saved(),
          credentials: { accessToken: 'placeholder' },
          commit: async () => {
            commits++;
          },
        }),
      ).rejects.toThrow(/invalid message identity/);
      expect(commits).toBe(0);
    });

  for (const record of [
    null,
    false,
    0,
    '',
    { id: 'invalid' },
    { id: '100' },
    { id: '301' },
  ])
    test(`malformed history record cannot advance or reset the accepted boundary: ${JSON.stringify(record)}`, async () => {
      const { connector } = fixture((url) =>
        url.pathname.endsWith('/profile')
          ? response({ emailAddress: mailbox, historyId: '300' })
          : response({ history: [record], historyId: '300' }),
      );
      for (const partial of [
        undefined,
        { record_id: '200', after_message_id: 'a', digest: 'saved-digest' },
      ]) {
        let commits = 0;
        await expect(
          runSync(connector, {
            feedKey: 'message_references',
            config: {},
            checkpoint: { references: { ...saved().references, partial } },
            credentials: { accessToken: 'placeholder' },
            commit: async () => {
              commits++;
            },
          }),
        ).rejects.toThrow(/invalid history (identity|boundary)/);
        expect(commits).toBe(0);
      }
    });

  test('native IDs are scoped to account while unchanged inventory/history replay has identical event bytes', async () => {
    let account = mailbox;
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: account, historyId: '200' });
      if (url.pathname.endsWith('/messages'))
        return response({ messages: [{ id: 'a', threadId: 'thread_a' }] });
      return response({
        history:
          url.searchParams.get('startHistoryId') === '100'
            ? [
                {
                  id: '200',
                  messagesAdded: [
                    {
                      message: {
                        id: 'a',
                        threadId: 'thread_a',
                        labelIds: ['TRASH'],
                        snippet: 'PRIVATE',
                        payload: { body: 'PRIVATE' },
                      },
                    },
                  ],
                },
              ]
            : [],
        historyId: '200',
      });
    });
    const inventory = await sync();
    const history = await sync(saved());
    expect(inventory.events).toEqual(history.events);
    expect(JSON.stringify(history.events)).not.toContain('PRIVATE');
    account = 'other@example.test';
    const other = await sync();
    expect(other.events[0].origin_id).not.toBe(inventory.events[0].origin_id);
    expect(other.events[0].metadata?.source_id).toBe('a');
  });

  test('a deleted or label-only change does not invent an addition or rewrite the retained observation', async () => {
    const { sync } = fixture((url) =>
      url.pathname.endsWith('/profile')
        ? response({ emailAddress: mailbox, historyId: '200' })
        : response({
            history: [
              {
                id: '200',
                messagesDeleted: [{ message: { id: 'a', threadId: 't' } }],
                labelsRemoved: [
                  { message: { id: 'b', threadId: 'u' }, labelIds: ['INBOX'] },
                ],
              },
            ],
            historyId: '200',
          }),
    );
    const result = await sync(saved());
    expect(result.events).toHaveLength(0);
    expect(result.checkpoint?.references).toMatchObject({ history_id: '200' });
    expect(result.status).toBe('complete');
  });

  for (const malformed of [
    { messages: {} },
    {
      messages: [
        { id: 'a', threadId: 'ta' },
        { id: 'a', threadId: 'tb' },
      ],
    },
    { messages: [], nextPageToken: 12 },
    { messages: [], nextPageToken: '' },
  ])
    test(`invalid inventory shape cannot move an accepted cursor: ${JSON.stringify(malformed)}`, async () => {
      let commits = 0;
      const { connector } = fixture((url) =>
        url.pathname.endsWith('/profile')
          ? response({ emailAddress: mailbox, historyId: '100' })
          : response(malformed),
      );
      await expect(
        runSync(connector, {
          feedKey: 'message_references',
          config: {},
          checkpoint: { references: { ...saved().references, inventory: {} } },
          credentials: { accessToken: 'placeholder' },
          commit: async () => {
            commits++;
          },
        }),
      ).rejects.toThrow(/invalid|conflicts/);
      expect(commits).toBe(0);
    });

  test('overlapping inventory entries retain the same reference without a second message identity', async () => {
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '100' });
      if (url.pathname.endsWith('/messages'))
        return response({
          messages: [
            { id: 'a', threadId: 't' },
            { id: 'a', threadId: 't' },
          ],
        });
      return response({ historyId: '100' });
    });
    const result = await sync();
    expect(result.events).toHaveLength(1);
    expect(result.status).toBe('complete');
  });
  test('inventory follows 25 advancing empty pages across its request budget before accepting a message', async () => {
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '100' });
      if (url.pathname.endsWith('/history'))
        return response({ historyId: '100' });
      const page = Number((url.searchParams.get('pageToken') ?? 'i0').slice(1));
      return response(
        page < 25
          ? { nextPageToken: `i${page + 1}` }
          : { messages: [{ id: 'a', threadId: 'ta' }] },
      );
    });
    const first = await sync();
    expect(first.status).toBe('more');
    expect(first.events).toHaveLength(0);
    expect(first.checkpoint?.references).toMatchObject({
      history_id: '100',
      inventory: { page_token: 'i20' },
    });
    expect(JSON.stringify(first.checkpoint)).not.toContain('i11');
    const second = await sync(first.checkpoint);
    expect(second.status).toBe('complete');
    expect(second.events.map((event) => event.metadata?.source_id)).toEqual([
      'a',
    ]);
  });

  test('a partial record survives 25 advancing empty history pages and request-budget resume', async () => {
    let emptyPages = false;
    const { sync } = fixture((url) => {
      if (url.pathname.endsWith('/profile'))
        return response({ emailAddress: mailbox, historyId: '300' });
      const page = Number((url.searchParams.get('pageToken') ?? 'h0').slice(1));
      if (emptyPages && page < 25)
        return response({ nextPageToken: `h${page + 1}`, historyId: '300' });
      return response({
        history: [
          {
            id: '200',
            messagesAdded: ['a', 'b'].map((id) => ({
              message: { id, threadId: `t${id}` },
            })),
          },
        ],
        historyId: '300',
      });
    });
    const partial = await sync(saved(), { max_results: 1 });
    expect(partial.events.map((event) => event.metadata?.source_id)).toEqual([
      'a',
    ]);
    emptyPages = true;
    const first = await sync(partial.checkpoint, { max_results: 1 });
    expect(first.status).toBe('more');
    expect(first.events).toHaveLength(0);
    expect(first.checkpoint?.references).toMatchObject({
      history_id: '100',
      partial: { after_message_id: 'a' },
      history_page: { token: 'h20' },
    });
    expect(JSON.stringify(first.checkpoint)).not.toContain('h11');
    const second = await sync(first.checkpoint, { max_results: 1 });
    expect(second.status).toBe('complete');
    expect(second.events.map((event) => event.metadata?.source_id)).toEqual([
      'b',
    ]);
    expect(second.checkpoint?.references).toEqual({
      ...saved().references,
      history_id: '300',
    });
  });

  for (const plane of ['inventory', 'history'])
    test(`a real advancing-then-repeated ${plane} cursor cycle fails without accepting the cyclic page`, async () => {
      const { sync } = fixture((url) => {
        if (url.pathname.endsWith('/profile'))
          return response({ emailAddress: mailbox, historyId: '300' });
        const token = url.searchParams.get('pageToken');
        return response({
          historyId: '300',
          nextPageToken: token === 'a' ? 'b' : 'a',
        });
      });
      await expect(sync(plane === 'history' ? saved() : null)).rejects.toThrow(
        /cursor did not advance/,
      );
    });
});
