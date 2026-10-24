import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: import after the shared SDK mock
let RedditConnector: any;
beforeAll(async () => { RedditConnector = (await import('../reddit')).default; });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function item(id: string, kind = 't1') {
  return { kind, data: { name: `${kind}_${id}`, id, author: 'synthetic-author',
    subject: 'comment reply', body: 'Private source body', created_utc: 1_700_000_000,
    context: `/r/example/comments/post/title/${id}/?context=3`, new: true } };
}
const options = { feedKey: 'inbox', config: {}, credentials: { accessToken: 'synthetic-token' }, checkpoint: null };

describe('Reddit inbox source', () => {
  test('captures metadata-only inbox references without marking messages read', async () => {
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(new URL(input.toString()));
      return Response.json({ data: { children: [item('reply'), item('private', 't4')], after: null } });
    }) as typeof fetch;
    const result = await runSync(new RedditConnector(), options);
    expect(urls[0].origin).toBe('https://oauth.reddit.com');
    expect(urls[0].pathname).toBe('/message/inbox');
    expect(urls[0].searchParams.get('mark')).toBe('false');
    expect(result.events.map(x => x.origin_id)).toEqual(['reddit_inbox_t1_reply', 'reddit_inbox_t4_private']);
    expect(result.events.every(x => x.origin_type === 'inbox_notification')).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain('Private source body');
    expect(result.events[0].metadata).toMatchObject({ source_id: 't1_reply', category: 'comment_notification' });
    expect(new RedditConnector().definition.feeds.inbox.requiredScopes).toEqual(['privatemessages']);
    // Only method scopes are requested at connect/reconnect; a feed-only scope is unreachable.
    expect(new RedditConnector().definition.authSchema.methods[0].optionalScopes).toContain('privatemessages');
  });

  test('keeps the cursor through an empty page and emits each identity once', async () => {
    const after: Array<string | null> = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const cursor = new URL(input.toString()).searchParams.get('after');
      after.push(cursor);
      return Response.json({ data: cursor === null ? { children: [item('one')], after: 't1_one' }
        : cursor === 't1_one' ? { children: [], after: 't1_empty' }
        : { children: [item('one'), item('two')], after: null } });
    }) as typeof fetch;
    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    const result = await runSync(connector, options);
    expect(after).toEqual([null, 't1_one', 't1_empty']);
    expect(result.events.map(x => x.origin_id)).toEqual(['reddit_inbox_t1_one', 'reddit_inbox_t1_two']);
    expect(result.status).toBe('complete');
  });

  test('returns full bodies only on explicit source reads and preserves continuation', async () => {
    globalThis.fetch = (async () => Response.json({ data: { children: [item('one')], after: 't1_one' } })) as typeof fetch;
    const result = await new RedditConnector().read({ ...options, limit: 1 });
    expect(result.rows[0]).toMatchObject({ id: 't1_one', body: 'Private source body' });
    expect(result.nextCursor).toBe('t1_one');
  });

  test('resumes a capped history sweep while also collecting newly arrived inbox items', async () => {
    const items = Array.from({ length: 14 }, (_, index) => item(`item${index}`));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const cursor = new URL(input.toString()).searchParams.get('after');
      const start = cursor ? items.findIndex(x => x.data.name === cursor) + 1 : 0;
      const children = items.slice(start, start + 2);
      return Response.json({ data: { children,
        after: start + children.length < items.length ? children.at(-1)?.data.name : null } });
    }) as typeof fetch;
    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    connector.MAX_PAGES = 3;
    const first = await runSync(connector, options);
    expect(first.status).toBe('more');
    expect(first.checkpoint?.pagination_token).toBe('t1_item5');
    items.unshift(item('arrived'));
    const second = await runSync(connector, { ...options, checkpoint: first.checkpoint });
    expect(second.events.map(x => x.origin_id)).toContain('reddit_inbox_t1_arrived');
    expect(second.checkpoint?.pagination_token).toBe('t1_item9');
    const third = await runSync(connector, { ...options, checkpoint: second.checkpoint });
    expect(third.status).toBe('complete');
    expect(third.checkpoint?.pagination_token).toBeNull();
    expect(third.events.map(x => x.origin_id)).toContain('reddit_inbox_t1_item13');
    const replay = await runSync(connector, options);
    expect(replay.events[0]).toEqual(second.events[0]);
  });

  test('rejects a cursor loop without committing or acknowledging the unread tail', async () => {
    globalThis.fetch = (async () => Response.json({ data: { children: [item('one')], after: 't1_one' } })) as typeof fetch;
    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    let commits = 0;
    await expect(runSync(connector, { ...options, commit: async () => { commits++; } })).rejects.toThrow(/cursor did not advance/);
    expect(commits).toBe(0);
  });

  test.each([{}, { data: { children: [], after: 3 } }, { data: { children: [{ kind: 't1', data: { name: 't4_other', created_utc: 1 } }], after: null } }])(
    'rejects malformed source responses instead of completing with missing identities', async body => {
      globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
      await expect(runSync(new RedditConnector(), options)).rejects.toThrow(/invalid inbox/);
    },
  );

  test('requires user authorization before any source request', async () => {
    let requested = false;
    globalThis.fetch = (async () => { requested = true; throw new Error('unexpected request'); }) as typeof fetch;
    await expect(runSync(new RedditConnector(), { ...options, credentials: null })).rejects.toThrow(/OAuth/);
    expect(requested).toBe(false);
  });

  test.each([400, 404])('restarts a retired saved anchor on HTTP %s without discarding arrivals', async status => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const cursor = new URL(input.toString()).searchParams.get('after');
      if (cursor === 't1_retired') return new Response('retired anchor', { status });
      return Response.json({ data: cursor === null ? { children: [item('new')], after: 't1_new' }
        : { children: [item('older')], after: null } });
    }) as typeof fetch;
    const connector = new RedditConnector();
    connector.RATE_LIMIT_MS = 0;
    const result = await runSync(connector, { ...options, checkpoint: { pagination_token: 't1_retired' } });
    expect(result.status).toBe('complete');
    expect(result.metadata?.cursor_reset).toBe(true);
    expect(result.events.map(x => x.origin_id)).toEqual(['reddit_inbox_t1_new', 'reddit_inbox_t1_older']);
  });

  test.each([401, 403, 429, 500])('preserves an HTTP %s failure instead of completing a scan', async status => {
    globalThis.fetch = (async () => new Response('source unavailable', { status })) as typeof fetch;
    let commits = 0;
    await expect(runSync(new RedditConnector(), { ...options, commit: async () => { commits++; } })).rejects.toThrow();
    expect(commits).toBe(0);
  });
});
