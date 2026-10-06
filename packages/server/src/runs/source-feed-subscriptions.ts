import { createHash } from 'node:crypto';
import { compileConnectionColumnVisibility } from '../authz/connection-visibility';
import { listEntityApprovalPolicies, resolveActingPrincipal } from '../authz/entity-policy';
import { evaluateConnectorPolicy } from '../authz/connector-policy';
import type { DbClient } from '../db/client';
import { feedDefinitionSelection } from '../connectors/feed-definition-selection';
import { DEVICE_FEED_READ_ACTION_KEY } from '../lib/device-feed-read-protocol';

/** The same source configuration key fences listener setup and incoming deliveries. */
export function sourceFeedScopeKey(config: unknown, version: string | null): string {
  return createHash('sha256').update(JSON.stringify([config ?? {}, version])).digest('hex');
}

export interface SourceFeedSubscription {
  automationId: number;
  principal: string | null;
  agentId: string | null;
}

/** Correlated selection for the enclosing feed f, connection c and definition d. */
export function sourceFeedSubscriptionSelection(sql: DbClient, automationId?: number) {
  // Resource-ref match predicates are evaluated per change by the normal activation path.
  return sql`
    SELECT a.id, a.created_by, a.managed_agent_id
    FROM automations a JOIN automation_versions v ON v.id = a.current_version_id
    WHERE a.organization_id = f.organization_id AND a.status = 'active'
      AND (a.managed_agent_id IS NOT NULL OR a.device_worker_id IS NOT NULL)
      ${automationId === undefined ? sql`` : sql`AND a.id = ${automationId}`}
      ${sql.unsafe(compileConnectionColumnVisibility('c', 'a.created_by'))}
      AND a.triggers @> jsonb_build_array(jsonb_build_object('kind', 'event', 'connector_key', c.connector_key))
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(a.triggers) trigger,
          jsonb_array_elements(COALESCE(d.automation_events, '[]'::jsonb)) event
        WHERE trigger->>'kind' = 'event' AND trigger->>'source' IS DISTINCT FROM 'workspace'
          AND trigger->>'connector_key' = c.connector_key
          AND (NOT trigger ? 'connection_id' OR trigger->'connection_id' = to_jsonb(c.id))
          AND trigger->'event_types' ? (event->>'key')
      )
  `;
}

/** Resolve subscriptions through the persisted owner and canonical connection visibility. */
export async function sourceFeedSubscriptions(sql: DbClient, organizationId: string, feedId: number, automationId?: number): Promise<SourceFeedSubscription[]> {
  const rows = await sql`
    SELECT subscription.*, c.id AS connection_id, c.connector_key
    FROM feeds f JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    JOIN LATERAL (${sourceFeedSubscriptionSelection(sql, automationId)}) subscription ON true
    WHERE f.id = ${feedId} AND f.organization_id = ${organizationId}
      AND f.status = 'active' AND f.deleted_at IS NULL
      AND c.status = 'active' AND c.deleted_at IS NULL
      AND d.feeds_schema->f.feed_key->'operations' ? 'read'
    ORDER BY subscription.id
  `;
  if (!rows.length) return [];
  const policies = await listEntityApprovalPolicies(organizationId, 'connector_action', sql);
  const subscriptions: SourceFeedSubscription[] = [];
  for (const row of rows) {
    const principal = typeof row.created_by === 'string' ? row.created_by : null;
    const subscriptionId = Number(row.id);
    const actor = await resolveActingPrincipal(sql, { organizationId, sessionAutomationId: subscriptionId });
    const policy = evaluateConnectorPolicy({ organizationId, connectionId: Number(row.connection_id), actor, policies,
      operation: { connector_key: row.connector_key, operation_key: DEVICE_FEED_READ_ACTION_KEY, kind: 'read' } });
    // Background subscriptions cannot grant themselves approval. A policy change
    // revokes the listener, delegated reads, and commit authority together.
    if (policy.effect !== 'auto') continue;
    subscriptions.push({ automationId: subscriptionId, principal, agentId: row.managed_agent_id ?? null });
  }
  return subscriptions;
}
