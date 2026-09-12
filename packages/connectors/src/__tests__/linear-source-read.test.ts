/**
 * Linear feed source reads via the GraphQL issues filter.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let LinearConnector: any;

beforeAll(async () => {
  const mod = await import('../linear');
  LinearConnector = mod.default;
});

interface Capture {
  queries: string[];
}

function connectorWith(capture: Capture, nodes: Array<Record<string, unknown>>) {
  const c = new LinearConnector();
  c.graphql = async (_creds: unknown, query: string) => {
    capture.queries.push(query);
    const first = Number(query.match(/issues\(first: (\d+)/)?.[1] ?? nodes.length);
    const start = Number(query.match(/after: "(\d+)"/)?.[1] ?? 0);
    const pageNodes = nodes.slice(start, start + first);
    const next = start + pageNodes.length;
    return {
      issues: {
        pageInfo: {
          hasNextPage: next < nodes.length,
          endCursor: next < nodes.length ? String(next) : null,
        },
        nodes: pageNodes,
      },
    };
  };
  return c;
}

function readIssues(connector: any, context: Record<string, unknown>) {
  return connector.read({ feedKey: 'issues', ...context });
}

describe('Linear feed source read', () => {
  test('returns a stable row shape', async () => {
    const cap: Capture = { queries: [] };
    const c = connectorWith(cap, [
      {
        id: 'iss-1',
        identifier: 'ENG-1',
        title: 'Auth timeout',
        description: 'Users stuck',
        url: 'https://linear.app/acme/issue/ENG-1',
        state: { name: 'Todo', type: 'unstarted' },
        assignee: { displayName: 'Alice' },
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    const res = await readIssues(c, {
      credentials: { accessToken: 'tok' },
      config: { team_key: 'ENG', lookback_days: 30 },
      sessionState: null,
      query: 'auth',
      limit: 10,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      id: 'iss-1',
      identifier: 'ENG-1',
      title: 'Auth timeout',
      state: 'Todo',
      assignee: 'Alice',
    });
    expect(res.columns.map((col: { name: string }) => col.name)).toContain('identifier');
    expect(cap.queries[0]).toContain('issues(first:');
    expect(cap.queries[0]).toContain('filter: { and:');
    expect(cap.queries[0]).toContain('ENG');
    expect(cap.queries[0]).toContain('updatedAt: { gte:');
    expect(cap.queries[0]).toContain('auth');
  });

  test('pushes the source-native query into the filter', async () => {
    const cap: Capture = { queries: [] };
    const c = connectorWith(cap, []);
    await readIssues(c, {
      credentials: { accessToken: 'tok' },
      config: {},
      sessionState: null,
      query: 'billing',
      limit: 5,
    });
    expect(cap.queries[0]).toContain('billing');
    expect(cap.queries[0]).toContain('containsIgnoreCase');
  });

  test('returns a provider cursor instead of re-walking beyond one Linear page', async () => {
    const cap: Capture = { queries: [] };
    const nodes = Array.from({ length: 120 }, (_, index) => ({
      id: `iss-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      title: `Issue ${index + 1}`,
      state: { name: 'Todo', type: 'unstarted' },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    }));
    const c = connectorWith(cap, nodes);
    const res = await readIssues(c, {
      credentials: { accessToken: 'tok' },
      config: {},
      sessionState: null,
      query: '',
      limit: 120,
    });
    expect(res.rows).toHaveLength(50);
    expect(res.nextCursor).toBe('50');
    expect(cap.queries).toHaveLength(1);
    expect(cap.queries[0]).toContain('issues(first: 50');
  });

  test('rejects offsets so callers cannot force a provider page re-walk', async () => {
    const cap: Capture = { queries: [] };
    const c = connectorWith(cap, []);
    await expect(
      readIssues(c, {
        credentials: { accessToken: 'tok' },
        config: {},
        sessionState: null,
        query: '',
        limit: 1,
        offset: 2500,
      }),
    ).rejects.toThrow(/returned cursor/);
    expect(cap.queries).toHaveLength(0);
  });

  test('uses max_results as an optional feed cap', async () => {
    const cap: Capture = { queries: [] };
    const nodes = Array.from({ length: 5 }, (_, index) => ({
      id: `iss-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      title: `Issue ${index + 1}`,
    }));
    const c = connectorWith(cap, nodes);
    const res = await readIssues(c, {
      credentials: { accessToken: 'tok' },
      config: { max_results: 2 },
      sessionState: null,
      query: '',
      limit: 50,
    });
    expect(res.rows).toHaveLength(2);
    expect(cap.queries).toHaveLength(1);
    expect(cap.queries[0]).toContain('issues(first: 2');
  });

  test('throws without credentials', async () => {
    const c = new LinearConnector();
    await expect(
      readIssues(c, {
        credentials: null,
        config: {},
        sessionState: null,
      }),
    ).rejects.toThrow(/OAuth credentials/);
  });

  test('rejects caller-defined sort instead of silently returning updated order', async () => {
    const c = connectorWith({ queries: [] }, []);
    await expect(
      readIssues(c, {
        credentials: { accessToken: 'tok' },
        config: {},
        sessionState: null,
        query: '',
        sort: { column: 'created_at', order: 'asc' },
      }),
    ).rejects.toThrow(/does not support caller-defined sort/);
  });

  test('issues supports both sync and source read on one feed', () => {
    const c = new LinearConnector();
    expect(typeof c.definition.feeds?.issues?.sync).toBe('function');
    expect(typeof c.definition.feeds?.issues?.read).toBe('function');
    expect(c.definition.version).toBe('1.1.1');
  });
});
