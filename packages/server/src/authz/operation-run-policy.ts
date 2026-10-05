import { type DbClient, getDb } from '../db/client';
import { DEVICE_FEED_READ_ACTION_KEY, isSourceFeedRead } from '../lib/device-feed-read-protocol';
import { getOperationForConnection } from '../operations/connector-operations';
import { supersedeActionEvent } from '../tools/admin/approval-events';
import { connectorApprovalMetadata } from '../operations/operation-run-card';
import { type ActionApprovalNotificationContext, notifyActionApprovalNeeded } from '../notifications/triggers';
import { insertEvent } from '../utils/insert-event';
import type { ConnectorPolicyResult } from './connector-policy';
import { resolveActingPrincipal, resolveConnectorPolicy, resolveStoredActingPrincipal } from './entity-policy';
import { compileConnectionRowVisibility } from './connection-visibility';

/** Only the server's connector-to-browser bridge writes this marker. */
export const CONNECTOR_PARENT_RUN_METADATA_KEY = 'connector_parent_run_id';

type PolicyRun = {
  id: number;
  run_type: string;
  status: string;
  approval_status: string;
  claimed_by: string | null;
  connection_id: number | null;
  feed_id: number | null;
  expires_at: Date | null;
  connector_key: string | null;
  action_key: string | null;
  action_input: Record<string, unknown> | null;
  policy_principal_kind: string | null;
  policy_principal_id: string | null;
  created_by_user_id: string | null;
  automation_id: number | null;
  parent_run_id: number | null;
  run_metadata: Record<string, unknown> | null;
};

const unavailable = (): ConnectorPolicyResult => ({
  effect: 'deny', ruleIds: [], reason: 'unavailable_operation',
});

async function loadPolicyRun(sql: DbClient, organizationId: string, runId: number, lock = false): Promise<PolicyRun | null> {
  const [run] = await sql<PolicyRun>`
    SELECT id, run_type, status, approval_status, claimed_by, connection_id, connector_key,
           action_key, action_input, policy_principal_kind, policy_principal_id,
           created_by_user_id, automation_id, parent_run_id, run_metadata, feed_id, expires_at
    FROM runs WHERE id = ${runId} AND organization_id = ${organizationId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return run ?? null;
}

async function resolvePublicRunPolicy(sql: DbClient, organizationId: string, run: PolicyRun): Promise<ConnectorPolicyResult> {
  if (run.run_type !== 'action' || run.connection_id == null || !run.action_key) return unavailable();
  const resolved = await getOperationForConnection(organizationId, Number(run.connection_id), run.action_key, sql);
  if (!resolved || resolved.connection.status !== 'active' || resolved.connection.connector_key !== run.connector_key) {
    return unavailable();
  }
  const actor = await resolveStoredActingPrincipal(sql, organizationId, run.policy_principal_kind, run.policy_principal_id);
  return resolveConnectorPolicy({ organizationId, connectionId: Number(run.connection_id), operation: resolved.operation, actor, sql });
}

/** Resolve execution authority from persisted provenance, never from the worker's input. */
export async function resolveRunConnectorPolicy(params: {
  organizationId: string;
  runId: number;
  sql?: DbClient;
}): Promise<ConnectorPolicyResult | null> {
  const sql = params.sql ?? getDb();
  const run = await loadPolicyRun(sql, params.organizationId, params.runId);
  if (!run) return unavailable();
  if (run.action_key === DEVICE_FEED_READ_ACTION_KEY && isSourceFeedRead(run.run_metadata)) {
    if (run.run_type !== 'action' || run.parent_run_id !== null || run.status !== 'running'
      || !['auto', 'approved'].includes(run.approval_status)
      || !run.expires_at || new Date(run.expires_at).getTime() <= Date.now()) return unavailable();
    const actor = await resolveStoredActingPrincipal(sql, params.organizationId, run.policy_principal_kind, run.policy_principal_id);
    if (!actor.ownerResolved) return unavailable();
    const visibility = compileConnectionRowVisibility({ organizationId: params.organizationId, principal: run.created_by_user_id }, 'c');
    const feeds = await sql.unsafe(`
      SELECT f.id FROM feeds f JOIN connections c ON c.id = f.connection_id
      WHERE f.id = $1 AND f.organization_id = $2 AND f.connection_id = $3
        AND f.status = 'active' AND f.deleted_at IS NULL
        AND c.connector_key = $4 AND c.status = 'active' AND c.deleted_at IS NULL
        ${visibility}
        AND (SELECT cd.feeds_schema->f.feed_key->'operations' ? 'read' FROM connector_definitions cd
          WHERE cd.key = c.connector_key AND cd.organization_id = f.organization_id
            AND ((f.pinned_version IS NULL AND cd.status = 'active')
              OR (f.pinned_version IS NOT NULL AND (cd.version = f.pinned_version OR cd.status = 'active')))
          ORDER BY (cd.version = f.pinned_version) DESC, (cd.status = 'active') DESC,
            cd.updated_at DESC, cd.id DESC LIMIT 1)
    `, [run.feed_id, params.organizationId, run.connection_id, run.connector_key]);
    return feeds.length ? { effect: 'auto', ruleIds: [], reason: 'parent_approval' } : unavailable();
  }
  // This reserved action is the transport for an already-authorized source feed
  // read. It is deliberately absent from the public connector action catalog.
  if (run.run_type === 'action' && run.action_key === DEVICE_FEED_READ_ACTION_KEY
    && run.policy_principal_kind === null && run.parent_run_id === null) return null;

  const parentMarker = run.run_metadata?.[CONNECTOR_PARENT_RUN_METADATA_KEY];
  if (parentMarker === undefined) return resolvePublicRunPolicy(sql, params.organizationId, run);
  if (!Number.isSafeInteger(parentMarker) || Number(parentMarker) !== Number(run.parent_run_id)
    || Number(parentMarker) >= Number(run.id) || Number(parentMarker) < 1) return unavailable();
  const parent = await loadPolicyRun(sql, params.organizationId, Number(parentMarker));
  if (!parent || parent.status !== 'running' || !['auto', 'approved'].includes(parent.approval_status)) return unavailable();

  // Sync has collection authority rather than a fabricated public operation.
  // Public action parents retain the exact requester who originally admitted them.
  const actor = parent.run_type === 'sync'
    ? await resolveActingPrincipal(sql, {
        organizationId: params.organizationId,
        userId: parent.created_by_user_id,
        sessionAutomationId: parent.automation_id,
      })
    : await resolveStoredActingPrincipal(sql, params.organizationId, parent.policy_principal_kind, parent.policy_principal_id);
  if (!actor.ownerResolved || run.policy_principal_kind !== actor.kind || run.policy_principal_id !== actor.id) return unavailable();
  if (parent.run_type === 'action') {
    const parentPolicy = await resolveRunConnectorPolicy({ ...params, runId: Number(parent.id), sql });
    if (!parentPolicy || parentPolicy.effect === 'deny') return parentPolicy ?? unavailable();
  } else if (parent.run_type !== 'sync') return unavailable();

  const childPolicy = await resolvePublicRunPolicy(sql, params.organizationId, run);
  if (childPolicy.effect === 'deny') return childPolicy;
  // The running parent already received authority for its implementation steps.
  // A new Ask does not interrupt each scroll; an explicit child Block still vetoes.
  return { effect: 'auto', ruleIds: childPolicy.ruleIds, reason: 'parent_approval' };
}

/** Run inside the caller's claim transaction, before any external execution. */
export async function applyRunConnectorPolicyAtClaim(params: {
  organizationId: string;
  runId: number;
  sql: DbClient;
  /** Inline runs were claimed on creation; only that same owner may park them. */
  claimedBy?: string;
}): Promise<boolean> {
  const { sql, organizationId, runId } = params;
  const run = await loadPolicyRun(sql, organizationId, runId, true);
  if (!run || (run.status !== 'pending' &&
    !(run.status === 'running' && params.claimedBy !== undefined && run.claimed_by === params.claimedBy))) return false;
  if (!['auto', 'approved'].includes(run.approval_status)) return false;
  const policy = await resolveRunConnectorPolicy(params);
  if (policy === null || policy.effect === 'auto') return true;
  if (policy.effect === 'approval' && run.approval_status === 'approved') return true;

  const blocked = policy.effect === 'deny';
  const message = blocked
    ? 'Current policy blocks this operation.'
    : 'Current policy requires human approval before this operation can run.';
  const [changed] = await sql`
    UPDATE runs SET approval_status = ${blocked ? 'rejected' : 'pending'},
      status = ${blocked ? 'cancelled' : 'pending'}, error_message = ${blocked ? message : null},
      completed_at = ${blocked ? sql`current_timestamp` : null},
      expires_at = CASE WHEN activation_kind IS NOT NULL OR ${blocked} THEN expires_at ELSE NULL END,
      claimed_by = ${blocked ? sql`claimed_by` : null},
      claimed_at = ${blocked ? sql`claimed_at` : null},
      last_heartbeat_at = ${blocked ? sql`last_heartbeat_at` : null}
    WHERE id = ${runId} AND organization_id = ${organizationId}
      AND status = ${run.status} AND approval_status IN ('auto', 'approved')
    RETURNING id
  `;
  if (!changed) return false;
  const resolved = !blocked && run.connection_id !== null && run.action_key
    ? await getOperationForConnection(organizationId, Number(run.connection_id), run.action_key, sql)
    : null;
  if (!blocked && !resolved) throw new Error('Approval operation became unavailable during policy recheck');
  const connectionName = resolved?.connection.display_name ?? run.connector_key ?? 'Connection';
  const status = blocked ? 'rejected' : 'pending_approval';
  const title = `${run.action_key ?? 'Operation'} — ${blocked ? 'blocked by policy' : 'pending approval'}`;
  const metadata = {
    policy_reason: policy.reason, policy_rule_ids: policy.ruleIds,
    ...(resolved ? connectorApprovalMetadata(connectionName, resolved.operation, run.action_input ?? {}) : {}),
  };
  let cardId = await supersedeActionEvent(runId, organizationId, status, title, message, metadata, null, sql);
  if (cardId === undefined) {
    // Delegated browser steps normally have no separate ledger card. A policy
    // veto still needs a durable explanation alongside its terminal run.
    const event = await insertEvent({
      entityIds: [], organizationId, originId: `run_${runId}_${status}`,
      title, content: message, semanticType: 'operation', runId,
      connectorKey: run.connector_key, connectionId: run.connection_id,
      interactionType: 'approval', interactionStatus: blocked ? 'rejected' : 'pending',
      interactionInput: isSourceFeedRead(run.run_metadata) ? null : run.action_input,
      metadata: { ...metadata, status, run_id: runId, action_key: run.action_key, operation_key: run.action_key },
    }, { sql });
    cardId = Number(event.id);
  }
  if (resolved) {
    // The run lock admits this transition once. Persist inbox + delivery work
    // on this transaction too, so a crash cannot leave a silent pending Ask.
    const context = run.run_metadata?.approval_notification as ActionApprovalNotificationContext | undefined;
    await notifyActionApprovalNeeded({
      ...context,
      orgId: organizationId, runId, eventId: cardId,
      actionKey: resolved.operation.operation_key,
      connectionName,
      requesterUserId: context?.requesterUserId ?? run.created_by_user_id,
      operation: { name: resolved.operation.name, input: run.action_input ?? {} },
    }, sql);
  }
  return false;
}
