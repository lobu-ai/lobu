/** Structured HTTP and MCP diagnostics, collected from server stdout. */
import type { Context } from 'hono';
import { ToolUserError } from './utils/errors';
import logger from './utils/logger';

const ERROR_REPORTED_FLAG = 'diagnosticErrorReported';

export function markErrorReported(c: Context): void {
  c.set(ERROR_REPORTED_FLAG as never, true as never);
}

export function isErrorReported(c: Context): boolean {
  return Boolean(c.get(ERROR_REPORTED_FLAG as never));
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

/** Expected tool faults are returned to the caller; operational failures are logged. */
export async function trackMCPToolCall<T>(
  toolName: string, handler: () => Promise<T>
): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    if (!(error instanceof ToolUserError)) {
      logger.error({ error, tool_name: toolName, source: 'mcp_tool' }, 'MCP tool failed');
    }
    throw error;
  }
}
