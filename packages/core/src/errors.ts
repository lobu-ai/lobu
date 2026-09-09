/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Replaces the ubiquitous `error instanceof Error ? error.message : String(error)`
 * idiom: `Error` (and subclasses) yield `.message`; anything else
 * (`throw "boom"`, `throw null`, a rejected non-Error) is stringified.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Base error class for all lobu errors. */
export abstract class BaseError extends Error {
  abstract readonly name: string;
  public operation?: string;

  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message);
    // Maintain proper prototype chain for instanceof checks.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Render the error chain as a single string. */
  getFullMessage(): string {
    if (!this.cause) return `${this.name}: ${this.message}`;
    const causeMsg =
      this.cause instanceof BaseError
        ? this.cause.getFullMessage()
        : this.cause.message;
    return `${this.name}: ${this.message}\nCaused by: ${causeMsg}`;
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      ...(this.operation && { operation: this.operation }),
      cause:
        this.cause instanceof BaseError
          ? this.cause.toJSON()
          : this.cause?.message,
      stack: this.stack,
    };
  }
}

export class WorkerError extends BaseError {
  override readonly name = "WorkerError";

  constructor(operation: string, message: string, cause?: Error) {
    super(message, cause);
    this.operation = operation;
  }
}

export class WorkspaceError extends BaseError {
  override readonly name = "WorkspaceError";

  constructor(operation: string, message: string, cause?: Error) {
    super(message, cause);
    this.operation = operation;
  }
}

export enum ErrorCode {
  DATABASE_CONNECTION_FAILED = "DATABASE_CONNECTION_FAILED",
  DEPLOYMENT_CREATE_FAILED = "DEPLOYMENT_CREATE_FAILED",
  DEPLOYMENT_DELETE_FAILED = "DEPLOYMENT_DELETE_FAILED",
  QUEUE_JOB_PROCESSING_FAILED = "QUEUE_JOB_PROCESSING_FAILED",
}

export class OrchestratorError extends BaseError {
  readonly name = "OrchestratorError";

  constructor(
    public code: ErrorCode,
    message: string,
    public details?: any,
    public shouldRetry: boolean = false,
    cause?: Error
  ) {
    super(message, cause);
  }

  static fromDatabaseError(error: any): OrchestratorError {
    // `error` can be null/undefined/primitive (e.g. `throw null`, or a pg pool
    // that rejects with no value mid-query). Reading `.code`/`.detail` off a
    // non-object would TypeError and replace the real DB failure with a
    // confusing "Cannot read properties of null" stack.
    const isObjectLike = typeof error === "object" && error !== null;
    const message = error instanceof Error ? error.message : String(error);
    return new OrchestratorError(
      ErrorCode.DATABASE_CONNECTION_FAILED,
      `Database error: ${message}`,
      isObjectLike ? { code: error.code, detail: error.detail } : undefined,
      true,
      error instanceof Error ? error : undefined
    );
  }

  toJSON(): Record<string, any> {
    return {
      ...super.toJSON(),
      code: this.code,
      details: this.details,
      shouldRetry: this.shouldRetry,
    };
  }
}

/**
 * Thrown when a worker spawn is declined because another replica already holds
 * the per-conversation lock for this turn — i.e. another pod legitimately OWNS
 * this conversation turn and is running it to completion.
 *
 * This is NOT a failure. It is the cross-pod "handled elsewhere" signal. Under
 * N>1 app replicas both pods drain the shared `thread_message` queue and race to
 * spawn the same per-conversation worker; exactly one wins the advisory lock.
 * The loser MUST drop silently — no user-facing error, no Critical log, no
 * retry (the winner holds the lock for the entire worker subprocess lifetime, so
 * retrying can never win). The winning pod discharges the shared turn-liveness
 * marker on its successful reply, so the user still receives the answer.
 *
 * Distinguished by type (not a magic message string) so the orchestrator can
 * tell "owned by another pod" apart from a genuine worker-startup failure (OOM,
 * spawn failure, bad config) which MUST still surface an error to the user.
 */
export class ConversationOwnedElsewhereError extends BaseError {
  readonly name = "ConversationOwnedElsewhereError";
}

export class ConfigError extends BaseError {
  readonly name = "ConfigError";
}

/**
 * The single catalog of user-facing agent-turn failures.
 *
 * Historically the same logical failure (e.g. "provider quota exhausted") was
 * classified and formatted in four independent places — the worker's
 * `classifyError`, a second ad-hoc regex in `worker.ts`, the Slack
 * `chat-response-bridge`, and the browser SSE `response-renderer` — plus the
 * turn-liveness sweep which invented its own string with no code at all. Each
 * past fix touched one layer while the other three kept diverging, so the same
 * error rendered differently depending on which layer terminalized first.
 *
 * This catalog makes an agent error DATA:
 *   1. The execution path classifies a message into a code.
 *   2. The code rides `ThreadResponsePayload.errorCode` to the gateway.
 *   3. Every renderer (Slack, Telegram, browser SSE) turns that code into
 *      text + CTA via the shared `renderAgentError`, keyed on this record.
 *
 * Adding a new failure mode requires one entry here plus its classifier pattern.
 * A raw error reaching a user is a signal to add an entry, not to hand-wire a
 * new branch in a renderer.
 */
export enum AgentErrorCode {
  /** Provider weekly/monthly/rate limit hit (e.g. a 429 "Limit Exhausted"). */
  PROVIDER_QUOTA_EXHAUSTED = "PROVIDER_QUOTA_EXHAUSTED",
  /** Provider credentials missing/invalid/expired. */
  PROVIDER_AUTH = "PROVIDER_AUTH",
  /** Model id not valid for the configured provider. */
  PROVIDER_UNKNOWN_MODEL = "PROVIDER_UNKNOWN_MODEL",
  /** Provider can't be routed through the gateway proxy (base URL unresolved). */
  PROVIDER_BASE_URL_UNRESOLVED = "PROVIDER_BASE_URL_UNRESOLVED",
  /** No model/provider selected for the agent at all. */
  NO_MODEL_CONFIGURED = "NO_MODEL_CONFIGURED",
  /**
   * Turn-liveness sweep terminalized the turn: no worker-driven signal within
   * the deadline (a worker blocked so long it stopped heartbeating). Carries a
   * code now so it renders through the same path instead of a hardcoded
   * "stopped responding" string.
   */
  WORKER_UNRESPONSIVE = "WORKER_UNRESPONSIVE",
  /** Worker process died mid-flight (pod crash/OOM) before it could reply. */
  WORKER_DIED = "WORKER_DIED",
  /** Deployment/worker failed to START, so the request never ran. */
  WORKER_STARTUP_FAILED = "WORKER_STARTUP_FAILED",
  /**
   * The provider aborted the turn on its own tool-call filter rather than
   * returning a usable stop reason — e.g. Gemini's
   * `finish_reason: function_call_filter: MALFORMED_FUNCTION_CALL`. A
   * provider-side, usually transient condition: nothing about the agent's
   * config is wrong, so it must not render as a worker crash.
   */
  PROVIDER_TOOL_CALL_FAILED = "PROVIDER_TOOL_CALL_FAILED",
  /** Session exceeded its time budget (exit 124); retried silently. */
  SESSION_TIMEOUT = "SESSION_TIMEOUT",
}

/**
 * What kind of call-to-action link a rendered error should carry. The renderer
 * resolves each kind to a concrete URL per surface (the resolver knows the org
 * slug / agent id / public web origin); the catalog stays URL-free so it can
 * live in `core` with no gateway dependency.
 */
export type AgentErrorCtaKind =
  | "agent-settings" // → <webOrigin>/<slug>/agents/<agentId>/settings
  | "provider-connect" // → exact provider connector detail, or connectors list
  | "provider-management" // → existing provider management, exact provider/model
  | "none";

/**
 * The spec is deliberately thin. Two families of failure:
 *
 *  - PROVIDER errors (quota/auth/unknown-model/routing) carry NO `message`: the
 *    provider's own error string rides in `payload.error`. When provider context
 *    is available, the gateway labels it and unwraps the common JSON message
 *    envelope without rewording the provider's sentence (including reset times).
 *    The spec only decides the CTA link to append.
 *
 *  - WORKER / config errors DO carry a `message`: they're synthesized by us (the
 *    sweep, the deployment manager, the model resolver) so there is no upstream
 *    provider string to fall back to.
 *
 * The renderer prefers `spec.message`, otherwise formats `payload.error`, and
 * appends the CTA.
 */
export interface AgentErrorSpec {
  /**
   * Fixed user-facing text, ONLY for errors we synthesize (no provider string
   * exists). Omit for provider errors — the renderer uses the relayed provider
   * message instead.
   */
  message?: string;
  cta: AgentErrorCtaKind;
  /** Label for the CTA button/link. */
  ctaLabel?: string;
  /**
   * When true, no user-facing message is emitted (bookkeeping only). Used for
   * SESSION_TIMEOUT, which the runs queue retries automatically.
   */
  silent?: boolean;
}

export const AGENT_ERRORS: Record<AgentErrorCode, AgentErrorSpec> = {
  // Provider errors — no `message`; the provider's own text is the body.
  // Provider-level failures (quota, credentials, routing) are fixed on the
  // existing provider's management surface. A model-level failure
  // (unknown/unallowed model) is fixed on the agent's settings.
  [AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED]: {
    cta: "provider-management",
    ctaLabel: "Manage provider",
  },
  [AgentErrorCode.PROVIDER_AUTH]: {
    cta: "provider-management",
    ctaLabel: "Reconnect provider",
  },
  [AgentErrorCode.PROVIDER_UNKNOWN_MODEL]: {
    cta: "agent-settings",
    ctaLabel: "Choose model",
  },
  [AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED]: {
    cta: "provider-management",
    ctaLabel: "Manage provider",
  },
  // The provider's own finish_reason string is not useful to an end user
  // ("function_call_filter: MALFORMED_FUNCTION_CALL"), so unlike the other
  // PROVIDER_* entries this one carries its own text and does NOT relay the
  // upstream blob. The raw message stays in the logs / Sentry.
  [AgentErrorCode.PROVIDER_TOOL_CALL_FAILED]: {
    message:
      "The model provider rejected its own tool call and ended the turn. This is usually temporary — please try again.",
    cta: "none",
  },
  // Errors we synthesize — carry our own text (no provider string to relay).
  [AgentErrorCode.NO_MODEL_CONFIGURED]: {
    message:
      "No model is configured for this agent. Choose a model in agent settings.",
    cta: "agent-settings",
    ctaLabel: "Choose a model",
  },
  [AgentErrorCode.WORKER_UNRESPONSIVE]: {
    message:
      "The agent didn't finish responding in time. This is usually temporary — please try again.",
    cta: "none",
  },
  [AgentErrorCode.WORKER_DIED]: {
    message:
      "The agent stopped unexpectedly before it could reply. This is usually temporary — please try again.",
    cta: "none",
  },
  [AgentErrorCode.WORKER_STARTUP_FAILED]: {
    message:
      "The agent couldn't start, so your request wasn't processed. Please try again in a moment.",
    cta: "none",
  },
  [AgentErrorCode.SESSION_TIMEOUT]: {
    cta: "none",
    silent: true,
  },
};

/**
 * Provider says: the key is VALID, the account just cannot spend — a balance,
 * credit, or billing-limit wall rather than a windowed rate limit.
 *
 * The native turn classifier maps this wording to
 * `PROVIDER_QUOTA_EXHAUSTED`, while `providerQuotaResetNotBefore` parks
 * an Automation for a day on the same wording. They were maintained as separate
 * literals and drifted in both directions: the parker learned OpenAI's
 * "no credits remaining" while the classifier did not, and the classifier
 * matched "insufficient quota" while the parker's
 * list did not. Because the server gates on the code the worker assigns, the
 * first drift silently disabled BOTH the day-park and the provider-health
 * writeback for OpenAI balance exhaustion (observed in prod 2026-08-05). This
 * union closes both — which deliberately promotes reset-less "insufficient
 * quota" wording (OpenAI/Azure billing) into the day-park; the retry-horizon
 * guard in `balanceExhaustedNotBefore` keeps windowed 429s out of it.
 *
 * Keep this to balance/billing wording only. Windowed limits ("too many
 * requests", a bare 429) classify as quota too, but must NOT day-park — they
 * self-heal, often within the minute.
 */
export const PROVIDER_BALANCE_EXHAUSTED =
  /credit balance is too low|insufficient (?:credits?|balance|funds|quota)\b|no resource package|billing_hard_limit_reached|payment required|exceeded your current quota|out of credits?\b|no credits remaining/i;

/** Parse an `AgentErrorCode` from an unknown value (payload/DB boundary). */
export function toAgentErrorCode(value: unknown): AgentErrorCode | undefined {
  if (typeof value !== "string") return undefined;
  return (Object.values(AgentErrorCode) as string[]).includes(value)
    ? (value as AgentErrorCode)
    : undefined;
}
