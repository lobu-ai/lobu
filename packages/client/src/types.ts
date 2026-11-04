import type {
  PostApiV1AgentsData,
  PostApiV1AgentsResponses,
} from "./generated/types.gen.js";

export type TokenProvider = string | (() => string | Promise<string>);

export type LobuFetch = typeof fetch;
export type LobuHeaders =
  | Headers
  | Record<string, string>
  | ReadonlyArray<readonly [string, string]>;

export interface LobuClientOptions {
  baseUrl: string;
  token: TokenProvider;
  fetch?: LobuFetch;
  headers?: LobuHeaders;
}

/**
 * Body for `POST /api/v1/agents`. Sourced from the generated OpenAPI types so it
 * stays in lockstep with the server's route schema — do NOT re-declare it here
 * (the previous hand-written twin had already drifted, missing `intent`).
 *
 * `networkConfig` and `nix` are server-trusted: mint sessions **server-side** —
 * never let an untrusted browser pick its own egress policy or runtime packages.
 */
export type CreateSessionRequest = NonNullable<PostApiV1AgentsData["body"]>;

/** `201` response of `POST /api/v1/agents`, from the generated OpenAPI types. */
export type CreateSessionResponse = PostApiV1AgentsResponses[201];

export interface SendMessageOptions {
  messageId?: string;
}

export interface SendMessageResponse {
  success: boolean;
  messageId: string;
  agentId?: string;
  jobId?: string;
  eventsUrl?: string;
  queued: boolean;
  traceparent?: string;
}

export interface LobuSseEvent<TData = unknown> {
  event: string;
  data: TData;
  id?: string;
  retry?: number;
}

/** `connected` payload. `agentId` is the *logical* agent id, not the session's conversation id. */
export interface LobuConnectedData {
  agentId: string;
  timestamp: number;
}

/** `output` payload: an incremental text delta from the agent. */
export interface LobuOutputData {
  type: "delta";
  content: string;
  timestamp: number;
  messageId?: string;
}

/** `complete` payload: the agent finished a turn. May settle several messages at once. */
export interface LobuCompleteData {
  type: "complete";
  messageId?: string;
  processedMessageIds?: string[];
  finalText?: string;
  timestamp: number;
}

/** `error`/`agent-error` payload. */
export interface LobuErrorData {
  type: "error";
  error: string;
  messageId?: string;
  processedMessageIds?: string[];
  timestamp: number;
}

/** `ping` heartbeat payload. */
export interface LobuPingData {
  timestamp: number;
}

interface LobuSseEnvelope {
  id?: string;
  retry?: number;
}

/**
 * Discriminated union of the agent SSE stream. The union is **closed** so that
 * matching on `event` narrows `data`. The richer interactive events
 * (`question`, `tool-approval`, …) are present by name with `unknown` data; to
 * type one yourself, pass an explicit payload type to `events<TData>()`.
 */
export type LobuAgentEvent =
  | (LobuSseEnvelope & { event: "connected"; data: LobuConnectedData })
  | (LobuSseEnvelope & { event: "output"; data: LobuOutputData })
  | (LobuSseEnvelope & { event: "complete"; data: LobuCompleteData })
  | (LobuSseEnvelope & { event: "error"; data: LobuErrorData })
  | (LobuSseEnvelope & { event: "agent-error"; data: LobuErrorData })
  | (LobuSseEnvelope & { event: "ping"; data: LobuPingData })
  | (LobuSseEnvelope & {
      event:
        | "status"
        | "ephemeral"
        | "question"
        | "link-button"
        | "tool-approval"
        | "suggestion"
        | "closed"
        | "stale";
      data: unknown;
    });

export interface AskOptions {
  /**
   * Correlation id for this turn. Defaults to a fresh random id. Must be unique
   * per call — `ask` resolves/rejects only on the terminal event carrying this
   * id, so reusing an id can resolve from a prior turn replayed via backlog.
   */
  messageId?: string;
  /** Abort the wait (and the underlying message send) early. */
  signal?: AbortSignal;
  /**
   * Reject if no terminal `complete` for this message arrives within this many
   * milliseconds. Defaults to 120000 (2 minutes).
   */
  timeoutMs?: number;
}

export interface AskResult {
  /** Concatenated `output` deltas for this message. */
  text: string;
  /** The correlation id used (echo of `AskOptions.messageId` or the generated one). */
  messageId: string;
}

export interface StreamEventsOptions {
  signal?: AbortSignal;
  headers?: LobuHeaders;
  /**
   * Maximum SSE connection attempts before the stream gives up and the async
   * iterator rejects. Defaults to 1 (no auto-reconnect): a non-OK response
   * (401/404/5xx) or network failure surfaces immediately instead of retrying
   * forever. Raise it to opt into reconnects for transient failures.
   */
  maxRetryAttempts?: number;
}
