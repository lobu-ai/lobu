/**
 * Chat SDK adapter for X direct messages, whose transport is the `x`
 * connector's browser operations rather than a provider API. The shared
 * connector-chat transport (`connector-chat.ts`) owns thread scoping, sends,
 * idempotency and the unsupported verbs; this module supplies only what is
 * X's: row mapping, DM detection and plain-text formatting.
 *
 * Ids: a thread is one X DM conversation on one connection
 * (`x:<connection id>:<conversation id>`). A 1:1 conversation id is the two
 * participants' user ids joined by `-`; a group conversation id is a bare
 * number, so the conversation id alone tells a DM from a group.
 */

import { Message } from "chat";

import { ConnectorChatAdapter, PlainTextFormatConverter } from "./connector-chat.js";

export const X_PLATFORM = "x";

/** One message row as the connector's `live_messages` feed returns it. */
export interface XMessageRow {
  id: string;
  message_id?: string;
  conversation_id: string;
  conversation_name?: string | null;
  sender_id?: string | null;
  sender_handle?: string | null;
  sender_name?: string | null;
  from_me?: boolean;
  is_group?: boolean;
  /** The conversation is a message request the account has not accepted. */
  is_request?: boolean;
  text?: string | null;
  /** `text`, `media` or `empty`, as the connector classifies it. */
  content_kind?: string;
  occurred_at?: string | null;
}

export class XAdapter extends ConnectorChatAdapter<XMessageRow> {
  readonly name = X_PLATFORM;
  protected readonly label = "X";
  protected readonly converter = new PlainTextFormatConverter();

  protected override get chatIdNoun(): string {
    return "X DM conversation id";
  }

  protected override get directChatNoun(): string {
    return "X 1:1 DM conversation";
  }

  /** A `<user id>-<user id>` conversation is 1:1; a bare id is a group. */
  protected isDirectChat(conversationId: string): boolean {
    return conversationId.includes("-");
  }

  protected override threadMetadata(conversationId: string): Record<string, unknown> {
    return { conversationId };
  }

  parseMessage(raw: XMessageRow): Message<XMessageRow> {
    const text = typeof raw.text === "string" ? raw.text : "";
    const userId = raw.sender_id || "unknown";
    const userName = raw.sender_handle || userId;
    return new Message({
      id: this.scopeMessageId(raw.id),
      threadId: this.encodeThreadId(raw.conversation_id),
      text,
      formatted: this.converter.toAst(text),
      raw,
      // X DM rows carry no mention signal, so a `mention_only` trigger never
      // answers a group; scoping the Automation to the conversation does.
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
   * answer it: our own message, or a message without text (attachments are not
   * carried). Message requests are answered like any other DM. `channelId` is
   * the conversation id an Automation's `channel_id` filter names.
   */
  parseSourceRow(
    row: Record<string, unknown>,
  ): { message: Message<XMessageRow> | null; channelId: string } | null {
    const conversationId = row.conversation_id;
    if (
      typeof row.id !== "string" || !row.id ||
      typeof conversationId !== "string" || !conversationId || conversationId.includes(":")
    ) {
      return null;
    }
    const answerable =
      row.from_me === false && row.content_kind === "text" &&
      typeof row.text === "string" && row.text.trim() !== "" &&
      typeof row.sender_id === "string" && row.sender_id !== "";
    return {
      message: answerable ? this.parseMessage(row as unknown as XMessageRow) : null,
      channelId: conversationId,
    };
  }

  /** The connector derives X's client request id from the operation key. */
  protected sendInput(
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Record<string, unknown> {
    return { conversation_id: conversationId, text, idempotency_key: idempotencyKey };
  }

  protected sentRow(
    conversationId: string,
    text: string,
    output: Record<string, unknown>,
  ): XMessageRow {
    return {
      id: `${conversationId}:${output.message_id}`,
      message_id: output.message_id as string,
      conversation_id: conversationId,
      text,
      from_me: true,
      is_group: !this.isDirectChat(conversationId),
    };
  }
}
