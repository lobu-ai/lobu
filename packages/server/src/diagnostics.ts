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

/**
 * A failure reduced to what may leave a credential boundary: its type, its
 * structured code (else its cause's, such as a transport `ECONNREFUSED`) and
 * its stack frames. The message is dropped because a transport error can carry
 * the authenticated URL, a header or a key. Pass it as `routeFailure`'s cause.
 */
export function redactedFailure(error: unknown): {
  name: string; message: string; code?: string; stack?: string;
} {
  const shape = (error && typeof error === 'object' ? error : {}) as {
    name?: unknown; code?: unknown; stack?: unknown; cause?: unknown;
  };
  const cause = (shape.cause && typeof shape.cause === 'object' ? shape.cause : {}) as { code?: unknown };
  const code = typeof shape.code === 'string' ? shape.code
    : typeof cause.code === 'string' ? cause.code : undefined;
  // Only `at ...` lines: a stack's header and continuation lines repeat the message.
  const frames = typeof shape.stack === 'string'
    ? shape.stack.split('\n').filter((line) => line.trimStart().startsWith('at ')).join('\n')
    : '';
  return {
    name: typeof shape.name === 'string' && shape.name ? shape.name : 'Error',
    message: 'details withheld at a credential boundary',
    ...(code ? { code } : {}),
    ...(frames ? { stack: frames } : {}),
  };
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
