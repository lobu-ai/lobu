import { createLogger, type Logger } from "./logger";
import {
  scrubSentryBreadcrumb,
  scrubSentryErrorEvent,
  scrubSentryTransactionEvent,
} from "./utils/sentry-scrubber";

// Lazy logger initialization to avoid circular dependency
let _logger: Logger | null = null;
function getLogger(): Logger {
  if (!_logger) {
    _logger = createLogger("sentry");
  }
  return _logger;
}

let sentryInstance: typeof import("@sentry/node") | null = null;

/**
 * Resolve the egress proxy URL the Sentry transport must use.
 *
 * Worker subprocesses reach the network ONLY through the gateway egress proxy
 * (HTTP_PROXY=http://localhost:8118); prod additionally pins the kernel to
 * IPAddressDeny=any + allow-loopback, so any direct (non-proxied) connection is
 * dropped. @sentry/node-core's transport reads ONLY the lowercase
 * http_proxy/https_proxy env vars (node_modules/@sentry/node-core/.../
 * transports/http.js), which the spawn env does not set — so without passing
 * the proxy explicitly via transportOptions.proxy the capture is silently
 * kernel-blocked in prod. Returns undefined in the server/dev (no proxy) →
 * direct egress, which is correct there.
 */
export function resolveSentryEgressProxy(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env.HTTP_PROXY || env.HTTPS_PROXY || undefined;
}

/**
 * Initialize Sentry with configuration from environment variables.
 * Only initializes if SENTRY_DSN is set — no implicit error reporting.
 * Uses dynamic import to avoid module resolution issues in dev mode.
 */
export async function initSentry() {
  const sentryDsn = process.env.SENTRY_DSN;
  if (!sentryDsn) {
    getLogger().debug("Sentry disabled (no SENTRY_DSN configured)");
    return;
  }

  // transportOptions.proxy has highest priority in @sentry/node-core's
  // transport; pass the gateway proxy through explicitly so worker captures
  // route through it (the ingest host is allowlisted in
  // gateway/config/network-allowlist.ts). See resolveSentryEgressProxy.
  const egressProxy = resolveSentryEgressProxy();

  try {
    const Sentry = await import("@sentry/node");
    sentryInstance = Sentry;

    Sentry.init({
      dsn: sentryDsn,
      transportOptions: egressProxy ? { proxy: egressProxy } : undefined,
      // Tag worker events with the same environment/release the server uses
      // (instrument.ts) so worker and server issues group and filter together.
      // ENVIRONMENT / SENTRY_RELEASE come from the pod env; APP_GIT_SHA is
      // the image-baked fallback when SENTRY_RELEASE is unset.
      environment: process.env.ENVIRONMENT || "production",
      release:
        process.env.SENTRY_RELEASE || process.env.APP_GIT_SHA || undefined,
      // Do not ship IP/cookies/headers by default — user content and identifiers
      // travel through this stack and Sentry has no scrubbing for our schema.
      sendDefaultPii: false,
      // Worker Sentry exists for ISSUES (provider/model failures), not tracing.
      // Every agent run spawns a worker; at 1.0 the fleet would burn the org's
      // span quota (5M/mo on the current plan was exhausted by the server alone
      // at 0.1) and drown the server's traces. Errors are unaffected — error
      // capture uses sampleRate (default 1.0), not tracesSampleRate.
      tracesSampleRate: 0,
      integrations: [
        Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
      ],
      // Same scrubbing the gateway installs (packages/server/src/instrument.ts).
      // These three cover error events, transactions, and the breadcrumbs Node's
      // default consoleIntegration derives from console output -- the paths that
      // carry provider URLs, OAuth callback URLs and connector arguments, and so
      // the `?token=`/`?code=` values in them. Without these the credentials the
      // gateway stopped leaking still left the fleet through the worker.
      //
      // Note this does NOT cover consoleLoggingIntegration above: that routes
      // through _INTERNAL_captureLog, which is filtered by beforeSendLog and is
      // inert entirely unless `enableLogs` is set, which it is not here.
      beforeSend: scrubSentryErrorEvent,
      beforeSendTransaction: scrubSentryTransactionEvent,
      beforeBreadcrumb: scrubSentryBreadcrumb,
    });

    getLogger().debug("Sentry monitoring initialized");
  } catch (error) {
    getLogger().warn(
      "Sentry initialization failed (continuing without monitoring):",
      error
    );
  }
}

/**
 * Get the initialized Sentry instance
 * @returns Sentry instance or null if not initialized
 */
export function getSentry(): typeof import("@sentry/node") | null {
  return sentryInstance;
}
