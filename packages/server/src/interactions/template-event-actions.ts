import { isDeepStrictEqual } from "node:util";
import type { ViewActionDecl } from "@lobu/core/contracts/tools/manage-views";
import {
	attachesToEntityType,
	isEventAttachment,
} from "@lobu/core/contracts/tools/view-attach";
import {
	collectTemplateActionInvocations,
	type TemplateActionInvocation,
	type TemplateInteractionDefinition,
	type TemplateInteractionRegistry,
} from "@lobu/core/json-template";
import { type DbClient, getDb, parsePgNumberArray } from "../db/client";
import { getPlatformDescriptor } from "../gateway/connections/platforms/index.js";
import { resolveEntityRender } from "../utils/default-entity-template";
import { ToolUserError } from "../utils/errors";
import {
	resolveEventKindData,
	resolveEventKindDefinition,
	validateSaveContentSemanticType,
} from "../utils/event-kind-validation";
import {
	insertConnectionlessWorkspaceEvent,
	insertEntityUpdatedEventInTransaction,
} from "../utils/insert-event";
import { emit } from "../events/emitter";
import {
	getView,
	isValidViewKey,
	type StoredView,
	VIEW_ACTION_NAME_RE,
} from "../views/views";
import {
	entityReadRestrictions,
	filterEntityReadRows,
} from "../authz/entity-read-policy";
import type { DeferredMutation } from "../authz/entity-mutation-gate";
import { updateEntity } from "../utils/entity-management";
import { readEntityStamps } from "../utils/entity-stamps";
import { exceedsValidationLimits } from "../utils/metadata-limits";
import { validateEntityMetadata } from "../utils/schema-validation";
import { AUDIT_SEMANTIC_TYPE } from "../tools/constants";
import { resolveEventViewSubject } from "../views/event-subject";
import type { Env } from "../index";
import type { ToolContext } from "../tools/registry";

const TEMPLATE_EVENT_ACTION_PREFIX = "event-action";
const ACTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const INTERACTION_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_VALUE_LENGTH = 1_000;

export interface TrustedTemplateActor {
	/** Host whose authentication produced this identity. */
	platform: string;
	/** Platform identity (Google/Slack user id, or Lobu user id on web/MCP). */
	platformUserId: string;
	/** Lobu user id when this surface has one; used for events.created_by. */
	userId?: string | null;
	name?: string | null;
}

export interface TemplateActionSource {
	connectionId?: string | null;
	messageId?: string | null;
	threadId?: string | null;
	clientId?: string | null;
}

export interface InvokeTemplateEventActionParams
	extends TemplateActionInvocation {
	organizationId: string;
	sourceEventId: number;
	interactionId: string;
	surface: string;
	actor: TrustedTemplateActor;
	source?: TemplateActionSource;
}

/** Entity fields a view action committed, server-stamped fields included. */
export interface ViewActionApplied {
	entity_id: number;
	fields: Record<string, unknown>;
}

/** Proposed field values the mutation gate held for an approval. */
export interface ViewActionPendingApproval {
	entity_id: number;
	fields: Record<string, unknown>;
}

export interface InvokedTemplateEventAction {
	created: boolean;
	/** The action's receipt: the emitted event, or an `audit` row when a view
	 * action only updates an entity. */
	eventId: number;
	eventType: string;
	applied?: ViewActionApplied;
	pendingApproval?: ViewActionPendingApproval;
}

/** A declared view action shares the existing receipt and activation path.
 * Event-bound actions additionally validate their readable source version.
 * An accepted retry returns its receipt even after the declaration changes. */
export interface InvokeViewActionParams {
	/** Trusted caller context is required to resolve an event-bound action. */
	event?: { id: number; env: Env; ctx: ToolContext };
	organizationId: string;
	viewKey: string;
	/**
	 * The content hash of the bundle the caller mounted. When given, the action
	 * runs only against that same bundle: a view re-applied since it was opened
	 * answers 409, so a click never runs under a definition the user did not
	 * see. Only the latest hash is stored, so there is nothing older to run.
	 */
	expectedContentHash?: string;
	action: string;
	value: Record<string, unknown> | null;
	/**
	 * Metadata values the caller read, for an action that `updates` an entity.
	 * Checked under the target's row lock; a mismatch writes nothing (409).
	 */
	expected?: Record<string, unknown>;
	/**
	 * The authenticated caller an `updates` action writes as. Required for it;
	 * identity always comes from the host's session, never the request body.
	 */
	caller?: { env: Env; ctx: ToolContext };
	interactionId: string;
	surface: string;
	actor: TrustedTemplateActor;
	source?: TemplateActionSource;
}

type ActionParams = InvokeTemplateEventActionParams | InvokeViewActionParams;

function actionIdempotencyKey(params: ActionParams): string {
	const source = "sourceEventId" in params
		? `event-action:${params.sourceEventId}`
		: `view-action:${params.viewKey}`;
	return `${source}:${params.surface}:${params.interactionId}`;
}

/** A receipt proves an earlier acceptance, not permission to execute a new action. */
async function acceptedAction(params: ActionParams): Promise<InvokedTemplateEventAction | null> {
	const key = actionIdempotencyKey(params);
	const [row] = await getDb()<{
		id: number; origin_id: string; origin_type: string; semantic_type: string;
		created_by: string | null; metadata: unknown;
	}>`
    SELECT id, origin_id, origin_type, semantic_type, created_by, metadata
    FROM events
    WHERE organization_id = ${params.organizationId}
      AND metadata ? '_lobu_idempotency_key'
      AND metadata->>'_lobu_idempotency_key' = ${key}
    LIMIT 1
  `;
	if (!row) return null;
	const interaction = record(record(row.metadata).interaction);
	const actor = record(interaction.actor);
	const source = params.source;
	const messagePinsDelivery = source?.messageId
		? getPlatformDescriptor(params.surface)?.messageIdIdentifiesMessage?.(source.messageId) === true
		: false;
	const sameSubject = "sourceEventId" in params
		? row.origin_type === "template_interaction" && interaction.source_event_id === params.sourceEventId
		: row.origin_type === "view_interaction" && interaction.view === params.viewKey
			&& (interaction.source_event_id ?? null) === (params.event?.id ?? null);
	// JSONB stores the JSON value, so compare the same representation for view payloads.
	const value = params.value === null ? null : JSON.parse(JSON.stringify(params.value));
	const expected = "expected" in params && params.expected !== undefined
		? JSON.parse(JSON.stringify(params.expected))
		: null;
	if (!sameSubject || row.origin_id !== key ||
		interaction.action !== params.action || interaction.surface !== params.surface ||
		interaction.interaction_id !== params.interactionId || !isDeepStrictEqual(interaction.value, value) ||
		!isDeepStrictEqual(interaction.expected ?? null, expected) ||
		actor.platform !== params.actor.platform || actor.id !== params.actor.platformUserId ||
		(row.created_by ?? null) !== (params.actor.userId ?? null) ||
		(interaction.connection_id ?? null) !== (source?.connectionId || null) ||
		(interaction.message_id ?? null) !== (source?.messageId || null) ||
		(!messagePinsDelivery && (interaction.thread_id ?? null) !== (source?.threadId || null))) {
		throw new ToolUserError("This interaction id was already used for a different action, actor, value, or delivery.", 409);
	}
	const result = record(interaction.result);
	return {
		created: false,
		eventId: Number(row.id),
		eventType: row.semantic_type,
		...(result.applied ? { applied: result.applied as ViewActionApplied } : {}),
		...(result.pending_approval
			? { pendingApproval: result.pending_approval as ViewActionPendingApproval }
			: {}),
	};
}

async function replayableAction(
	params: ActionParams,
	write: (key: string) => Promise<InvokedTemplateEventAction>,
): Promise<InvokedTemplateEventAction> {
	const accepted = await acceptedAction(params);
	if (accepted) return accepted;
	let result: InvokedTemplateEventAction;
	try {
		result = await write(actionIdempotencyKey(params));
	} catch (error) {
		// Acceptance may race source replacement or a lost acknowledgement.
		const concurrent = await acceptedAction(params);
		if (concurrent) return concurrent;
		throw error;
	}
	if (result.created) return result;
	// A concurrent writer may have claimed the key after our first read.
	const concurrent = await acceptedAction(params);
	if (concurrent) return concurrent;
	throw new ToolUserError("The accepted interaction could not be reconciled.", 409);
}

/** View action payloads ride as JSON (e.g. `{ id }`), not rendered strings. */
const MAX_VIEW_VALUE_JSON_LENGTH = 4_000;

function validateViewInvocation(params: InvokeViewActionParams): void {
	if (!isValidViewKey(params.viewKey)) {
		throw new ToolUserError("Invalid view key", 400);
	}
	if (!VIEW_ACTION_NAME_RE.test(params.action)) {
		throw new ToolUserError("Invalid view action name", 400);
	}
	if (!INTERACTION_ID.test(params.interactionId)) {
		throw new ToolUserError("interaction_id has an invalid format", 400);
	}
	if (!params.actor.platformUserId.trim()) {
		throw new ToolUserError("A verified interaction actor is required", 401);
	}
	if (
		params.value !== null &&
		JSON.stringify(params.value).length > MAX_VIEW_VALUE_JSON_LENGTH
	) {
		throw new ToolUserError(
			`Interaction value exceeds ${MAX_VIEW_VALUE_JSON_LENGTH} characters`,
			400,
		);
	}
	if (params.expected !== undefined) {
		if (
			!params.expected ||
			typeof params.expected !== "object" ||
			Array.isArray(params.expected) ||
			Object.keys(params.expected).length > MAX_VIEW_EXPECTED_KEYS ||
			JSON.stringify(params.expected).length > MAX_VIEW_VALUE_JSON_LENGTH
		) {
			throw new ToolUserError(
				`expected must be an object of at most ${MAX_VIEW_EXPECTED_KEYS} metadata fields under ${MAX_VIEW_VALUE_JSON_LENGTH} characters`,
				400,
			);
		}
	}
}

/** Same bound as an entity update's `expected`. */
const MAX_VIEW_EXPECTED_KEYS = 50;

export async function invokeViewAction(
	params: InvokeViewActionParams,
): Promise<InvokedTemplateEventAction> {
	validateViewInvocation(params);
	const result = await replayableAction(params, (key) => appendViewAction(params, key));
	// A retried acknowledgement should still let the caller refresh its view.
	emit(params.organizationId, { keys: [`view:${params.viewKey}`] });
	return result;
}

async function appendViewAction(
	params: InvokeViewActionParams,
	idempotencyKey: string,
): Promise<InvokedTemplateEventAction> {
	const view = await getView(params.organizationId, params.viewKey);
	if (!view) {
		throw new ToolUserError(`Unknown view: ${params.viewKey}`, 404);
	}
	if (
		params.expectedContentHash !== undefined &&
		params.expectedContentHash !== view.content_hash
	) {
		throw new ToolUserError(
			"This view changed since it was opened. Reload it before submitting.",
			409,
		);
	}
	// Stored JSON, so read each half defensively: a hand-edited row must not
	// turn a malformed declaration into a write.
	const declared = Object.hasOwn(view.actions ?? {}, params.action)
		? view.actions[params.action]
		: undefined;
	const emits =
		typeof declared?.emits === "string" && declared.emits ? declared.emits : null;
	const updates = declaredUpdates(declared);
	if (!emits && !updates) {
		throw new ToolUserError(
			`View "${params.viewKey}" does not declare action "${params.action}"`,
			403,
		);
	}
	if (!updates && params.expected !== undefined) {
		throw new ToolUserError(
			"expected applies only to a view action that updates an entity.",
			400,
		);
	}

	if (!params.event && view.attach.length > 0 && view.attach.every(isEventAttachment)) {
		throw new ToolUserError("This view action requires its event subject.", 400);
	}
	const subject = params.event
		? await resolveEventViewSubject(view, params.event.id, params.event.env, params.event.ctx)
		: null;
	if (subject && Number(subject.id) !== params.event?.id) {
		throw new ToolUserError("This event has been replaced. Reopen it before submitting.", 409);
	}
	const target = updates ? await resolveViewWriteTarget(params, view, updates) : null;
	const entityIds = [
		...new Set([...(subject?.entity_ids ?? []), ...(target ? [target.entityId] : [])]),
	];

	const interactionEnvelope = {
		action: params.action,
		value: params.value,
		...(params.expected !== undefined ? { expected: params.expected } : {}),
		interaction_id: params.interactionId,
		surface: params.surface,
		actor: {
			platform: params.actor.platform,
			id: params.actor.platformUserId,
			...(params.actor.name ? { name: params.actor.name } : {}),
		},
		view: view.key,
		...(subject ? { source_event_id: subject.id, source_origin_id: subject.origin_id } : {}),
		...(params.source?.connectionId
			? { connection_id: params.source.connectionId }
			: {}),
		...(params.source?.messageId ? { message_id: params.source.messageId } : {}),
		...(params.source?.threadId ? { thread_id: params.source.threadId } : {}),
	};
	const eventData = {
		view: view.key,
		action: params.action,
		value: params.value,
		interaction: interactionEnvelope,
	};
	// Event actions inherit the authorized source entities; payload fields
	// cannot invent this context.
	if (emits) {
		const kindValidation = await validateSaveContentSemanticType(
			emits,
			eventData,
			params.organizationId,
			entityIds,
		);
		if (!kindValidation.valid) {
			throw new ToolUserError(kindValidation.errors.join("\n"), 422);
		}
	}

	// The entity write, its change event and the receipt commit together: a
	// failed precondition, a denial or a lost receipt race leaves none of them.
	const committed = await getDb().begin(async (tx) => {
		const write = target ? await applyViewWrite(tx, params, view, target) : null;
		const inserted = await insertConnectionlessWorkspaceEvent(
			{
				entityIds,
				organizationId: params.organizationId,
				originId: idempotencyKey,
				title: `${view.name}: ${params.action}`,
				payloadType: "empty",
				// An updates-only action has no domain event to emit, so its receipt
				// is an operational audit row.
				semanticType: emits ?? AUDIT_SEMANTIC_TYPE,
				originType: "view_interaction",
				parentOriginId: null,
				authorName: params.actor.name ?? null,
				createdBy: params.actor.userId ?? null,
				clientId: params.source?.clientId ?? null,
				metadata: {
					...eventData,
					interaction: {
						...interactionEnvelope,
						...(write ? { result: write.result } : {}),
					},
				},
			},
			idempotencyKey,
			{ sql: tx },
		);
		return { inserted, write };
	});
	// Like manage_entity, the approval card is queued after the write commits
	// so it never rides, nor rolls back with, the accepted action.
	if (committed.write?.deferred && params.caller) {
		await committed.write.deferred.queue(params.caller.ctx, params.caller.env);
	}
	const result = committed.write?.result;
	return {
		created: committed.inserted.change !== "unchanged",
		eventId: committed.inserted.id,
		eventType: emits ?? AUDIT_SEMANTIC_TYPE,
		...(result?.applied ? { applied: result.applied } : {}),
		...(result?.pending_approval ? { pendingApproval: result.pending_approval } : {}),
	};
}

type ViewActionUpdates = NonNullable<ViewActionDecl["updates"]>;

function declaredUpdates(declared: ViewActionDecl | undefined): ViewActionUpdates | null {
	const updates = declared?.updates;
	if (
		!updates ||
		typeof updates.entityType !== "string" ||
		!updates.entityType ||
		!Array.isArray(updates.fields) ||
		updates.fields.length === 0 ||
		!updates.fields.every((field) => typeof field === "string" && field.length > 0)
	) {
		return null;
	}
	return updates;
}

interface ViewWriteTarget {
	entityId: number;
	set: Record<string, unknown>;
	stamps: Readonly<Record<string, string>>;
}

/**
 * Authorize one entity patch against the CURRENT view declaration. The write's
 * grant is the declaration (owner/admin authored); the caller still needs to
 * read the target. No record subject reaches the server for a view action, so
 * the target is bound by the view's attachment, not by the page it was on.
 */
async function resolveViewWriteTarget(
	params: InvokeViewActionParams,
	view: StoredView,
	updates: ViewActionUpdates,
): Promise<ViewWriteTarget> {
	const caller = params.caller;
	if (!caller) {
		throw new ToolUserError(
			"A signed-in Lobu user is required for a view action that updates an entity.",
			401,
		);
	}
	const value = params.value ?? {};
	const entityId = value.entity_id;
	if (typeof entityId !== "number" || !Number.isSafeInteger(entityId) || entityId <= 0) {
		throw new ToolUserError("value.entity_id must name the entity to update.", 400);
	}
	const rawSet = value.set;
	if (!rawSet || typeof rawSet !== "object" || Array.isArray(rawSet)) {
		throw new ToolUserError("value.set must be an object of field values.", 400);
	}
	const set = { ...(rawSet as Record<string, unknown>) };
	const fields = Object.keys(set);
	if (fields.length === 0) {
		throw new ToolUserError("value.set must name at least one field.", 400);
	}
	if (exceedsValidationLimits(set)) {
		throw new ToolUserError("value.set exceeds size/nesting limits.", 400);
	}
	const undeclared = fields.filter((field) => !updates.fields.includes(field));
	if (undeclared.length > 0) {
		throw new ToolUserError(
			`View "${view.key}" action "${params.action}" does not declare ${undeclared.join(", ")}.`,
			403,
		);
	}

	const db = getDb();
	const [row] = await db<{ slug: string; metadata: unknown; stamps: unknown }>`
    SELECT et.slug, e.metadata, et.metadata_schema -> 'x-lobu-stamps' AS stamps
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${entityId}
      AND e.organization_id = ${params.organizationId}
      AND e.deleted_at IS NULL
  `;
	const notFound = () => new ToolUserError(`Entity ${entityId} not found`, 404, "NOT_FOUND");
	if (!row) throw notFound();
	// The caller's own read policy decides visibility; a hidden row reads as missing.
	const restrictions = await entityReadRestrictions(db, caller.ctx);
	if ((await filterEntityReadRows(db, [{ id: entityId }], restrictions)).length === 0) {
		throw notFound();
	}
	if (row.slug !== updates.entityType) {
		throw new ToolUserError(
			`View "${view.key}" action "${params.action}" updates ${updates.entityType}, not ${row.slug}.`,
			403,
		);
	}
	if (!attachesToEntityType(view.attach, row.slug, entityId)) {
		throw new ToolUserError(
			`View "${view.key}" does not attach to this ${row.slug}.`,
			403,
		);
	}
	const stamps = readEntityStamps(row.stamps);
	const stamped = fields.filter((field) => Object.hasOwn(stamps, field));
	if (stamped.length > 0) {
		throw new ToolUserError(
			`${stamped.join(", ")} ${stamped.length === 1 ? "is" : "are"} stamped by the server and cannot be set.`,
			403,
		);
	}

	// Validate against the type's schema exactly as an entity update does:
	// null clears a field, so validate the merged state without cleared keys,
	// then keep the schema's coercions for the submitted fields only.
	const metadata = (
		typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata ?? {})
	) as Record<string, unknown>;
	const candidate = Object.fromEntries(
		Object.entries({ ...metadata, ...set }).filter(([, field]) => field !== null),
	);
	const validation = await validateEntityMetadata(row.slug, candidate, caller.ctx);
	if (!validation.valid) {
		const errors = validation.errors?.map((error) => error.message).join("; ") ?? "Invalid metadata";
		throw new ToolUserError(`Metadata validation failed: ${errors}`, 400);
	}
	for (const field of fields) {
		if (set[field] !== null) set[field] = candidate[field];
	}
	return { entityId, set, stamps };
}

interface ViewWrite {
	result: {
		applied?: ViewActionApplied;
		pending_approval?: ViewActionPendingApproval;
	};
	deferred?: DeferredMutation;
}

/**
 * Apply the patch through the shared entity update path inside the action's
 * transaction. It is the clicking user's write but not a manual edit: the
 * mutation gate runs, a human-owned field or an escalating rule defers to an
 * approval, and no field ownership is claimed.
 */
async function applyViewWrite(
	tx: DbClient,
	params: InvokeViewActionParams,
	view: StoredView,
	target: ViewWriteTarget,
): Promise<ViewWrite> {
	const { env, ctx } = params.caller!;
	const updated = await updateEntity(
		target.entityId,
		{
			metadata: target.set,
			...(params.expected !== undefined ? { expected: params.expected } : {}),
		},
		env,
		ctx,
		{
			sql: tx,
			viewAction: { key: view.key },
			policyPrincipalKind: "user",
			afterPersist: async (before, after, handle) => {
				await insertEntityUpdatedEventInTransaction(
					{
						entityId: target.entityId,
						organizationId: params.organizationId,
						before,
						after,
						contentChanged: false,
						createdBy: params.actor.userId ?? null,
						clientId: params.source?.clientId ?? null,
						via: `view:${view.key}`,
					},
					handle,
				);
			},
		},
	);
	const blocked = updated.fieldMerge?.blocked ?? {};
	const committed = (updated.metadata ?? {}) as Record<string, unknown>;
	const written = Object.keys(target.set).filter((field) => !Object.hasOwn(blocked, field));
	const stamped = Object.entries(target.stamps)
		.filter(([stamp, tracked]) => written.includes(tracked) && Object.hasOwn(committed, stamp))
		.map(([stamp]) => stamp);
	const result: ViewWrite["result"] = {};
	if (written.length > 0) {
		result.applied = {
			entity_id: target.entityId,
			fields: Object.fromEntries(
				[...written, ...stamped].map((field) => [field, committed[field] ?? null]),
			),
		};
	}
	const held = Object.keys(blocked);
	if (held.length > 0) {
		result.pending_approval = {
			entity_id: target.entityId,
			fields: Object.fromEntries(held.map((field) => [field, blocked[field].proposed])),
		};
	}
	return { result, ...(updated.deferred ? { deferred: updated.deferred } : {}) };
}

export function templateEventActionId(
	sourceEventId: number,
	action: string,
): string {
	return `${TEMPLATE_EVENT_ACTION_PREFIX}:${sourceEventId}:${action}`;
}

const TEMPLATE_EVENT_ACTION_ID = new RegExp(
	`^${TEMPLATE_EVENT_ACTION_PREFIX}:([1-9]\\d*):(${ACTION_NAME.source.slice(1, -1)})$`,
);

export function parseTemplateEventActionId(
	actionId: string,
): { sourceEventId: number; action: string } | null {
	const match = TEMPLATE_EVENT_ACTION_ID.exec(actionId);
	if (!match) return null;
	const sourceEventId = Number(match[1]);
	return Number.isSafeInteger(sourceEventId)
		? { sourceEventId, action: match[2] }
		: null;
}

/**
 * Look up a declared interaction by name.
 *
 * `event_kinds` is raw JSONB — connector-supplied feed definitions reach
 * `resolveEventKindDefinition` without passing `manage_entity_schema`'s
 * write-time validator — so the registry is a plain object with a live
 * prototype. A bare index would resolve `@constructor` to `Object`, which
 * `ACTION_NAME` happily admits, and hand the caller an entry whose `emits` is
 * undefined. Own keys and a string `emits` are the whole contract.
 */
export function resolveTemplateInteraction(
	interactions: TemplateInteractionRegistry | undefined,
	action: string,
): TemplateInteractionDefinition | null {
	if (!interactions || !Object.hasOwn(interactions, action)) return null;
	const interaction = interactions[action];
	return interaction && typeof interaction.emits === "string"
		? interaction
		: null;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function deliveryMatches(
	metadata: Record<string, unknown>,
	source: Required<Pick<TemplateActionSource, "connectionId" | "messageId">> &
		Pick<TemplateActionSource, "threadId">,
	/**
	 * Whether this platform's message id already names the exact message, so the
	 * thread ids need not agree. Resolved by the caller from the platform
	 * descriptor, keeping this matcher a pure predicate over its inputs.
	 */
	messageIdPinsMessage: boolean,
): boolean {
	if (!Array.isArray(metadata.delivery)) return false;
	return metadata.delivery.some((raw) => {
		const delivery = record(raw);
		if (
			stringOrNull(delivery.connectionId) !== source.connectionId ||
			stringOrNull(delivery.messageId) !== source.messageId
		) {
			return false;
		}
		return (
			messageIdPinsMessage ||
			!source.threadId ||
			stringOrNull(delivery.threadId) === source.threadId
		);
	});
}

function validateInvocation(params: InvokeTemplateEventActionParams): void {
	if (
		!Number.isSafeInteger(params.sourceEventId) ||
		params.sourceEventId <= 0
	) {
		throw new ToolUserError("source_event_id must be a positive integer", 400);
	}
	if (!ACTION_NAME.test(params.action)) {
		throw new ToolUserError("Invalid template action name", 400);
	}
	if (!INTERACTION_ID.test(params.interactionId)) {
		throw new ToolUserError("interaction_id has an invalid format", 400);
	}
	if (!params.actor.platformUserId.trim()) {
		throw new ToolUserError("A verified interaction actor is required", 401);
	}
	if (params.value !== null && params.value.length > MAX_VALUE_LENGTH) {
		throw new ToolUserError(
			`Interaction value exceeds ${MAX_VALUE_LENGTH} characters`,
			400,
		);
	}
}

/**
 * Validate and append one presentation-declared event action.
 *
 * The actor is constructed by the authenticated host adapter, never read from
 * tool/request arguments. The source event, registry entry, rendered value,
 * and (for chat) exact delivery binding are all re-checked from Postgres before
 * the append-only event and Automation activation commit together.
 */
export async function invokeTemplateEventAction(
	params: InvokeTemplateEventActionParams,
): Promise<InvokedTemplateEventAction> {
	validateInvocation(params);
	return replayableAction(params, (key) => appendTemplateEventAction(params, key));
}

async function appendTemplateEventAction(
	params: InvokeTemplateEventActionParams,
	idempotencyKey: string,
): Promise<InvokedTemplateEventAction> {
	const sql = getDb();
	const rows = await sql<{
		id: number;
		origin_id: string;
		title: string | null;
		entity_ids: Array<number | string> | null;
		semantic_type: string;
		payload_data: unknown;
		metadata: unknown;
	}>`
    SELECT id, origin_id, title, entity_ids, semantic_type, payload_data, metadata
    FROM events
    WHERE id = ${params.sourceEventId}
      AND organization_id = ${params.organizationId}
      AND superseded_by IS NULL
    LIMIT 1
  `;
	const sourceEvent = rows[0];
	if (!sourceEvent) {
		const stale = await sql`
      SELECT 1 FROM events
      WHERE id = ${params.sourceEventId}
        AND organization_id = ${params.organizationId}
      LIMIT 1
    `;
		throw new ToolUserError(
			stale.length > 0
				? "This interaction is closed or has been replaced."
				: "Interactive event not found.",
			stale.length > 0 ? 409 : 404,
		);
	}

	const source = params.source;
	if (source?.connectionId || source?.messageId) {
		if (!source.connectionId || !source.messageId) {
			throw new ToolUserError(
				"Chat interactions require connection and message identity",
				403,
			);
		}
		// Whether a message id alone pins the message is the platform's own rule,
		// so its descriptor owns it: Google Chat says yes (a full space-scoped
		// resource name), and platforms without the hook keep the thread check,
		// which identifiers like Slack's `ts` need, being conversation- rather
		// than message-scoped.
		const messageIdPinsMessage =
			getPlatformDescriptor(params.surface)?.messageIdIdentifiesMessage?.(
				source.messageId,
			) === true;
		if (
			!deliveryMatches(
				record(sourceEvent.metadata),
				{
					connectionId: source.connectionId,
					messageId: source.messageId,
					threadId: source.threadId,
				},
				messageIdPinsMessage,
			)
		) {
			throw new ToolUserError(
				"This action does not belong to this chat delivery.",
				403,
			);
		}
	}

	const entityIds = parsePgNumberArray(sourceEvent.entity_ids);
	const kind = await resolveEventKindDefinition(
		sourceEvent.semantic_type,
		params.organizationId,
		entityIds,
	);
	const interaction = resolveTemplateInteraction(
		kind?.interactions,
		params.action,
	);
	if (!kind || !interaction) {
		throw new ToolUserError(
			"This event kind does not declare that interaction.",
			403,
		);
	}

	const template = resolveEntityRender(
		kind.jsonTemplate ?? null,
		kind.metadataSchema,
	);
	const sourceData = resolveEventKindData(
		record(sourceEvent.payload_data),
		record(sourceEvent.metadata),
	);
	const rendered = template
		? collectTemplateActionInvocations(template, sourceData)
		: [];
	if (
		!rendered.some(
			(candidate) =>
				candidate.action === params.action && candidate.value === params.value,
		)
	) {
		throw new ToolUserError(
			"That action value is not present in the rendered event.",
			400,
		);
	}

	const interactionEnvelope = {
		action: params.action,
		value: params.value,
		interaction_id: params.interactionId,
		surface: params.surface,
		actor: {
			platform: params.actor.platform,
			id: params.actor.platformUserId,
			...(params.actor.name ? { name: params.actor.name } : {}),
		},
		source_event_id: sourceEvent.id,
		source_origin_id: sourceEvent.origin_id,
		...(source?.connectionId ? { connection_id: source.connectionId } : {}),
		...(source?.messageId ? { message_id: source.messageId } : {}),
		...(source?.threadId ? { thread_id: source.threadId } : {}),
	};
	const eventData = { ...sourceData, interaction: interactionEnvelope };
	const kindValidation = await validateSaveContentSemanticType(
		interaction.emits,
		eventData,
		params.organizationId,
		entityIds,
	);
	if (!kindValidation.valid) {
		throw new ToolUserError(kindValidation.errors.join("\n"), 422);
	}

	const inserted = await insertConnectionlessWorkspaceEvent(
		{
			entityIds,
			organizationId: params.organizationId,
			originId: idempotencyKey,
			title: sourceEvent.title
				? `${sourceEvent.title}: ${params.action}`
				: params.action,
			payloadType: "empty",
			semanticType: interaction.emits,
			originType: "template_interaction",
			parentOriginId: sourceEvent.origin_id,
			authorName: params.actor.name ?? null,
			createdBy: params.actor.userId ?? null,
			clientId: source?.clientId ?? null,
			metadata: eventData,
		},
		idempotencyKey,
	);
	return {
		created: inserted.change !== "unchanged",
		eventId: inserted.id,
		eventType: interaction.emits,
	};
}
