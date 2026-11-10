import { type Static, Type } from "@sinclair/typebox";
import { ViewKeySchema } from "@lobu/core/contracts/tools/manage-views";
import type { Env } from "../index";
import {
	type InvokedTemplateEventAction,
	invokeViewAction,
} from "../interactions/template-event-actions";
import { requireWorkspaceContext } from "./access-control";
import type { AccountToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";
import { ToolUserError } from "../utils/errors";
import {
	InvokeEventActionResultSchema,
} from "./invoke_event_action";
import { eventClientId } from "../auth/event-client-id";

export const ViewActionScopeSchema = Type.Object({
	event: Type.Integer({ minimum: 1, description: "Exact stored event version shown by the view." }),
}, { additionalProperties: false });

export const InvokeViewActionSchema = Type.Object(
	{
		view: ViewKeySchema,
		scope: Type.Optional(ViewActionScopeSchema),
		action: Type.String({ minLength: 1, maxLength: 64 }),
		value: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					"Action payload, e.g. the record id the button names. An action that updates an entity takes { entity_id, set: { field: value } }.",
			})
		),
		expected: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				maxProperties: 50,
				description:
					"For an action that updates an entity: metadata field -> the value the view read. Checked under the row lock; a mismatch writes nothing and fails 409 PRECONDITION_FAILED.",
			})
		),
		interaction_id: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false }
);

type InvokeViewActionArgs = Static<typeof InvokeViewActionSchema>;

const viewActionEntityFields = (description: string) =>
	Type.Object(
		{
			entity_id: Type.Integer(),
			fields: Type.Record(Type.String(), Type.Unknown()),
		},
		{ description },
	);

export const InvokeViewActionResultSchema = Type.Object({
	...InvokeEventActionResultSchema.properties,
	applied: Type.Optional(
		viewActionEntityFields("Entity fields the action committed, server-stamped fields included."),
	),
	pending_approval: Type.Optional(
		viewActionEntityFields("Proposed field values held for an approval instead of written."),
	),
});

/** The wire result of a view action, shared by the MCP tool and the web route. */
export function viewActionResult(
	result: InvokedTemplateEventAction,
): Static<typeof InvokeViewActionResultSchema> {
	return {
		created: result.created,
		event_id: result.eventId,
		event_type: result.eventType,
		...(result.applied ? { applied: result.applied } : {}),
		...(result.pendingApproval ? { pending_approval: result.pendingApproval } : {}),
	};
}

async function invokeViewActionImpl(
	args: InvokeViewActionArgs,
	env: Env,
	ctx: AccountToolContext
): Promise<Static<typeof InvokeViewActionResultSchema>> {
	if (!ctx.isAuthenticated || !ctx.userId) {
		throw new ToolUserError(
			"A signed-in Lobu user is required for this interaction.",
			401
		);
	}
	// The current view declaration and normal event read policy authorize the
	// action. The event subject is outside user-controlled action values.
	const target = requireWorkspaceContext(ctx);
	const result = await invokeViewAction({
		organizationId: target.organizationId,
		...(args.scope ? { event: { id: args.scope.event, env, ctx: target } } : {}),
		viewKey: args.view,
		action: args.action,
		value: args.value ?? null,
		...(args.expected !== undefined ? { expected: args.expected } : {}),
		caller: { env, ctx: target },
		interactionId: args.interaction_id,
		surface: "mcp",
		actor: {
			platform: "lobu",
			platformUserId: ctx.userId,
			userId: ctx.userId,
		},
		source: { clientId: eventClientId(ctx) },
	});
	return viewActionResult(result);
}

export const invokeViewActionTool = withValidatedArgs(
	"invoke_view_action",
	InvokeViewActionSchema,
	invokeViewActionImpl
);
