import { getDb, type DbClient } from "../../db/client.js";
import type { ToolContext } from "../../tools/registry.js";

const MAX_TITLE_LENGTH = 200;

type ActivityContext = Pick<ToolContext, 'mcpConversationId' | 'mcpSessionId' | 'clientId' | 'tokenType'>;

export interface McpActivityAttribution {
	clientIdentity: string;
	clientId: string | null;
	activityId: string;
	activityKind: "conversation" | "session";
	transportSessionId: string | null;
	hostConversationId: string | null;
}

function boundedId(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= 512 ? trimmed : null;
}

export function currentMcpActivityAttribution(
	ctx: ActivityContext,
): McpActivityAttribution | null {
	const hostConversationId = boundedId(ctx.mcpConversationId);
	const transportSessionId = boundedId(ctx.mcpSessionId);
	const isConversation =
		hostConversationId !== null && hostConversationId !== transportSessionId;
	const activityId = isConversation
		? hostConversationId
		: (transportSessionId ?? hostConversationId);
	if (!activityId) return null;
	return {
		clientIdentity: ctx.clientId?.trim() || "",
		clientId: oauthClientId(ctx),
		activityId,
		activityKind: isConversation ? "conversation" : "session",
		transportSessionId,
		hostConversationId: isConversation ? hostConversationId : null,
	};
}

export function currentMcpActivityEventMetadata(ctx: ActivityContext): {
	mcp_session_id: string | null;
	mcp_conversation_id: string | null;
} {
	const attribution = currentMcpActivityAttribution(ctx);
	return {
		mcp_session_id: attribution?.transportSessionId ?? null,
		mcp_conversation_id: attribution?.hostConversationId ?? null,
	};
}

function oauthClientId(ctx: ActivityContext): string | null {
	return ctx.tokenType === "oauth" ? (ctx.clientId ?? null) : null;
}

export function normalizeMcpConversationTitle(value: string): string {
	// Truncate by code point, not UTF-16 code unit: splitting an astral
	// character (an emoji) leaves a lone surrogate that cannot be encoded as
	// UTF-8, and the title write below would throw.
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return [...cleaned].slice(0, MAX_TITLE_LENGTH).join("");
}

type UserActivityContext = ActivityContext & { userId: string | null };

/** Called inside the invocation transaction: a failed summary rolls back both. */
export async function recordUserMcpActivity(
	sql: DbClient,
	ctx: UserActivityContext,
	toolName: string,
	failed: boolean,
): Promise<void> {
	const identity = currentMcpActivityAttribution(ctx);
	if (!identity || !ctx.userId) return;
	await sql`
		INSERT INTO public.user_mcp_activities (
			user_id, client_identity, activity_id, activity_kind, client_id,
			client_software_id, last_action, tools, call_count, failed_count
		) VALUES (
			${ctx.userId}, ${identity.clientIdentity}, ${identity.activityId}, ${identity.activityKind},
			${ctx.clientId ?? null}, (SELECT software_id FROM oauth_clients WHERE id = ${ctx.clientId ?? null}),
			${toolName}, ${sql.json([toolName])}, 1, ${failed ? 1 : 0}
		)
		ON CONFLICT (user_id, client_identity, activity_id) DO UPDATE SET
			last_action = CASE WHEN EXCLUDED.last_activity_at >= user_mcp_activities.last_activity_at
				THEN EXCLUDED.last_action ELSE user_mcp_activities.last_action END,
			tools = CASE WHEN user_mcp_activities.tools ? ${toolName}
				THEN user_mcp_activities.tools ELSE user_mcp_activities.tools || EXCLUDED.tools END,
			call_count = user_mcp_activities.call_count + 1,
			failed_count = user_mcp_activities.failed_count + EXCLUDED.failed_count,
			first_activity_at = LEAST(user_mcp_activities.first_activity_at, EXCLUDED.first_activity_at),
			last_activity_at = GREATEST(user_mcp_activities.last_activity_at, EXCLUDED.last_activity_at)
	`;
}

export async function setCurrentMcpConversationTitle(ctx: UserActivityContext, value: string) {
	const identity = currentMcpActivityAttribution(ctx);
	if (!identity || !ctx.userId) throw new Error("No current user MCP conversation is available.");
	const title = normalizeMcpConversationTitle(value);
	if (!title) throw new Error("Conversation title must not be empty.");
	const sql = getDb();
	await sql`
		INSERT INTO public.user_mcp_activities (
			user_id, client_identity, activity_id, activity_kind, client_id,
			client_software_id, title, last_action
		) VALUES (
			${ctx.userId}, ${identity.clientIdentity}, ${identity.activityId}, ${identity.activityKind},
			${ctx.clientId ?? null}, (SELECT software_id FROM oauth_clients WHERE id = ${ctx.clientId ?? null}),
			${title}, 'set_title'
		)
		ON CONFLICT (user_id, client_identity, activity_id) DO UPDATE SET title = EXCLUDED.title
	`;
	return { title };
}
