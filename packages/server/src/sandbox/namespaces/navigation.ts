import type { ManageNavigationResult, NavigationGetInput, NavigationSetInput } from "@lobu/core/contracts/tools/manage-navigation";
import type { Env } from "../../index";
import { manageNavigation } from "../../tools/admin/manage_navigation";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface NavigationNamespace {
	get(input?: NavigationGetInput): Promise<ManageNavigationResult>;
	set(input: NavigationSetInput): Promise<ManageNavigationResult>;
}

export function buildNavigationNamespace(ctx: ToolContext, env: Env): NavigationNamespace {
	const { method } = createActionCaller(manageNavigation, env, ctx, "navigation");
	return { get: method("get"), set: method("set") };
}
