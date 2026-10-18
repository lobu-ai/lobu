/**
 * Shared chat transport for platforms whose "API" is a connector connection —
 * a device-paired browser — rather than a credentialed provider client.
 *
 * The gateway never holds the platform's credential: every outbound verb
 * becomes a `send_message` connector operation on the connection, admitted by
 * the normal operations path (policy, approval, durable run). Inbound messages
 * arrive as the connector's live feed rows (`chat-source-ingress.ts`).
 *
 * A platform plugs in with three pieces, nothing else:
 *   1. a `ConnectorChatAdapter` subclass supplying row mapping
 *      (`parseMessage`, `parseSourceRow`), DM detection (`isDirectChat`), the
 *      `send_message` input/output translation and a format converter;
 *   2. `connectorChatPlatform(...)` from `connector-chat-platform.ts` as its
 *      `PLATFORM_REGISTRY` descriptor, keyed by the connector key (the platform name);
 *   3. that connector declaring a `replyToSource` Automation event and a
 *      `send_message` action. The response strategy follows automatically.
 *
 * Contract every subclass inherits:
 * - Thread ids are `<platform>:<connection id>:<chat id>`; message ids are
 *   `<connection id>:<raw id>`. Every connection of one platform shares one
 *   adapter name and the Chat SDK's lock, subscription and dedupe state, so two
 *   connections seeing the same chat or raw id must never contend or suppress
 *   each other. A chat id may not contain `:`.
 * - `postMessage` issues exactly ONE operation per call and surfaces any
 *   non-completed outcome as an error; it never retries, because a send that
 *   failed after the page delivered it would double-send. Callers that may
 *   redeliver pass a stable idempotency key so the existing run is adopted.
 * - Streaming is buffered and posted once: never a placeholder plus edits.
 */

import {
  type Adapter,
  type AdapterPostableMessage,
  type BaseFormatConverter,
  type ChatInstance,
  type FetchResult,
  type FormattedContent,
  type Message,
  NotImplementedError,
  type RawMessage,
  type StreamChunk,
  type ThreadInfo,
} from "chat";

export interface ConnectorChatOperationRequest {
  operationKey: string;
  input: Record<string, unknown>;
  /** Reused for a redelivered terminal response; fresh for an independent post. */
  idempotencyKey: string;
}

export type ConnectorChatOperationOutcome =
  | { status: "completed"; output: Record<string, unknown> }
  | { status: "failed" | "timeout" | "pending_approval" | "in_progress"; error: string };

export type ConnectorChatOperationExecutor = (
  request: ConnectorChatOperationRequest,
) => Promise<ConnectorChatOperationOutcome>;

export interface ConnectorChatAdapterOptions {
  /** Runtime connection id; scopes every thread and message id this adapter mints. */
  connectionId: string;
  userName: string;
  execute: ConnectorChatOperationExecutor;
  newIdempotencyKey: () => string;
}

/** What `parseSourceRow` returns: see `ChatPlatformDescriptor.parseSourceMessage`. */
export type ConnectorChatSourceMessage<Row> = {
  message: Message<Row> | null;
  channelId: string;
} | null;

export abstract class ConnectorChatAdapter<Row>
  implements Adapter<string, Row>
{
  /** The platform name: the connector key and the thread-id prefix. */
  abstract readonly name: string;
  /** Human platform name for error messages ("WhatsApp Web"). */
  protected abstract readonly label: string;
  protected abstract readonly converter: BaseFormatConverter;
  /** How errors name a native chat id ("WhatsApp chat JID"). */
  protected get chatIdNoun(): string {
    return `${this.label} chat id`;
  }
  /** How errors name a 1:1 chat id ("WhatsApp person JID"). */
  protected get directChatNoun(): string {
    return `${this.label} direct chat`;
  }
  readonly userName: string;
  readonly persistMessageHistory = false;

  constructor(protected readonly options: ConnectorChatAdapterOptions) {
    this.userName = options.userName;
  }

  /** True when this native chat id is a 1:1 conversation. */
  protected abstract isDirectChat(chatId: string): boolean;
  /** One row of the connector's live feed (or a sent reply) as a Chat SDK message. */
  abstract parseMessage(raw: Row): Message<Row>;
  /**
   * The inbound chat message a live source row is, or `message: null` when
   * nothing should answer it; null when the row names no chat. `channelId` is
   * the native chat id an Automation's `channel_id` filter names.
   */
  abstract parseSourceRow(row: Record<string, unknown>): ConnectorChatSourceMessage<Row>;
  /** The connector's `send_message` input for one reply. */
  protected abstract sendInput(chatId: string, text: string): Record<string, unknown>;
  /** The raw row a completed `send_message` stands for; its `id` is the raw message id. */
  protected abstract sentRow(
    chatId: string,
    text: string,
    output: Record<string, unknown>,
  ): Row & { id: string };

  /** `fetchThread` metadata for one chat. */
  protected threadMetadata(chatId: string): Record<string, unknown> {
    return { chatId };
  }

  async initialize(_chat: ChatInstance): Promise<void> {}

  /** No inbound webhook exists: messages arrive from the connector's live feed. */
  async handleWebhook(_request: Request): Promise<Response> {
    return new Response(`${this.label} has no webhook transport`, { status: 404 });
  }

  private get threadPrefix(): string {
    return `${this.name}:${this.options.connectionId}:`;
  }

  encodeThreadId(chatId: string): string {
    if (!chatId || chatId.includes(":")) {
      throw new Error(`Invalid ${this.chatIdNoun}: ${chatId}`);
    }
    return `${this.threadPrefix}${chatId}`;
  }

  /** The chat id of one of THIS connection's threads; any other id is refused. */
  decodeThreadId(threadId: string): string {
    const chatId = threadId.startsWith(this.threadPrefix)
      ? threadId.slice(this.threadPrefix.length)
      : "";
    if (!chatId || chatId.includes(":")) {
      throw new Error(`Invalid ${this.label} thread ID: ${threadId}`);
    }
    return chatId;
  }

  /** A chat has no sub-threads, so the channel is the thread. */
  channelIdFromThreadId(threadId: string): string {
    this.decodeThreadId(threadId);
    return threadId;
  }

  isDM(threadId: string): boolean {
    return this.isDirectChat(this.decodeThreadId(threadId));
  }

  async openDM(userId: string): Promise<string> {
    const threadId = this.encodeThreadId(userId);
    if (!this.isDM(threadId)) {
      throw new Error(`Not a ${this.directChatNoun}: ${userId}`);
    }
    return threadId;
  }

  /** Connection-scoped message id: the Chat SDK dedupe key embeds it. */
  scopeMessageId(rawId: string): string {
    return `${this.options.connectionId}:${rawId}`;
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
    idempotencyKey?: string,
  ): Promise<RawMessage<Row>> {
    return this.send(threadId, this.converter.renderPostable(message), idempotencyKey);
  }

  /** Buffer the whole stream and send it once — never post-then-edit. */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<Row> | null> {
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
  ): Promise<RawMessage<Row>> {
    const chatId = this.decodeThreadId(threadId);
    if (!text.trim()) throw new Error(`Refusing to send an empty ${this.label} message`);
    const outcome = await this.options.execute({
      operationKey: "send_message",
      input: this.sendInput(chatId, text),
      idempotencyKey,
    });
    if (outcome.status !== "completed") {
      // Ambiguous or refused: report it and stop. Retrying could deliver twice.
      throw new Error(`${this.label} send_message ${outcome.status}: ${outcome.error}`);
    }
    if (typeof outcome.output.message_id !== "string" || !outcome.output.message_id) {
      throw new Error(`${this.label} send_message completed without a message id`);
    }
    const raw = this.sentRow(chatId, text, outcome.output);
    // The thread stays the one the reply was addressed to, whatever alias the
    // connector reports the chat under.
    return { id: this.scopeMessageId(raw.id), threadId, raw };
  }

  /** Text is the only reply path; the engine needs no edit when it streams once. */
  async editMessage(): Promise<RawMessage<Row>> {
    throw new NotImplementedError(`${this.label} does not edit replies`, "editMessage");
  }

  async deleteMessage(): Promise<void> {
    throw new NotImplementedError(`${this.label} does not delete replies`, "deleteMessage");
  }

  async addReaction(): Promise<void> {
    throw new NotImplementedError(`${this.label} reactions are not supported`, "addReaction");
  }

  async removeReaction(): Promise<void> {
    throw new NotImplementedError(`${this.label} reactions are not supported`, "removeReaction");
  }

  /** No typing operation exists; a no-op keeps turns quiet. */
  async startTyping(): Promise<void> {}

  /** History retrieval is left to the engine's conversation state. */
  async fetchMessages(): Promise<FetchResult<Row>> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const chatId = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: threadId,
      isDM: this.isDM(threadId),
      metadata: this.threadMetadata(chatId),
    };
  }
}
