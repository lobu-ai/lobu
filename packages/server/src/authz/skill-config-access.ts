import { getDb } from "../db/client";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { type ActingPrincipal, resolveActingPrincipal, resolveWritePolicyDecision } from "./entity-policy";

/**
 * Whether the caller may read the workspace skill library. Every library read
 * (manage_skills list/get, the catalog's installed view) goes through this one
 * check. Humans keep their org read access; the `skill_config` read policy
 * narrows agent, Automation and app principals.
 */
export async function skillConfigReadAllowed(ctx: ToolContext): Promise<boolean> {
	const principal = await resolveActingPrincipal(getDb(), {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		appId: ctx.appPrincipalId,
		sessionAutomationId: ctx.actingAutomationId ?? null,
	});
	return skillConfigReadAllowedFor(ctx.organizationId, principal);
}

/** The same check for an already-resolved principal (an approval's original requester). */
export async function skillConfigReadAllowedFor(
	organizationId: string,
	principal: Pick<ActingPrincipal, "kind" | "id" | "ownerAgentId" | "ownerResolved">,
): Promise<boolean> {
	if (principal.kind === "user") return true;
	const decision = await resolveWritePolicyDecision({
		organizationId,
		resourceClass: "skill_config",
		principalKind: principal.kind,
		principalId: principal.id,
		ownerAgentId: principal.ownerAgentId,
		ownerResolved: principal.ownerResolved,
		action: "read",
	});
	return decision === "allow";
}

export async function assertSkillConfigReadAllowed(ctx: ToolContext): Promise<void> {
	if (!(await skillConfigReadAllowed(ctx))) {
		throw new ToolUserError("Policy denies reading workspace skills for this principal.", 403);
	}
}
