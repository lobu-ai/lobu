import { beforeAll, describe, expect, mock, test } from 'bun:test';
// The connector delegates its sync loop to the cursor paginator; the shared mock
// provides a faithful real generator (not a throwing stub), so this exercises
// the genuine paging semantics while keeping the browser stack out.
import { connectorSdkMock, HttpStatusError } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let JiraConnector: any;

beforeAll(async () => {
  const mod = await import('../jira');
  JiraConnector = mod.default;
});

interface JiraPage {
  issues?: Array<{ id?: string; key?: string; fields?: Record<string, unknown> }>;
  nextPageToken?: string;
}

/**
 * Build a fake http client whose `json()` serves a queue of /search/jql pages.
 * An `Error` in the queue is thrown for that request instead.
 */
function fakeHttp(pages: Array<JiraPage | Error>) {
  const calls: Array<string | null> = [];
  const jqls: string[] = [];
  let i = 0;
  return {
    calls,
    jqls,
    client: {
      json: async (url: string) => {
        const u = new URL(url, 'https://api.atlassian.com');
        calls.push(u.searchParams.get('nextPageToken'));
        jqls.push(u.searchParams.get('jql') ?? '');
        const page = pages[i++] ?? { issues: [] };
        if (page instanceof Error) throw page;
        return page;
      },
    },
  };
}

function makeCtx(checkpoint: Record<string, unknown> | null = null) {
  return {
    feedKey: 'issues',
    config: { cloud_id: 'cloud-1', jql: 'order by updated DESC' },
    credentials: { accessToken: 'tok' },
    sessionState: null,
    checkpoint,
  };
}

const WINDOW = { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' };

describe('JiraConnector.sync pagination', () => {
  test('follows nextPageToken across pages and stops when the token is absent', async () => {
    const connector = new JiraConnector();
    const { client, calls } = fakeHttp([
      { issues: [{ id: '1' }, { id: '2' }], nextPageToken: 'p2' },
      { issues: [{ id: '3' }], nextPageToken: 'p3' },
      { issues: [{ id: '4' }] }, // no token -> last page
    ]);
    connector.client = () => client;

    const result = await runSync(connector, makeCtx());

    // 4 issues across 3 pages, all mapped to events.
    expect(result.events).toHaveLength(4);
    expect(result.events.map((e: { origin_id: string }) => e.origin_id)).toEqual([
      'jira_issue_1',
      'jira_issue_2',
      'jira_issue_3',
      'jira_issue_4',
    ]);
    // First page sends no cursor, then follows p2, p3.
    expect(calls).toEqual([null, 'p2', 'p3']);
    expect(result.metadata).toEqual({ items_found: 4 });
  });

  test('stops on an empty page even when a token is returned (degenerate cursor guard)', async () => {
    const connector = new JiraConnector();
    const { client, calls } = fakeHttp([
      { issues: [{ id: '1' }], nextPageToken: 'p2' },
      { issues: [], nextPageToken: 'p3' }, // empty page but token present -> must stop
      { issues: [{ id: 'should-not-fetch' }] },
    ]);
    connector.client = () => client;

    const result = await runSync(connector, makeCtx());

    expect(result.events).toHaveLength(1);
    // Only two fetches: page 1, then the empty page 2; page 3 is never requested.
    expect(calls).toEqual([null, 'p2']);
  });
});

describe('JiraConnector.sync resumable traversal', () => {
  test('commits each page with the token that resumes after it, and closes the window on the last', async () => {
    const connector = new JiraConnector();
    const { client } = fakeHttp([
      { issues: [{ id: '1' }], nextPageToken: 'p2' },
      { issues: [{ id: '2' }] },
    ]);
    connector.client = () => client;

    const result = await runSync(connector, makeCtx({ last_sync_at: WINDOW.start }));

    expect(result.status).toBe('complete');
    const [first, last] = result.commits;
    expect(first.events.map((e) => e.origin_id)).toEqual(['jira_issue_1']);
    expect(first.checkpoint).toMatchObject({
      last_sync_at: WINDOW.start,
      pending: { window: { start: WINDOW.start }, page_token: 'p2' },
    });
    expect(last.events.map((e) => e.origin_id)).toEqual(['jira_issue_2']);
    // The finished window's end becomes the next window's start.
    const end = (first.checkpoint as { pending: { window: { end: string } } }).pending.window.end;
    expect(last.checkpoint).toEqual({ last_sync_at: end });
  });

  test('a capped run hands back the next token and asks for more', async () => {
    const connector = new JiraConnector();
    connector.MAX_PAGES = 2;
    const { client, calls } = fakeHttp([
      { issues: [{ id: '1' }], nextPageToken: 'p2' },
      { issues: [{ id: '2' }], nextPageToken: 'p3' },
      { issues: [{ id: 'not-this-run' }] },
    ]);
    connector.client = () => client;

    const result = await runSync(connector, makeCtx());

    expect(result.status).toBe('more');
    expect(calls).toEqual([null, 'p2']);
    expect(result.events.map((e) => e.origin_id)).toEqual(['jira_issue_1', 'jira_issue_2']);
    expect(result.checkpoint).toMatchObject({ pending: { page_token: 'p3' } });
  });

  test('a resumed run continues the saved window from the saved token', async () => {
    const connector = new JiraConnector();
    const { client, calls, jqls } = fakeHttp([{ issues: [{ id: '7' }] }]);
    connector.client = () => client;

    const result = await runSync(
      connector,
      makeCtx({ last_sync_at: WINDOW.start, pending: { window: WINDOW, page_token: 'p7' } })
    );

    expect(calls).toEqual(['p7']);
    // The window is the saved one, not a fresh one ending now.
    expect(jqls[0]).toContain(`updated < ${Date.parse(WINDOW.end)}`);
    expect(result.status).toBe('complete');
    expect(result.checkpoint).toEqual({ last_sync_at: WINDOW.end });
  });

  test('a retired token restarts the saved window from its first page once', async () => {
    const connector = new JiraConnector();
    const { client, calls, jqls } = fakeHttp([
      new HttpStatusError({ status: 400, body: 'invalid nextPageToken' }),
      { issues: [{ id: '1' }] },
    ]);
    connector.client = () => client;

    const result = await runSync(
      connector,
      makeCtx({ last_sync_at: WINDOW.start, pending: { window: WINDOW, page_token: 'gone' } })
    );

    expect(calls).toEqual(['gone', null]);
    expect(jqls[1]).toBe(jqls[0]);
    expect(result.events.map((e) => e.origin_id)).toEqual(['jira_issue_1']);
    expect(result.checkpoint).toEqual({ last_sync_at: WINDOW.end });
  });

  test('a 400 on a fresh traversal is not retried', async () => {
    const connector = new JiraConnector();
    const { client, calls } = fakeHttp([new HttpStatusError({ status: 400, body: 'bad jql' })]);
    connector.client = () => client;

    await expect(runSync(connector, makeCtx())).rejects.toThrow('HTTP 400');
    expect(calls).toEqual([null]);
  });
});
