// Shared @lobu/connector-sdk mock for connector unit tests.
//
// mock.module replaces the WHOLE module and bun shares the mock registry
// across files in a run, so every connector test that stubs the SDK must
// expose the same superset of symbols regardless of file order. This is the
// single source for that superset — `mock.module('@lobu/connector-sdk',
// connectorSdkMock)` in each test file.
//
// The SDK pulls in playwright; stubbing lets the pure connector logic be
// imported without the browser stack. The runtime-only symbols throw if a
// test actually reaches them; extensionDomScrape and the paginateBy* generators
// are faithfully re-implemented so connectors that delegate their sync loops
// exercise the real paging semantics (the real helpers have their own tests in
// packages/connector-sdk). Those stay inline for historical reasons only —
// neither build copier runs this file.

// The file OUTPUT helpers are imported rather than re-implemented: a hand-copy
// that drifted would let a connector pass its tests while manufacturing a
// U+FFFD in prod. `file-output.ts` and `file-input.ts` import nothing, so they
// drag in none of the browser stack.
import * as fileInput from '../../../connector-sdk/src/file-input.js';
import * as fileOutput from '../../../connector-sdk/src/file-output.js';
import { requireBrowser } from '../../../connector-sdk/src/browser-requirement.js';
import * as browserHandoffBanner from '../../../connector-sdk/src/browser-handoff-banner.js';
import * as browserSourceRead from '../../../connector-sdk/src/browser-source-read.js';
import { IDENTITY } from '../../../connector-sdk/src/identity-namespaces.js';

interface DomScrapeOpts {
  dispatcher: {
    // biome-ignore lint/suspicious/noExplicitAny: stub dispatcher return
    dispatch: (action: string, input: Record<string, unknown>) => Promise<any>;
  };
  url: string;
  config: Record<string, unknown>;
  parseRows: (rows: Array<Record<string, unknown>>) => unknown[];
  allowedOrigins: string[];
  persistent?: boolean;
  focus?: boolean;
}

// Faithful copies of the SDK's pure pagination generators (no browser stack).
// Kept byte-for-byte in step with packages/connector-sdk/src/pagination.ts.
async function* paginateByCursor<T, C = string>(
  fetchPage: (cursor: C | null) => Promise<{ items: T[]; nextCursor: C | null | undefined }>,
  options: { maxPages?: number; initialCursor?: C | null; delayMs?: number } = {}
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let cursor: C | null = options.initialCursor ?? null;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const { items, nextCursor } = await fetchPage(cursor);
    yield items;
    if (nextCursor === null || nextCursor === undefined) return;
    cursor = nextCursor;
  }
}

async function* paginateByOffset<T>(
  fetchPage: (offset: number, pageSize: number) => Promise<{ items: T[]; hasMore: boolean }>,
  options: { pageSize: number; maxPages?: number; startOffset?: number; delayMs?: number }
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let offset = options.startOffset ?? 0;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const { items, hasMore } = await fetchPage(offset, options.pageSize);
    yield items;
    if (!hasMore) return;
    offset += options.pageSize;
  }
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly body: string;

  /** Accepts the SDK's constructor shape, plus a short `{ status, body }` form for test fixtures. */
  constructor(args: {
    status: number;
    body?: string;
    message?: string;
    prefix?: string;
    method?: string;
    url?: string;
    statusText?: string;
    bodyText?: string;
  }) {
    const bodyText = args.bodyText ?? args.body ?? '';
    super(
      args.message ??
        (args.prefix
          ? `${args.prefix} ${args.method} ${args.url} failed (${args.status}): ${bodyText}`
          : `HTTP ${args.status}`)
    );
    this.name = 'HttpStatusError';
    this.status = args.status;
    this.bodyText = bodyText;
    this.body = bodyText;
  }
}

type RawFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A hand-built fake that serves only `raw`, completed with the SDK's other methods. */
// biome-ignore lint/suspicious/noExplicitAny: fakes return Response-shaped literals
export function fakeClient<T extends { raw: (url: string, init?: RequestInit) => any }>(fake: T) {
  return { ...httpClientFromRaw(fake.raw), ...fake };
}

/**
 * The SDK `HttpClient` surface built over one `raw` transport, mirroring
 * connector-sdk/src/http-client.ts minus retries: `raw` hands back any status,
 * every other method throws HttpStatusError on a non-2xx. Tests that fake a
 * connector's client pass their own `raw` so the connector's `request`/`json`
 * paths see the same status handling the SDK gives them.
 */
export function httpClientFromRaw(raw: RawFetch, errorPrefix = 'HTTP') {
  const request = async (url: string, init?: RequestInit) => {
    const response = await raw(url, init);
    if (response.ok) return response;
    throw new HttpStatusError({
      prefix: errorPrefix,
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      status: response.status,
      statusText: response.statusText ?? '',
      bodyText: await response.text(),
    });
  };
  const json = async (url: string, init?: RequestInit) => (await request(url, init)).json();
  return {
    raw,
    request,
    json,
    get: (url: string, init?: RequestInit) => json(url, { ...init, method: 'GET' }),
    post: (url: string, body?: unknown, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');
      return json(url, {
        ...init,
        method: 'POST',
        headers,
        body: body === undefined ? init.body : JSON.stringify(body),
      });
    },
  };
}

export function connectorSdkMock() {
  const notUsed = (name: string) => () => {
    throw new Error(`${name} is not used in connector unit tests`);
  };
  class ConnectorRuntime {
    definition!: {
      key: string;
      feeds?: Record<
        string,
        {
          sync?: (ctx: unknown) => Promise<unknown>;
          read?: (ctx: unknown) => Promise<unknown>;
          observe?: (ctx: unknown) => Promise<void>;
        }
      >;
    };

    async sync(ctx: { feedKey: string }): Promise<unknown> {
      const handler = this.definition.feeds?.[ctx.feedKey]?.sync;
      if (!handler) {
        throw new Error(
          `${this.definition.key} feed '${ctx.feedKey}' does not support sync`,
        );
      }
      return handler(ctx);
    }

    async observe(ctx: { feedKey: string }): Promise<void> {
      const handler = this.definition.feeds?.[ctx.feedKey]?.observe;
      if (!handler) throw new Error("Feed has no listener setup");
      await handler(ctx);
    }

    async read(ctx: { feedKey: string }): Promise<unknown> {
      const handler = this.definition.feeds?.[ctx.feedKey]?.read;
      if (!handler) {
        throw new Error(
          `${this.definition.key} feed '${ctx.feedKey}' does not support source reads`,
        );
      }
      return handler(ctx);
    }
  }
  class IntegrationConnector extends ConnectorRuntime {}
  // Connectors create their HTTP client as a class field at construction, so a
  // throwing stub would break `new XConnector()`. Every method is a faithful
  // minimal implementation over global fetch (see httpClientFromRaw), so tests
  // drive a connector's real request and error paths by stubbing
  // `globalThis.fetch`. Configured headers and the bearer token are sent.
  const createHttpClient = (
    options: { token?: string; headers?: Record<string, string>; errorPrefix?: string } = {}
  ) =>
    httpClientFromRaw((url, init) => {
      const headers = new Headers(options.headers);
      new Headers(init?.headers).forEach((value, key) => {
        headers.set(key, value);
      });
      if (options.token && !headers.has('authorization')) {
        headers.set('Authorization', `Bearer ${options.token}`);
      }
      return fetch(url, { ...init, headers });
    }, options.errorPrefix);

  return {
    requireBrowser,
    ...fileInput,
    ...fileOutput,
    ...browserHandoffBanner,
    ...browserSourceRead,
    // Real generic identity namespaces: connectors read them at module load.
    IDENTITY,
    // Sole platform entity-type slug for ACL-gated resources. Must stay in step
    // with ACL_RESOURCE_TYPE_SLUG in packages/connector-sdk/src/acl-source.ts.
    ACL_RESOURCE_TYPE_SLUG: '$resource',
    HttpStatusError,
    extensionNetworkSync: async (opts: {
      dispatcher: {
        dispatch: (
          action: string,
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
      url: string;
      parseResponse: (url: string, json: unknown) => unknown[];
      config?: { maxScrolls?: number };
      triggerNextPage?: (
        tabId: number,
        dispatcher: {
          dispatch: (
            action: string,
            input: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        },
        sessionId: string,
      ) => Promise<void>;
    }) => {
      const observation = await opts.dispatcher.dispatch('navigate', {
        network_intercept: true,
        url: opts.url,
      });
      const responses =
        (observation?.result as {
          responses?: Array<{ body?: string; url?: string }>;
        })?.responses ?? [];
      const items: unknown[] = [];
      let apiCallCount = responses.length;
      for (const response of responses) {
        if (!response.body) continue;
        items.push(
          ...opts.parseResponse(
            response.url ?? opts.url,
            JSON.parse(response.body) as unknown,
          ),
        );
      }
      // This stub models response parsing and custom pagination only. It does not
      // model the real SDK's checkAuth or responseTimeoutMs semantics.
      if (opts.triggerNextPage) {
        const tabId = Number(observation?.tab_id ?? 1);
        for (let page = 0; page < (opts.config?.maxScrolls ?? 0); page++) {
          const before = items.length;
          await opts.triggerNextPage(tabId, opts.dispatcher, 'test-network-session');
          const drained = await opts.dispatcher.dispatch('network_intercept_drain', {});
          const nextResponses =
            (drained?.result as {
              responses?: Array<{ body?: string; url?: string }>;
            })?.responses ?? [];
          apiCallCount += nextResponses.length;
          for (const response of nextResponses) {
            if (!response.body) continue;
            items.push(
              ...opts.parseResponse(
                response.url ?? opts.url,
                JSON.parse(response.body) as unknown,
              ),
            );
          }
          if (items.length === before) break;
        }
      }
      return {
        items,
        backend: 'extension-network',
        apiCallCount,
      };
    },
    createHttpClient,
    // Faithful copy of connector-sdk checkpoint/timestamp-watermark.ts — must
    // honor the checkpoint arg; a passthrough stub leaks via Bun's global mock
    // registry and breaks the SDK's timestamp-watermark.test when connector tests run first.
    filterByCheckpoint: <T extends { occurred_at: Date }>(
      events: T[],
      checkpoint: Record<string, unknown> | null
    ): T[] => {
      const lastTimestamp = checkpoint?.last_timestamp as string | undefined;
      if (!lastTimestamp) return events;
      const cutoff = new Date(lastTimestamp);
      return events.filter((e) => e.occurred_at >= cutoff);
    },
    sleep: async () => {},
    validatePublicUrl: (url: string) => url,
    // Mirrors the missing-credential throw of connector-sdk/src/http-client.ts
    // `requireBearerClient` — connector tests assert this message, so the label
    // fallback order must stay in step. On the success path it hands back the
    // mock client above, which is unauthenticated: the token is dropped, so
    // tests here cannot assert what the SDK would have sent on the wire.
    requireBearerClient: (
      credentials: { accessToken?: string } | null,
      options: { label?: string; errorPrefix?: string } = {}
    ) => {
      if (!credentials?.accessToken) {
        const label = options.label ?? options.errorPrefix ?? 'This connector';
        throw new Error(`${label} requires OAuth authentication.`);
      }
      return createHttpClient();
    },
    paginateByCursor,
    paginateByOffset,
    ConnectorRuntime,
    IntegrationConnector,
    calculateEngagementScore: () => 0,
    SubscriptionCandidateSchema: {
      type: 'object',
      properties: {},
    },
    extensionDomScrape: async (opts: DomScrapeOpts) => {
      const observation = await opts.dispatcher.dispatch('navigate', {
        cs_scrape: true,
        persistent: opts.persistent ?? false,
        focus: opts.focus ?? false,
        window_focused: opts.focus ?? false,
        url: opts.url,
        scrape_config: opts.config,
        allowed_origins: opts.allowedOrigins,
      });
      const result = observation?.result;
      const items = opts.parseRows(result?.rows ?? []);
      return {
        items,
        loggedIn: result?.loggedIn !== false,
        count: result?.count ?? items.length,
        host: result?.host,
        landedUrl: result?.landedUrl,
      };
    },
  };
}
