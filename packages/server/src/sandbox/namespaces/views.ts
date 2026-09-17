/**
 * ClientSDK `views` namespace. Thin wrapper over `manageViews`.
 *
 * The attach line lives in the module source — there are no attach/detach
 * verbs, and git is the only history of definitions, so this namespace is
 * set/get/list/remove.
 */

import type {
	ViewGetInput,
	ViewListInput,
	ViewRemoveInput,
	ViewSetInput,
} from "@lobu/core/contracts/tools/manage-views";
import type { Env } from "../../index";
import { manageViews } from "../../tools/admin/manage_views";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface ViewsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	get(input: ViewGetInput): Promise<unknown>;
	set(input: ViewSetInput): Promise<unknown>;
	list(input: ViewListInput): Promise<unknown>;
	remove(input: ViewRemoveInput): Promise<unknown>;
}

export function buildViewsNamespace(
	ctx: ToolContext,
	env: Env
): ViewsNamespace {
	const { manage, method } = createActionCaller(
		manageViews,
		env,
		ctx,
		"views"
	);

	return {
		manage,
		get: method("get"),
		set: method("set"),
		list: method("list"),
		remove: method("remove"),
	};
}
