/**
 * A direct signed-in user request, rather than delegated account authority.
 * OAuth/PAT/MCP callers may act with a user's permissions; that does not make
 * their writes manual corrections or authorize human-only approval decisions.
 * These identities come from authenticated context, never tool arguments.
 */
interface IdentityContext {
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
 * A manual edit by the signed-in user: direct authority and no chat turn behind
 * it. Chat turns entering another workspace lose their home agent binding
 * (sandbox/client-sdk.ts resolveChatSenderWorkspace) but remain agent edits.
 */
export function isManualUserEdit(ctx: IdentityContext): boolean {
  return !!ctx.userId && !hasDelegatedIdentity(ctx) && !ctx.sourceContext;
}
