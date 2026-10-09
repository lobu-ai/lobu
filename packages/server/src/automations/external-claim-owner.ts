import type { ToolContext } from '../tools/registry';
import { ToolUserError } from '../utils/errors';

/**
 * MCP sessions can rotate between calls. Bind leases to the authenticated caller
 * so claims remain resumable across transports; window tokens still fence the
 * run, attempt, and lease.
 */
export function encodeExternalAutomationClaimOwner(
  ctx: Pick<ToolContext, 'userId' | 'agentId' | 'clientId'>,
  action: 'claim_next_window' | 'complete_window' = 'claim_next_window'
): string {
  const identity = {
    user_id: ctx.userId ?? null,
    agent_id: ctx.agentId ?? null,
    client_id: ctx.clientId ?? null,
  };
  if (Object.values(identity).every((value) => value == null)) {
    throw new ToolUserError(
      `${action} requires an identified caller to own the window lease.`,
      403
    );
  }
  return `external:${JSON.stringify(identity)}`;
}
