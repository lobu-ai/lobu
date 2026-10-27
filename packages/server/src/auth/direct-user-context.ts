/**
 * A direct signed-in user request, rather than delegated account authority.
 * OAuth/PAT/MCP callers may act with a user's permissions; that does not make
 * their writes manual corrections or authorize human-only approval decisions.
 * These identities come from authenticated context, never tool arguments.
 */
export interface IdentityContext {
  userId?: string | null;
  agentId?: string | null;
  clientId?: string | null;
  mcpSessionId?: string | null;
  actingAutomationId?: number | null;
  sourceContext?: unknown;
}

/** Conversation attribution alone is not delegation: verified chat reviewers carry it too. */
export function hasDelegatedIdentity(ctx: IdentityContext): boolean {
  return !!ctx.agentId || !!ctx.clientId || !!ctx.mcpSessionId ||
    ctx.actingAutomationId != null;
}

/**
 * A verified person deciding directly: a user identity with no agent, OAuth
 * client (PATs carry `pat_<id>`), MCP transport or Automation behind it. Run
 * approvals and membership changes share this one rule.
 */
export function isHumanDecision(ctx: IdentityContext): boolean {
  return !!ctx.userId && !hasDelegatedIdentity(ctx);
}

/**
 * A manual edit by the signed-in user: direct authority and no chat turn behind
 * it. Chat turns entering another workspace lose their home agent binding
 * (sandbox/client-sdk.ts resolveChatSenderWorkspace) but remain agent edits.
 */
export function isManualUserEdit(ctx: IdentityContext): boolean {
  return !!ctx.userId && !hasDelegatedIdentity(ctx) && !ctx.sourceContext;
}
