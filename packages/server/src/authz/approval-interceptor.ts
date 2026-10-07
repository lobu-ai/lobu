/**
 * Approval interceptor — the ACL plugin for the entity mutation gate.
 *
 * This is the ONLY module that knows the approval-policy layer exists: it wraps
 * the `entity-policy` decisions and builds durable approval proposals via
 * `entity-field-approval`. It exports plain values (`approvalInterceptor` + the
 * two deferral builders); the gate statically imports them into its builtin
 * registry, so the interceptor ships in every execution path — server, worker,
 * tests, and the production esbuild bundle alike.
 *
 * It imports the gate ONLY for types (erased at compile time), so there is no
 * runtime edge back into the gate at module init — the runtime cycle
 * (gate → this → entity-field-approval → entity-management → gate) touches the
 * gate's hoisted function exports at call time only.
 *
 * Adding a second cross-cutting gate (quota, rate limit, …) is a NEW sibling
 * file exporting its own `MutationInterceptor`, appended to the gate's
 * `BUILTIN_INTERCEPTORS` — core mutation code never changes.
 */

import {
	proposeEntityCreate,
	proposeEntityDelete,
	proposeEntityFieldChange,
} from "../tools/admin/entity-field-approval";
import type { EntityData } from "../utils/entity-management";
import type {
	DeferredMutation,
	EntityMutationRequest,
	MutationAttribution,
	MutationInterceptor,
	UpdateDecision,
} from "./entity-mutation-gate";
import {
	evaluateEntityFieldUpdates,
	evaluateEntityMutation,
} from "./entity-policy";

function reasonFor(
	attribution: MutationAttribution,
	verb: "creating" | "deleting",
	entityTypeSlug: string,
	name: string | undefined,
): string {
	const actor = attribution === "automation" ? "An Automation" : "An agent";
	const label = name ? `${entityTypeSlug} "${name}"` : entityTypeSlug;
	return `${actor} proposes ${verb} ${label}.`;
}

function fieldChangeReason(
	attribution: MutationAttribution,
	fields: string[],
): string {
	const actor = attribution === "automation" ? "An Automation" : "An agent";
	return `${actor} proposes updating ${fields.join(", ")} on this entity.`;
}

export function buildCreateDeferral(args: {
	entityData: EntityData;
	proposal: Record<string, unknown>;
	attribution: MutationAttribution;
	/**
	 * Overrides the generated "an agent proposes creating x" line. Set when a
	 * WRITE RULE caused the hold, so the approver reads the rule's own words
	 * instead of a sentence that does not say why this create needs a human.
	 */
	reason?: string;
	/** Fields the rule escalated — what the approver is consenting to. */
	escalatedFields?: string[];
	automationId?: number | null;
	parentRunId?: number | null;
}): DeferredMutation {
	const name =
		typeof args.entityData.name === "string" ? args.entityData.name : undefined;
	return {
		display: {
			action: "create",
			attribution: args.attribution,
			proposal: args.proposal,
		},
		queue: (ctx) =>
			proposeEntityCreate(ctx, {
				entity_data: args.entityData,
				proposal: args.proposal,
				escalated_fields: args.escalatedFields,
				automation_id: args.automationId ?? null,
				attribution: args.attribution,
				reason:
					args.reason ??
					reasonFor(
						args.attribution,
						"creating",
						args.entityData.entity_type,
						name,
					),
			}, args.parentRunId ?? null),
	};
}

export function buildFieldChangeDeferral(args: {
	entityId: number;
	fields: Record<string, unknown>;
	current: Record<string, unknown>;
	attribution: MutationAttribution;
	/**
	 * Overrides the generated "agent wants to change x, y" line. Set when a
	 * WRITE RULE caused the hold, so the approver reads the rule's own words
	 * instead of a field list that does not explain itself.
	 */
	reason?: string;
	/** Fields the rule escalated — what the approver is consenting to. */
	escalatedFields?: string[];
	automationId?: number | null;
	parentRunId?: number | null;
}): DeferredMutation {
	return {
		display: {
			action: "update",
			attribution: args.attribution,
			fields: args.fields,
			current: args.current,
		},
		queue: (ctx) =>
			proposeEntityFieldChange(ctx, {
				entity_id: args.entityId,
				fields: args.fields,
				current: args.current,
				escalated_fields: args.escalatedFields,
				automation_id: args.automationId ?? null,
				attribution: args.attribution,
				reason:
					args.reason ??
					fieldChangeReason(args.attribution, Object.keys(args.fields)),
			}, args.parentRunId ?? null),
	};
}

async function evaluate(
	req: EntityMutationRequest,
): Promise<
	| { outcome: "allow" | "review" }
	| { outcome: "deny"; reason: string }
	| { outcome: "defer"; deferred: DeferredMutation }
	| UpdateDecision
	| null
> {
	// An automation acting under its owning agent folds the AGENT'S rows in too, so
	// the agent envelope binds while a pre-existing automation-specific restriction
	// can only tighten (the agent envelope never loosens it away).
	const ownerAgentId = req.ownerAgentId ?? null;
	// An automation whose owning agent couldn't be resolved fails closed downstream.
	const ownerResolved = req.ownerResolved ?? true;

	if (req.action === "link" || req.action === "unlink") {
		// Association changes are whole-record updates under the existing envelope.
		// They have no field patch and cannot inherit a synthetic field's approval.
		const decision = await evaluateEntityMutation({ ...req, action: "update" });
		return decision === "deny" ? { outcome: "deny", reason: "Policy denied identity association" }
			: { outcome: decision === "require_approval" ? "review" : "allow" };
	}

	if (req.action === "update") {
		const decisions = await evaluateEntityFieldUpdates({
			organizationId: req.organizationId,
			principalKind: req.principalKind,
			principalId: req.principalId ?? null,
			ownerAgentId,
			ownerResolved,
			entityTypeSlug: req.entityTypeSlug,
			entityId: req.entityId,
			entityOrgId: req.entityOrgId ?? null,
			fields: req.fields,
			sql: req.sql,
		});
		const requireApproval = new Set<string>();
		for (const [field, decision] of Object.entries(decisions)) {
			if (decision === "deny") {
				return {
					outcome: "deny",
					reason: `Policy denied update to field '${field}'`,
				};
			}
			if (decision === "require_approval") requireApproval.add(field);
		}
		return { outcome: "fields", requireApproval };
	}

	const decision = await evaluateEntityMutation({
		organizationId: req.organizationId,
		principalKind: req.principalKind,
		principalId: req.principalId ?? null,
		ownerAgentId,
		ownerResolved,
		action: req.action,
		entityTypeSlug: req.entityTypeSlug,
		entityId: req.action === "delete" ? req.entityId : undefined,
		entityOrgId: req.action === "delete" ? req.entityOrgId : undefined,
		sql: req.sql,
	});

	if (decision === "deny") {
		return {
			outcome: "deny",
			reason:
				req.action === "create"
					? `Policy denied creating ${req.entityTypeSlug}`
					: `Policy denied deleting entity ${req.entityId}`,
		};
	}
	if (decision === "allow") return { outcome: "allow" };

	// require_approval → defer with a POST-COMMIT queue() closure.
	if (req.action === "create") {
		return {
			outcome: "defer",
			deferred: buildCreateDeferral({
				entityData: req.entityData,
				proposal: req.proposal,
				attribution: req.attribution,
				automationId: req.automationId,
				parentRunId: req.parentRunId,
			}),
		};
	}
	const name =
		typeof req.current.name === "string" ? req.current.name : undefined;
	return {
		outcome: "defer",
		deferred: {
			display: {
				action: "delete",
				attribution: req.attribution,
				current: req.current,
				proposal: {
					entity_id: req.entityId,
					entity_type: req.entityTypeSlug,
					name,
					force_delete_tree: req.forceDeleteTree ?? false,
				},
			},
			queue: (ctx) =>
				proposeEntityDelete(ctx, {
					entity_id: req.entityId,
					force_delete_tree: req.forceDeleteTree ?? false,
					current: req.current as {
						id: number;
						entity_type: string;
						name: string;
						slug?: string | null;
						parent_id?: number | null;
						metadata?: Record<string, unknown> | null;
					},
					automation_id: req.automationId ?? null,
					attribution: req.attribution,
					reason: reasonFor(
						req.attribution,
						"deleting",
						req.entityTypeSlug,
						name,
					),
				}, req.parentRunId ?? null),
		},
	};
}

/** The ACL plugin the gate registers as a builtin. */
export const approvalInterceptor: MutationInterceptor = {
	name: "approval",
	evaluate,
};
