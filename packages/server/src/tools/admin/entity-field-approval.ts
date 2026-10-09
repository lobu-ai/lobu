import { applyIdentityAssociationProposal, type IdentityAssociationProposal } from "../../utils/identity-association";
/**
 * Durable approval gate for entity mutations that need human review. Field
 * updates preserve human ownership through `mergeEntityFields`; held creates,
 * deletes, and identity associations use their normal paths after approval. Every
 * proposal is a pending internal run plus an approval event, so delivery and
 * decisions remain durable across replicas. Claim/approve/reject orchestration
 * lives in manage_operations next to `supersedeActionEvent`.
 */

import { deriveToolActorSource } from '../../utils/apply-context';
import { RESERVED_COLUMN_NAMES } from "../../authz/entity-row-validation";
import { SCOPE_CHECK_NOT_APPLICABLE } from "../../auth/tool-access";
import {
	type EntityTransactionHookContext,
	getEntityHooks,
} from "../../utils/entity-hooks";
import { createHash } from "node:crypto";
import {
	ApprovalAttribution,
	type ApprovalAttribution as ApprovalAttributionType,
} from "@lobu/core/contracts/interaction-envelope";
import { resolveEntityApprovalPolicy } from "../../authz/entity-policy";
import { resolveApprovalChatOrigin } from "./approval-delivery";
import { type DbClient, getDb } from "../../db/client";
import type { Env } from "../../index";
import {
	currentMcpActivityAttribution,
	currentMcpActivityEventMetadata,
} from "../../lobu/stores/mcp-client-conversations";
import { resolveActionOrigin } from "../../notifications/action-origin";
import {
	formatFieldChangeAction,
	formatLabel,
	notifyActionApprovalNeeded,
} from "../../notifications/triggers";
import type { FieldMergeResult } from "../../utils/entity-field-merge";
import {
	createEntity,
	deleteEntity,
	type EntityData,
	mergeEntityFields,
} from "../../utils/entity-management";
import { ToolUserError } from "../../utils/errors";
import {
	ApprovalKind,
	approvalContext,
	highApprovalImpact,
	normalApprovalImpact,
} from "../../utils/approval-context";
import {
	insertChangeEventInTransaction,
	insertEvent,
	stableJson,
} from "../../utils/insert-event";
import logger from "../../utils/logger";
import {
	buildEntityUrl,
	buildResourcePermalink,
} from "../../utils/url-builder";
import { resolveRunInitiator, runPermalinkResource } from "../initiator";
import type { ToolContext } from "../registry";
import { getOrgUrlContext } from "../view-urls";

/** Synthetic runs.action_key tagging an automation field-change held for approval. */
export const ENTITY_FIELD_CHANGE_ACTION_KEY = "entity_field_change";
export const ENTITY_CHANGE_ACTION_KEY = "entity_change";
export const ENTITY_CHANGE_ACTION_KEYS = [
	ENTITY_FIELD_CHANGE_ACTION_KEY,
	ENTITY_CHANGE_ACTION_KEY,
] as const;

/**
 * Internal signal: an escalated (atomic) card had at least one stale field, so
 * the whole apply must roll back rather than commit the remainder.
 *
 * Thrown from inside the apply transaction purely to unwind it — it never
 * escapes {@link applyEntityFieldChangeProposal}, which converts it into a
 * fully-stale {@link FieldMergeResult}. Throwing is what lets the atomicity
 * check reuse the merge's own staleness verdict instead of re-deriving it.
 */
class AtomicCardStaleError extends Error {
	constructor(readonly stale: FieldMergeResult["stale"]) {
		super(
			`approved card is stale: ${Object.keys(stale).join(", ")} changed since it was proposed`,
		);
		this.name = "AtomicCardStaleError";
	}
}

/** Proposed field changes held in runs.action_input for a field-change gate run. */
export interface EntityFieldChangeProposal {
	operation?: "update";
	entity_id: number;
	/** field_path -> proposed value (what the automation/agent wanted to write). */
	fields: Record<string, unknown>;
	/** field_path -> current human-owned value (for the diff card). */
	current?: Record<string, unknown>;
	automation_id?: number | null;
	/** Who proposed the change — drives the card label/author. Defaults to 'automation'. */
	attribution?: ApprovalAttributionType;
	reason?: string | null;
	/**
	 * The ONE human who owns every gated field (distinct
	 * `field_controls[field].set_by`), resolved at propose time. Drives
	 * owner-routed delivery (Slack DM tier) and lets that owner approve the run
	 * without an admin role. Absent for mixed/no owners — admin-only handling.
	 * Lives in action_input (not run_metadata) because the approve path and the
	 * Slack bridge already load action_input for the proposal; the dedupe SELECT
	 * compares the canonical change identity, so replays still collapse.
	 */
	owner_user_id?: string | null;
	/**
	 * Fields the RULE escalated when this card was minted — exactly what the
	 * approver is consenting to. Applying waives only these; an escalation the
	 * rule raises for the first time later still needs its own card.
	 */
	escalated_fields?: string[];
}

export interface EntityDeleteProposal {
	operation: "delete";
	entity_id: number;
	force_delete_tree?: boolean;
	current: {
		id: number;
		entity_type: string;
		name: string;
		slug?: string | null;
		parent_id?: number | null;
		metadata?: Record<string, unknown> | null;
	};
	automation_id?: number | null;
	attribution?: ApprovalAttributionType;
	reason?: string | null;
}

export interface EntityCreateProposal {
	operation: "create";
	entity_data: EntityData;
	proposal: Record<string, unknown>;
	automation_id?: number | null;
	attribution?: ApprovalAttributionType;
	reason?: string | null;
	/**
	 * Fields the RULE escalated when this card was minted — exactly what the
	 * approver is consenting to. Applying waives only these; an escalation the
	 * rule raises for the first time later still needs its own card.
	 */
	escalated_fields?: string[];
}

export type EntityChangeProposal =
	| IdentityAssociationProposal
	| EntityFieldChangeProposal
	| EntityDeleteProposal
	| EntityCreateProposal;

export function entityChangeOperation(
	proposal: EntityChangeProposal,
): "create" | "update" | "delete" | "link" | "unlink" {
	const operation = proposal.operation ?? "update";
	switch (operation) {
		case "create":
		case "update":
		case "delete":
		case "link":
		case "unlink":
			return operation;
		default:
			throw new ToolUserError(`Unsupported entity change operation: ${operation}`, 400);
	}
}

function asUpdateProposal(
	proposal: EntityChangeProposal,
): EntityFieldChangeProposal {
	if (proposal.operation === undefined || proposal.operation === "update") {
		return proposal;
	}
	throw new Error(`Expected update proposal, got ${proposal.operation}`);
}

function asDeleteProposal(
	proposal: EntityChangeProposal,
): EntityDeleteProposal {
	if (proposal.operation === "delete") return proposal;
	throw new Error(
		`Expected delete proposal, got ${proposal.operation ?? "update"}`,
	);
}

function asCreateProposal(
	proposal: EntityChangeProposal,
): EntityCreateProposal {
	if (proposal.operation === "create") return proposal;
	throw new Error(
		`Expected create proposal, got ${proposal.operation ?? "update"}`,
	);
}

function changedEntityId(proposal: EntityChangeProposal): number {
	if (proposal.operation === "create") {
		throw new Error("Create proposals do not have an existing entity id");
	}
	return proposal.entity_id;
}

function entityChangeIdempotencyKey(
	organizationId: string,
	parentRunId: number | null,
	proposal: EntityChangeProposal,
): string {
	const operation = entityChangeOperation(proposal);
	let change: Record<string, unknown>;
	switch (operation) {
		case "link":
		case "unlink":
			change = { proposal };
			break;
		case "update":
			change = {
				entityId: asUpdateProposal(proposal).entity_id,
				fields: asUpdateProposal(proposal).fields,
			};
			break;
		case "delete":
			change = {
				entityId: asDeleteProposal(proposal).entity_id,
				force: asDeleteProposal(proposal).force_delete_tree ?? false,
			};
			break;
		case "create":
			change = { entityData: asCreateProposal(proposal).entity_data };
			break;

	}
	const digest = createHash("sha256")
		.update(stableJson({ organizationId, parentRunId, operation, change }))
		.digest("hex");
	return `entity-change:${digest}`;
}
async function loadAutomationLabel(
	ctx: ToolContext,
	automationId: number | null | undefined,
	attribution: ApprovalAttributionType | undefined,
): Promise<{
	actorLabel: string;
	automationName: string | null;
	automationAgentId: string | null;
}> {
	if (attribution !== ApprovalAttribution.Automation) {
		return { actorLabel: "An agent", automationName: null, automationAgentId: null };
	}
	if (!automationId) {
		return { actorLabel: "An Automation", automationName: null, automationAgentId: null };
	}
	const rows = await getDb()<{
		name: string | null;
		managed_agent_id: string | null;
	}>`
    SELECT name, managed_agent_id
    FROM automations
    WHERE id = ${automationId}
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
	return {
		actorLabel: rows[0]?.name ?? `Automation ${automationId}`,
		automationName: rows[0]?.name ?? null,
		automationAgentId: rows[0]?.managed_agent_id ?? null,
	};
}

interface EntitySnapshot {
	id: number;
	name: string | null;
	entity_type: string | null;
	slug: string | null;
	parent_id: number | null;
	parent_slug: string | null;
	parent_entity_type: string | null;
}

async function loadEntitySnapshot(
	ctx: ToolContext,
	entityId: number,
): Promise<EntitySnapshot | null> {
	const rows = await getDb()<EntitySnapshot>`
    SELECT e.id, e.name, et.slug AS entity_type, e.slug, e.parent_id,
           parent.slug AS parent_slug, pet.slug AS parent_entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities parent ON e.parent_id = parent.id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    WHERE e.id = ${entityId}
      AND e.organization_id = ${ctx.organizationId}
  `;
	return rows[0] ?? null;
}

/**
 * The single human owner across a proposal's gated field paths, from
 * `entities.field_controls[field].set_by` (stamped on every human edit).
 * Exactly one distinct owner → that user; mixed owners or none → null
 * (admin-only routing/authority). Reserved $-attributes ($name/$parent_id/
 * $content) have no field_controls entry, so they contribute no owner.
 */
async function resolveProposalFieldOwner(
	organizationId: string,
	entityId: number,
	fieldPaths: string[],
): Promise<string | null> {
	const rows = await getDb()<{ field_controls: unknown }>`
    SELECT field_controls FROM entities
    WHERE id = ${entityId}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
	if (rows.length === 0) return null;
	const controls = (
		typeof rows[0].field_controls === "string"
			? JSON.parse(rows[0].field_controls)
			: (rows[0].field_controls ?? {})
	) as Record<string, { set_by?: string | null }>;
	const owners = new Set<string>();
	for (const path of fieldPaths) {
		const setBy = controls[path]?.set_by;
		if (setBy) owners.add(setBy);
	}
	return owners.size === 1 ? [...owners][0] : null;
}

/**
 * Queue an automation field-change for approval. Returns the pending run/event ids.
 * Called post-commit from the automation promotion path.
 */
export async function proposeEntityFieldChange(
	ctx: ToolContext,
	proposal: EntityFieldChangeProposal,
	parentRunId: number | null = null,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	const ownerUserId = await resolveProposalFieldOwner(
		ctx.organizationId,
		proposal.entity_id,
		Object.keys(proposal.fields),
	);
	return proposeEntityChange(ctx, {
		...proposal,
		...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
		operation: "update",
	}, parentRunId);
}

export async function proposeEntityDelete(
	ctx: ToolContext,
	proposal: Omit<EntityDeleteProposal, "operation">,
	parentRunId: number | null = null,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	return proposeEntityChange(ctx, { ...proposal, operation: "delete" }, parentRunId);
}

export async function proposeEntityCreate(
	ctx: ToolContext,
	proposal: Omit<EntityCreateProposal, "operation">,
	parentRunId: number | null = null,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	return proposeEntityChange(ctx, { ...proposal, operation: "create" }, parentRunId);
}

export async function proposeEntityChange(
	ctx: ToolContext,
	proposal: EntityChangeProposal,
	parentRunId: number | null = null,
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
	const sql = getDb();
	const operation = entityChangeOperation(proposal);
	const identityProposal = proposal.operation === "link" || proposal.operation === "unlink" ? proposal : null;
	const updateProposal =
		operation === "update" ? asUpdateProposal(proposal) : null;
	const deleteProposal =
		operation === "delete" ? asDeleteProposal(proposal) : null;
	const createProposal =
		operation === "create" ? asCreateProposal(proposal) : null;
	const actionKey =
		operation === "update"
			? ENTITY_FIELD_CHANGE_ACTION_KEY
			: ENTITY_CHANGE_ACTION_KEY;
	const idempotencyKey = entityChangeIdempotencyKey(
		ctx.organizationId,
		parentRunId,
		proposal,
	);
	const initiatorColumns = resolveRunInitiator(ctx);

	// Idempotency: complete_window is replay-safe (retries + concurrent replicas),
	// so the same blocked change can be proposed more than once. Collapse to one
	// active run — whether still pending or already applying — instead of stacking
	// duplicate cards or colliding with the global active-run idempotency index.
	// (Deletes match on force_delete_tree too: force and non-force are different
	// asks and must not affirm each other.)
	type ExistingChangeRun = {
		id: number;
		approval_status: string;
		status: string;
		pending_event_id: number | null;
		current_event_id: number | null;
	};
	const findExisting = (db: DbClient) => db<ExistingChangeRun>`
    SELECT r.id, r.approval_status, r.status,
           (SELECT e.id FROM current_event_records e
              WHERE e.run_id = r.id
                AND e.interaction_status = 'pending'
              ORDER BY e.id DESC LIMIT 1) AS pending_event_id,
           (SELECT e.id FROM current_event_records e
              WHERE e.run_id = r.id
                AND e.interaction_type = 'approval'
              ORDER BY e.id DESC LIMIT 1) AS current_event_id
    FROM runs r
    WHERE r.organization_id = ${ctx.organizationId}
      AND r.run_type = 'internal'
      AND r.action_key = ${actionKey}
      AND (
        (
          r.idempotency_key = ${idempotencyKey}
          AND r.status IN ('pending', 'claimed', 'running')
        )
        OR (
          r.idempotency_key IS NULL
          AND ${identityProposal === null}
          AND r.approval_status = 'pending'
          AND r.status = 'pending'
		  -- Same proposal from a different parent run is a distinct ask. This
		  -- semantic fallback repairs pending rows created before canonical keys.
		  AND r.parent_run_id IS NOT DISTINCT FROM ${parentRunId}
          AND COALESCE(r.action_input->>'operation', 'update') = ${operation}
          AND COALESCE(r.action_input->>'entity_id', '') = ${"entity_id" in proposal ? String(proposal.entity_id) : ""}
          AND (
            ${operation !== "update"}
            OR r.action_input->'fields' = ${sql.json(updateProposal?.fields ?? {})}::jsonb
          )
          AND (
            ${operation !== "delete"}
            OR COALESCE((r.action_input->>'force_delete_tree')::boolean, false) = ${deleteProposal?.force_delete_tree ?? false}
          )
          AND (
            ${operation !== "create"}
            OR r.action_input->'entity_data' = ${sql.json(createProposal?.entity_data ?? {})}::jsonb
          )
        )
      )
    ORDER BY (r.idempotency_key = ${idempotencyKey}) DESC, r.id DESC
    LIMIT 1
  `;

	const fieldKeys = updateProposal ? Object.keys(updateProposal.fields) : [];
	const fieldList = fieldKeys.join(", ");
	const attribution = proposal.attribution ?? ApprovalAttribution.Automation;
	const actorNoun =
		attribution === ApprovalAttribution.Agent ? "An agent" : "An Automation";
	const [{ actorLabel, automationName, automationAgentId }, entity] =
		await Promise.all([
			loadAutomationLabel(ctx, proposal.automation_id, attribution),
			operation === "create"
				? Promise.resolve(null)
				: loadEntitySnapshot(ctx, changedEntityId(proposal)),
		]);
	const entityType = createProposal
		? createProposal.entity_data.entity_type
		: entity?.entity_type;
	const entityName = createProposal
		? createProposal.entity_data.name
		: entity?.name;
	const actionLabel = identityProposal
		? `${operation === "link" ? "Associate" : "Separate"} identity records ${identityProposal.entity_id} and ${identityProposal.to_entity_id}`
		: operation === "update"
			? formatFieldChangeAction(entityType, fieldKeys)
			: operation === "delete"
				? `Delete ${entityType ? formatLabel(entityType).toLowerCase() : "entity"}`
				: `Create ${formatLabel(entityType ?? "entity").toLowerCase()}`;

	const insertApprovalEvent = (runId: number, db: DbClient) =>
		insertEvent(
			{
				entityIds: identityProposal ? [identityProposal.entity_id, identityProposal.to_entity_id] :
					operation === "create"
						? []
						: [changedEntityId(proposal)],
				organizationId: ctx.organizationId,
				originId: `run_${runId}_pending`,
				title: `${actionLabel} — pending approval`,
				content:
					proposal.reason ??
					(operation === "update"
						? `${actorNoun} proposed updating ${fieldList} on this entity.`
						: operation === "delete"
							? `${actorNoun} proposed deleting this entity.`
							: `${actorNoun} proposed creating this entity.`),
				semanticType: "operation",
				runId,
				// A proposal is something the Automation produced, so it belongs in the
				// Automation's produced feed and out of its own next window. Same source
				// the approval run itself is keyed on below (`runs.automation_id`), so the
				// event and its run can never disagree about who proposed this.
				// No version: the proposal carries none, and inventing the Automation's
				// CURRENT version here would misattribute a proposal made by an older
				// one.
				automationId: proposal.automation_id ?? null,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInput: proposal as unknown as Record<string, unknown>,
				metadata: {
					...approvalContext(
						ApprovalKind.Entity,
						operation === "delete"
							? highApprovalImpact(
									"This removes the entity from active workspace data.",
								)
							: normalApprovalImpact(),
					),
					tool: actionKey,
					action_key: actionKey,
					action: operation === "update" ? "change" : operation,
					entity_id: "entity_id" in proposal ? proposal.entity_id : null,
					fields: updateProposal ? updateProposal.fields : null,
					current: updateProposal
						? (updateProposal.current ?? null)
						: deleteProposal
							? deleteProposal.current
							: null,
					proposal: identityProposal ? { from_entity_id: identityProposal.entity_id, to_entity_id: identityProposal.to_entity_id, relationship_type: identityProposal.relationship_type_slug, records: identityProposal.current } : createProposal
						? createProposal.proposal
						: deleteProposal
								? {
										entity_id: deleteProposal.entity_id,
										entity_type:
											entity?.entity_type ?? deleteProposal.current.entity_type,
										name: entity?.name ?? deleteProposal.current.name,
										force_delete_tree:
											deleteProposal.force_delete_tree ?? false,
									}
								: null,
					automation_id: proposal.automation_id ?? null,
					automation_name: automationName,
					automation_agent_id: automationAgentId,
					// The producing run this proposal belongs to, if any. Stamped so the UI can
					// tell this proposal is part of a BATCH (the change-set card owns the
					// Approve/Reject decision) and suppress this card's own duplicate buttons.
					source_run_id: parentRunId,
					entity_name: entityName ?? null,
					entity_type: entityType ?? null,
					entity_slug: createProposal ? null : (entity?.slug ?? null),
					parent_slug: createProposal ? null : (entity?.parent_slug ?? null),
					parent_entity_type: createProposal
						? null
						: (entity?.parent_entity_type ?? null),
					attribution,
					initiator: {
						kind: initiatorColumns.initiatorKind,
						...initiatorColumns.initiatorRef,
					},
					reason: proposal.reason ?? null,
					status: "pending_approval",
					...currentMcpActivityEventMetadata(ctx),
				},
				authorName: attribution,
				clientId: ctx.tokenType === "oauth" ? (ctx.clientId ?? null) : null,
			},
			{ sql: db },
		);
	const reuseExisting = async (row: ExistingChangeRun, db: DbClient) => {
		await db`
			UPDATE runs
			SET idempotency_key = ${idempotencyKey}
			WHERE id = ${row.id} AND idempotency_key IS NULL
		`;
		const isPending =
			row.approval_status === "pending" && row.status === "pending";
		const eventId = isPending ? row.pending_event_id : row.current_event_id;
		if (eventId != null) {
			return {
				runId: Number(row.id),
				eventId: Number(eventId),
				reused: true,
			};
		}
		if (!isPending) {
			throw new Error(
				`Active entity change run ${row.id} has no approval event`,
			);
		}
		const event = await insertApprovalEvent(Number(row.id), db);
		return {
			runId: Number(row.id),
			eventId: Number(event.id),
			reused: false,
		};
	};

	const persisted = await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`;
		const existing = await findExisting(tx);
		if (existing.length > 0) {
			return reuseExisting(existing[0], tx);
		}

		const inserted = await tx<{ id: number }>`
			INSERT INTO runs (
				organization_id, run_type, action_key, action_input, parent_run_id,
				automation_id, created_by_user_id, initiator_kind, initiator_ref,
				approval_status, status, idempotency_key, created_at
			) VALUES (
				${ctx.organizationId}, 'internal', ${actionKey},
				${tx.json(proposal as unknown as Record<string, unknown>)},
				${parentRunId}, ${proposal.automation_id ?? null},
				${initiatorColumns.createdByUserId},
				${initiatorColumns.initiatorKind},
				${tx.json(initiatorColumns.initiatorRef)},
				'pending', 'pending', ${idempotencyKey}, current_timestamp
			)
			ON CONFLICT DO NOTHING
			RETURNING id
		`;
		if (inserted.length === 0) {
			const winner = await findExisting(tx);
			if (winner.length === 0) {
				throw new Error("Entity change idempotency conflict has no active run");
			}
			return reuseExisting(winner[0], tx);
		}

		const runId = Number(inserted[0].id);
		const event = await insertApprovalEvent(runId, tx);
		return { runId, eventId: Number(event.id), reused: false };
	});
	const { runId, eventId } = persisted;

	const [permalinkRun] = await sql<{
		initiator_kind: string | null;
		initiator_ref: Record<string, unknown> | null;
		initiator_agent_id: string | null;
	}>`
		SELECT r.initiator_kind, r.initiator_ref, w.managed_agent_id AS initiator_agent_id
		FROM runs r
		LEFT JOIN automations w
			ON w.id = r.automation_id AND w.organization_id = r.organization_id
		WHERE r.id = ${runId} AND r.organization_id = ${ctx.organizationId}
	`;
	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	// Run-scoped: the pending event is superseded on approve→complete; a run link
	// stays valid across the chain. (Read-side content_ids resolution also covers
	// the event id below, carried for the notification's resourceId.)
	// An Automation-initiated proposal lands on that Automation's drill-down instead
	// of the workspace-wide log, so the link answers where it came from.
	const approvalUrl = buildResourcePermalink(
		ownerSlug,
		runPermalinkResource(
			{
				initiatorKind: permalinkRun?.initiator_kind,
				initiatorRef: permalinkRun?.initiator_ref,
			},
			runId,
			permalinkRun?.initiator_agent_id,
		),
		baseUrl,
	);
	if (persisted.reused) return { runId, eventId, approvalUrl };
	const entityUrl =
		ownerSlug && entity?.entity_type && entity.slug
			? buildEntityUrl(
					{
						ownerSlug,
						entityType: entity.entity_type,
						slug: entity.slug,
						parentType: entity.parent_entity_type ?? null,
						parentSlug: entity.parent_slug ?? null,
					},
					baseUrl,
				)
			: undefined;
	// A single-field update can match a field-scoped delivery target; a
	// multi-field one falls back to the entity/type/global row rather than
	// arbitrarily routing by the first field.
	const approvalPolicy = await resolveEntityApprovalPolicy({
		organizationId: ctx.organizationId,
		entityTypeSlug: entityType ?? null,
		entityId:
			"entity_id" in proposal && typeof proposal.entity_id === "number"
				? proposal.entity_id
				: null,
		fieldPath:
			updateProposal && fieldKeys.length === 1 ? (fieldKeys[0] ?? null) : null,
	});
	// The policy's configured channel wins; otherwise the conversation that asked.
	// Either way this is a targeted delivery — the trigger never falls back to the
	// org-wide fan-out.
	const deliveryTarget =
		approvalPolicy.deliveryTarget.connectionId ||
		approvalPolicy.deliveryTarget.channelId
			? approvalPolicy.deliveryTarget
			: await resolveApprovalChatOrigin(ctx);
	const actionOrigin = await resolveActionOrigin(ctx);

	notifyActionApprovalNeeded({
		orgId: ctx.organizationId,
		runId,
		actionKey,
		connectionName: actionLabel,
		eventId,
		approvalUrl,
		connectionId: deliveryTarget.connectionId,
		channelId: deliveryTarget.channelId,
		teamId: deliveryTarget.teamId,
		ownerUserId: updateProposal?.owner_user_id ?? null,
		requesterUserId: ctx.userId ?? null,
		mcpActivity: currentMcpActivityAttribution(ctx),
		actionOrigin,
		details:
			operation === "update"
				? {
						kind: "entity_field_change",
						actorLabel,
						entityId: updateProposal?.entity_id ?? null,
						entityType: entity?.entity_type ?? null,
						entityName: entity?.name ?? null,
						entityUrl,
						fields: updateProposal?.fields ?? {},
						current: updateProposal?.current ?? null,
						reason: proposal.reason ?? null,
					}
				: {
						kind: "entity_change",
						operation,
						actorLabel,
						entityId:
							identityProposal?.entity_id ?? deleteProposal?.entity_id ?? null,
						entityType: entityType ?? null,
						entityName: entityName ?? null,
						entityUrl,
						proposal: identityProposal ? { from_entity_id: identityProposal.entity_id, to_entity_id: identityProposal.to_entity_id, relationship_type: identityProposal.relationship_type_slug, records: identityProposal.current } : deleteProposal
								? {
										entity_id: deleteProposal.entity_id,
										entity_type:
											entity?.entity_type ?? deleteProposal.current.entity_type,
										name: entity?.name ?? deleteProposal.current.name,
										force_delete_tree:
											deleteProposal.force_delete_tree ?? false,
									}
								: (createProposal?.proposal ?? null),
						current: deleteProposal?.current ?? null,
						reason: proposal.reason ?? null,
					},
	}).catch((error) =>
		logger.error(error, "Failed to send entity change approval notification"),
	);

	return { runId, eventId, approvalUrl };
}

/** Reserved $-prefixed proposal keys that map to entity ATTRIBUTES, not metadata. */
const ATTRIBUTE_FIELD_KEYS = new Set(["$name", "$parent_id", "$content"]);

/**
 * Apply an approved field-change proposal. The approver endorsed the value, so
 * metadata fields are written AND marked human-owned via
 * mergeEntityFields(source='human'). Reserved $-attribute keys ($name,
 * $parent_id, $content) write the entity attribute directly — with the same
 * staleness guard: an attribute a human changed after the proposal was queued
 * is left alone.
 */
export async function applyEntityFieldChangeProposal(
	proposal: EntityFieldChangeProposal,
	approverUserId: string | null,
	db: DbClient = getDb(),
): Promise<FieldMergeResult> {
	const sql = db;
	const metadataFields = Object.fromEntries(
		Object.entries(proposal.fields).filter(
			([key]) => !ATTRIBUTE_FIELD_KEYS.has(key),
		),
	);
	const attributeFields = Object.fromEntries(
		Object.entries(proposal.fields).filter(([key]) =>
			ATTRIBUTE_FIELD_KEYS.has(key),
		),
	);
	const apply = async (tx: DbClient): Promise<FieldMergeResult> => {
		// Resolve and claim the organization parent before mergeEntityFields locks
		// the entity. The canonical event insert below takes the same FK lock, and
		// this order avoids deadlocking with organization deletion's parent-first
		// cascade.
		const [scope] = await tx<{ organization_id: string; entity_type: string }>`
			SELECT e.organization_id, et.slug AS entity_type FROM entities e JOIN entity_types et ON et.id = e.entity_type_id
			WHERE e.id = ${proposal.entity_id} AND e.deleted_at IS NULL
		`;
		if (!scope) {
			throw new ToolUserError(`Entity ${proposal.entity_id} not found`, 404);
		}
		const hooks = getEntityHooks(scope.entity_type);
		// Applying a proposal is human-gated upstream (requireHumanApprovalContext),
		// so the caller carries no MCP scope dimension — the same sentinel every
		// session-authenticated path passes.
		const hookContext: EntityTransactionHookContext = {
			organizationId: scope.organization_id,
			userId: approverUserId,
			sql: tx,
			scopes: SCOPE_CHECK_NOT_APPLICABLE,
			actorSource: 'ui',
		};
		await hooks?.beforeUpdate?.(metadataFields, hookContext);
		await tx`
			SELECT 1 FROM organization
			WHERE id = ${scope.organization_id}
			FOR KEY SHARE
		`;
		// Only an afterUpdate hook needs the pre-image; entity types without one
		// must not pay for a second lock on the row mergeEntityFields already locks.
		const before = hooks?.afterUpdate
			? (
					await tx<{ metadata: Record<string, unknown> | null }>`
						SELECT metadata FROM entities
						WHERE id = ${proposal.entity_id}
						FOR UPDATE
					`
				)[0]
			: undefined;
		// Plan metadata and attributes from the same locked pre-image and validate
		// their combined result once. A valid metadata/name transition must not be
		// judged against a temporary row containing only half of the approved edit.
		const merge = await mergeEntityFields({
			tx,
			entityId: proposal.entity_id,
			fields: metadataFields,
			attributes: attributeFields,
			source: "human",
			actorId: approverUserId,
			note: proposal.reason ?? null,
			expectedCurrent: proposal.current ?? null,
			approvedFields: proposal.escalated_fields ?? [],
			beforePersist: (planned) => {
				// An escalated card is one reviewed unit. Reject drift before rules
				// see an unapproved fragment; ordinary ownership cards retain their
				// existing per-field consent and may apply the fields still current.
				if ((proposal.escalated_fields?.length ?? 0) > 0 &&
					Object.keys(planned.stale).length > 0) {
					throw new AtomicCardStaleError(planned.stale);
				}
			},
		});
		const appliedChanges = Object.entries(merge.applied).map(
			([field, value]) => ({ field, old: value.old, new: value.new }),
		);
		if (appliedChanges.length > 0) {
			if (hooks?.afterUpdate && before) {
				const [after] = await tx<{
					metadata: Record<string, unknown> | null;
				}>`
					SELECT metadata FROM entities WHERE id = ${proposal.entity_id}
				`;
				await hooks.afterUpdate(
					{ id: proposal.entity_id, metadata: before.metadata },
					{ id: proposal.entity_id, metadata: after.metadata },
					hookContext,
				);
			}
			const [entity] = await tx<{ name: string }>`
				SELECT name FROM entities
				WHERE id = ${proposal.entity_id} AND deleted_at IS NULL
			`;
			if (!entity) {
				throw new ToolUserError(`Entity ${proposal.entity_id} not found`, 404);
			}
			await insertChangeEventInTransaction(
				{
					entityIds: [proposal.entity_id],
					organizationId: scope.organization_id,
					subject: "entity",
					op: "updated",
					title: `Entity updated: ${appliedChanges.map((change) => change.field).join(", ")}`,
					content: `Approved entity update applied to "${entity.name}" (id: ${proposal.entity_id}).`,
					metadata: { changes: appliedChanges, approval_applied: true },
					createdBy: approverUserId,
				},
				tx,
			);
		}
		return merge;
	};
	// A stale escalated card is converted into a successful "skipped" result.
	// When this function joins the approval's outer transaction, that conversion
	// must happen outside a savepoint so every write from the stale attempt is
	// rolled back before the outer transaction continues to its terminal card.
	const transaction =
		typeof sql.savepoint === "function" ? sql.savepoint(apply) : sql.begin(apply);
	return await transaction.catch((err) => {
		// Not an apply failure: nothing was wrong with the write, the reviewed
		// unit simply no longer describes the row. Resolve as fully stale so the
		// caller reports "skipped (stale)" and the newer human value stands.
		if (err instanceof AtomicCardStaleError) {
			return {
				changed: false,
				applied: {},
				blocked: {},
				stale: err.stale,
				affirmed: [],
				nextMetadata: {},
				nextControls: {},
			} satisfies FieldMergeResult;
		}
		throw err;
	});
}

export async function applyEntityChangeProposal(
	proposal: EntityChangeProposal,
	ctx: ToolContext,
	env: Env,
	db: DbClient,
	postCommitEffects?: Array<() => Promise<void>>,
): Promise<unknown> {
	const operation = entityChangeOperation(proposal);
	if (proposal.operation === "link" || proposal.operation === "unlink") {
		return applyIdentityAssociationProposal(db, proposal, ctx);
	}
	if (operation === "update") {
		return applyEntityFieldChangeProposal(
			asUpdateProposal(proposal),
			ctx.userId ?? null,
			db,
		);
	}
	if (operation === "create") {
		const createProposal = asCreateProposal(proposal);
		return createEntity(
			{
				...createProposal.entity_data,
				organization_id: ctx.organizationId,
				// The automation that PROPOSED the create is not a real user row, so
				// entities.created_by (NOT NULL, FK → user) must attribute the create to
				// the human who APPROVED it. Approval is human-gated (requireHuman-
				// ApprovalContext), so ctx.userId is a verified user here — using it
				// avoids the "system" fallback that fails the FK.
				created_by: ctx.userId ?? createProposal.entity_data.created_by,
			},
			{
				sql: db,
				hookContext: {
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					scopes: ctx.scopes,
					actorSource: deriveToolActorSource(ctx),
					env,
					deferAfterCommit: postCommitEffects
						? (effect) => postCommitEffects.push(effect)
						: undefined,
				},
				// This IS the approval, scoped to what the card showed. A `deny` still
				// throws: approval cannot make an illegal row legal.
				approvedFields: createProposal.escalated_fields ?? [],
			},
		);
	}
	const deleteProposal = asDeleteProposal(proposal);
	// The grant comes from the write this card REPLAYS. A delete card's entire
	// content is the delete, so `$deleted` — and only `$deleted` — is what the
	// human approved. Without it a rule that escalates on the delete is a dead
	// end: the card is minted, a human approves, and applying re-runs the rule,
	// escalates again, and throws. An escalate naming anything else is still not
	// covered and still stops the apply, which is the point of a scoped grant.
	return deleteEntity(
		deleteProposal.entity_id,
		deleteProposal.force_delete_tree ?? false,
		env,
		ctx,
		{
			sql: db,
			approvedFields: [RESERVED_COLUMN_NAMES.softDelete],
		},
	);
}
