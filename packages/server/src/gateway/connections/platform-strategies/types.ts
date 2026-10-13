/**
 * Shared types for platform response strategies. Split out of `./index.ts`
 * so platform-specific strategy modules (e.g. `./slack.ts`) can import them
 * without a circular module dependency on the registry.
 */

import type { ThreadResponsePayload } from "../../infrastructure/queue/index.js";
import type { AsyncPushIterator } from "./async-push-iterator.js";

export interface StreamState {
  iterator: AsyncPushIterator<string>;
  streamPromise: Promise<unknown>;
  /** Accumulated text — kept only so handleCompletion can persist it to history. */
  buffer: string;
  /** Set when the adapter's streaming API rejected. Completion posts the buffer. */
  streamFailed: boolean;
  /**
   * True once the worker has sent at least one delta with `isFullReplacement=true`.
   * A full replacement is a complete, self-contained user-facing message
   * (e.g. the worker's own "❌ Session failed: …" text). When this is set,
   * `handleError` must NOT post its fallback `"Error: …"` text, because the
   * user has already seen a formatted failure message.
   *
   * Partial-only streams (worker streamed incremental deltas and then errored)
   * leave this false so the fallback still fires and the user sees a failure
   * indicator instead of silently-truncated output.
   */
  wasFullyReplaced: boolean;
  /** The resolved Chat SDK target — reused on failure fallback without a second resolveTarget call. */
  target: any;
}

export interface StrategyContext {
  connectionId: string;
  instance: any;
  channelId: string;
  platform: string;
}

/**
 * How the strategy wants the bridge to resolve a Chat SDK target. Passed as a
 * callback so the bridge keeps sole ownership of target resolution and we
 * don't duplicate that logic per strategy.
 */
export type ResolveTarget = () => Promise<any | null>;

export interface PlatformResponseStrategy {
  /**
   * Handle `isFullReplacement=true` when there is an existing stream.
   *
   * The default strategy must close the live iterator and await the adapter's
   * streamPromise so the in-flight post resolves before a new one opens.
   * Slack never opens a real stream, so it just discards the buffer.
   *
   * Returning means the caller should treat `existing` as disposed and pass
   * `undefined` to the subsequent `handleDelta` call.
   */
  disposeOnFullReplacement(existing: StreamState): Promise<void>;

  /**
   * Handle a delta payload.
   *
   * - If `existing` is `undefined`, the strategy opens a new stream.
   * - Otherwise it appends to the existing stream.
   *
   * Returns the next `StreamState` (or `null` if a fresh stream could not be
   * opened). The bridge keys the returned state by channel/conversation.
   */
  handleDelta(args: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    existing: StreamState | undefined;
    resolveTarget: ResolveTarget;
  }): Promise<StreamState | null>;

  /**
   * Handle completion. For a live-streaming strategy this runs after the
   * bridge has closed the stream's iterator and awaited the adapter's
   * streamPromise. `stream` is `null` when no local streaming state exists on
   * this replica — under N>1 replicas the delta rows can be claimed by a
   * different pod than the terminal row (the `thread_response` queue is drained
   * competitively with no per-conversation affinity), so a post-once strategy
   * must render from `payload.finalText` instead. Post-once strategies should
   * therefore prefer `payload.finalText` over `stream.buffer` even when a local
   * stream exists, because that buffer may hold only the subset of deltas this
   * pod happened to claim.
   */
  handleCompletion(args: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    stream: StreamState | null;
  }): Promise<void>;

  /**
   * True when the strategy delivers the reply only at completion from the full
   * text (no live streaming to the platform during deltas) — i.e. Slack, which
   * buffers deltas and posts once via `chat.postMessage`. Such strategies can
   * render from `payload.finalText` with no local stream (a different replica
   * claimed the deltas), since nothing was posted on any other replica. Live-
   * streaming strategies set this false: their deltas already posted on the
   * streaming replica, so re-posting the final text from another replica would
   * duplicate — and a row with no local stream is simply nothing left to do.
   */
  readonly deliversAtCompletion: boolean;

  /**
   * Deliver one bridge-originated post for this payload (error, guardrail
   * notice, ephemeral). Optional: without it the bridge posts through the
   * resolved Chat SDK target. A transport whose send is not idempotent
   * implements it so a redelivered payload adopts the first send.
   */
  post?(args: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    content: unknown;
  }): Promise<void>;
}
