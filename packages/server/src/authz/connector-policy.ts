import type { DestinationAudience } from "@lobu/connector-sdk";
import type { AvailableOperation } from "../operations/types";
import { qualifiedOperationKey } from "../tools/admin/manage_operations/handlers/shared";
import { allowedConnectorEffect, type AllowedAction } from "./caller-action-allowlist";
import type { ActingPrincipal, EntityApprovalPolicy, EntityPolicyPrincipalKind } from "./entity-policy";
import { policyConditionsHold } from "./policy-conditions";
import { principalMatches } from "./principal-matches";
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

/** A guardrail with an audience applies only where at least that audience sees the write. */
export const POLICY_AUDIENCES = ["workspace", "external"] as const;
export type PolicyAudience = (typeof POLICY_AUDIENCES)[number];

// An audience that could not be read counts as the widest.
const AUDIENCE_WIDTH = { private: 0, workspace: 1, external: 2, unknown: 2 } as const;

function reachesAudience(
	audience: PolicyAudience | null,
	destination: DestinationAudience | undefined,
): boolean {
	if (audience === null) return true;
	return destination !== undefined && AUDIENCE_WIDTH[destination] >= AUDIENCE_WIDTH[audience];
}

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
	/**
	 * The conditions of a conditional rule that decided the result, as stored.
	 * Shown to approvers on the card and in Activity; the agent gets the note.
	 */
	when?: readonly unknown[];
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
 * The explanation returned to the requester: an agent, app or Automation gets
 * each rule's note but not its conditions, which only approvers see.
 */
export function requesterPolicyExplanation(explanation: ConnectorPolicyExplanation): ConnectorPolicyExplanation {
	return { ...explanation, rules: explanation.rules.map(({ when: _when, ...rule }) => rule) };
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
	"connector_key" | "operation_key" | "kind" | "annotations" | "input_schema"
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

/** Auto grants; every other rule (a hold, a block, any guardrail) restricts. */
function grantsAccess(rule: EntityApprovalPolicy): boolean {
	return rule.kind === "grant" && rule.effects.execute === "auto";
}

/**
 * How a rule's `when` is decided when it cannot be (no input, as in
 * discovery, or a stored condition this runtime cannot read).
 *
 * - `strict` (the default) reports the most restrictive result any input could
 *   get: a restricting rule applies, a granting rule does not, and neither
 *   may shadow a broader rule, since for some input it would not hold.
 * - `lenient` reports the least restrictive one: a restricting rule does not
 *   apply, a granting rule does, and either may shadow. Only used to decide
 *   whether an operation is blocked for every input, e.g. to hide it.
 */
export type UnknownConditionSide = "strict" | "lenient";

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
	/**
	 * Who will see the write, read by the connector from the input marked
	 * `x-lobu-destination`. Absent: nothing to classify, so a rule with an
	 * audience never applies.
	 */
	destinationAudience?: DestinationAudience;
	/**
	 * The operation's input, which a rule's `when` reads. Absent: not known
	 * yet (discovery, inspection), so conditions are decided per `unknownConditions`.
	 * Null is an operation with no input.
	 */
	input?: Record<string, unknown> | null;
	unknownConditions?: UnknownConditionSide;
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
			matchesCategory(rule.operationCategory, args.operation) &&
			reachesAudience(rule.audience, args.destinationAudience),
	);
	// A rule whose `when` does not hold is ignored, exactly as if its scope did
	// not match. An undecidable one applies only on the side asked for.
	const lenient = args.unknownConditions === "lenient";
	const holds = new Map(matches.map((rule) => [rule, policyConditionsHold(rule.condition, args.input)]));
	const applies = (rule: EntityApprovalPolicy) => {
		const held = holds.get(rule);
		return held === "unknown" ? grantsAccess(rule) === lenient : held === true;
	};
	const canShadow = (rule: EntityApprovalPolicy) => {
		const held = holds.get(rule);
		return held === "unknown" ? lenient : held === true;
	};
	const grants = matches.filter((rule) => rule.kind === "grant" && applies(rule));
	const orgRules = grants.filter((rule) => rule.principalKind === null);
	const shadowing = matches.filter(
		(rule) => rule.kind === "grant" && rule.principalKind === null && canShadow(rule),
	);
	const decisive = orgRules.filter((rule) => !shadowing.some((other) => moreSpecific(other, rule)));
	// With no matching rule the action runs: holds come from rules, never from silence.
	let effect: ConnectorPolicyResult["effect"] = "auto";
	const restrictions = grants.filter(
		(rule) => rule.principalKind !== null && principalMatches(rule, args.actor),
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
		(rule) => rule.kind !== "grant" && applies(rule) && principalMatches(rule, args.actor),
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
			...(rule.condition ? { when: rule.condition } : {}),
		})),
		reason: ordered.some((rule) => rule.kind !== "grant")
			? "guardrail"
			: ordered.length
				? "matched_rule"
				: "default_auto",
	};
}

/**
 * Whether reading the destination's audience could change this decision. The
 * narrowest and the widest audience bound every other result, so when both
 * decide alike the connector need not be asked.
 */
export function destinationAudienceMatters(
	args: Omit<Parameters<typeof evaluateConnectorPolicy>[0], "destinationAudience">,
): boolean {
	const narrow = evaluateConnectorPolicy({ ...args, destinationAudience: "private" });
	const wide = evaluateConnectorPolicy({ ...args, destinationAudience: "unknown" });
	return narrow.effect !== wide.effect || narrow.reason !== wide.reason ||
		narrow.ruleIds.join() !== wide.ruleIds.join();
}
