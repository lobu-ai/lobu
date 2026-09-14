import type { ToolErrorCode } from '@lobu/core';
import { isRetryable } from '@lobu/core';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gateway statuses a tool failure must never be reported with.
 *
 * The public gateway is fronted by Cloudflare, and the edge DISCARDS the
 * origin's body on exactly these two statuses, answering with its own bare
 * `error code: <n>` text instead. Measured against a Cloudflare-proxied origin
 * that echoes a requested status with a JSON body:
 *
 *   200 → `{"status":200}`   400 → `{"status":400}`   500 → `{"status":500}`
 *   503 → `{"status":503}`   502 → `error code: 502`  504 → `error code: 504`
 *
 * So a pushdown failure that left the origin on 502 arrived as that bare string:
 * the `{ error, code, retryable }` JSON the gateway sent never reached the
 * browser, and the SPA's error reader falls back to the raw response text when a
 * body is not JSON (`owletto/src/lib/api/core.ts`) — which is why the page
 * showed `error code: 502` and nothing else. 500 is the safe fallback precisely
 * because it is passed through untouched.
 */
const CDN_SUBSTITUTED_STATUSES: ReadonlySet<number> = new Set([502, 504]);

/**
 * The HTTP status a classified tool failure is reported with.
 *
 * No branch returns 502/504 (see {@link CDN_SUBSTITUTED_STATUSES}): the upstream
 * a *connection* depends on is not this origin's gateway, so a gateway status
 * both misdescribes the failure and risks costing the caller the only
 * description of it.
 *
 * Connector-credential failures map to 400 rather than 401/403: the CALLER's
 * own session is valid, and a 401 would read to the SPA as "sign in again".
 */
export function toolErrorHttpStatus(code: ToolErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'PERMISSION':
      return 403;
    case 'RATE_LIMITED':
      return 429;
    case 'VALIDATION':
    case 'AUTH_MISSING':
    case 'AUTH_INVALID':
      return 400;
    case 'UPSTREAM_TIMEOUT':
    case 'UPSTREAM_5XX':
    case 'UPSTREAM_UNAVAILABLE':
    case 'NETWORK':
    case 'INTERNAL':
      return 500;
  }
}

/**
 * Error class for client-input failures inside MCP/REST tools (bad path,
 * not-found, validation errors). Carries an HTTP status so the REST proxy
 * can return the right code, and is recognised by `trackMCPToolCall` to
 * avoid noisy Sentry alerts on 4xx-class outcomes.
 *
 * Optionally carries a structured `ToolErrorCode` (lobu#2051 Item 2). When a
 * throw site supplies one, the MCP/REST boundaries surface `{ code, retryable,
 * call_id }` and the auto-retry wrapper can honor `retryable`. `callId` is
 * stamped at the `executeTool` boundary.
 */
export class ToolUserError extends Error {
  readonly httpStatus: number;
  readonly code?: ToolErrorCode;
  readonly retryable: boolean;
  callId?: string;

  constructor(message: string, httpStatus = 400, code?: ToolErrorCode) {
    super(message);
    this.name = 'ToolUserError';
    // Guard the class, not one throw site: every wire boundary that answers a
    // tool call reads `httpStatus` straight off this error (`restErrorResponse`,
    // the input-file routes, the automation-trigger route, the notification
    // routes), so a 502/504 at any of the 500+ throw sites can cost the caller
    // the message. Re-derive from the structured code when there is one.
    this.httpStatus = CDN_SUBSTITUTED_STATUSES.has(httpStatus)
      ? code
        ? toolErrorHttpStatus(code)
        : 500
      : httpStatus;
    this.code = code;
    this.retryable = code ? isRetryable(code) : false;
  }
}

export function parsePositiveIntegerId(value: string, fieldName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ToolUserError(`${fieldName} must be a positive integer`, 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ToolUserError(`${fieldName} must be a positive integer`, 400);
  }
  return parsed;
}

/**
 * Thrown when a tool name reaches `executeTool` but is not registered. Indicates
 * registry/frontend drift (e.g. frontend `apiCall('foo', …)` references a name
 * the backend no longer registers). The REST proxy captures this to Sentry so
 * the next drift surfaces
 * as an alert rather than a 400 the page swallows.
 */
export class ToolNotRegisteredError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`);
    this.name = 'ToolNotRegisteredError';
    this.toolName = toolName;
  }
}

/** An expected, actionable startup configuration failure. */
export class BootConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootConfigError';
  }
}
