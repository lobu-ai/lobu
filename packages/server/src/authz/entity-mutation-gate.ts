/**
 * Entity-mutation gate — a pluggable interceptor pipeline that sits in front of
 * every user-facing entity write (create/update/delete + automation promotion).
 *
 * Core mutation code (manage_entity, entity-management.updateEntity,
 * promote-keyed-entities, complete-window) is POLICY-BLIND: it builds one
 * `EntityMutationRequest`, calls `runMutationGate`, and acts on the decision. It
 * never imports the approval ACL or any specific policy module. New cross-cutting
 * gates (quota, rate limits, …) are added as ONE new interceptor file whose
 * exported interceptor is appended to `BUILTIN_INTERCEPTORS` below — with zero
 * edits to core mutation code.
 *
 * Chaining semantics (deterministic, order = registration order):
 *  - create/delete: the first `deny` wins; the first `defer` short-circuits (its
 *    `DeferredMutation` is returned); otherwise `allow`.
 *  - update: any `deny` on a field wins immediately; otherwise the per-field
 *    `requireApproval` sets are UNION-ed across all interceptors (empty ⇒ allow).
 *
 * A `defer` never writes on the caller's transaction. The interceptor hands back
 * a `DeferredMutation` whose `queue()` closure the CORE runs strictly POST-COMMIT
 * (repo invariant: approvals + their events never ride the caller's tx).
 *
 * Import-cycle note: the static edge chain is gate → approval-interceptor →
 * entity-field-approval → entity-management → gate (circular). This is safe
 * because every cross-module use inside the cycle happens at CALL time, never at
 * module-init, and this module's public API is hoisted `function` declarations —
 * so the circular partial-module view entity-management receives is complete.
 * By the time this module's own body initializes `BUILTIN_INTERCEPTORS`, the
 * interceptor module has fully evaluated (it is this module's dependency). Keep
 * the exports below as `function` declarations (not const arrows) so the
 * hoisting guarantee holds. The interceptor import MUST stay static: the
 * production esbuild bundle (docker/app → dist/server.bundle.mjs) cannot follow
 * a variable-specifier dynamic import and would ship a gate with no
 * interceptors.
 *
 * Multi-replica safety: the registry is code-defined and identical on every pod
 * (no shared mutable state affecting decisions).
 */

import type { ApprovalAttribution } from "@lobu/core/contracts/interaction-envelope";
import type { DbClient } from "../db/client";
import type { Env } from "../index";
import type { ToolContext } from "../tools/registry";
import type { EntityData } from "../utils/entity-management";
import {
	approvalInterceptor,
	buildCreateDeferral,
	buildFieldChangeDeferral,
} from "./approval-interceptor";

export type MutationPrincipalKind = "user" | "agent" | "automation";

/** Attribution for a deferred (queued-for-approval) mutation. */
export type MutationAttribution = ApprovalAttribution;

/** Field ownership as seen by an update request ("human" pins the value). */
export type FieldOwner = "human" | "none";

interface EntityMutationBase {
	organizationId: string;
	principalKind: MutationPrincipalKind;
	/** Caller's DbClient or open transaction — interceptors query policy on it. */
	sql: DbClient;
	/** Attribution + automation id used by an interceptor to label a deferral. */
	attribution: MutationAttribution;
	automationId?: number | null;
	/**
	 * Stable identity of the acting non-human principal, for per-principal policy
	 * matching (a policy row may target one agent or automation). Agent → agent id;
	 * automation → `automation:<id>`; system/automation token (no agent id) → null.
	 * Null means "any principal of this kind". Plumbed here now; consumed by the
	 * per-principal resolver in a later commit.
	 */
	principalId?: string | null;
	/**
	 * The OWNING AGENT of an automation, when the acting principal is an automation. The
	 * write is then governed by BOTH the automation's own rows AND its agent's,
	 * folded max-restrictive — so an agent's envelope binds its automation, while a
	 * pre-existing automation-specific restriction can only tighten (the agent
	 * envelope never loosens it away). Null when not an automation, or an automation with
	 * no agent. `automations.managed_agent_id` is the sole principal-ownership edge, so this
	 * is the only ancestor a write ever folds.
	 */
	ownerAgentId?: string | null;
	/**
	 * False iff the acting principal is an automation whose owning agent could not be
	 * resolved (its row is gone). Threaded to the gate so it FAILS CLOSED (deny)
	 * rather than run the write as an unowned automation against the looser org default.
	 * Defaults true (agent/user writes, and automations whose owner resolved).
	 */
	ownerResolved?: boolean;
	/** Causal run whose mutation may create a child approval run. */
	parentRunId?: number | null;
}

export interface CreateMutationRequest extends EntityMutationBase {
	action: "create";
	entityTypeSlug: string;
	entityData: EntityData;
	/** Snapshot payload shown on the approval card. */
	proposal: Record<string, unknown>;
}

export interface DeleteMutationRequest extends EntityMutationBase {
	action: "delete";
	entityTypeSlug: string;
	entityId: number;
	entityOrgId: string | null;
	forceDeleteTree?: boolean;
	/** Snapshot of the entity being deleted, for the approval card. */
	current: Record<string, unknown>;
}

export interface UpdateMutationRequest extends EntityMutationBase {
	action: "update";
	entityTypeSlug: string;
	entityId: number;
	entityOrgId?: string | null;
	/** field path (incl. reserved $-attributes) -> current owner. */
	fields: Record<string, FieldOwner>;
}

export type RelationshipMutationRequest = EntityMutationBase & {
	entityTypeSlug: string;
	entityId: number;
	entityOrgId: string;
} & ({ action: "link" } | { action: "unlink" });

export type RelationshipMutationDecision = { outcome: "allow" | "review" } | { outcome: "deny"; reason: string };

export type EntityMutationRequest =
	| RelationshipMutationRequest
	| CreateMutationRequest
	| DeleteMutationRequest
	| UpdateMutationRequest;

/**
 * A mutation an interceptor held back. `queue()` is called POST-COMMIT by the
 * core to durably record the approval (run + event + notification) and returns
 * the ids/url the call site folds into its "approval queued" result. `display`
 * carries whatever the call site needs to assemble that result without knowing
 * how the approval was built.
 */
export interface DeferredMutation {
	queue: (
		ctx: ToolContext,
		env: Env,
	) => Promise<{ runId: number; eventId: number; approvalUrl?: string }>;
	display: {
		action: "create" | "update" | "delete";
		attribution: MutationAttribution;
		proposal?: Record<string, unknown>;
		current?: Record<string, unknown>;
		fields?: Record<string, unknown>;
	};
}

export type CreateOrDeleteDecision =
	| { outcome: "allow" }
	| { outcome: "deny"; reason: string }
	| { outcome: "defer"; deferred: DeferredMutation };

export type UpdateDecision =
	| { outcome: "deny"; reason: string }
	| { outcome: "fields"; requireApproval: Set<string> };

/**
 * One cross-cutting gate. An interceptor inspects a request and returns either a
 * create/delete decision or an update decision, matching the request action.
 * Returning `null` means "no opinion" (pass-through).
 */
export interface MutationInterceptor {
	name: string;
	evaluate: (
		req: EntityMutationRequest,
	) => Promise<CreateOrDeleteDecision | UpdateDecision | RelationshipMutationDecision | null>;
}

/**
 * Interceptors every deployment runs, in order. Statically imported so the
 * production bundle includes them (see the import-cycle note above).
 */
const BUILTIN_INTERCEPTORS: readonly MutationInterceptor[] = [
	approvalInterceptor,
];

const registry: MutationInterceptor[] = [...BUILTIN_INTERCEPTORS];

/** Append an interceptor after the builtins. Idempotent by name. */
export function registerMutationInterceptor(
	interceptor: MutationInterceptor,
): void {
	if (registry.some((i) => i.name === interceptor.name)) return;
	registry.push(interceptor);
}

/**
 * Package a blocked field-change discovered LATE (after the row lock + merge,
 * when the blocked values are finally known) as a POST-COMMIT deferred mutation.
 * Thin wrapper so core mutation code imports only the gate, never the ACL.
 */
export function deferEntityFieldChange(args: {
	entityId: number;
	fields: Record<string, unknown>;
	current: Record<string, unknown>;
	attribution: MutationAttribution;
	/** Replaces the generated reason line — see `buildFieldChangeDeferral`. */
	reason?: string;
	/** Fields the rule escalated — what the approver is consenting to. */
	escalatedFields?: string[];
	automationId?: number | null;
	parentRunId?: number | null;
}): DeferredMutation {
	return buildFieldChangeDeferral(args);
}

/** Package a policy-held create as a POST-COMMIT deferred mutation. */
export function deferEntityCreate(args: {
	entityData: EntityData;
	proposal: Record<string, unknown>;
	attribution: MutationAttribution;
	/** Replaces the generated reason line — see `buildCreateDeferral`. */
	reason?: string;
	/** Fields the rule escalated — what the approver is consenting to. */
	escalatedFields?: string[];
	automationId?: number | null;
	parentRunId?: number | null;
}): DeferredMutation {
	return buildCreateDeferral(args);
}

function isUpdateDecision(
	d: CreateOrDeleteDecision | UpdateDecision | RelationshipMutationDecision,
): d is UpdateDecision {
	return d.outcome === "deny" || d.outcome === "fields";
}

/**
 * Run every registered interceptor against `req` and fold the results per the
 * chaining semantics documented at the top of this file.
 */
export async function runMutationGate(req: RelationshipMutationRequest): Promise<RelationshipMutationDecision>;
export async function runMutationGate(
	req: CreateMutationRequest | DeleteMutationRequest,
): Promise<CreateOrDeleteDecision>;
export async function runMutationGate(
	req: UpdateMutationRequest,
): Promise<UpdateDecision>;
export async function runMutationGate(
	req: EntityMutationRequest,
): Promise<CreateOrDeleteDecision | UpdateDecision | RelationshipMutationDecision> {
	if (req.action === "link" || req.action === "unlink") {
		let review = false;
		for (const interceptor of registry) {
			const decision = await interceptor.evaluate(req);
			if (decision?.outcome === "deny") return decision;
			if (decision && decision.outcome !== "allow") review = true;
		}
		return { outcome: review ? "review" : "allow" };
	}
	if (req.action === "update") {
		const requireApproval = new Set<string>();
		for (const interceptor of registry) {
			const decision = await interceptor.evaluate(req);
			if (!decision) continue;
			if (decision.outcome === "deny") return decision;
			if (isUpdateDecision(decision)) {
				for (const field of decision.requireApproval) requireApproval.add(field);
			}
		}
		return { outcome: "fields", requireApproval };
	}

	for (const interceptor of registry) {
		const decision = await interceptor.evaluate(req);
		if (!decision) continue;
		if (decision.outcome === "deny") return decision;
		if (decision.outcome === "defer") return decision;
	}
	return { outcome: "allow" };
}

/** Test-only: drop any test-registered interceptors, keeping the builtins. */
export function __resetMutationGateForTests(): void {
	registry.length = 0;
	registry.push(...BUILTIN_INTERCEPTORS);
}
