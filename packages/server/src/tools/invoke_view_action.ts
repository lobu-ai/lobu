import { type Static, Type } from "@sinclair/typebox";
import { ViewKeySchema } from "@lobu/core/contracts/tools/manage-views";
import type { Env } from "../index";
import { invokeViewAction } from "../interactions/template-event-actions";
import { requireWorkspaceContext } from "./access-control";
import type { AccountToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";
import { ToolUserError } from "../utils/errors";
import {
	InvokeEventActionResultSchema,
} from "./invoke_event_action";

export const InvokeViewActionSchema = Type.Object(
	{
		view: ViewKeySchema,
		action: Type.String({ minLength: 1, maxLength: 64 }),
		value: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "Action payload, e.g. the record id the button names.",
			})
		),
		interaction_id: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false }
);

type InvokeViewActionArgs = Static<typeof InvokeViewActionSchema>;

async function invokeViewActionImpl(
	args: InvokeViewActionArgs,
	_env: Env,
	ctx: AccountToolContext
): Promise<Static<typeof InvokeEventActionResultSchema>> {
	if (!ctx.isAuthenticated || !ctx.userId) {
		throw new ToolUserError(
			"A signed-in Lobu user is required for this interaction.",
			401
		);
	}
	// No offered-action capability token: unlike template actions, a view click
	// carries no rendered-event binding to prove. The authenticated caller IS
	// the actor, and the CURRENT view's declaration is the boundary — a
	// removed button stops working because the row no longer declares it.
	const target = requireWorkspaceContext(ctx);
	const result = await invokeViewAction({
		organizationId: target.organizationId,
		viewKey: args.view,
		action: args.action,
		value: args.value ?? null,
		interactionId: args.interaction_id,
		surface: "mcp",
		actor: {
			platform: "lobu",
			platformUserId: ctx.userId,
			userId: ctx.userId,
		},
		source: { clientId: ctx.clientId ?? null },
	});
	return {
		created: result.created,
		event_id: result.eventId,
		event_type: result.eventType,
	};
}

export const invokeViewActionTool = withValidatedArgs(
	"invoke_view_action",
	InvokeViewActionSchema,
	invokeViewActionImpl
);
