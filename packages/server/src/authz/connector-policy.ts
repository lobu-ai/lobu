import type { AvailableOperation } from "../operations/types";
import { qualifiedOperationKey } from "../tools/admin/manage_operations/handlers/shared";
import { allowedConnectorEffect, type AllowedAction } from "./caller-action-allowlist";
import type { ActingPrincipal, EntityApprovalPolicy, EntityPolicyPrincipalKind } from "./entity-policy";
import { type WriteEffect, writeEffectRank } from "./write-action-manifest";

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
	effect: WriteEffect;
	ruleIds: number[];
	/** The deciding rules: guardrails first, then grants, each by id. */
	rules: ConnectorPolicyRuleRef[];
	reason:
		| "matched_rule"
		| "guardrail"
		| "default_auto"
		| "unresolved_principal"
		| "parent_approval"
		| "unavailable_operation"
		/** The caller's allowed actions list, not a workspace rule, decided it. */
		| "allowlist";
}

/**
 * Who a policy decision was made for: the run's stored policy principal and
 * its name when decided. A person's id is null, as on the run.
 */
export interface ConnectorPolicyPrincipal {
	kind: EntityPolicyPrincipalKind;
	id: string | null;
	label: string | null;
}

/**
 * Why an operation was held or blocked, recorded on held runs and returned to
 * callers. `device_owner` marks a hold that comes from the pinned device's owner
 * rather than from organization policy.
 */
export interface ConnectorPolicyExplanation {
	reason: ConnectorPolicyResult["reason"] | "device_owner";
	rules: ConnectorPolicyRuleRef[];
	principal: ConnectorPolicyPrincipal;
}

/** A refusal by the caller's own allowed actions list, named as such rather than as a workspace rule. */
export function allowlistRefusal(operationKey: string): string {
	return `'${operationKey}' isn't on this caller's allowed actions list.`;
}

export function explainConnectorPolicy(
	policy: ConnectorPolicyResult,
	principal: ConnectorPolicyPrincipal,
	deviceOwner = false,
): ConnectorPolicyExplanation {
	return {
		reason: deviceOwner && runsWithoutHold(policy.effect) ? "device_owner" : policy.reason,
		rules: policy.rules.map((rule) => ({ ...rule })),
		principal: { ...principal },
	};
}

/**
 * `: <note>` from the first deciding rule that carries one, else "". A device
 * owner's hold is not explained by policy: its rules are the Auto grants that
 * allowed the run, so their notes never explain the hold.
 */
export function connectorPolicyNoteSuffix(
	policy: Pick<ConnectorPolicyResult, "rules"> & {
		reason?: ConnectorPolicyExplanation["reason"];
	},
): string {
	if (policy.reason === "device_owner") return "";
	const note = policy.rules.find((rule) => rule.note)?.note;
	return note ? `: ${note}` : "";
}

type PolicyOperation = Pick<
	AvailableOperation,
	"connector_key" | "operation_key" | "kind" | "annotations"
>;

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

/** Auto and Log only run with no hold; Log differs only in what the card records. */
export function runsWithoutHold(effect: WriteEffect): boolean {
	return effect === "auto" || effect === "log";
}

/** `runs.run_metadata` key the confirm action stamps on a Check run it releases. */
export const POLICY_CHECK_METADATA_KEY = "policy_check";

/**
 * Whether a run already cleared the hold its current policy asks for. A human
 * approval clears Ask and Check; the requester's own confirmation clears only
 * Check. Block is never cleared.
 */
export function runClearedHold(
	effect: WriteEffect,
	run: { approval_status: string; run_metadata: Record<string, unknown> | null },
): boolean {
	if (runsWithoutHold(effect)) return true;
	if (run.approval_status === "approved") return effect === "approval" || effect === "check";
	return effect === "check" && run.run_metadata?.[POLICY_CHECK_METADATA_KEY] != null;
}

/**
 * Who may confirm a Check: an agent session, a connected app, or an Automation
 * that runs an agent. People and code-only Automations get Ask instead.
 */
export function canConfirmCheck(actor: ActingPrincipal): boolean {
	if (actor.kind === "agent" || actor.kind === "app") return true;
	return actor.kind === "automation" && actor.ownerAgentId !== null;
}

/** Keep the narrowest matching grants, apply principal restrictions, then every matching guardrail. */
export function evaluateConnectorPolicy(args: {
	organizationId: string;
	connectionId: number | null;
	operation: PolicyOperation;
	actor: ActingPrincipal;
	policies: readonly EntityApprovalPolicy[];
	/** Every allowlist bound to the caller; each one must name the write. */
	allowlists?: readonly (readonly AllowedAction[])[];
	/**
	 * A person acting in the web app (`isPersonInWebApp`), recorded on the run
	 * at admission. Rules stop agents, apps and Automations, never a person.
	 */
	person?: boolean;
}): ConnectorPolicyResult {
	if (!args.actor.ownerResolved) {
		return { effect: "deny", ruleIds: [], rules: [], reason: "unresolved_principal" };
	}
	if (args.person && args.actor.kind === "user") {
		return { effect: "auto", ruleIds: [], rules: [], reason: "default_auto" };
	}
	// An allowlist limits what a caller may change; reads stay open unless a rule blocks them.
	const allowedEffect = args.operation.kind === "read"
		? "auto"
		: allowedConnectorEffect(args.allowlists ?? [], args.connectionId, args.operation.operation_key);
	if (allowedEffect === "deny") {
		return { effect: "deny", ruleIds: [], rules: [], reason: "allowlist" };
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
	// With no matching rule the action runs: holds come from rules, never from silence.
	let effect: ConnectorPolicyResult["effect"] = "auto";
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
	// The caller's own Auto rule for this exact action on this exact connection
	// lifts every Ask first for it. Only a rule naming this caller (or an
	// Automation's agent) counts; a rule for every agent or every app never does.
	const lifts = restrictions.filter(
		(rule) =>
			rule.principalId !== null &&
			rule.connectionId !== null &&
			rule.operationKey !== null &&
			rule.operationCategory === null &&
			rule.effects.execute === "auto",
	);
	const ownLift = lifts.some((rule) => rule.principalKind === args.actor.kind);
	// An Automation's agent lifts Asks for it too, except an Ask set for
	// Automations, so "Ask next time" on an Automation still asks.
	const lifted = (rule: EntityApprovalPolicy) =>
		rule.effects.execute === "approval" &&
		lifts.length > 0 &&
		(ownLift || rule.principalKind !== "automation");
	// Every matching guardrail applies after the grant fold. A guardrail can only
	// log, check, hold or block: a stored `auto` (rejected on write) or any
	// unrecognised effect fails closed to deny.
	const guardrails = matches.filter(
		(rule) => rule.kind !== "grant" && namesActor(rule),
	);
	let contributors: EntityApprovalPolicy[] = [];
	const fold = (rule: EntityApprovalPolicy, candidate: ConnectorPolicyResult["effect"]) => {
		if (writeEffectRank(candidate) > writeEffectRank(effect)) {
			effect = candidate;
			contributors = [];
		}
		if (candidate === effect) contributors.push(rule);
	};
	for (const rule of [...decisive, ...restrictions]) {
		const stored = rule.effects.execute;
		if (lifted(rule)) continue;
		// Invalid stored values fail closed. New connector rules only accept the three effects.
		fold(rule, stored === "auto" || stored === "approval" ? stored : "deny");
	}
	for (const rule of guardrails) {
		const stored = rule.effects.execute;
		// Block, Log and Check still apply, including a Check asked of a caller
		// that cannot confirm it.
		if (lifted(rule)) continue;
		let candidate: WriteEffect =
			stored === "log" || stored === "check" || stored === "approval" ? stored : "deny";
		// Only an agent can confirm its own Check. A person or an Automation
		// without an agent has nobody to confirm it, so it is asked instead.
		if (candidate === "check" && !canConfirmCheck(args.actor)) candidate = "approval";
		// A guardrail only raises the result; an equally strict guardrail still
		// explains it.
		if (writeEffectRank(candidate) >= writeEffectRank(effect)) fold(rule, candidate);
	}
	const allowlistEffect = allowedEffect === "check" && !canConfirmCheck(args.actor)
		? "approval"
		: allowedEffect;
	if (writeEffectRank(allowlistEffect) > writeEffectRank(effect)) {
		return { effect: allowlistEffect, ruleIds: [], rules: [], reason: "allowlist" };
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
				: "default_auto",
	};
}
