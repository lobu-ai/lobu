import type { AgentConfigStore } from "@lobu/core";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";

export interface AgentOwnershipConfig {
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: Pick<AgentConfigStore, "getMetadata">;
}

export interface AgentOwnershipResult {
  authorized: boolean;
  ownerPlatform?: string;
  ownerUserId?: string;
  /**
   * Resolved organization id for the agent the session is authorised to
   * access. agents is keyed (organization_id, id) — the SAME agent id can
   * exist in multiple orgs — so the org id must come from the
   * authorisation result, not from a later unscoped `SELECT FROM agents
   * WHERE id = ?` lookup (codex P2 on PR #865, same shape as PR #836's
   * tenant-isolation findings).
   */
  organizationId?: string;
}

// `external` sessions carry an OAuth-provider user ID, so prefer that as the
// canonical lookup key; every other platform hands us a deterministic user ID
// directly (e.g. Telegram's claim-code flow), so `session.userId` is
// authoritative.
export function resolveSettingsLookupUserId(
  session: SettingsTokenPayload
): string {
  return session.platform === "external"
    ? session.oauthUserId || session.userId
    : session.userId;
}

function sessionMatchesMetadataOwner(
  session: SettingsTokenPayload,
  ownerPlatform: string,
  ownerUserId: string
): boolean {
  const lookupUserId = resolveSettingsLookupUserId(session);
  if (!lookupUserId || ownerUserId !== lookupUserId) {
    return false;
  }

  return ownerPlatform === session.platform || session.platform === "external";
}

/**
 * Resolve the authorised organization id for `(session, agentId)`.
 *
 * Reads `agent_users` directly via `UserAgentsStore.findAgentOrganizations`
 * — that table IS the per-org owner mapping. Prior versions of this code
 * resolved org from `agents` via `(id, owner_platform, owner_user_id)`,
 * but those columns are legacy and only unique by convention; a single
 * human owning the same agentId across two orgs would get the wrong
 * row. Codex round 2 finding B on PR #865.
 *
 * Returns `undefined` when the user owns no instance of `agentId` (no
 * matching `agent_users` row in any org) OR owns it in more than one org.
 * The non-admin path now treats a defined result as the authorisation
 * signal itself: a single owning org means the caller demonstrably owns
 * this agent (the row names their own platform+userId) and that org is the
 * agent's real tenant — independent of the request's ambient org-context,
 * which on the unscoped chat route is the caller's DEFAULT org and need
 * not match the agent's org. Downstream code (snapshot fallback) treats
 * `undefined` as "no scope to query under" and returns null rather than
 * serving cross-tenant bytes.
 *
 * When `agent_users` has multiple rows (same user, same agentId,
 * multiple orgs) we deliberately take none — there's no way to pick
 * tenant-safely from a session that doesn't carry an org id. The HTTP
 * URL has no org slug for this route, so the only safe result is to
 * decline and let the snapshot path fall through to the on-disk file
 * (which is already pinned to the deployment's single workspace).
 */
async function resolveAuthorizedOrgId(
  store: UserAgentsStore | undefined,
  agentId: string,
  ownerPlatform: string | undefined,
  ownerUserId: string | undefined
): Promise<string | undefined> {
  if (!store || !ownerPlatform || !ownerUserId) return undefined;
  const orgs = await store.findAgentOrganizations(
    ownerPlatform,
    ownerUserId,
    agentId
  );
  if (orgs.length !== 1) return undefined;
  return orgs[0];
}

export async function verifyOwnedAgentAccess(
  session: SettingsTokenPayload,
  agentId: string,
  config: AgentOwnershipConfig
): Promise<AgentOwnershipResult> {
  if (session.isAdmin) {
    // Admin: ownership not required. We don't have a session-bound org
    // for this case, and resolving from `agents` alone risks the same
    // cross-tenant leak the rest of this file just got fixed for. Leave
    // organizationId undefined; downstream snapshot reads will decline
    // rather than serve arbitrary tenant bytes.
    return { authorized: true };
  }

  if (session.agentId) {
    if (session.agentId !== agentId) {
      return { authorized: false };
    }
    // The session is bound to a single agent. Pin the org via the same
    // agent_users authoritative source the non-admin path uses below;
    // if the session predates that mapping the org stays undefined and
    // the snapshot fallback declines.
    const lookupUserId = resolveSettingsLookupUserId(session);
    const organizationId = await resolveAuthorizedOrgId(
      config.userAgentsStore,
      agentId,
      session.platform,
      lookupUserId || undefined
    );
    return { authorized: true, organizationId };
  }

  const lookupUserId = resolveSettingsLookupUserId(session);
  if (config.userAgentsStore) {
    // Authorize against the org the agent ACTUALLY lives in, resolved from
    // the authoritative `agent_users` mapping — NOT the caller's ambient
    // org-context. The cookie/session routes (SPA chat: POST/GET
    // /api/v1/agents[/*] + the EventSource SSE that can't send headers)
    // reach here under `createLobuOrgContextMiddleware`, which pins the ALS
    // org to the user's DEFAULT org. A user whose default org differs from
    // the agent's org (e.g. owning `crm` in `org_lobucrm` while their
    // personal org is the default) would fail an ALS-scoped `ownsAgent`
    // lookup and get a spurious 403 on every chat run. `findAgentOrganizations`
    // answers "which orgs does THIS user own THIS agent in" independent of
    // the ambient org, so chat works for any agent the signed-in user
    // legitimately owns. Tenant isolation holds: the result is keyed on the
    // caller's own (platform, userId) — a caller can only authorize against
    // agent_users rows that name them, never another tenant's agent. When the
    // user owns the same agentId in multiple orgs we decline (orgs.length !==
    // 1 in resolveAuthorizedOrgId) because the unscoped route carries no org
    // selector to disambiguate tenant-safely.
    const organizationId = await resolveAuthorizedOrgId(
      config.userAgentsStore,
      agentId,
      session.platform,
      lookupUserId
    );
    if (organizationId) {
      return {
        authorized: true,
        ownerPlatform: session.platform,
        ownerUserId: lookupUserId,
        organizationId,
      };
    }
  }

  if (!config.agentMetadataStore) {
    return { authorized: false };
  }

  const metadata = await config.agentMetadataStore.getMetadata(agentId);
  if (
    !metadata?.owner ||
    !sessionMatchesMetadataOwner(
      session,
      metadata.owner.platform,
      metadata.owner.userId
    )
  ) {
    return { authorized: false };
  }

  if (config.userAgentsStore) {
    config.userAgentsStore
      .addAgent(session.platform, lookupUserId, agentId)
      .catch(() => {
        /* best-effort reconciliation */
      });
  }

  // Prefer `metadata.organizationId` — postgres-backed AgentConfigStore
  // populates it from the same row that vouched for ownership above, so
  // it's tenant-safe by construction. Fall back to the agent_users
  // mapping if the in-memory store didn't set it.
  const organizationId =
    metadata.organizationId ??
    (await resolveAuthorizedOrgId(
      config.userAgentsStore,
      agentId,
      metadata.owner.platform,
      metadata.owner.userId
    ));
  return {
    authorized: true,
    ownerPlatform: metadata.owner.platform,
    ownerUserId: metadata.owner.userId,
    organizationId,
  };
}

/**
 * Create a token verifier function scoped to a given config.
 *
 * The returned async function accepts a decoded settings token payload and an
 * agentId, then returns the payload if the caller is authorised, or null.
 */
export function createTokenVerifier(config: AgentOwnershipConfig) {
  return async (
    payload: SettingsTokenPayload | null,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!payload) return null;
    const result = await verifyOwnedAgentAccess(payload, agentId, config);
    return result.authorized ? payload : null;
  };
}

/**
 * Same as `createTokenVerifier` but returns the full ownership result —
 * authorisation status PLUS the resolved organizationId. Use this when a
 * caller needs to scope subsequent queries by org (snapshot fallback,
 * stats, etc.).
 */
export function createOwnershipResolver(config: AgentOwnershipConfig) {
  return async (
    payload: SettingsTokenPayload | null,
    agentId: string
  ): Promise<AgentOwnershipResult> => {
    if (!payload) return { authorized: false };
    return verifyOwnedAgentAccess(payload, agentId, config);
  };
}
