/**
 * AuthzScope — the value read seams use to compile visibility predicates.
 * The read principal is the requesting user or, for a headless Automation
 * script, its server-resolved creator. A null principal sees only org-visible
 * connections. Write policy and approvals use the execution context separately.
 */
import type { ChatTurnAccess } from '@lobu/core';
import { chatAccessOfToolContext, type DeviceAccessCaller } from './device-access';

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
}

/**
 * Scope for a live source read, which may run on a member's paired device.
 * `chatAccess` is required (null for a caller that is not a chat turn), so
 * every read path states the caller's tier for the device access rule
 * (authz/device-access.ts) instead of silently dropping it. Build one with
 * {@link sourceReadScopeFromToolContext}; a system caller writes the literal
 * with `chatAccess: null`.
 */
export type SourceReadScope = AuthzScope & { chatAccess: ChatTurnAccess | null };

/**
 * Build read scope without replacing the execution identity. An authenticated
 * user always takes precedence over the Automation's server-resolved creator.
 */
export function authzScopeFromToolContext(ctx: {
  organizationId: string;
  userId: string | null;
  agentId?: string | null;
  automationReadPrincipalId?: string | null;
}): AuthzScope {
  return {
    organizationId: ctx.organizationId,
    principal: ctx.userId ?? ctx.automationReadPrincipalId ?? null,
    agentId: ctx.agentId ?? null,
  };
}

/**
 * {@link authzScopeFromToolContext} plus the caller's tier for a live source
 * read. Both tier inputs are required: a caller cannot omit them by accident.
 */
export function sourceReadScopeFromToolContext(
  ctx: Parameters<typeof authzScopeFromToolContext>[0] & DeviceAccessCaller,
): SourceReadScope {
  return { ...authzScopeFromToolContext(ctx), chatAccess: chatAccessOfToolContext(ctx) };
}

/**
 * A headless/service scope: no principal, so only org-visible rows are returned
 * (fail-closed for private data). Use for internal reads without a user or
 * Automation creator principal.
 */
export function headlessScope(organizationId: string): AuthzScope {
  return { organizationId, principal: null };
}
