import {
	MCP_PROTOCOL_VERSION,
	mintGatewayMcpToken,
	verifyWorkerToken,
	type WorkerTokenData,
} from "@lobu/core";
import type { Context } from "hono";
import { captureEffect } from "../../routes/internal/capture-mode.js";
import { getOrgId, orgContext } from "../../../lobu/stores/org-context.js";
import { getRevokedTokenStore } from "../revoked-token-store.js";
import type { McpTool } from "./tool-cache.js";
import {
	MCP_REQUEST_BODY_LIMIT,
	assertRequestBodySize,
	createMcpAbortScope,
	readBoundedBody,
} from "../../../mcp-proxy/http-response.js";

// Bound upstream MCP calls so a slow/hung third-party server can't pin a
// worker turn (and the gateway request serving it) indefinitely. Applies to
// POST/DELETE (JSON-RPC calls) only — GET opens the streamable-HTTP SSE
// listening stream, which is long-lived by design and must not be aborted.
// 120s matches the worker-side MCP call budget.
export const UPSTREAM_FETCH_TIMEOUT_MS = Number(
	process.env.MCP_PROXY_FETCH_TIMEOUT_MS ?? 120_000,
);

/** Standard MCP `initialize` request body. */
export const INITIALIZE_BODY = JSON.stringify({
	jsonrpc: "2.0",
	method: "initialize",
	params: {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "lobu-gateway", version: "1.0.0" },
	},
	id: 0,
});

/** Standard MCP `notifications/initialized` body. */
export const INITIALIZED_NOTIFICATION_BODY = JSON.stringify({
	jsonrpc: "2.0",
	method: "notifications/initialized",
});

export interface JsonRpcResponse {
	jsonrpc: string;
	id: unknown;
	result?: {
		tools?: McpTool[];
		content?: unknown[];
		isError?: boolean;
	};
	error?: { code: number; message: string };
}

export interface HttpMcpServerConfig {
	id: string;
	upstreamUrl: string;
	/** True when the upstream is the same embedded Lobu process (lobu-memory). */
	internal?: boolean;
}

export interface McpConfigSource {
	getHttpServer(
		id: string,
		agentId?: string,
		organizationId?: string,
	): Promise<HttpMcpServerConfig | undefined>;
	getAllHttpServers(
		agentId?: string,
		organizationId?: string,
	): Promise<Map<string, HttpMcpServerConfig>>;
}

export async function authenticateRequest(
	c: Context,
): Promise<{ tokenData: WorkerTokenData; token: string } | null> {
	const sessionToken = extractSessionToken(c);
	if (!sessionToken) return null;

	const tokenData = verifyWorkerToken(sessionToken);
	if (!tokenData) return null;

	if (
		tokenData.jti &&
		(await getRevokedTokenStore().isRevoked(tokenData.jti))
	) {
		return null;
	}

	return { tokenData, token: sessionToken };
}

/**
 * Run MCP proxy work inside the organization bound to the worker token.
 *
 * The Postgres secret store resolves org-scoped credentials from
 * AsyncLocalStorage, so authenticated MCP routes must install the token's
 * organization context before reading OAuth credentials.
 */
export function runWithWorkerOrgContext<T>(
	tokenData: WorkerTokenData,
	fn: () => T,
): T {
	return runWithOrganizationContext(tokenData.organizationId, fn);
}

export function runWithOrganizationContext<T>(
	organizationId: string | null | undefined,
	fn: () => T,
): T {
	if (!organizationId) {
		throw new Error("MCP organization context requires organizationId");
	}
	return orgContext.run({ organizationId }, fn);
}

export function extractSessionToken(c: Context): string | null {
	const authHeader = c.req.header("authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.substring(7);
	}

	return null;
}

export function buildUpstreamHeaders(
	sessionId: string | null,
	credentialToken?: string,
	internal?: boolean,
	protocolVersion?: string | null,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		// MCP streamable-HTTP spec requires both — servers like DeepWiki reject
		// plain `application/json` with 406 Not Acceptable.
		Accept: "application/json, text/event-stream",
	};

	if (credentialToken && internal) {
		const gatewayMcpToken = mintGatewayMcpToken(credentialToken);
		if (!gatewayMcpToken) {
			throw new Error("Internal MCP credential must be a verified worker token");
		}
		headers.Authorization = `Bearer ${gatewayMcpToken}`;
	} else if (credentialToken) {
		headers.Authorization = `Bearer ${credentialToken}`;
	}

	// Stamp internal MCP requests so the embedded Lobu multi-tenant
	// middleware promotes the worker JWT to admin scope for this org.
	if (internal) {
		headers["X-Lobu-Memory-Direct-Auth"] = "1";
	}

	if (sessionId) {
		headers["Mcp-Session-Id"] = sessionId;
		headers["MCP-Protocol-Version"] = protocolVersion ?? MCP_PROTOCOL_VERSION;
	}

	return headers;
}

/**
 * Live upstream sessions are scoped by user. Capture runs get their own key
 * so they cannot share a session and its policy with live turns or another
 * capture owner.
 */
export function computeScopeKey(userId: string, worker?: WorkerTokenData): string {
	return worker?.executionMode === "capture"
		? JSON.stringify([userId, "capture", worker.automationRunId ?? null, worker.runId ?? null])
		: userId;
}

/**
 * Build a session-store key for the upstream Mcp-Session-Id associated
 * with a specific (org, agent, mcp, scope) tuple. The session store is a
 * process-wide Map, and agentId is NOT globally unique (agents PK is
 * (organization_id, id)), so the key MUST be org-scoped to stop two orgs
 * sharing the same agentId+mcpId from bleeding upstream session handles into
 * each other. Scoping by scopeKey additionally prevents two users (or
 * user-vs-channel credentials) within an org from sharing a single upstream
 * session. The org is read from `runWithOrganizationContext` (every caller
 * runs inside it) so no signature need carry it.
 */
export function buildSessionKey(
	agentId: string,
	mcpId: string,
	scopeKey?: string,
): string {
	const orgId = getOrgId();
	const scope = scopeKey ?? "_unscoped";
	return `mcp:session:${orgId}:${agentId}:${mcpId}:${scope}`;
}

export async function getRequestBodyAsText(c: Context): Promise<string> {
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		return "";
	}

	// Hono may expose a framework-materialized body as a consumed/null stream;
	// in that case the framework has already paid the buffering cost. We still
	// enforce the UTF-8 byte cap before JSON parsing at every caller.
	if (!c.req.raw.body) {
		const text = await c.req.text();
		assertRequestBodySize(text, MCP_REQUEST_BODY_LIMIT);
		return text;
	}
	const abortScope = createMcpAbortScope({ callerSignal: c.req.raw.signal });
	try {
		const body = await readBoundedBody(c.req.raw.body, MCP_REQUEST_BODY_LIMIT, {
			signal: abortScope.signal,
			kind: "request",
		});
		return new TextDecoder().decode(body.bytes);
	} finally {
		abortScope.cleanup();
	}
}

export function sendJsonRpcError(
	c: Context,
	code: number,
	message: string,
	id: unknown = null,
): Response {
	return c.json(
		{
			jsonrpc: "2.0",
			id,
			error: { code, message },
		},
		200,
	);
}

/** Capture before MCP approval or upstream credential resolution. */
export async function captureMcpTool(
	worker: WorkerTokenData, mcpId: string, toolName: string, args: Record<string, unknown>,
) {
	const result = await captureEffect(worker, `mcp.${mcpId}.${toolName}`, args);
	return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
}
