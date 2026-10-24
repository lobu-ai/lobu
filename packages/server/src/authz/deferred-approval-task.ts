/** Durable handoff for approvals held by an atomic Automation completion. */
import { createHash } from "node:crypto";
import { type DbClient, getDb } from "../db/client";
import {
	ENTITY_APPROVAL_TASK,
	taskQueueName,
} from "../scheduled/task-definitions";
import { enqueueTasksInTransaction } from "../scheduled/task-scheduler";
import {
	type EntityChangeProposal,
	proposeEntityChange,
	proposeEntityFieldChange,
} from "../tools/admin/entity-field-approval";
import type { ToolContext } from "../tools/registry";
import { stableJson } from "../utils/insert-event";

type ApprovalContext = Pick<
	ToolContext,
	| "organizationId"
	| "userId"
	| "agentId"
	| "actingAutomationId"
	| "actingRunId"
	| "sourceContext"
	| "clientId"
	| "tokenType"
	| "mcpSessionId"
	| "mcpConversationId"
	| "requestUrl"
	| "baseUrl"
>;
export interface EntityApprovalTaskPayload {
	context: ApprovalContext;
	proposal: EntityChangeProposal;
	sourceRunId: number;
}

export async function enqueueEntityApproval(
	tx: DbClient,
	ctx: ToolContext,
	proposal: EntityChangeProposal,
	sourceRunId: number | null,
): Promise<void> {
	if (!sourceRunId || !proposal.automation_id)
		throw new Error("Approval handoff requires a source Automation run");
	// Persist attribution only. Tokens, capabilities, scopes, and mutable runtime
	// handles never cross this handoff; the task can only propose, never apply.
	const context: ApprovalContext = {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		actingAutomationId: ctx.actingAutomationId,
		actingRunId: ctx.actingRunId,
		sourceContext: ctx.sourceContext,
		clientId: ctx.clientId,
		tokenType: ctx.tokenType,
		mcpSessionId: ctx.mcpSessionId,
		mcpConversationId: ctx.mcpConversationId,
		requestUrl: ctx.requestUrl,
		baseUrl: ctx.baseUrl,
	};
	const fingerprint = createHash("sha256")
		.update(stableJson(proposal))
		.digest("hex");
	await enqueueTasksInTransaction(tx, [
		{
			name: ENTITY_APPROVAL_TASK,
			payload: {
				context,
				proposal,
				sourceRunId,
			} satisfies EntityApprovalTaskPayload,
			opts: {
				idempotencyKey: `entity-approval:${sourceRunId}:${fingerprint}`,
				organizationId: ctx.organizationId,
				automationId: proposal.automation_id,
				parentRunId: sourceRunId,
			},
		},
	]);
}

export async function runEntityApprovalTask(
	payload: EntityApprovalTaskPayload,
	taskRunId: number,
): Promise<void> {
	const sql = getDb();
	const [source] = await sql`
    SELECT source.status
    FROM runs task JOIN runs source ON source.id = task.parent_run_id
    WHERE task.id = ${taskRunId} AND task.run_type = 'task'
      AND task.queue_name = ${taskQueueName(ENTITY_APPROVAL_TASK)}
      AND task.action_key = ${ENTITY_APPROVAL_TASK}
      AND task.organization_id = ${payload.context.organizationId}
      AND source.organization_id = task.organization_id
      AND source.id = ${payload.sourceRunId}
      AND source.automation_id = task.automation_id
      AND source.automation_id = ${payload.proposal.automation_id ?? null}
  `;
	if (!source || source.status !== "completed")
		throw new Error("Approval handoff does not match a committed source run");
	const ctx: ToolContext = {
		...payload.context,
		memberRole: null,
		isAuthenticated: true,
		scopedToOrg: true,
		allowCrossOrg: false,
		grantedOrganizationIds: null,
		directSearchFederation: false,
	};
	if (
		payload.proposal.operation === undefined ||
		payload.proposal.operation === "update"
	) {
		await proposeEntityFieldChange(
			ctx,
			payload.proposal,
			payload.sourceRunId,
			true,
		);
	} else {
		await proposeEntityChange(ctx, payload.proposal, payload.sourceRunId, true);
	}
}
