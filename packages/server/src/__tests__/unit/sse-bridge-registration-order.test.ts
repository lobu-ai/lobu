/**
 * Regression tests for the race windows that PR #845 missed (codex audit):
 *
 *   1. `gateway/routes/public/agent.ts` — the agent events SSE route did
 *      `sseManager.addConnection(...)` + initial `writeSSE`/backlog writes
 *      BEFORE wiring `stream.onAbort(cleanup)` and the abort bridge. An abort
 *      in that window leaked the manager registration.
 *   2. `mcp-handler.ts` — `withSSEHeartbeat` wrapped the SSE response with a
 *      heartbeat `setInterval` but never bound the inbound request's
 *      `AbortSignal`. Abnormal disconnects (LB timeout, proxy kill, client
 *      hard-close) left the interval running forever.
 *
 * A third covered `WorkerGateway.handleStreamConnection` registering into
 * `WorkerConnectionManager`. Both are deleted — the worker SSE reverse channel
 * is gone — so that case went with them.
 *
 * The fix in each spot is the same shape:
 *   - Register an idempotent cleanup latch FIRST.
 *   - Bind the per-request `AbortSignal` via `bindRequestAbortToStream` SECOND.
 *   - Do the async / writer setup LAST.
 *   - Cleanup must be safe to run before the registration completes.
 *
 * These tests exercise the latch shape directly rather than building a full
 * Hono integration harness — the route handlers wire the same primitives and
 * call the same manager surfaces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { bindRequestAbortToStream } from '../../events/sse-abort-bridge';
import { withSSEHeartbeat } from '../../mcp-handler';

// ---------------------------------------------------------------------------
// Finding 1 — agent.ts SseManager registration-order latch
// ---------------------------------------------------------------------------

function fakeSseManager() {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  return {
    addConnection(key: string, stream: unknown) {
      added.push({ key, stream });
    },
    removeConnection(key: string, stream: unknown) {
      removed.push({ key, stream });
    },
    get state() {
      return { added: [...added], removed: [...removed] };
    },
  };
}

describe('agent SSE route — registration-order latch', () => {
  it('removes from SseManager when abort fires during initial backlog writes', async () => {
    // Mirrors `packages/server/src/gateway/routes/public/agent.ts` — the
    // events route's idempotent cleanup latch + abort bridge.
    const manager = fakeSseManager();
    const ctrl = new AbortController();
    const stream = { id: 'stream-X', aborted: false, closed: false };
    const subscribers: Array<() => void> = [];

    let connectionAdded = false;
    let cleanedUp = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (connectionAdded) manager.removeConnection('sk-X', stream);
    };

    // Cleanup wired FIRST.
    subscribers.push(cleanup);
    const detach = bindRequestAbortToStream(ctrl.signal, {
      get aborted() {
        return cleanedUp;
      },
      get closed() {
        return cleanedUp;
      },
      abort() {
        for (const s of subscribers) s();
      },
    });

    manager.addConnection('sk-X', stream);
    connectionAdded = true;

    // Simulate the initial writeSSE await window — abort fires here.
    const initialWritePromise = (async () => {
      await new Promise((r) => setTimeout(r, 5));
    })();
    ctrl.abort();
    await initialWritePromise;
    detach();

    expect(manager.state.added.length).toBe(1);
    expect(manager.state.removed.length).toBe(1);
  });

  it('skips manager.removeConnection if abort fires before addConnection', () => {
    const manager = fakeSseManager();
    const ctrl = new AbortController();
    const subscribers: Array<() => void> = [];

    let connectionAdded = false;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (connectionAdded) manager.removeConnection('sk-Y', {});
    };

    subscribers.push(cleanup);
    bindRequestAbortToStream(ctrl.signal, {
      get aborted() {
        return cleanedUp;
      },
      get closed() {
        return cleanedUp;
      },
      abort() {
        for (const s of subscribers) s();
      },
    });

    ctrl.abort(); // before any addConnection call

    expect(manager.state.added).toEqual([]);
    expect(manager.state.removed).toEqual([]);
    expect(cleanedUp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — withSSEHeartbeat must clear the interval on abrupt abort
// ---------------------------------------------------------------------------

describe('withSSEHeartbeat — abort signal clears heartbeat interval', () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<unknown>();

  beforeEach(() => {
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
    for (const handle of activeTimers) {
      originalClearInterval(handle as Parameters<typeof clearInterval>[0]);
    }
    activeTimers.clear();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  it('clears the heartbeat interval when the inbound request signal aborts', async () => {
    // Build an SSE source that never ends so the heartbeat interval stays
    // live indefinitely. Without the abort-signal wiring in
    // `withSSEHeartbeat` the test would time out — the interval would keep
    // firing past the abort because the source pipe never closes.
    const ctrl = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: connected\ndata: {}\n\n'));
        // Intentionally never close — simulate a long-lived MCP SSE stream.
      },
    });

    const response = new Response(source, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const wrapped = withSSEHeartbeat(response, ctrl.signal);

    // Pull the first chunk so the pipe is hot and the interval is live.
    const reader = wrapped.body!.getReader();
    await reader.read();
    expect(activeTimers.size).toBeGreaterThanOrEqual(1);

    ctrl.abort();

    // Wait for the abort-bridge -> abortWriter path to clear the interval.
    const deadline = Date.now() + 500;
    while (activeTimers.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(activeTimers.size).toBe(0);

    // Drain the reader so the test doesn't leak.
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  });

  it('does not leave a live interval when the signal is already aborted at bind time', async () => {
    // Regression for the codex audit follow-up: pre-aborted requests should not
    // create heartbeat state that can survive after the request is already gone.
    const ctrl = new AbortController();
    ctrl.abort();

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: connected\ndata: {}\n\n'));
      },
    });
    const response = new Response(source, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const wrapped = withSSEHeartbeat(response, ctrl.signal);

    // Give the pre-abort bind a microtask to fire.
    await new Promise((r) => setTimeout(r, 0));

    expect(activeTimers.size).toBe(0);

    // Drain (will be empty or aborted; either way no leak).
    try {
      const reader = wrapped.body!.getReader();
      await reader.cancel();
    } catch {
      /* ignore */
    }
  });

  it('passes through normal close path (no abort signal) without leaking', async () => {
    // Sanity check: the abort-bridge code path must not break the existing
    // pipe-close cleanup that PR #845's predecessor relied on.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: connected\ndata: {}\n\n'));
        controller.close();
      },
    });
    const response = new Response(source, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const wrapped = withSSEHeartbeat(response);
    const reader = wrapped.body!.getReader();
    // Drain until EOF.
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    // After source closes, the heartbeat interval should be cleared.
    const deadline = Date.now() + 500;
    while (activeTimers.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(activeTimers.size).toBe(0);
  });
});
