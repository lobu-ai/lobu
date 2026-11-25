import { QueueTerminalError } from "../../infrastructure/queue/types.js";
import { platformMetadataString } from "../platform-metadata.js";
import type { LobuGoogleChatAdapter } from "../platforms/gchat-adapter.js";
import type { PlatformResponseStrategy } from "./types.js";

export const googleChatResponseStrategy: PlatformResponseStrategy = {
  deliversAtCompletion: true,
  async disposeOnFullReplacement() {},
  async handleDelta() { return null; },
  async handleCompletion({ ctx, payload }) {
    if (!payload.finalText?.trim()) return;
    const replyThread = platformMetadataString(payload.platformMetadata, "responseThreadId");
    // The authenticated platform API can explicitly target a space instead of
    // answering an incoming message. Only that route may post without a thread.
    const spaceTarget = !replyThread && payload.platformMetadata?.source === "platform-cli" &&
      payload.conversationId === payload.channelId;
    const conversationId = payload.conversationId;
    const threadId = replyThread ?? (spaceTarget && !conversationId.startsWith("gchat:")
      ? `gchat:${conversationId}`
      : conversationId);
    if (!threadId?.startsWith("gchat:")) {
      throw new QueueTerminalError("Google Chat completion has no originating thread");
    }
    const adapter: Pick<LobuGoogleChatAdapter, "postTerminalReply"> = ctx.instance.chat.getAdapter("gchat");
    const deliveryKey = JSON.stringify([ctx.connectionId, payload.messageId, payload.turnRunId]);
    await adapter.postTerminalReply(threadId, payload.finalText, deliveryKey, spaceTarget);
  },
};
