import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', connectorSdkMock);
// biome-ignore lint/suspicious/noExplicitAny: connector loaded after SDK mock
let GitHubConnector: any;
beforeAll(async () => { GitHubConnector = (await import('../github')).default; });

const ctx = { config: { repo_owner: 'synthetic', repo_name: 'pagination' }, credentials: { accessToken: 'test-token' } };
const old = '2026-01-01T00:00:00.000Z';
const item = (id: number, pr = false) => ({
  id, number: id, title: `Item ${id}`, body: `Body ${id}`,
  created_at: old, updated_at: old, user: { login: 'synthetic-user', id: 1 },
  ...(pr ? { pull_request: {} } : {}),
});

describe('GitHub bounded feed traversal', () => {
  test.each(['issues', 'pull_requests', 'issue_comments', 'pr_comments'])(
    '%s resumes all pages before advancing its watermark', async feedKey => {
      const connector = new GitHubConnector();
      const calls: URL[] = [];
      connector.requestJson = async ({ url }: { url: string }) => {
        const u = new URL(url); calls.push(u);
        return u.searchParams.get('page') === '2'
          ? [item(101, feedKey === 'pull_requests')]
          : Array.from({ length: 100 }, (_, i) => item(i + 1, feedKey === 'pull_requests'));
      };
      const first = await runSync(connector, { ...ctx, feedKey, checkpoint: { last_sync_at: old } });
      expect(first.status).toBe('more');
      expect(first.events).toHaveLength(100);
      expect(first.checkpoint.last_sync_at).toBe(old);
      const second = await runSync(connector, { ...ctx, feedKey, checkpoint: first.checkpoint });
      expect(second.status).toBe('complete');
      expect(second.events).toHaveLength(1);
      expect(second.checkpoint.last_sync_at).toBe(first.checkpoint.content.started_at);
      expect(calls.map(u => u.searchParams.get('page'))).toEqual(['1', '2']);
      expect(calls.map(u => u.searchParams.get('since'))).toEqual([old, old]);
      expect(calls[0].searchParams.get('sort')).toBe('created');
      expect(calls[0].searchParams.get('direction')).toBe('asc');
    }
  );

  test('a filtered full issue page still continues to its PR tail', async () => {
    const connector = new GitHubConnector();
    connector.requestJson = async ({ url }: { url: string }) => new URL(url).searchParams.get('page') === '2'
      ? [item(101, true)] : Array.from({ length: 100 }, (_, i) => item(i));
    const first = await runSync(connector, { ...ctx, feedKey: 'pull_requests', checkpoint: null });
    expect(first.events).toHaveLength(0);
    expect(first.status).toBe('more');
    const second = await runSync(connector, { ...ctx, feedKey: 'pull_requests', checkpoint: first.checkpoint });
    expect(second.events.map(e => e.origin_id)).toEqual(['pr_synthetic_pagination_101']);
    expect(second.events[0].automation_signals).toBeUndefined();
  });

  test('an indeterminate REST body cannot advance the completed watermark', async () => {
    const connector = new GitHubConnector();
    connector.requestJson = async () => null;
    const result = await runSync(connector, { ...ctx, feedKey: 'issues', checkpoint: { last_sync_at: old } });
    expect(result.status).toBe('more');
    expect(result.checkpoint.last_sync_at).toBe(old);
  });

  test('discussions use their native continuation', async () => {
    const connector = new GitHubConnector();
    const cursors: unknown[] = [];
    connector.requestGraphQL = async ({ variables }: { variables: Record<string, unknown> }) => {
      cursors.push(variables.cursor);
      return { data: { repository: { discussions: {
        nodes: [{ id: 'd', number: variables.cursor ? 2 : 1, createdAt: old, updatedAt: old }],
        pageInfo: { hasNextPage: !variables.cursor, endCursor: 'discussion-1' },
      } } } };
    };
    const first = await runSync(connector, { ...ctx, feedKey: 'discussions', checkpoint: { last_sync_at: old } });
    expect(first.status).toBe('more');
    const second = await runSync(connector, { ...ctx, feedKey: 'discussions', checkpoint: first.checkpoint });
    expect(second.status).toBe('complete');
    expect(cursors).toEqual([undefined, 'discussion-1']);
    expect(second.events.map(e => e.origin_id)).toEqual(['discussion_synthetic_pagination_2']);
  });

  test('discussion comments exhaust inner pages before advancing the discussion', async () => {
    const connector = new GitHubConnector();
    const cursors: Array<Record<string, unknown>> = [];
    connector.requestGraphQL = async ({ variables }: { variables: Record<string, unknown> }) => {
      cursors.push(variables);
      return { data: { repository: { discussions: {
        nodes: [{ number: variables.cursor ? 2 : 1, comments: {
          nodes: [{ id: String(cursors.length), body: 'comment', createdAt: old, updatedAt: old }],
          pageInfo: { hasNextPage: cursors.length === 1, endCursor: 'comment-1' },
        } }],
        pageInfo: { hasNextPage: !variables.cursor, endCursor: 'discussion-1' },
      } } } };
    };
    let checkpoint: Record<string, unknown> | null = { last_sync_at: old };
    const events = [];
    for (let i = 0; i < 3; i++) {
      const result = await runSync(connector, { ...ctx, feedKey: 'discussion_comments', checkpoint });
      expect(result.status).toBe(i === 2 ? 'complete' : 'more');
      events.push(...result.events); checkpoint = result.checkpoint;
    }
    expect(events).toHaveLength(3);
    expect(cursors.map(v => [v.cursor, v.commentCursor])).toEqual([
      [undefined, undefined], [undefined, 'comment-1'], ['discussion-1', undefined],
    ]);
  });

  test('a partial star snapshot never emits removals; its completed snapshot does', async () => {
    const connector = new GitHubConnector();
    const previous = { key: 'github_user_id:999', login: 'removed-user', user_id: 999 };
    connector.fetchRepository = async () => ({ id: 1 });
    connector.enqueueStargazerProfileEvent = async () => old;
    connector.requestJson = async ({ url }: { url: string }) => new URL(url).searchParams.get('page') === '2'
      ? [] : Array.from({ length: 100 }, (_, i) => ({ user: { login: `user-${i}`, id: i + 1 }, starred_at: old }));
    const first = await runSync(connector, { ...ctx, feedKey: 'stargazers', checkpoint: { stargazers: [previous] } });
    expect(first.status).toBe('more');
    expect(first.events.filter(e => e.origin_type === 'stargazer_unstarred')).toHaveLength(0);
    expect(first.checkpoint.stargazers).toEqual([previous]);
    const second = await runSync(connector, { ...ctx, feedKey: 'stargazers', checkpoint: first.checkpoint });
    expect(second.status).toBe('complete');
    expect(second.checkpoint.stargazers).toHaveLength(100);
    expect(second.events.filter(e => e.origin_type === 'stargazer_unstarred')).toHaveLength(1);
  });
  test('partial GraphQL errors cannot close a traversal', async () => {
    const connector = new GitHubConnector();
    connector.requestJson = async () => ({
      data: { repository: { discussions: { nodes: [], pageInfo: { hasNextPage: false } } } },
      errors: [{ message: 'synthetic provider error' }],
    });
    await expect(runSync(connector, { ...ctx, feedKey: 'discussions', checkpoint: null }))
      .rejects.toThrow('synthetic provider error');
  });

  test('a repeated GraphQL cursor cannot commit progress', async () => {
    const connector = new GitHubConnector();
    connector.requestGraphQL = async () => ({ data: { repository: { discussions: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' },
    } } } });
    const first = await runSync(connector, { ...ctx, feedKey: 'discussions', checkpoint: null });
    let committed = false;
    await expect(runSync(connector, { ...ctx, feedKey: 'discussions', checkpoint: first.checkpoint,
      commit: async () => { committed = true; },
    })).rejects.toThrow('repeated page cursor');
    expect(committed).toBe(false);
  });

});
