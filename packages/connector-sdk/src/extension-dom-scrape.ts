import type { ChromeActionDispatcher } from './extension-network.js';

/**
 * Companion to `extensionNetworkSync` for feeds that can't be read by passive
 * network capture — the CDP debugger the intercept needs stops some
 * personalized feeds from rendering. Wraps the extension's content-script
 * `cs_scrape` op in one dispatch so the DOM path goes through the SDK like the
 * network path; the connector supplies only its selector config + a row parser.
 */

/** Declarative config the extension's `genericScrape` interprets; forwarded verbatim as `scrape_config`. */
export interface ExtensionScrapeConfig {
  scroll?: { max?: number; stall?: number; waitMs?: number; deep?: boolean };
  loggedOutWhen?: { pathRegex?: string; hostRegex?: string };
  rowSelector?: string;
  /** Section/day grouping: iterate each `selector`, take its first text line as
   * the group label (when `labelFromFirstLine`), and emit a row per
   * `rowSelector` inside it. The engine reads `cfg.group.selector`. */
  group?: {
    selector: string;
    rowSelector: string;
    labelFromFirstLine?: boolean;
  };
  id?: {
    source: string;
    name?: string | readonly string[];
    regex?: string;
    group?: number;
  };
  requireFields?: readonly string[];
  fields?: Record<string, ExtensionScrapeField>;
  [k: string]: unknown;
}

/** One part read off a single element inside an `objectAll` match. */
interface ExtensionScrapePart {
  /**
   * `attr` reads `attr`; `text` the innerText; `aria` the element's own or a
   * descendant's aria-label; `alt` a descendant img[alt]. These labels can
   * remain useful when class names are obfuscated.
   */
  take?: 'attr' | 'text' | 'aria' | 'alt' | (string & {});
  attr?: string;
}

interface ExtensionScrapeField {
  selector?: string;
  /**
   * `attr` / `text` / `html` read the FIRST match. `objectAll` reads EVERY match
   * and emits one object per element, built from `parts` — letting a connector
   * capture a row's repeated structures (e.g. every profile link as
   * {href, name}) and disambiguate them by content rather than DOM position.
   */
  take?: 'attr' | 'text' | 'html' | 'objectAll' | 'clipboardAction' | (string & {});
  attr?: string;
  firstLine?: boolean;
  const?: unknown;
  /** Sub-spec for `objectAll`: the named parts to read off each matched element. */
  parts?: Record<string, ExtensionScrapePart>;
  /**
   * `clipboardAction` menu-navigation keys, all inert: the extension never
   * clicks a clipboard-writing action. Page code can retain the native
   * clipboard callables before injection, so a late interceptor cannot prove
   * the user's real clipboard was left untouched. A `clipboardAction` field
   * always reads as an empty string — a connector must instead extract a
   * durable identity or link already present in the DOM.
   */
  triggerSelector?: string;
  actionSelector?: string;
  actionText?: string;
  actionTextRegex?: string;
  actionTextRegexFlags?: string;
  maxWaitMs?: number;
}

/** The `.result` payload of a `cs_scrape` dispatch. */
export interface ExtensionScrapeResult {
  count?: number;
  host?: string;
  landedUrl?: string;
  loggedIn?: boolean;
  rows?: Array<Record<string, unknown>>;
  /** Set by the extension when the in-page scrape script threw (e.g. CSP
   * blocked injection). Distinct from a clean logged-out result. */
  error?: unknown;
  [k: string]: unknown;
}

/** Dispatcher observation envelope; the index signature satisfies `ChromeActionOutput`. */
export type ExtensionScrapeObservation = Record<string, unknown> & {
  tab_id?: number;
  cs_scrape?: boolean;
  persistent_reused?: boolean;
  result?: ExtensionScrapeResult;
};

export interface ExtensionDomScrapeResult<TItem> {
  items: TItem[];
  loggedIn: boolean;
  count: number;
  host?: string;
  landedUrl?: string;
  /** Tab the content-script scrape ran in. Useful for focusing an auth-wall tab. */
  tabId?: number;
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  const normalizedPattern = pattern.toLowerCase().replace(/\.$/, '');
  if (normalizedHost === normalizedPattern) return true;
  if (normalizedPattern.startsWith('*.')) {
    return normalizedHost.endsWith(normalizedPattern.slice(1));
  }
  return false;
}

function assertExpectedScrapeSite(
  requestedUrl: string,
  allowedOrigins: string[],
  result: ExtensionScrapeResult
): void {
  const requestedHost = new URL(requestedUrl).hostname;
  const expectedHosts = [requestedHost, ...allowedOrigins];
  const assertHost = (host: string, source: string) => {
    if (expectedHosts.some((pattern) => hostMatchesPattern(host, pattern)))
      return;
    throw new Error(
      `cs_scrape returned the wrong site: requested ${requestedHost}, but ${source} reported ${host}.`
    );
  };

  if (result.host) assertHost(result.host, 'result.host');
  if (result.landedUrl) {
    let landedHost: string;
    try {
      landedHost = new URL(result.landedUrl).hostname;
    } catch {
      throw new Error(
        `cs_scrape returned the wrong site: landedUrl is not a valid URL (${result.landedUrl}).`
      );
    }
    assertHost(landedHost, 'landedUrl');
  }
}

/**
 * Drive one content-script `cs_scrape` navigate and return parsed rows.
 * Scrapes default to a background, action-scoped tab that the extension closes
 * after harvesting. Set `persistent:true` only for a site with tab-bound state;
 * it selects that site's sticky anchor and serializes work on that anchor.
 * There is no way to target a user's own tab: the extension refuses any scrape
 * against a tab it does not lease or hold as that site's anchor.
 */
export async function extensionDomScrape<TItem>(opts: {
  dispatcher: ChromeActionDispatcher;
  url: string;
  config: ExtensionScrapeConfig;
  parseRows: (rows: Array<Record<string, unknown>>) => TItem[];
  allowedOrigins: string[];
  persistent?: boolean;
  focus?: boolean;
}): Promise<ExtensionDomScrapeResult<TItem>> {
  const observation = await opts.dispatcher.dispatch<ExtensionScrapeObservation>('navigate', {
    cs_scrape: true,
    persistent: opts.persistent ?? false,
    focus: opts.focus ?? false,
    url: opts.url,
    scrape_config: opts.config,
    allowed_origins: opts.allowedOrigins,
  });
  const result = observation?.result;

  // Fail loudly on a broken scrape. A missing result (dispatch never produced
  // one) or an `error` field (the in-page script threw — e.g. CSP blocked
  // injection) must NOT be silently coerced into a logged-in, zero-row
  // "success": that masks DOM/selector breakage as an empty sync and can let a
  // connector advance its checkpoint or report health on no data. A genuine
  // auth wall is different — the engine returns `loggedIn:false` with no error,
  // which is preserved below for the caller to handle.
  if (!result) {
    throw new Error(
      'cs_scrape returned no result — the content-script dispatch did not complete.'
    );
  }
  if (result.error != null && result.error !== '') {
    throw new Error(`cs_scrape failed in the page: ${String(result.error)}`);
  }
  assertExpectedScrapeSite(opts.url, opts.allowedOrigins, result);
  const items = opts.parseRows(result.rows ?? []);
  return {
    items,
    loggedIn: result.loggedIn !== false,
    count: result.count ?? items.length,
    host: result.host,
    landedUrl: result.landedUrl,
    tabId: observation.tab_id,
  };
}
