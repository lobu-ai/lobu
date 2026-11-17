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

/** How a rule takes part: grants fold narrowest-wins; guardrails can only tighten. */
export type ConnectorPolicyKind = "grant" | "guardrail";

/** A rule that decided a policy result, as shown to callers and approvers. */
export interface ConnectorPolicyRuleRef {
	id: number;
	kind: ConnectorPolicyKind;
	note?: string;
}

export interface ConnectorPolicyResult {
	effect: "auto" | "approval" | "deny";
	ruleIds: number[];
	/** The deciding rules: guardrails first, then grants, each by id. */
	rules: ConnectorPolicyRuleRef[];
	reason:
		| "matched_rule"
		| "guardrail"
		| "default_approval"
		| "unresolved_principal"
		| "parent_approval"
		| "unavailable_operation";
}

/**
 * Why an operation was held or blocked, recorded on held runs and returned to
 * callers. `device_owner` marks a hold that comes from the pinned device's owner
 * rather than from organization policy.
 */
export interface ConnectorPolicyExplanation {
	reason: ConnectorPolicyResult["reason"] | "device_owner";
	rules: ConnectorPolicyRuleRef[];
}

export function explainConnectorPolicy(
	policy: ConnectorPolicyResult,
	deviceOwner = false,
): ConnectorPolicyExplanation {
	return {
		reason: deviceOwner && policy.effect === "auto" ? "device_owner" : policy.reason,
		rules: policy.rules.map((rule) => ({ ...rule })),
	};
}

/** `: <note>` from the first deciding rule that carries one, else "". */
export function connectorPolicyNoteSuffix(
	policy: Pick<ConnectorPolicyResult, "rules">,
): string {
	const note = policy.rules.find((rule) => rule.note)?.note;
	return note ? `: ${note}` : "";
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

/** Keep the narrowest matching grants, apply principal restrictions, then every matching guardrail. */
export function evaluateConnectorPolicy(args: {
	organizationId: string;
	connectionId: number | null;
	operation: PolicyOperation;
	actor: ActingPrincipal;
	policies: readonly EntityApprovalPolicy[];
}): ConnectorPolicyResult {
	if (!args.actor.ownerResolved) {
		return { effect: "deny", ruleIds: [], rules: [], reason: "unresolved_principal" };
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
	const grants = matches.filter((rule) => rule.kind === "grant");
	const orgRules = grants.filter((rule) => rule.principalKind === null);
	const decisive = orgRules.filter((rule) => !orgRules.some((other) => moreSpecific(other, rule)));
	let effect: ConnectorPolicyResult["effect"] = decisive.length
		? "auto"
		: "approval";
	const namesActor = (rule: EntityApprovalPolicy) =>
		rule.principalKind === null ||
		(rule.principalKind === args.actor.kind &&
			(rule.principalId === null || rule.principalId === args.actor.id)) ||
		(args.actor.kind === "automation" &&
			args.actor.ownerAgentId !== null &&
			rule.principalKind === "agent" &&
			(rule.principalId === null ||
				rule.principalId === args.actor.ownerAgentId));
	const restrictions = grants.filter(
		(rule) => rule.principalKind !== null && namesActor(rule),
	);
	// Every matching guardrail applies after the grant fold. A guardrail can only
	// hold or block: a stored `auto` (rejected on write) or any unrecognised
	// effect fails closed to deny.
	const guardrails = matches.filter(
		(rule) => rule.kind !== "grant" && namesActor(rule),
	);
	let contributors: EntityApprovalPolicy[] = [];
	const fold = (rule: EntityApprovalPolicy, candidate: ConnectorPolicyResult["effect"]) => {
		if (rank[candidate] > rank[effect]) {
			effect = candidate;
			contributors = [];
		}
		if (candidate === effect) contributors.push(rule);
	};
	for (const rule of [...decisive, ...restrictions]) {
		const stored = rule.effects.execute;
		// Invalid stored values fail closed. New connector rules only accept the three effects.
		fold(rule, stored === "auto" || stored === "approval" ? stored : "deny");
	}
	for (const rule of guardrails) {
		const candidate = rule.effects.execute === "approval" ? "approval" : "deny";
		// A guardrail only raises the result; an equally strict guardrail still
		// explains it.
		if (rank[candidate] >= rank[effect]) fold(rule, candidate);
	}
	const ordered = [...contributors].sort(
		(a, b) => Number(a.kind === "grant") - Number(b.kind === "grant") || a.id - b.id,
	);
	return {
		effect,
		ruleIds: ordered.map((rule) => rule.id).sort((a, b) => a - b),
		rules: ordered.map((rule) => ({
			id: rule.id,
			kind: rule.kind,
			...(rule.note ? { note: rule.note } : {}),
		})),
		reason: ordered.some((rule) => rule.kind !== "grant")
			? "guardrail"
			: ordered.length
				? "matched_rule"
				: "default_approval",
	};
}
