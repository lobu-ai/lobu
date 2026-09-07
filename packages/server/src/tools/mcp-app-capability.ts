import { decrypt, encrypt } from "@lobu/core";
import type { AccountToolContext, ToolContext } from "./registry";

export const MCP_APP_CAPABILITY_MAX_LENGTH = 4_096;

export interface McpAppCapabilityBinding {
	organizationId: string;
	userId: string;
	clientId: string;
	sessionId: string;
	conversationId: string | null;
	expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMcpAppCapabilityBinding(
	value: unknown,
): value is McpAppCapabilityBinding {
	if (!isRecord(value)) return false;
	return (
		typeof value.organizationId === "string" &&
		typeof value.userId === "string" &&
		typeof value.clientId === "string" &&
		typeof value.sessionId === "string" &&
		(value.conversationId === null ||
			typeof value.conversationId === "string") &&
		typeof value.expiresAt === "number"
	);
}

export function canIssueMcpAppCapability(
	ctx: ToolContext,
): ctx is ToolContext & {
	userId: string;
	clientId: string;
	mcpSessionId: string;
} {
	return (
		ctx.tokenType === "oauth" &&
		Boolean(ctx.userId && ctx.clientId && ctx.mcpSessionId)
	);
}

export function issueMcpAppCapability<T extends Record<string, unknown>>(
	payload: T,
	ctx: ToolContext & {
		userId: string;
		clientId: string;
		mcpSessionId: string;
	},
	ttlMs: number,
): string {
	return encrypt(
		JSON.stringify({
			...payload,
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			clientId: ctx.clientId,
			sessionId: ctx.mcpSessionId,
			conversationId: ctx.mcpConversationId ?? null,
			expiresAt: Date.now() + ttlMs,
		}),
	);
}

export function readMcpAppCapability(
	token: string | null | undefined,
	maxLength = MCP_APP_CAPABILITY_MAX_LENGTH,
): unknown {
	if (!token || token.length > maxLength) return null;
	try {
		return JSON.parse(decrypt(token));
	} catch {
		return null;
	}
}

export function mcpAppCapabilityMatchesHost(
	capability: McpAppCapabilityBinding,
	ctx: AccountToolContext,
): boolean {
	if (
		capability.userId !== ctx.userId ||
		capability.clientId !== ctx.clientId ||
		capability.expiresAt <= Date.now()
	) {
		return false;
	}
	if (capability.conversationId) {
		return capability.conversationId === ctx.mcpConversationId;
	}
	return capability.sessionId === ctx.mcpSessionId;
}
