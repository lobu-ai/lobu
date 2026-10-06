import type { AutomationTrigger } from '@lobu/core/contracts/tools/manage-automations';
import type { ConnectorAutomationEvent, FeedDefinition } from '@lobu/connector-sdk';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import { resolveActingPrincipal } from '../authz/entity-policy';
import type { DbClient } from '../db/client';
import { feedDefinitionSelection } from '../connectors/feed-definition-selection';

export interface SourceFeedSubscription {
  automationId: number;
  principal: string | null;
  agentId: string | null;
}

/** Resolve subscriptions through the same persisted owner and connection visibility as reads. */
export async function sourceFeedSubscriptions(sql: DbClient, organizationId: string, feedId: number): Promise<SourceFeedSubscription[]> {
  const [feed] = await sql`
    SELECT c.id AS connection_id, c.connector_key, d.feeds_schema->f.feed_key AS definition,
           d.automation_events
    FROM feeds f JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    WHERE f.id = ${feedId} AND f.organization_id = ${organizationId}
      AND f.status = 'active' AND f.deleted_at IS NULL
      AND c.status = 'active' AND c.deleted_at IS NULL
  `;
  const definition = feed?.definition as FeedDefinition | undefined;
  if (!definition?.operations?.includes('observe')) return [];
  const eventKeys = new Set((feed.automation_events as ConnectorAutomationEvent[] | null ?? []).map(event => event.key));
  const rows = await sql`
    SELECT a.id, a.created_by, a.managed_agent_id, a.triggers
    FROM automations a JOIN automation_versions v ON v.id = a.current_version_id
    WHERE a.organization_id = ${organizationId} AND a.status = 'active'
      AND (a.managed_agent_id IS NOT NULL OR a.device_worker_id IS NOT NULL)
      AND a.triggers @> ${sql.json([{ kind: 'event', connector_key: feed.connector_key }])}::jsonb
    ORDER BY a.id
  `;
  const subscriptions: SourceFeedSubscription[] = [];
  for (const row of rows) {
    const triggers = row.triggers as AutomationTrigger[];
    if (!triggers.some(trigger => trigger.kind === 'event' && trigger.source !== 'workspace'
      && trigger.connector_key === feed.connector_key
      && (trigger.connection_id === undefined || trigger.connection_id === Number(feed.connection_id))
      && trigger.event_types.some(event => eventKeys.has(event)))) continue;
    const principal = typeof row.created_by === 'string' ? row.created_by : null;
    const scope = { organizationId, principal };
    const visible = await sql`SELECT c.id FROM connections c
      WHERE c.id = ${feed.connection_id} AND c.organization_id = ${organizationId}
      ${sql.unsafe(compileConnectionRowVisibility(scope, 'c'))}`;
    if (!visible.length) continue;
    const automationId = Number(row.id);
    const actor = await resolveActingPrincipal(sql, { organizationId, sessionAutomationId: automationId });
    if (!actor.ownerResolved) continue;
    subscriptions.push({ automationId, principal, agentId: row.managed_agent_id ?? null });
  }
  return subscriptions;
}
