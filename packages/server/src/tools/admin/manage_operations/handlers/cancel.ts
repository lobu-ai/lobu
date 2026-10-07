import type { Static } from '@sinclair/typebox';
import { resolveActingPrincipal } from '../../../../authz/entity-policy';
import { getDb } from '../../../../db/client';
import type { ToolContext } from '../../../registry';
import { supersedeActionEvent } from '../../approval-events';
import { callerIsAdmin } from '../../helpers/db-helpers';
import type { CancelAction, ManageOperationsResult } from '../schemas';

/** The run and its card settle together; the existing worker lease fences stop
 * a cancelled run being claimed or overwritten by a late completion. */
export async function handleCancel(
  args: Static<typeof CancelAction>,
  ctx: ToolContext,
): Promise<ManageOperationsResult> {
  const sql = getDb();
  const actor = await resolveActingPrincipal(sql, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionAutomationId: ctx.actingAutomationId,
  });
  const human = !ctx.agentId && ctx.actingAutomationId == null && !!ctx.userId;
  const admin = human && await callerIsAdmin(sql, ctx);
  return sql.begin(async (tx) => {
    const [run] = await tx<{
      status: string; approval_status: string | null; action_key: string;
      created_by_user_id: string | null;
      policy_principal_kind: string | null; policy_principal_id: string | null;
    }>`
      SELECT status, approval_status, action_key, created_by_user_id,
        policy_principal_kind, policy_principal_id
      FROM runs WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
        AND run_type = 'action'
      FOR UPDATE
    `;
    if (!run) return { error: 'Operation run not found' };
    const ownsPrincipal = actor.ownerResolved && actor.id != null &&
      run.policy_principal_kind === actor.kind && run.policy_principal_id === actor.id;
    const ownsUserRun = human && run.created_by_user_id === ctx.userId &&
      (run.policy_principal_kind == null || run.policy_principal_kind === 'user');
    if (!admin && !ownsPrincipal && !ownsUserRun) {
      return { error: 'Only the requester or a workspace administrator can cancel this operation.' };
    }
    if (!['pending', 'claimed', 'running'].includes(run.status)) {
      return { action: 'cancel', run_id: args.run_id, status: run.status, cancelled: false };
    }
    const message = 'Operation cancelled by requester or workspace administrator.';
    // A withdrawn approval was never decided: settle it like the TTL sweep and
    // connection delete do, so no reviewer surface keeps it actionable and it
    // is never read back as a human rejection.
    const withdrawnApproval = run.approval_status === 'pending';
    await tx`
      UPDATE runs SET status = 'cancelled', completed_at = current_timestamp,
        outcome = NULL, error_message = ${message},
        approval_status = ${withdrawnApproval ? 'expired' : run.approval_status}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
    await supersedeActionEvent(args.run_id, ctx.organizationId,
      withdrawnApproval ? 'rejected' : 'failed',
      `${run.action_key} — cancelled`, message,
      withdrawnApproval
        ? { run_status: 'cancelled', approval_status: 'expired', expiry_reason: message }
        : { run_status: 'cancelled', error_message: message },
      null, tx);
    return { action: 'cancel', run_id: args.run_id, status: 'cancelled', cancelled: true };
  });
}
