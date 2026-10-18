/**
 * Chat SDK adapter for LinkedIn direct messages, whose transport is the
 * `linkedin` connector's browser operations rather than a provider API. The
 * shared connector-chat transport (`connector-chat.ts`) owns thread scoping,
 * sends, idempotency and the unsupported verbs; this module supplies only what
 * is LinkedIn's: row mapping, DM detection and plain-text formatting.
 *
 * Ids: a thread is one LinkedIn conversation on one connection
 * (`linkedin:<connection id>:<chat id>`). In the member's own inbox the chat
 * id is the conversation URN's token (`2-…=`), the same value the connector's
 * `send_message` takes. A company page inbox's conversation must be answered
 * from that page's mailbox, so its chat id is the full conversation URN,
 * URI-encoded because chat ids carry no `:`; `send_message` takes the decoded
 * URN. A thread id does not say whether the conversation is a group, so the
 * row's explicit `is_group: false` is what makes a message answerable, and the
 * connector refuses to send into anything but a direct message.
 */

import { Message, NotImplementedError } from "chat";

import { normalizeLinkedInMemberId } from "@lobu/connectors/linkedin-identity";
import { ConnectorChatAdapter, PlainTextFormatConverter } from "./connector-chat.js";

export const LINKEDIN_PLATFORM = "linkedin";

const PAGE_CONVERSATION_PREFIX = "urn:li:msg_conversation:(urn:li:fsd_pageMailbox:";
const ENCODED_CONVERSATION_PREFIX = encodeURIComponent("urn:li:msg_conversation:(");

/** A row's chat id: its thread token, or its full URN for a page inbox. */
function chatIdOf(row: { thread_id: string; conversation_id?: string }): string {
  return typeof row.conversation_id === "string" && row.conversation_id.startsWith(PAGE_CONVERSATION_PREFIX)
    ? encodeURIComponent(row.conversation_id)
    : row.thread_id;
}

/** What `send_message` takes for a chat id: the thread token or the conversation URN. */
function conversationOf(chatId: string): string {
  return chatId.startsWith(ENCODED_CONVERSATION_PREFIX) ? decodeURIComponent(chatId) : chatId;
}

/** The thread token of a conversation URN, or the chat id when it is one already. */
function threadTokenOf(conversation: string): string {
  const match = /,([^,()]+)\)$/.exec(conversation);
  return conversation.startsWith("urn:") && match ? match[1] : conversation;
}

/** One message row as the connector's `live_messages` feed returns it. */
export interface LinkedInMessageRow {
  id: string;
  /** `urn:li:msg_conversation:(<mailbox>,<thread id>)`. */
  conversation_id?: string;
  thread_id: string;
  conversation_url?: string;
  text?: string | null;
  /** `text`, `media`, `revoked` or `system`, as the connector classifies it. */
  content_kind?: string;
  /** Null when LinkedIn did not say; never treated as a direct message. */
  is_group?: boolean | null;
  from_me?: boolean | null;
  sender_id?: string | null;
  sender_member_id?: string | null;
  sender_slug?: string | null;
  sender_name?: string | null;
  occurred_at?: string | null;
}

export class LinkedInAdapter extends ConnectorChatAdapter<LinkedInMessageRow> {
  readonly name = LINKEDIN_PLATFORM;
  protected readonly label = "LinkedIn";
  protected readonly converter = new PlainTextFormatConverter();
  protected readonly maxTextLength = 3000;

  protected override get chatIdNoun(): string {
    return "LinkedIn conversation thread id";
  }

  /**
   * Every LinkedIn thread this adapter addresses is a direct message: only
   * `is_group: false` rows become messages, and the connector's send refuses a
   * group or unknown conversation.
   */
  protected isDirectChat(_threadId: string): boolean {
    return true;
  }

  /** A member id is not a conversation: replies go to existing threads only. */
  override async openDM(): Promise<string> {
    throw new NotImplementedError("LinkedIn replies only in existing conversations", "openDM");
  }

  protected override threadMetadata(threadId: string): Record<string, unknown> {
    return { threadId };
  }

  parseMessage(raw: LinkedInMessageRow): Message<LinkedInMessageRow> {
    const text = typeof raw.text === "string" ? raw.text : "";
    const userId = normalizeLinkedInMemberId(raw.sender_member_id ?? raw.sender_id) ?? "unknown";
    const userName = raw.sender_slug || raw.sender_name || userId;
    return new Message({
      id: this.scopeMessageId(raw.id),
      threadId: this.encodeThreadId(chatIdOf(raw)),
      text,
      formatted: this.converter.toAst(text),
      raw,
      // Group conversations are never answered, so nothing is a mention.
      isMention: false,
      author: {
        userId,
        userName,
        fullName: raw.sender_name || userName,
        isBot: false,
        isMe: raw.from_me === true,
      },
      metadata: {
        dateSent: raw.occurred_at ? new Date(raw.occurred_at) : new Date(),
        edited: false,
      },
      attachments: [],
    });
  }

  /**
   * The inbound chat message a live source row is, or null when nothing should
   * answer it: our own message, a recalled, system or attachment message, a
   * group, or a conversation LinkedIn did not identify as 1:1. `channelId` is
   * the thread token an Automation's `channel_id` filter names, in either inbox.
   */
  parseSourceRow(
    row: Record<string, unknown>,
  ): { message: Message<LinkedInMessageRow> | null; channelId: string } | null {
    const threadId = row.thread_id;
    if (
      typeof row.id !== "string" || !row.id ||
      typeof threadId !== "string" || !threadId || threadId.includes(":")
    ) {
      return null;
    }
    const answerable =
      row.from_me === false && row.is_group === false && row.content_kind === "text" &&
      typeof row.text === "string" && row.text.trim() !== "" &&
      normalizeLinkedInMemberId(
        typeof row.sender_member_id === "string" ? row.sender_member_id : null,
      ) !== null;
    return {
      message: answerable ? this.parseMessage(row as unknown as LinkedInMessageRow) : null,
      channelId: threadId,
    };
  }

  /** The connector derives LinkedIn's client origin token from the operation key. */
  protected sendInput(
    threadId: string,
    text: string,
    idempotencyKey: string,
  ): Record<string, unknown> {
    return { conversation_id: conversationOf(threadId), text, idempotency_key: idempotencyKey };
  }

  protected sentRow(
    threadId: string,
    text: string,
    output: Record<string, unknown>,
  ): LinkedInMessageRow {
    const conversation = conversationOf(threadId);
    return {
      id: output.message_id as string,
      ...(conversation === threadId ? {} : { conversation_id: conversation }),
      thread_id: threadTokenOf(conversation),
      text,
      content_kind: "text",
      from_me: true,
      is_group: false,
    };
  }
}
