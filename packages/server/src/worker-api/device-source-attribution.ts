import type { SourceAttribution } from '@lobu/core/contracts/worker/protocol';
import type { DbClient } from '../db/client';
import type { ToolContext } from '../tools/registry';

/** Only authenticated context supplies identity; tool arguments are deliberately absent. */
export function requestSourceAttribution(
  ctx: Pick<ToolContext, 'isAuthenticated' | 'agentId' | 'clientId' | 'tokenType'>,
): Pick<SourceAttribution, 'agent_id' | 'client_id'> {
  if (!ctx.isAuthenticated) return {};
  return {
    ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
    ...(ctx.tokenType === 'oauth' && ctx.clientId ? { client_id: ctx.clientId } : {}),
  };
}

/**
 * Project one claimed run through the activity feed's source-identity fields. All joins
 * are indexed identities, scoped to the run's organization. The execution device
 * comes from the authenticated poller, never the requester or action arguments.
 */
export async function deviceSourceAttributionForRun(
  sql: DbClient,
  runId: number,
  organizationId: string,
  deviceWorkerId: string,
): Promise<SourceAttribution | undefined> {
  const rows = await sql<SourceAttribution>`
    SELECT r.connector_key AS platform,
           c.id AS connection_id, c.display_name AS connection_name,
           f.id AS feed_id, f.feed_key, f.display_name AS feed_name,
           a.id AS automation_id, COALESCE(av.name, a.name) AS automation_name,
           agent.id AS agent_id, agent.name AS agent_name,
           client.id AS client_id, client.client_name,
           device.id::text AS device_worker_id,
           device.label AS device_label, device.platform AS device_platform
    FROM runs r
    LEFT JOIN connections c ON c.id = r.connection_id AND c.organization_id = r.organization_id
    LEFT JOIN feeds f ON f.id = r.feed_id AND f.organization_id = r.organization_id
    LEFT JOIN automations a ON a.id = r.automation_id AND a.organization_id = r.organization_id
    LEFT JOIN automation_versions av ON av.id = a.current_version_id
    LEFT JOIN agents agent
      ON agent.id = COALESCE(
        r.run_metadata->'source_attribution'->>'agent_id',
        CASE WHEN r.policy_principal_kind = 'agent' THEN r.policy_principal_id END,
        a.managed_agent_id
      ) AND agent.organization_id = r.organization_id
    LEFT JOIN oauth_clients client
      ON client.id = r.run_metadata->'source_attribution'->>'client_id'
    LEFT JOIN device_workers device
      ON device.id = r.executed_by_device_worker_id AND device.id = ${deviceWorkerId}::uuid
    WHERE r.id = ${runId} AND r.organization_id = ${organizationId}
    LIMIT 1
  `;
  return rows[0];
}
