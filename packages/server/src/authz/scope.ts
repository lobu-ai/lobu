/**
 * AuthzScope — the single value every read seam compiles its scoping predicate
 * from. M1 introduces the type and routes the existing per-user
 * connection-visibility logic through one compiler (see ./connection-visibility);
 * later milestones grow `principal` into a verified `$member` (M3) and put
 * `policyVersion` to work (M2/M6). No runtime change at M1: `principal` is the
 * requesting user id and `null` means a headless/service caller (org-visible
 * rows only, fail-closed for private data).
 */
export interface AuthzScope {
  /** The tenant. Every read is partitioned by this first. */
  organizationId: string;
  /**
   * The requesting principal. Today the user id; M3 resolves it to a verified
   * `$member`. `null` = headless/service caller — private data is excluded
   * (fail-closed); only org-visible rows are returned.
   */
  principal: string | null;
  /** The durable agent identity when the read happens inside an agent run. */
  agentId?: string | null;
  /** Policy snapshot the read is compiled against. Reserved for M2+/M6. */
  policyVersion?: number | null;
}

/**
 * Build an AuthzScope from a tool/SDK execution context. The `ToolContext`
 * carries `userId: string | null` (the requesting user, null when anonymous /
 * headless) plus the durable `agentId` — exactly the inputs the scope needs.
 */
export function authzScopeFromToolContext(ctx: {
  organizationId: string;
  userId: string | null;
  agentId?: string | null;
}): AuthzScope {
  return {
    organizationId: ctx.organizationId,
    principal: ctx.userId,
    agentId: ctx.agentId ?? null,
  };
}

/**
 * A headless/service scope: no principal, so only org-visible rows are returned
 * (fail-closed for private data). Use for automations / scheduled jobs / internal
 * reads that run without a requesting user.
 */
export function headlessScope(organizationId: string): AuthzScope {
  return { organizationId, principal: null };
}
