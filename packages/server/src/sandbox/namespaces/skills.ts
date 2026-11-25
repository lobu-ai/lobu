/**
 * ClientSDK `skills` namespace. Thin wrapper over `manageSkills`: reads of the
 * workspace skill library.
 */

import type { SkillGetInput, SkillListInput } from "@lobu/core/contracts/tools/manage-skills";
import type { Env } from "../../index";
import { manageSkills } from "../../tools/admin/manage_skills";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface SkillsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: SkillListInput): Promise<unknown>;
	get(input: SkillGetInput): Promise<unknown>;
}

export function buildSkillsNamespace(ctx: ToolContext, env: Env): SkillsNamespace {
	const { manage, method } = createActionCaller(manageSkills, env, ctx, "skills");
	return {
		manage,
		list: method("list"),
		get: method("get"),
	};
}
