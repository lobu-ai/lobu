import { resolveActingPrincipal } from '../authz/entity-policy';
import { getDb } from '../db/client';
import { evaluatePreToolGuardrails } from '../gateway/guardrails/pre-tool';
import { getLobuCoreServices } from '../lobu/gateway';
import { ToolUserError } from '../utils/errors';
import logger from '../utils/logger';
import type { AccountToolContext, InboundToolCall } from './registry';

/**
 * Inbound pre-tool guardrails: a connected app's call to Lobu's own MCP server
 * (or REST tool API) runs the workspace's pre-tool guardrails that name that
 * app, in the workspace the call acts in. Call it wherever a tool context's
 * workspace is resolved, including a nested `client.org(x)` switch, so a
 * guardrail in workspace B applies when a script started in A reaches into B.
 *
 * The caller is the acting principal `resolveActingPrincipal` derives from the
 * verified token. Only an app principal is checked here: an agent's calls
 * already pass the outbound MCP proxy's pre-tool stage, and that lane must not
 * change. Unlike the proxy, this fails closed: when the guardrails cannot be
 * read or run, the call is refused rather than executed unchecked.
 *
 * A no-op without `ctx.inboundToolCall` (contexts built outside `executeTool`).
 * Each workspace is checked once per invocation, since a script may switch
 * into the same workspace on every SDK call.
 */
export function enforceInboundPreToolGuardrails(ctx: AccountToolContext): Promise<void> {
  const call = ctx.inboundToolCall;
  const organizationId = ctx.organizationId;
  if (!call || !organizationId || !ctx.appPrincipalId) return Promise.resolve();
  let check = call.checkedWorkspaces.get(organizationId);
  if (!check) {
    check = checkWorkspace(ctx, organizationId, call);
    call.checkedWorkspaces.set(organizationId, check);
  }
  return check;
}

async function checkWorkspace(
  ctx: AccountToolContext,
  organizationId: string,
  call: InboundToolCall
): Promise<void> {
  let tripped: boolean;
  try {
    const principal = await resolveActingPrincipal(getDb(), {
      organizationId,
      userId: ctx.userId,
      agentId: ctx.agentId,
      sessionAutomationId: ctx.actingAutomationId,
      appId: ctx.appPrincipalId,
    });
    if (principal.kind !== 'app') return;
    if (!ctx.userId) throw new Error('A connected-app call has no user');
    const trip = await evaluatePreToolGuardrails({
      registry: getLobuCoreServices()?.getGuardrailRegistry?.() ?? undefined,
      organizationId,
      principal,
      userId: ctx.userId,
      conversationId: ctx.mcpConversationId ?? undefined,
      toolName: call.toolName,
      arguments: call.arguments,
    });
    tripped = trip !== null;
  } catch (error) {
    logger.warn(
      { error, organizationId, appId: ctx.appPrincipalId, toolName: call.toolName },
      'Inbound pre-tool guardrails could not be checked; refusing the call'
    );
    throw new ToolUserError(
      'Tool call blocked: this workspace’s guardrails could not be checked. Try again.',
      500,
      'INTERNAL'
    );
  }
  if (tripped) throw new ToolUserError('Tool call blocked by policy.', 403, 'PERMISSION');
}
