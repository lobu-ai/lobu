/**
 * Regression test for lobu-ai/lobu#782: SSE keepalive timer + emitter listener
 * must be torn down when the underlying request aborts, not only when the
 * `ReadableStream.cancel()` callback fires.
 *
 * Reproduces the abnormal-disconnect path by:
 *   1. Wiring an AbortController as `c.req.raw.signal`.
 *   2. Letting the stream start (registers the listener + interval).
 *   3. Aborting without ever consuming or cancelling the stream.
 *   4. Asserting the listener stops receiving events and the interval is cleared.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as invalidationEmitter from '../../events/emitter';
import { streamInvalidationEvents } from '../../events/sse';

function buildContext(signal: AbortSignal) {
  return {
    req: { raw: { signal } },
    header: () => {},
    body: (stream: ReadableStream) => new Response(stream),
  };
}

describe('streamInvalidationEvents cleanup', () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<unknown>();
  let restoreListener = () => {};

  beforeEach(() => {
    // This suite exercises socket cleanup; cross-process subscription and
    // failure/retry paths have their own tests.
    const listener = spyOn(invalidationEmitter, 'ensureInvalidationListener').mockResolvedValue(undefined);
    restoreListener = () => listener.mockRestore();
    activeTimers.clear();
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const handle = originalSetInterval(fn, ms);
      activeTimers.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: unknown) => {
      activeTimers.delete(handle);
      return originalClearInterval(handle as Parameters<typeof clearInterval>[0]);
    }) as typeof clearInterval;
  });

  afterEach(() => {
    restoreListener();
    for (const handle of activeTimers) {
      originalClearInterval(handle as Parameters<typeof clearInterval>[0]);
    }
    activeTimers.clear();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  it('tears down listener + interval when the request signal aborts (no cancel())', async () => {
    const orgId = 'org-abort-' + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    const ctx = buildContext(ctrl.signal);

    const response = streamInvalidationEvents(
      ctx as unknown as Parameters<typeof streamInvalidationEvents>[0],
      orgId
    );
    // Pull the handshake frame so start() has fully run.
    const reader = response.body!.getReader();
    await reader.read();

    expect(activeTimers.size).toBe(1);

    // Sanity: while subscribed, an emit on this org reaches a probe co-listener.
    let probeHits = 0;
    const unsubProbe = invalidationEmitter.subscribe(orgId, () => {
      probeHits++;
    });
    invalidationEmitter.emit(orgId, { keys: ['x'] });
    expect(probeHits).toBe(1);
    unsubProbe();

    // Simulate abnormal disconnect: socket aborted, no cancel().
    ctrl.abort();

    // Abort handler is synchronous; cleanup should have run.
    expect(activeTimers.size).toBe(0);

    // After cleanup, the stream's listener is gone — the emitter map should
    // no longer carry an entry for this org (subscribe() with size==0 path
    // deletes the key after unsubscribe).
    let secondProbeHits = 0;
    const unsubProbe2 = invalidationEmitter.subscribe(orgId, () => {
      secondProbeHits++;
    });
    invalidationEmitter.emit(orgId, { keys: ['y'] });
    expect(secondProbeHits).toBe(1); // only the probe sees it
    unsubProbe2();
  });

  it('cleanup is idempotent across abort + cancel()', async () => {
    const orgId = 'org-both-' + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    const ctx = buildContext(ctrl.signal);

    const response = streamInvalidationEvents(
      ctx as unknown as Parameters<typeof streamInvalidationEvents>[0],
      orgId
    );
    const reader = response.body!.getReader();
    await reader.read();

    expect(activeTimers.size).toBe(1);

    ctrl.abort();
    await reader.cancel().catch(() => {});

    // Either path tearing down twice must not throw and must leave 0 timers.
    expect(activeTimers.size).toBe(0);
  });

  it('cleans up when client cancels before abort', async () => {
    const orgId = 'org-cancel-' + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    const ctx = buildContext(ctrl.signal);

    const response = streamInvalidationEvents(
      ctx as unknown as Parameters<typeof streamInvalidationEvents>[0],
      orgId
    );
    const reader = response.body!.getReader();
    await reader.read();

    expect(activeTimers.size).toBe(1);

    await reader.cancel();

    expect(activeTimers.size).toBe(0);
  });

  it('calls the emitter unsubscribe exactly once on abort', async () => {
    // Pi-review nit #1: prove the stream's invalidation listener is
    // unsubscribed, not just that an unrelated probe still receives events.
    // Spy on subscribe so we can attribute the returned unsubscribe to the
    // stream and count its invocations.
    const realSubscribe = invalidationEmitter.subscribe;
    let unsubscribeCalls = 0;
    const subscribeSpy = spyOn(invalidationEmitter, 'subscribe').mockImplementation(
      (organizationId, listener) => {
        const inner = realSubscribe(organizationId, listener);
        return () => {
          unsubscribeCalls++;
          inner();
        };
      }
    );

    try {
      const orgId = 'org-unsub-' + Math.random().toString(36).slice(2);
      const ctrl = new AbortController();
      const ctx = buildContext(ctrl.signal);

      const response = streamInvalidationEvents(
        ctx as unknown as Parameters<typeof streamInvalidationEvents>[0],
        orgId
      );
      const reader = response.body!.getReader();
      await reader.read();

      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      expect(unsubscribeCalls).toBe(0);

      ctrl.abort();

      expect(unsubscribeCalls).toBe(1);

      // Idempotent: a follow-up cancel must NOT re-call unsubscribe.
      await reader.cancel().catch(() => {});
      expect(unsubscribeCalls).toBe(1);
    } finally {
      subscribeSpy.mockRestore();
    }
  });

  it('does not register a listener or interval if the request is already aborted', async () => {
    // Pi-review nit #2: cover the early-aborted-signal branch in
    // streamInvalidationEvents.start(). With a pre-aborted signal, start()
    // must close the controller without ever calling subscribe() or
    // setInterval().
    const subscribeSpy = spyOn(invalidationEmitter, 'subscribe');

    try {
      const orgId = 'org-preaborted-' + Math.random().toString(36).slice(2);
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = buildContext(ctrl.signal);

      const response = streamInvalidationEvents(
        ctx as unknown as Parameters<typeof streamInvalidationEvents>[0],
        orgId
      );
      const reader = response.body!.getReader();
      // The stream should be closed immediately; first read resolves done.
      const result = await reader.read();
      expect(result.done).toBe(true);

      expect(subscribeSpy).not.toHaveBeenCalled();
      expect(activeTimers.size).toBe(0);
    } finally {
      subscribeSpy.mockRestore();
    }
  });
});
