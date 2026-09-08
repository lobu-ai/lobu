import type { DbClient } from "../../db/client";
import { isAdminOrOwnerRole } from "../../tools/access-control";
import { getWorkspaceRole } from "../../utils/organization-access";

/**
 * Automation IDs authorized to handle one concrete incoming chat from outside
 * the installation's organization. A tag or a foreign connection id alone is
 * never a grant: the recorded author must still administer both workspaces.
 * A provider's optional team identity must match the one captured when the
 * channel was linked, including absence.
 */
export function authorizedChatLinkIds(
  sql: DbClient,
  chat: {
    connectionOrganizationId: string;
    connection: { id: number } | { slug: string };
    channelId: string;
    teamId?: string | null;
  },
) {
  const connectionFilter = "id" in chat.connection
    ? sql`s.connection_id = ${chat.connection.id}`
    : sql`s.connection_slug = ${chat.connection.slug}`;
  // These role predicates mirror isAdminOrOwnerRole. The query owns its SQL
  // aliases; callers only match the returned IDs, then their specific trigger.
  return sql`
    SELECT s.automation_id
    FROM automation_message_subscriptions s
    JOIN automations w ON w.id = s.automation_id
    JOIN agents a ON a.id = w.managed_agent_id AND a.organization_id = w.organization_id
    JOIN member agent_admin ON agent_admin."userId" = w.created_by
      AND agent_admin."organizationId" = w.organization_id
      AND agent_admin.role IN ('owner', 'admin')
    JOIN member installation_admin ON installation_admin."userId" = w.created_by
      AND installation_admin."organizationId" = ${chat.connectionOrganizationId}
      AND installation_admin.role IN ('owner', 'admin')
    WHERE ${connectionFilter}
      AND s.connection_organization_id = ${chat.connectionOrganizationId}
      AND s.native_channel_id = ${chat.channelId}
      AND s.trigger_team_id IS NOT DISTINCT FROM ${chat.teamId || null}
      AND s.connection_status = 'active'
      AND s.credential_mode IS NOT NULL
      AND w.tags @> ARRAY['system:chat-link']::text[]
  `;
}

/**
 * Live owner/admin authority in both organizations. Every write that creates or
 * renews a cross-organization chat link checks it here; the routing query
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
