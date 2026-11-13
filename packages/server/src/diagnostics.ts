/** Structured HTTP and MCP diagnostics, collected from server stdout. */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ToolUserError } from './utils/errors';
import logger from './utils/logger';

const ERROR_REPORTED_FLAG = 'diagnosticErrorReported';

export function markErrorReported(c: Context): void {
  c.set(ERROR_REPORTED_FLAG as never, true as never);
}

export function isErrorReported(c: Context): boolean {
  return Boolean(c.get(ERROR_REPORTED_FLAG as never));
}

/**
 * A route's own error response, carrying the failure behind it. Throw it
 * instead of returning the response: the app's error boundary sends the
 * response unchanged and records `cause` on the request span, so the issue is
 * grouped by what failed rather than as a bare `HttpServerError: HTTP <status>`.
 * It does not log; the route still owns its log line.
 */
export function routeFailure(response: Response, cause: unknown): HTTPException {
  return new HTTPException(response.status as ContentfulStatusCode, { res: response, cause });
}

/** Retain the original exception when a route catches it and returns a 5xx. */
export function captureServerError(
  c: Context, error: unknown, source: string, httpStatus: number
): void {
  if (error instanceof ToolUserError || isErrorReported(c)) return;
  logger.error({ error, source, http_method: c.req.method,
    res_status: httpStatus, path: c.req.path }, 'HTTP handler failed');
  markErrorReported(c);
}

/**
 * Expected tool faults are returned to the caller; operational failures are
 * logged. A caller that left (`signal` aborted) is neither.
 */
export async function trackMCPToolCall<T>(
  toolName: string, handler: () => Promise<T>, signal?: AbortSignal
): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    if (!(error instanceof ToolUserError) && !signal?.aborted) {
      logger.error({ error, tool_name: toolName, source: 'mcp_tool' }, 'MCP tool failed');
    }
    throw error;
  }
}
