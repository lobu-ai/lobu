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
    const threadId = platformMetadataString(payload.platformMetadata, "responseThreadId")
      ?? payload.conversationId;
    if (!threadId?.startsWith("gchat:")) {
      throw new QueueTerminalError("Google Chat completion has no originating thread");
    }
    const adapter: Pick<LobuGoogleChatAdapter, "postTerminalReply"> = ctx.instance.chat.getAdapter("gchat");
    const deliveryKey = JSON.stringify([ctx.connectionId, payload.messageId, payload.turnRunId]);
    await adapter.postTerminalReply(threadId, payload.finalText, deliveryKey);
  },
};
