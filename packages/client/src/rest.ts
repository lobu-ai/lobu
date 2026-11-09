import { LobuApiError } from "./errors.js";
import {
  getApiV1AgentsByAgentIdEvents,
  postApiV1Agents,
  postApiV1AgentsByAgentIdMessages,
} from "./generated/sdk.gen.js";
import { createClient, type Client } from "./generated/client/index.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  LobuFetch,
  LobuHeaders,
  LobuSseEvent,
  SendMessageOptions,
  SendMessageResponse,
  StreamEventsOptions,
  TokenProvider,
} from "./types.js";

export class LobuRestClient {
  private readonly token: TokenProvider;
  private readonly fetchImpl: LobuFetch;
  private readonly headers: LobuHeaders | undefined;
  private readonly client: Client;

  constructor(options: {
    baseUrl: string;
    token: TokenProvider;
    fetch: LobuFetch;
    headers?: LobuHeaders;
  }) {
    this.token = options.token;
    this.fetchImpl = options.fetch;
    this.headers = options.headers;
    this.client = createClient({
      baseUrl: normalizeBaseUrl(options.baseUrl),
      fetch: options.fetch,
    });
  }

  async createSession(
    input: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
    const result = await postApiV1Agents({
      client: this.client,
      body: input,
      headers: await this.authHeaders(),
    });
    if (result.error) throw new LobuApiError(result.response, result.error);
    return result.data;
  }

  async sendMessage(
    sessionId: string,
    sessionToken: string,
    content: string,
    options: SendMessageOptions = {}
  ): Promise<SendMessageResponse> {
    const result = await postApiV1AgentsByAgentIdMessages({
      client: this.client,
      path: { agentId: sessionId },
      body: { content, messageId: options.messageId },
      headers: this.authHeadersFor(sessionToken),
    });
    if (result.error) throw new LobuApiError(result.response, result.error);
    return result.data;
  }

  async *streamEvents<TData = unknown>(
    sessionId: string,
    sessionToken: string,
    options: StreamEventsOptions = {}
  ): AsyncIterable<LobuSseEvent<TData>> {
    const controller = new AbortController();
    const queue: Array<LobuSseEvent<TData>> = [];
    let done = options.signal?.aborted === true;
    let pumpDone = false;
    let pumpError: unknown;
    let wake: (() => void) | undefined;

    const wakeReader = () => {
      wake?.();
      wake = undefined;
    };
    const abort = () => {
      done = true;
      // Cancel the in-flight SSE request immediately — without this, a caller
      // aborting their external signal only breaks the local loop while the
      // underlying fetch + the generated client's reconnect loop keep running.
      try {
        controller.abort();
      } catch {
        // Bun can throw from stream cancellation during abort propagation.
      }
      wakeReader();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const result = await getApiV1AgentsByAgentIdEvents({
      client: this.client,
      path: { agentId: sessionId },
      headers: {
        ...this.authHeadersFor(sessionToken),
        ...headersToRecord(options.headers),
      },
      signal: controller.signal,
      fetch: endBodyOnAbort(this.fetchImpl, controller.signal),
      // The generated SSE client retries forever by default: a non-OK response
      // (401/404/5xx) or a network failure throws inside its read loop, fires
      // onSseError, then sleeps and reconnects with no attempt cap — so a
      // failed stream NEVER terminates and the async iterator below hangs
      // indefinitely. Cap the attempts and surface the error so callers reject
      // instead of hanging. An aborted signal already breaks the loop cleanly.
      sseMaxRetryAttempts: options.maxRetryAttempts ?? 1,
      onSseError: (error) => {
        // Don't treat a caller-initiated abort as a stream failure — that path
        // is a clean shutdown, not an error to propagate.
        if (controller.signal.aborted) return;
        if (pumpError === undefined) pumpError = error;
        wakeReader();
      },
      onSseEvent: (event) => {
        queue.push({
          event: event.event ?? "message",
          data: event.data as TData,
          id: event.id,
          retry: event.retry,
        });
        wakeReader();
      },
    });

    const pump = (async () => {
      try {
        for await (const _data of result.stream) {
          // onSseEvent above preserves event names. The generated stream yields
          // only data payloads, so the queue is the public SDK surface.
        }
      } catch (error) {
        if (!controller.signal.aborted && pumpError === undefined) {
          pumpError = error;
        }
      } finally {
        done = true;
        pumpDone = true;
        wakeReader();
      }
    })();

    try {
      while (!done || queue.length > 0) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (pumpError) throw pumpError;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (pumpError) throw pumpError;
    } finally {
      // Abort whenever the generator exits before the pump finished — a caller
      // `break`, an external-signal abort, or a throw all land here with the
      // underlying SSE request still open. Only skip when pumpDone (the stream
      // already ended on its own). The prior guard skipped the abort exactly on
      // a caller-initiated stop, leaking the fetch and the client's reconnect loop.
      if (!pumpDone) {
        try {
          controller.abort();
        } catch {
          // Bun can throw from stream cancellation during abort propagation.
        }
      }
      options.signal?.removeEventListener("abort", abort);
      if (pumpDone) await pump;
    }
  }

  getFetch(): LobuFetch {
    return this.fetchImpl;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return this.authHeadersFor(await resolveToken(this.token));
  }

  private authHeadersFor(token: string): Record<string, string> {
    return {
      ...headersToRecord(this.headers),
      Authorization: `Bearer ${token}`,
    };
  }
}

async function resolveToken(provider: TokenProvider): Promise<string> {
  return typeof provider === "function" ? provider() : provider;
}

/**
 * The generated SSE reader calls `reader.cancel()` on abort without handling
 * the returned promise. Once the aborted fetch has errored the response body,
 * that cancel rejects with nobody listening: an unhandled AbortError that can
 * crash a Node process. Ending the body cleanly on our own abort keeps the
 * stream from erroring, so that cancel resolves. Failures that are not ours
 * still propagate as errors.
 */
function endBodyOnAbort(fetchImpl: LobuFetch, signal: AbortSignal): LobuFetch {
  const wrapped = async (
    input: Parameters<LobuFetch>[0],
    init?: Parameters<LobuFetch>[1]
  ): Promise<Response> => {
    const response = await fetchImpl(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (cancelled) return;
          if (signal.aborted) controller.close();
          else controller.error(error);
          return;
        }
        if (cancelled) return;
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return wrapped as LobuFetch;
}

function normalizeBaseUrl(baseUrl: string): string {
  // Strip trailing slashes without a regex — `/\/+$/` trips CodeQL's
  // polynomial-ReDoS check on a long run of slashes, and a plain slice is both
  // safe and clearer.
  let trimmed = baseUrl.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  if (!trimmed) throw new Error("Lobu baseUrl is required");
  return trimmed;
}

function headersToRecord(
  headers: LobuHeaders | RequestInit["headers"] | undefined
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers as Iterable<readonly [string, string]>);
  }
  return headers as Record<string, string>;
}
