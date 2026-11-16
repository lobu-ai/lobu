import { getDb } from "../db/client";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import {
	type ActingPrincipal,
	resolveActingPrincipal,
	resolveWritePolicyDecision,
} from "./entity-policy";

/** Agent configuration and its installed metadata share the same read envelope. */
export async function agentConfigReadAllowed(
	ctx: ToolContext,
	targetAgentId: string | null,
	actor?: ActingPrincipal,
): Promise<boolean> {
	const principal = actor ?? await resolveActingPrincipal(getDb(), {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		sessionAutomationId: ctx.actingAutomationId ?? null,
	});
	// Humans retain their existing org/read access; this policy narrows agent principals.
	if (principal.kind === "user") return true;
	const decision = await resolveWritePolicyDecision({
		organizationId: ctx.organizationId,
		resourceClass: "agent_config",
		principalKind: principal.kind,
		principalId: principal.id,
		ownerAgentId: principal.ownerAgentId,
		ownerResolved: principal.ownerResolved,
		action: "read",
		targetAgentId,
	});
	return decision === "allow";
}

export async function assertAgentConfigReadAllowed(
	ctx: ToolContext,
	targetAgentId: string | null,
): Promise<void> {
	if (!(await agentConfigReadAllowed(ctx, targetAgentId))) {
		throw new ToolUserError(
			`Policy denies reading agent '${targetAgentId?.trim() || "agents"}' for this principal.`,
			403,
		);
	}
}
