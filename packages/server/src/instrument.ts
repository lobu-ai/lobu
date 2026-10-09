/** Early diagnostics: load configuration and install the fatal boundary before boot. */
import dotenv from 'dotenv';
import { writeSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { scrubDiagnosticValue } from '@lobu/core';
import { resolveDiagnosticRuntime } from './utils/runtime-info';

// This entry point runs before the server graph reads configuration.
dotenv.config();

// Do not continue after an uncaught exception. A synchronous write preserves
// the sanitized stack even when an immediate exit would drop buffered stdout.
// Node also routes unhandled rejections here under its default throw policy.
process.on('uncaughtException', (error, origin) => {
  try {
    writeSync(1, `${JSON.stringify(scrubDiagnosticValue({
      level: 'fatal', service: 'lobu-server', source: origin,
      time: Date.now(), release: process.env.APP_GIT_SHA,
      environment: resolveDiagnosticRuntime().environment,
      msg: 'Process terminated by an unhandled error', error,
    }))}\n`);
  } catch {
    // Never emit the original, potentially credential-bearing error as fallback.
    try { writeSync(2, '{"level":"fatal","msg":"Fatal diagnostic could not be serialized safely"}\n'); } catch {}
  } finally {
    process.exit(1);
  }
});

// ── Event-loop stall detector ────────────────────────────────────────────────
// The "worker stopped responding" incident was a ~70s event-loop freeze that we
// could only reverse-engineer from gaps in the ping/`/health` logs — there was
// no instrumentation to TAG the stall with its real duration or cause. This
// closes that gap: a native perf_hooks delay monitor whose `max` we sample
// periodically. A hard synchronous block stops the sampling timer too, so the
// tick that fires AFTER the block sees the accumulated `max` — that's the stall
// duration. On a stall past the threshold we emit a structured diagnostic
// so the next freeze can be diagnosed without reconstructing ping gaps.
// The timer is unref'd so
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
      // The collector ingests this structured record from pod logs.
      console.error(JSON.stringify({
        level: 'warn', service: 'lobu-server', source: 'event-loop',
        release: process.env.APP_GIT_SHA,
        msg: 'Event loop stalled', stallMs: rounded, thresholdMs,
        p99Ms: Math.round(h.percentile(99) / 1e6),
        meanMs: Math.round(h.mean / 1e6),
      }));
    }
    h.reset(); // reset the window so each tick reports only the latest interval
  }, 1000);
  timer.unref();
}
