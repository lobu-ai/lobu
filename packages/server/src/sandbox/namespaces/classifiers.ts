/**
 * ClientSDK `classifiers` namespace. Thin wrapper over `manageClassifiers`.
 *
 * `delete` addresses a classifier by `classifier_id: number`; `classify`
 * addresses it by `classifier_slug: string`.
 */

import type {
	ClassifierClassifyInput,
	ClassifierCreateInput,
	ClassifierDeleteInput,
	ClassifierListInput,
} from "@lobu/core/contracts/tools/manage-classifiers";
import type { Env } from "../../index";
import { manageClassifiers } from "../../tools/admin/manage_classifiers";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface ClassifiersNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: ClassifierListInput): Promise<unknown>;
	create(input: ClassifierCreateInput): Promise<unknown>;
	delete(input: ClassifierDeleteInput): Promise<unknown>;
	classify(input: ClassifierClassifyInput): Promise<unknown>;
}

export function buildClassifiersNamespace(
	ctx: ToolContext,
	env: Env,
): ClassifiersNamespace {
	const { manage, method } = createActionCaller(manageClassifiers, env, ctx, "classifiers");

	return {
		manage,
		list: method("list"),
		create: method("create"),
		delete: method("delete"),
		classify: method("classify"),
	};
}
