/**
 * Tool: manage_entity
 *
 * Entity management - create, update, list, get, delete.
 * Also manages entity relationships (graph edges between entities).
 *
 * Actions:
 * - create: Create new entity
 * - update: Update existing entity
 * - list: List entities with filtering
 * - get: Get details for specific entity
 * - delete: Delete entity (with optional force for cascading deletes)
 * - link: Create a relationship between two entities
 * - unlink: Soft-delete a relationship
 * - update_link: Update metadata/confidence/source on a relationship
 * - list_links: List relationships for an entity with filters
 * - merge: Fold confirmed duplicates into one canonical entity
 * - resolve_duplicates: Apply an entity type's configured resolution policy
 * - unmerge: Reverse a ledger-backed merge when its after-state is unchanged
 */

import { deriveToolActorSource } from '../../utils/apply-context';
import { randomUUID } from "node:crypto";

import {
	ApprovalAttribution,
	type ApprovalAttribution as ApprovalAttributionType,
} from "@lobu/core/contracts/interaction-envelope";
import {
	CreateEntityAction,
	DeleteEntityAction,
	GetEntityAction,
	LinkEntitiesAction,
	ListEntitiesAction,
	ListLinksAction,
	type ManageEntityResult,
	ManageEntityResultSchema,
	ManageEntitySchema,
	MergeEntitiesAction,
	type RelationshipCountByType,
	type RelationshipRow,
	ResolveDuplicatesAction,
	UnlinkEntitiesAction,
	UnmergeEntityAction,
	UpdateEntityAction,
	UpdateLinkAction,
} from "@lobu/core/contracts/tools/manage-entity";
import type { Static } from "@sinclair/typebox";
import {
	deferEntityCreate,
	runMutationGate,
} from "../../authz/entity-mutation-gate";
import {
	EntityRowValidationError,
	RESERVED_COLUMN_NAMES,
} from "../../authz/entity-row-validation";
import {
	type ActingPrincipal,
	evaluateEntityMutation,
	resolveActingPrincipal,
} from "../../authz/entity-policy";
import { resolveAutomationAttribution } from "../../automations/automation-source";
import {
	type DbClient,
	getDb,
	pgBigintArray,
	pgTextArray,
} from "../../db/client";
import { discoverWorkspaceResolutionGroups } from "../../entity-resolution/discovery";
import { loadLiveEntityIdentities } from "../../entity-resolution/identities";
import {
	assessEntityResolution,
	RESOLUTION_FINGERPRINT_VERSION,
} from "../../entity-resolution/policy";
import { wasResolutionRejected } from "../../entity-resolution/rejection";
import type { Env } from "../../index";
import {
	batchLoadRelationships,
	createEntity,
	deleteEntity,
	type EntityData,
	getEntity,
	listEntities,
	type RelationshipColumnSpec,
	updateEntity,
} from "../../utils/entity-management";
import {
	applyMergeGroup,
	applyUnmerge,
	previewMerge,
} from "../../utils/entity-merge";
import { ToolUserError } from "../../utils/errors";
import {
	EntityPolicyDenialError,
	type EntityWriteDenialDescription,
	recordEntityWriteDenial,
} from "../../utils/entity-write-denial-audit";
import {
	insertChangeEventInTransaction,
	insertEdgeChangeEventInTransaction,
	stableJson,
} from "../../utils/insert-event";
import { resolveMemberSchemaFieldsFromSchema } from "../../utils/member-entity-type";
import {
	ACL_MANAGED_TYPE_SQL,
	assertNotAclManagedEdge,
	canonicalizeSymmetricEdge,
	validateConfidence,
	validateNoSelfReference,
	validateReconciledEdgeUpdate,
	validateScopeRule,
	validateSource,
	validateTypeRule,
} from "../../utils/relationship-validation";
import {
	assertManualRelationshipClaim,
	assertManualRelationshipMutationAllowed,
	assertNoReservedRelationshipMetadata,
	RELATIONSHIP_CLAIMS_METADATA_KEY,
	relationshipMetadataWithoutClaims,
	retractManualRelationshipClaim,
} from "../../utils/relationship-claims";
import {
	exceedsValidationLimits,
	isEmptyObject,
} from "../../utils/metadata-limits";
import { validateEntityMetadata } from "../../utils/schema-validation";
import { buildEntityUrl } from "../../utils/url-builder";
import { trackAutomationReaction } from "../../utils/automation-reactions";
import { isAdminOrOwnerRole } from "../access-control";
import { MEMBER_ENTITY_TYPE_SLUG } from "../constants";
import type { ToolContext } from "../registry";
import {
	buildEntityViewUrl,
	getOrgUrlContext,
	toEntityInfo,
} from "../view-urls";
import { action, defineActionTool } from "./action-tool";
import { proposeEntityDelete, proposeEntityMerge } from "./entity-field-approval";

export { ManageEntityResultSchema, ManageEntitySchema };

function toIsoStringOrNow(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The acting principal for an entity mutation, resolved through the shared seam
 * ({@link resolveActingPrincipal}): merges the explicit `automation_source` and the
 * reaction session's own automation, looks up the owning agent, and pins autonomous
 * mode for an automation — so a reaction can't dodge its agent's envelope by omitting
 * automation_source.
 */
function actingPrincipalFor(
	args: Attributed | undefined,
	ctx: ToolContext,
): Promise<ActingPrincipal> {
	return resolveActingPrincipal(getDb(), {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		explicitAutomationId: args?.automation_source?.automation_id ?? null,
		sessionAutomationId: ctx.actingAutomationId ?? null,
	});
}

function attributionFor(actor: ActingPrincipal): ApprovalAttributionType {
	return actor.kind === "automation"
		? ApprovalAttribution.Automation
		: ApprovalAttribution.Agent;
}

/** A write-rule refusal, in the shape the denial audit records. */
function ruleDenialFrom(error: unknown): EntityWriteDenialDescription | null {
	if (
		!(error instanceof EntityRowValidationError) ||
		error.verdict.outcome !== "deny"
	) {
		return null;
	}
	return {
		denialSource: "rule",
		operation: error.verdict.operation,
		reason: error.verdict.reason,
		deniedFields: error.verdict.fields,
		entityId: error.verdict.entityId,
		entityType: error.verdict.entityType,
		entityOrganizationId: error.verdict.entityOrganizationId,
	};
}

function recordToolDenial(params: {
	ctx: ToolContext;
	attemptId: string;
	actor: ActingPrincipal;
	automationId: number | null;
	denial: EntityWriteDenialDescription;
}): Promise<void> {
	return recordEntityWriteDenial({
		...params.denial,
		organizationId: params.ctx.organizationId,
		ctx: params.ctx,
		attemptId: params.attemptId,
		actor: params.actor,
		automationId: params.automationId,
	});
}

/**
 * Entity read gate for agents/automations. Humans skip (role ACL is separate).
 * Default is auto (unrestricted within org); a policy can deny by type.
 */
async function assertEntityReadAllowed(
	args: Attributed | undefined,
	ctx: ToolContext,
	entityTypeSlug: string | null | undefined,
): Promise<void> {
	const actor = await actingPrincipalFor(args, ctx);
	if (actor.kind === "user") return;
	const decision = await evaluateEntityMutation({
		organizationId: ctx.organizationId,
		principalKind: actor.kind,
		principalId: actor.id,
		ownerAgentId: actor.ownerAgentId,
		ownerResolved: actor.ownerResolved,
		action: "read",
		entityTypeSlug: entityTypeSlug ?? null,
		sql: getDb(),
	});
	if (decision === "deny") {
		const label = entityTypeSlug?.trim() || "this entity type";
		throw new ToolUserError(
			`Policy denies reading entities of type '${label}' for this principal.`,
			403,
		);
	}
}

// ============================================
// Main Function (Action Router)
// ============================================

/** The one field the principal seam reads off any variant that carries it. */
type Attributed = Pick<Static<typeof CreateEntityAction>, "automation_source">;

/** How `unlink`/`update_link` address an edge: by id, by endpoint triple, or both. */
type EdgeAddress = Pick<
	Static<typeof UnlinkEntitiesAction>,
	"relationship_id" | "from_entity_id" | "to_entity_id" | "relationship_type_slug"
>;

/**
 * The mutations a reaction record is kept for, and the fields that record
 * carries. Everything but `action` is optional because no single tracked
 * variant declares all of them: `create` has no `entity_id`, `update` and
 * `link` have no `entity_type`, and `link` has no `name`.
 */
interface TrackedMutationArgs extends Attributed {
	action: "create" | "update" | "link";
	entity_id?: number;
	entity_type?: string;
	name?: string;
}

type Handler<A> = (
	args: A,
	ctx: ToolContext,
	env: Env,
) => Promise<ManageEntityResult>;

// Variants in the contract's order, so the derived union matches the exposed
// `ManageEntitySchema`. Each handler receives its own variant's args; the
// per-action access tiers are enforced by `routeAction` before dispatch.
const manageEntityTool = defineActionTool("manage_entity", {
	create: action(
		CreateEntityAction,
		trackedMutation((args, ctx, env) => handleCreate(args, env, ctx)),
	),
	update: action(
		UpdateEntityAction,
		trackedMutation((args, ctx, env) => handleUpdate(args, env, ctx)),
	),
	list: action(ListEntitiesAction, (args, ctx, env) =>
		handleList(args, env, ctx),
	),
	get: action(GetEntityAction, (args, ctx, env) =>
		handleGet(args.entity_id, env, ctx, args.include_deleted ?? false),
	),
	delete: action(DeleteEntityAction, (args, ctx, env) =>
		handleDelete(args, env, ctx),
	),
	link: action(
		LinkEntitiesAction,
		trackedMutation((args, ctx, env) => handleLink(args, env, ctx)),
	),
	unlink: action(UnlinkEntitiesAction, handleUnlink),
	update_link: action(UpdateLinkAction, handleUpdateLink),
	list_links: action(ListLinksAction, handleListLinks),
	merge: action(MergeEntitiesAction, handleMerge),
	resolve_duplicates: action(ResolveDuplicatesAction, handleResolveDuplicates),
	unmerge: action(UnmergeEntityAction, handleUnmerge),
});

export const manageEntity = manageEntityTool.run;

/**
 * Record an Automation reaction for a mutating action once its handler
 * returns. Reaction tracking took the declared source verbatim — no session
 * precedence, no ownership check — so an unowned id credited another
 * Automation's feedback record. Still gated on the caller HAVING declared a
 * source: resolving one for every reaction session would start tracking
 * mutations that were never tracked before, which is a product change, not
 * this fix.
 */
function trackedMutation<A extends TrackedMutationArgs>(
	handler: Handler<A>,
): Handler<A> {
	return async (args, ctx, env) => {
		const result = await handler(args, ctx, env);
		await trackEntityReaction(args, result, ctx);
		return result;
	};
}

async function trackEntityReaction(
	args: TrackedMutationArgs,
	result: ManageEntityResult,
	ctx: ToolContext,
): Promise<void> {
	const reactionAttribution = args.automation_source
		? await resolveAutomationAttribution(ctx, args.automation_source)
		: null;
	// A reaction record is keyed by the producing run.
	if (
		reactionAttribution?.automationId == null ||
		reactionAttribution.runId == null ||
		!("action" in result)
	) {
		return;
	}
	const reactionType =
		result.action === "create"
			? "entity_created"
			: result.action === "update"
				? "entity_updated"
				: result.action === "link"
					? "entity_linked"
					: null;
	if (!reactionType) return;
	const entityId =
		result.action === "create" && "entity" in result
			? result.entity?.id
			: args.entity_id;
	await trackAutomationReaction({
		organizationId: ctx.organizationId,
		automationId: reactionAttribution.automationId,
		sourceRunId: reactionAttribution.runId,
		reactionType,
		toolName: "manage_entity",
		toolArgs: {
			action: args.action,
			entity_type: args.entity_type,
			name: args.name,
			entity_id: args.entity_id,
		},
		toolResult: result as Record<string, unknown>,
		entityId,
	});
}

// ============================================
// Action Handlers
// ============================================

async function handleCreate(
	args: Static<typeof CreateEntityAction>,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	// (Derived-type rejection lives in createEntity — the single chokepoint that
	// also resolves public-catalog types.)

	// Validate metadata against entity type's JSON schema (if defined)
	if (args.metadata && !isEmptyObject(args.metadata)) {
		const validation = await validateEntityMetadata(
			args.entity_type,
			args.metadata,
			ctx,
		);
		if (!validation.valid) {
			const errorMessages =
				validation.errors?.map((e) => e.message).join("; ") ??
				"Invalid metadata";
			throw new ToolUserError(`Metadata validation failed: ${errorMessages}`, 400);
		}
	}

	// Build entity data with organization_id from context
	const entityData: EntityData = {
		entity_type: args.entity_type,
		name: args.name,
		slug: args.slug,
		parent_id: args.parent_id ?? null,
		metadata: args.metadata ?? {},
		enabled_classifiers: args.enabled_classifiers ?? null,
		organization_id: ctx.organizationId,
	};
	(entityData as any).created_by = ctx.userId ?? "system";

	// All fields available on all entity types - DB constraints handle validation
	entityData.domain = args.domain ?? null;
	entityData.category = args.category ?? null;
	entityData.platform_type = args.platform_type ?? null;
	entityData.main_market = args.main_market ?? null;
	entityData.market = args.market ?? null;
	entityData.link = args.link ?? null;

	// Content body (used by memory entities)
	if (args.content !== undefined) {
		entityData.content = args.content;
	}

	const proposal = {
		entity_type: entityData.entity_type,
		name: entityData.name,
		parent_id: entityData.parent_id ?? null,
		metadata: entityData.metadata ?? {},
	};
	const actor = await actingPrincipalFor(args, ctx);
	const denialAttemptId = randomUUID();
	// Resolved once for the create path: the gate, the deferral, and the audit
	// row it produces must all name the SAME Automation, or an approval card and
	// its provenance disagree about who proposed the row.
	const createAttribution = await resolveAutomationAttribution(
		ctx,
		args.automation_source
	);
	const attribution = attributionFor(actor);
	const createDecision = await runMutationGate({
		action: "create",
		organizationId: ctx.organizationId,
		principalKind: actor.kind,
		sql: getDb(),
		attribution,
		automationId: createAttribution.automationId,
		parentRunId: createAttribution.runId,
		principalId: actor.id,
		ownerAgentId: actor.ownerAgentId,
		ownerResolved: actor.ownerResolved,
		entityTypeSlug: args.entity_type,
		entityData,
		proposal,
	});
	if (createDecision.outcome === "deny") {
		await recordEntityWriteDenial({
			organizationId: ctx.organizationId,
			ctx,
			attemptId: denialAttemptId,
			denialSource: "policy",
			operation: "create",
			reason: createDecision.reason,
			deniedFields: [],
			entityId: null,
			entityType: args.entity_type,
			entityOrganizationId: null,
			actor,
			automationId: createAttribution.automationId,
		});
		throw new ToolUserError(createDecision.reason, 403);
	}
	if (createDecision.outcome === "defer") {
		const res = await createDecision.deferred.queue(ctx, env);
		return {
			action: "create",
			approval_queued: true,
			approval_url: res.approvalUrl,
			approval_run_id: res.runId,
			approval_action: "create",
			approval_proposal: proposal,
			approval_current: {},
			approval_attribution: attribution,
			next_steps: [
				`${capitalize(args.entity_type)} "${args.name}" is waiting for approval before it is created.`,
			],
		} as unknown as ManageEntityResult;
	}

	// A write rule can also hold a create, and it can only say so from INSIDE the
	// insert transaction — the gate above judges the principal, the rule judges
	// the row. An escalate aborts that transaction, so nothing was created and
	// the whole proposal becomes the card, exactly like the policy-held path
	// above. A `deny` is not caught: the caller proposed an illegal row.
	let entity: Awaited<ReturnType<typeof createEntity>>;
	try {
		entity = await createEntity(entityData, {
			hookContext: {
				organizationId: ctx.organizationId,
				userId: ctx.userId,
				scopes: ctx.scopes,
				actorSource: deriveToolActorSource(ctx),
				env,
			},
		});
	} catch (err) {
		const denial = ruleDenialFrom(err);
		if (denial) {
			// createEntity owned and rolled back its transaction before this catch.
			await recordToolDenial({
				ctx,
				attemptId: denialAttemptId,
				actor,
				automationId: createAttribution.automationId,
				denial,
			});
			throw err;
		}
		if (
			!(err instanceof EntityRowValidationError) ||
			err.verdict.outcome !== "escalate"
		) {
			throw err;
		}
		const res = await deferEntityCreate({
			entityData,
			proposal,
			attribution,
			// The rule's own words, not "an agent proposes creating x" — the
			// approver needs to know WHY this row needs a human.
			reason: err.verdict.reason,
			// Exactly what the approver consents to; a later, different escalation
			// still needs its own card.
			escalatedFields: err.verdict.fields,
			automationId: createAttribution.automationId,
			parentRunId: createAttribution.runId,
		}).queue(ctx, env);
		return {
			action: "create",
			approval_queued: true,
			approval_url: res.approvalUrl,
			approval_run_id: res.runId,
			approval_action: "create",
			approval_proposal: proposal,
			approval_current: {},
			approval_attribution: attribution,
			next_steps: [
				`${capitalize(args.entity_type)} "${args.name}" needs approval before it is created: ${err.verdict.reason}`,
			],
		} as unknown as ManageEntityResult;
	}

	const entityTypeLabel = capitalize(entity.entity_type);

	// Build next steps
	const nextSteps: string[] = [
		`${entityTypeLabel} "${entity.name}" created successfully with ID ${entity.id}.`,
	];

	if (!entity.parent_id) {
		// Root entity (no parent)
		nextSteps.push(
			`Use client.connections.connect({ connector_key: '<connector_key>' }), client.feeds.create({ connection_id: <connection_id>, feed_key: '<feed_key>', entity_ids: [${entity.id}], config: {} }) to target this entity, then client.feeds.trigger({ feed_id: <feed_id> }) to collect now.`,
			`Use client.automations.create({ entity_id: ${entity.id}, slug: '<slug>', managed_agent_id: '<managed_agent_id>', prompt: '<prompt>', sources: [], triggers: [{ kind: 'schedule', cron: '<cron>', timezone: '<IANA timezone>' }] }) to schedule an Automation.`,
		);
	} else {
		// Child entity (has parent)
		nextSteps.push(
			`${entityTypeLabel} belongs to ${entity.parent_name ? `"${entity.parent_name}"` : "parent"} (ID: ${entity.parent_id}).`,
			`Use client.connections.connect({ connector_key: '<connector_key>' }), client.feeds.create({ connection_id: <connection_id>, feed_key: '<feed_key>', entity_ids: [${entity.id}], config: {} }) to target this entity, then client.feeds.trigger({ feed_id: <feed_id> }) to collect now.`,
		);
	}

	const entityDetails = (await getEntity(entity.id, env, ctx)) ?? entity;
	const createdAtIso = toIsoStringOrNow(entityDetails.created_at);
	const viewUrl = await buildEntityViewUrl(ctx, entityDetails);

	return {
		action: "create",
		entity: {
			id: entityDetails.id,
			entity_type: entityDetails.entity_type,
			name: entityDetails.name,
			slug: entityDetails.slug,
			parent_id: entityDetails.parent_id,
			parent_name: entityDetails.parent_name,
			parent_slug: entityDetails.parent_slug ?? null,
			metadata: entityDetails.metadata ?? {},
			enabled_classifiers: entityDetails.enabled_classifiers,
			created_at: createdAtIso,
			view_url: viewUrl,
		},
		warnings: entity.warnings,
		next_steps: nextSteps,
	};
}

async function handleUpdate(
	args: Static<typeof UpdateEntityAction>,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const entityId = args.entity_id;
  const sql = getDb();

  // Fetch before state for change tracking and validation
  const beforeRows = await sql`
    SELECT e.name, e.slug, e.parent_id, e.metadata, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${entityId} AND e.deleted_at IS NULL
  `;
	if (beforeRows.length === 0) {
		throw new ToolUserError(`Entity with ID ${entityId} not found`, 404);
	}
	const before = beforeRows[0];

	// Validate metadata against entity type's JSON schema (if being updated)
	if (args.metadata !== undefined && !isEmptyObject(args.metadata)) {
		/*
		 * Bound the WHOLE patch before filtering. `validateEntityMetadata` applies
		 * the size/nesting guard to whatever it is handed, and what it is handed
		 * below is the null-free copy — but the merge persists the original, so a
		 * patch of a hundred thousand null keys would shrink to `{}`, sail past
		 * the guard, and be written. The guard has to see what gets stored.
		 */
		if (exceedsValidationLimits(args.metadata)) {
			throw new ToolUserError(
				"Metadata validation failed: metadata exceeds size/nesting limits",
				400,
			);
		}
		/*
		 * Null is a clear sentinel, so validate a copy without cleared properties:
		 * an optional clear then reads as an absent property and passes, while a
		 * required clear fails as a missing one instead of being coerced to "".
		 * AJV mutates the copy; propagate its coercions without dropping sentinels.
		 */
		const metadataForValidation = Object.fromEntries(
			Object.entries(args.metadata).filter(([, value]) => value !== null),
		);
		const validation = await validateEntityMetadata(
			before.entity_type as string,
			metadataForValidation,
			ctx,
		);
		if (!validation.valid) {
			const errorMessages =
				validation.errors?.map((e) => e.message).join("; ") ??
				"Invalid metadata";
			throw new ToolUserError(`Metadata validation failed: ${errorMessages}`, 400);
		}
		Object.assign(args.metadata, metadataForValidation);
	}

	// Build update data (only include fields that are present)
	const updateData: Partial<EntityData> = {};

	if (args.name !== undefined) updateData.name = args.name;
	if (args.slug !== undefined) updateData.slug = args.slug;
	if (args.parent_id !== undefined) updateData.parent_id = args.parent_id;
	if (args.enabled_classifiers !== undefined)
		updateData.enabled_classifiers = args.enabled_classifiers;

	// Type-specific fields
	if (args.domain !== undefined) updateData.domain = args.domain;
	if (args.category !== undefined) updateData.category = args.category;
	if (args.platform_type !== undefined)
		updateData.platform_type = args.platform_type;
	if (args.main_market !== undefined) updateData.main_market = args.main_market;
	if (args.market !== undefined) updateData.market = args.market;
	if (args.link !== undefined) updateData.link = args.link;

	// Content body
	if (args.content !== undefined) updateData.content = args.content;

	// Metadata (replaces entire object)
	if (args.metadata !== undefined) updateData.metadata = args.metadata;

	// Human-correction note: annotates the field_controls marker for the fields
	// this edit claims (why the human set/overrode the value).
	if (args.field_note !== undefined) updateData.field_note = args.field_note;

	// Approve/affirm: claim ownership of these fields' current values as-is.
	if (args.affirm_fields !== undefined)
		updateData.affirm_fields = args.affirm_fields;

	const updateActor = await actingPrincipalFor(args, ctx);
	// Update approvals inherit the producing run as their causal parent.
	const updateAttribution = await resolveAutomationAttribution(
		ctx,
		args.automation_source
	);
	const denialAttemptId = randomUUID();
	const updatedEntity = await updateEntity(entityId, updateData, env, ctx, {
		policyPrincipalKind: updateActor.kind,
		attribution: attributionFor(updateActor),
		principalId: updateActor.id,
		parentRunId: updateAttribution.runId,
		ownerAgentId: updateActor.ownerAgentId,
		ownerResolved: updateActor.ownerResolved,
		afterPersist: async (lockedBefore, after, tx) => {
			const beforeMetadata = lockedBefore.metadata ?? {};
			const afterMetadata = after.metadata ?? {};
			const changes: Array<{ field: string; old: unknown; new: unknown }> = [];
			if (lockedBefore.name !== after.name) {
				changes.push({
					field: "name",
					old: lockedBefore.name,
					new: after.name,
				});
			}
			if (lockedBefore.slug !== after.slug) {
				changes.push({
					field: "slug",
					old: lockedBefore.slug,
					new: after.slug,
				});
			}
			if (lockedBefore.parent_id !== (after.parent_id ?? null)) {
				changes.push({
					field: "parent_id",
					old: lockedBefore.parent_id,
					new: after.parent_id ?? null,
				});
			}
			if (args.content !== undefined) {
				changes.push({ field: "content", old: "[changed]", new: "[changed]" });
			}
			for (const key of new Set([
				...Object.keys(beforeMetadata),
				...Object.keys(afterMetadata),
			])) {
				if (
					stableJson(beforeMetadata[key] ?? null) !==
					stableJson(afterMetadata[key] ?? null)
				) {
					changes.push({
						field: key,
						old: beforeMetadata[key] ?? null,
						new: afterMetadata[key] ?? null,
					});
				}
			}
			if (changes.length === 0) return;
			const contentLines = changes.map(
				(change) =>
					`- ${change.field}: ${JSON.stringify(change.old)} → ${JSON.stringify(change.new)}`,
			);
			await insertChangeEventInTransaction(
				{
					entityIds: [entityId],
					organizationId: ctx.organizationId,
					subject: "entity",
					op: "updated",
					title: `Entity updated: ${changes.map((change) => change.field).join(", ")}`,
					content: `Entity "${after.name}" (id: ${entityId}) updated:\n${contentLines.join("\n")}`,
					metadata: { changes },
					createdBy: ctx.userId ?? null,
					clientId: ctx.clientId ?? null,
				},
				tx,
			);
		},
	}).catch(async (err: unknown) => {
		const denial =
			err instanceof EntityPolicyDenialError
				? err.denial
				: ruleDenialFrom(err);
		if (denial) {
			// updateEntity owned and rolled back its transaction before this catch.
			await recordToolDenial({
				ctx,
				attemptId: denialAttemptId,
				actor: updateActor,
				automationId: updateAttribution.automationId,
				denial,
			});
		}
		throw err;
	});
	const entityDetails =
		(await getEntity(updatedEntity.id, env, ctx)) ?? updatedEntity;

	const viewUrl = await buildEntityViewUrl(ctx, entityDetails);

	// Post-commit: any blocked (human-owned or policy-gated) fields become a
	// single durable approval card. updateEntity packaged them as a deferred
	// mutation; queue() runs AFTER the entity tx + change event so the approval
	// (run + event + notification) is never rolled back with the edit — same
	// rule as complete_window's deferred creates.
	const blockedPaths = Object.keys(updatedEntity.fieldMerge?.blocked ?? {});
	const deferred = updatedEntity.deferred;
	let approvalQueued = false;
	let approvalUrl: string | undefined;
	let approvalRunId: number | undefined;
	let approvalFields: Record<string, unknown> | undefined;
	let approvalCurrent: Record<string, unknown> | undefined;
	if (deferred) {
		const res = await deferred.queue(ctx, env);
		approvalQueued = true;
		approvalUrl = res.approvalUrl;
		approvalRunId = res.runId;
		approvalFields = deferred.display.fields;
		approvalCurrent = deferred.display.current;
	}

	return {
		action: "update",
		entity: {
			id: entityDetails.id,
			entity_type: entityDetails.entity_type,
			name: entityDetails.name,
			slug: entityDetails.slug,
			parent_id: entityDetails.parent_id,
			parent_name: entityDetails.parent_name,
			parent_slug: entityDetails.parent_slug ?? null,
			metadata: entityDetails.metadata ?? {},
			enabled_classifiers: entityDetails.enabled_classifiers,
			view_url: viewUrl,
		},
		applied_fields: updatedEntity.fieldMerge?.applied,
		blocked_fields: blockedPaths.length > 0 ? blockedPaths : undefined,
		approval_queued: approvalQueued || undefined,
		approval_url: approvalUrl,
		approval_run_id: approvalRunId,
		approval_fields: approvalFields,
		approval_current: approvalCurrent,
		approval_attribution: deferred ? deferred.display.attribution : undefined,
	};
}

// Access policy for the built-in $member entity type:
//  - Anyone who isn't a member of the org cannot see the member list at all.
//  - Members who aren't admin/owner see names + non-PII metadata, but not the
//    email address.
//  - Only admin/owner see the email field.
function canSeeMemberList(ctx: ToolContext): boolean {
  return !!ctx.memberRole;
}

function canSeeMemberEmail(ctx: ToolContext): boolean {
  return isAdminOrOwnerRole(ctx.memberRole);
}

function redactMemberEmail(
	metadata: Record<string, unknown>,
	schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const { emailField } = resolveMemberSchemaFieldsFromSchema(schema);
  if (!(emailField in metadata)) return metadata;
  const { [emailField]: _removed, ...rest } = metadata;
  return rest;
}

/**
 * Fold a duplicate entity (`entity_id`, the loser) into the one it really is
 * (`winner_entity_id`). Humans must be admin/owner. Agents and automations may
 * auto-merge only when the entity type policy proves the match; every other
 * candidate queues human review. The heavy lifting (merge attributes, move
 * identities and edges, tombstone + forward each loser, flatten chains) is in
 * `applyMergeGroup`; this handler is the org-scoped gate + validation.
 */
async function handleMerge(
	args: Static<typeof MergeEntitiesAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const actor = await actingPrincipalFor(args, ctx);
	const denialAttemptId = randomUUID();
	if (actor.kind === "user" && !isAdminOrOwnerRole(ctx.memberRole)) {
		throw new ToolUserError("Only an admin or owner may merge entities", 403);
	}
	// Both merge outcomes — the queued proposal and the auto-merge decision —
	// record the same Automation, so resolve it once for the handler.
	const mergeAttribution = await resolveAutomationAttribution(
		ctx,
		args.automation_source
	);
	const loserIds = [
		...new Set(
			args.duplicate_entity_ids ?? (args.entity_id ? [args.entity_id] : []),
		),
	].sort((a, b) => a - b);
	const winnerId = args.winner_entity_id;
	if (loserIds.length === 0)
		throw new ToolUserError(
			"entity_id or duplicate_entity_ids is required for merge",
			400,
		);
	if (loserIds.includes(winnerId))
		throw new ToolUserError("winner_entity_id cannot also be a duplicate", 400);
	if (loserIds.length > 25)
		throw new ToolUserError("A merge can include at most 25 duplicates", 400);

	const sql = getDb();
	// Every duplicate and the winner must be live and in the caller's org — never
	// merge across a tenant boundary or into a deleted/foreign entity.
	const rows = (await sql`
    SELECT e.id, e.entity_type_id, e.metadata, et.metadata_schema,
           et.slug AS entity_type_slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
	WHERE e.organization_id = ${ctx.organizationId}
	      AND e.id = ANY(${pgBigintArray([...loserIds, winnerId])}::bigint[])
	      AND e.deleted_at IS NULL
	`) as Array<{
		id: number;
		entity_type_id: number;
		metadata: Record<string, unknown>;
		metadata_schema: Record<string, unknown> | null;
		entity_type_slug: string;
	}>;
	const found = new Set(rows.map((r) => Number(r.id)));
	for (const loserId of loserIds) {
		if (!found.has(loserId))
			throw new ToolUserError(
				`Entity ${loserId} not found in this workspace`,
				404,
			);
	}
	if (!found.has(winnerId))
		throw new ToolUserError(
			`Entity ${winnerId} not found in this workspace`,
			404,
		);
	const entityTypeIds = new Set(rows.map((row) => Number(row.entity_type_id)));
	if (entityTypeIds.size !== 1) {
		throw new ToolUserError(
			"Duplicate and canonical entities must have the same entity type",
			400,
		);
	}

	let resolution: ReturnType<typeof assessEntityResolution> | null = null;
	if (actor.kind !== "user") {
		const byId = new Map(rows.map((row) => [Number(row.id), row]));
		const winner = byId.get(winnerId);
		if (!winner) {
			throw new ToolUserError(
				`Entity ${winnerId} not found in this workspace`,
				404,
			);
		}
		const identities = await loadLiveEntityIdentities(sql, {
			organizationId: ctx.organizationId,
			entityIds: [...loserIds, winnerId],
		});
		resolution = assessEntityResolution({
			metadataSchema: winner.metadata_schema,
			entityTypeSlug: winner.entity_type_slug,
			winner: {
				id: winnerId,
				metadata: winner.metadata ?? {},
				identities: identities.get(winnerId) ?? [],
			},
			losers: loserIds.map((loserId) => ({
				id: loserId,
				metadata: byId.get(loserId)?.metadata ?? {},
				identities: identities.get(loserId) ?? [],
			})),
		});
	}

	// Preflight: report the rule verdict without mutating and without queuing.
	// Placed after the role gate (a principal who may not merge gets no preview)
	// and before the review branch below — a dry run must never create an
	// approval, exactly as on the delete path.
	if (args.dry_run) {
		const preview = await previewMerge({ loserIds, winnerId });
		return {
			action: "merge",
			success: true,
			message: preview.refused
				? `Dry run: the merge would NOT be applied — ${preview.reason}`
				: "Dry run: the merge would be applied",
			winner_entity_id: winnerId,
			loser_entity_id: loserIds[0],
			loser_entity_ids: loserIds,
			moved_identities: 0,
			repointed_edges: 0,
			dry_run: true,
		};
	}

	/**
	 * Send this merge to a human instead of applying it. Two deciders reach here
	 * with the same card, the same suppression rule and the same shape, differing
	 * only in who asked and why:
	 *
	 *  - the resolution POLICY, before any write is attempted — "is this the same
	 *    record?" — which answers `review` when the identity evidence is not
	 *    conclusive;
	 *  - the type's write RULE, from inside the merge kernel — "may this record be
	 *    merged away?" — which answers `escalate` however certain the identity is.
	 *
	 * They are different questions, so the second can override a policy that was
	 * sure: certainty about identity is not consent to the write. `reason` is
	 * whichever decider spoke, so the card says why it is waiting.
	 */
	const queueMergeForReview = async (
		policy: NonNullable<typeof resolution>,
		reason: string,
	): Promise<ManageEntityResult> => {
		const attribution = attributionFor(actor);
		if (
			await wasResolutionRejected(sql, {
				organizationId: ctx.organizationId,
				fingerprint: policy.fingerprint,
			})
		) {
			return {
				action: "merge",
				approval_suppressed: true,
				message:
					"This unchanged candidate was already rejected. It will be reconsidered when its evidence or policy changes.",
				resolution: {
					decision: "review",
					reason,
					evidence: policy.evidence,
				},
			};
		}
		const queued = await proposeEntityMerge(
			ctx,
			{
				entity_ids: loserIds,
				winner_entity_id: winnerId,
				evidence: policy.evidence,
				automation_id: mergeAttribution.automationId,
				policy_hash: policy.policyHash,
				resolution_fingerprint: policy.fingerprint,
				resolution_fingerprint_version: RESOLUTION_FINGERPRINT_VERSION,
				attribution,
				reason,
				// The proposer's own words, kept strictly separate from `reason` (the
				// machine-computed verdict). Displayed as a claim attributed to
				// whoever proposed the merge — it is never evidence and never affects
				// the auto-merge decision, which is recomputed server-side above.
				proposer_rationale: args.merge_rationale?.trim() || null,
			},
			policy.resolutionKeys,
			mergeAttribution.runId,
		);
		return {
			action: "merge",
			approval_queued: true,
			approval_url: queued.approvalUrl,
			approval_run_id: queued.runId,
			approval_action: "merge",
			approval_proposal: {
				entity_id: loserIds[0],
				entity_ids: loserIds,
				winner_entity_id: winnerId,
			},
			approval_attribution: attribution,
			next_steps: ["The merge is waiting for human approval."],
			resolution: {
				decision: "review",
				reason,
				evidence: policy.evidence,
			},
		};
	};

	if (actor.kind !== "user" && resolution?.decision === "review") {
		return await queueMergeForReview(resolution, resolution.reason);
	}

	let result: Awaited<ReturnType<typeof applyMergeGroup>>;
	try {
		result = await applyMergeGroup({
			orgId: ctx.organizationId,
			loserIds,
			winnerId,
			mergedBy: ctx.agentId ?? ctx.userId ?? "system",
			expectedResolutionFingerprint:
				actor.kind === "user" ? undefined : resolution?.fingerprint,
			resolution:
				actor.kind === "user"
					? {
							decision: "human",
							evidence: args.merge_evidence ?? [],
						}
					: {
							decision: "auto_merge",
							sourceRunId: mergeAttribution.runId,
							automationId: mergeAttribution.automationId,
							policyHash: resolution?.policyHash ?? null,
							evidence: resolution?.evidence ?? [],
						},
		});
	} catch (err) {
		const denial = ruleDenialFrom(err);
		if (denial) {
			// applyMergeGroup rolled back before this handler regains control.
			await recordToolDenial({
				ctx,
				attemptId: denialAttemptId,
				actor,
				automationId: mergeAttribution.automationId,
				denial,
			});
		}
		// The write rule judges the merge under lock inside the kernel, so its
		// verdict arrives only once the policy has already decided to apply. Route
		// the one escalation this card can replay — the merge card's grant is the
		// hardcoded literal `[$merged_into]`, so an escalate naming anything else
		// would mint a card that throws the moment a reviewer approves it. Those,
		// and every deny, still fail closed.
		//
		// Scoped to a non-user actor because that is the only path with a
		// resolution to card against: the card carries the policy hash, evidence
		// and fingerprint the suppression check re-reads, and a human-initiated
		// merge computes none of them. A human's merge is UNCHANGED by this — it
		// keeps the explicit 409 it already returned. Whether an escalate should
		// card a human's own merge too is a separate question, and answering it
		// needs a decision about what such a card is keyed on, not this catch.
		if (
			actor.kind !== "user" &&
			resolution &&
			err instanceof EntityRowValidationError &&
			err.verdict.outcome === "escalate" &&
			err.verdict.fields.length === 1 &&
			err.verdict.fields[0] === RESERVED_COLUMN_NAMES.mergedInto
		) {
			return await queueMergeForReview(resolution, err.verdict.reason);
		}
		throw new ToolUserError(
			`Merge failed: ${err instanceof Error ? err.message : String(err)}`,
			409,
		);
	}

	return {
		action: "merge",
		success: true,
		message: `Merged ${loserIds.length} duplicate ${loserIds.length === 1 ? "entity" : "entities"} into ${winnerId} (${result.movedIdentities} identities moved, ${result.repointedEdges} edges re-pointed).`,
		winner_entity_id: winnerId,
		loser_entity_id: loserIds[0],
		loser_entity_ids: loserIds,
		moved_identities: result.movedIdentities,
		repointed_edges: result.repointedEdges,
		resolution: {
			decision: actor.kind === "user" ? "human" : "auto_merge",
			reason:
				actor.kind === "user"
					? "A workspace administrator confirmed the merge."
					: (resolution?.reason ?? "A deterministic identity rule matched."),
			evidence:
				actor.kind === "user"
					? (args.merge_evidence ?? [])
					: (resolution?.evidence ?? []),
		},
	};
}

async function handleResolveDuplicates(
	args: Static<typeof ResolveDuplicatesAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	// The schema already requires >= 2 unique ids; sorted for a stable order.
	const candidateIds = [...args.candidate_entity_ids].sort((a, b) => a - b);
	let discovery: Awaited<ReturnType<typeof discoverWorkspaceResolutionGroups>>;
	try {
		discovery = await discoverWorkspaceResolutionGroups(getDb(), {
			organizationId: ctx.organizationId,
			candidateIds,
			maxGroups: 199,
			maxOperations: 199,
		});
	} catch (error) {
		throw new ToolUserError(
			error instanceof Error ? error.message : String(error),
			409,
		);
	}

	let autoMerged = 0;
	let approvalsQueued = 0;
	let approvalsSuppressed = 0;
	for (const group of discovery.groups) {
		for (const loserId of group.loserIds) {
			const result = await handleMerge(
				{
					action: "merge",
					winner_entity_id: group.winnerId,
					duplicate_entity_ids: [loserId],
				},
				ctx,
			);
			if ("success" in result && result.success) autoMerged += 1;
			else if ("approval_queued" in result && result.approval_queued) {
				approvalsQueued += 1;
			} else if (
				"approval_suppressed" in result &&
				result.approval_suppressed
			) {
				approvalsSuppressed += 1;
			}
		}
	}

	return {
		action: "resolve_duplicates",
		candidates_scanned: discovery.candidatesScanned,
		groups_found: discovery.groups.length,
		auto_merged: autoMerged,
		approvals_queued: approvalsQueued,
		approvals_suppressed: approvalsSuppressed,
		oversized_groups: discovery.oversizedGroupCount,
		deferred_candidates: discovery.deferredCandidateCount,
	};
}

/**
 * Reverse a merge: split a tombstoned loser (`entity_id`) back out of the winner
 * it was folded into. The winner is recovered from the loser's own `merged_into`
 * pointer (not passed in). Admin/owner only, org-fenced. Exact ledger restoration
 * and the legacy marker fallback live in `applyUnmerge`; this handler is the gate
 * + validation.
 */
async function handleUnmerge(
	args: Static<typeof UnmergeEntityAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (!isAdminOrOwnerRole(ctx.memberRole)) {
		throw new ToolUserError(
			"Only an admin or owner may un-merge entities",
			403,
		);
	}
	const loserId = args.entity_id;

	const sql = getDb();
	// The loser is a TOMBSTONE (deleted_at set by the merge), so we validate org
	// membership without the live filter the merge handler uses. It must exist and
	// currently be forwarded (merged_into set) — otherwise there's nothing to undo.
	const [row] = (await sql`
    SELECT id, merged_into FROM entities
    WHERE organization_id = ${ctx.organizationId} AND id = ${loserId}
  `) as Array<{ id: number; merged_into: number | null }>;
	if (!row)
		throw new ToolUserError(
			`Entity ${loserId} not found in this workspace`,
			404,
		);
	if (row.merged_into === null) {
		throw new ToolUserError(
			`Entity ${loserId} is not merged into anything — nothing to un-merge`,
			409,
		);
	}

	let result: Awaited<ReturnType<typeof applyUnmerge>>;
	try {
		result = await applyUnmerge({
			orgId: ctx.organizationId,
			loserId,
			unmergedBy: ctx.agentId ?? ctx.userId ?? "system",
		});
	} catch (err) {
		throw new ToolUserError(
			`Un-merge failed: ${err instanceof Error ? err.message : String(err)}`,
			409,
		);
	}

	return {
		action: "unmerge",
		success: true,
		message: `Un-merged entity ${loserId} out of ${result.winnerId} (${result.restoredIdentities} identities restored).`,
		winner_entity_id: result.winnerId,
		loser_entity_id: loserId,
		restored_identities: result.restoredIdentities,
	};
}

async function handleList(
	args: Static<typeof ListEntitiesAction>,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (args.entity_type === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberList(ctx)) {
		throw new ToolUserError(
			"The member list is only visible to members of this workspace. Join the workspace to see members.",
			400,
		);
	}

	// Type-scoped list: fail closed before querying when the principal can't read
	// that type. Cross-type list filters after (see below).
	if (args.entity_type) {
		await assertEntityReadAllowed(args, ctx, args.entity_type);
	}

	const sql = getDb();

	// Run list query and entity type schema fetch in parallel
	const [listResult, entityTypeRow] = await Promise.all([
		listEntities(
			{
				entity_type: args.entity_type,
				parent_id: args.parent_id,
				search: args.search,
				category: args.category,
				main_market: args.main_market,
				market: args.market,
				limit: args.limit,
				offset: args.offset,
				sort_by: args.sort_by,
				sort_order: args.sort_order,
			},
			env,
			ctx,
		),
		args.entity_type
			? sql`SELECT metadata_schema FROM entity_types WHERE slug = ${args.entity_type} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL LIMIT 1`.then(
					(r) => r[0] ?? null,
				)
			: Promise.resolve(null),
	]);

	let { entities, hasMore, totalCount, limit, offset, sortBy, sortOrder } =
		listResult;

	// Cross-type list: drop rows whose type the agent may not read. Humans skip
	// the gate above; agents with a blanket auto keep everything.
	if (!args.entity_type && entities.length > 0) {
		const actor = await actingPrincipalFor(args, ctx);
		if (actor.kind !== "user") {
			const typeCache = new Map<string, boolean>();
			const allowed: typeof entities = [];
			for (const e of entities) {
				const slug = e.entity_type;
				let ok = typeCache.get(slug);
				if (ok === undefined) {
					const decision = await evaluateEntityMutation({
						organizationId: ctx.organizationId,
						principalKind: actor.kind,
						principalId: actor.id,
						ownerAgentId: actor.ownerAgentId,
						ownerResolved: actor.ownerResolved,
						action: "read",
						entityTypeSlug: slug,
						sql,
					});
					ok = decision === "allow";
					typeCache.set(slug, ok);
				}
				if (ok) allowed.push(e);
			}
			// Prefer not leaking exact denied-row counts; keep hasMore from the
			// underlying query so later pages with allowed types still surface.
			if (allowed.length !== entities.length) {
				entities = allowed;
				totalCount = allowed.length;
			}
		}
	}

	// Batch-load relationships if schema declares x-table-relationships
	const schema = entityTypeRow?.metadata_schema as Record<
		string,
		unknown
	> | null;
	const relSpecs = (schema?.["x-table-relationships"] ??
		[]) as RelationshipColumnSpec[];
	const entityIds = entities.map((e) => e.id);

	// Batch-load relationships and linked-column lookups in parallel.
	const [relMap, linkedEntities] = await Promise.all([
		relSpecs.length > 0 && entityIds.length > 0
			? batchLoadRelationships(entityIds, relSpecs, ctx.organizationId)
			: Promise.resolve(new Map()),
		resolveLinkedColumns(entities, schema, ctx.organizationId),
	]);

	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	const hideMemberEmail = !canSeeMemberEmail(ctx);

	return {
		action: "list",
		entities: entities.map((e) => {
			const entityInfo = ownerSlug ? toEntityInfo(ownerSlug, e) : null;
			const rawMetadata = e.metadata ?? {};
			const metadata =
				hideMemberEmail && e.entity_type === MEMBER_ENTITY_TYPE_SLUG
					? redactMemberEmail(rawMetadata, schema)
					: rawMetadata;
			return {
				id: e.id,
				entity_type: e.entity_type,
				name: e.name,
				slug: e.slug,
				parent_id: e.parent_id,
				parent_name: e.parent_name,
				parent_slug: e.parent_slug,
				parent_entity_type: e.parent_entity_type,
				metadata,
				enabled_classifiers: e.enabled_classifiers,
				// Row `created_at` is a Date; the schema (and wire shape) is an ISO
				// string, so convert at the source rather than leaning on the emission
				// layer's coercion.
				created_at: toIsoStringOrNow(e.created_at),
				total_content: e.total_content,
				active_connections: e.active_connections,
				automations_count: e.automations_count,
				children_count: e.children_count,
				view_url: entityInfo ? buildEntityUrl(entityInfo, baseUrl) : undefined,
				...(relMap.size > 0 && relMap.has(e.id)
					? { relationships: relMap.get(e.id) }
					: {}),
			};
		}),
		...(Object.keys(linkedEntities).length > 0
			? { linked_entities: linkedEntities }
			: {}),
		metadata: {
			page_size: entities.length,
			has_more: hasMore,
			total_count: totalCount,
			limit,
			offset,
			sort_by: sortBy,
			sort_order: sortOrder,
			filtered_by_type: args.entity_type,
		},
	};
}

/**
 * Resolve every `x-link-entity-type` column on the schema to `{slug, name}`
 * pairs in one batch per (entityType, lookupField). Replaces the previous
 * FE pattern of `useQueries` fanning out one full-table fetch per linked
 * column. Returns a map keyed `${entityType}:${lookupField}` → lookup-value
 * → ref. Empty object if the schema declares no linked columns or none of
 * the visible rows reference linked values.
 */
async function resolveLinkedColumns(
	entities: Array<{ metadata?: Record<string, any> | null }>,
	schema: Record<string, unknown> | null,
	organizationId: string,
): Promise<
	Record<
		string,
		Record<string, { slug: string; entity_type: string; name: string }>
	>
> {
	if (!schema || entities.length === 0) return {};
	const properties = (schema as { properties?: Record<string, any> })
		.properties;
	if (!properties) return {};

	// Collect (linkedType, lookupField) → set of referenced values from the rows.
	const buckets = new Map<
		string,
		{ entityType: string; lookupField: string; values: Set<string> }
	>();
	for (const [columnKey, prop] of Object.entries(properties)) {
		const linkedType = (prop as { "x-link-entity-type"?: unknown })[
			"x-link-entity-type"
		];
		if (typeof linkedType !== "string" || linkedType === "") continue;
		const lookupFieldRaw = (prop as { "x-link-lookup-field"?: unknown })[
			"x-link-lookup-field"
		];
		const lookupField =
			typeof lookupFieldRaw === "string" && lookupFieldRaw
				? lookupFieldRaw
				: "slug";
		const bucketKey = `${linkedType}:${lookupField}`;
		let bucket = buckets.get(bucketKey);
		if (!bucket) {
			bucket = { entityType: linkedType, lookupField, values: new Set() };
			buckets.set(bucketKey, bucket);
		}
		for (const e of entities) {
			const raw = e.metadata?.[columnKey];
			const list = Array.isArray(raw) ? raw : [raw];
			for (const v of list) {
				if (v == null) continue;
				const s = String(v).trim();
				if (s !== "") bucket.values.add(s);
			}
		}
	}
	if (buckets.size === 0) return {};

	const sql = getDb();
	const out: Record<
		string,
		Record<string, { slug: string; entity_type: string; name: string }>
	> = {};

	await Promise.all(
		[...buckets.entries()].map(
			async ([bucketKey, { entityType, lookupField, values }]) => {
				if (values.size === 0) return;
				const valuesArr = [...values];
				const valuesLiteral = pgTextArray(valuesArr);
				const rows =
					lookupField === "slug"
						? await sql<{
								slug: string;
								entity_type: string;
								name: string;
								lookup_value: string;
							}>`
              SELECT e.slug, et.slug AS entity_type, e.name, e.slug AS lookup_value
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.organization_id = ${organizationId}
                AND e.deleted_at IS NULL
                AND et.slug = ${entityType}
                AND e.slug = ANY(${valuesLiteral}::text[])
            `
						: await sql<{
								slug: string;
								entity_type: string;
								name: string;
								lookup_value: string;
							}>`
              SELECT e.slug, et.slug AS entity_type, e.name, (e.metadata->>${lookupField}) AS lookup_value
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.organization_id = ${organizationId}
                AND e.deleted_at IS NULL
                AND et.slug = ${entityType}
                AND (e.metadata->>${lookupField}) = ANY(${valuesLiteral}::text[])
            `;
      if (rows.length === 0) return;
				const bucketMap: Record<
					string,
					{ slug: string; entity_type: string; name: string }
				> = {};
      for (const r of rows) {
        if (r.lookup_value == null) continue;
					bucketMap[r.lookup_value] = {
						slug: r.slug,
						entity_type: r.entity_type,
						name: r.name,
					};
      }
      out[bucketKey] = bucketMap;
			},
		),
  );

  return out;
}

async function handleGet(
	entityId: number,
	env: Env,
	ctx: ToolContext,
	includeDeleted = false,
): Promise<ManageEntityResult> {
	const entity = await getEntity(entityId, env, ctx, { includeDeleted });

	if (!entity) {
		throw new ToolUserError(`Entity with ID ${entityId} not found`, 404);
	}

	await assertEntityReadAllowed(undefined, ctx, entity.entity_type);

	if (
		entity.entity_type === MEMBER_ENTITY_TYPE_SLUG &&
		!canSeeMemberList(ctx)
	) {
		throw new ToolUserError(
			"Member details are only visible to members of this workspace. Join the workspace to see members.",
			400,
		);
	}

	const viewUrl = await buildEntityViewUrl(ctx, entity);

	let metadata = entity.metadata ?? {};
	if (
		entity.entity_type === MEMBER_ENTITY_TYPE_SLUG &&
		!canSeeMemberEmail(ctx)
	) {
		const sql = getDb();
		const rows = await sql`
      SELECT metadata_schema FROM entity_types
      WHERE slug = ${MEMBER_ENTITY_TYPE_SLUG} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      LIMIT 1
    `;
		const memberSchema =
			(rows[0]?.metadata_schema as Record<string, unknown> | null) ?? null;
    metadata = redactMemberEmail(metadata, memberSchema);
  }

  return {
		action: "get",
    entity: {
      id: entity.id,
      entity_type: entity.entity_type,
      name: entity.name,
      slug: entity.slug,
      parent_id: entity.parent_id,
      parent_name: entity.parent_name,
      parent_slug: entity.parent_slug ?? null,
      metadata,
      enabled_classifiers: entity.enabled_classifiers,
      created_at: toIsoStringOrNow(entity.created_at),
      view_url: viewUrl,
    },
  };
}

async function handleDelete(
	args: Static<typeof DeleteEntityAction>,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const entityId = args.entity_id;
	const force = args.force_delete_tree ?? false;
	// Get entity info before deletion
	const entity = await getEntity(entityId, env, ctx);
	if (!entity) {
		throw new ToolUserError(`Entity with ID ${entityId} not found`, 404);
	}

	const deleteActor = await actingPrincipalFor(args, ctx);
	const denialAttemptId = randomUUID();
	const deleteAttribution = await resolveAutomationAttribution(
		ctx,
		args.automation_source
	);
	const attribution = attributionFor(deleteActor);
	const current = {
		id: entity.id,
		entity_type: entity.entity_type,
		name: entity.name,
		slug: entity.slug,
		parent_id: entity.parent_id,
		metadata: entity.metadata ?? {},
	};
	const deleteDecision = await runMutationGate({
		action: "delete",
		organizationId: ctx.organizationId,
		principalKind: deleteActor.kind,
		sql: getDb(),
		attribution,
		automationId: deleteAttribution.automationId,
		parentRunId: deleteAttribution.runId,
		principalId: deleteActor.id,
		ownerAgentId: deleteActor.ownerAgentId,
		ownerResolved: deleteActor.ownerResolved,
		entityTypeSlug: entity.entity_type,
		entityId,
		entityOrgId: null,
		forceDeleteTree: force,
		current,
	});
	if (deleteDecision.outcome === "deny") {
		await recordEntityWriteDenial({
			organizationId: ctx.organizationId,
			ctx,
			attemptId: denialAttemptId,
			denialSource: "policy",
			operation: "delete",
			reason: deleteDecision.reason,
			deniedFields: [],
			entityId: entity.id,
			entityType: entity.entity_type,
			entityOrganizationId: entity.organization_id ?? null,
			actor: deleteActor,
			automationId: deleteAttribution.automationId,
		});
		throw new ToolUserError(deleteDecision.reason, 403);
	}
	// Preflight: report what the delete would remove/detach without mutating.
	// Runs after the gate's deny check (a denied principal gets no preview) but
	// before defer queues anything — a dry run must never create an approval.
	if (args.dry_run) {
		const preview = await deleteEntity(entityId, force, env, ctx, {
			dryRun: true,
		});
		return {
			action: "delete",
			success: true,
			// A rule refusal outranks the policy gate here. Telling someone their
			// delete "would be queued for approval" when a rule already refused it
			// promises a review that cannot help: approval waives an escalate, and
			// it can never launder a deny.
			message:
				deleteDecision.outcome === "defer" && !preview.refused
					? `${preview.message} (a real delete would be queued for approval)`
					: preview.message,
			deleted_count: 0,
			dry_run: true,
			tree: preview.tree,
		};
	}
	if (deleteDecision.outcome === "defer") {
		const res = await deleteDecision.deferred.queue(ctx, env);
		return {
			action: "delete",
			success: false,
			message: `Delete queued for approval: ${entity.name}`,
			deleted_count: 0,
			approval_queued: true,
			approval_url: res.approvalUrl,
			approval_run_id: res.runId,
			approval_action: "delete",
			approval_proposal: {
				entity_id: entity.id,
				entity_type: entity.entity_type,
				name: entity.name,
				force_delete_tree: force,
			},
			approval_current: current,
			approval_attribution: attribution,
		} as ManageEntityResult;
	}

	let result: Awaited<ReturnType<typeof deleteEntity>>;
	try {
		result = await deleteEntity(entityId, force, env, ctx);
	} catch (err) {
		const denial = ruleDenialFrom(err);
		if (denial) {
			// deleteEntity owned and rolled back its transaction before this catch.
			await recordToolDenial({
				ctx,
				attemptId: denialAttemptId,
				actor: deleteActor,
				automationId: deleteAttribution.automationId,
				denial,
			});
			throw err;
		}
		// Row rules run after the principal gate — under lock inside the delete
		// transaction, and once on the pool beforehand when the type has a
		// beforeDelete hook, so the hook's cleanup never precedes the verdict.
		// Route only an escalation the delete card can replay; denies and unrelated
		// fields still fail closed.
		if (
			!(err instanceof EntityRowValidationError) ||
			err.verdict.outcome !== "escalate" ||
			err.verdict.fields.length !== 1 ||
			err.verdict.fields[0] !== RESERVED_COLUMN_NAMES.softDelete
		) {
			throw err;
		}
		const queued = await proposeEntityDelete(ctx, {
			entity_id: entityId,
			force_delete_tree: force,
			current,
			automation_id:
				ctx.actingAutomationId ?? args.automation_source?.automation_id ?? null,
			attribution,
			reason: err.verdict.reason,
		}, deleteAttribution.runId);
		return {
			action: "delete",
			success: false,
			message: `Delete needs approval: ${err.verdict.reason}`,
			deleted_count: 0,
			approval_queued: true,
			approval_url: queued.approvalUrl,
			approval_run_id: queued.runId,
			approval_action: "delete",
			approval_proposal: {
				entity_id: entity.id,
				entity_type: entity.entity_type,
				name: entity.name,
				force_delete_tree: force,
			},
			approval_current: current,
			approval_attribution: attribution,
		} as ManageEntityResult;
	}

	return {
		action: "delete",
		success: true,
		message: result.message,
		deleted_count: result.deleted,
		tree: result.tree,
	};
}

// ============================================
// Relationship (Link) Helpers
// ============================================

const RELATIONSHIP_SELECT = `
  r.id,
  r.organization_id,
  r.from_entity_id,
  r.to_entity_id,
  r.relationship_type_id,
  rt.slug as relationship_type_slug,
  rt.name as relationship_type_name,
  rt.is_symmetric,
  ${ACL_MANAGED_TYPE_SQL} as acl_managed,
  fe.name as from_entity_name,
  fe.slug as from_entity_slug,
  fet.slug as from_entity_type,
  te.name as to_entity_name,
  te.slug as to_entity_slug,
  tet.slug as to_entity_type,
  NULLIF(r.metadata - '${RELATIONSHIP_CLAIMS_METADATA_KEY}', '{}'::jsonb) AS metadata,
  r.confidence,
  r.source,
  r.created_by,
  r.updated_by,
  r.created_at,
  r.updated_at,
  r.deleted_at
`;

const RELATIONSHIP_JOINS = `
  FROM entity_relationships r
  JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
  LEFT JOIN entities fe ON r.from_entity_id = fe.id
  LEFT JOIN entity_types fet ON fet.id = fe.entity_type_id
  LEFT JOIN entities te ON r.to_entity_id = te.id
  LEFT JOIN entity_types tet ON tet.id = te.entity_type_id
`;

// ============================================
// Relationship (Link) Action Handlers
// ============================================

/**
 * Pre-image of an edge, read before unlink/update_link so the change log can
 * carry what the row held before the mutation. `RELATIONSHIP_SELECT` is the
 * caller-facing projection; this is the audit one.
 */
interface EdgeAuditRow {
	id: number | string;
	organization_id: string;
	from_entity_id: number | string;
	to_entity_id: number | string;
	relationship_type_id: number | string;
	metadata: unknown;
	confidence: number | null;
	source: string | null;
	relationship_type_slug: string | null;
	purpose: string | null;
}

async function lockEdgeForMutation(
	tx: DbClient,
	relationshipId: number,
	organizationId: string,
	action: string,
): Promise<EdgeAuditRow> {
	const rows = await tx<EdgeAuditRow>`
    SELECT r.id, r.organization_id, r.from_entity_id, r.to_entity_id,
           r.relationship_type_id, r.metadata, r.confidence, r.source,
           rt.slug AS relationship_type_slug, rt.purpose
    FROM entity_relationships r
    LEFT JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.id = ${relationshipId} AND r.deleted_at IS NULL
    LIMIT 1
    FOR UPDATE OF r
  `;
	if (rows.length === 0) {
		throw new ToolUserError(`Relationship ${relationshipId} not found`, 404);
	}
	if (String(rows[0].organization_id) !== organizationId) {
		throw new ToolUserError(
			"Access denied: relationship belongs to another organization",
			403,
		);
	}
	// This loader's caller (update_link) mutates the edge, so the authorization
	// guard belongs here rather than in it. Changing an ACL edge alters access
	// exactly as surely as creating one grants it.
	assertNotAclManagedEdge(
		{ slug: rows[0].relationship_type_slug, purpose: rows[0].purpose },
		action,
	);
	return rows[0];
}

async function lockOrganizationForSemanticEvent(
	tx: DbClient,
	organizationId: string,
): Promise<void> {
	await tx`
		SELECT 1 FROM organization
		WHERE id = ${organizationId}
		FOR KEY SHARE
	`;
}

interface RelationshipTypeRow {
	id: number | string;
	is_symmetric: boolean;
	slug: string | null;
	purpose: string | null;
}

/**
 * Schema search path for relationship types: tenant first, then any
 * visibility='public' catalog. Mirrors createEntity's resolver so a tenant
 * can use a canonical relationship type like `works_at` defined in
 * public-uk-finance without registering a local copy. Tenant-local types
 * win when both exist.
 */
async function resolveRelationshipType(
	slug: string,
	organizationId: string,
): Promise<RelationshipTypeRow> {
	const sql = getDb();
	const rows = await sql<RelationshipTypeRow>`
    SELECT rt.id, rt.is_symmetric, rt.slug, rt.purpose
    FROM entity_relationship_types rt
    LEFT JOIN organization o ON o.id = rt.organization_id
    WHERE rt.slug = ${slug}
      AND rt.deleted_at IS NULL
      AND (
        rt.organization_id = ${organizationId}
        OR o.visibility = 'public'
      )
    ORDER BY (rt.organization_id = ${organizationId}) DESC, rt.id ASC
    LIMIT 1
  `;
	if (rows.length === 0) {
		throw new ToolUserError(`Relationship type "${slug}" not found`, 404);
	}
	return rows[0];
}

async function handleLink(
	args: Static<typeof LinkEntitiesAction>,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const sql = getDb();

	validateNoSelfReference(args.from_entity_id, args.to_entity_id);
	await validateScopeRule(args.from_entity_id, args.to_entity_id, env, ctx);

	const relType = await resolveRelationshipType(
		args.relationship_type_slug,
		ctx.organizationId,
	);
  // An authorization-bearing type is what the ACL gates read. Minting one of its
  // edges here would be minting access, so this surface refuses them outright —
  // classification is only a trust boundary if the classified rows stop being
  // generically writable.
  assertNotAclManagedEdge(relType, 'link');
  const typeId = Number(relType.id);
  const isSymmetric = Boolean(relType.is_symmetric);

  await validateTypeRule(typeId, args.from_entity_id, args.to_entity_id, sql);

  let fromId = args.from_entity_id;
  let toId = args.to_entity_id;
  if (isSymmetric) {
    // For symmetric same-org pairs we canonicalize by id so dedup catches
    // a → b and b → a as the same edge. For cross-org pairs (target in a
    // public catalog), keep the caller's-org entity as `from` even if its
    // id is higher, so the stored source matches the semantic source. The
    // canonical form would otherwise leave rows where `from_entity_id`
    // points at a public catalog row under a tenant `organization_id` —
    // tenant-owned but cosmetically inverted.
    const orgRows = await sql<{ id: number; organization_id: string }>`
      SELECT id, organization_id FROM entities WHERE id IN (${fromId}, ${toId})
    `;
		const orgOf = (id: number) =>
			String(orgRows.find((r) => Number(r.id) === id)?.organization_id);
		const sameOrg =
			orgOf(fromId) === ctx.organizationId &&
			orgOf(toId) === ctx.organizationId;
		if (sameOrg) {
			const canonical = canonicalizeSymmetricEdge(fromId, toId);
			fromId = canonical.from;
			toId = canonical.to;
		}
		// else: cross-org symmetric — preserve caller-from / public-to.
		// validateScopeRule already required `from` to be in caller's org.
	}

	validateConfidence(args.confidence);
	validateSource(args.source);
	assertNoReservedRelationshipMetadata(args.metadata);
	const source = args.source ?? "api";
	const confidence =
		args.confidence ?? (source === "ui" || source === "api" ? 1.0 : null);

	const created = await sql.begin(async (tx) => {
		const asserted = await assertManualRelationshipClaim(tx, {
			organizationId: ctx.organizationId,
			fromEntityId: fromId,
			toEntityId: toId,
			relationshipTypeId: typeId,
			metadata: args.metadata ?? null,
			confidence,
			source,
			createdBy: ctx.userId,
		});
		if (!asserted.claimAdded) {
			throw new ToolUserError(
				`An active relationship of this type already exists between entities ${fromId} and ${toId}`,
				409,
			);
		}
		const relationshipId = asserted.id;

		const createdRows = await tx.unsafe<RelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`,
			[relationshipId],
  );

		await insertEdgeChangeEventInTransaction(
			{
				organizationId: ctx.organizationId,
				relationshipId,
				fromEntityId: fromId,
				toEntityId: toId,
				relationshipTypeId: typeId,
				relationshipTypeSlug: args.relationship_type_slug ?? null,
				op: "link",
				changes: [
					{ field: "exists", old: false, new: true },
					{ field: "metadata", old: null, new: args.metadata ?? null },
					{ field: "confidence", old: null, new: confidence },
					{ field: "source", old: null, new: source },
				],
				createdBy: ctx.userId,
				clientId: ctx.clientId,
			},
			tx,
		);
		return createdRows[0];
	});

	return { action: "link", relationship: created };
}

/**
 * `unlink` and `update_link` accept either the `relationship_id` or the same
 * `{from, to, type}` triple `link` takes — which is the only addressing the SDK
 * signatures ever exposed. `idx_entity_relationships_live_triple` makes the
 * triple unique among live rows, so it names at most one edge.
 *
 * A symmetric edge is stored in one orientation only — same-org pairs are
 * canonicalized by id at link time, cross-org pairs keep the caller's org as
 * `from` — and the caller has no way to know which. So for a symmetric type
 * either orientation of the endpoints resolves the same row.
 *
 * This resolves an id and nothing more: the ACL, ownership, and org-scope
 * guards the by-id path already runs (`lockEdgeForMutation`,
 * `retractManualRelationshipClaim`) still run downstream, unchanged.
 */
async function resolveRelationshipId(
	args: EdgeAddress,
	ctx: ToolContext,
	action: "unlink" | "update_link",
): Promise<number> {
	const { relationship_id: namedId } = args;
	const fromId = args.from_entity_id;
	const toId = args.to_entity_id;
	const typeSlug = args.relationship_type_slug;

	if (!fromId || !toId || !typeSlug) {
		if (namedId) return namedId;
		throw new ToolUserError(
			`relationship_id, or from_entity_id + to_entity_id + relationship_type_slug, is required for ${action}`,
			400,
		);
	}

	// Same search path as `link`, so an edge minted against a canonical public
	// type is addressable the way it was created.
	const relType = await resolveRelationshipType(typeSlug, ctx.organizationId);
	const isSymmetric = Boolean(relType.is_symmetric);

	const sql = getDb();
	const rows = await sql<{ id: number | string }>`
    SELECT id
    FROM entity_relationships
    WHERE organization_id = ${ctx.organizationId}
      AND relationship_type_id = ${Number(relType.id)}
      AND deleted_at IS NULL
      AND (
        (from_entity_id = ${fromId} AND to_entity_id = ${toId})
        OR (
          ${isSymmetric}::boolean
          AND from_entity_id = ${toId}
          AND to_entity_id = ${fromId}
        )
      )
    -- At most one live row can match (idx_entity_relationships_live_triple),
    -- but order anyway so legacy data cannot make the pick arbitrary.
    ORDER BY id ASC
    LIMIT 1
  `;
	if (rows.length === 0)
		throw new ToolUserError(
			`No relationship of type "${typeSlug}" between entities ${fromId} and ${toId}`,
			404,
		);
	const resolved = Number(rows[0].id);
	// Both addressings supplied and they disagree. Letting the id win would
	// have `unlink` delete an edge the caller never named, so refuse instead of
	// picking one.
	if (namedId && Number(namedId) !== resolved)
		throw new ToolUserError(
			`relationship_id ${namedId} is not the "${typeSlug}" relationship between entities ${fromId} and ${toId} (that is relationship ${resolved}); pass one or the other`,
			400,
		);
	return resolved;
}

async function handleUnlink(
	args: Static<typeof UnlinkEntitiesAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const relationshipId = await resolveRelationshipId(args, ctx, "unlink");

  const sql = getDb();

	const result = await sql.begin(async (tx) => {
		const retracted = await retractManualRelationshipClaim(tx, {
			organizationId: ctx.organizationId,
			relationshipId,
			updatedBy: ctx.userId,
		});
		if (retracted.relationshipRemoved) {
			const edge = retracted.relationship;
			await insertEdgeChangeEventInTransaction(
				{
					organizationId: ctx.organizationId,
					relationshipId: edge.id,
					fromEntityId: edge.fromEntityId,
					toEntityId: edge.toEntityId,
					relationshipTypeId: edge.relationshipTypeId,
					relationshipTypeSlug: edge.relationshipTypeSlug,
					op: "unlink",
					changes: [
						{ field: "exists", old: true, new: false },
						{ field: "metadata", old: edge.metadata, new: null },
						{ field: "confidence", old: edge.confidence, new: null },
						{ field: "source", old: edge.source, new: null },
					],
					createdBy: ctx.userId,
					clientId: ctx.clientId,
				},
				tx,
			);
		}
		return retracted;
	});

	return {
		action: "unlink",
		success: true,
		message: result.relationshipRemoved
			? `Relationship ${relationshipId} deleted`
			: `Manual claim removed from relationship ${relationshipId}; source claims still retain it`,
	};
}

async function handleUpdateLink(
	args: Static<typeof UpdateLinkAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const relationshipId = await resolveRelationshipId(args, ctx, "update_link");

  const sql = getDb();

	const updated = await sql.begin(async (tx) => {
		await lockOrganizationForSemanticEvent(tx, ctx.organizationId);
		const edge = await lockEdgeForMutation(
			tx,
			relationshipId,
			ctx.organizationId,
			"update_link",
		);
		assertManualRelationshipMutationAllowed(edge, "updated");
		validateConfidence(args.confidence);
		validateSource(args.source);
		const hasMetadata = args.metadata !== undefined;
		assertNoReservedRelationshipMetadata(args.metadata);
		const visibleMetadataBefore = relationshipMetadataWithoutClaims(edge.metadata);
		const metadataChanged =
			hasMetadata &&
			stableJson(visibleMetadataBefore) !== stableJson(args.metadata ?? null);
		// Check the locked pre-image so concurrent updates cannot move a reconciled
		// edge out of the scope that retires it.
		validateReconciledEdgeUpdate(edge.source, args.source, metadataChanged);
		const metadataJson = hasMetadata ? tx.json(args.metadata) : null;
		const updatedRows = await tx<{
			metadata: unknown;
			confidence: number | null;
			source: string | null;
		}>`
      UPDATE entity_relationships SET
        metadata = CASE
					WHEN ${hasMetadata} THEN
						COALESCE(${metadataJson}, '{}'::jsonb)
						|| jsonb_build_object(
							${RELATIONSHIP_CLAIMS_METADATA_KEY}::text,
							metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}::text
						)
          ELSE metadata
        END,
        confidence = COALESCE(${args.confidence ?? null}, confidence),
        source = COALESCE(${args.source ?? null}, source),
        updated_by = ${ctx.userId},
        updated_at = current_timestamp
      WHERE id = ${relationshipId} AND deleted_at IS NULL
      RETURNING metadata, confidence, source
    `;
		const relationship = await tx.unsafe<RelationshipRow>(
			`SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`,
			[relationshipId],
		);
		const after = updatedRows[0];
		const changes = [
			{
				field: "metadata",
				old: visibleMetadataBefore,
				new: relationshipMetadataWithoutClaims(after.metadata),
			},
			{ field: "confidence", old: edge.confidence, new: after.confidence },
			{ field: "source", old: edge.source, new: after.source },
		].filter(
			(change) =>
				stableJson(change.old ?? null) !== stableJson(change.new ?? null),
		);
		if (changes.length > 0) {
			await insertEdgeChangeEventInTransaction(
				{
					organizationId: ctx.organizationId,
					relationshipId: Number(edge.id),
					fromEntityId: Number(edge.from_entity_id),
					toEntityId: Number(edge.to_entity_id),
					relationshipTypeId: Number(edge.relationship_type_id),
					relationshipTypeSlug: edge.relationship_type_slug,
					op: "update_link",
					changes,
					createdBy: ctx.userId,
					clientId: ctx.clientId,
				},
				tx,
			);
		}
		return relationship[0];
	});

	return { action: "update_link", relationship: updated };
}

async function handleListLinks(
	args: Static<typeof ListLinksAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const sql = getDb();
	const typeRows = await sql<{ entity_type: string }>`
		SELECT et.slug AS entity_type
		FROM entities e
		JOIN entity_types et ON et.id = e.entity_type_id
		WHERE e.id = ${args.entity_id}
		  AND e.organization_id = ${ctx.organizationId}
		LIMIT 1
	`;
	if (typeRows.length === 0) {
		throw new ToolUserError(`Entity ${args.entity_id} not found`, 404);
	}
	await assertEntityReadAllowed(args, ctx, typeRows[0].entity_type);

	const direction = args.direction ?? "both";
	const includeDeleted = args.include_deleted ?? false;
	const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
	const offset = Math.max(args.offset ?? 0, 0);

	const conditions: string[] = ["r.organization_id = $1"];
	const params: unknown[] = [ctx.organizationId];
	let paramIdx = 2;

	if (!includeDeleted) {
		conditions.push("r.deleted_at IS NULL");
	}

	if (direction === "outbound") {
		conditions.push(`(r.from_entity_id = $${paramIdx})`);
		params.push(args.entity_id);
		paramIdx++;
	} else if (direction === "inbound") {
		conditions.push(`(r.to_entity_id = $${paramIdx})`);
		params.push(args.entity_id);
		paramIdx++;
	} else {
		conditions.push(
			`(r.from_entity_id = $${paramIdx} OR r.to_entity_id = $${paramIdx})`,
		);
		params.push(args.entity_id);
		paramIdx++;
	}

	if (args.relationship_type_slug) {
		conditions.push(`rt.slug = $${paramIdx}`);
		params.push(args.relationship_type_slug);
		paramIdx++;
	}

	if (args.source) {
		conditions.push(`r.source = $${paramIdx}`);
		params.push(args.source);
		paramIdx++;
	}

	if (args.confidence_min !== undefined) {
		conditions.push(`r.confidence >= $${paramIdx}`);
		params.push(args.confidence_min);
		paramIdx++;
	}

	const whereClause = conditions.join(" AND ");

	const countResult = await sql.unsafe<{ total: number }>(
		`SELECT COUNT(*)::int as total ${RELATIONSHIP_JOINS} WHERE ${whereClause}`,
		params,
	);
	const total = Number(countResult[0]?.total ?? 0);

	const rows = await sql.unsafe<RelationshipRow>(
		`SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS}
     WHERE ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT ${limit + 1}
     OFFSET ${offset}`,
		params,
  );

  const hasMore = rows.length > limit;
  const relationships = hasMore ? rows.slice(0, limit) : rows;

  const countsResult = await sql.unsafe<RelationshipCountByType>(
    `SELECT
      rt.slug as relationship_type_slug,
      rt.name as relationship_type_name,
      COUNT(*)::int as count
    ${RELATIONSHIP_JOINS}
    WHERE ${whereClause}
    GROUP BY rt.slug, rt.name
    ORDER BY count DESC`,
		params,
  );

  return {
		action: "list_links",
    relationships,
    counts_by_type: countsResult,
    metadata: { total, limit, offset, has_more: hasMore },
  };
}
