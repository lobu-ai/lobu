/**
 * Platform response strategies for the Chat SDK bridge.
 *
 * Each strategy encapsulates the platform-specific quirks of streaming text
 * responses back to the user (e.g. Slack posts at completion via
 * `markdown_text`, most other platforms stream deltas through the Chat SDK).
 *
 * `ChatResponseBridge` picks one strategy per payload based on the platform
 * field and delegates the delta/completion shape to it, so the bridge never
 * branches on a platform slug to stream a response. Platform-specific
 * strategies live in sibling modules (`./slack.ts`); this module owns the
 * platform-clean default strategy and the lookup.
 *
 * This registry covers RESPONSE STREAMING only. The other per-platform
 * differences the gateway needs — channel-id and label spelling, credential
 * requirements, the unlinked-chat notice — hang off `ChatPlatformDescriptor`
 * in `../platforms/`; add a new one there, not here.
 */

import { createLogger } from "@lobu/core";
import type { ThreadResponsePayload } from "../../infrastructure/queue/index.js";
import { AsyncPushIterator } from "./async-push-iterator.js";
import { SlackResponseStrategy } from "./slack.js";
import type {
  PlatformResponseStrategy,
  ResolveTarget,
  StrategyContext,
  StreamState,
} from "./types.js";

const logger = createLogger("platform-response-strategies");

export type {
  PlatformResponseStrategy,
  StrategyContext,
  StreamState,
} from "./types.js";

/**
 * Default strategy: stream deltas straight through the Chat SDK's
 * `target.post(AsyncIterable)` path. Used for Telegram and anything without
 * platform-specific buffering requirements.
 */
class DefaultResponseStrategy implements PlatformResponseStrategy {
  // Streams live to the platform during deltas — the reply is already posted
  // on the replica that streamed it, so no cross-replica completion fallback.
  readonly deliversAtCompletion = false;

  async disposeOnFullReplacement(existing: StreamState): Promise<void> {
    // Close current stream and await delivery so a new one can open cleanly.
    existing.iterator.close();
    try {
      await existing.streamPromise;
    } catch (error) {
      logger.debug(
        { error: String(error) },
        "Prior stream failed during full-replacement flush"
      );
    }
  }

  async handleDelta({
    ctx,
    payload,
    existing,
    resolveTarget,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    existing: StreamState | undefined;
    resolveTarget: ResolveTarget;
  }): Promise<StreamState | null> {
    const { connectionId, channelId } = ctx;

    if (!existing) {
      // First delta — open a new stream
      try {
        const target = await resolveTarget();
        if (!target) {
          logger.warn(
            { connectionId, channelId },
            "Failed to resolve target for delta — dropping"
          );
          return null;
        }

        const iterator = new AsyncPushIterator<string>();
        iterator.push(payload.delta as string);
        // target.post(AsyncIterable) — the adapter owns throttling + chunking.
        const newStream: StreamState = {
          iterator,
          streamPromise: Promise.resolve(),
          buffer: payload.delta as string,
          streamFailed: false,
          wasFullyReplaced: !!payload.isFullReplacement,
          target,
        };
        newStream.streamPromise = Promise.resolve(
          target.post(iterator as any)
        ).catch((error: unknown) => {
          newStream.streamFailed = true;
          logger.warn(
            { connectionId, error: String(error) },
            "Adapter stream failed — will post buffered text on completion"
          );
        });
        return newStream;
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to open delta stream"
        );
        return null;
      }
    }

    // Subsequent delta — push into the live iterator
    existing.iterator.push(payload.delta as string);
    existing.buffer += payload.delta as string;
    return existing;
  }

  async handleCompletion({
    ctx,
    stream,
  }: {
    ctx: StrategyContext;
    payload: ThreadResponsePayload;
    stream: StreamState | null;
  }): Promise<void> {
    const { connectionId, channelId } = ctx;
    // No local stream means this replica never claimed any delta rows for the
    // run. A live-streaming strategy has nothing buffered to flush and must not
    // re-post from finalText (deltas already streamed on the claiming replica),
    // so there is nothing to do here. The bridge gates on deliversAtCompletion
    // and won't normally call us stream-less; guard defensively regardless.
    if (!stream) return;
    if (stream.streamFailed && stream.buffer.trim() && stream.target) {
      // Fallback: when native streaming rejected (e.g. Slack's chatStream
      // requires a recipient user/team id that the public-API send path
      // can't supply), post the accumulated buffer non-streaming so the
      // response still lands in the thread instead of being silently dropped.
      try {
        await stream.target.post(stream.buffer);
        logger.info(
          { connectionId, channelId },
          "Posted buffered response via non-streaming fallback"
        );
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Non-streaming fallback post failed"
        );
      }
    }
  }
}

const slackStrategy = new SlackResponseStrategy();
const defaultStrategy = new DefaultResponseStrategy();

export function getResponseStrategy(
  platform: string
): PlatformResponseStrategy {
  switch (platform) {
    case "slack":
      return slackStrategy;
    default:
      return defaultStrategy;
  }
}
