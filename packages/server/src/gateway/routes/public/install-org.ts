import { createLogger } from "@lobu/core";
import type { Context } from "hono";
import { getDb } from "../../../db/client.js";
import { isAdminOrOwnerRole } from "../../../tools/access-control.js";
import {
  getMembershipRole,
  getOrgBySlug,
} from "../../../workspace/multi-tenant.js";

const logger = createLogger("install-org");

/** The authenticated user id stamped onto the request by `createLobuAuthBridge`. */
export function readUserId(c: Context): string | null {
  const user = c.get("user" as never) as { id?: string } | null | undefined;
  return typeof user?.id === "string" && user.id.length > 0 ? user.id : null;
}

/**
 * Resolve the active organization id for the current request.
 *
 * Priority:
 *  1. `c.get('organizationId')` — set by the lobuApp wrapper after
 *     `resolveDefaultOrgId(user.id)` (see `lobu/gateway.ts`). This is the
 *     value Postgres-backed stores read via AsyncLocalStorage, so binding
 *     install state to it keeps the OAuth flow aligned with where the
 *     resulting connection row will be written.
 *  2. `c.get('session')?.activeOrganizationId` — better-auth's stamped
 *     active org, used when the wrapper hasn't run (rare; defensive).
 *
 * Returns `null` if neither is present — caller must reject the request
 * (after consulting {@link resolveSingleTenantOrgId} for the self-host
 * fallback).
 */
function readSessionOrgId(c: Context): string | null {
  const fromContext = c.get("organizationId" as never) as
    | string
    | null
    | undefined;
  if (typeof fromContext === "string" && fromContext.length > 0) {
    return fromContext;
  }
  const session = c.get("session" as never) as
    | { activeOrganizationId?: string | null }
    | null
    | undefined;
  const fromSession = session?.activeOrganizationId;
  if (typeof fromSession === "string" && fromSession.length > 0) {
    return fromSession;
  }
  return null;
}

/**
 * Self-host fallback: when there's exactly one organization row in the
 * database, return its id. This keeps install routes usable on
 * single-tenant deployments where the route is mounted without the
 * lobuApp session middleware that populates `c.get('organizationId')`.
 *
 * Returns `null` when zero or more than one org rows exist — in those
 * cases the caller must reject; we won't silently pick a tenant.
 */
async function resolveSingleTenantOrgId(): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT id FROM organization LIMIT 2
    `) as Array<{ id: string }>;
    if (rows.length === 1) return rows[0]!.id;
    return null;
  } catch (err) {
    logger.warn(
      { err: String(err) },
      "Single-tenant org lookup failed — treating as ambiguous"
    );
    return null;
  }
}

/**
 * Resolve an EXPLICIT install target org supplied by the UI (`?org=<slug|id>`),
 * authorized by membership. This is the org the user was actually viewing when
 * they clicked "Install" — the single source of truth for where the connection
 * is created. It intentionally does NOT fall back to the ambient "active org":
 * that silently drifts from the UI selection (the connectors page can show org A
 * while the session's active org is B), which lands installs in the wrong tenant.
 *
 * Returns the resolved org id only when the request's user is a member of it.
 * On self-host (no authenticated user) the requested org is honored only when it
 * is the sole tenant. Returns `null` otherwise — the caller MUST reject rather
 * than silently retarget.
 */
async function resolveRequestedOrgId(
  c: Context,
  requested: string
): Promise<string | null> {
  // The UI passes the org slug from its route; fall back to treating the value
  // as a raw org id when it doesn't resolve as a slug. Membership gates both.
  let orgId: string | null = null;
  try {
    const bySlug = await getOrgBySlug(requested);
    orgId = bySlug?.id ?? null;
  } catch (err) {
    logger.warn(
      { err: String(err), requested },
      "Requested-org slug lookup failed"
    );
  }
  if (!orgId) orgId = requested;

  const userId = readUserId(c);
  if (userId) {
    const role = await getMembershipRole(orgId, userId);
    if (role) return orgId;
    logger.warn(
      { requested, orgId },
      "Rejecting explicit install org: user is not a member"
    );
    return null;
  }

  // No authenticated user (self-host): only honor the requested org when it is
  // the single tenant, so a stray ?org= can't select a foreign tenant.
  const single = await resolveSingleTenantOrgId();
  return single !== null && single === orgId ? orgId : null;
}

/**
 * Resolve the install-flow org for the current request.
 *
 * Precedence:
 *   1. Explicit `?org=<slug|id>` from the install link — the org the user chose
 *      in the UI, authorized by membership ({@link resolveRequestedOrgId}). When
 *      present but unauthorized/unknown, returns `null` so the route rejects
 *      rather than silently falling back to a different org.
 *   2. The session-bound active org (legacy links, CLI).
 *   3. The self-host single-tenant fallback.
 *
 * Shared by every app-installation flow (the generic install engine in
 * `app-install.ts`), so it lives here rather than in any one provider's module.
 */
export async function resolveInstallOrgId(c: Context): Promise<string | null> {
  const requested = c.req.query("org")?.trim();
  if (requested) {
    return resolveRequestedOrgId(c, requested);
  }
  const sessionOrgId = readSessionOrgId(c);
  if (sessionOrgId) return sessionOrgId;
  return resolveSingleTenantOrgId();
}

/**
 * Authorize install-flow COMPLETION against the org the install was started for
 * (carried in the signed OAuth state). Used by the callback instead of
 * re-deriving the ambient active org and comparing it to the state's org: that
 * comparison rejects a legitimate install whenever the user's active org drifted
 * from the org they launched the install from (the UI-selected org threaded via
 * `?org=`). Membership is the real authorization — the state org was already
 * membership-checked at start, so the callback just re-confirms the completing
 * user still belongs to it.
 *
 * On self-host (no authenticated user) the org is authorized only when it is the
 * sole tenant.
 */
export async function verifyInstallOrgAccess(
  c: Context,
  organizationId: string
): Promise<boolean> {
  const userId = readUserId(c);
  if (userId) {
    const role = await getMembershipRole(organizationId, userId);
    return role !== null;
  }
  const single = await resolveSingleTenantOrgId();
  return single !== null && single === organizationId;
}

/**
 * Stronger install authorization for destructive ownership moves. Ordinary app
 * installation completion needs plain membership; moving an installation between
 * workspaces requires owner/admin, and the GitHub transfer flow calls this for
 * BOTH the source and the target org — one demoted, one claimed.
 */
export async function verifyInstallOrgAdminAccess(
  c: Context,
  organizationId: string
): Promise<boolean> {
  const userId = readUserId(c);
  if (userId) {
    return isAdminOrOwnerRole(
      await getMembershipRole(organizationId, userId)
    );
  }
  const single = await resolveSingleTenantOrgId();
  return single !== null && single === organizationId;
}
