/**
 * Network interception through the paired Owletto Chrome extension.
 * Connectors supply interception patterns, response parsing, and scrolling;
 * the ChromeActionDispatcher routes chrome.* operations to the user's browser.
 * The dispatcher returns the extension's observation envelope so connectors
 * use the same contract for direct and queued operations.
 */

import { sdkLogger } from './logger.js';

// ── Wire types (mirror apps/chrome/network-intercept.js + chrome connector) ──

export type ExtensionNetworkPattern = string | { regex: string; flags?: string };

export interface InterceptedResponse {
  url: string;
  status: number;
  mime: string;
  /** Body text. May be truncated; see `truncated`. */
  body: string;
  /** True when Chrome returned the body base64-encoded (e.g. binary content). */
  base64_encoded?: boolean;
  truncated?: boolean;
  ts: number;
}

export interface NavigateObservation {
  tab_id: number;
  current_url: string;
  title: string;
  [k: string]: unknown;
}

export interface NetworkInterceptStartObservation {
  session_id: string;
  tab_id: number;
  resumed: boolean;
  [k: string]: unknown;
}

export interface NetworkInterceptDrainObservation {
  session_id: string;
  drained: number;
  missing: boolean;
  responses: InterceptedResponse[];
  [k: string]: unknown;
}

export type ChromeActionInput = Record<string, unknown>;
export type ChromeActionOutput = Record<string, unknown>;

/**
 * Caller-supplied bridge to the Owletto extension. The server wires this
 * to its run-scheduling API (enqueue a run on the chrome connector with
 * `action_key=<action>`, await /complete-action, surface the observation).
 *
 * Decoupled so the connector code is unit-testable: tests pass a stub
 * dispatcher, the production worker passes the real one.
 */
export interface ChromeActionDispatcher {
  dispatch<T extends ChromeActionOutput = ChromeActionOutput>(
    action_key: string,
    action_input: ChromeActionInput
  ): Promise<T>;
}

// ── Config ────────────────────────────────────────────────────────────────

export interface ExtensionNetworkConfig {
  /** URL patterns to intercept (glob string or {regex} object). */
  interceptPatterns: ExtensionNetworkPattern[];
  /** Maximum scroll iterations (default 10). */
  maxScrolls?: number;
  /** Delay between scrolls in ms (default 2000). */
  scrollDelayMs?: number;
  /**
   * How long to wait for at least one response after each scroll before
   * declaring no-more-pages. Default 5000.
   */
  responseTimeoutMs?: number;
  /**
   * Per-session response buffer cap. Default 200 — higher than the
   * Playwright path because the extension caps the buffer FIFO-style and
   * we don't want a slow drain to lose batches between scrolls.
   */
  maxBufferResponses?: number;
  /** Per-response body cap. Default 1 MiB. */
  maxBodyBytes?: number;
  /**
   * Origins the dispatched chrome actions are allowed to touch. Each entry
   * is either an exact host (`linkedin.com`) or a wildcard (`*.linkedin.com`,
   * `linkedin.com/*`); see apps/chrome/tools.js / network-intercept.js
   * `urlHostInAllowlist` / `enforceAllowedOriginFromTab`.
   *
   * Forwarded on every dispatched action's `action_input.allowed_origins`,
   * mirroring how the chrome extension's per-run ctx normally pulls them
   * off `run.config.allowed_origins`. When omitted, the extension's gate
   * defaults to permissive — set this from every connector for defense in
   * depth.
   */
  allowedOrigins?: string[];
}

const DEFAULT_CONFIG = {
  maxScrolls: 10,
  scrollDelayMs: 2000,
  responseTimeoutMs: 5000,
  maxBufferResponses: 200,
  maxBodyBytes: 1024 * 1024,
};

export interface ExtensionNetworkResult<TItem> {
  items: TItem[];
  apiCallCount: number;
  backend: 'extension';
}

// ── Main entrypoint ───────────────────────────────────────────────────────

/**
 * Drive a navigate → start → (scroll → drain){,n} → stop pipeline against
 * the extension. Emits action runs
 * of driving a Playwright Page.
 */
export async function extensionNetworkSync<TItem>(opts: {
  dispatcher: ChromeActionDispatcher;
  config: ExtensionNetworkConfig;
  url: string;
  /**
   * Parse one intercepted JSON response into zero-or-more items. The
   * extension hands us the raw body string; we JSON.parse here so the
   * connector's parser sees the same `unknown` it does in the Playwright
   * path.
   */
  parseResponse: (url: string, json: unknown) => TItem[];
  /**
   * Best-effort auth check from the post-navigate URL. The extension
   * returns the resolved `current_url` after Page.frameStoppedLoading;
   * callers compare it against known redirect destinations
   * (/login, /authwall, …).
   */
  checkAuth?: (currentUrl: string) => boolean;
  /**
   * Custom pagination trigger. Defaults to dispatching an `evaluate`
   * action that runs `window.scrollTo(0, document.documentElement.scrollHeight)`.
   */
  triggerNextPage?: (
    tabId: number,
    dispatcher: ChromeActionDispatcher,
    sessionId: string
  ) => Promise<void>;
}): Promise<ExtensionNetworkResult<TItem>> {
  const cfg = { ...DEFAULT_CONFIG, ...opts.config };
  const items: TItem[] = [];
  let apiCallCount = 0;
  // Threaded through every dispatched action's input so the extension's
  // per-run allowedOrigins gate (apps/chrome/background.js reads from
  // run.config or action_input) blocks anything off-host. Omitted from the
  // payload when the caller didn't set it — the extension treats an empty
  // array as permissive.
  const allowedOriginsInput = opts.config.allowedOrigins
    ? { allowed_origins: opts.config.allowedOrigins }
    : {};

  // 1. Open an about:blank tab WITHOUT navigating yet. The Network domain
  // listener must be live BEFORE the page starts loading — otherwise the
  // first batch of Voyager XHRs the page fires during initial render
  // completes before our start() listener attaches and we miss them.
  const blankNavObs = await opts.dispatcher.dispatch<NavigateObservation>('navigate', {
    url: 'about:blank',
    open_in_new_tab: true,
    wait_for_load: true,
    ...allowedOriginsInput,
  });
  const tabId = blankNavObs.tab_id;
  sdkLogger.info({ tabId }, '[ExtensionNetwork] opened scratch tab');

  // sessionId is set once network_intercept_start returns. The cleanup
  // block below stops the session iff it's set (so a thrown start() still
  // closes the tab without trying to stop a never-started session). Pi v2
  // suggested fix.
  let sessionId: string | null = null;

  try {
    // 2. Start the intercept on the empty tab BEFORE the real navigation
    // happens, so every response fired during the page's initial render is
    // captured. Anything that landed before start() is lost — and since the
    // tab is at about:blank, nothing has landed yet.
    const startObs = await opts.dispatcher.dispatch<NetworkInterceptStartObservation>(
      'network_intercept_start',
      {
        tab_id: tabId,
        patterns: opts.config.interceptPatterns,
        max_buffer_responses: cfg.maxBufferResponses,
        max_body_bytes: cfg.maxBodyBytes,
        ...allowedOriginsInput,
      }
    );
    sessionId = startObs.session_id;
    // Capture the just-set session id in a non-nullable local so the typed
    // drainInto calls below don't have to wrestle with the let-binding
    // type. The outer sessionId variable stays nullable for the cleanup.
    const liveSessionId: string = sessionId;

    // 3. Now navigate to the real URL. Initial XHRs land into the live
    // buffer.
    const navObs = await opts.dispatcher.dispatch<NavigateObservation>('navigate', {
      tab_id: tabId,
      url: opts.url,
      open_in_new_tab: false,
      wait_for_load: true,
      ...allowedOriginsInput,
    });
    sdkLogger.info(
      { tabId, currentUrl: navObs.current_url },
      '[ExtensionNetwork] navigated'
    );

    if (opts.checkAuth && !opts.checkAuth(navObs.current_url)) {
      throw new Error(
        'extensionNetworkSync: auth check failed — Chrome session is not logged in to this site'
      );
    }

    // 4. give the initial render a chance to fire its XHRs, then drain.
    await sleep(cfg.responseTimeoutMs);
    apiCallCount += await drainInto(items, opts, liveSessionId);

    // 5. scroll loop. Each iteration: trigger pagination, wait, drain.
    let prev = items.length;
    for (let n = 0; n < cfg.maxScrolls; n++) {
      const trigger =
        opts.triggerNextPage ??
        (async (tid: number, dispatch: ChromeActionDispatcher) => {
          await dispatch.dispatch('evaluate', {
            tab_id: tid,
            expression:
              'window.scrollTo(0, document.documentElement.scrollHeight); 1',
            ...allowedOriginsInput,
          });
        });
      await trigger(tabId, opts.dispatcher, liveSessionId);
      await sleep(cfg.scrollDelayMs);
      apiCallCount += await drainInto(items, opts, liveSessionId);

      if (items.length === prev) {
        sdkLogger.info(
          { scroll: n + 1 },
          '[ExtensionNetwork] no new items, stopping pagination'
        );
        break;
      }
      sdkLogger.info(
        { scroll: n + 1, newItems: items.length - prev, total: items.length },
        '[ExtensionNetwork] scroll'
      );
      prev = items.length;
    }

    return { items, apiCallCount, backend: 'extension' };
  } finally {
    await safeStop(opts.dispatcher, sessionId);
    await safeCloseTab(opts.dispatcher, tabId);
  }

  // Helper kept inside the closure so it sees the `cfg` + `opts` typed Ts above.
  async function drainInto(
    sink: TItem[],
    o: typeof opts,
    sid: string
  ): Promise<number> {
    const drained = await o.dispatcher.dispatch<NetworkInterceptDrainObservation>(
      'network_intercept_drain',
      { session_id: sid, ...allowedOriginsInput }
    );
    let calls = 0;
    for (const resp of drained.responses ?? []) {
      calls++;
      if (resp.base64_encoded) {
        // Skip binary bodies — connectors using this helper want JSON.
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(resp.body);
      } catch {
        sdkLogger.warn(
          { url: resp.url, bodyLen: resp.body?.length ?? 0 },
          '[ExtensionNetwork] non-JSON intercepted body, skipped'
        );
        continue;
      }
      const parsed = o.parseResponse(resp.url, json);
      sink.push(...parsed);
    }
    return calls;
  }
}

async function safeStop(dispatcher: ChromeActionDispatcher, sessionId: string | null) {
  if (!sessionId) return;
  try {
    await dispatcher.dispatch('network_intercept_stop', { session_id: sessionId });
  } catch (err) {
    sdkLogger.warn({ err, sessionId }, '[ExtensionNetwork] stop failed (already gone?)');
  }
}

async function safeCloseTab(dispatcher: ChromeActionDispatcher, tabId: number) {
  try {
    // close_tab is intentionally not gated by allowedOrigins on the extension
    // side (a tab the connector opened is owned by the connector regardless
    // of where it ended up), so we don't need to forward the allowlist here.
    await dispatcher.dispatch('close_tab', { tab_id: tabId });
  } catch (err) {
    sdkLogger.warn(
      { err, tabId, reason: err instanceof Error ? err.message : String(err) },
      '[ExtensionNetwork] close_tab failed'
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
