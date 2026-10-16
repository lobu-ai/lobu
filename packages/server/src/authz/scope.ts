/**
 * AuthzScope — the value read seams use to compile visibility predicates.
 * The read principal is the requesting user or, for a headless Automation
 * script, its server-resolved creator. A null principal sees only org-visible
 * connections. Write policy and approvals use the execution context separately.
 */
import type { ChatTurnAccess } from '@lobu/core';
import { chatAccessOfToolContext } from './device-access';

export interface AuthzScope {
  /** The tenant. Every read is partitioned by this first. */
  organizationId: string;
  /**
   * User id used for read visibility. `null` excludes private connections.
   */
  principal: string | null;
  /** The durable agent identity when the read happens inside an agent run. */
  agentId?: string | null;
  /** Policy snapshot the read is compiled against. Reserved for M2+/M6. */
  policyVersion?: number | null;
  /**
   * The chat tier of the turn making the read, or null/absent when the caller
   * is not a chat turn. Live device reads decide on it (authz/device-access.ts).
   */
  chatAccess?: ChatTurnAccess | null;
}

/**
 * Build read scope without replacing the execution identity. An authenticated
 * user always takes precedence over the Automation's server-resolved creator.
 */
export function authzScopeFromToolContext(ctx: {
  organizationId: string;
  userId: string | null;
  agentId?: string | null;
  automationReadPrincipalId?: string | null;
  tokenType?: string;
  sourceContext?: { chatAccess?: ChatTurnAccess } | null;
}): AuthzScope {
  const chatAccess = chatAccessOfToolContext(ctx);
  return {
    organizationId: ctx.organizationId,
    principal: ctx.userId ?? ctx.automationReadPrincipalId ?? null,
    agentId: ctx.agentId ?? null,
    ...(chatAccess ? { chatAccess } : {}),
  };
}

/**
 * A headless/service scope: no principal, so only org-visible rows are returned
 * (fail-closed for private data). Use for internal reads without a user or
 * Automation creator principal.
 */
export function headlessScope(organizationId: string): AuthzScope {
  return { organizationId, principal: null };
}
