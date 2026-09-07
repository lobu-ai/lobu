import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { ToolContext } from "../../tools/registry.js";

const logger = createLogger("mcp-client-conversations");
const MAX_TITLE_LENGTH = 200;

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
	ctx: ToolContext,
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

export function currentMcpActivityEventMetadata(ctx: ToolContext): {
	mcp_session_id: string | null;
	mcp_conversation_id: string | null;
} {
	const attribution = currentMcpActivityAttribution(ctx);
	return {
		mcp_session_id: attribution?.transportSessionId ?? null,
		mcp_conversation_id: attribution?.hostConversationId ?? null,
	};
}

function oauthClientId(ctx: ToolContext): string | null {
	return ctx.tokenType === "oauth" ? (ctx.clientId ?? null) : null;
}

function transportSessionIds(ctx: ToolContext): string[] {
	const sessionId = currentMcpActivityAttribution(ctx)?.transportSessionId;
	return sessionId ? [sessionId] : [];
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

export async function recordMcpConversationActivity(args: {
	ctx: ToolContext;
	toolName: string;
	failed: boolean;
}): Promise<void> {
	const identity = currentMcpActivityAttribution(args.ctx);
	if (!identity) return;
	try {
		const sql = getDb();
		// `last_action` stores the RAW tool name, the same contract the migration
		// backfill writes. `displayAction` on the read path is the single
		// formatting point, so live and backfilled rows always render alike.
		const label = args.toolName;
		const clientId = oauthClientId(args.ctx);
		const sessionIds = transportSessionIds(args.ctx);
		await sql`
      INSERT INTO public.mcp_client_conversations (
        organization_id, client_identity, conversation_id, transport_session_ids,
        client_id, user_id, agent_id, last_action, tools, call_count, failed_count
      ) VALUES (
        ${args.ctx.organizationId}, ${identity.clientIdentity}, ${identity.activityId},
        ${sql.json(sessionIds)}, ${clientId}, ${args.ctx.userId ?? null},
        ${args.ctx.agentId ?? null}, ${label}, ${sql.json([args.toolName])}, 1, ${args.failed ? 1 : 0}
      )
      ON CONFLICT (organization_id, client_identity, conversation_id) DO UPDATE SET
        transport_session_ids = CASE
          WHEN jsonb_array_length(EXCLUDED.transport_session_ids) = 0
            OR public.mcp_client_conversations.transport_session_ids ? (EXCLUDED.transport_session_ids->>0)
          THEN public.mcp_client_conversations.transport_session_ids
          ELSE public.mcp_client_conversations.transport_session_ids || EXCLUDED.transport_session_ids END,
        client_id = COALESCE(EXCLUDED.client_id, public.mcp_client_conversations.client_id),
        user_id = COALESCE(EXCLUDED.user_id, public.mcp_client_conversations.user_id),
        agent_id = COALESCE(EXCLUDED.agent_id, public.mcp_client_conversations.agent_id),
        last_action = EXCLUDED.last_action,
        tools = CASE WHEN public.mcp_client_conversations.tools ? ${args.toolName}
          THEN public.mcp_client_conversations.tools
          ELSE public.mcp_client_conversations.tools || EXCLUDED.tools END,
        call_count = public.mcp_client_conversations.call_count + 1,
        failed_count = public.mcp_client_conversations.failed_count + EXCLUDED.failed_count,
        last_activity_at = now(), updated_at = now()
    `;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(
			{ err, toolName: args.toolName },
			`MCP conversation activity was not materialized: ${message}`,
		);
	}
}

export async function setCurrentMcpConversationTitle(
	ctx: ToolContext,
	value: string,
) {
	const identity = currentMcpActivityAttribution(ctx);
	if (!identity)
		throw new Error(
			"No current MCP conversation is available for this client session.",
		);
	const title = normalizeMcpConversationTitle(value);
	if (!title) throw new Error("Conversation title must not be empty.");
	const sql = getDb();
	const clientId = oauthClientId(ctx);
	const sessionIds = transportSessionIds(ctx);
	// A title can be set before the conversation's first call lands (the activity
	// row is written after the tool returns), so this seeds the row. `last_action`
	// is NOT NULL and keeps the raw-name contract; the enclosing tool call
	// overwrites it moments later, and the read path hides the row until it does.
	await sql`
    INSERT INTO public.mcp_client_conversations (
      organization_id, client_identity, conversation_id, transport_session_ids,
      client_id, user_id, agent_id, title, last_action
    ) VALUES (
      ${ctx.organizationId}, ${identity.clientIdentity}, ${identity.activityId},
      ${sql.json(sessionIds)}, ${clientId}, ${ctx.userId ?? null},
      ${ctx.agentId ?? null}, ${title}, 'set_title'
    )
    ON CONFLICT (organization_id, client_identity, conversation_id)
    DO UPDATE SET title = EXCLUDED.title,
      transport_session_ids = CASE
        WHEN jsonb_array_length(EXCLUDED.transport_session_ids) = 0
          OR public.mcp_client_conversations.transport_session_ids ? (EXCLUDED.transport_session_ids->>0)
        THEN public.mcp_client_conversations.transport_session_ids
        ELSE public.mcp_client_conversations.transport_session_ids || EXCLUDED.transport_session_ids END,
      updated_at = now()
  `;
	return { title };
}
