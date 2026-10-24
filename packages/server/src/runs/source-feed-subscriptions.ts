import { createHash } from 'node:crypto';
import { referenceCaptureTriggers } from '../automations/event-trigger';
import type { AutomationTrigger } from '@lobu/core/contracts/tools/manage-automations';
import { compileConnectionColumnVisibility } from '../authz/connection-visibility';
import { listEntityApprovalPolicies, resolveActingPrincipal } from '../authz/entity-policy';
import { evaluateConnectorPolicy } from '../authz/connector-policy';
import type { DbClient } from '../db/client';
import { feedDefinitionSelection } from '../connectors/feed-definition-selection';
import { feedTriggerEligibilitySql } from '../connectors/feed-health-semantics';
import { DEVICE_FEED_READ_ACTION_KEY } from '../lib/device-feed-read-protocol';
import { resolveAutomationExecutor, type ResolvedExecutor } from '../tools/admin/manage_automations/executors';

/** The same source configuration key fences listener setup and incoming deliveries. */
export function sourceFeedScopeKey(config: unknown, version: string | null): string {
  return createHash('sha256').update(JSON.stringify([config ?? {}, version])).digest('hex');
}

export interface SourceFeedSubscription {
  automationId: number;
  principal: string | null;
  agentId: string | null;
  executorKind: ResolvedExecutor['kind'];
  triggers: AutomationTrigger[];
}

/** Resolve subscriptions through the persisted owner and canonical connection visibility. */
export async function sourceFeedSubscriptions(
  sql: DbClient,
  organizationId: string,
  feedId: number,
  automationId?: number,
): Promise<SourceFeedSubscription[]> {
  // Resource-ref match predicates are evaluated per change by the normal activation path.
  const rows = await sql`
    SELECT a.id, a.created_by, a.managed_agent_id, a.device_worker_id, a.agent_kind, a.execution_config,
      a.triggers, c.id AS connection_id, c.connector_key, f.feed_key, f.config AS source_config,
      COALESCE(f.pinned_version, d.version) AS scope_version,
      d.feeds_schema->f.feed_key->'webhook'->'events' AS feed_events
    FROM feeds f JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    JOIN automations a ON a.organization_id = f.organization_id
    JOIN automation_versions v ON v.id = a.current_version_id
    WHERE f.id = ${feedId} AND f.organization_id = ${organizationId}
      AND f.status = 'active' AND f.deleted_at IS NULL
      AND c.status = 'active' AND c.deleted_at IS NULL
      AND (${sql.unsafe(feedTriggerEligibilitySql('d', 'f', 'source-only'))})
      AND a.status = 'active'
      AND (a.managed_agent_id IS NOT NULL OR a.device_worker_id IS NOT NULL
        OR a.execution_config->'executor'->>'kind' = 'external')
      ${sql.unsafe(compileConnectionColumnVisibility('c', 'a.created_by'))}
      AND a.triggers @> jsonb_build_array(jsonb_build_object('kind', 'event', 'connector_key', c.connector_key))
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(a.triggers) trigger,
          -- CASE, not COALESCE: a scalar or object events value must not raise (see feedWebhookDrivenSql).
          jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.feeds_schema->f.feed_key->'webhook'->'events') = 'array'
            THEN d.feeds_schema->f.feed_key->'webhook'->'events' ELSE '[]'::jsonb END) event
        WHERE trigger->>'kind' = 'event' AND trigger->>'source' IS DISTINCT FROM 'workspace'
          AND trigger->>'connector_key' = c.connector_key
          AND (NOT trigger ? 'connection_id' OR trigger->'connection_id' = to_jsonb(c.id))
          AND trigger->'event_types' ? event
          AND (a.execution_config->'executor'->>'kind' IS DISTINCT FROM 'external'
            OR trigger->>'capture' = 'references')
      )
    ORDER BY a.id
  `;
  if (!rows.length) return [];
  const policies = await listEntityApprovalPolicies(organizationId, 'connector_action', sql);
  const subscriptions: SourceFeedSubscription[] = [];
  let hasCapture = false;
  for (const row of rows) {
    const executor = resolveAutomationExecutor({ agentId: row.managed_agent_id,
      deviceWorkerId: row.device_worker_id, agentKind: row.agent_kind, executionConfig: row.execution_config });
    if (!executor) continue;
    const principal = typeof row.created_by === 'string' ? row.created_by : null;
    const subscriptionId = Number(row.id);
    const actor = await resolveActingPrincipal(sql, {
      organizationId,
      sessionAutomationId: subscriptionId,
    });
    const policy = evaluateConnectorPolicy({
      organizationId,
      connectionId: Number(row.connection_id),
      actor,
      policies,
      operation: {
        connector_key: row.connector_key,
        operation_key: DEVICE_FEED_READ_ACTION_KEY,
        kind: 'read',
      },
    });
    // Background subscriptions cannot grant themselves approval. A policy change
    // revokes the listener, delegated reads, and commit authority together.
    if (policy.effect !== 'auto') continue;
    hasCapture ||= referenceCaptureTriggers(Array.isArray(row.triggers) ? row.triggers : []).some(trigger =>
      trigger.connector_key === row.connector_key
      && (trigger.connection_id === undefined || trigger.connection_id === Number(row.connection_id))
      && trigger.event_types.some(event => row.feed_events.includes(event)));
    subscriptions.push({
      automationId: subscriptionId,
      principal,
      agentId: row.managed_agent_id ?? null,
      executorKind: executor.kind,
      triggers: Array.isArray(row.triggers) ? row.triggers : [],
    });
  }
  // Canonical observer selection depends only on admitted capture for this
  // source, never unrelated/denied triggers or the requesting Automation.
  if (hasCapture) {
    const source = rows[0];
    const [earlier] = await sql`SELECT f.id FROM feeds f
      JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
      JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
      WHERE f.organization_id = ${organizationId} AND f.connection_id = ${source.connection_id}
        AND f.feed_key = ${source.feed_key} AND f.id < ${feedId}
        AND f.status = 'active' AND f.deleted_at IS NULL
        AND COALESCE(f.pinned_version, d.version) = ${source.scope_version}
        AND COALESCE(f.config, '{}'::jsonb) = ${sql.json(source.source_config ?? {})}::jsonb
        AND (${sql.unsafe(feedTriggerEligibilitySql('d', 'f', 'source-only'))}) LIMIT 1`;
    if (earlier) return [];
  }
  return automationId === undefined ? subscriptions : subscriptions.filter(subscription => subscription.automationId === automationId);
}
