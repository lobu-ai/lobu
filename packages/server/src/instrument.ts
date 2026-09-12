/**
 * Sentry Instrumentation — must be imported before all other modules.
 *
 * @sentry/node uses OpenTelemetry under the hood to auto-instrument:
 * - postgres (postgres.js) and pg (node-postgres)
 * - HTTP/fetch outgoing requests
 * - Node.js core modules
 *
 * This file is imported as the very first line in server.ts.
 */

import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { resolveSentryRuntime } from './utils/runtime-info';
import {
  scrubSentryBreadcrumb,
  scrubSentryErrorEvent,
  scrubSentryTransactionEvent,
} from '@lobu/core';

// .env is the single source of truth for secrets. This module reads SENTRY_DSN
// (and ENVIRONMENT / SENTRY_RELEASE) at load time and is imported before any
// other module — so it must load .env itself, or Sentry would be silently
// disabled in any deployment that keeps the DSN in .env. dotenv.config() is
// idempotent (it doesn't override already-set vars), so a later call is fine.
dotenv.config();

const dsn = process.env.SENTRY_DSN;

// A dev runtime never legitimately reports as production. A worktree/dev
// stack can carry a prod .env copy with ENVIRONMENT=production, so use
// NODE_ENV=development to keep those events out of the production stream.
// Override only Sentry's tag: mutating process.env here would also change
// logger mode and the environment inherited by workers later in the boot.
const {
  environment: sentryEnvironment,
  isDevelopment: isDev,
  devTaggedAsProduction,
} = resolveSentryRuntime({
  ENVIRONMENT: process.env.ENVIRONMENT,
  NODE_ENV: process.env.NODE_ENV,
});
if (dsn && devTaggedAsProduction) {
  console.error(
    '[instrument] ENVIRONMENT=production with NODE_ENV=development — tagging local Sentry events as development instead of polluting prod'
  );
}

if (dsn) {
  Sentry.init({
    dsn,
    // Default to 'development', NOT 'production'. Prod deployments set ENVIRONMENT
    // explicitly (charts/lobu), so the only stacks that hit this fallback are
    // local/dev/example ones that happen to carry a SENTRY_DSN. A non-prod
    // default keeps the production environment filter trustworthy.
    environment: sentryEnvironment,
    release: process.env.SENTRY_RELEASE || process.env.APP_GIT_SHA || undefined,
    // 0.1 produced ~250k spans/day (~7.5M/mo) and exhausted the plan's 5M span
    // quota by day ~20 of the usage period. 0.02 keeps ~50k/day (~1.5M/mo) —
    // comfortably inside quota with headroom for growth. Errors are unaffected
    // (sampleRate below governs those).
    tracesSampleRate: isDev ? 1.0 : 0.02,
    // Error events: capture 100%. Error volume is low (~5/day) so there's no
    // quota pressure, and the captureMessage spam that once motivated 0.5
    // sampling was removed (runs-queue.ts). Sampling rare provider/model
    // failures at 0.5 risked dropping the single occurrence that matters. If
    // quota ever becomes a concern, prefer a fingerprint-level beforeSend that
    // keeps run/provider/worker errors at 100% and samples only high-volume
    // validation noise.
    sampleRate: 1.0,
    beforeSend: scrubSentryErrorEvent,
    beforeSendTransaction: scrubSentryTransactionEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
    // The NodeSystemError integration calls util.getSystemErrorMap(), which
    // some Node builds we run under (notably v24.x in our app image) don't
    // expose. The integration itself then throws inside the event processor
    // and the underlying exception never reaches Sentry. Drop it. (Sentry:
    // LOBU-36.)
    integrations: (defaults) => defaults.filter((i) => i.name !== 'NodeSystemError'),
  });
}

// ── Event-loop stall detector ────────────────────────────────────────────────
// The "worker stopped responding" incident was a ~70s event-loop freeze that we
// could only reverse-engineer from gaps in the ping/`/health` logs — there was
// no instrumentation to TAG the stall with its real duration or cause. This
// closes that gap: a native perf_hooks delay monitor whose `max` we sample
// periodically. A hard synchronous block stops the sampling timer too, so the
// tick that fires AFTER the block sees the accumulated `max` — that's the stall
// duration. On a stall past the threshold we log loudly and (if Sentry is
// configured) capture a tagged message so the next freeze names itself instead
// of being reconstructed from ping gaps. Zero new deps; the timer is unref'd so
// it never keeps the process alive.
{
  const thresholdMs = Number.parseInt(
    process.env.LOBU_EVENT_LOOP_STALL_MS || '2000',
    10
  );
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const timer = setInterval(() => {
    const maxMs = h.max / 1e6; // nanoseconds → ms
    if (maxMs >= thresholdMs) {
      const rounded = Math.round(maxMs);
      // Loud log so it's visible in pod logs even without Sentry.
      console.error(
        `[event-loop] STALL detected: loop blocked ~${rounded}ms ` +
          `(threshold ${thresholdMs}ms). The loop could not run timers/IO for ` +
          `this long — a synchronous block, GC pause, or CPU starvation.`
      );
      if (dsn) {
        Sentry.captureMessage(`Event loop stalled ~${rounded}ms`, {
          level: 'warning',
          tags: { subsystem: 'event-loop', stall: 'true' },
          extra: {
            stallMs: rounded,
            thresholdMs,
            p99Ms: Math.round(h.percentile(99) / 1e6),
            meanMs: Math.round(h.mean / 1e6),
          },
        });
      }
    }
    h.reset(); // reset the window so each tick reports only the latest interval
  }, 1000);
  timer.unref();
}
