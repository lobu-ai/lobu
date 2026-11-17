/**
 * Utilities shared by per-platform capability modules. All of these moved out
 * of `ChatInstanceManager` verbatim so each platform descriptor can compose
 * them without re-importing the manager.
 */

import { createLogger } from "@lobu/core";
import type { Readable } from "node:stream";
import { stripPlatformPrefix } from "../../channels/bound-channels.js";
import type { IFileHandler } from "../../platform/file-handler.js";
import type { ChatPlatformInstance, PlatformRoutingInfo } from "./types.js";

const logger = createLogger("chat-target-resolver");

/**
 * Turn off the Chat SDK's message-history cache so every adapter shares one
 * inbound path.
 *
 * The SDK writes that cache in `handleIncomingMessage` BEFORE dispatch, gated
 * on the adapter's `persistMessageHistory` flag and unguarded; `processMessage`
 * catches the throw and the webhook still answers 200, so a failing cache write
 * drops the message before Lobu sees it. Only Telegram and WhatsApp set the
 * flag. Lobu's durable transcripts use `channel_messages`, and its live-history
 * path already falls back to `ConversationStateStore` when a platform has no
 * history API, so delivery must not depend on this secondary cache.
 */
export function disableSdkMessageHistory<T extends object>(adapter: T): T {
  // Declared readonly on the SDK interface, so redefine rather than assign.
  Object.defineProperty(adapter, "persistMessageHistory", {
    value: false,
    configurable: true,
    writable: true,
  });
  return adapter;
}

/** Drain a Readable into a single Buffer. */
export async function streamToBuffer(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Resolve a Chat-SDK Thread from its canonical `thread.id` (e.g.
 * `slack:{channel}:{thread_ts}` or `telegram:{chatId}:{topicId}`) via the
 * adapter's `createThread`. Returns the thread, or `null` when the chat
 * instance exposes no `createThread` or the SDK returns nothing.
 *
 * `currentMessage` is the inbound-sender hint the SDK reads as
 * `_currentMessage.author.userId` / `raw.team_id` for ephemeral/DM routing;
 * pass `undefined` (NOT `{}`, which crashes the SDK in handleStream reading
 * `_currentMessage.author.userId`) when there's no sender.
 */
async function createSdkThread(
  chat: any,
  platform: string,
  threadId: string,
  currentMessage: Record<string, unknown> | undefined
): Promise<any | null> {
  const adapter = chat.getAdapter?.(platform);
  const createThread = (chat as any).createThread;
  if (!adapter || typeof createThread !== "function") return null;
  const thread = await createThread.call(
    chat,
    adapter,
    threadId,
    currentMessage,
    false
  );
  return thread ?? null;
}

/**
 * Resolve exactly the thread `threadId` names, or throw. For a post that must
 * land where it was addressed (an upload, an approved send) a channel-level
 * fallback would put the message somewhere nobody approved.
 */
export async function resolveExactChatThread(
  chat: any,
  platform: string,
  threadId: string
): Promise<any> {
  const hasCreateThread =
    !!chat.getAdapter?.(platform) &&
    typeof (chat as any).createThread === "function";
  if (!hasCreateThread) {
    throw new Error(`Chat instance has no createThread for ${platform}`);
  }
  const thread = await createSdkThread(chat, platform, threadId, undefined);
  if (!thread) {
    throw new Error(`Unable to resolve ${platform} thread ${threadId}`);
  }
  return thread;
}

/**
 * Resolve a Chat-SDK post target (Thread or Channel) for an outbound message.
 * One resolver shared by the response bridge, the interaction bridge, and the
 * file-upload handler.
 *
 * The dance, in order:
 *   1. `responseThreadId` (when given): a full thread id (e.g. a Telegram forum
 *      topic) — resolve it via `createThread` so the reply lands in that topic.
 *      A resolution failure here is non-fatal and falls through to the rest.
 *   2. DM shortcut: when there's no `conversationId` or it equals `channelId`,
 *      the conversation is channel-level — return the channel directly.
 *   3. Threaded: `conversationId` is the canonical `thread.id` — resolve via
 *      `createThread`.
 *   4. Last-resort channel fallback so the response still lands somewhere.
 *
 * Returns `null` only when nothing resolves.
 */
export async function resolveChatTarget(
  chat: any,
  platform: string,
  opts: {
    channelId: string;
    conversationId?: string;
    responseThreadId?: string;
    currentMessage?: Record<string, unknown>;
  }
): Promise<any | null> {
  const { channelId, conversationId, responseThreadId, currentMessage } = opts;
  // Worker/session routing uses canonical platform-prefixed channel ids, while
  // a few direct platform callers still pass the raw id. Chat SDK channel keys
  // are canonical, so normalize idempotently instead of producing an
  // unroutable value such as `slack:slack:D0123`.
  const channelKey = `${platform}:${stripPlatformPrefix(platform, channelId)}`;

  // If we have a full thread ID (e.g. telegram:{chatId}:{topicId}), use
  // createThread so the response lands in the correct forum topic.
  if (responseThreadId) {
    try {
      const thread = await createSdkThread(
        chat,
        platform,
        responseThreadId,
        currentMessage
      );
      if (thread) return thread;
    } catch (error) {
      logger.debug(
        { platform, responseThreadId, error: String(error) },
        "createThread from responseThreadId failed, falling back"
      );
    }
  }

  // DM shortcut: buildMessagePayload stores `conversationId === channelId`
  // for DMs (channel-level, not thread-level).
  if (!conversationId || conversationId === channelId) {
    const channel = chat.channel?.(channelKey);
    if (channel) return channel;
    logger.warn(
      {
        platform,
        channelId,
        channelKey,
        conversationId,
        hasChannelFn: !!chat.channel,
      },
      "resolveChatTarget: chat.channel() returned null for DM"
    );
    return null;
  }

  // Threaded fallback: `conversationId` is the Chat SDK's canonical `thread.id`
  // (e.g. `slack:{channel}:{parent_thread_ts}`) — pass it to `createThread`.
  try {
    const thread = await createSdkThread(
      chat,
      platform,
      conversationId,
      currentMessage
    );
    if (thread) return thread;
  } catch (error) {
    logger.warn(
      { platform, conversationId, error: String(error) },
      "resolveChatTarget: createThread with conversationId failed"
    );
  }

  // Last-resort channel-level fallback so the response still lands somewhere
  // instead of silently disappearing.
  const channel = chat.channel?.(channelKey);
  if (!channel) {
    logger.warn(
      { platform, channelId, channelKey, conversationId },
      "resolveChatTarget: unable to resolve thread or channel"
    );
  }
  return channel ?? null;
}

/**
 * Post a Postable (carrying a file buffer) to a thread or channel on a
 * managed Chat instance. Shared by every Chat-SDK-backed file handler
 * (Slack, Discord, Teams). `threadId` / `channelKey` are already the
 * canonical platform-prefixed ids the Chat SDK expects.
 *
 * Unlike `resolveChatTarget`, an upload MUST surface a hard failure to the
 * worker rather than silently falling back to channel-level — so a thread that
 * cannot be resolved throws instead of degrading to the channel.
 */
export async function postFileToChatTarget(
  instance: ChatPlatformInstance,
  target: { threadId?: string; channelKey: string },
  postable: { raw: string; files: Array<{ data: Buffer; filename: string }> }
): Promise<any> {
  const { chat } = instance;
  const platform = instance.connection.platform;

  if (target.threadId) {
    const thread = await resolveExactChatThread(chat, platform, target.threadId);
    return thread.post(postable);
  }

  const channel = chat.channel?.(target.channelKey);
  if (!channel) {
    throw new Error(
      `Unable to resolve ${platform} channel ${target.channelKey} for upload`
    );
  }
  return channel.post(postable);
}

// Generic file handler for platforms whose Chat SDK adapter already supports
// Postable.files (Discord, Teams). The conversationId arriving as `threadTs`
// is the canonical platform-prefixed thread ID (e.g. `discord:guildId:channelId`).
export function createChatSdkFileHandler(
  instance: ChatPlatformInstance
): IFileHandler {
  const platform = instance.connection.platform;

  return {
    uploadFile: async (fileStream, options) => {
      const buffer = await streamToBuffer(fileStream);
      const sent = await postFileToChatTarget(
        instance,
        {
          threadId: options.threadTs,
          // Same idempotent normalization as resolveChatTarget: token-bound
          // worker channel ids are already canonical platform-prefixed.
          channelKey: `${platform}:${stripPlatformPrefix(platform, options.channelId)}`,
        },
        {
          raw: options.initialComment || "",
          files: [{ data: buffer, filename: options.filename }],
        }
      );

      return {
        fileId: String(sent?.id || sent?.messageId || sent?.ts || Date.now()),
        permalink: "",
        name: options.filename,
        size: buffer.length,
      };
    },
  };
}

/**
 * Legacy routing-info fallback: before the capability registry existed,
 * `extractPlatformRoutingInfo` fell through to the WhatsApp body shape
 * (`body.whatsapp.chat`) for every platform that wasn't Slack or Telegram.
 * Discord/Teams/GChat preserve those exact semantics by pointing their descriptors
 * here alongside WhatsApp itself.
 */
export function extractWhatsAppStyleRoutingInfo(
  body: Record<string, unknown>
): PlatformRoutingInfo | null {
  const whatsapp = body.whatsapp as { chat?: string } | undefined;
  if (!whatsapp?.chat) return null;
  return {
    channelId: whatsapp.chat,
    conversationId: whatsapp.chat,
  };
}
