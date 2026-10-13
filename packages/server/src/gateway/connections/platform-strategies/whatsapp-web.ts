import { createHash } from "node:crypto";
import type { AdapterPostableMessage } from "chat";
import { stripPlatformPrefix } from "../../channels/bound-channels.js";
import type { ThreadResponsePayload } from "../../infrastructure/queue/index.js";
import { platformMetadataString } from "../platform-metadata.js";
import {
  WHATSAPP_WEB_PLATFORM,
  type WhatsAppWebAdapter,
} from "../platforms/whatsapp-web-adapter.js";
import type { PlatformResponseStrategy, StrategyContext } from "./types.js";

/**
 * Device sends cannot be edited or safely retried with a fresh operation key,
 * so every post is keyed by the message it answers and its content: a retry
 * adopts the first send's operation (including a pending approval or an
 * ambiguous failure) instead of dispatching another, while different posts
 * for the same message stay distinct.
 */
async function postOnce(
  ctx: StrategyContext,
  target: string,
  messageId: string,
  content: AdapterPostableMessage
): Promise<void> {
  const adapter = ctx.instance.chat.getAdapter(
    WHATSAPP_WEB_PLATFORM
  ) as WhatsAppWebAdapter;
  // Same canonical spelling `resolveChatTarget` uses; the adapter refuses a
  // thread that belongs to another connection.
  const threadId = `${WHATSAPP_WEB_PLATFORM}:${stripPlatformPrefix(WHATSAPP_WEB_PLATFORM, target)}`;
  const contentHash = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  await adapter.postMessage(
    threadId,
    content,
    `chat-post:${ctx.connectionId}:${messageId}:${contentHash}`
  );
}

/** The thread a turn's terminal text answers in. */
function responseThread(ctx: StrategyContext, payload: ThreadResponsePayload): string {
  return platformMetadataString(payload.platformMetadata, "responseThreadId") ?? ctx.channelId;
}

export const whatsappWebResponseStrategy: PlatformResponseStrategy = {
  deliversAtCompletion: true,
  async disposeOnFullReplacement() {},
  // Deltas can land on different replicas; only the terminal text is complete.
  async handleDelta() {
    return null;
  },
  async handleCompletion({ ctx, payload }) {
    const text = payload.finalText;
    if (!text?.trim()) return;
    await postOnce(ctx, responseThread(ctx, payload), payload.messageId, { markdown: text });
  },
  post({ ctx, threadId, messageId, content }) {
    return postOnce(ctx, threadId, messageId, content as AdapterPostableMessage);
  },
};
