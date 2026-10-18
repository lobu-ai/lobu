/**
 * Chat SDK adapter for WhatsApp Web, whose transport is the `whatsapp.web`
 * connector's device operations rather than a provider API. The shared
 * connector-chat transport (`connector-chat.ts`) owns thread scoping, sends,
 * idempotency and the unsupported verbs; this module supplies only what is
 * WhatsApp's: row mapping, DM detection by JID and formatting.
 *
 * Ids: a thread is one WhatsApp chat on one connection
 * (`whatsapp.web:<connection id>:<chat jid>`); a 1:1 chat is a DM and an
 * `@g.us` chat is a group.
 */

import {
  BaseFormatConverter,
  type FormattedContent,
  isTableNode,
  Message,
  parseMarkdown,
  tableToAscii,
  walkAst,
} from "chat";
import { gfmToMarkdown } from "mdast-util-gfm";
import { type Handlers, toMarkdown } from "mdast-util-to-markdown";

import {
  WHATSAPP_DM_SUFFIXES,
  WHATSAPP_GROUP_SUFFIX,
} from "@lobu/connectors/whatsapp-web-identity";
import { ConnectorChatAdapter } from "./connector-chat.js";

export const WHATSAPP_WEB_PLATFORM = "whatsapp.web";

const GROUP_SUFFIX = WHATSAPP_GROUP_SUFFIX;
const DM_SUFFIXES: readonly string[] = WHATSAPP_DM_SUFFIXES;

/** One message row as the connector's live feed and search return it. */
export interface WhatsAppWebMessageRow {
  id: string;
  chat_jid: string;
  chat_name?: string | null;
  text?: string | null;
  occurred_at?: string | null;
  from_me?: boolean;
  sender_jid?: string | null;
  push_name?: string | null;
  is_group?: boolean;
  /** `text`, `media`, `revoked` or `system`, as the connector classifies it. */
  content_kind?: string;
  /** The message @mentions the paired account or quotes one of its messages. */
  mentions_me?: boolean;
}

/**
 * WhatsApp marks bold and strike with a single `*` / `~`. These are serializer
 * node handlers, so code spans and escaped text are never rewritten.
 */
const WHATSAPP_INLINE_HANDLERS: Partial<Handlers> = {
  strong: (node, _parent, state, info) =>
    `*${state.containerPhrasing(node, { ...info, before: "*", after: "*" })}*`,
  delete: (node, _parent, state, info) =>
    `~${state.containerPhrasing(node, { ...info, before: "~", after: "~" })}~`,
};

class WhatsAppWebFormatConverter extends BaseFormatConverter {
  fromAst(ast: FormattedContent): string {
    // WhatsApp renders no headings, rules or tables: map them to what it does.
    const whatsappAst = walkAst(structuredClone(ast), (node) => {
      if (node.type === "heading") {
        return { type: "paragraph", children: [{ type: "strong", children: node.children }] };
      }
      if (node.type === "thematicBreak") {
        return { type: "paragraph", children: [{ type: "text", value: "━━━" }] };
      }
      if (isTableNode(node)) return { type: "code", value: tableToAscii(node) };
      return node;
    });
    return toMarkdown(whatsappAst, {
      emphasis: "_",
      bullet: "-",
      extensions: [gfmToMarkdown()],
      handlers: WHATSAPP_INLINE_HANDLERS,
    }).trim();
  }
  toAst(platformText: string): FormattedContent {
    return parseMarkdown(platformText);
  }
}

export class WhatsAppWebAdapter extends ConnectorChatAdapter<WhatsAppWebMessageRow> {
  readonly name = WHATSAPP_WEB_PLATFORM;
  protected readonly label = "WhatsApp Web";
  protected readonly converter = new WhatsAppWebFormatConverter();
  protected readonly maxTextLength = 65536;

  protected override get chatIdNoun(): string {
    return "WhatsApp chat JID";
  }

  protected override get directChatNoun(): string {
    return "WhatsApp person JID";
  }

  /** A person JID is a 1:1 chat; a group or anything else is not a DM. */
  protected isDirectChat(chatJid: string): boolean {
    return DM_SUFFIXES.some((suffix) => chatJid.endsWith(suffix));
  }

  protected override threadMetadata(chatJid: string): Record<string, unknown> {
    return { chatJid };
  }

  parseMessage(raw: WhatsAppWebMessageRow): Message<WhatsAppWebMessageRow> {
    const text = typeof raw.text === "string" ? raw.text : "";
    const isGroup = raw.chat_jid.endsWith(GROUP_SUFFIX);
    const userId =
      raw.sender_jid ?? (!isGroup && raw.from_me !== true ? raw.chat_jid : "unknown");
    const displayName = raw.push_name || userId;
    return new Message({
      id: this.scopeMessageId(raw.id),
      threadId: this.encodeThreadId(raw.chat_jid),
      text,
      formatted: this.converter.toAst(text),
      raw,
      // Only a group has anyone else to address: a DM quoting the bot is
      // still just a DM, so a `mention_only` trigger never answers it.
      isMention: isGroup && raw.mentions_me === true,
      author: {
        userId,
        userName: displayName,
        fullName: displayName,
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
   * answer it: our own message, a revocation, a system event, a media-only
   * message (attachments are not carried), or a chat that is neither a person
   * nor a group (status, broadcast, newsletter). `channelId` is the chat JID,
   * the value an Automation's `channel_id` filter names.
   */
  parseSourceRow(
    row: Record<string, unknown>,
  ): { message: Message<WhatsAppWebMessageRow> | null; channelId: string } | null {
    const chatJid = row.chat_jid;
    if (typeof row.id !== "string" || !row.id || typeof chatJid !== "string" || !chatJid || chatJid.includes(":")) {
      return null;
    }
    const isGroup = chatJid.endsWith(GROUP_SUFFIX);
    const answerable =
      row.from_me === false && row.content_kind === "text" &&
      typeof row.text === "string" && row.text.trim() !== "" &&
      (isGroup
        ? typeof row.sender_jid === "string" && row.sender_jid !== ""
        : DM_SUFFIXES.some((suffix) => chatJid.endsWith(suffix)));
    return {
      message: answerable ? this.parseMessage(row as unknown as WhatsAppWebMessageRow) : null,
      channelId: chatJid,
    };
  }

  protected sendInput(chatJid: string, text: string): Record<string, unknown> {
    return { chat_jid: chatJid, text };
  }

  /**
   * The output's chat_jid may come back as the chat's `@lid` alias; the sent
   * row keeps the chat the reply was addressed to.
   */
  protected sentRow(
    chatJid: string,
    text: string,
    output: Record<string, unknown>,
  ): WhatsAppWebMessageRow {
    return {
      id: output.message_id as string,
      chat_jid: chatJid,
      text,
      from_me: true,
      is_group: chatJid.endsWith(GROUP_SUFFIX),
    };
  }
}
