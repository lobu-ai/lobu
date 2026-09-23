/**
 * Linear feed sync: a traversal of a fixed `updatedAt` window that commits
 * every page with the cursor that resumes after it, so a capped or killed run
 * continues where it stopped instead of re-reading the newest pages forever.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let LinearConnector: any;

beforeAll(async () => {
  const mod = await import('../linear');
  LinearConnector = mod.default;
});

const node = (id: string) => ({ id, identifier: `ENG-${id}`, title: `Issue ${id}`, updatedAt: '2026-01-15T00:00:00.000Z' });

/** A connector whose GraphQL serves `pages` in order, recording each query. */
function connectorWith(pages: Array<{ ids: string[]; next?: string }>) {
  const queries: string[] = [];
  const c = new LinearConnector();
  let i = 0;
  c.graphql = async (_creds: unknown, query: string) => {
    queries.push(query);
    const page = pages[i++] ?? { ids: [] };
    return {
      issues: {
        pageInfo: { hasNextPage: Boolean(page.next), endCursor: page.next ?? null },
        nodes: page.ids.map(node),
      },
    };
  };
  return { connector: c, queries };
}

const ctx = (checkpoint: Record<string, unknown> | null) => ({
  feedKey: 'issues',
  config: {},
  credentials: { accessToken: 'tok' },
  sessionState: null,
  checkpoint,
});

describe('LinearConnector.sync resumable traversal', () => {
  test('commits each page with its resume cursor and closes the window on the last page', async () => {
    const { connector, queries } = connectorWith([{ ids: ['1'], next: 'c1' }, { ids: ['2'] }]);

    const result = await runSync(connector, ctx({ last_sync_at: '2026-01-01T00:00:00.000Z' }));

    expect(result.status).toBe('complete');
    expect(queries[0]).toContain('updatedAt: { gte: "2026-01-01T00:00:00.000Z" }');
    expect(queries[1]).toContain('after: "c1"');
    const [first, last] = result.commits;
    expect(first.events.map((e) => e.origin_id)).toEqual(['linear_issue_1']);
    expect(first.checkpoint).toMatchObject({
      last_sync_at: '2026-01-01T00:00:00.000Z',
      pending: { since: '2026-01-01T00:00:00.000Z', cursor: 'c1' },
    });
    // The finished traversal's start becomes the next one's lower bound.
    const startedAt = (first.checkpoint as { pending: { started_at: string } }).pending.started_at;
    expect(queries[0]).toContain(`updatedAt: { lt: ${JSON.stringify(startedAt)} }`);
    expect(last.checkpoint).toEqual({ last_sync_at: startedAt });
  });

  test('a capped run keeps its place and asks for more', async () => {
    const { connector } = connectorWith([
      { ids: ['1'], next: 'c1' },
      { ids: ['2'], next: 'c2' },
      { ids: ['not-this-run'] },
    ]);
    connector.MAX_PAGES = 2;

    const result = await runSync(connector, ctx(null));

    expect(result.status).toBe('more');
    expect(result.events.map((e) => e.origin_id)).toEqual(['linear_issue_1', 'linear_issue_2']);
    expect(result.checkpoint).toMatchObject({ pending: { cursor: 'c2' } });
    // A first traversal has no lower bound, and records none.
    expect(result.checkpoint).not.toHaveProperty('last_sync_at');
    expect(result.checkpoint).not.toHaveProperty('pending.since');
  });

  test('a resumed run continues the saved window from the saved cursor', async () => {
    const { connector, queries } = connectorWith([{ ids: ['3'] }]);

    const result = await runSync(
      connector,
      ctx({
        last_sync_at: '2026-01-01T00:00:00.000Z',
        pending: { since: '2026-01-01T00:00:00.000Z', started_at: '2026-02-01T00:00:00.000Z', cursor: 'c2' },
      })
    );

    expect(queries[0]).toContain('after: "c2"');
    expect(queries[0]).toContain('updatedAt: { gte: "2026-01-01T00:00:00.000Z" }');
    expect(queries[0]).toContain('updatedAt: { lt: "2026-02-01T00:00:00.000Z" }');
    expect(result.status).toBe('complete');
    expect(result.checkpoint).toEqual({ last_sync_at: '2026-02-01T00:00:00.000Z' });
  });

  test('does not checkpoint a malformed non-terminal page', async () => {
    const connector = new LinearConnector();
    connector.graphql = async () => ({
      issues: {
        pageInfo: { hasNextPage: true, endCursor: null },
        nodes: [node('1')],
      },
    });

    await expect(runSync(connector, ctx(null))).rejects.toThrow(
      'valid page cursor/exhaustion state'
    );
  });
});
