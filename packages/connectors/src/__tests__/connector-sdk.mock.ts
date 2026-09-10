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
// packages/connector-sdk). They are re-implemented inline rather than imported
// from connector-sdk/src because this mock is copied verbatim into the cli's
// dist/ for the packaged-connector test run, where that cross-package source
// path does not resolve.

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
  readonly body: string;

  constructor(args: { status: number; body?: string; message?: string }) {
    super(args.message ?? `HTTP ${args.status}`);
    this.name = 'HttpStatusError';
    this.status = args.status;
    this.body = args.body ?? '';
  }
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
  // throwing stub would break `new XConnector()`. `get`/`post` are faithful
  // minimal implementations over global fetch (HttpStatusError on non-2xx,
  // mirroring connector-sdk/src/http-client.ts) so tests can drive a
  // connector's real request and error paths by stubbing `globalThis.fetch`.
  // The remaining methods throw only IF actually called — tests that need
  // them override `connector.http` / `connector.requestJson` first.
  const createHttpClient = () => ({
    get: async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new HttpStatusError({ status: response.status, body: await response.text() });
      }
      return response.json();
    },
    json: notUsed('http.json'),
    request: notUsed('http.request'),
    raw: notUsed('http.raw'),
    post: async (url: string, body?: unknown) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new HttpStatusError({ status: response.status, body: await response.text() });
      }
      return response.json();
    },
  });

  return {
    // Sole platform entity-type slug for ACL-gated resources. Inlined (not
    // imported from connector-sdk/src) to keep this mock valid when copied
    // verbatim into the cli's dist/ (see the file header). Must stay in step
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
