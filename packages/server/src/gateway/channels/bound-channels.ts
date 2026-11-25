/**
 * THE single source of truth for "which chat channels can this org / agent reach
 * through which connection" — including the hosted-preview cross-org case.
 *
 * Both the proactive-notification path (`resolveBotDeliveryTargets`) and the
 * native conversation tools (`resolveAddressableTargets`) resolve channels here,
 * so the cross-org preview invariant (the sharpest tenant-safety edge) lives in
 * ONE place and cannot drift between callers.
 *
 * Three branches:
 *   (A) the org's own connections, joined to their bindings on (org, agent,
 *       platform).
 *   (B) hosted-preview cross-org: a binding under THIS org served by the shared
 *       preview connection (which lives in a DIFFERENT org under a placeholder
 *       agent). A `/lobu link <code>` writes the binding under the linking org,
 *       so it never matches branch A's (org, agent) join. Gated HARD to the
 *       single previewMode connection per platform and, when that connection is
 *       workspace-scoped, to bindings from the same workspace. It is NOT joined
 *       on agent_id, so the hosted connection's placeholder agent does not hide
 *       tenant bindings. A NOT EXISTS skips channels the org/agent already owns
 *       via branch A (no double-resolve / double-post).
 *   (C) cross-org chat link: a channel this org linked with a `/link <code>`
 *       claim on another org's ordinary chat connection (credentialed or
 *       connector-transport). Authority is the canonical chat-link grant the
 *       inbound route honors (`chat-link-authorization.ts`): an active
 *       `system:chat-link` Automation whose author administers both orgs. It
 *       grants exactly the linked channel, so nothing else on the owning
 *       connection becomes reachable, and unlinking (archive, delete, or lost
 *       admin) retires it. The post itself still runs as the owning
 *       connection, under the owning org's connector policy. Same NOT EXISTS
 *       as branch B.
 *
 * `agentId` (optional) scopes BOTH branches to one agent — set for the
 * conversation tools (an agent may only address ITS OWN bindings), omitted for
 * org-wide notification delivery. `connectionId` (optional) narrows by runtime
 * id (used by targeted notify); `connectionDbId` narrows by the exact stored row
 * id for contracts that persist that identity.
 *
 * The preview connection's first-class tenant id is useful routing scope, not a
 * reason to disable hosted delivery. A legacy tenantless preview connection may
 * serve all of its bindings; a workspace-scoped one serves only matching team
 * bindings because channel ids are workspace-scoped, not global.
 */
import type { DbClient } from "../../db/client.js";
import {
  runtimeConnectionIdToSlug,
  runtimeConnectionPredicate,
} from "../../lobu/stores/connections-projection.js";
import { linkedChatChannels } from "./chat-link-authorization.js";

interface BoundChannelRow {
  /** Connection id that owns the post (preview conn for cross-org). */
  id: string;
  platform: string;
  /** As stored on the binding — may be platform-prefixed (`slack:C…`) or bare. */
  channel_id: string;
  team_id: string | null;
  created_at: Date;
  /** Stored `connections.id` of the posting connection. */
  connection_db_id: number | string;
  /** Served by another org's connection (branch B or C). */
  cross_org: boolean;
}

export async function resolveBoundChannelRows(
  sql: DbClient,
  opts: {
    organizationId: string;
    agentId?: string | null;
    connectionId?: string | null;
    connectionDbId?: number | null;
  }
): Promise<BoundChannelRow[]> {
  const { organizationId, agentId, connectionId, connectionDbId } = opts;
  const slugFilter = connectionId ? runtimeConnectionIdToSlug(connectionId) : null;
  // Agent scope is BINDING ownership (`b.agent_id`), NOT the connection's
  // agent_id — a managed Slack install has agent_id NULL but its bindings still
  // belong to the agent that linked them, so filtering on the connection would
  // hide managed-install channels from agent-scoped list/search/audience paths.
  const agentFilterA = agentId ? sql`AND b.agent_id = ${agentId}` : sql``;
  const agentFilterB = agentId ? sql`AND b.agent_id = ${agentId}` : sql``;
  const ownAgentFilter = agentId ? sql`AND ob.agent_id = ${agentId}` : sql``;
  const connFilterA = slugFilter
    ? sql`AND b.connection_slug = ${slugFilter}`
    : sql``;
  const connFilterB = slugFilter
    ? sql`AND b.connection_slug = ${slugFilter}`
    : sql``;
  const connDbFilterA = connectionDbId != null
    ? sql`AND b.connection_id = ${connectionDbId}`
    : sql``;
  const connDbFilterB = connectionDbId != null
    ? sql`AND b.connection_id = ${connectionDbId}`
    : sql``;
  // A connector-transport connection's runtime id is its numeric row id, not
  // a slug, so branch C matches through the canonical runtime-id predicate.
  const connFilterC = connectionId
    ? sql`AND ${runtimeConnectionPredicate(sql, connectionId, {
        id: sql`b.connection_id`, slug: sql`b.connection_slug`, credentialMode: sql`b.credential_mode`,
      })}`
    : sql``;
  const ownChannel = sql`
    SELECT 1
    FROM automation_message_subscriptions ob
    WHERE ob.connection_organization_id = ${organizationId}
      AND ob.organization_id = ${organizationId}
      AND ob.connection_status = 'active'
      AND ob.credential_mode IS NOT NULL
      ${ownAgentFilter}
      AND ob.platform = b.platform
      AND ob.channel_id = b.channel_id
  `;
  const { channels: linkedChats } = await linkedChatChannels(sql, organizationId);

  // `connections` keys chat rows by `slug` (`agentconn-<id>` for BYO,
  // `slackinst-<id>` verbatim for managed). Callers expect the runtime
  // connection id, so strip the BYO namespace back off in SQL (mirror of
  // `slugToRuntimeConnectionId`). Folded columns: platform → `connector_key`,
  // settings/metadata → `config.{settings,chatMetadata}`, teamId →
  // `external_tenant_id`. Chat rows carry `credential_mode IS NOT NULL`.
  return (await sql`
    SELECT id, platform, channel_id, team_id, created_at, connection_db_id, cross_org FROM (
      SELECT DISTINCT ON (id, platform, channel_id)
        id, platform, channel_id, team_id, created_at, connection_db_id, cross_org
      FROM (
        -- (A) the org's own connections. connection_id is the sole routing key.
        SELECT
          b.runtime_connection_id AS id,
          b.platform, b.channel_id, b.team_id, b.created_at,
          b.connection_id AS connection_db_id, false AS cross_org
        FROM automation_message_subscriptions b
        WHERE b.connection_organization_id = ${organizationId}
          AND b.organization_id = ${organizationId}
          AND b.connection_status = 'active'
          AND b.credential_mode IS NOT NULL
          ${agentFilterA}
          ${connFilterA}
          ${connDbFilterA}

        UNION ALL

        -- (B) hosted-preview cross-org: this org's (agent's) bindings via the
        -- shared preview connection. NO agent_id join on the preview conn; gated
        -- to the single previewMode connection per platform and, when scoped,
        -- the same workspace as the binding.
        SELECT
          b.runtime_connection_id AS id,
          b.platform, b.channel_id, b.team_id, b.created_at,
          b.connection_id AS connection_db_id,
          b.connection_organization_id IS DISTINCT FROM ${organizationId} AS cross_org
        FROM automation_message_subscriptions b
        WHERE b.organization_id = ${organizationId}
          AND b.connection_status = 'active'
          AND b.credential_mode IS NOT NULL
          AND b.preview_mode
          AND (
            b.connection_team_id IS NULL
            OR b.team_id = b.connection_team_id
          )
          ${agentFilterB}
          ${connFilterB}
          ${connDbFilterB}
          -- Skip channels the org/agent already owns via branch A.
          AND NOT EXISTS (${ownChannel})

        UNION ALL

        -- (C) cross-org chat link: only the channel each authorized link
        -- names, posted by the owning connection. A connector-transport
        -- connection (credential_mode NULL) is addressed by its row id.
        SELECT
          CASE WHEN b.credential_mode IS NULL
            THEN b.connection_id::text ELSE b.runtime_connection_id END AS id,
          b.platform, b.channel_id, b.team_id, b.created_at,
          b.connection_id AS connection_db_id, true AS cross_org
        FROM automation_message_subscriptions b
        WHERE b.organization_id = ${organizationId}
          AND b.connection_organization_id <> ${organizationId}
          AND (b.automation_id, b.connection_id, b.channel_id) IN (${linkedChats})
          ${agentFilterB}
          ${connFilterC}
          ${connDbFilterB}
          AND NOT EXISTS (${ownChannel})
      ) candidates
      ORDER BY id, platform, channel_id, created_at ASC
    ) targets
    -- Binding-creation order: the primary channel (earliest binding) first.
    ORDER BY created_at ASC
  `) as BoundChannelRow[];
}

/** Bindings store a platform-prefixed id (`slack:C…`); strip to the native id. */
export function stripPlatformPrefix(platform: string, channelId: string): string {
  const prefix = `${platform}:`;
  return channelId.startsWith(prefix)
    ? channelId.slice(prefix.length)
    : channelId;
}
