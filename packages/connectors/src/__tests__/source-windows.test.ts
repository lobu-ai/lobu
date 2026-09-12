import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());
let Gmail: typeof import('../google_gmail').default;
let Drive: typeof import('../google_drive').default;
let Linear: typeof import('../linear').default;
let Jira: typeof import('../jira').default;
beforeAll(async () => {
  Gmail = (await import('../google_gmail')).default;
  Drive = (await import('../google_drive')).default;
  Linear = (await import('../linear')).default;
  Jira = (await import('../jira')).default;
});
const window = { start: '2026-01-01T00:00:00.250Z', end: '2026-01-02T00:00:00.250Z' };
const credentials = { accessToken: 'synthetic-token' };

describe('live source windows', () => {
  test.each([
    [{}, 'label:INBOX'],
    [{ label: 'STARRED' }, 'label:STARRED'],
    [{ labels: ['work', 'personal'] }, '{label:work label:personal}'],
    [{ query: 'from:one@example.test OR from:two@example.test' }, 'from:one@example.test OR from:two@example.test'],
  ])('Gmail preserves configured window scope %j', async (config, scope) => {
    let query = '';
    const c = new Gmail();
    Object.assign(c, { createClient: () => ({ raw: async (url: string) => {
      query = new URL(url).searchParams.get('q') ?? '';
      return Response.json({ messages: [] });
    } }) });
    await c.read({ feedKey: 'threads', config, credentials, window, query: 'has:attachment' });
    expect(query).toStartWith(`(${scope}) (has:attachment) after:`);
  });

  test('Gmail person filtering inspects thread metadata and preserves an empty page cursor', async () => {
    const threadRequests: string[] = [];
    const c = new Gmail();
    Object.assign(c, { createClient: () => ({ raw: async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'more' });
      const message = { id: 'm1', threadId: 't1', internalDate: String(Date.parse(window.start)), payload: { headers: [{ name: 'From', value: 'Alice <alice@example.test>' }] } };
      if (u.pathname.includes('/threads/')) {
        threadRequests.push(url);
        return Response.json({ messages: [message] });
      }
      return Response.json(message);
    } }) });
    const result = await c.read({ feedKey: 'threads', config: { human_senders_only: true }, credentials, window });
    expect(threadRequests).toHaveLength(1);
    expect(new URL(threadRequests[0]).searchParams.get('format')).toBe('metadata');
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBe('more');
    expect(result.hasMore).toBe(true);
  });

  test('Drive rejects a file without its window timestamp', async () => {
    const c = new Drive();
    Object.assign(c, { client: () => ({ raw: async () => Response.json({ files: [{ id: 'file-1' }] }) }) });
    await expect(c.read({ feedKey: 'files', config: {}, credentials, window })).rejects.toThrow(/modified|malformed/i);
  });

  test('Linear rejects ambiguous exhaustion', async () => {
    const c = new Linear();
    Object.assign(c, { graphql: async () => ({ issues: { nodes: [], pageInfo: {} } }) });
    await expect(c.read({ feedKey: 'issues', config: {}, credentials, window })).rejects.toThrow(/cursor|exhaustion/i);
  });

  test('Jira rejects an unfinished page without a cursor', async () => {
    const c = new Jira();
    Object.assign(c, { restBase: async () => 'https://jira.example.test/rest/api/3', client: () => ({ json: async () => ({ issues: [], isLast: false }) }) });
    await expect(c.read({ feedKey: 'issues', config: {}, credentials, window })).rejects.toThrow(/cursor|exhaustion/i);
  });
  test('Jira rejects a window page without explicit exhaustion metadata', async () => {
    const c = new Jira();
    Object.assign(c, { restBase: async () => 'https://jira.example.test/rest/api/3', client: () => ({ json: async () => ({ issues: [] }) }) });
    await expect(c.read({ feedKey: 'issues', config: {}, credentials, window })).rejects.toThrow(/cursor|exhaustion/i);
  });
  test('Jira acknowledges an explicitly exhausted window page', async () => {
    const c = new Jira();
    Object.assign(c, { restBase: async () => 'https://jira.example.test/rest/api/3', client: () => ({ json: async () => ({ issues: [], isLast: true }) }) });
    const result = await c.read({ feedKey: 'issues', config: {}, credentials, window });
    expect(result).toMatchObject({ rows: [], hasMore: false, window: { ...window, axis: 'updated_at' } });
  });
  test('Gmail uses internal arrival time, exact half-open bounds, and retains empty-page continuation', async () => {
    const requests: URL[] = [];
    const c = new Gmail();
    Object.assign(c, { createClient: () => ({ raw: async (url: string) => {
      const u = new URL(url); requests.push(u);
      if (u.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'start' }, { id: 'end' }], nextPageToken: 'next-page' });
      const id = u.pathname.split('/').pop();
      return Response.json({ id, threadId: id, internalDate: String(Date.parse(id === 'start' ? window.start : window.end)), payload: { headers: [{ name: 'Date', value: '2000-01-01' }] } });
    } }) });
    const result = await c.read({ feedKey: 'threads', config: { query: '-in:spam' }, credentials, window, limit: 2 });
    expect(result.rows.map((row) => row.id)).toEqual(['start']);
    expect(result.window).toEqual({ ...window, axis: 'received_at' });
    expect(requests[0].searchParams.get('q')).toContain('-in:spam');
    expect(requests[0].searchParams.get('q')).toContain(`after:${Math.floor(Date.parse(window.start) / 1000) - 1}`);
    expect(result.nextCursor).toBe('next-page');
    expect(result.hasMore).toBe(true);
  });

  test('Gmail fails the page when one message cannot be fetched', async () => {
    const c = new Gmail();
    Object.assign(c, { createClient: () => ({ raw: async (url: string) =>
      new URL(url).pathname.endsWith('/messages')
        ? Response.json({ messages: [{ id: 'unavailable' }] })
        : new Response('provider unavailable', { status: 503 }),
    }) });
    await expect(c.read({ feedKey: 'threads', config: {}, credentials, window })).rejects.toThrow(/503/);
  });

  test('Drive combines configured scope, requested limit and fixed modified-time bounds', async () => {
    let request: URL | undefined;
    const c = new Drive();
    Object.assign(c, { client: () => ({ raw: async (url: string) => {
      request = new URL(url); return Response.json({ files: [], nextPageToken: 'next' });
    } }) });
    const result = await c.read({ feedKey: 'files', config: { query: "name contains 'report'" }, credentials, window, limit: 2 });
    expect(request?.searchParams.get('pageSize')).toBe('2');
    expect(request?.searchParams.get('q')).toContain(`modifiedTime >= '${window.start}'`);
    expect(request?.searchParams.get('q')).toContain(`modifiedTime < '${window.end}'`);
    expect(request?.searchParams.get('q')).toContain("name contains 'report'");
    expect(result.window).toEqual({ ...window, axis: 'modified_at' });
    expect(result.nextCursor).toBe('next');
  });

  test('Drive rejects incomplete provider search results', async () => {
    const c = new Drive();
    Object.assign(c, { client: () => ({ raw: async () => Response.json({ files: [], incompleteSearch: true }) }) });
    await expect(c.read({ feedKey: 'files', config: {}, credentials, window })).rejects.toThrow(/incomplete/i);
  });

  test('Linear replaces the moving lookback and rejects a missing continuation', async () => {
    let query = '';
    const c = new Linear();
    Object.assign(c, { graphql: async (_credentials: unknown, text: string) => {
      query = text; return { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } };
    } });
    await expect(c.read({ feedKey: 'issues', config: { lookback_days: 1 }, credentials, window })).rejects.toThrow(/cursor/i);
    expect(query).toContain(JSON.stringify(window.start));
    expect(query).toContain(JSON.stringify(window.end));
    expect(query).toContain('lt:');
  });
});
