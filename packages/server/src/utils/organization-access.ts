/**
 * Organization Access Utilities
 *
 * Provides helpers for organization-scoped database queries with
 * public/private organization support.
 *
 * Access Rules:
 * - Upstream routing enforces public/private workspace visibility.
 * - Workspace members can read; owners/admins can edit records.
 * - No-user contexts: an anonymous public-workspace read passes, but a write
 *   also needs `isAuthenticated` (system/internal calls like reaction scripts).
 */

import { type DbClient, getDb } from '../db/client';
import type { ToolContext } from '../tools/registry';
import { ToolUserError } from './errors';

/**
 * Read and write denials on an entity must be byte-identical: a caller that is
 * told "no access" for a record in another workspace must not be able to tell
 * it apart from one that never existed.
 */
const NO_RECORD_ACCESS = 'This record was not found in this workspace, or you do not have access to it.';

/**
 * Get the user's role in a workspace (organization).
 * Returns null if the user is not a member.
 */
export async function getWorkspaceRole(
  sql: DbClient,
  orgId: string,
  userId: string
): Promise<string | null> {
  const result = await sql`
    SELECT role FROM "member"
    WHERE "organizationId" = ${orgId} AND "userId" = ${userId}
    LIMIT 1
  `;
  return result.length > 0 ? (result[0].role as string) : null;
}

/**
 * Check if user can read an entity
 * Allowed if entity belongs to the user's organization and user is a member.
 */
async function canReadEntity(sql: DbClient, entityId: number, ctx: ToolContext): Promise<boolean> {
  const entityResult = await getDb()`
    SELECT e.organization_id
    FROM entities e
    WHERE e.id = ${entityId}
    LIMIT 1
  `;
  if (entityResult.length === 0) return false;

  const entityOrgId = String(entityResult[0].organization_id);
  if (entityOrgId !== ctx.organizationId) return false;
  if (!ctx.userId) return true;

  const orgRole = await getWorkspaceRole(sql, entityOrgId, ctx.userId);
  return orgRole !== null;
}

/**
 * Require read access or throw
 */
export async function requireReadAccess(
  sql: DbClient,
  entityId: number,
  ctx: ToolContext
): Promise<void> {
  const canRead = await canReadEntity(sql, entityId, ctx);
  if (!canRead) {
    throw new ToolUserError(NO_RECORD_ACCESS, 403);
  }
}

/**
 * Require write access or throw
 */
export async function requireWriteAccess(
  sql: DbClient,
  entityId: number,
  ctx: ToolContext
): Promise<void> {
  const rows = await getDb()`
    SELECT 1 FROM entities
    WHERE id = ${entityId} AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(NO_RECORD_ACCESS, 403);
  }
  const canWrite = await canWriteOrg(sql, ctx);
  if (!canWrite) {
    throw new ToolUserError("You don't have permission to edit records in this workspace. Ask a workspace owner or admin.", 403);
  }
}

/**
 * Check if the caller may write at the organization level (no entity scope).
 * Used by org-scoped resources like automations that have their own organization_id.
 */
async function canWriteOrg(sql: DbClient, ctx: ToolContext): Promise<boolean> {
  if (!ctx.organizationId) return false;

  // System/internal calls (e.g. reaction scripts) — authenticated context is sufficient
  if (!ctx.userId && ctx.isAuthenticated) return true;
  if (!ctx.userId) return false;

  const membership = await sql`
    SELECT 1
    FROM "member"
    WHERE "organizationId" = ${ctx.organizationId}
      AND "userId" = ${ctx.userId}
      AND role IN ('owner', 'admin')
    LIMIT 1
  `;
  return membership.length > 0;
}

/**
 * Check if the caller may read at the organization level (no entity scope).
 * Mirrors entity read automation: once the request is scoped to the organization,
 * anonymous/system contexts are allowed and authenticated users must be members.
 */
async function canReadOrg(sql: DbClient, ctx: ToolContext): Promise<boolean> {
  if (!ctx.organizationId) return false;
  if (!ctx.userId) return true;

  const orgRole = await getWorkspaceRole(sql, ctx.organizationId, ctx.userId);
  return orgRole !== null;
}

/**
 * Require organization-level read access or throw.
 */
export async function requireOrgReadAccess(sql: DbClient, ctx: ToolContext): Promise<void> {
  if (!ctx.organizationId) throw new ToolUserError('Select a workspace to view its records.', 403);
  const ok = await canReadOrg(sql, ctx);
  if (!ok) {
    throw new ToolUserError("You don't have permission to view this workspace. Ask a workspace owner or admin for access.", 403);
  }
}

/**
 * Require organization-level write access or throw.
 */
export async function requireOrgWriteAccess(sql: DbClient, ctx: ToolContext): Promise<void> {
  if (!ctx.organizationId) throw new ToolUserError('Select a workspace before making changes.', 403);
  const ok = await canWriteOrg(sql, ctx);
  if (!ok) {
    throw new ToolUserError("You don't have permission to make changes in this workspace. Ask a workspace owner or admin.", 403);
  }
}
