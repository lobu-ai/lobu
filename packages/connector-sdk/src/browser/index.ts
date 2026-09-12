/**
 * Browser automation entry: `@lobu/connector-sdk/browser`.
 *
 * Everything here needs a Node process — Playwright, CDP sockets, the
 * filesystem for error artifacts — so it is deliberately NOT re-exported from
 * the package root. The root stays loadable inside a V8 isolate; a connector
 * that imports this subpath cannot run there, since connector code has no lane
 * but the isolate.
 */
export type { AcquireBrowserOptions, AcquiredBrowser } from './acquire.js';
export { acquireBrowser, BrowserAuthCascadeError } from './acquire.js';
export type { CdpVersionInfo, ResolveCdpOptions } from './cdp.js';
export { fetchCdpVersionInfo, resolveCdpUrl } from './cdp.js';
export { CdpPage } from './cdp-page.js';
export type { BrowserLaunchOptions, EnhancedBrowser } from './launcher.js';
export { captureErrorArtifacts, launchBrowser } from './launcher.js';
export type { ReviewExtractResult, RunReviewScrapeOptions } from './review-scrape.js';
export { handleCookieConsent, runReviewScrape } from './review-scrape.js';
