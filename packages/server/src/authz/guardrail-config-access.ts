import { getDb } from "../db/client";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { agentConfigReadAllowed } from "./agent-config-access";
import { resolveActingPrincipal } from "./entity-policy";

/**
 * Whether the caller may read the workspace guardrail library. Guardrails were
 * agent configuration, so their readability is the `agent_config` read policy
 * for the workspace as a whole: humans keep their org read access, and agent,
 * Automation and app principals are narrowed by policy.
 */
async function guardrailConfigReadAllowed(ctx: ToolContext): Promise<boolean> {
	const principal = await resolveActingPrincipal(getDb(), {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		appId: ctx.appPrincipalId,
		sessionAutomationId: ctx.actingAutomationId ?? null,
	});
	return agentConfigReadAllowed(ctx, null, principal);
}

export async function assertGuardrailConfigReadAllowed(ctx: ToolContext): Promise<void> {
	if (!(await guardrailConfigReadAllowed(ctx))) {
		throw new ToolUserError("Policy denies reading workspace guardrails for this principal.", 403);
	}
}
