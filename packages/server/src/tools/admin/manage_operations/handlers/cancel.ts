import type { Static } from '@sinclair/typebox';
import { resolveActingPrincipal } from '../../../../authz/entity-policy';
import { leasedAutomationOfHeldRun } from '../../../../automations/automation-source';
import { getDb } from '../../../../db/client';
import { withFailureCode } from '../../../../utils/errors';
import type { ToolContext } from '../../../registry';
import { supersedeActionEvent } from '../../approval-events';
import { callerIsAdmin } from '../../helpers/db-helpers';
import type { CancelAction, ManageOperationsResult } from '../schemas';

/** The run and its card settle together; the existing worker lease fences stop
 * a cancelled run being claimed or overwritten by a late completion. An external
 * processor withdraws an Automation's run while it holds that Automation's
 * window lease. */
export async function handleCancel(
  args: Static<typeof CancelAction>,
  ctx: ToolContext,
): Promise<ManageOperationsResult> {
  const sql = getDb();
  const actor = await resolveActingPrincipal(sql, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    explicitAutomationId: await leasedAutomationOfHeldRun(sql, ctx, args.run_id),
    sessionAutomationId: ctx.actingAutomationId,
    appId: ctx.appPrincipalId ?? null,
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
        AND (run_type = 'action' OR (run_type = 'internal' AND approval_status = 'pending'))
      FOR UPDATE
    `;
    if (!run) return withFailureCode({ error: 'Operation run not found' }, 'NOT_FOUND');
    // An app key is shared by every user of that app, so it never confers ownership on its own.
    const ownsPrincipal = actor.kind !== 'app' && actor.ownerResolved && actor.id != null &&
      run.policy_principal_kind === actor.kind && run.policy_principal_id === actor.id;
    // A connected app acts with its user's authority: the user, through any of their apps, owns its runs.
    const ownsUserRun = human && run.created_by_user_id === ctx.userId &&
      (run.policy_principal_kind == null || run.policy_principal_kind === 'user' || run.policy_principal_kind === 'app');
    if (!admin && !ownsPrincipal && !ownsUserRun) {
      return withFailureCode({ error: 'Only the requester or a workspace administrator can cancel this operation.' }, 'PERMISSION');
    }
    if (!['pending', 'claimed', 'running'].includes(run.status)) {
      return { action: 'cancel', run_id: args.run_id, status: run.status, cancelled: false };
    }
    const message = 'Operation cancelled by requester or workspace administrator.';
    // A withdrawn Ask or Check was never decided: settle it as `withdrawn`, so
    // no reviewer surface keeps it actionable and it is never read back as a
    // human rejection or as a lapsed request.
    const withdrawn = run.approval_status === 'pending' || run.approval_status === 'check';
    await tx`
      UPDATE runs SET status = 'cancelled', completed_at = current_timestamp,
        outcome = NULL, error_message = ${message},
        approval_status = ${withdrawn ? 'withdrawn' : run.approval_status}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
    // A Check run has no card until it is confirmed: the withdrawn run row is
    // its whole record.
    if (run.approval_status === 'check') {
      return { action: 'cancel', run_id: args.run_id, status: 'cancelled', cancelled: true };
    }
    await supersedeActionEvent(args.run_id, ctx.organizationId,
      withdrawn ? 'rejected' : 'failed',
      (operation) => `${operation} — cancelled`, message,
      withdrawn
        ? { run_status: 'cancelled', approval_status: 'withdrawn', expiry_reason: message,
            withdrawn_by: { principal_kind: actor.kind, principal_id: actor.id, user_id: ctx.userId ?? null } }
        : { run_status: 'cancelled', error_message: message },
      null, tx);
    return { action: 'cancel', run_id: args.run_id, status: 'cancelled', cancelled: true };
  });
}
