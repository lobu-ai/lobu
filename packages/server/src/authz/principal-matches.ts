import type { ActingPrincipal, EntityApprovalPolicy } from "./entity-policy";

/**
 * Whether a rule's subject names the caller: everyone, every principal of the
 * caller's kind, or the caller itself. An Automation also matches the rules of
 * the agent it runs as.
 */
export function principalMatches(
	rule: Pick<EntityApprovalPolicy, "principalKind" | "principalId">,
	actor: ActingPrincipal,
): boolean {
	return (
		rule.principalKind === null ||
		(rule.principalKind === actor.kind &&
			(rule.principalId === null || rule.principalId === actor.id)) ||
		(actor.kind === "automation" &&
			actor.ownerAgentId !== null &&
			rule.principalKind === "agent" &&
			(rule.principalId === null || rule.principalId === actor.ownerAgentId))
	);
}
