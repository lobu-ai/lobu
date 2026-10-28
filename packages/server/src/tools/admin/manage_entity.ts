import { decideIdentityAssociation, type IdentityAssociationInput } from "../../utils/identity-association";
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
 * - discover_duplicates: Page whole duplicate components across one entity type (read-only)
 */

import { type EntityReadRestrictions, entityReadRestrictions, filterEntityReadRows } from "../../authz/entity-read-policy";
import { deriveToolActorSource } from '../../utils/apply-context';
import { randomUUID } from "node:crypto";

import {
	ApprovalAttribution,
	type ApprovalAttribution as ApprovalAttributionType,
} from "@lobu/core/contracts/interaction-envelope";
import {
	CreateEntityAction,
	DeleteEntityAction,
	DiscoverDuplicatesAction,
	GetEntityAction,
	LinkEntitiesAction,
	ListEntitiesAction,
	ListLinksAction,
	type ManageEntityResult,
	ManageEntityResultSchema,
	ManageEntitySchema,
	type RelationshipRow,
	UnlinkEntitiesAction,
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
	resolveWriteCreatorUserId,
} from "../../authz/entity-policy";
import { resolveAutomationAttribution } from "../../automations/automation-source";
import {
	type DbClient,
	getDb,
	pgTextArray,
} from "../../db/client";
import { discoverWorkspaceResolutionPage } from "../../entity-resolution/discovery";
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
import { ToolUserError } from "../../utils/errors";
import { runTurnWriteOnce } from "../turn-write-idempotency";
import { recordKeyColumn } from "@lobu/core/contracts/entity-reference";
import { normalizeEntityTypeSlug } from "../../utils/reserved";
import {
  endpointPredicate,
  nextRelationshipCursor,
  parseRelationshipCursor,
  readAuthoredRelationshipPage,
  readableRelationships,
  readNativeRelationshipPage,
  RELATIONSHIP_JOINS,
  RELATIONSHIP_SELECT,
} from "../../utils/relationship-reads";
import { compareEntityEndpoints, lockEndpointTypes, resolveEntityReference } from "../../utils/entity-reference";
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
import { canSeeMemberEmail, canSeeMemberList, redactMemberEmail } from "../../utils/member-entity-type";
import {
	assertNotAclManagedEdge,
	validateConfidence,
	validateReconciledEdgeUpdate,
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
import { isInProcessSystemCall } from "../access-control";
import { MEMBER_ENTITY_TYPE_SLUG } from "../constants";
import type { ToolContext } from "../registry";
import {
	buildEntityViewUrl,
	getOrgUrlContext,
	toEntityInfo,
} from "../view-urls";
import { action, defineActionTool } from "./action-tool";
import { proposeEntityChange, proposeEntityDelete } from "./entity-field-approval";
import { eventClientId } from "../../auth/event-client-id";

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
async function actingPrincipalFor(
	args: Attributed | undefined,
	ctx: ToolContext,
): Promise<ActingPrincipal> {
	// Caller-supplied attribution is a hint, not authority. Ignore an invalid
	// Automation/run pair before resolving policy; trusted session identity is
	// retained by both resolvers and still fails closed if its owner is missing.
	// Without a session stamp, omitting the hint already uses the caller's own policy.
	const attribution = await resolveAutomationAttribution(ctx, args?.automation_source);
	return resolveActingPrincipal(getDb(), {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		explicitAutomationId: attribution.automationId,
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
	"relationship_id" | "from_entity_id" | "to_entity_id" | "from_entity_type" | "to_entity_type" | "relationship_type_slug"
>;

/**
 * The mutations a reaction record is kept for, and the fields that record
 * carries. Everything but `action` is optional because no single tracked
 * variant declares all of them: `create` has no `entity_id`, `update` and
 * `link` have no `entity_type`, and `link` has no `name`.
 */
interface TrackedMutationArgs extends Attributed {
	dry_run?: boolean;
	action: "create" | "update" | "link";
	entity_id?: number | string;
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
		oncePerTurnInput(
			"entities.create",
			trackedMutation((args, ctx, env) => handleCreate(args, env, ctx)),
		),
	),
	update: action(
		UpdateEntityAction,
		trackedMutation((args, ctx, env) => handleUpdate(args, env, ctx)),
	),
	list: action(ListEntitiesAction, (args, ctx, env) =>
		handleList(args, env, ctx),
	),
	get: action(GetEntityAction, (args, ctx, env) =>
		handleGet(args.entity_id, env, ctx, args.include_deleted ?? false, args.entity_type),
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
	discover_duplicates: action(DiscoverDuplicatesAction, handleDiscoverDuplicates),
});

export const manageEntity = manageEntityTool.run;

/**
 * While its receipt is retained, a re-run or repeated create with the same
 * arguments replays the first result (including a deferred
 * approval) instead of creating a second row. A claim with no result — an
 * attempt still running or one that died mid-write — refuses rather than
 * guess. A refusal (a soft error result or a ToolUserError) releases its
 * claim; any other thrown error retains it because the create or its
 * approval may already have committed. Non-turn
 * callers run the handler as before.
 */
function oncePerTurnInput<A>(surface: string, handler: Handler<A>): Handler<A> {
	return async (args, ctx, env) => {
		let result: ManageEntityResult | undefined;
		const outcome = await runTurnWriteOnce<ManageEntityResult>(
			ctx.agentTurn,
			surface,
			args,
			async () => {
				result = await handler(args, ctx, env);
				const error = (result as { error?: unknown }).error;
				return typeof error === "string" && error.length > 0
					? { release: true }
					: { store: result };
			},
		);
		if (outcome.kind === "replay") return outcome.result;
		if (outcome.kind === "attempted") {
			throw new ToolUserError(
				"This create was already attempted for this message and may have succeeded; it was not repeated.",
				409,
			);
		}
		return result as ManageEntityResult;
	};
}

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
	// Resolved unconditionally, like every other call site in this file: a
	// reaction session stamps `ctx.actingAutomationId` and declares no
	// `automation_source`, so gating on the declaration dropped its credit —
	// and with it `entity_id`, the only per-subject signal this table carries.
	const reactionAttribution = await resolveAutomationAttribution(
		ctx,
		args.automation_source,
	);
	// A reaction record is keyed by the producing run.
	if (
		reactionAttribution.automationId == null ||
		reactionAttribution.runId == null ||
		!("action" in result)
	) {
		return;
	}
	if (args.action === "link" && args.dry_run) return;
	if (result.action === "link" && (!("relationship" in result) || !result.relationship)) return;
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
		entityId: typeof entityId === 'number' ? entityId : undefined,
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
		organization_id: ctx.organizationId,
	};
	// created_by is NOT NULL, FK → "user"; a headless script-executor create
	// (userId == null) resolves the automation owner / org admin (see the helper).
	entityData.created_by =
		(await resolveWriteCreatorUserId(getDb(), {
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			sessionAutomationId: ctx.actingAutomationId ?? null,
		})) ?? "system";

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
				principal: ctx,
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
	if (typeof entityId !== 'number') throw new ToolUserError('Source-owned entity fields are read-only', 400);
	if (args.entity_type) await resolveEntityReference(entityId, args.entity_type, ctx);
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
			Object.entries({ ...before.metadata, ...args.metadata }).filter(
				([, value]) => value !== null,
			),
		);
		const validation = await validateEntityMetadata(
			before.entity_type as string,
			metadataForValidation,
			ctx,
			{
				legacyAutomationEntityId:
					(before.metadata as Record<string, unknown> | null)?.source ===
					'automation_promotion'
						? entityId
						: undefined,
			},
		);
		if (!validation.valid) {
			const errorMessages =
				validation.errors?.map((e) => e.message).join("; ") ??
				"Invalid metadata";
			throw new ToolUserError(`Metadata validation failed: ${errorMessages}`, 400);
		}
		// Coerce only the submitted patch. Copying the saved siblings back into
		// the patch would claim human ownership of fields the caller never edited
		// and could overwrite a concurrent update before the locked write.
		for (const key of Object.keys(args.metadata)) {
			if (args.metadata[key] !== null) args.metadata[key] = metadataForValidation[key];
		}
	}

	// Build update data (only include fields that are present)
	const updateData: Partial<EntityData> = {};

	if (args.name !== undefined) updateData.name = args.name;
	if (args.slug !== undefined) updateData.slug = args.slug;
	if (args.parent_id !== undefined) updateData.parent_id = args.parent_id;

	// Content body
	if (args.content !== undefined) updateData.content = args.content;

	// Metadata patch (merged with the locked current row in updateEntity)
	if (args.metadata !== undefined) updateData.metadata = args.metadata;

	// Human-correction note: annotates the field_controls marker for the fields
	// this edit claims (why the human set/overrode the value).
	if (args.field_note !== undefined) updateData.field_note = args.field_note;

	// Approve/affirm: claim ownership of these fields' current values as-is.
	if (args.affirm_fields !== undefined)
		updateData.affirm_fields = args.affirm_fields;

	// Asserted manual edit: honoured or refused (403) inside updateEntity.
	if (args.manual_edit !== undefined) updateData.manual_edit = args.manual_edit;

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
					clientId: eventClientId(ctx),
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
		manual_edit_applied: updatedEntity.manualEditApplied || undefined,
	};
}

// $member read policy (canSeeMemberList / canSeeMemberEmail /
// redactMemberEmail) lives in utils/member-entity-type.ts, shared with
// search_memory so the two surfaces cannot drift.

async function handleDiscoverDuplicates(
	args: Static<typeof DiscoverDuplicatesAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (!ctx.memberRole && !isInProcessSystemCall(ctx)) {
		throw new ToolUserError("Duplicate discovery requires workspace membership", 403);
	}
	// Discovery can expose relationships inferred from member email addresses.
	if (args.entity_type === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberEmail(ctx.memberRole)) {
		throw new ToolUserError("Member identity discovery requires workspace administrator access", 403);
	}
	await assertEntityReadAllowed(undefined, ctx, args.entity_type);
	return discoverWorkspaceResolutionPage(getDb(), {
		organizationId: ctx.organizationId, entityType: args.entity_type,
		limit: args.limit, cursor: args.cursor,
	}, ctx);
}

async function handleList(
	args: Static<typeof ListEntitiesAction>,
	env: Env,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	if (args.entity_type === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberList(ctx.memberRole)) {
		throw new ToolUserError(
			"The member list is only visible to members of this workspace. Join the workspace to see members.",
			400,
		);
	}

	// Type-scoped list: fail closed before querying when the principal can't read
	// that type. Record and cross-type restrictions filter before pagination.
	if (args.entity_type) {
		await assertEntityReadAllowed(args, ctx, args.entity_type);
	}

	const sql = getDb();
	const readRestrictions = await entityReadRestrictions(sql, ctx, await actingPrincipalFor(args, ctx));

	// Run list query and entity type schema fetch in parallel
	const [listResult, entityTypeRow] = await Promise.all([
		listEntities(
			{
				entity_type: args.entity_type,
				parent_id: args.parent_id,
				search: args.search,
				segment: args.segment,
				filters: args.filters,
				limit: args.limit,
				offset: args.offset,
				sort_by: args.sort_by,
				sort_order: args.sort_order,
			},
			env,
			ctx,
			readRestrictions,
		),
		args.entity_type
			? sql`SELECT metadata_schema FROM entity_types WHERE slug = ${args.entity_type} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL LIMIT 1`.then(
					(r) => r[0] ?? null,
				)
			: Promise.resolve(null),
	]);

	const { entities, hasMore, totalCount, limit, offset, sortBy, sortOrder } =
		listResult;

	// Batch-load relationships if schema declares x-table-relationships
	const schema = entityTypeRow?.metadata_schema as Record<
		string,
		unknown
	> | null;
	const relSpecs = (schema?.["x-table-relationships"] ??
		[]) as RelationshipColumnSpec[];
	const entityIds = entities.filter(e => e.source_record_id === undefined).map((e) => e.id);

	// Batch-load relationships and linked-column lookups in parallel.
	const [relMap, linkedEntities] = await Promise.all([
		relSpecs.length > 0 && entityIds.length > 0
			? batchLoadRelationships(entityIds, relSpecs, ctx.organizationId, readRestrictions)
			: Promise.resolve(new Map()),
		resolveLinkedColumns(entities, schema, ctx.organizationId, readRestrictions),
	]);

	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	const hideMemberEmail = !canSeeMemberEmail(ctx.memberRole);

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
				id: e.source_record_id !== undefined ? e.source_record_id : e.id,
				...(e.identity ? { identity: e.identity } : {}),
				entity_type: e.entity_type,
				name: e.name,
				slug: e.slug,
				parent_id: e.parent_id,
				parent_name: e.parent_name,
				parent_slug: e.parent_slug,
				parent_entity_type: e.parent_entity_type,
				metadata,
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
	readRestrictions: EntityReadRestrictions,
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
								id: number; slug: string;
								entity_type: string;
								name: string;
								lookup_value: string;
							}>`
              SELECT e.id, e.slug, et.slug AS entity_type, e.name, e.slug AS lookup_value
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.organization_id = ${organizationId}
                AND e.deleted_at IS NULL
                AND et.slug = ${entityType}
                AND e.slug = ANY(${valuesLiteral}::text[])
            `
						: await sql<{
								id: number; slug: string;
								entity_type: string;
								name: string;
								lookup_value: string;
							}>`
              SELECT e.id, e.slug, et.slug AS entity_type, e.name, (e.metadata->>${lookupField}) AS lookup_value
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
      for (const r of await filterEntityReadRows(sql, rows, readRestrictions)) {
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
	entityId: number | string,
	env: Env,
	ctx: ToolContext,
	includeDeleted = false,
	entityType?: string,
): Promise<ManageEntityResult> {
	if (typeof entityId === 'string') {
		if (includeDeleted) throw new ToolUserError('include_deleted is not supported by this source', 400);
		const entity = await resolveEntityReference(entityId, entityType, ctx);
		return { action: 'get', entity: { id: entity.id, entity_type: entity.entityType,
			name: entity.name, slug: entity.slug, metadata: entity.metadata } };
	}
	const readRestrictions = await entityReadRestrictions(getDb(), ctx);
	const entity = await getEntity(entityId, env, ctx, { includeDeleted, readRestrictions });

	if (!entity) {
		throw new ToolUserError(`Entity with ID ${entityId} not found`, 404);
	}
	if (entityType !== undefined && entity.entity_type !== normalizeEntityTypeSlug(entityType)) {
		throw new ToolUserError('entity_type does not match entity_id', 400);
	}

	await assertEntityReadAllowed(undefined, ctx, entity.entity_type);

	if (
		entity.entity_type === MEMBER_ENTITY_TYPE_SLUG &&
		!canSeeMemberList(ctx.memberRole)
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
		!canSeeMemberEmail(ctx.memberRole)
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
      ...(entity.identity ? { identity: entity.identity } : {}),
      entity_type: entity.entity_type,
      name: entity.name,
      slug: entity.slug,
      parent_id: entity.parent_id,
      parent_name: entity.parent_name,
      parent_slug: entity.parent_slug ?? null,
      metadata,
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
	if (typeof entityId !== 'number') throw new ToolUserError('Source-owned entities cannot be deleted through this API', 400);
	if (args.entity_type) await resolveEntityReference(entityId, args.entity_type, ctx);
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
			// The VERIFIED id, not an inline merge of the declared one. `runId`
			// below already comes from this resolution, so the raw merge could
			// pair a verified run with a declared Automation that failed
			// verification — a worse pairing than either half alone.
			automation_id: deleteAttribution.automationId,
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
	from_entity_id: number | string | null;
	to_entity_id: number | string | null;
	from_entity_type_id: number | string | null;
	to_entity_type_id: number | string | null;
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
    SELECT r.id, r.organization_id, r.from_entity_id, r.to_entity_id, r.from_entity_type_id, r.to_entity_type_id,
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

async function handleIdentityAssociation(input: IdentityAssociationInput, ctx: ToolContext, parentRunId: number | null = null): Promise<ManageEntityResult> {
  const sql = getDb();
  const decision = await sql.begin(tx => decideIdentityAssociation(tx, input, ctx));
  if (decision.outcome === 'refused' && !input.dry_run) throw new ToolUserError(decision.reason, 409);
  const queued = decision.outcome === 'review' && !input.dry_run && decision.proposal
    ? await proposeEntityChange(ctx, decision.proposal, parentRunId) : null;
  if (input.dry_run) return { action: input.operation, dry_run: true,
    preview: { outcome: decision.outcome, reason: decision.reason } };
  if (queued) return { action: input.operation, approval_queued: true,
    approval_run_id: queued.runId, approval_url: queued.approvalUrl };
  if (decision.outcome === 'suppressed') return input.operation === 'link'
    ? { action: 'link', approval_suppressed: true, message: decision.reason }
    : { action: 'unlink', approval_suppressed: true, message: decision.reason };
  if (input.operation === 'unlink') return { action: 'unlink', success: true, message: decision.reason };
  const rows = decision.relationshipId ? await sql.unsafe<RelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`, [decision.relationshipId]) : [];
  if (!rows[0]) throw new ToolUserError('Identity association did not produce a relationship', 409);
  return { action: 'link', relationship: rows[0] };
}

async function handleLink(
  args: Static<typeof LinkEntitiesAction>, _env: Env, ctx: ToolContext,
): Promise<ManageEntityResult> {
  const sql = getDb();
  const relType = await resolveRelationshipType(args.relationship_type_slug, ctx.organizationId);
  assertNotAclManagedEdge(relType, 'link');
  if (relType.purpose === 'identity') {
    if (typeof args.from_entity_id !== 'number' || typeof args.to_entity_id !== 'number') {
      throw new ToolUserError('Identity associations require stored endpoints', 400);
    }
    if (args.from_entity_type) await resolveEntityReference(args.from_entity_id, args.from_entity_type, ctx);
    if (args.to_entity_type) await resolveEntityReference(args.to_entity_id, args.to_entity_type, ctx);
    const attribution = await resolveAutomationAttribution(ctx, args.automation_source);
    validateConfidence(args.confidence);
    validateSource(args.source);
    return handleIdentityAssociation({ operation: 'link', entity_id: args.from_entity_id,
      to_entity_id: args.to_entity_id, relationship_type_id: Number(relType.id),
      relationship_type_slug: args.relationship_type_slug, metadata: args.metadata,
      dry_run: args.dry_run, automation_id: attribution.automationId, source: args.source, confidence: args.confidence }, ctx, attribution.runId);
  }
  if (args.dry_run) throw new ToolUserError('Relationship dry_run requires purpose identity', 400);
  const restrictions = await entityReadRestrictions(sql, ctx, await actingPrincipalFor(args, ctx));
  let [from, to] = await Promise.all([
    resolveEntityReference(args.from_entity_id, args.from_entity_type, ctx, { restrictions }),
    resolveEntityReference(args.to_entity_id, args.to_entity_type, ctx, { restrictions }),
  ]);
  // Retain the existing authorship scope: the source record/type belongs to the
  // workspace; a stored target may additionally belong to a public catalog.
  if (from.organizationId !== ctx.organizationId) throw new ToolUserError('Source entity must belong to your workspace', 403);
  if (compareEntityEndpoints(from, to) === 0) throw new ToolUserError('Self-referencing relationships are not allowed', 400);
  await validateTypeRule(Number(relType.id), from.entityId ?? 0, to.entityId ?? 0, sql,
    { from: from.entityType, to: to.entityType });
  if (relType.is_symmetric && to.organizationId === ctx.organizationId && compareEntityEndpoints(from, to) > 0) {
    [from, to] = [to, from];
  }
  validateConfidence(args.confidence);
  validateSource(args.source);
  assertNoReservedRelationshipMetadata(args.metadata);
  const source = args.source ?? 'api';
  const confidence = args.confidence ?? (source === 'ui' || source === 'api' ? 1 : null);
  const relationship = await sql.begin(async tx => {
    await lockOrganizationForSemanticEvent(tx, ctx.organizationId);
    await lockEndpointTypes(tx, [from, to]);
    const asserted = await assertManualRelationshipClaim(tx, {
      organizationId: ctx.organizationId, fromEntityId: from.entityId, toEntityId: to.entityId,
      fromEntityTypeId: from.sourceTypeId, fromSourceKey: from.sourceKey,
      toEntityTypeId: to.sourceTypeId, toSourceKey: to.sourceKey,
      relationshipTypeId: Number(relType.id), metadata: args.metadata ?? null,
      confidence, source, createdBy: ctx.userId,
    });
    if (!asserted.claimAdded) throw new ToolUserError('An active relationship of this type already exists between these entities', 409);
    const rows = await tx.unsafe<RelationshipRow>(`SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`, [asserted.id]);
    await insertEdgeChangeEventInTransaction({
      organizationId: ctx.organizationId, relationshipId: asserted.id,
      fromEntityId: from.entityId, toEntityId: to.entityId,
      fromEntityTypeId: from.sourceTypeId, toEntityTypeId: to.sourceTypeId,
      relationshipTypeId: Number(relType.id), relationshipTypeSlug: args.relationship_type_slug, op: 'link',
      changes: [{ field: 'exists', old: false, new: true }, { field: 'metadata', old: null, new: args.metadata ?? null },
        { field: 'confidence', old: null, new: confidence }, { field: 'source', old: null, new: source }],
      createdBy: ctx.userId, clientId: eventClientId(ctx),
    }, tx);
    return { ...rows[0], from_entity_name: from.name, to_entity_name: to.name };
  });
  return { action: 'link', relationship };
}

/**
 * `unlink` and `update_link` accept either the `relationship_id` or the same
 * `{from, to, type}` triple `link` takes — which is the only addressing the SDK
 * signatures ever exposed. `idx_entity_relationships_live_triple` (stored
 * endpoints) and `idx_entity_relationships_live_source_pair` (source endpoints)
 * make the triple unique among live rows, so it names at most one edge.
 *
 * A symmetric edge is stored in one orientation only — same-org pairs are
 * canonicalized by `compareEntityEndpoints` at link time, cross-org pairs keep
 * the caller's org as `from` — and the caller has no way to know which. So for
 * a symmetric type either orientation of the endpoints resolves the same row.
 *
 * This resolves an id and nothing more: the ACL, ownership, and org-scope
 * guards the by-id path already runs (`lockEdgeForMutation`,
 * `retractManualRelationshipClaim`) still run downstream, unchanged.
 */
async function resolveRelationshipId(args: EdgeAddress, ctx: ToolContext, action: 'unlink' | 'update_link'): Promise<number> {
  const namedId = args.relationship_id;
  if (args.from_entity_id === undefined || args.to_entity_id === undefined || !args.relationship_type_slug) {
    if (namedId) return namedId;
    throw new ToolUserError(`relationship_id, or from_entity_id + to_entity_id + relationship_type_slug, is required for ${action}`, 400);
  }
  const relType = await resolveRelationshipType(args.relationship_type_slug, ctx.organizationId);
  const [from, to] = await Promise.all([
    resolveEntityReference(args.from_entity_id, args.from_entity_type, ctx, { readSource: false }),
    resolveEntityReference(args.to_entity_id, args.to_entity_type, ctx, { readSource: false }),
  ]);
  const params: unknown[] = [ctx.organizationId, Number(relType.id)];
  const forward = `${endpointPredicate('from', from, params)} AND ${endpointPredicate('to', to, params)}`;
  const reverse = relType.is_symmetric ? ` OR (${endpointPredicate('from', to, params)} AND ${endpointPredicate('to', from, params)})` : '';
  const rows = await getDb().unsafe<{ id: number }>(`
    SELECT r.id FROM entity_relationships r
    WHERE r.organization_id = $1 AND r.relationship_type_id = $2 AND r.deleted_at IS NULL
      AND ((${forward})${reverse}) ORDER BY r.id LIMIT 1`, params);
  if (!rows[0]) throw new ToolUserError(`No relationship of type "${args.relationship_type_slug}" between the specified entities`, 404);
  const resolved = Number(rows[0].id);
  if (namedId && namedId !== resolved) throw new ToolUserError('relationship_id and endpoints disagree; pass one or the other', 400);
  return resolved;
}

async function handleUnlink(
	args: Static<typeof UnlinkEntitiesAction>,
	ctx: ToolContext,
): Promise<ManageEntityResult> {
	const relationshipId = await resolveRelationshipId(args, ctx, "unlink");

  const sql = getDb();
  const [identity] = await sql`
    SELECT r.from_entity_id, r.to_entity_id, r.relationship_type_id, t.slug FROM entity_relationships r
    JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    WHERE r.id = ${relationshipId} AND r.organization_id = ${ctx.organizationId} AND t.purpose = 'identity'
  `;
  if (identity) {
    const attribution = await resolveAutomationAttribution(ctx, args.automation_source);
    return handleIdentityAssociation({ operation: 'unlink', relationship_id: relationshipId,
    entity_id: Number(identity.from_entity_id), to_entity_id: Number(identity.to_entity_id),
    relationship_type_id: Number(identity.relationship_type_id), relationship_type_slug: String(identity.slug),
    dry_run: args.dry_run, automation_id: attribution.automationId }, ctx, attribution.runId);
  }
  if (args.dry_run) throw new ToolUserError('Relationship dry_run requires purpose identity', 400);


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
					fromEntityTypeId: edge.fromEntityTypeId,
					toEntityTypeId: edge.toEntityTypeId,
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
					clientId: eventClientId(ctx),
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
	// Authorize the exact response before mutating. Unlink by id deliberately
	// remains available without reading a disconnected source.
	const readable = await getDb().unsafe<RelationshipRow>(`SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1 AND r.organization_id = $2 AND r.deleted_at IS NULL`, [relationshipId, ctx.organizationId]);
	const [authorized] = await readableRelationships(readable, ctx, await entityReadRestrictions(getDb(), ctx));
	if (!authorized) throw new ToolUserError('Relationship not found or not readable', 404);

  const sql = getDb();

	const updated = await sql.begin(async (tx) => {
		await lockOrganizationForSemanticEvent(tx, ctx.organizationId);
		const edge = await lockEdgeForMutation(
			tx,
			relationshipId,
			ctx.organizationId,
			"update_link",
		);
		if (edge.purpose === "identity") throw new ToolUserError("updateLink does not support identity associations; use unlink", 409);
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
					fromEntityId: edge.from_entity_id === null ? null : Number(edge.from_entity_id),
					toEntityId: edge.to_entity_id === null ? null : Number(edge.to_entity_id),
					fromEntityTypeId: edge.from_entity_type_id === null ? null : Number(edge.from_entity_type_id),
					toEntityTypeId: edge.to_entity_type_id === null ? null : Number(edge.to_entity_type_id),
					relationshipTypeId: Number(edge.relationship_type_id),
					relationshipTypeSlug: edge.relationship_type_slug,
					op: "update_link",
					changes,
					createdBy: ctx.userId,
					clientId: eventClientId(ctx),
				},
				tx,
			);
		}
		return relationship[0];
	});

	return { action: "update_link", relationship: {
		...updated,
		...(typeof updated.from_entity_id === 'string' ? { from_entity_name: authorized.from_entity_name } : {}),
		...(typeof updated.to_entity_id === 'string' ? { to_entity_name: authorized.to_entity_name } : {}),
	} };
}

async function handleListLinks(
  args: Static<typeof ListLinksAction>,
  ctx: ToolContext,
): Promise<ManageEntityResult> {
  // One deadline for the whole page, including both authored and native links.
  const deadline = AbortSignal.timeout(20_000);
  ctx = {
    ...ctx,
    abortSignal: ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, deadline]) : deadline,
  };
  const sql = getDb();
  let entityId = args.entity_id;
  let entityType = args.entity_type;
  if (args.record) {
    if (entityId !== undefined || entityType !== undefined) {
      throw new ToolUserError('Pass entity_id or record, not both', 400);
    }
    if (args.offset || args.include_deleted || args.source !== undefined || args.confidence_min !== undefined) {
      throw new ToolUserError('record cannot be combined with offset, include_deleted, source, or confidence_min', 400);
    }
    entityId = args.record.key;
    entityType = args.record.type;
    const [type] = await sql`
      SELECT metadata_schema FROM entity_types
      WHERE slug = ${entityType} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL
    `;
    // Undeclared views retain their read-only source-native adapter.
    if (!recordKeyColumn(type?.metadata_schema)) {
      await assertEntityReadAllowed(args, ctx, entityType);
      const native = await readNativeRelationshipPage(
        args, args.record, ctx, Math.min(Math.max(args.limit ?? 100, 1), 500), args.cursor,
      );
      return {
        action: 'list_links',
        record_links: native.links,
        record_failures: native.failures,
        next_cursor: native.next_cursor,
      };
    }
  }
  if (entityId === undefined) throw new ToolUserError('list_links needs entity_id', 400);
  const isSource = typeof entityId === 'string';
  if (!isSource && args.cursor !== undefined) {
    throw new ToolUserError('entity_id uses limit/offset; cursor requires a typed source key', 400);
  }
  if (isSource && args.offset) throw new ToolUserError('Source link pagination uses cursor', 400);
  if (isSource && (args.source !== undefined || args.confidence_min !== undefined || args.include_deleted)) {
    throw new ToolUserError('Source records do not support source, confidence_min, or include_deleted filters across live and authored links', 400);
  }
  const principal = await actingPrincipalFor(args, ctx);
  const restrictions = await entityReadRestrictions(sql, ctx, principal);
  const endpoint = await resolveEntityReference(entityId, entityType, ctx, { restrictions });
  if (endpoint.organizationId !== ctx.organizationId) {
    throw new ToolUserError('Entity not found in this workspace', 404);
  }
  const binding = JSON.stringify([
    ctx.organizationId,
    ctx.userId,
    ctx.agentId,
    ctx.actingAutomationId,
    entityType,
    entityId,
    args.direction,
    args.relationship_type_slug,
    args.source,
    args.confidence_min,
    args.include_deleted,
  ]);
  const cursor = parseRelationshipCursor(args.cursor, binding);
  const authored = await readAuthoredRelationshipPage(args, endpoint, ctx, restrictions, cursor);
  const result = {
    action: 'list_links' as const,
    relationships: authored.relationships,
    relationship_failures: authored.failures,
    counts_by_type: authored.counts,
    metadata: {
      limit: authored.limit,
      offset: authored.offset,
      has_more: authored.hasMore,
      counts_scope: 'page' as const,
    },
  };
  if (!isSource) return result;
  const native = cursor.sourceDone
    ? { links: [], failures: [], next_cursor: undefined }
    : await readNativeRelationshipPage(
      args, { type: endpoint.entityType, key: String(entityId) }, ctx, authored.limit, cursor.sourceCursor,
    );
  return {
    ...result,
    record_links: native.links,
    record_failures: native.failures,
    next_cursor: nextRelationshipCursor(cursor, authored, native),
  };
}
