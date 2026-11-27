import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { classifyToolError, isRetryable } from '@lobu/core';
import { connectorSdkMock, fakeClient } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());
let Gmail: typeof import('../google_gmail').default;
let Drive: typeof import('../google_drive').default;
let Linear: typeof import('../linear').default;
let Jira: typeof import('../jira').default;
let Shopify: typeof import('../shopify').default;
beforeAll(async () => {
  Shopify = (await import('../shopify')).default;
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
    Object.assign(c, { createClient: () => fakeClient({ raw: async (url: string) => {
      query = new URL(url).searchParams.get('q') ?? '';
      return Response.json({ messages: [] });
    } }) });
    await c.read({ feedKey: 'threads', config, credentials, window, query: 'has:attachment' });
    expect(query).toStartWith(`(${scope}) (has:attachment) after:`);
  });

  test('Gmail person filtering inspects thread metadata and preserves an empty page cursor', async () => {
    const threadRequests: string[] = [];
    const c = new Gmail();
    Object.assign(c, { createClient: () => fakeClient({ raw: async (url: string) => {
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
    Object.assign(c, { client: () => fakeClient({ raw: async () => Response.json({ files: [{ id: 'file-1' }] }) }) });
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
    Object.assign(c, { createClient: () => fakeClient({ raw: async (url: string) => {
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
    Object.assign(c, { createClient: () => fakeClient({ raw: async (url: string) =>
      new URL(url).pathname.endsWith('/messages')
        ? Response.json({ messages: [{ id: 'unavailable' }] })
        : new Response('provider unavailable', { status: 503 }),
    }) });
    await expect(c.read({ feedKey: 'threads', config: {}, credentials, window })).rejects.toThrow(/503/);
  });

  test('Drive combines configured scope, requested limit and fixed modified-time bounds', async () => {
    let request: URL | undefined;
    const c = new Drive();
    Object.assign(c, { client: () => fakeClient({ raw: async (url: string) => {
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
    Object.assign(c, { client: () => fakeClient({ raw: async () => Response.json({ files: [], incompleteSearch: true }) }) });
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
  test('Shopify reads orders live, never syncs them, and keeps exact half-open bounds', async () => {
    const c = new Shopify();
    const orders = c.definition.feeds.orders;
    expect(orders.sync).toBeUndefined();
    expect(orders.readWindowAxis).toBe('updated_at');

    const bodies: { query: string; variables: Record<string, unknown> }[] = [];
    const order = (id: string, updatedAt: string) => ({
      id: `gid://shopify/Order/${id}`, legacyResourceId: id, name: `#${id}`,
      createdAt: window.start, processedAt: null, updatedAt, cancelledAt: null,
      displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', email: null,
      customer: { displayName: 'Synthetic Buyer', email: 'buyer@example.test' },
      subtotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
      totalTaxSet: { shopMoney: { amount: '0.00', currencyCode: 'USD' } },
      totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
      lineItems: { nodes: [{ sku: 'SKU-1', name: 'Pen', quantity: 2, originalUnitPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } } }] },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ data: { orders: {
        pageInfo: { hasNextPage: true, endCursor: 'next-page' },
        nodes: [order('2', '2026-01-01T12:00:00Z'), order('3', window.end)],
      } } });
    }) as typeof fetch;
    try {
      const result = await c.read({
        feedKey: 'orders', config: { shop: 'demo-store.myshopify.com' }, credentials, window, limit: 2,
      });
      expect(result.rows.map((row) => row.name)).toEqual(['#2']);
      expect(result.rows[0]).toMatchObject({ total: 10, currency: 'USD' });
      // Buyer identity is Level 2 protected customer data: never requested, never returned.
      expect(bodies[0].query).not.toMatch(/\b(customer|email|phone|address)/i);
      expect(JSON.stringify(result.rows)).not.toMatch(/Synthetic Buyer|buyer@example\.test|customer_/);
      expect(JSON.stringify(c.definition.authSchema)).not.toContain('read_customers');
      expect(result.window).toEqual({ ...window, axis: 'updated_at' });
      expect(result.nextCursor).toBe('next-page');
      expect(bodies[0].variables.first).toBe(2);
      expect(bodies[0].variables.query).toContain("updated_at:>='2026-01-01T00:00:00Z'");
      expect(bodies[0].variables.query).toContain("updated_at:<'2026-01-02T00:00:01Z'");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('Shopify rejects an unfinished orders page without a cursor', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ data: { orders: {
      pageInfo: { hasNextPage: true, endCursor: null }, nodes: [],
    } } })) as typeof fetch;
    try {
      await expect(new Shopify().read({
        feedKey: 'orders', config: { shop: 'demo-store.myshopify.com' }, credentials, window,
      })).rejects.toThrow(/cursor|exhaustion/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test.each([
    ['ACCESS_DENIED', Response.json({ errors: [{
      message: 'This app is not approved to access the Order object.',
      extensions: { code: 'ACCESS_DENIED' },
    }] }), 'AUTH_INVALID'],
    ['THROTTLED', Response.json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }), 'RATE_LIMITED'],
    ['an HTTP 401', new Response('Invalid API key or access token', { status: 401 }), 'AUTH_INVALID'],
  ] as const)('Shopify %s keeps a classifiable status instead of a retryable upstream 5xx', async (_case, response, expected) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => response) as typeof fetch;
    try {
      const error = await new Shopify().read({
        feedKey: 'orders', config: { shop: 'demo-store.myshopify.com' }, credentials, window,
      }).then(() => undefined, (e: unknown) => e);
      const code = classifyToolError({ httpStatus: (error as { status?: number } | undefined)?.status });
      expect(code).toBe(expected);
      if (expected === 'AUTH_INVALID') expect(isRetryable(code)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
