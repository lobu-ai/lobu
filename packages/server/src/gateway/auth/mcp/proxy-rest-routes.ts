import { createLogger } from "@lobu/core";
import type { Context } from "hono";
import {
	McpTransportError,
	parseJsonRpcResponse,
} from "../../../mcp-proxy/http-response.js";
import type { McpProxy } from "./proxy.js";
import {
	authenticateRequest,
	captureMcpTool,
	buildSessionKey,
	computeScopeKey,
	getRequestBodyAsText,
	type JsonRpcResponse,
	runWithWorkerOrgContext,
} from "./proxy-shared.js";
import { ssrfBlockResponse } from "./proxy-upstream.js";
import type { McpTool } from "./tool-cache.js";

const logger = createLogger("mcp-proxy");

export async function handleListTools(
	proxy: McpProxy,
	c: Context,
): Promise<Response> {
	const mcpId = c.req.param("mcpId");
	if (!mcpId) return c.json({ error: "Missing MCP server id" }, 400);
	const auth = await authenticateRequest(c);
	if (!auth) return c.json({ error: "Invalid authentication token" }, 401);
	if (!auth.tokenData.organizationId) {
		return c.json({ error: "Worker token missing organizationId" }, 401);
	}

	return runWithWorkerOrgContext(auth.tokenData, () =>
		handleListToolsAuthenticated(proxy, c, auth, mcpId),
	);
}

async function handleListToolsAuthenticated(
	proxy: McpProxy,
	c: Context,
	auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>,
	mcpId: string,
): Promise<Response> {
	const agentId = auth.tokenData.agentId || auth.tokenData.userId;
	const requesterUserId = auth.tokenData.userId;
	if (!agentId || !requesterUserId) {
		return c.json({ error: "Invalid authentication token" }, 401);
	}
	const httpServer = await proxy.configService.getHttpServer(mcpId, agentId, auth.tokenData.organizationId);
	if (!httpServer) {
		return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
	}

	// The curl-facing introspection endpoint must surface a hard SSRF block as
	// 403 — fetchToolsForMcp fails soft for agent-boot discovery and would
	// otherwise drain the blocked response and return an empty 200.
	const ssrfBlock = await ssrfBlockResponse(httpServer, mcpId, agentId);
	if (ssrfBlock) return ssrfBlock;

	try {
		const { tools, instructions } = await proxy.fetchToolsForMcp(
			mcpId,
			agentId,
			auth.tokenData,
			httpServer.internal === true ? auth.token : undefined,
			{ surfaceErrors: true, callerSignal: c.req.raw.signal },
		);
		return c.json({ tools, instructions });
	} catch (error) {
		logger.error("Failed to list tools", { mcpId, error });
		return c.json(
			{
				error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
			},
			502,
		);
	}
}

export async function handleCallTool(
	proxy: McpProxy,
	c: Context,
): Promise<Response> {
	const mcpId = c.req.param("mcpId");
	const toolName = c.req.param("toolName");
	if (!mcpId || !toolName) {
		return c.json({ error: "Missing MCP server id or tool name" }, 400);
	}
	const auth = await authenticateRequest(c);
	if (!auth) return c.json({ error: "Invalid authentication token" }, 401);
	if (!auth.tokenData.organizationId) {
		return c.json({ error: "Worker token missing organizationId" }, 401);
	}

	return runWithWorkerOrgContext(auth.tokenData, () =>
		handleCallToolAuthenticated(proxy, c, auth, mcpId, toolName),
	);
}

async function handleCallToolAuthenticated(
	proxy: McpProxy,
	c: Context,
	auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>,
	mcpId: string,
	toolName: string,
): Promise<Response> {
	const agentId = auth.tokenData.agentId || auth.tokenData.userId;
	const requesterUserId = auth.tokenData.userId;
	if (!agentId || !requesterUserId) {
		return c.json({ error: "Invalid authentication token" }, 401);
	}
	const httpServer = await proxy.configService.getHttpServer(mcpId, agentId, auth.tokenData.organizationId);
	if (!httpServer) {
		return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
	}
	const scopeKey = computeScopeKey(requesterUserId, auth.tokenData);

	// Parse body early so tool arguments are available for the approval message.
	let toolArguments: Record<string, unknown> = {};
	try {
		const body = await getRequestBodyAsText(c);
		if (body) {
			toolArguments = JSON.parse(body);
		}
	} catch (error) {
		if (error instanceof McpTransportError && error.kind === "oversized_request") {
			return c.json({ error: "Request body too large" }, 413);
		}
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	if (auth.tokenData.executionMode === "capture" && !httpServer.internal) {
		return c.json(await captureMcpTool(auth.tokenData, mcpId, toolName, toolArguments));
	}

	// Pre-tool guardrails — same enforcement as the JSON-RPC path so this REST
	// entrypoint can't bypass the stage. Runs before approval and independently
	// of grantStore.
	if (
		await proxy.runPreToolGuardrails(
			agentId,
			auth.tokenData,
			toolName,
			toolArguments,
		)
	) {
		return c.json({
			content: [{ type: "text", text: "Tool call blocked by policy." }],
			isError: true,
		});
	}

	// Check tool approval based on annotations and grants.
	const approval = auth.tokenData.executionMode === "capture" ? "allow" : await proxy.evaluateToolApproval(
		mcpId,
		toolName,
		toolArguments,
		agentId,
		auth.tokenData,
		auth.token,
	);
	if (approval === "blocked-notified") {
		return c.json(
			{
				content: [
					{
						type: "text",
						text: "Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
					},
				],
				isError: true,
			},
			403,
		);
	}
	if (approval === "blocked-no-channel") {
		return c.json(
			{
				content: [
					{
						type: "text",
						text: `Tool call requires approval. Request access approval in chat for: ${mcpId} → ${toolName}`,
					},
				],
				isError: true,
			},
			403,
		);
	}

	try {
		const sessionKey = buildSessionKey(agentId, mcpId, scopeKey);
		if (!proxy.upstream.getSession(sessionKey)) {
			await proxy.upstream.reinitializeSession(
				httpServer,
				agentId,
				mcpId,
				scopeKey,
				auth.token,
				c.req.raw.signal,
			);
		}

		const jsonRpcBody = JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: toolName, arguments: toolArguments },
			id: 1,
		});

		// Forward the caller's `x-mcp-format` opt-in so internal MCPs (the
		// embedded lobu-memory server) can return raw JSON instead of formatted
		// markdown. The worker uses this for retrieval tools to surface
		// structured `result_summary` (event ids + snippet text) through the
		// `tool_use` SSE event.
		const callerFormat = c.req.header("x-mcp-format");
		const extraHeaders = callerFormat
			? { "x-mcp-format": callerFormat }
			: undefined;

		let response = await proxy.upstream.sendUpstreamRequest(
			httpServer,
			agentId,
			mcpId,
			"POST",
			jsonRpcBody,
			scopeKey,
			auth.token,
			extraHeaders,
			c.req.raw.signal,
			false,
		);

		let data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;

		if (data?.error) {
			const errorMsg =
				data.error.message ||
				(typeof data.error === "string" ? data.error : "Upstream error");
			logger.error("Upstream returned JSON-RPC error on tool call", {
				mcpId,
				toolName,
				error: data.error,
			});

			return c.json(
				{
					content: [],
					isError: true,
					error: errorMsg,
				},
				502,
			);
		}

		const result = data?.result || {};
		return c.json({
			content: result.content || [],
			isError: result.isError || false,
		});
	} catch (error) {
		logger.error("Failed to call tool", { mcpId, toolName, error });
		return c.json(
			{
				content: [],
				isError: true,
				error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
			},
			502,
		);
	}
}

export async function handleListAllTools(
	proxy: McpProxy,
	c: Context,
): Promise<Response> {
	const auth = await authenticateRequest(c);
	if (!auth) return c.json({ error: "Invalid authentication token" }, 401);
	if (!auth.tokenData.organizationId) {
		return c.json({ error: "Worker token missing organizationId" }, 401);
	}

	return runWithWorkerOrgContext(auth.tokenData, () =>
		handleListAllToolsAuthenticated(proxy, c, auth),
	);
}

async function handleListAllToolsAuthenticated(
	proxy: McpProxy,
	c: Context,
	auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>,
): Promise<Response> {
	const agentId = auth.tokenData.agentId || auth.tokenData.userId;

	const allHttpServers = await proxy.configService.getAllHttpServers(agentId, auth.tokenData.organizationId);
	const allMcpIds = Array.from(allHttpServers.keys());

	const mcpServers: Record<string, { tools: McpTool[] }> = {};

	// Fetch tools in parallel, tolerate failures
	const results = await Promise.allSettled(
		allMcpIds.map(async (mcpId) => {
			const { tools } = await proxy.fetchToolsForMcp(
				mcpId,
				agentId,
				auth.tokenData,
				auth.token,
				{ callerSignal: c.req.raw.signal },
			);
			return { mcpId, tools };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled" && result.value.tools.length > 0) {
			mcpServers[result.value.mcpId] = { tools: result.value.tools };
		}
	}

	return c.json({ mcpServers });
}
