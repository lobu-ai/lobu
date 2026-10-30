import { createLogger, MCP_PROTOCOL_VERSION } from "@lobu/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
	boundStreamingResponse,
	createMcpAbortScope,
	getMcpAbortReason,
	logMcpTerminalOutcome,
	MCP_REQUEST_BODY_LIMIT,
	MCP_RESPONSE_BODY_LIMIT,
	assertRequestBodySize,
	isMcpToolCallRequest,
	inspectMcpJsonRpcBody,
	newMcpCallId,
	normalizeMcpAbortError,
	readResponseBody,
	McpTransportError,
	parseJsonRpcResponse,
} from "../../../mcp-proxy/http-response.js";
import {
	fetchPublicUrl,
	isInternalUrl,
} from "@lobu/connector-worker/egress";
import {
	buildSessionKey,
	buildUpstreamHeaders,
	type HttpMcpServerConfig,
	INITIALIZE_BODY,
	INITIALIZED_NOTIFICATION_BODY,
	UPSTREAM_FETCH_TIMEOUT_MS,
} from "./proxy-shared.js";

const logger = createLogger("mcp-proxy");

/**
 * An MCP upstream's HTTP 4xx: the upstream refused this caller or request (an
 * auth or scope refusal, such as a worker token whose agent was deleted
 * mid-turn), so the gateway itself did not fail. Carries the upstream status
 * for a REST caller to keep.
 */
export class McpUpstreamRefusal extends Error {
	constructor(
		readonly status: ContentfulStatusCode,
		message: string,
	) {
		super(message);
		this.name = "McpUpstreamRefusal";
	}
}

/**
 * The message of an upstream error body: a JSON-RPC `error` object, or the
 * OAuth-style `{ error, error_description }` refusal an auth gate answers with.
 */
export function upstreamErrorMessage(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const { error, error_description: description } = body as {
		error?: unknown;
		error_description?: unknown;
	};
	if (typeof error === "string" && error) {
		return typeof description === "string" && description
			? `${error}: ${description}`
			: error;
	}
	if (error && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message) return message;
	}
	return null;
}

/**
 * Read an upstream 4xx into a refusal, consuming its body; null (body
 * untouched) when the upstream did not refuse.
 */
export async function readUpstreamRefusal(
	response: Response,
	mcpId: string,
): Promise<McpUpstreamRefusal | null> {
	if (response.status < 400 || response.status >= 500) return null;
	let body: unknown = null;
	try {
		body = await parseJsonRpcResponse(response);
	} catch {
		// A non-JSON refusal body (a plain-text 401) carries no message.
	}
	return new McpUpstreamRefusal(
		response.status as ContentfulStatusCode,
		upstreamErrorMessage(body) ??
			`MCP '${mcpId}' refused the request (HTTP ${response.status})`,
	);
}

type McpTerminalLogger = {
	info: (message: unknown, ...args: unknown[]) => void;
};

/**
 * SSRF guard: if the upstream URL resolves to an internal/reserved network
 * (and the server isn't an embedded internal MCP), log it and return a 403
 * JSON-RPC error response. Returns null when the request may proceed.
 */
export async function ssrfBlockResponse(
	httpServer: HttpMcpServerConfig,
	mcpId: string,
	agentId: string,
): Promise<Response | null> {
	if (httpServer.internal || !(await isInternalUrl(httpServer.upstreamUrl))) {
		return null;
	}
	logger.warn("Blocked SSRF attempt to internal URL", {
		url: httpServer.upstreamUrl,
		mcpId,
		agentId,
	});
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32600,
				message: "Upstream URL resolves to a blocked internal network",
			},
		}),
		{ status: 403, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Upstream MCP transport client: owns the per-process session-id cache,
 * resolves per-scope credentials, and performs the initialize handshake and
 * non-streamed JSON-RPC egress to MCP upstreams.
 */
export class McpUpstreamClient {
	constructor(
		private readonly terminalLogger: McpTerminalLogger = logger,
		private readonly requestTimeoutMs = UPSTREAM_FETCH_TIMEOUT_MS,
	) {}

	private readonly SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
	/**
	 * Per-process MCP upstream session-id cache. The session id is opaque to
	 * the gateway and only valid for the upstream MCP server, so on a gateway
	 * restart the worker simply re-runs `initialize` and gets a new session —
	 * no cross-replica coherence needed.
	 */
	private readonly sessions = new Map<
		string,
		{ sessionId: string; protocolVersion: string; expiresAt: number }
	>();

	getSession(key: string): string | null {
		const entry = this.sessions.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.sessions.delete(key);
			return null;
		}
		// Refresh TTL on read.
		entry.expiresAt = Date.now() + this.SESSION_TTL_SECONDS * 1000;
		return entry.sessionId;
	}

	getProtocolVersion(key: string): string | null {
		const entry = this.sessions.get(key);
		return entry && entry.expiresAt > Date.now() ? entry.protocolVersion : null;
	}

	setSession(key: string, sessionId: string, protocolVersion?: string): void {
		this.sessions.set(key, {
			sessionId,
			protocolVersion:
				protocolVersion ?? this.getProtocolVersion(key) ?? MCP_PROTOCOL_VERSION,
			expiresAt: Date.now() + this.SESSION_TTL_SECONDS * 1000,
		});
	}

	deleteSession(key: string): void {
		this.sessions.delete(key);
	}

	/**
	 * Single egress point for JSON-RPC calls to an MCP upstream.
	 * The internal lobu-memory server accepts the worker JWT directly; runs the
	 * SSRF guard and tracks the upstream session id. Successful SSE responses
	 * stream by default; finite REST/tool callers opt into bounded buffering
	 * under the POST deadline.
	 */
	async sendUpstreamRequest(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		method: string,
		body?: string,
		scopeKey?: string,
		directAuthToken?: string,
		extraHeaders?: Record<string, string>,
		callerSignal?: AbortSignal,
		streamResponse = true,
	): Promise<Response> {
		const sessionKey = buildSessionKey(agentId, mcpId, scopeKey);
		const sessionId = this.getSession(sessionKey);
		const protocolVersion = this.getProtocolVersion(sessionKey);

		// Internal MCPs (lobu-memory) live in the same Lobu process and accept
		// the worker JWT directly.
		const credentialToken = httpServer.internal ? directAuthToken : undefined;

		const ssrfBlock = await ssrfBlockResponse(httpServer, mcpId, agentId);
		if (ssrfBlock) return ssrfBlock;

		const headers = buildUpstreamHeaders(
			sessionId,
			credentialToken,
			httpServer.internal === true,
			protocolVersion,
		);
		if (extraHeaders) {
			for (const [key, value] of Object.entries(extraHeaders)) {
				headers[key] = value;
			}
		}

		const callId = newMcpCallId();
		const requestBytes = body ? new TextEncoder().encode(body).byteLength : 0;
		const startedAt = Date.now();
		const abortScope = createMcpAbortScope({
			timeoutMs: method.toUpperCase() === "GET" ? undefined : this.requestTimeoutMs,
			callerSignal,
		});
		const finish = (
			status: number | null,
			responseBytes: number,
			preview?: string,
			error?: unknown,
			jsonRpcStatus: "success" | "error" | "unknown" = "unknown",
		) => {
			const transportError =
				error instanceof McpTransportError
					? error
					: abortScope.signal.reason instanceof McpTransportError
						? abortScope.signal.reason
						: undefined;
			const abortReason = getMcpAbortReason(transportError, abortScope.signal);
			logMcpTerminalOutcome(this.terminalLogger, {
				call_id: callId,
				request_bytes: requestBytes,
				response_bytes: responseBytes,
				request_limit: MCP_REQUEST_BODY_LIMIT,
				response_limit: MCP_RESPONSE_BODY_LIMIT,
				duration_ms: Date.now() - startedAt,
				http_status: status,
				jsonrpc_status: jsonRpcStatus,
				truncated: transportError?.kind === "oversized_response" || transportError?.kind === "oversized_request",
				aborted: abortReason !== null,
				abort_reason: abortReason,
				retryable: false,
				ambiguous_execution: body ? isMcpToolCallRequest(body) : false,
				...(preview && (error || status === null || status >= 400) ? { diagnostic_preview: preview } : {}),
			});
		};

		let response: Response;
		try {
			if (body) assertRequestBodySize(body);
			const request = {
				method,
				headers,
				body: body || undefined,
				signal: abortScope.signal,
			};
			response = httpServer.internal
				? await fetch(httpServer.upstreamUrl, request)
				: await fetchPublicUrl(httpServer.upstreamUrl, request);
		} catch (error) {
			const normalized = normalizeMcpAbortError(error, abortScope.signal);
			abortScope.cleanup();
			finish(null, 0, undefined, normalized);
			throw normalized;
		}

		// An unknown-session response makes the cached handle unusable for future
		// calls. Invalidate it without replaying the request that received the 404.
		if (response.status === 404 && sessionId) {
			this.deleteSession(sessionKey);
		}

		// Track session
		const newSessionId = response.headers.get("Mcp-Session-Id");
		if (newSessionId) {
			this.setSession(sessionKey, newSessionId);
		}

		const isSse = (response.headers.get("content-type") ?? "")
			.toLowerCase()
			.includes("text/event-stream");
		if (method.toUpperCase() === "GET" || (streamResponse && response.ok && isSse)) {
			// POST SSE is relayed immediately, but the POST/tool-call deadline stays
			// active through body consumption. GET streams have no deadline.
			return boundStreamingResponse(response, {
				signal: abortScope.signal,
				cleanup: (error, bytes) => {
					abortScope.cleanup();
					finish(response.status, bytes ?? 0, undefined, error);
				},
				onCancel: () => abortScope.abort("caller_abort"),
			});
		}
		try {
			const responseHadBody = response.body !== null;
			const bounded = await readResponseBody(response, { signal: abortScope.signal });
			const inspection = inspectMcpJsonRpcBody(
				bounded.bytes,
				response.headers.get("content-type"),
			);
			if (inspection.sessionError) this.deleteSession(sessionKey);
			finish(
				response.status,
				bounded.byteLength,
				bounded.preview,
				undefined,
				inspection.status,
			);
			return new Response(responseHadBody ? bounded.bytes : null, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			const transportError = error instanceof McpTransportError ? error : undefined;
			finish(
				response.status,
				transportError?.bytes ?? 0,
				transportError?.preview,
				error,
			);
			throw error;
		} finally {
			abortScope.cleanup();
		}
	}

	/** Send the MCP `initialize` request to an upstream and return the raw response. */
	async sendInitialize(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		scopeKey?: string,
		directAuthToken?: string,
		callerSignal?: AbortSignal,
	): Promise<Response> {
		const response = await this.sendUpstreamRequest(
			httpServer,
			agentId,
			mcpId,
			"POST",
			INITIALIZE_BODY,
			scopeKey,
			directAuthToken,
			undefined,
			callerSignal,
			false,
		);
		// Discovery deliberately treats an authentication challenge as an empty
		// unauthenticated catalog. Preserve the raw response so the caller can
		// inspect its status instead of trying to parse a non-JSON challenge body.
		if (response.status === 401) return response;
		const refusal = await readUpstreamRefusal(response, mcpId);
		if (refusal) throw refusal;
		const parsed = (await parseJsonRpcResponse(response.clone())) as {
			result?: { protocolVersion?: unknown };
			error?: { message?: string };
		};
		if (parsed.error) {
			throw new Error(
				`MCP initialize failed: ${parsed.error.message ?? "unknown error"}`,
			);
		}
		const protocolVersion = parsed.result?.protocolVersion;
		if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
			throw new Error("MCP initialize response omitted protocolVersion");
		}
		const sessionKey = buildSessionKey(agentId, mcpId, scopeKey);
		const sessionId = this.getSession(sessionKey);
		if (sessionId) this.setSession(sessionKey, sessionId, protocolVersion);
		return response;
	}

	/** Send the MCP `notifications/initialized` notification (best-effort). */
	async sendInitializedNotification(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		scopeKey?: string,
		directAuthToken?: string,
		callerSignal?: AbortSignal,
	): Promise<void> {
		try {
			await this.sendUpstreamRequest(
				httpServer,
				agentId,
				mcpId,
				"POST",
				INITIALIZED_NOTIFICATION_BODY,
				scopeKey,
				directAuthToken,
				undefined,
				callerSignal,
				false,
			);
		} catch (error) {
			if (callerSignal?.aborted) throw error;
			// Notification delivery is best-effort.
		}
	}

	/**
	 * Re-initialize an MCP session by sending initialize + notifications/initialized.
	 * Called when upstream returns "Server not initialized" (stale session).
	 */
	async reinitializeSession(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		scopeKey?: string,
		directAuthToken?: string,
		callerSignal?: AbortSignal,
	): Promise<void> {
		// Clear stale session
		this.deleteSession(buildSessionKey(agentId, mcpId, scopeKey));

		const initResponse = await this.sendInitialize(
			httpServer,
			agentId,
			mcpId,
			scopeKey,
			directAuthToken,
			callerSignal,
		);
		await initResponse.text(); // consume response (may be JSON or SSE-framed)

		await this.sendInitializedNotification(
			httpServer,
			agentId,
			mcpId,
			scopeKey,
			directAuthToken,
			callerSignal,
		);

		logger.info("Re-initialized MCP session", { mcpId, agentId });
	}
}
