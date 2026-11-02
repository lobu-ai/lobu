/**
 * ClientSDK `schedules` namespace. Thin wrapper over `manageSchedules`.
 */

import type {
	ManageSchedulesArgs,
	ScheduleCancelInput,
	ScheduleCreateInput,
	ScheduleListInput,
	SchedulePauseInput,
	ScheduleUpdateInput,
} from "@lobu/core/contracts/tools/manage-schedules";
import type { Env } from "../../index";
import { manageSchedules } from "../../tools/admin/manage_schedules";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface SchedulesNamespace {
	manage(input: ManageSchedulesArgs): Promise<unknown>;
	list(input?: ScheduleListInput): Promise<unknown>;
	create(input: ScheduleCreateInput): Promise<unknown>;
	update(input: ScheduleUpdateInput): Promise<unknown>;
	pause(input: SchedulePauseInput): Promise<unknown>;
	cancel(input: ScheduleCancelInput): Promise<unknown>;
}

export function buildSchedulesNamespace(
	ctx: ToolContext,
	env: Env,
): SchedulesNamespace {
	const { manage, method } = createActionCaller(manageSchedules, env, ctx, "schedules");

	return {
		manage,
		list: method("list"),
		create: method("create"),
		update: method("update"),
		pause: method("pause"),
		cancel: method("cancel"),
	};
}
