import { afterEach, beforeAll, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', connectorSdkMock);

let GitHubConnector: typeof import('../github').default;
beforeAll(async () => {
  GitHubConnector = (await import('../github')).default;
});
afterEach(() => setSystemTime());

const SINCE = '2026-09-01T00:00:00.000Z';
const START = '2026-09-28T00:00:00.000Z';
const LATER = '2026-09-28T01:00:00.000Z';
const CONFIG = { repo_owner: 'test-owner', repo_name: 'test-repo' };

function commit(id: number, date = '2026-09-20T00:00:00.000Z') {
  return {
    sha: id.toString(16).padStart(40, '0'),
    commit: {
      message: `Test commit ${id}`,
      author: { name: 'Test author', date },
      committer: { date },
    },
  };
}

function provider(count: number) {
  const connector = new GitHubConnector();
  const calls: URL[] = [];
  let history = Array.from({ length: count }, (_, i) => commit(count - i));
  const snapshots = new Map<string, typeof history>();
  const initial = [...history];
  const setHistory = (commits: typeof history) => {
    history = commits;
    if (commits[0]) snapshots.set(commits[0].sha, [...commits]);
  };
  setHistory(history);
  let intercept: ((url: URL) => unknown) | undefined;
  // Model the provider's immutable commit graph selected by sha, with a moving
  // default branch. Date ties intentionally span more than the entire budget.
  Object.assign(connector, {
    requestJson: async ({ url: rawUrl }: { url: string }) => {
      const url = new URL(rawUrl);
      calls.push(url);
      const intercepted = intercept?.(url);
      if (intercepted !== undefined) return intercepted;
      const sha = url.searchParams.get('sha');
      const source = sha ? snapshots.get(sha) : history;
      if (!source) throw new Error('Unknown snapshot');
      const since = url.searchParams.get('since');
      const until = url.searchParams.get('until');
      const filtered = source.filter((item) => {
        const date = item.commit.committer.date;
        return (!since || date >= since) && (!until || date <= until);
      });
      const size = Number(url.searchParams.get('per_page') ?? 30);
      const offset = (Number(url.searchParams.get('page') ?? 1) - 1) * size;
      return filtered.slice(offset, offset + size);
    },
  });
  return {
    connector, calls, initial, setHistory,
    intercept: (handler: typeof intercept) => { intercept = handler; },
  };
}

function sync(connector: InstanceType<typeof GitHubConnector>, checkpoint: Record<string, unknown> | null) {
  return runSync(connector, {
    config: CONFIG,
    feedKey: 'commits',
    checkpoint,
    credentials: { provider: 'github', accessToken: 'test-token' },
    entityIds: [],
  });
}

describe('GitHub commits pagination', () => {
  test('recovers a backlog beyond 30 pages across bounded runs', async () => {
    setSystemTime(new Date(START));
    const api = provider(3101);
    const first = await sync(api.connector, { last_sync_at: SINCE });
    const firstCalls = api.calls.length;
    setSystemTime(new Date(LATER));
    const second = await sync(api.connector, JSON.parse(JSON.stringify(first.checkpoint)));
    const ids = new Set([...first.events, ...second.events].map((event) => event.origin_id));

    expect(ids.size).toBe(3101);
    expect(first.status).toBe('more');
    expect(first.checkpoint?.last_sync_at).toBe(SINCE);
    expect(first.events).toHaveLength(3000);
    expect(firstCalls).toBeLessThanOrEqual(31); // 30 pages plus resolving the head
    expect(second.status).toBe('complete');
    expect(second.checkpoint?.last_sync_at).toBe(START);
    expect(second.checkpoint?.commits).toBeUndefined();
  });

  test('pins the graph while the default branch changes within and between runs', async () => {
    setSystemTime(new Date(START));
    const api = provider(3101);
    const next = commit(4000, '2026-09-28T00:30:00.000Z');
    api.intercept((url) => {
      if (url.searchParams.get('page') === '2') {
        // A force push removes 200 entries, shifting every subsequent offset.
        // Those entries remain readable through the original immutable SHA.
        api.setHistory([next, ...api.initial.slice(200)]);
      }
    });
    const first = await sync(api.connector, { last_sync_at: SINCE });
    setSystemTime(new Date(LATER));
    const second = await sync(api.connector, first.checkpoint);
    const ids = new Set([...first.events, ...second.events].map((event) => event.origin_id));

    for (const item of api.initial) {
      expect(ids.has(`commit_test-owner_test-repo_${item.sha}`)).toBe(true);
    }
    expect(first.status).toBe('more');
    expect(second.status).toBe('complete');
    const third = await sync(api.connector, second.checkpoint);
    expect(third.events.map((event) => event.metadata?.sha)).toContain(next.sha);
  });

  test('a full final budget page is not proof of completion', async () => {
    setSystemTime(new Date(START));
    const api = provider(3000);
    const first = await sync(api.connector, { last_sync_at: SINCE });
    expect(first.status).toBe('more');
    expect(first.checkpoint?.last_sync_at).toBe(SINCE);
    const second = await sync(api.connector, first.checkpoint);
    expect(second.events).toHaveLength(0);
    expect(second.status).toBe('complete');
    expect(second.checkpoint?.last_sync_at).toBe(START);
  });

  test('cold backfills keep their original lookback across resumed runs', async () => {
    setSystemTime(new Date(START));
    const api = provider(3101);
    const first = await sync(api.connector, null);
    expect(first.status).toBe('more');
    expect(first.checkpoint?.last_sync_at).toBeUndefined();
    const since = api.calls.find((url) => url.searchParams.has('since'))?.searchParams.get('since');
    api.calls.length = 0;
    setSystemTime(new Date('2027-10-01T00:00:00.000Z'));
    const second = await sync(api.connector, first.checkpoint);
    expect(second.events).toHaveLength(101);
    expect(api.calls[0].searchParams.get('since')).toBe(since);
    expect(second.checkpoint?.last_sync_at).toBe(START);
  });

  test('an indeterminate page does not complete or skip its offset', async () => {
    setSystemTime(new Date(START));
    const api = provider(201);
    api.intercept((url) => url.searchParams.get('page') === '2' ? null : undefined);
    const first = await sync(api.connector, { last_sync_at: SINCE });
    expect(first.status).toBe('more');
    expect(first.checkpoint?.last_sync_at).toBe(SINCE);
    expect(first.events).toHaveLength(100);
    api.intercept(undefined);
    const second = await sync(api.connector, first.checkpoint);
    expect(new Set([...first.events, ...second.events].map((event) => event.origin_id)).size).toBe(201);
    expect(second.status).toBe('complete');
  });

  test('a failed resumed request leaves the persisted checkpoint retryable', async () => {
    setSystemTime(new Date(START));
    const api = provider(3101);
    const first = await sync(api.connector, { last_sync_at: SINCE });
    const saved = JSON.stringify(first.checkpoint);
    api.intercept(() => { throw new Error('Provider unavailable'); });
    await expect(sync(api.connector, first.checkpoint)).rejects.toThrow('Provider unavailable');
    expect(JSON.stringify(first.checkpoint)).toBe(saved);
    api.intercept(undefined);
    const retry = await sync(api.connector, first.checkpoint);
    expect(retry.events).toHaveLength(101);
    expect(retry.status).toBe('complete');
  });

  for (const body of [null, undefined, {}, [{}]]) {
    test(`an invalid head response (${JSON.stringify(body)}) is not completion`, async () => {
      const connector = new GitHubConnector();
      Object.assign(connector, { requestJson: async () => body });
      const result = await sync(connector, { last_sync_at: SINCE });
      expect(result.status).toBe('more');
      expect(result.events).toHaveLength(0);
      expect(result.checkpoint?.last_sync_at).toBe(SINCE);
    });
  }

  test('a confirmed empty list completes at the start watermark', async () => {
    setSystemTime(new Date(START));
    const api = provider(0);
    const result = await sync(api.connector, { last_sync_at: SINCE });
    expect(result.status).toBe('complete');
    expect(result.events).toHaveLength(0);
    expect(result.checkpoint?.last_sync_at).toBe(START);
  });
});
