import {
	collectTemplateActionInvocations,
	type TemplateActionInvocation,
	type TemplateInteractionDefinition,
	type TemplateInteractionRegistry,
} from "@lobu/core/json-template";
import { getDb, parsePgNumberArray } from "../db/client";
import { getPlatformDescriptor } from "../gateway/connections/platforms/index.js";
import { resolveEntityRender } from "../utils/default-entity-template";
import { ToolUserError } from "../utils/errors";
import {
	resolveEventKindDefinition,
	validateSaveContentSemanticType,
} from "../utils/event-kind-validation";
import { insertConnectionlessWorkspaceEvent } from "../utils/insert-event";
import { emit } from "../events/emitter";
import { getView, isValidViewKey, VIEW_ACTION_NAME_RE } from "../views/views";

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

export interface InvokedTemplateEventAction {
	created: boolean;
	eventId: number;
	eventType: string;
}

/**
 * Second source for the chokepoint: a click on a DECLARED view action.
 *
 * Unlike the template path there is no rendered event to match the value
 * against (no server render) and no delivery binding (views render only in
 * frame hosts). The declaration on the CURRENT view row is the whole check: a
 * removed button stops working because the row no longer declares it. Write
 * rules, workspace scoping and Automation activation are identical to the
 * template path, and the appended event carries `origin_type =
 * 'view_interaction'`. There is deliberately no signed offered-action token:
 * the declaration check is the boundary, not a UX-consistency re-render.
 */
export interface InvokeViewActionParams {
	organizationId: string;
	viewKey: string;
	action: string;
	value: Record<string, unknown> | null;
	interactionId: string;
	surface: string;
	actor: TrustedTemplateActor;
	source?: TemplateActionSource;
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
}

export async function invokeViewAction(
	params: InvokeViewActionParams,
): Promise<InvokedTemplateEventAction> {
	validateViewInvocation(params);
	const view = await getView(params.organizationId, params.viewKey);
	if (!view) {
		throw new ToolUserError(`Unknown view: ${params.viewKey}`, 404);
	}
	const declared = view.actions?.[params.action];
	if (!declared || typeof declared.emits !== "string" || !declared.emits) {
		throw new ToolUserError(
			`View "${params.viewKey}" does not declare action "${params.action}"`,
			403,
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
		view: view.key,
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
	// View actions are not entity-bound, so the kind resolves with no entity
	// context — exactly as an org-level kind does on the template path.
	const kindValidation = await validateSaveContentSemanticType(
		declared.emits,
		eventData,
		params.organizationId,
		[],
	);
	if (!kindValidation.valid) {
		throw new ToolUserError(kindValidation.errors.join("\n"), 422);
	}

	const idempotencyKey = `view-action:${view.key}:${params.surface}:${params.interactionId}`;
	const inserted = await insertConnectionlessWorkspaceEvent(
		{
			entityIds: [],
			organizationId: params.organizationId,
			originId: idempotencyKey,
			title: `${view.name}: ${params.action}`,
			payloadType: "empty",
			semanticType: declared.emits,
			originType: "view_interaction",
			parentOriginId: null,
			authorName: params.actor.name ?? null,
			createdBy: params.actor.userId ?? null,
			clientId: params.source?.clientId ?? null,
			metadata: eventData,
		},
		idempotencyKey,
	);
	// Views render from their own rows, not from the event fan-out, so the
	// view's frame needs an explicit invalidation to refetch after a click.
	emit(params.organizationId, { keys: [`view:${view.key}`] });
	return {
		created: inserted.change !== "unchanged",
		eventId: inserted.id,
		eventType: declared.emits,
	};
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
	const sourceMetadata = record(sourceEvent.metadata);
	// Match get_content's rendering contract exactly: notification events render
	// their payload, while ordinary typed events render their metadata.
	const sourceData =
		typeof sourceMetadata.notification_type === "string"
			? record(sourceEvent.payload_data)
			: sourceMetadata;
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

	const idempotencyKey = `event-action:${sourceEvent.id}:${params.surface}:${params.interactionId}`;
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
