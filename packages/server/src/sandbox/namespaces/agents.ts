/**
 * ClientSDK `agents` namespace. Thin wrapper over `manageAgents`.
 */

import type {
	AgentCreateInput,
	AgentUpdateInput,
	ManageAgentsArgs,
	ManageAgentsResult,
} from "@lobu/core/contracts/tools/manage-agents";
import type { Env } from "../../index";
import { manageAgents } from "../../tools/admin/manage_agents";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

export interface AgentsNamespace {
	manage(input: ManageAgentsArgs): Promise<unknown>;
	list(): Promise<unknown>;
	get(agent_id: string): Promise<Extract<ManageAgentsResult, { action: "get" }>>;
	create(input: AgentCreateInput): Promise<unknown>;
	update(input: AgentUpdateInput): Promise<ManageAgentsResult>;
	delete(agent_id: string): Promise<unknown>;
}

export function buildAgentsNamespace(
	ctx: ToolContext,
	env: Env,
): AgentsNamespace {
	const { manage, method } = createActionCaller(manageAgents, env, ctx, "agents");

	return {
		manage,
		list: method("list"),
		get: method("get", {
			mapArgs: (agent_id) => ({
				agent_id: idArg("agents.get", "agent_id", agent_id, "string"),
			}),
		}),
		create: method("create"),
		update: method("update"),
		delete: method("delete", {
			mapArgs: (agent_id) => ({
				agent_id: idArg("agents.delete", "agent_id", agent_id, "string"),
			}),
		}),
	};
}
