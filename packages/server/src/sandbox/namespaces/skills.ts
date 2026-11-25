/**
 * ClientSDK `skills` namespace. Thin wrapper over `manageSkills`: the
 * workspace skill library.
 */

import type {
	SkillArchiveInput,
	SkillGetInput,
	SkillInstallFromCatalogInput,
	SkillListInput,
	SkillPutInput,
} from "@lobu/core/contracts/tools/manage-skills";
import type { Env } from "../../index";
import { manageSkills } from "../../tools/admin/manage_skills";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface SkillsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: SkillListInput): Promise<unknown>;
	get(input: SkillGetInput): Promise<unknown>;
	put(input: SkillPutInput): Promise<unknown>;
	archive(input: SkillArchiveInput): Promise<unknown>;
	installFromCatalog(input: SkillInstallFromCatalogInput): Promise<unknown>;
}

export function buildSkillsNamespace(ctx: ToolContext, env: Env): SkillsNamespace {
	const { manage, method } = createActionCaller(manageSkills, env, ctx, "skills");
	return {
		manage,
		list: method("list"),
		get: method("get"),
		put: method("put"),
		archive: method("archive"),
		installFromCatalog: method("install_from_catalog"),
	};
}
