/**
 * Tool: manage_operations
 *
 * Unified execution and discovery surface for connector-backed operations.
 * Operations can be backed by local connector actions, upstream MCP tools,
 * or OpenAPI-derived HTTP operations.
 */

import { action, defineActionTool } from "./action-tool";
import {
	handleApprove,
	handleApproveBatch,
	handleReject,
	handleRejectBatch,
} from "./manage_operations/handlers/approvals";
import { handleExecute } from "./manage_operations/handlers/execute";
import { handleListAvailable } from "./manage_operations/handlers/list-available";
import {
	handleGetRun,
	handleListActivity,
	handleListRuns,
} from "./manage_operations/handlers/runs";
import {
	ApproveAction,
	ApproveBatchAction,
	ExecuteAction,
	GetRunAction,
	ListActivityAction,
	ListAvailableAction,
	ListRunsAction,
	RejectAction,
	RejectBatchAction,
} from "./manage_operations/schemas";
import { queueApprovalNotificationCardRefresh } from "../../notifications/service";
import type { ToolContext } from "../registry";

function settleApprovalResult<T>(ctx: ToolContext, result: T): T {
	const record = result as Record<string, unknown>;
	const runIds = Array.isArray(record.run_ids)
		? record.run_ids.map(Number)
		: Number.isFinite(Number(record.run_id))
			? [Number(record.run_id)]
			: [];
	queueApprovalNotificationCardRefresh(ctx.organizationId, runIds);
	return result;
}

const manageOperationsTool = defineActionTool("manage_operations", {
	list_available: action(ListAvailableAction, handleListAvailable),
	execute: action(ExecuteAction, handleExecute),
	list_runs: action(ListRunsAction, handleListRuns),
	get_run: action(GetRunAction, handleGetRun),
	list_activity: action(ListActivityAction, handleListActivity),
	approve: action(ApproveAction, async (args, ctx, env) =>
		settleApprovalResult(ctx, await handleApprove(args, ctx, env)),
	),
	reject: action(RejectAction, async (args, ctx) =>
		settleApprovalResult(ctx, await handleReject(args, ctx)),
	),
	approve_batch: action(ApproveBatchAction, async (args, ctx, env) =>
		settleApprovalResult(ctx, await handleApproveBatch(args, ctx, env)),
	),
	reject_batch: action(RejectBatchAction, async (args, ctx) =>
		settleApprovalResult(ctx, await handleRejectBatch(args, ctx)),
	),
});

/**
 * Approval-card settlement belongs after the shared state transition, not in
 * any one UI handler. This keeps Slack, web, MCP Apps, single decisions, and
 * batches convergent: whichever surface wins the durable run claim updates all
 * persisted chat copies from the same final state.
 */
export const manageOperations = manageOperationsTool.run;
export {
	ManageOperationsResultSchema,
	ManageOperationsSchema,
} from "./manage_operations/schemas";
export {
	type ApprovalReviewer,
	requireApprovalCard,
	supersedeActionEvent,
} from "./approval-events";
export { waitForDeviceActionRun } from "./device-action-wait";
export {
	formatActivityAttentionBlock,
	listOrgActivity,
} from "./manage_operations/activity-feed";
export {
	buildActionConfig,
} from "./manage_operations/handlers/execute";
export { qualifiedOperationKey } from "./manage_operations/handlers/shared";
