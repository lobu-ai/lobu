/**
 * Sentry Integration for MCP Tool Monitoring
 *
 * Sentry.init() lives in instrument.ts (imported first in server.ts).
 * This module provides the MCP tool call tracking wrapper.
 */

import type { Context } from 'hono';
import * as Sentry from '@sentry/node';
import { ToolUserError } from './utils/errors';
import { getErrorMessage, scrubSentryValue } from '@lobu/core';
import logger from './utils/logger';

const SENTRY_CAPTURED_FLAG = 'sentryErrorCaptured';

/**
 * Mark the current request as already reported to Sentry so the response-level
 * post-middleware doesn't double-count it.
 */
export function markSentryReported(c: Context): void {
  c.set(SENTRY_CAPTURED_FLAG as never, true as never);
}

export function isSentryReported(c: Context): boolean {
  return Boolean(c.get(SENTRY_CAPTURED_FLAG as never));
}

/**
 * Capture a server-side error from inside a route's catch block. Use this when
 * the handler swallows the exception and returns a 500 JSON response — the
 * top-level `app.onError` only sees exceptions that bubble up, so without this
 * call the error never reaches Sentry. ToolUserError (4xx, user fault) is
 * skipped to keep the alert feed clean.
 *
 * After calling, set `markSentryReported(c)` is implicit so the response-level
 * post-middleware skips the same request.
 */
export function captureServerError(
  c: Context,
  error: unknown,
  source: string,
  httpStatus: number
): void {
  if (error instanceof ToolUserError) return;
  logger.error({ error, source, http_method: c.req.method, res_status: httpStatus,
    path: c.req.path, sentryReported: true }, 'HTTP handler failed');
  Sentry.captureException(error, {
    tags: {
      source,
      http_method: c.req.method,
      // Passed in, not read from `c.res`: every caller reports the error
      // before returning its response, and hono mints a placeholder 200 on
      // that first `c.res` access.
      http_status: String(httpStatus),
    },
    extra: {
      path: c.req.path,
      // `extra`, not `tags`: Host is client-supplied, so as an indexed tag its
      // value cardinality is unbounded by anything we control. Triage still
      // reads it here; the search index stays bounded.
      host: c.req.header('host') ?? 'unknown',
    },
  });
  markSentryReported(c);
}

/**
 * Track an MCP tool call with Sentry
 * Captures tool name, arguments, response, and execution time
 */
export async function trackMCPToolCall<T>(
  toolName: string,
  args: unknown,
  handler: () => Promise<T>
): Promise<T> {
  return await Sentry.startSpan(
    {
      name: `MCP Tool Call: ${toolName}`,
      op: 'mcp.tool.call',
      attributes: {
        'mcp.tool.name': toolName,
      },
    },
    async (span) => {
      try {
        // Execute the tool handler
        const result = await handler();

        // Set success attributes on span
        span?.setAttributes({
          'mcp.tool.status': 'success',
          'mcp.tool.arguments': JSON.stringify(scrubSentryValue(args)),
        });

        return result;
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);

        // 4xx-class outcomes raised by the tool itself (bad path, not found,
        // schema validation) aren't operational errors — annotate the span
        // but skip Sentry capture to keep the alert feed clean.
        const isUserError = error instanceof ToolUserError;

        if (!isUserError) {
          logger.error({ error, tool_name: toolName, source: 'mcp_tool', sentryReported: true },
            'MCP tool failed');
          Sentry.captureException(error, {
            tags: {
              tool_name: toolName,
              status: 'error',
            },
            extra: {
              arguments: scrubSentryValue(args),
              error_message: errorMessage,
            },
          });
        }

        span?.setAttributes({
          'mcp.tool.status': isUserError ? 'user_error' : 'error',
          'mcp.tool.error': errorMessage,
        });

        throw error;
      }
    }
  );
}
