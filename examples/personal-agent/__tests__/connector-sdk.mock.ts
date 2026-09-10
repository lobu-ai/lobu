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
  fetchPage: (
    cursor: C | null
  ) => Promise<{ items: T[]; nextCursor: C | null | undefined }>,
  options: {
    maxPages?: number;
    initialCursor?: C | null;
    delayMs?: number;
  } = {}
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let cursor: C | null = options.initialCursor ?? null;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs)
      await new Promise((r) => setTimeout(r, options.delayMs));
    const { items, nextCursor } = await fetchPage(cursor);
    yield items;
    if (nextCursor === null || nextCursor === undefined) return;
    cursor = nextCursor;
  }
}

async function* paginateByOffset<T>(
  fetchPage: (
    offset: number,
    pageSize: number
  ) => Promise<{ items: T[]; hasMore: boolean }>,
  options: {
    pageSize: number;
    maxPages?: number;
    startOffset?: number;
    delayMs?: number;
  }
): AsyncGenerator<T[], void, void> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let offset = options.startOffset ?? 0;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && options.delayMs)
      await new Promise((r) => setTimeout(r, options.delayMs));
    const { items, hasMore } = await fetchPage(offset, options.pageSize);
    yield items;
    if (!hasMore) return;
    offset += options.pageSize;
  }
}

class MockConnectorRuntime {
  declare readonly definition: {
    key: string;
    feeds?: Record<
      string,
      {
        sync?: (ctx: never) => unknown;
        read?: (ctx: never) => unknown;
      }
    >;
  };

  async sync(ctx: { feedKey: string }) {
    const handler = this.definition.feeds?.[ctx.feedKey]?.sync;
    if (!handler) {
      throw new Error(
        `${this.definition.key} feed '${ctx.feedKey}' does not support sync`
      );
    }
    return handler(ctx as never);
  }

  async read(ctx: { feedKey: string }) {
    const handler = this.definition.feeds?.[ctx.feedKey]?.read;
    if (!handler) {
      throw new Error(
        `${this.definition.key} feed '${ctx.feedKey}' does not support source reads`
      );
    }
    return handler(ctx as never);
  }
}

export function connectorSdkMock() {
  const notUsed = (name: string) => () => {
    throw new Error(`${name} is not used in connector unit tests`);
  };
  return {
    extensionNetworkSync: notUsed("extensionNetworkSync"),
    // Connectors create their HTTP client as a class field at construction, so a
    // throwing stub would break `new XConnector()`. Return an inert client whose
    // network methods throw only IF actually called — tests that exercise a
    // request path override `connector.http` / `connector.requestJson` first.
    createHttpClient: () => ({
      json: notUsed("http.json"),
      request: notUsed("http.request"),
    }),
    // The real helper wraps stored credentials into a bearer HttpClient. Tests
    // that exercise a sync path pass their fake client AS the credentials and
    // get it straight back; anything else still throws, so a connector that
    // reaches the network unintentionally fails loudly.
    requireBearerClient: (credentials: unknown) => {
      if (
        credentials &&
        typeof (credentials as { get?: unknown }).get === "function"
      ) {
        return credentials;
      }
      return notUsed("requireBearerClient")();
    },
    paginateByCursor,
    paginateByOffset,
    // Generic identity namespaces (real values — connectors read IDENTITY.EMAIL
    // at module load to declare cross-channel identity specs).
    IDENTITY: {
      PHONE: "phone",
      EMAIL: "email",
      EMAIL_DOMAIN: "email_domain",
      AUTH_USER_ID: "auth_user_id",
    },
    // Match the SDK base-class dispatch contract. Example connectors declare
    // per-feed handlers and inherit these entry points in production.
    ConnectorRuntime: MockConnectorRuntime,
    calculateEngagementScore: () => 0,
    sleep: async () => {
      // No-op in tests — real sleep is used for rate-limit pacing.
    },
    validatePublicUrl: (url: string) => {
      // Throws on non-public URLs, like the real guard. Accept http(s) only.
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("URL is not publicly reachable");
      }
      const host = parsed.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host.endsWith(".local") ||
        /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
      ) {
        throw new Error("URL is not publicly reachable");
      }
    },
    extensionDomScrape: async (opts: DomScrapeOpts) => {
      const observation = await opts.dispatcher.dispatch("navigate", {
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
