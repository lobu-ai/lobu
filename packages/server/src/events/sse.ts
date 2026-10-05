/**
 * SSE helper for invalidation event streams.
 *
 * Both the org-scoped (`/api/:orgSlug/events`) and the public
 * (`/api/:orgSlug/public/events`) streams previously bound cleanup only to
 * `ReadableStream.cancel()`. Under abnormal disconnects (LB timeout, proxy
 * kill, client hard close) `cancel()` does not always fire — the keepalive
 * `setInterval` keeps running and the emitter listener stays registered,
 * leaking memory + descriptors. Issue lobu-ai/lobu#782.
 *
 * Fix: bind cleanup to the per-request abort signal (`c.req.raw.signal`),
 * which fires on socket close regardless of stream-cancel semantics. Keep
 * `cancel()` as a redundant trigger; both routes through an idempotent
 * `runCleanup()` so the second one is a no-op.
 */
import type { Context } from 'hono';
import * as invalidationEmitter from './emitter';
import type { InvalidationEvent } from './emitter';

interface StreamOptions {
  /** Optional filter; return `null` to drop the event for this subscriber. */
  filter?: (event: InvalidationEvent) => InvalidationEvent | null;
}

const KEEPALIVE_INTERVAL_MS = 30000;
const CONNECTED_FRAME = 'event: connected\ndata: {}\n\n';

export function streamInvalidationEvents(
  c: Context,
  organizationId: string,
  options: StreamOptions = {}
): Response {
  const encoder = new TextEncoder();
  const requestSignal = c.req.raw.signal;

  let cleanedUp = false;
  let cleanup: (() => void) | null = null;
  let onAbort: (() => void) | null = null;

  const runCleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (onAbort && requestSignal) {
      requestSignal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
    cleanup?.();
    cleanup = null;
  };

  const stream = new ReadableStream({
    async start(controller) {
      // Subscribe this replica to peer NOTIFYs before telling the client it is
      // connected: the client re-reads durable state on `connected`, so any
      // write after that read must reach this stream.
      await invalidationEmitter.ensureInvalidationListener();

      // If the client already aborted or cancelled between handler invocation
      // and here, bail out immediately rather than registering a leaking listener.
      if (requestSignal?.aborted || cleanedUp) {
        try {
          controller.close();
        } catch {
          // already closed
        }
        return;
      }

      controller.enqueue(encoder.encode(CONNECTED_FRAME));

      const unsubscribe = invalidationEmitter.subscribe(organizationId, (event) => {
        if (event.resync) {
          // This replica's listener reconnected and may have missed
          // invalidations; `connected` makes the client re-read.
          try {
            controller.enqueue(encoder.encode(CONNECTED_FRAME));
          } catch {
            // Controller closed — abort/cancel will tear down.
          }
          return;
        }
        const forwarded = options.filter ? options.filter(event) : event;
        if (!forwarded) return;
        try {
          const data = JSON.stringify(forwarded);
          controller.enqueue(encoder.encode(`event: invalidate\ndata: ${data}\n\n`));
        } catch {
          // Controller closed — fall through; abort/cancel will tear down.
        }
      });

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          // Controller closed — cancel/abort will tear down.
        }
      }, KEEPALIVE_INTERVAL_MS);

      cleanup = () => {
        unsubscribe();
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // already closed by cancel()
        }
      };

      onAbort = () => runCleanup();
      requestSignal?.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      runCleanup();
    },
  });

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return c.body(stream);
}
