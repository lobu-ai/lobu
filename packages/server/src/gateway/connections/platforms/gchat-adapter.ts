import { createHash } from "node:crypto";
import { GoogleChatAdapter, type GoogleChatAdapterConfig } from "@chat-adapter/gchat";
import { convertEmojiPlaceholders, type FetchOptions, type FetchResult } from "chat";
import { GoogleAuth, JWT } from "google-auth-library";
import { createLogger } from "@lobu/core";
import { QueueTerminalError } from "../../infrastructure/queue/types.js";

const logger = createLogger("gchat-delivery");
const APP_HISTORY_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly";
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
  private readonly appHistoryAuth?: GoogleAuth | JWT;

  constructor(config: GoogleChatAdapterConfig, private readonly installedSpace?: string) {
    super(config);
    if (!installedSpace) return;
    // App history is separately approved by Workspace. A missing grant must
    // never affect the token used by the normal bot send path.
    const scopes = [APP_HISTORY_SCOPE];
    if (this.credentials) {
      this.appHistoryAuth = new JWT({
        email: this.credentials.client_email,
        key: this.credentials.private_key,
        scopes,
      });
    } else if (this.useADC) {
      this.appHistoryAuth = new GoogleAuth({ scopes });
    }
  }

  override async fetchMessages(threadId: string, options: FetchOptions = {}): Promise<FetchResult<unknown>> {
    if (options.direction !== "backward") return super.fetchMessages(threadId, options);
    const { spaceName, threadName } = this.decodeThreadId(threadId);
    if (this.installedSpace && (spaceName !== this.installedSpace || !this.appHistoryAuth)) {
      throw new Error("Google Chat history has no approved app authority for this space");
    }
    const threadIdPattern = /^spaces\/[\w-]+\/threads\/[\w.-]+$/;
    if (!threadName?.startsWith(`${spaceName}/threads/`) || !threadIdPattern.test(threadName)) {
      throw new Error("Google Chat history has no exact thread");
    }

    const api = this.installedSpace ? this.chatApi : this.impersonatedChatApi ?? this.chatApi;
    const response = await api.spaces.messages.list({
      parent: spaceName,
      ...(this.appHistoryAuth && { auth: this.appHistoryAuth }),
      filter: `thread.name = ${threadName}`,
      orderBy: "createTime desc",
      pageSize: Math.min(options.limit ?? 50, 50),
      pageToken: options.cursor,
      fields: "messages(name,text,sender,createTime,thread,privateMessageViewer),nextPageToken",
    }, { timeout: 2_000, retry: false }).catch((error: unknown) => {
      const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
      throw new Error(typeof status === "number"
        ? `Google Chat history read failed (HTTP ${status})`
        : "Google Chat history read failed");
    });

    const visible = (response.data.messages ?? []).filter((item) =>
      !item.privateMessageViewer && item.thread?.name === threadName &&
      item.name?.startsWith(`${spaceName}/messages/`));
    const messages = await Promise.all(visible.reverse().map((item) => this.parseGChatListMessage(item, spaceName, threadId)));
    return { messages, nextCursor: response.data.nextPageToken ?? undefined };
  }

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
