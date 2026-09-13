import { getRequiredAccessLevel } from '../../auth/tool-access';
import { ToolUserError } from '../../utils/errors';
import logger from '../../utils/logger';
import { enforceRoleScopeAccess, isSystemContext } from '../access-control';
import type { ToolContext } from '../registry';
import { getErrorMessage } from "@lobu/core";

/**
 * Routes admin tool actions to handler functions with standardized error wrapping.
 *
 * Usage:
 *   return routeAction('manage_entity', args.action, ctx, {
 *     create: () => handleCreate(args, env, ctx),
 *     update: () => handleUpdate(id, args, env, ctx),
 *     list: () => handleList(args, env, ctx),
 *   });
 */
/**
 * Log level for an error caught in `routeAction`. ToolUserError is an expected
 * client fault (the REST/MCP layer turns it into a 4xx) — log it at `warn` so it
 * stays diagnosable without paging or leaking to the Sentry alert feed. Genuine
 * handler faults log at `error`. Exported for direct unit testing.
 */
export function errorLogLevel(error: unknown): 'warn' | 'error' {
  return error instanceof ToolUserError ? 'warn' : 'error';
}

function enforceActionAccess(toolName: string, action: string, ctx: ToolContext): void {
  // Automation reactions and other in-process system calls historically run with
  // userId=null + isAuthenticated=true. Preserve that path while enforcing the
  // policy table for real user/OAuth sessions that reach handlers via run / query.
  if (isSystemContext(ctx)) return;

  const requiredAccess = getRequiredAccessLevel(toolName, { action }, false);
  enforceRoleScopeAccess(requiredAccess, ctx.memberRole, ctx.scopes, {
    adminRole: `Action ${toolName}.${action} requires admin or owner access. Ask an organization owner to grant elevated access.`,
    writeRole: `Action ${toolName}.${action} requires workspace membership with write access.`,
    readScope: `Action ${toolName}.${action} requires an MCP session with read access.`,
    writeScope: `Action ${toolName}.${action} requires an MCP session with write access.`,
    adminScope: `Action ${toolName}.${action} requires an MCP session with admin access. Reconnect this client and grant the mcp:admin scope to run it.`,
  });
}

export async function routeAction<TResult>(
  toolName: string,
  action: string,
  ctx: ToolContext,
  handlers: Record<string, () => Promise<TResult>>
): Promise<TResult> {
  const handler = handlers[action];
  if (!handler) {
    // Unknown action is a caller/input fault (a 4xx), not an operational error.
    throw new ToolUserError(`Unknown action: ${action}`, 400);
  }

  enforceActionAccess(toolName, action, ctx);

  try {
    return await handler();
  } catch (error) {
    // ToolUserError is an expected client fault (bad input, not-found,
    // permission denied, conflict) that the REST/MCP layer turns into a 4xx for
    // the caller — it is NOT an operational error. Logging it at `error` both
    // spams the error log and (via the pino→Sentry bridge) created noisy alerts
    // for routine 409/403 outcomes. Log at `warn` so it stays diagnosable
    // without paging; genuine handler faults still log at `error`.
    logger[errorLogLevel(error)](
      {
        error,
        error_message: getErrorMessage(error),
        error_stack: error instanceof Error ? error.stack : undefined,
      },
      `${toolName} error:`
    );
    throw error;
  }
}

/**
 * Requires a field to be present, throwing a descriptive error if missing.
 * Common pattern for requiring entity_id, automation_id, etc. per action.
 */
export function requireField<T>(value: T | undefined | null, fieldName: string, action: string): T {
  if (value === undefined || value === null) {
    // Missing required input is a caller fault (a 400), not an operational
    // error — so it returns the right status and stays out of the Sentry feed.
    throw new ToolUserError(`${fieldName} is required for ${action} action`, 400);
  }
  return value;
}
