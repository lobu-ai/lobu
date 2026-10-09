/**
 * ClientSDK `operations` namespace. Thin wrapper over `manageOperations`.
 *
 * `execute` is the only method flagged `access: 'external'` — dry-run mode
 * (PR-2) intercepts these calls instead of sending them.
 */

import type {
	OperationApproveInput,
	OperationExecuteInput,
	OperationListAvailableInput,
	OperationListRunsInput,
	OperationListActivityInput,
	OperationRejectInput,
} from "@lobu/core/contracts/tools/manage-operations";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

export interface OperationsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	listAvailable(input?: OperationListAvailableInput): Promise<unknown>;
	execute(input: OperationExecuteInput): Promise<unknown>;
	listRuns(input?: OperationListRunsInput): Promise<unknown>;
	listActivity(input?: OperationListActivityInput): Promise<unknown>;
	getRun(run_id: number): Promise<unknown>;
	cancel(run_id: number): Promise<unknown>;
	approve(input: OperationApproveInput): Promise<unknown>;
	reject(input: OperationRejectInput): Promise<unknown>;
}

export function buildOperationsNamespace(
	ctx: ToolContext,
	env: Env,
): OperationsNamespace {
	const { manage, method } = createActionCaller(
		manageOperations,
		env,
		ctx,
		"operations",
	);

	return {
		manage,
		listAvailable: method("list_available", { publicMethod: "listAvailable" }),
		execute: method("execute"),
		listRuns: method("list_runs", { publicMethod: "listRuns" }),
		listActivity: method("list_activity", { publicMethod: "listActivity" }),
		getRun: method("get_run", {
			publicMethod: "getRun",
			mapArgs: (run_id) => ({
				run_id: idArg("operations.getRun", "run_id", run_id, "number"),
			}),
		}),
		cancel: method("cancel", {
			mapArgs: (run_id) => ({ run_id: idArg("operations.cancel", "run_id", run_id, "number") }),
		}),
		approve: method("approve"),
		reject: method("reject"),
	};
}
