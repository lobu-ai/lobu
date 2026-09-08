import type { DbClient } from "../../db/client";
import { isAdminOrOwnerRole } from "../../tools/access-control";
import { getWorkspaceRole } from "../../utils/organization-access";

/**
 * Authorization for a chat-link outside the installation's organization.
 * Callers bind `w` to automations and `s` to its exact message subscription.
 * A tag or a foreign connection id alone is never a grant: the recorded author
 * must still administer both workspaces. A provider's optional team identity
 * must match the one captured when the channel was linked, including absence.
 *
 * The role predicate is the SQL twin of `isAdminOrOwnerRole`; a correlated read
 * over `w.created_by` cannot call it, so keep the two definitions in step.
 */
export function crossOrganizationChatLinkScope(
  sql: DbClient,
  connectionOrganizationId: string,
  teamId?: string | null,
) {
  return sql`(
    w.tags @> ARRAY['system:chat-link']::text[]
    AND s.connection_organization_id = ${connectionOrganizationId}
    AND s.connection_status = 'active'
    AND s.credential_mode IS NOT NULL
    AND s.trigger_team_id IS NOT DISTINCT FROM ${teamId || null}
    AND EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = w.managed_agent_id AND a.organization_id = w.organization_id
    )
    AND EXISTS (
      SELECT 1 FROM member m
      WHERE m."userId" = w.created_by
        AND m."organizationId" = w.organization_id
        AND m.role IN ('owner', 'admin')
    )
    AND EXISTS (
      SELECT 1 FROM member m
      WHERE m."userId" = w.created_by
        AND m."organizationId" = ${connectionOrganizationId}
        AND m.role IN ('owner', 'admin')
    )
  )`;
}

/**
 * Live owner/admin authority in both organizations. Every write that creates or
 * renews a cross-organization chat link checks it here; the read-side scope
 * above re-checks the same pair on the recorded author at routing time, so
 * revoking either membership retires the link without a cleanup job.
 */
export async function canLinkChatOrganizations(
  sql: DbClient,
  userId: string | null,
  agentOrganizationId: string,
  connectionOrganizationId: string,
): Promise<boolean> {
  if (!userId) return false;
  if (!isAdminOrOwnerRole(await getWorkspaceRole(sql, agentOrganizationId, userId))) {
    return false;
  }
  return isAdminOrOwnerRole(
    await getWorkspaceRole(sql, connectionOrganizationId, userId),
  );
}
