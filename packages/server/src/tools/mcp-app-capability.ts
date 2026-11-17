import { decrypt, encrypt } from "@lobu/core";
import { isHostedRedirectUri } from "../auth/app-principal";
import { OAuthClientsStore } from "../auth/oauth/clients";
import { getDb } from "../db/client";
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

/**
 * Whether the bearer behind this call is held by a hosted web client — one
 * whose token lives on the host's servers, so the model and any local program
 * can reach the app surface only through the host's rendered card.
 *
 * The approval capability is the sole proof that a human pressed Approve, and
 * neither the Apps declaration (claude.ai renders without it; any script can
 * send it) nor the client/session identity (the requesting chat and its card
 * share both) separates a rendered card from a script. Client registration
 * does: a hosted client completes an authorization-code flow at an https
 * redirect it controls, while device-flow (Lobu CLI) and loopback-redirect
 * clients (local agents, scripts) hold the bearer on the user's machine.
 * Legacy rows with no recorded grant type fail closed.
 */
export async function isHostedWebClient(
	ctx: Pick<ToolContext, "tokenType" | "authorizationGrantType" | "clientId">,
): Promise<boolean> {
	if (
		ctx.tokenType !== "oauth" ||
		ctx.authorizationGrantType !== "authorization_code" ||
		!ctx.clientId
	) {
		return false;
	}
	const client = await new OAuthClientsStore(getDb()).getClient(ctx.clientId);
	const redirectUris = client?.redirect_uris ?? [];
	return redirectUris.length > 0 && redirectUris.every(isHostedRedirectUri);
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
