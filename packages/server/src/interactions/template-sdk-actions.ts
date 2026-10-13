import {
	collectTemplateActionInvocations,
	isTemplateSdkInteractionDefinition,
} from "@lobu/core/json-template";
import { getDb, parsePgNumberArray } from "../db/client";
import type { ToolContext } from "../tools/registry";
import { buildConnectionVisibilityClause } from "../utils/content-search/visibility";
import { resolveEntityRender } from "../utils/default-entity-template";
import {
	resolveEventKindData,
	resolveEventKindDefinition,
} from "../utils/event-kind-validation";
import { ToolUserError } from "../utils/errors";
import {
	type InvokeTemplateEventActionParams,
	validateTemplateEventActionInput,
} from "./template-event-actions";

/**
 * Resolve executable configuration only from the current readable event's
 * authoritative kind. Browsers provide an action/value, never script source.
 * Emitted actions keep their existing replay and append semantics.
 */
export async function resolveWebTemplateSdkAction(
	params: InvokeTemplateEventActionParams,
	ctx: ToolContext,
): Promise<{
	tool: "run_sdk" | "query_sdk";
	args: { script: string; timeout_ms: number; title: string };
} | null> {
	validateTemplateEventActionInput(params);
	const visibility = buildConnectionVisibilityClause({
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		baseParamIndex: 3,
	});
	const sql = getDb();
	const [event] = await sql.unsafe<{
		id: number;
		title: string | null;
		semantic_type: string;
		entity_ids: Array<number | string> | null;
		payload_data: Record<string, unknown> | null;
		metadata: Record<string, unknown> | null;
	}>(
		`
    SELECT f.id, f.title, f.semantic_type, f.entity_ids, f.payload_data, f.metadata
    FROM events f
    WHERE f.id = $1 AND f.organization_id = $2 AND f.superseded_by IS NULL
      ${visibility.sql}
    LIMIT 1
  `,
		[params.sourceEventId, ctx.organizationId, ...visibility.params],
	);
	if (!event) return null;
	// Bypass the per-replica TTL: a revoked/replaced script must not execute.
	const kind = await resolveEventKindDefinition(
		event.semantic_type,
		ctx.organizationId,
		parsePgNumberArray(event.entity_ids),
		sql,
	);
	if (!kind?.interactions || !Object.hasOwn(kind.interactions, params.action)) {
		return null;
	}
	const definition = kind.interactions[params.action];
	if (!isTemplateSdkInteractionDefinition(definition)) return null;
	// This binding is for explicit native web interaction. Agent/chat callers
	// keep the emitted-event contract; they cannot borrow a browser user's scope.
	if (ctx.tokenType !== "session" || ctx.agentId) {
		throw new ToolUserError("SDK event actions require a signed-in web session.", 403);
	}
	const template = resolveEntityRender(kind.jsonTemplate ?? null, kind.metadataSchema);
	const data = resolveEventKindData(event.payload_data, event.metadata);
	if (
		!template ||
		!collectTemplateActionInvocations(template, data).some(
			(action) => action.action === params.action && action.value === params.value,
		)
	) {
		throw new ToolUserError("That action value is not present in the rendered event.", 400);
	}
	const input = {
		source_event_id: Number(event.id),
		action: params.action,
		value: params.value,
		interaction_id: params.interactionId,
	};
	return {
		tool: definition.sdk.mode === "read" ? "query_sdk" : "run_sdk",
		args: {
			script: `const input = ${JSON.stringify(input)};\n${definition.sdk.script}`,
			timeout_ms: definition.sdk.timeout_ms ?? 30_000,
			title: `${event.title ?? "Event"}: ${params.action}`.slice(0, 200),
		},
	};
}
