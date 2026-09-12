// Connector tests replace only external I/O and timing. Capture the published
// SDK before Bun installs any module mock: its runtime, schemas and pure helpers
// must remain real so new SDK capabilities cannot drift from a second copy here.
// The package import also works in the CLI packaged-connector test layout.
import * as connectorSdk from '@lobu/connector-sdk';

const actualSdk = { ...connectorSdk };

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
    ...actualSdk,
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
    sleep: async () => {},
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
