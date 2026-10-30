/**
 * Canonical access-control predicates shared by tool handlers.
 *
 * `executeTool` (REST/MCP boundary) and `routeAction` (per-action admin tool
 * dispatch) enforce the same role + MCP-scope policy and render every denial
 * through `scopeDenialMessage`, so the two paths cannot drift.
 */

import { hasRequiredMcpScope, type ToolAccessLevel } from '../auth/tool-access';
import { ToolUserError } from '../utils/errors';
import { getOrganizationSlug } from '../utils/url-builder';
import type { AccountToolContext, TokenType, ToolContext } from './registry';

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

/**
 * A reader outside the workspace — anonymous, or signed in without membership —
 * viewing what a public workspace publishes. Such readers see the workspace's
 * knowledge, never its operational trail (see
 * {@link operationalTrailExclusionSql}).
 */
export function isPublicReader(ctx: AccessControlContext): boolean {
  return !isInProcessSystemCall(ctx) && !ctx.memberRole;
}

/** True when the role grants admin-tier access (owner or admin). */
export function isAdminOrOwnerRole(memberRole: string | null | undefined): boolean {
  return memberRole === 'owner' || memberRole === 'admin';
}

/** What a caller tried, at which tier, and as whom: the input to every denial message. */
interface AccessDenialInput {
  /** The tool action or tool the caller attempted, e.g. `manage_agents.delete`. */
  subject: string;
  requiredAccess: ToolAccessLevel;
  memberRole: string | null | undefined;
  tokenType?: TokenType | null;
  /** Workspace slug; null when the call is not bound to one workspace. */
  workspace: string | null;
  /** An account-level call (no single workspace role): skip the role standing. */
  accountScope?: boolean;
  /** A lower-tier route to the same goal, appended to an admin denial. */
  alternative?: string | null;
}

/**
 * The one rendering of a role or MCP-scope denial. OAuth grants are never
 * widened on refresh, so a connection approved below the tier an action needs
 * stays there until the user reconnects and picks a higher level on the Lobu
 * consent screen. "Administer workspaces" only takes effect for an owner/admin;
 * for a member, reconnecting cannot help, so say who can. The thrown error
 * class stays the structure; this only renders it.
 */
export function scopeDenialMessage(input: AccessDenialInput): string {
  const message = baseScopeDenialMessage(input);
  return input.requiredAccess === 'admin' && input.alternative
    ? `${message} ${input.alternative}`
    : message;
}

function baseScopeDenialMessage(input: AccessDenialInput): string {
  const { subject, requiredAccess, memberRole, tokenType, workspace, accountScope } = input;
  const inWorkspace = workspace ? ` in ${workspace}` : ' in this workspace';
  const ofWorkspace = workspace ? ` of ${workspace}` : ' of this workspace';

  if (requiredAccess === 'admin' && !accountScope && !isAdminOrOwnerRole(memberRole)) {
    const standing = memberRole
      ? `Your role${inWorkspace} is ${memberRole}`
      : `You are not a member${ofWorkspace}`;
    // A web session has no connection to reconnect; only a token caller might
    // think a higher consent level would help.
    const noReconnect = tokenType === 'session' ? '' : ', and reconnecting this app cannot change that';
    return `${subject} requires admin or owner access${inWorkspace}. ${standing}${noReconnect}. Ask an owner${ofWorkspace} to do it, or to give you the admin role.`;
  }

  if (tokenType === 'pat') {
    return `${subject} needs ${requiredAccess} access. This personal access token was created without it. Create a new token with mcp:${requiredAccess} in Lobu settings and use that instead.`;
  }

  const connectionTo = workspace ? `this connection to ${workspace}` : 'this connection';
  if (requiredAccess === 'admin') {
    // The consent screen offers only the levels the app requested, and some
    // apps never request mcp:admin, so never promise the admin option: send the
    // owner through the app's own step-up first, then to the web app or CLI.
    const standing = isAdminOrOwnerRole(memberRole)
      ? `As an ${memberRole}${ofWorkspace}, retry`
      : "If you're an owner/admin of the workspace, retry";
    return `${subject} needs admin access, which ${connectionTo} doesn't have (tokens aren't upgraded on refresh). ${standing} the action so this app asks you to grant more access; if it doesn't, disconnect and reconnect Lobu in this app's connector settings and choose 'Administer workspaces' if the consent screen offers it. If it isn't offered, this app doesn't request admin access; do this from the Lobu web app or CLI instead.`;
  }
  const reconnect =
    "disconnect Lobu in this app's connector settings, connect again, and choose";
  const connection = workspace ? `This connection to ${workspace}` : 'This connection';
  if (requiredAccess === 'write') {
    const adminOption = isAdminOrOwnerRole(memberRole)
      ? " (or 'Administer workspaces', if offered, to also allow admin actions)"
      : memberRole && !accountScope
        ? ''
        : " (or 'Administer workspaces', if offered and you're an owner/admin)";
    return `${subject} needs write access. ${connection} was approved read-only, and tokens are not upgraded on refresh. To fix it, ${reconnect} 'Read and make changes'${adminOption} on the Lobu consent screen.`;
  }
  return `${subject} needs read access. ${connection} was approved without it, and tokens are not upgraded on refresh. To fix it, ${reconnect} 'Read only' or a higher level on the Lobu consent screen.`;
}

/** {@link scopeDenialMessage} for a workspace-bound caller, naming the workspace by slug. */
export async function workspaceScopeDenialMessage(
  ctx: {
    organizationId: string | null;
    memberRole: string | null | undefined;
    tokenType?: TokenType | null;
  },
  subject: string,
  requiredAccess: ToolAccessLevel,
  alternative?: string | null
): Promise<string> {
  // Only reached on the denial path, so a lookup per denial is fine; a failed
  // lookup only loses the workspace name, never the denial.
  const workspace = await getOrganizationSlug(ctx.organizationId).catch(() => null);
  return scopeDenialMessage({
    subject,
    requiredAccess,
    memberRole: ctx.memberRole,
    tokenType: ctx.tokenType,
    workspace,
    alternative,
  });
}

/**
 * The caller is authenticated, but its workspace role or MCP scope does not
 * reach the access level the requested operation needs. The class is the
 * structure wire boundaries answer on (REST maps it to 403); the message only
 * renders it. Deliberately not a ToolUserError: `logToolCallFailure` drops a
 * sub-500 ToolUserError as an expected client fault, and a denial keeps the
 * tool-failure-log visibility it always had.
 */
export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * A `client.org()` or workspace-argument target outside the caller's reach: not
 * granted, not a member, or a session bound to its own workspace. A permission
 * denial wherever it surfaces; `reason` lets the caller offer re-consent.
 */
export class CrossOrgAccessDenied extends Error {
  readonly code = 'CrossOrgAccessDenied';
  readonly reason: 'ungranted_member' | 'unavailable';
  readonly workspaceSlug: string | null;
  constructor(message: string, opts?: { reason?: CrossOrgAccessDenied['reason']; workspaceSlug?: string | null }) {
    super(message);
    this.name = 'CrossOrgAccessDenied';
    this.reason = opts?.reason ?? 'unavailable';
    this.workspaceSlug = opts?.workspaceSlug ?? null;
  }
}

/**
 * A token has already passed the workspace-role check but lacks an MCP scope
 * needed for the requested operation. Keeping this distinct from a role denial
 * lets nested SDK calls request progressive OAuth authorization without ever
 * offering an admin grant to an ordinary member.
 */
export class McpScopeRequiredError extends AccessDeniedError {
  constructor(
    message: string,
    readonly requiredScope: 'mcp:admin'
  ) {
    super(message);
    this.name = 'McpScopeRequiredError';
  }
}

/** The slice of a tool context the role + MCP-scope gate reads. */
interface RoleScopeContext {
  organizationId: string | null;
  memberRole: string | null;
  scopes?: string[] | null;
  tokenType?: TokenType | null;
}

/**
 * Enforce the role + MCP-scope policy for a required access level. Throws on
 * denial with the message from {@link scopeDenialMessage}; returns on success.
 * `writeRole` is optional: the MCP/REST boundary handles missing-membership
 * writes via its public-readability branch instead, so it omits the message
 * and skips that check.
 */
export async function enforceRoleScopeAccess(
  requiredAccess: ToolAccessLevel,
  ctx: RoleScopeContext,
  subject: string,
  writeRole?: string,
  /** A lower-tier route to the same goal (`ownerAdminActionAlternative`); admin denials only. */
  alternative?: string | null
): Promise<void> {
  if (requiredAccess === 'admin' && !isAdminOrOwnerRole(ctx.memberRole)) {
    throw new AccessDeniedError(
      await workspaceScopeDenialMessage(ctx, subject, 'admin', alternative)
    );
  }

  if (requiredAccess === 'write' && writeRole && !ctx.memberRole) {
    throw new AccessDeniedError(writeRole);
  }

  if (!hasRequiredMcpScope(requiredAccess, ctx.scopes)) {
    const message = await workspaceScopeDenialMessage(ctx, subject, requiredAccess, alternative);
    if (requiredAccess === 'admin') throw new McpScopeRequiredError(message, 'mcp:admin');
    throw new AccessDeniedError(message);
  }
}
