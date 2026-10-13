/**
 * Chat SDK adapter for WhatsApp Web, whose transport is the `whatsapp.web`
 * connector's device operations rather than a provider API.
 *
 * The gateway never holds a WhatsApp credential: every outbound verb becomes a
 * connector operation on the paired device, admitted by the normal operations
 * path (policy, approval, durable run). The executor is injected so this module
 * stays a pure translation between Chat SDK verbs and those operations.
 *
 * `send_message` is not idempotent on WhatsApp — a
 * send that fails after the page delivered it would double-send on retry — so
 * `postMessage` issues exactly one operation per call and surfaces any
 * non-completed outcome as an error. A failed send stays failed; it is never
 * retried here. Terminal responses supply a stable operation key so queue
 * redelivery adopts the existing run. Streaming is buffered and posted once, so a
 * reply never becomes a placeholder followed by edits.
 *
 * Ids: a thread is one WhatsApp chat on one connection
 * (`whatsapp.web:<connection id>:<chat jid>`); a 1:1 chat is a DM and an
 * `@g.us` chat is a group. Message ids are scoped the same way
 * (`<connection id>:<raw id>`). Every WhatsApp Web connection shares one
 * adapter name and the Chat SDK's lock, subscription and dedupe state, so two
 * connections seeing the same chat or raw id must not contend or suppress
 * each other.
 */

import {
  type Adapter,
  type AdapterPostableMessage,
  BaseFormatConverter,
  type ChatInstance,
  type FetchResult,
  type FormattedContent,
  isTableNode,
  Message,
  NotImplementedError,
  parseMarkdown,
  type RawMessage,
  type StreamChunk,
  type ThreadInfo,
  tableToAscii,
  walkAst,
} from "chat";
import { gfmToMarkdown } from "mdast-util-gfm";
import { type Handlers, toMarkdown } from "mdast-util-to-markdown";

export const WHATSAPP_WEB_PLATFORM = "whatsapp.web";

const THREAD_PREFIX = `${WHATSAPP_WEB_PLATFORM}:`;
const GROUP_SUFFIX = "@g.us";
const DM_SUFFIXES = ["@s.whatsapp.net", "@c.us", "@lid"];

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
}

export interface WhatsAppWebOperationRequest {
  operationKey: string;
  input: Record<string, unknown>;
  /** Reused for a redelivered terminal response; fresh for an independent post. */
  idempotencyKey: string;
}

export type WhatsAppWebOperationOutcome =
  | { status: "completed"; output: Record<string, unknown> }
  | { status: "failed" | "timeout" | "pending_approval" | "in_progress"; error: string };

export type WhatsAppWebOperationExecutor = (
  request: WhatsAppWebOperationRequest,
) => Promise<WhatsAppWebOperationOutcome>;

export interface WhatsAppWebAdapterOptions {
  /** Runtime connection id; scopes every message id this adapter mints. */
  connectionId: string;
  userName: string;
  execute: WhatsAppWebOperationExecutor;
  newIdempotencyKey: () => string;
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

export class WhatsAppWebAdapter implements Adapter<string, WhatsAppWebMessageRow> {
  readonly name = WHATSAPP_WEB_PLATFORM;
  readonly userName: string;
  readonly persistMessageHistory = false;
  private readonly converter = new WhatsAppWebFormatConverter();

  constructor(private readonly options: WhatsAppWebAdapterOptions) {
    this.userName = options.userName;
  }

  async initialize(_chat: ChatInstance): Promise<void> {}

  /** No inbound webhook exists: messages arrive from the device feed. */
  async handleWebhook(_request: Request): Promise<Response> {
    return new Response("WhatsApp Web has no webhook transport", { status: 404 });
  }

  /**
   * Thread ids carry the connection: the Chat SDK locks, subscribes and dedupes
   * by thread id in state shared by every connection, so two paired devices
   * talking to the same person must never share one.
   */
  private get threadPrefix(): string {
    return `${THREAD_PREFIX}${this.options.connectionId}:`;
  }

  encodeThreadId(chatJid: string): string {
    if (!chatJid || chatJid.includes(":")) {
      throw new Error(`Invalid WhatsApp chat JID: ${chatJid}`);
    }
    return `${this.threadPrefix}${chatJid}`;
  }

  /** The chat JID of one of THIS connection's threads; any other id is refused. */
  decodeThreadId(threadId: string): string {
    const chatJid = threadId.startsWith(this.threadPrefix)
      ? threadId.slice(this.threadPrefix.length)
      : "";
    if (!chatJid || chatJid.includes(":")) {
      throw new Error(`Invalid WhatsApp Web thread ID: ${threadId}`);
    }
    return chatJid;
  }

  /** A WhatsApp chat has no sub-threads, so the channel is the thread. */
  channelIdFromThreadId(threadId: string): string {
    this.decodeThreadId(threadId);
    return threadId;
  }

  /** A person JID is a 1:1 chat; a group or anything else is not a DM. */
  isDM(threadId: string): boolean {
    const chatJid = this.decodeThreadId(threadId);
    return DM_SUFFIXES.some((suffix) => chatJid.endsWith(suffix));
  }

  async openDM(userId: string): Promise<string> {
    const threadId = this.encodeThreadId(userId);
    if (!this.isDM(threadId)) {
      throw new Error(`Not a WhatsApp person JID: ${userId}`);
    }
    return threadId;
  }

  /** Connection-scoped message id: the Chat SDK dedupe key embeds it. */
  scopeMessageId(rawId: string): string {
    return `${this.options.connectionId}:${rawId}`;
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

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
    idempotencyKey?: string,
  ): Promise<RawMessage<WhatsAppWebMessageRow>> {
    return this.send(threadId, this.converter.renderPostable(message), idempotencyKey);
  }

  /** Buffer the whole stream and send it once — never post-then-edit. */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<WhatsAppWebMessageRow> | null> {
    let text = "";
    for await (const chunk of textStream) {
      if (typeof chunk === "string") text += chunk;
      else if (chunk.type === "markdown_text") text += chunk.text;
    }
    if (!text.trim()) return null;
    return this.send(threadId, this.converter.fromMarkdown(text));
  }

  private async send(
    threadId: string,
    text: string,
    idempotencyKey = this.options.newIdempotencyKey(),
  ): Promise<RawMessage<WhatsAppWebMessageRow>> {
    const chatJid = this.decodeThreadId(threadId);
    if (!text.trim()) throw new Error("Refusing to send an empty WhatsApp message");
    const outcome = await this.options.execute({
      operationKey: "send_message",
      input: { chat_jid: chatJid, text },
      idempotencyKey,
    });
    if (outcome.status !== "completed") {
      // Ambiguous or refused: report it and stop. Retrying could deliver twice.
      throw new Error(`WhatsApp send_message ${outcome.status}: ${outcome.error}`);
    }
    const rawId = outcome.output.message_id;
    if (typeof rawId !== "string" || !rawId) {
      throw new Error("WhatsApp send_message completed without a message id");
    }
    // The output's chat_jid may come back as the chat's `@lid` alias; the
    // thread stays the one the reply was addressed to.
    return {
      id: this.scopeMessageId(rawId),
      threadId,
      raw: {
        id: rawId,
        chat_jid: chatJid,
        text,
        from_me: true,
        is_group: chatJid.endsWith(GROUP_SUFFIX),
      },
    };
  }

  /** Text is the only reply path; the engine needs no edit when it streams once. */
  async editMessage(): Promise<RawMessage<WhatsAppWebMessageRow>> {
    throw new NotImplementedError("WhatsApp Web does not edit replies", "editMessage");
  }

  async deleteMessage(): Promise<void> {
    throw new NotImplementedError("WhatsApp Web does not delete replies", "deleteMessage");
  }

  async addReaction(): Promise<void> {
    throw new NotImplementedError("WhatsApp Web reactions are not supported", "addReaction");
  }

  async removeReaction(): Promise<void> {
    throw new NotImplementedError("WhatsApp Web reactions are not supported", "removeReaction");
  }

  /** WhatsApp Web exposes no typing operation; a no-op keeps turns quiet. */
  async startTyping(): Promise<void> {}

  /** This adapter leaves history retrieval to the engine's conversation state. */
  async fetchMessages(): Promise<FetchResult<WhatsAppWebMessageRow>> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const chatJid = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: threadId,
      isDM: this.isDM(threadId),
      metadata: { chatJid },
    };
  }
}
