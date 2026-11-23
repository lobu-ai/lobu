import type { AutomationDeliveryTarget } from '@lobu/core/contracts/tools/manage-automations';
import type { DbClient } from '../db/client';
import {
  resolveBoundChannelRows,
  stripPlatformPrefix,
} from '../gateway/channels/bound-channels';
import { ToolUserError } from '../utils/errors';

interface ResolvedAutomationDeliveryTarget {
  connectionId: string;
  channelId: string;
  teamId: string | null;
}

interface ConfiguredAutomationDeliveryTarget {
  configured: boolean;
  target: ResolvedAutomationDeliveryTarget | null;
}

/** The executor assignment that decides which bindings an Automation may address. */
interface AutomationDeliveryOwner {
  agentId: string | null;
  deviceWorkerId: string | null;
}

/**
 * Resolve a public Automation delivery target through the canonical bound-channel
 * resolver. A numeric connection id alone is never authority: the target must
 * be an active channel binding owned by the same organization as the
 * Automation. An agent-owned Automation may address only its agent's bindings.
 * An Automation with no managed agent and no device worker is processed by an
 * external client that has no bindings of its own, so it may address any active
 * binding in its organization. A device-pinned Automation without an agent has
 * no delivery target. Hosted-preview bindings retain the same workspace guard
 * as normal inbound/proactive routing.
 */
async function resolveAutomationDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  owner: AutomationDeliveryOwner,
  target: AutomationDeliveryTarget
): Promise<ResolvedAutomationDeliveryTarget | null> {
  if (!owner.agentId && owner.deviceWorkerId) return null;

  const rows = await resolveBoundChannelRows(sql, {
    organizationId,
    agentId: owner.agentId,
    connectionDbId: target.connection_id,
  });
  const row = rows.find((candidate) => {
    const candidateNativeId = stripPlatformPrefix(
      candidate.platform,
      candidate.channel_id
    );
    const targetNativeId = stripPlatformPrefix(
      candidate.platform,
      target.channel_id
    );
    return candidateNativeId === targetNativeId;
  });
  if (!row) return null;
  return {
    connectionId: row.id,
    channelId: `${row.platform}:${stripPlatformPrefix(
      row.platform,
      row.channel_id
    )}`,
    teamId: row.team_id,
  };
}

export async function assertAutomationDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  owner: AutomationDeliveryOwner,
  target: AutomationDeliveryTarget
): Promise<AutomationDeliveryTarget> {
  const resolved = await resolveAutomationDeliveryTarget(
    sql,
    organizationId,
    owner,
    target
  );
  if (!resolved) {
    throw new ToolUserError(
      'Automation delivery target must be an active chat channel bound in this workspace, and bound to the same agent when the Automation has one. Link the private channel first, then select it as the delivery channel.',
      422
    );
  }
  return {
    connection_id: target.connection_id,
    channel_id: resolved.channelId,
  };
}

/**
 * Read the server-owned route for a notification emitted by an Automation.
 * `configured: true, target: null` means the stored target became unavailable;
 * callers must fail closed rather than fall back to another bound channel.
 */
export async function loadConfiguredAutomationDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  automationId: number
): Promise<ConfiguredAutomationDeliveryTarget> {
  const rows = await sql<{
    managed_agent_id: string | null;
    device_worker_id: string | null;
    delivery_target: AutomationDeliveryTarget | null;
  }>`
    SELECT managed_agent_id, device_worker_id, delivery_target
    FROM automations
    WHERE id = ${automationId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.delivery_target) return { configured: false, target: null };
  return {
    configured: true,
    target: await resolveAutomationDeliveryTarget(
      sql,
      organizationId,
      { agentId: row.managed_agent_id, deviceWorkerId: row.device_worker_id },
      row.delivery_target
    ),
  };
}
