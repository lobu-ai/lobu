import type { AvailableOperation } from "../operations/types";
import { qualifiedOperationKey } from "../tools/admin/manage_operations/handlers/shared";
import type { ActingPrincipal, EntityApprovalPolicy } from "./entity-policy";

export const CONNECTOR_POLICY_CATEGORIES = [
	"read",
	"write",
	"destructive",
	"non_destructive",
	"unknown",
] as const;
export type ConnectorPolicyCategory =
	(typeof CONNECTOR_POLICY_CATEGORIES)[number];

export interface ConnectorPolicyScope {
	connectorKey?: string | null;
	connectionId?: number | null;
	operationCategory?: ConnectorPolicyCategory | null;
}

/** An exact action names its connector even when the caller omits the target. */
export function canonicalConnectorPolicyScope(
	scope: ConnectorPolicyScope & { operationKey?: string | null },
): Required<ConnectorPolicyScope> {
	let { connectorKey = null } = scope;
	const { connectionId = null, operationCategory = null, operationKey } = scope;
	if (operationKey) {
		const separator = operationKey.indexOf("::");
		if (separator <= 0 || separator + 2 === operationKey.length)
			throw new Error("operation_key must name a connector and action (connector::action).");
		const operationConnector = operationKey.slice(0, separator);
		if (connectorKey !== null && connectorKey !== operationConnector)
			throw new Error("operation_key must belong to connector_key.");
		if (connectionId === null) connectorKey = operationConnector;
	}
	return { connectorKey, connectionId, operationCategory };
}

export interface ConnectorPolicyResult {
	effect: "auto" | "approval" | "deny";
	ruleIds: number[];
	reason:
		| "matched_rule"
		| "default_approval"
		| "unresolved_principal"
		| "parent_approval"
		| "unavailable_operation";
}

type PolicyOperation = Pick<
	AvailableOperation,
	"connector_key" | "operation_key" | "kind" | "annotations"
>;
const rank = { auto: 0, approval: 1, deny: 2 } as const;

function matchesCategory(
	category: ConnectorPolicyCategory | null,
	operation: PolicyOperation,
): boolean {
	if (category === null) return true;
	if (category === "read" || category === "write")
		return operation.kind === category;
	if (operation.kind !== "write") return false;
	const destructive = operation.annotations?.destructiveHint;
	if (category === "destructive") return destructive === true;
	if (category === "non_destructive") return destructive === false;
	return destructive === undefined;
}

function specificity(rule: EntityApprovalPolicy): [number, number] {
	const target =
		rule.connectionId !== null ? 2 : rule.connectorKey !== null ? 1 : 0;
	const action =
		rule.operationKey !== null ? 2 : rule.operationCategory !== null ? 1 : 0;
	return [target, action];
}

/** Narrowing a target cannot erase a restriction on a different action category. */
function moreSpecific(a: EntityApprovalPolicy, b: EntityApprovalPolicy): boolean {
	const [targetA, actionA] = specificity(a);
	const [targetB, actionB] = specificity(b);
	if (actionA === 1 && actionB === 1 && a.operationCategory !== b.operationCategory)
		return false;
	return targetA >= targetB && actionA >= actionB && (targetA > targetB || actionA > actionB);
}

/** Keep the narrowest matching scopes, then apply principal restrictions. */
export function evaluateConnectorPolicy(args: {
	organizationId: string;
	connectionId: number | null;
	operation: PolicyOperation;
	actor: ActingPrincipal;
	policies: readonly EntityApprovalPolicy[];
}): ConnectorPolicyResult {
	if (!args.actor.ownerResolved) {
		return { effect: "deny", ruleIds: [], reason: "unresolved_principal" };
	}
	const key = qualifiedOperationKey(
		args.operation.connector_key,
		args.operation.operation_key,
	);
	const matches = args.policies.filter(
		(rule) =>
			rule.organizationId === args.organizationId &&
			rule.resourceClass === "connector_action" &&
			rule.effects.execute !== undefined &&
			(rule.connectionId === null || rule.connectionId === args.connectionId) &&
			(rule.connectorKey === null ||
				rule.connectorKey === args.operation.connector_key) &&
			(rule.operationKey === null || rule.operationKey === key) &&
			matchesCategory(rule.operationCategory, args.operation),
	);
	const orgRules = matches.filter((rule) => rule.principalKind === null);
	const decisive = orgRules.filter((rule) => !orgRules.some((other) => moreSpecific(other, rule)));
	let effect: ConnectorPolicyResult["effect"] = decisive.length
		? "auto"
		: "approval";
	const restrictions = matches.filter(
		(rule) =>
			rule.principalKind !== null &&
			((rule.principalKind === args.actor.kind &&
				(rule.principalId === null || rule.principalId === args.actor.id)) ||
				(args.actor.kind === "automation" &&
					args.actor.ownerAgentId !== null &&
					rule.principalKind === "agent" &&
					(rule.principalId === null ||
						rule.principalId === args.actor.ownerAgentId))),
	);
	const contributors: number[] = [];
	for (const rule of [...decisive, ...restrictions]) {
		const stored = rule.effects.execute;
		// Invalid stored values fail closed. New connector rules only accept the three effects.
		const candidate =
			stored === "auto" || stored === "approval" ? stored : "deny";
		if (rank[candidate] > rank[effect]) {
			effect = candidate;
			contributors.length = 0;
		}
		if (candidate === effect) contributors.push(rule.id);
	}
	return {
		effect,
		ruleIds: contributors.sort((a, b) => a - b),
		reason: contributors.length ? "matched_rule" : "default_approval",
	};
}
