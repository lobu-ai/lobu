import { createHash } from "node:crypto";
import { GoogleChatAdapter } from "@chat-adapter/gchat";
import { convertEmojiPlaceholders } from "chat";
import { createLogger } from "@lobu/core";
import { QueueTerminalError } from "../../infrastructure/queue/types.js";

const logger = createLogger("gchat-delivery");
// Google limits the entire create request to 32,000 bytes, including its JSON.
const MAX_REPLY_TEXT_BYTES = 30_000;

function* replyParts(text: string): Generator<string> {
  if (Buffer.byteLength(JSON.stringify(text)) - 2 <= MAX_REPLY_TEXT_BYTES) {
    if (text) yield text;
    return;
  }
  let part = "";
  let bytes = 0;
  for (const character of text) {
    // Also account for control characters and quotes escaped by JSON.
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > MAX_REPLY_TEXT_BYTES) {
      yield part;
      part = "";
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part) yield part;
}

function createFailure(error: unknown): Error {
  // Gaxios errors may carry the authenticated request. Retain only its HTTP
  // status in the error passed to the durable queue.
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  const message = typeof status === "number"
    ? `Google Chat reply failed (HTTP ${status})`
    : "Google Chat reply receipt was unavailable";
  return status === 400 || status === 401 || status === 403 || status === 404
    ? new QueueTerminalError(message)
    : new Error(message);
}

export class LobuGoogleChatAdapter extends GoogleChatAdapter {
  async postTerminalReply(threadId: string, markdown: string, deliveryKey: string, spaceTarget = false): Promise<void> {
    const target = this.decodeThreadId(threadId);
    const { spaceName, isDM } = target;
    if (this.encodeThreadId(target) !== threadId || !/^spaces\/[\w-]+$/.test(spaceName)) {
      throw new QueueTerminalError("Google Chat reply has no valid space");
    }
    let threadName = target.threadName;
    const resource = threadName?.slice(spaceName.length);
    if (threadName?.startsWith(`${spaceName}/messages/`) && /^\/messages\/[\w-][\w.-]*$/.test(resource ?? "")) {
      // The SDK uses the original message resource when a webhook omits its
      // thread. Ask Google for the exact thread attached to that message.
      const original = await this.chatApi.spaces.messages.get({ name: threadName, fields: "thread" })
        .catch((error: unknown) => { throw createFailure(error); });
      threadName = original.data.thread?.name ?? undefined;
    }
    if ((target.threadName || (!isDM && !spaceTarget)) &&
        (!threadName?.startsWith(`${spaceName}/threads/`) ||
          !/^\/threads\/[\w-][\w.-]*$/.test(threadName.slice(spaceName.length)))) {
      throw new QueueTerminalError("Google Chat reply has no valid originating thread");
    }

    const text = convertEmojiPlaceholders(this.formatConverter.renderPostable({ markdown }), "gchat");
    let partIndex = 0;
    for (const part of replyParts(text)) {
      const requestId = createHash("sha256").update(JSON.stringify([deliveryKey, threadId, partIndex])).digest("hex");
      const receipt = await this.chatApi.spaces.messages.create({
        parent: spaceName,
        requestId,
        messageReplyOption: threadName ? "REPLY_MESSAGE_OR_FAIL" : undefined,
        requestBody: { text: part, thread: threadName ? { name: threadName } : undefined },
      }).catch((error: unknown) => { throw createFailure(error); });
      if (!receipt.data.name?.startsWith(`${spaceName}/messages/`)) {
        throw new Error("Google Chat reply receipt did not identify a message");
      }
      logger.info({ requestId, messageName: receipt.data.name }, "Google Chat accepted reply");
      partIndex++;
    }
  }
}
