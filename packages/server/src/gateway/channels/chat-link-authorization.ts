import { type DbClient, type DbQuery, pgTextArray } from "../../db/client";
import { runtimeConnectionPredicate } from "../../lobu/stores/connections-projection";
import { isAdminOrOwnerRole } from "../../tools/access-control";
import { getWorkspaceRole } from "../../utils/organization-access";

/**
 * Connector-transport platforms (a chat whose transport is a connector
 * connection). Platform setup imports channel authorization and bound-channel
 * resolution, so load the registry only at query time: a platform-first import
 * must not re-enter its own descriptor (`registry-import-order.test.ts`).
 */
async function connectorTransportPlatforms(): Promise<string[]> {
  return (await import("../connections/platforms/index.js")).connectorTransportPlatforms();
}

/**
 * The cross-organization chat-link grant: an active `system:chat-link`
 * Automation bound to an active chat connection in another organization. A tag
 * or a foreign connection id alone is never a grant: the recorded author must
 * still administer both workspaces. The grant is per subscription row:
 * `scope` narrows the rows and `columns` picks what each caller matches.
 *
 * Resolves to a wrapped subquery: a bare query fragment is a thenable, so an
 * async function returning one would run it instead of handing it back.
 */
async function chatLinkSubscriptions(
  sql: DbClient,
  columns: DbQuery,
  scope: DbQuery,
): Promise<{ subquery: DbQuery }> {
  const platforms = await connectorTransportPlatforms();
  // These role predicates mirror isAdminOrOwnerRole. The query owns its SQL
  // aliases; callers only match the returned columns, then their specific trigger.
  const subquery = sql`
    SELECT ${columns}
    FROM automation_message_subscriptions s
    JOIN automations w ON w.id = s.automation_id
    JOIN agents a ON a.id = w.managed_agent_id AND a.organization_id = w.organization_id
    JOIN member agent_admin ON agent_admin."userId" = w.created_by
      AND agent_admin."organizationId" = w.organization_id
      AND agent_admin.role IN ('owner', 'admin')
    JOIN member installation_admin ON installation_admin."userId" = w.created_by
      AND installation_admin."organizationId" = s.connection_organization_id
      AND installation_admin.role IN ('owner', 'admin')
    WHERE ${scope}
      AND s.connection_status = 'active'
      AND (s.credential_mode IS NOT NULL OR s.platform = ANY(${pgTextArray(platforms)}::text[]))
      AND w.tags @> ARRAY['system:chat-link']::text[]
  `;
  return { subquery };
}

/**
 * Automation IDs authorized to handle one concrete incoming chat from outside
 * the installation's organization. A provider's optional team identity must
 * match the one captured when the channel was linked, including absence.
 */
export async function authorizedChatLinkIds(
  sql: DbClient,
  chat: {
    connectionOrganizationId: string;
    connection: { id: number } | { slug: string } | { runtimeId: string };
    channelId: string;
    teamId?: string | null;
  },
) {
  const connectionFilter = "runtimeId" in chat.connection
    ? runtimeConnectionPredicate(sql, chat.connection.runtimeId, {
        id: sql`s.connection_id`, slug: sql`s.connection_slug`, credentialMode: sql`s.credential_mode`,
      })
    : "id" in chat.connection
      ? sql`s.connection_id = ${chat.connection.id}`
      : sql`s.connection_slug = ${chat.connection.slug}`;
  const { subquery } = await chatLinkSubscriptions(sql, sql`s.automation_id`, sql`${connectionFilter}
    AND s.connection_organization_id = ${chat.connectionOrganizationId}
    AND s.native_channel_id = ${chat.channelId}
    AND s.trigger_team_id IS NOT DISTINCT FROM ${chat.teamId || null}`);
  return { automationIds: subquery };
}

/**
 * The `(automation_id, connection_id, channel_id)` subscription rows through
 * which `organizationId` linked a chat channel on another organization's
 * connection: the same grant the inbound route honors, read from the linking
 * side. Each row grants exactly its own channel on its own connection.
 */
export async function linkedChatChannels(sql: DbClient, organizationId: string) {
  const { subquery } = await chatLinkSubscriptions(
    sql,
    sql`s.automation_id, s.connection_id, s.channel_id`,
    sql`s.organization_id = ${organizationId}
      AND s.connection_organization_id <> ${organizationId}`,
  );
  return { channels: subquery };
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
