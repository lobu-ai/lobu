/**
 * Canonical access-control predicates shared by tool handlers.
 *
 * `executeTool` (REST/MCP boundary) and `routeAction` (per-action admin tool
 * dispatch) enforce the same role + MCP-scope policy with caller-specific
 * error copy; the decision logic lives here so the two paths cannot drift.
 */

import { hasRequiredMcpScope, type ToolAccessLevel } from '../auth/tool-access';
import { ToolUserError } from '../utils/errors';
import type { AccountToolContext, ToolContext } from './registry';

/** Narrow an account-dispatch context to a workspace-bound one, or reject. */
export function requireWorkspaceContext(ctx: AccountToolContext): ToolContext {
  if (!ctx.organizationId) {
    throw new ToolUserError(
      'Select a workspace with await client.org(target), or supply the tool’s explicit workspace target.',
      400
    );
  }
  return { ...ctx, organizationId: ctx.organizationId };
}

/** The minimal slice of ToolContext/AuthContext these predicates need. */
interface AccessControlContext {
  isAuthenticated: boolean;
  userId: string | null;
  memberRole: string | null;
  /** Present on ToolContext; used to distinguish in-process system calls from tokens. */
  tokenType?: string | null;
}

/**
 * Automation reactions and other in-process system calls run with
 * `userId=null + isAuthenticated=true` and no member role. They bypass
 * role/scope policy checks at the handler boundary.
 *
 * Do NOT use this alone as a data-exposure boundary for owner/admin-only
 * rows — see {@link isInProcessSystemCall}.
 */
export function isSystemContext(ctx: AccessControlContext): boolean {
  return ctx.isAuthenticated === true && ctx.userId === null && ctx.memberRole === null;
}

/**
 * True for a trusted in-process system call (automation reaction and friends),
 * which run with `userId: null` + `isAuthenticated: true` + `tokenType: 'session'`.
 *
 * `isSystemContext` alone also matches a userless OAuth/PAT token admitted to a
 * public org (memberRole null). Requiring `tokenType === 'session'` excludes
 * token callers while keeping reaction/system sessions.
 */
export function isInProcessSystemCall(ctx: AccessControlContext): boolean {
  return isSystemContext(ctx) && ctx.tokenType === 'session';
}

/** True when the role grants admin-tier access (owner or admin). */
export function isAdminOrOwnerRole(memberRole: string | null | undefined): boolean {
  return memberRole === 'owner' || memberRole === 'admin';
}

/**
 * Caller-specific denial copy. `writeRole` is optional: the MCP/REST boundary
 * handles missing-membership writes via its public-readability branch instead,
 * so it omits the message and skips that check.
 */
interface AccessDenialMessages {
  adminRole: string;
  writeRole?: string;
  readScope: string;
  writeScope: string;
  adminScope: string;
}

/**
 * A token has already passed the workspace-role check but lacks an MCP scope
 * needed for the requested operation. Keeping this distinct from a role denial
 * lets nested SDK calls request progressive OAuth authorization without ever
 * offering an admin grant to an ordinary member.
 */
export class McpScopeRequiredError extends Error {
  constructor(
    message: string,
    readonly requiredScope: 'mcp:admin'
  ) {
    super(message);
    this.name = 'McpScopeRequiredError';
  }
}

/**
 * Enforce the role + MCP-scope policy for a required access level.
 * Throws the caller-provided message on denial; returns on success.
 */
export function enforceRoleScopeAccess(
  requiredAccess: ToolAccessLevel,
  memberRole: string | null,
  scopes: string[] | null | undefined,
  messages: AccessDenialMessages
): void {
  if (requiredAccess === 'admin' && !isAdminOrOwnerRole(memberRole)) {
    throw new Error(messages.adminRole);
  }

  if (requiredAccess === 'write' && messages.writeRole && !memberRole) {
    throw new Error(messages.writeRole);
  }

  if (!hasRequiredMcpScope(requiredAccess, scopes)) {
    if (requiredAccess === 'read') {
      throw new Error(messages.readScope);
    }
    if (requiredAccess === 'write') {
      throw new Error(messages.writeScope);
    }
    throw new McpScopeRequiredError(messages.adminScope, 'mcp:admin');
  }
}
