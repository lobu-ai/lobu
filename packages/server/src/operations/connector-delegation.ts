import type { ConnectorOperationRequest, ConnectorOperationResult } from '@lobu/core/contracts/tools/manage-operations';
import { resolveStoredActingPrincipal } from '../authz/entity-policy';
import { resolveRunConnectorPolicy } from '../authz/operation-run-policy';
import { intervals } from '../config/intervals';
import { getDb, type DbClient } from '../db/client';
import type { Env } from '../index';
import type { handleExecute } from '../tools/admin/manage_operations/handlers/execute';
import type { ToolContext } from '../tools/registry';
import { ToolUserError } from '../utils/errors';

type Delegation = {
  parentRunId: number;
  claimedBy: string;
  organizationId?: string;
  request: ConnectorOperationRequest;
  abortSignal?: AbortSignal;
};

/** Both inline and fleet connectors spend the persisted parent's authority.
 * Only operation input is guest-controlled; the gateway owns identity/routing.
 * The public operation handler remains the single admission/approval engine. */
export async function executeConnectorOperation(params: Delegation, execute: typeof handleExecute): Promise<ConnectorOperationResult> {
  const sql = getDb();
  const loadParent = async (db: DbClient, lock: boolean) => {
    const [parent] = await db<{
      organization_id: string; created_by_user_id: string | null; automation_id: number | null;
      policy_principal_kind: string | null; policy_principal_id: string | null;
    }>`SELECT r.organization_id, r.created_by_user_id, r.automation_id,
          r.policy_principal_kind, r.policy_principal_id
       FROM runs r JOIN connections c ON c.id = r.connection_id AND c.organization_id = r.organization_id
       WHERE r.id = ${params.parentRunId} AND r.claimed_by = ${params.claimedBy}
         AND (${params.organizationId ?? null}::text IS NULL OR r.organization_id = ${params.organizationId ?? null})
         AND r.run_type = 'action' AND r.status = 'running'
         AND r.approval_status IN ('auto', 'approved')
         AND r.target_device_worker_id IS NULL
         AND COALESCE(r.last_heartbeat_at, r.claimed_at) >= current_timestamp - make_interval(secs => ${intervals.runsReaperStaleAfterSeconds})
         AND (r.expires_at IS NULL OR r.expires_at > current_timestamp)
         AND c.deleted_at IS NULL AND c.status = 'active'
       ${lock ? db`FOR SHARE OF r, c` : db``}`;
    if (!parent || params.abortSignal?.aborted) throw new ToolUserError('Connector parent is not an authorized live claim.', 409);
    const policy = await resolveRunConnectorPolicy({organizationId: parent.organization_id, runId: params.parentRunId, sql: db});
    if (!policy || policy.effect === 'deny') throw new ToolUserError('Current policy blocks the connector parent.', 403);
    return parent;
  };
  const parent = await loadParent(sql, false);
  const actor = await resolveStoredActingPrincipal(sql, parent.organization_id, parent.policy_principal_kind, parent.policy_principal_id);
  if (!actor.ownerResolved) throw new ToolUserError('Connector requester is no longer available.', 403);
  const ctx: ToolContext = {
    organizationId: parent.organization_id, userId: parent.created_by_user_id,
    agentId: actor.kind === 'agent' ? actor.id : actor.ownerAgentId,
    actingAutomationId: parent.automation_id, actingRunId: params.parentRunId,
    memberRole: null, isAuthenticated: true, tokenType: 'pat', scopedToOrg: true,
    allowCrossOrg: false, grantedOrganizationIds: [parent.organization_id], directSearchFederation: false,
    abortSignal: params.abortSignal,
  };
  const result = await execute({
    ...params.request, action: 'execute',
    idempotency_key: `connector:${params.parentRunId}:${params.request.idempotency_key}`,
  }, ctx, {} as Env, {actor, assertActive: async (tx) => { await loadParent(tx, true); }});
  if ('error' in result || ('action' in result && result.action === 'execute')) return result;
  throw new Error('Unexpected connector operation result');
}

