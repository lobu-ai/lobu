/**
 * Structured error taxonomy for connector and query (read) tool paths — lobu#2051 (Item 2).
 *
 * This is a *separate* catalog from `AGENT_ERRORS` (errors.ts), which is
 * agent-turn/worker-scoped and wired to `classifyError → renderAgentError → CTA`.
 * Connector/query tools (query_sql, query_sdk, run_sdk, manage_connections.test,
 * connector pushdown) do not go through that pipeline, so folding these codes into
 * `AgentErrorCode` would couple two unrelated flows. Instead this mirrors the
 * `OrchestratorError` precedent (a typed `code` + a `retryable` flag).
 *
 * Two consumers:
 *  - the caller / auto-retry layer branches on `retryable` (retry transient codes,
 *    never retry permanent ones) and correlates a failure via `call_id`;
 *  - the human/agent reads a stable `code` instead of a flaky message string.
 *
 * `retryable` is a *static property of the code*, not something each throw site
 * decides: `RATE_LIMITED` is always retryable, `AUTH_MISSING` never is. Throw sites
 * pick the right code; the catalog is the single source of truth for retryability.
 */

export type ToolErrorCode =
  // ── permanent: retrying the identical call cannot succeed ──
  /** No auth profile configured for a connector that requires one. */
  | "AUTH_MISSING"
  /** Credentials were rejected by the upstream (HTTP 401/403). */
  | "AUTH_INVALID"
  /** Connector / feed / connection / resource does not exist (HTTP 404). */
  | "NOT_FOUND"
  /** Malformed args or SQL, or a read-only violation. */
  | "VALIDATION"
  /** Denied by org-scope / cross-org visibility rules. */
  | "PERMISSION"
  // ── transient: the same call may succeed on retry ──
  /** Upstream throttled the request (HTTP 429 / too many requests). */
  | "RATE_LIMITED"
  /** Upstream request or DB statement timed out (e.g. PG 57014). */
  | "UPSTREAM_TIMEOUT"
  /** Upstream server error (HTTP 5xx). */
  | "UPSTREAM_5XX"
  /** Network-level failure reaching the upstream (econnrefused/reset/dns/socket). */
  | "NETWORK"
  /** Connector execution was unavailable (oom/crash) — retry once. */
  | "UPSTREAM_UNAVAILABLE"
  // ── fallback ──
  /** Unclassified failure. Non-retryable by default (don't mask real bugs behind retries). */
  | "INTERNAL";

export interface ToolErrorSpec {
  /** Whether retrying the identical call (no other change) may succeed. */
  retryable: boolean;
  /** Default human-facing message when the throw site supplies none. */
  message: string;
}

export const TOOL_ERRORS: Record<ToolErrorCode, ToolErrorSpec> = {
  AUTH_MISSING: {
    retryable: false,
    message: "No auth profile is configured for this connector.",
  },
  AUTH_INVALID: {
    retryable: false,
    message: "The connector's credentials were rejected.",
  },
  NOT_FOUND: {
    retryable: false,
    message: "The requested resource was not found.",
  },
  VALIDATION: {
    retryable: false,
    message: "The request was malformed.",
  },
  PERMISSION: {
    retryable: false,
    message: "Not permitted in this organization scope.",
  },
  RATE_LIMITED: {
    retryable: true,
    message: "The upstream rate limit was hit; retry shortly.",
  },
  UPSTREAM_TIMEOUT: {
    retryable: true,
    message: "The upstream request timed out.",
  },
  UPSTREAM_5XX: {
    retryable: true,
    message: "The upstream server returned an error.",
  },
  NETWORK: {
    retryable: true,
    message: "A network error occurred reaching the upstream.",
  },
  UPSTREAM_UNAVAILABLE: {
    retryable: true,
    message: "The connector process was unavailable.",
  },
  INTERNAL: {
    retryable: false,
    message: "An internal error occurred.",
  },
};

/** Whether a code is retryable, per the catalog. */
export function isRetryable(code: ToolErrorCode): boolean {
  return TOOL_ERRORS[code].retryable;
}

/** Parse a `ToolErrorCode` from an unknown value (payload/DB boundary). */
export function toToolErrorCode(value: unknown): ToolErrorCode | undefined {
  if (typeof value !== "string") return undefined;
  return Object.getOwnPropertyDescriptor(TOOL_ERRORS, value) !== undefined
    ? (value as ToolErrorCode)
    : undefined;
}

/**
 * A typed error for connector/query paths that already *throw* (as opposed to the
 * soft-error paths, which carry `{ code, retryable }` on their result object).
 *
 * `callId` is stamped at the `executeTool` boundary so a thrown failure can be
 * correlated across logs/audit with the single tool invocation that produced it.
 */
export class ToolError extends Error {
  readonly name = "ToolError";
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  /** Per-invocation correlation id, stamped at the executeTool boundary. */
  callId?: string;

  constructor(
    code: ToolErrorCode,
    message?: string,
    options?: { cause?: unknown; callId?: string }
  ) {
    super(message ?? TOOL_ERRORS[code].message, { cause: options?.cause });
    this.code = code;
    this.retryable = TOOL_ERRORS[code].retryable;
    this.callId = options?.callId;
  }

  toJSON(): {
    code: ToolErrorCode;
    retryable: boolean;
    message: string;
    call_id?: string;
  } {
    return {
      code: this.code,
      retryable: this.retryable,
      message: this.message,
      ...(this.callId ? { call_id: this.callId } : {}),
    };
  }
}

/** Narrow an unknown thrown value to a `ToolError`. */
export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

/**
 * A structured signal describing an upstream/execution failure. Any field that is
 * present is trusted over the message string. `message` is the last-resort input:
 * keyword matching is fragile (a user's data can contain "429" or "timeout"), so it
 * only runs when no structured field classifies the error.
 */
export interface ToolErrorSignal {
  /** HTTP status from an upstream call (connector remote API). */
  httpStatus?: number;
  /** PostgreSQL SQLSTATE, e.g. "57014" (query_canceled / statement timeout). */
  pgCode?: string;
  /** Connector run exit reason, when the failure came from the executor. */
  exitReason?: "timeout" | "oom" | "crash" | "error_message";
  /** Whether an upstream HTTP layer already judged this transient (from withHttpRetry). */
  transient?: boolean;
  /** Raw message — used only as a fallback when nothing above classifies. */
  message?: string;
}

const RATE_LIMIT_MESSAGE_KEYWORDS = ["429", "rate limit", "too many requests"];

const NETWORK_MESSAGE_KEYWORDS = [
  "network",
  "econnrefused",
  "etimedout",
  "enotfound",
  "econnreset",
  "epipe",
  "eai_again",
  "fetch failed",
  "socket",
  "connection reset",
  "connection refused",
  "connection terminated",
  "connection timeout",
  "service unavailable",
  "gateway timeout",
  "server closed",
];

/**
 * Map a structured signal (preferred) — or, as a last resort, a message string —
 * to a `ToolErrorCode`. Precedence: HTTP status → PG code → run exit reason
 * → explicit `transient` judgment → message keywords → `INTERNAL`.
 *
 * This replaces the duplicated keyword lists in connector-sdk/src/retry.ts; those
 * should source their retry decision from `isRetryable(classifyToolError(...))`.
 */
export function classifyToolError(signal: ToolErrorSignal): ToolErrorCode {
  const { httpStatus, pgCode, exitReason, transient, message } = signal;

  if (typeof httpStatus === "number") {
    if (httpStatus === 429) return "RATE_LIMITED";
    if (httpStatus === 401 || httpStatus === 403) return "AUTH_INVALID";
    if (httpStatus === 404) return "NOT_FOUND";
    if (httpStatus === 408 || httpStatus === 504) return "UPSTREAM_TIMEOUT";
    if (httpStatus >= 500) return "UPSTREAM_5XX";
    if (httpStatus >= 400) return "VALIDATION";
  }

  // Only a real 5-char SQLSTATE is authoritative here. The postgres.js driver also
  // surfaces connection-level failures with a non-SQLSTATE `code` (e.g.
  // 'ECONNREFUSED', 'CONNECTION_CLOSED') — those must fall through to the message
  // matching below so a transient DB-connection drop stays NETWORK, not VALIDATION.
  // A five-letter errno such as 'EPIPE' fits the SQLSTATE shape too. Generic
  // `Error.code` callers cannot prove an E-prefixed value came from PostgreSQL,
  // so let those ambiguous codes fall through to message matching.
  if (pgCode && /^[0-9A-Z]{5}$/.test(pgCode) && !pgCode.startsWith("E")) {
    if (pgCode === "57014") return "UPSTREAM_TIMEOUT"; // query_canceled / statement_timeout
    // 08xxx = connection exceptions (transient); 40001 = serialization failure; 40P01 = deadlock.
    if (pgCode.startsWith("08") || pgCode === "40001" || pgCode === "40P01")
      return "NETWORK";
    // Everything else (syntax, constraint, etc.) is the caller's fault → not retryable.
    return "VALIDATION";
  }

  if (exitReason) {
    if (exitReason === "timeout") return "UPSTREAM_TIMEOUT";
    if (exitReason === "oom" || exitReason === "crash")
      return "UPSTREAM_UNAVAILABLE";
    // "error_message" is the connector-thrown case with no structured signal —
    // fall through to message matching below.
  }

  if (transient === true) return "NETWORK";

  if (message) {
    const lower = message.toLowerCase();
    if (RATE_LIMIT_MESSAGE_KEYWORDS.some((kw) => lower.includes(kw)))
      return "RATE_LIMITED";
    if (NETWORK_MESSAGE_KEYWORDS.some((kw) => lower.includes(kw)))
      return "NETWORK";
  }

  return "INTERNAL";
}
