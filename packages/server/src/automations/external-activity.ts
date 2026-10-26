import { getDb } from '../db/client';
import logger from '../utils/logger';
import { automationArrivalSettleMs } from '../utils/window-utils';
import type { ToolContext } from '../tools/registry';
import { encodeExternalAutomationClaimOwner } from './external-claim-owner';

export type ExternalActivityCaller = Pick<ToolContext, 'userId' | 'agentId' | 'clientId'>;

/** Subscription discovery, not a per-client unread count or processing acknowledgment. */
export async function listExternalSourceSubscriptions(params: {
  organizationId: string; caller: ExternalActivityCaller; agentId?: string; limit: number;
}) {
  if (!params.caller.userId && !params.caller.agentId && !params.caller.clientId) return [];
  const sql = getDb();
  return sql<{ id: number; name: string; updated_at: string | Date }>`
    SELECT a.id, a.name, a.updated_at FROM automations a
    WHERE a.organization_id = ${params.organizationId} AND a.status = 'active'
      AND a.execution_config->'executor'->>'kind' = 'external'
      ${params.agentId ? sql`AND a.managed_agent_id = ${params.agentId}` : sql``}
      ${params.caller.agentId ? sql`AND (a.managed_agent_id IS NULL OR a.managed_agent_id = ${params.caller.agentId})` : sql``}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.triggers) trigger
        WHERE trigger->>'kind' = 'event' AND trigger->>'source' IS DISTINCT FROM 'workspace'
          AND trigger->>'capture' = 'references')
    ORDER BY a.id LIMIT ${params.limit}`;
}

/** Read current config + active runs only. Discovery never creates a run or renews a lease. */
export async function listExternalAutomationWork(params: {
  organizationId: string;
  caller: ExternalActivityCaller;
  agentId?: string;
  limit: number;
}) {
  const { caller, organizationId, limit } = params;
  if (!caller.userId && !caller.agentId && !caller.clientId) return [];
  const owner = encodeExternalAutomationClaimOwner(caller);
  const sql = getDb();
  const agentFilter = params.agentId ? sql`AND a.managed_agent_id = ${params.agentId}` : sql``;
  const identityFilter = caller.agentId
    ? sql`AND (active.claimed_by = ${owner}
        OR (active.id IS NOT NULL AND (active.agent_id IS NULL OR active.agent_id = ${caller.agentId}))
        OR (active.id IS NULL AND (a.managed_agent_id IS NULL OR a.managed_agent_id = ${caller.agentId})))` : sql``;
  const work = await sql<{
    id: number; name: string; next_run_at: string | Date | null;
    run_id: number | null; run_status: string | null;
    claimed_by: string | null; created_at: string | Date | null;
  }>`
    SELECT a.id, a.name, a.next_run_at,
           active.id AS run_id, active.status AS run_status,
           active.claimed_by, active.created_at
    FROM automations a
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.claimed_by, r.created_at, r.expires_at,
             r.approved_input->'executor'->>'kind' AS executor_kind,
             r.approved_input->>'agent_id' AS agent_id
      FROM runs r
      WHERE r.automation_id = a.id AND r.run_type = 'automation'
        AND r.status IN ('pending', 'claimed', 'running')
        AND (r.expires_at IS NULL OR r.expires_at > CURRENT_TIMESTAMP)
      ORDER BY CASE WHEN r.status IN ('claimed', 'running') THEN 0 ELSE 1 END, r.id
      LIMIT 1
    ) active ON true
    WHERE a.organization_id = ${organizationId} AND a.status = 'active'
      ${agentFilter} ${identityFilter}
      AND (
        (active.executor_kind = 'external' AND active.status IN ('claimed', 'running') AND active.claimed_by = ${owner})
        OR (active.executor_kind = 'external' AND active.status = 'pending')
        OR (active.id IS NULL AND a.execution_config->'executor'->>'kind' = 'external'
          AND a.next_window_start < CURRENT_TIMESTAMP - (${automationArrivalSettleMs()} * INTERVAL '1 millisecond')
          AND a.schedule IS NOT NULL
          AND a.schedule_auto_paused_at IS NULL AND a.next_run_at <= CURRENT_TIMESTAMP)
      )
    ORDER BY CASE WHEN active.claimed_by = ${owner} THEN 0 ELSE 1 END,
             a.next_run_at ASC NULLS LAST, a.id
    LIMIT ${limit}
  `;
  // Temporary branch-3 diagnostics: org-wide, with raw timestamp precision preserved.
  const settleMs = automationArrivalSettleMs();
  const diagnostics = await sql`
    SELECT a.id, active.id IS NOT NULL AS has_active_run,
           active.id IS NULL AS no_active_run,
           a.execution_config->'executor'->>'kind' AS executor_kind,
           a.execution_config->'executor'->>'kind' = 'external' AS executor_is_external,
           a.schedule IS NULL AS schedule_is_null,
           a.schedule IS NOT NULL AS has_schedule,
           a.schedule_auto_paused_at IS NULL AS schedule_auto_paused_at_is_null,
           a.next_run_at::text AS next_run_at,
           a.next_window_start::text AS next_window_start,
           CURRENT_TIMESTAMP::text AS diagnostic_now,
           (a.next_window_start < CURRENT_TIMESTAMP - (${settleMs} * INTERVAL '1 millisecond')) IS TRUE AS window_settled,
           (a.next_run_at <= CURRENT_TIMESTAMP) IS TRUE AS run_due
    FROM automations a
    LEFT JOIN LATERAL (
      SELECT r.id FROM runs r
      WHERE r.automation_id = a.id AND r.run_type = 'automation'
        AND r.status IN ('pending', 'claimed', 'running')
        AND (r.expires_at IS NULL OR r.expires_at > CURRENT_TIMESTAMP)
      LIMIT 1
    ) active ON true
    WHERE a.organization_id = ${organizationId} AND a.status = 'active'
      AND a.execution_config->'executor'->>'kind' = 'external'
    ORDER BY a.id
  `.catch(() => null); // Diagnostics must not prevent returning the original work.
  logger.info({
    organizationId,
    hasUserId: Boolean(caller.userId),
    hasAgentId: Boolean(caller.agentId),
    hasClientId: Boolean(caller.clientId),
    workRowCount: work.length,
    settleMs,
    diagnosticsFailed: diagnostics === null,
    diagnostics,
  }, '[external-activity] Branch-3 due-work diagnostics');
  return work;
}
