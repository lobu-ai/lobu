import { type Static, Type } from "@sinclair/typebox";
import type { Env } from "../index";
import { invokeTemplateEventAction } from "../interactions/template-event-actions";
import { resolveCrossOrgToolContext } from "../sandbox/client-sdk";
import { ToolUserError } from "../utils/errors";
import { requireWorkspaceContext } from "./access-control";
import type { AccountToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";
import { assertTemplateActionCapability } from "../interactions/template-action-capability";

export const InvokeEventActionSchema = Type.Object(
	{
		source_event_id: Type.Integer({ minimum: 1 }),
		action: Type.String({ minLength: 1, maxLength: 64 }),
		value: Type.Optional(
			Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]),
		),
		interaction_id: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);

export const InvokeEventActionResultSchema = Type.Object({
	created: Type.Boolean(),
	event_id: Type.Integer(),
	event_type: Type.String(),
});

type InvokeEventActionArgs = Static<typeof InvokeEventActionSchema>;

async function invokeEventActionImpl(
	args: InvokeEventActionArgs,
	_env: Env,
	ctx: AccountToolContext,
): Promise<Static<typeof InvokeEventActionResultSchema>> {
	if (!ctx.isAuthenticated || !ctx.userId) {
		throw new ToolUserError(
			"A signed-in Lobu user is required for this interaction.",
			401,
		);
	}
	const organizationId = assertTemplateActionCapability(
		ctx.mcpAppEventActionCapability,
		args.source_event_id,
		ctx,
	);
	const target = ctx.organizationId
		? requireWorkspaceContext(ctx)
		: await resolveCrossOrgToolContext(organizationId, ctx);
	const result = await invokeTemplateEventAction({
		organizationId: target.organizationId,
		sourceEventId: args.source_event_id,
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

export const invokeEventAction = withValidatedArgs(
	"invoke_event_action",
	InvokeEventActionSchema,
	invokeEventActionImpl,
);
