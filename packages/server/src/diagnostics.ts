/** Structured HTTP diagnostics, collected from server stdout. */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import logger from './utils/logger';

const ERROR_REPORTED_FLAG = 'diagnosticErrorReported';

export function markErrorReported(c: Context): void {
  c.set(ERROR_REPORTED_FLAG as never, true as never);
}

export function isErrorReported(c: Context): boolean {
  return Boolean(c.get(ERROR_REPORTED_FLAG as never));
}

/**
 * A route's own error response, carrying the failure behind it, reported once.
 * Throw it instead of returning the response: the app's error boundary sends
 * the response unchanged and records `cause` on the request span, so the issue
 * is grouped by what failed rather than as a bare `HttpServerError: HTTP <status>`.
 *
 * It writes the request's one error record — `cause` as the error, so its type,
 * typed code and stack set the issue's fingerprint and kind — and marks the
 * request reported, so the HTTP response middleware does not add a second
 * record for the same failure. A route never logs the failure itself as well.
 * A request whose caller already left is not reported, matching the HTTP
 * boundary: the failure is that caller's cancellation, not an issue.
 * `message` names the failure (default: the status and route template) and
 * `fields` add value-free context such as ids.
 */
export function routeFailure(
  c: Context, response: Response, cause: unknown,
  message?: string, fields?: Record<string, unknown>
): HTTPException {
  if (!isErrorReported(c) && !c.req.raw.signal.aborted) {
    logger.error({ ...fields, error: cause, source: 'route_failure', http_method: c.req.method,
      res_status: response.status, path: c.req.path },
    message ?? `HTTP ${response.status} from ${c.req.method} ${routePath(c)}`);
    markErrorReported(c);
  }
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
    // A subclass that never sets `name` inherits "Error"; its class names it.
    name: error instanceof Error && error.name === 'Error' ? error.constructor.name
      : typeof shape.name === 'string' && shape.name ? shape.name : 'Error',
    message: 'details withheld at a credential boundary',
    ...(code ? { code } : {}),
    ...(frames ? { stack: frames } : {}),
  };
}
