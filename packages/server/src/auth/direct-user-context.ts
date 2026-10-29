import { ENTITY_MANUAL_EDIT_SCOPE } from './oauth/scopes';

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
  /** Scopes of the authenticating token. A web session carries the
   *  not-applicable sentinel (tools/execute.ts), never a real grant. */
  scopes?: readonly string[] | null;
  /** Preserved from the authenticated session, never caller input. */
  tokenDerivedSession?: boolean;
}

/** Conversation attribution alone is not delegation: verified chat reviewers carry it too. */
export function hasDelegatedIdentity(ctx: IdentityContext): boolean {
  return !!ctx.agentId || !!ctx.clientId || !!ctx.mcpSessionId ||
    ctx.actingAutomationId != null || !!ctx.tokenDerivedSession;
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

/** Why a `manual_edit` assertion is refused; null when it is honoured. */
export type ManualEditRefusal = 'missing_scope' | 'delegated_caller';

/**
 * Why `manual_edit: true` cannot be honoured for this caller, or null when it
 * can. Apart from the PAT/OAuth `clientId` it carries the same exclusions as
 * {@link isManualUserEdit}: an agent, MCP session, Automation or chat turn is
 * never a person's own edit, whatever its token holds. The `clientId` is
 * allowed because a first-party backend relaying a person's click is exactly
 * the caller this exists for, and the scope is only mintable by a person in a
 * web session (auth/routes.ts).
 */
export function manualEditRefusal(ctx: IdentityContext): ManualEditRefusal | null {
  if (!!ctx.agentId || !!ctx.mcpSessionId || ctx.actingAutomationId != null || !!ctx.sourceContext || ctx.tokenDerivedSession) {
    return 'delegated_caller';
  }
  if (!ctx.userId || !ctx.scopes?.includes(ENTITY_MANUAL_EDIT_SCOPE)) return 'missing_scope';
  return null;
}

/**
 * A delegated client asserting, through `manual_edit: true`, that the signed-in
 * person made this edit. Callers still combine it with the verified Automation
 * attribution guard, exactly as for {@link isManualUserEdit}.
 */
export function isAssertedManualEdit(
  ctx: IdentityContext,
  args: { manual_edit?: boolean | null }
): boolean {
  return args.manual_edit === true && manualEditRefusal(ctx) === null;
}
