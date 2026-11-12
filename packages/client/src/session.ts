import { LobuAgentError } from "./errors.js";
import type { LobuRestClient } from "./rest.js";
import type {
  AskOptions,
  AskResult,
  CreateSessionRequest,
  CreateSessionResponse,
  LobuAgentEvent,
  LobuSseEvent,
  SendMessageOptions,
  SendMessageResponse,
  StreamEventsOptions,
} from "./types.js";

function newMessageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

export class AgentSession {
  /**
   * Server-side conversation/routing id (`${agentId}_${userId}_${thread}`).
   * `send`/`events`/`ask` route on this. It is **not** the logical agent id you
   * passed to `createSession` — that one is echoed back in the `connected`
   * event's `data.agentId`.
   */
  readonly conversationId: string;
  /**
   * SSE/messages endpoints the server advertised for this session (stable
   * across refresh). `send`/`events`/`ask` route through `baseUrl` +
   * `conversationId` (the generated client is path-templated), which matches
   * the server's same-origin URLs. These are surfaced for callers that need the
   * exact advertised endpoints (e.g. a server on a different public origin);
   * routing through a divergent origin directly is a follow-up.
   */
  readonly sseUrl: string;
  readonly messagesUrl: string;

  private _token: string;
  private _expiresAt: number;
  private readonly request: CreateSessionRequest;

  constructor(
    private readonly rest: LobuRestClient,
    response: CreateSessionResponse,
    request: CreateSessionRequest
  ) {
    this.conversationId = response.agentId;
    this._token = response.token;
    this._expiresAt = response.expiresAt;
    this.sseUrl = response.sseUrl;
    this.messagesUrl = response.messagesUrl;
    // Defensive deep copy: refresh replays this request, so the caller mutating
    // their object afterwards must not change what we re-send.
    this.request = structuredClone(request);
  }

  /** Current session (worker) token. Updated in place by {@link refresh}. */
  get token(): string {
    return this._token;
  }

  /** Unix epoch ms when {@link token} expires, as advertised by the server. */
  get expiresAt(): number {
    return this._expiresAt;
  }

  send(
    content: string,
    options?: SendMessageOptions
  ): Promise<SendMessageResponse> {
    return this.rest.sendMessage(
      this.conversationId,
      this._token,
      content,
      options
    );
  }

  events(options?: StreamEventsOptions): AsyncIterable<LobuAgentEvent>;
  events<TData>(
    options?: StreamEventsOptions
  ): AsyncIterable<LobuSseEvent<TData>>;
  events(
    options: StreamEventsOptions = {}
  ): AsyncIterable<LobuSseEvent<unknown>> {
    return this.rest.streamEvents(this.conversationId, this._token, options);
  }

  /**
   * Re-mint this session's token without losing the conversation. Re-runs the
   * original create-session request against the resume path (`forceNew: false`)
   * and updates {@link token}/{@link expiresAt} in place. Call this before
   * {@link expiresAt} for a long-lived chat. Manual by
   * design — there is no background auto-renew.
   */
  async refresh(): Promise<this> {
    const response = await this.rest.createSession({
      ...this.request,
      forceNew: false,
    });
    this._token = response.token;
    this._expiresAt = response.expiresAt;
    return this;
  }

  /**
   * Send a message and await the agent's reply. Resolves with the concatenated
   * text on the `complete` event for this message; rejects with
   * {@link LobuAgentError} on `error`/`agent-error`. Convenience over
   * `send` + `events` for request/response use.
   *
   * Delivery rides the SSE stream. Under a multi-replica deployment where
   * API/SSE events are not owner-routed, `ask` can time out even though the
   * agent finished — single-replica and local runs are reliable. Use
   * `send` + your own `events` consumer if you need finer control.
   */
  async ask(content: string, options: AskOptions = {}): Promise<AskResult> {
    const messageId = options.messageId ?? newMessageId();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();

    const timeoutMs = options.timeoutMs ?? 120_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let text = "";
    let sent = false;

    try {
      for await (const event of this.events({ signal: controller.signal })) {
        // Send only after the `connected` handshake so the SSE request is open
        // before the message is enqueued — otherwise the reply can outrun our
        // subscription. Backlog replay only covers the same pod (see JSDoc).
        if (event.event === "connected") {
          if (!sent) {
            sent = true;
            await this.send(content, { messageId });
          }
          continue;
        }
        if (event.event === "output" && event.data.messageId === messageId) {
          text += event.data.content;
        } else if (
          event.event === "complete" &&
          (event.data.messageId === messageId ||
            event.data.processedMessageIds?.includes(messageId))
        ) {
          if (
            typeof event.data.finalText === "string" &&
            event.data.finalText.length > 0
          ) {
            text = event.data.finalText;
          }
          return { text, messageId };
        } else if (
          (event.event === "error" || event.event === "agent-error") &&
          (event.data.messageId === messageId ||
            event.data.processedMessageIds?.includes(messageId))
        ) {
          throw new LobuAgentError(event.data.error, messageId);
        }
      }
      if (options.signal?.aborted) throw new Error("ask() aborted");
      if (timedOut) throw new Error(`ask() timed out after ${timeoutMs}ms`);
      throw new Error("ask() stream ended before completion");
    } finally {
      clearTimeout(timer);
      controller.abort();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
