import { getDb } from '../db/client';
import { automationArrivalSettleMs } from '../utils/window-utils';
import type { ToolContext } from '../tools/registry';
import { encodeExternalAutomationClaimOwner } from './external-claim-owner';

export type ExternalActivityCaller = Pick<ToolContext, 'userId' | 'agentId' | 'clientId'>;

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
  return sql<{
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
}
