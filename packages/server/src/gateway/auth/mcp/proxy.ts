import { randomUUID } from "node:crypto";
import {
	createLogger,
	generateWorkerToken,
	getErrorMessage,
	type GuardrailRegistry,
	runGuardrailInstances,
	type WorkerTokenData,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  enabledInlineGuardrails,
  resolveAgentGuardrails,
} from "../../guardrails/aggregator.js";
import { recordGuardrailTrip } from "../../guardrails/audit.js";
import { parseJsonRpcResponse } from "../../../mcp-proxy/http-response.js";
import { requiresToolApproval } from "../../permissions/approval-policy.js";
import type { GrantStore } from "../../permissions/grant-store.js";
import type { AgentSettingsStore } from "../settings/agent-settings-store.js";
import {
	pairAdminGrant,
	type PendingAdminGrant,
	storePendingTool,
} from "./pending-tool-store.js";
import { handleProxyRequest } from "./proxy-forward.js";
import {
	handleCallTool,
	handleListAllTools,
	handleListTools,
} from "./proxy-rest-routes.js";
import {
	buildSessionKey,
	computeScopeKey,
	type JsonRpcResponse,
	type McpConfigSource,
	runWithOrganizationContext,
} from "./proxy-shared.js";
import { McpUpstreamClient } from "./proxy-upstream.js";
import type { CachedMcpServer, McpTool, McpToolCache } from "./tool-cache.js";

const logger = createLogger("mcp-proxy");

async function waitForMcpRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason ?? new Error("MCP request caller_abort");
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("MCP request caller_abort"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export type DirectToolExecutionOptions = {
	organizationId: string;
	conversationId?: string;
	channelId?: string;
	teamId?: string;
	connectionId?: string;
	platform?: string;
	source?: string;
	deploymentName?: string;
} & PendingAdminGrant;

export class McpProxy {
	// Tool-approval cards may sit in-thread for a long time before the user
	// actually clicks (Slack notifications, async review, etc.). The pending
	// invocation key holds the args needed to execute the tool after approval;
	// 24h gives users a realistic window to respond. Anything shorter silently
	// drops late clicks (the take-on-claim returns null and the click no-ops).
	private readonly PENDING_TOOL_TTL = 24 * 60 * 60; // 24 hours
	private app: Hono;
	private readonly toolCache?: McpToolCache;
	/** @internal Used by the route-handler modules (proxy-forward, proxy-rest-routes). */
	readonly grantStore?: GrantStore;
	/** @internal Used by the route-handler modules (proxy-forward, proxy-rest-routes). */
	readonly agentSettingsStore?: AgentSettingsStore;
	/** @internal Used by the route-handler modules (proxy-forward, proxy-rest-routes). */
	readonly guardrailRegistry?: GuardrailRegistry;
	/** @internal Upstream transport client (sessions, credentials, egress). */
	readonly upstream: McpUpstreamClient;

	/** Callback invoked when a tool call is blocked for approval. */
	public onToolBlocked?: (
		requestId: string,
		agentId: string,
		userId: string,
		mcpId: string,
		toolName: string,
		args: Record<string, unknown>,
		grantPattern: string,
		channelId: string,
		conversationId: string,
		teamId: string | undefined,
		connectionId: string | undefined,
		platform: string | undefined,
		source: string | undefined,
		turnMessageId: string | undefined,
	) => Promise<void>;

	constructor(
		readonly configService: McpConfigSource,
		options: {
			toolCache?: McpToolCache;
			grantStore?: GrantStore;
			/** Source of per-agent guardrail enable lists for the pre-tool stage. */
			agentSettingsStore?: AgentSettingsStore;
			/** Shared registry of guardrails; pre-tool stage entries are queried. */
			guardrailRegistry?: GuardrailRegistry;
		},
	) {
		this.toolCache = options.toolCache;
		this.grantStore = options.grantStore;
		this.agentSettingsStore = options.agentSettingsStore;
		this.guardrailRegistry = options.guardrailRegistry;
		this.upstream = new McpUpstreamClient();
		this.app = new Hono();
		this.setupRoutes();
		logger.debug("MCP proxy initialized");
	}

	getApp(): Hono {
		return this.app;
	}

	/**
	 * Execute an MCP tool call directly (internal use, no HTTP auth).
	 * Used by the interaction bridge to execute tool calls after user approval.
	 */
	async executeToolDirect(
		agentId: string,
		userId: string,
		mcpId: string,
		toolName: string,
		args: Record<string, unknown>,
		options: DirectToolExecutionOptions,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		isError: boolean;
	}> {
		return runWithOrganizationContext(options?.organizationId, () =>
			this.executeToolDirectScoped(
				agentId,
				userId,
				mcpId,
				toolName,
				args,
				options,
			),
		);
	}

	private async executeToolDirectScoped(
		agentId: string,
		userId: string,
		mcpId: string,
		toolName: string,
		args: Record<string, unknown>,
		options: DirectToolExecutionOptions,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		isError: boolean;
	}> {
		const { organizationId } = options;
		const httpServer = await this.configService.getHttpServer(
			mcpId,
			agentId,
			organizationId,
		);
		if (!httpServer) {
			return {
				content: [{ type: "text", text: `MCP server '${mcpId}' not found` }],
				isError: true,
			};
		}
		let directAuthToken: string | undefined;
		if (httpServer.internal) {
			if (!options.conversationId || !options.channelId) {
				return {
					content: [{ type: "text", text: "Approved tool execution is missing signed routing context" }],
					isError: true,
				};
			}
			directAuthToken = generateWorkerToken(
				userId,
				options.conversationId,
				options.deploymentName ?? `tool-approval:${agentId}`,
				{
					channelId: options.channelId,
					teamId: options.teamId,
					agentId,
					organizationId,
					connectionId: options.connectionId,
					platform: options.platform,
					source: options.source,
					// Unpaired admin grant → mint without the admin tier at all.
					...pairAdminGrant(options.adminTools, options.adminActorUserId),
				},
			);
		}

		const scopeKey = computeScopeKey(userId);
		const sessionKey = buildSessionKey(agentId, mcpId, scopeKey);

		const jsonRpcBody = JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: toolName, arguments: args },
			id: 1,
		});

		try {
			// Approval webhooks can land on a different gateway replica than the
			// blocked call. Upstream MCP sessions are intentionally replica-local,
			// so initialize on this replica before resuming the tool.
			if (!this.upstream.getSession(sessionKey)) {
				await this.upstream.reinitializeSession(
					httpServer,
					agentId,
					mcpId,
					scopeKey,
					directAuthToken,
				);
			}

			const sendToolCall = () =>
				this.upstream.sendUpstreamRequest(
					httpServer,
					agentId,
					mcpId,
					"POST",
					jsonRpcBody,
					scopeKey,
					directAuthToken,
					undefined,
					undefined,
					false,
				);
			let response = await sendToolCall();

			if (!response.ok) {
				const text = await response.text();
				return {
					content: [
						{
							type: "text",
							text: `Tool call failed: ${response.status} ${text}`,
						},
					],
					isError: true,
				};
			}

			let json = (await parseJsonRpcResponse(response)) as {
				result?: {
					content?: Array<{ type: string; text: string }>;
					isError?: boolean;
				};
				content?: Array<{ type: string; text: string }>;
				isError?: boolean;
				error?: { code?: number; message?: string };
			};
			if (json.error) {
				return {
					content: [{ type: "text", text: json.error.message ?? JSON.stringify(json.error) }],
					isError: true,
				};
			}
			const result = json.result || json;
			return {
				content: result.content || [
					{ type: "text", text: JSON.stringify(result) },
				],
				isError: result.isError || false,
			};
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Tool execution error: ${String(error)}`,
					},
				],
				isError: true,
			};
		}
	}

	/**
	 * Check if this request is an MCP proxy request (has X-Mcp-Id header)
	 * Used by gateway to determine if root path requests should be handled by MCP proxy
	 */
	isMcpRequest(c: Context): boolean {
		return !!c.req.header("x-mcp-id");
	}

	/**
	 * Fetch tools and instructions for a specific MCP server.
	 * Performs MCP initialize handshake first to capture server instructions,
	 * then fetches tool list.
	 */
	async fetchToolsForMcp(
		mcpId: string,
		agentId: string,
		tokenData: WorkerTokenData,
		workerToken?: string,
		options?: { surfaceErrors?: boolean; callerSignal?: AbortSignal },
	): Promise<{ tools: McpTool[]; instructions?: string }> {
		return runWithOrganizationContext(tokenData.organizationId, () =>
			this.fetchToolsForMcpScoped(
				mcpId,
				agentId,
				tokenData,
				workerToken,
				options,
			),
		);
	}

	private async fetchToolsForMcpScoped(
		mcpId: string,
		agentId: string,
		tokenData: WorkerTokenData,
		workerToken?: string,
		options?: { surfaceErrors?: boolean; callerSignal?: AbortSignal },
	): Promise<{ tools: McpTool[]; instructions?: string }> {
		if (this.toolCache) {
			const cached = this.toolCache.getServerInfo(mcpId, agentId);
			if (cached) return cached;
		}

		const httpServer = await this.configService.getHttpServer(
			mcpId,
			agentId,
			tokenData.organizationId,
		);
		if (!httpServer) {
			return { tools: [] };
		}

		const userId = tokenData?.userId;
		const scopeKey = computeScopeKey(userId, tokenData);

		const discoverOnce = async (): Promise<CachedMcpServer> => {
			this.upstream.deleteSession(buildSessionKey(agentId, mcpId, scopeKey));

			const initResponse = await this.upstream.sendInitialize(
				httpServer,
				agentId,
				mcpId,
				scopeKey,
				workerToken,
				options?.callerSignal,
			);
			if (initResponse.status === 401) {
				await initResponse.body?.cancel().catch(() => {
					/* noop */
				});
				return { tools: [] };
			}

			// `sendInitialize` already rejected a JSON-RPC error or a handshake
			// without a negotiated protocolVersion, so this body is a result.
			const initData = (await parseJsonRpcResponse(initResponse)) as {
				result?: {
					capabilities?: Record<string, unknown>;
					instructions?: string;
				};
			};
			const instructions = initData.result?.instructions;
			if (instructions) {
				logger.info("Captured MCP server instructions", {
					mcpId,
					length: instructions.length,
				});
			}

			await this.upstream.sendInitializedNotification(
				httpServer,
				agentId,
				mcpId,
				scopeKey,
				workerToken,
				options?.callerSignal,
			);

			// A server that did not advertise the tools capability is valid and
			// must not receive tools/list. Once tools are advertised, discovery
			// errors are transport failures rather than an empty catalog.
			if (!("tools" in (initData.result?.capabilities ?? {}))) {
				return { tools: [], instructions };
			}

			const response = await this.upstream.sendUpstreamRequest(
				httpServer,
				agentId,
				mcpId,
				"POST",
				JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/list",
					params: {},
					id: 1,
				}),
				scopeKey,
				workerToken,
				undefined,
				options?.callerSignal,
				false,
			);
			if (response.status === 401) {
				await response.body?.cancel().catch(() => {
					/* noop */
				});
				return { tools: [], instructions };
			}

			const data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
			if (data.error) {
				throw new Error(`MCP tools/list failed: ${data.error.message}`);
			}
			if (!Array.isArray(data.result?.tools)) {
				throw new Error("MCP tools/list response omitted tools");
			}
			return { tools: data.result.tools, instructions };
		};
		const cacheServerInfo = (serverInfo: CachedMcpServer) => {
			if (this.toolCache && serverInfo.tools.length > 0) {
				this.toolCache.setServerInfo(mcpId, serverInfo, agentId);
			}
		};

		try {
			const serverInfo = await discoverOnce();
			cacheServerInfo(serverInfo);
			return serverInfo;
		} catch (error) {
			if (options?.callerSignal?.aborted) throw error;
			logger.warn("MCP discovery failed, retrying once", {
				mcpId,
				error: getErrorMessage(error),
			});

			// Retry once after a short delay (upstream may still be starting)
			await waitForMcpRetry(2000, options?.callerSignal);
			try {
				const serverInfo = await discoverOnce();
				cacheServerInfo(serverInfo);
				logger.info("Retry succeeded for MCP discovery", {
					mcpId,
					toolCount: serverInfo.tools.length,
				});
				return serverInfo;
			} catch (retryError) {
				logger.error("Retry also failed for MCP discovery", {
					mcpId,
					error:
						retryError instanceof Error
							? retryError.message
							: String(retryError),
				});
				// The curl-facing REST endpoint surfaces upstream failures as 502;
				// agent-boot discovery (the default) fails soft so one unreachable
				// MCP doesn't block the worker from starting.
				if (options?.surfaceErrors) throw retryError;
			}
			if (options?.surfaceErrors) throw error;
			return { tools: [] };
		}
	}

	private setupRoutes() {
		// REST API endpoints for curl-based tool access (registered BEFORE catch-all)
		this.app.get("/tools", (c) => handleListAllTools(this, c));
		this.app.get("/:mcpId/tools", (c) => handleListTools(this, c));
		this.app.post("/:mcpId/tools/:toolName", (c) => handleCallTool(this, c));

		// Path-based routes (catch-all for MCP streamable-HTTP transport)
		this.app.all("/:mcpId", (c) => handleProxyRequest(this, c));
		this.app.all("/:mcpId/*", (c) => handleProxyRequest(this, c));
	}

	/**
	* Run the agent's resolved pre-tool guardrails for a `tools/call`. Returns
	* true if a guardrail tripped and the call must be blocked — the caller then returns a
	* generic, platform-shaped "blocked by policy" response (the specific reason
	* is never surfaced to the worker; that would be an evasion oracle).
	*
	* Shared by BOTH tool-call entrypoints — the JSON-RPC forward path
	* (`handleProxyRequest`) and the REST `handleCallTool` — so neither can
	* bypass the stage, and independent of `grantStore` so guardrails enforce
	* even when the approval subsystem isn't configured.
	*
	* Fails OPEN on store/registry-level errors (per-guardrail throws already
	* fail open in the runner); judge guardrails fail CLOSED by design.
	*
	* @internal Public only for the route-handler modules.
	*/
	async runPreToolGuardrails(
		agentId: string,
		tokenData: {
			userId: string;
			conversationId?: string;
			organizationId?: string;
		},
		toolName: string,
		toolArgs: Record<string, unknown>,
	): Promise<boolean> {
		if (!this.guardrailRegistry || !this.agentSettingsStore) return false;
		try {
			// Org-scope the read (see resolveAgentOptions): a shared agent id spans
			// orgs and this runs without ambient orgContext, so pass the org from
			// tokenData to avoid resolving another org's guardrails.
			const settings = await this.agentSettingsStore.getSettings(agentId, {
				organizationId: tokenData.organizationId,
			});
			const resolved = resolveAgentGuardrails(
				settings ?? { guardrails: [] },
				this.guardrailRegistry,
				{ inline: enabledInlineGuardrails(settings) },
			);
			const list = resolved.byStage["pre-tool"];
			if (list.length === 0) return false;
			const outcome = await runGuardrailInstances("pre-tool", list, {
				agentId,
				userId: tokenData.userId,
				toolName,
				arguments: toolArgs,
				conversationId: tokenData.conversationId,
			});
			if (!outcome.tripped) return false;
			// Resolve org id with a metadata fallback — per-job tokens carry it, but
			// legacy deployment-lifetime tokens may not, and an unaudited trip is a
			// security log gap.
			let resolvedOrgId = tokenData.organizationId;
			if (!resolvedOrgId) {
				try {
					const md = await this.agentSettingsStore.getMetadata(agentId);
					resolvedOrgId = md?.organizationId;
				} catch (lookupErr) {
					logger.warn(
						{
							agentId,
							err:
								lookupErr instanceof Error
									? lookupErr.message
									: String(lookupErr),
						},
						"Pre-tool guardrail trip: orgId metadata lookup failed (audit may be skipped)",
					);
				}
			}
			void recordGuardrailTrip({
				organizationId: resolvedOrgId,
				agentId,
				userId: tokenData.userId,
				conversationId: tokenData.conversationId,
				stage: "pre-tool",
				guardrail: outcome.tripped.guardrail,
				reason: outcome.tripped.reason,
				metadata: outcome.tripped.metadata,
			});
			logger.info(
				{ agentId, toolName, guardrail: outcome.tripped.guardrail },
				"Pre-tool guardrail tripped — blocking tool call with generic policy message",
			);
			return true;
		} catch (err) {
			// Fail open on store/registry-level errors — the runner already
			// fail-opens on per-guardrail throws.
			logger.warn(
				{
					agentId,
					toolName,
					err: getErrorMessage(err),
				},
				"Pre-tool guardrail check failed — proceeding without guardrails",
			);
			return false;
		}
	}

	/**
	 * Shared tool-approval gate used by the REST (`handleCallTool`) and JSON-RPC
	 * (`handleProxyRequest`) call paths. Resolves tool annotations, checks the
	 * grant store, and — if blocked — stores the pending invocation and fires
	 * `onToolBlocked`. Returns:
	 * - `"allow"`: not blocked (no approval needed, or a grant exists);
	 * - `"blocked-notified"`: blocked and the user was asked to approve;
	 * - `"blocked-no-channel"`: blocked but no `onToolBlocked` handler is wired,
	 *   so no approval card could be sent.
	 *
	 * @internal Public only for the route-handler modules.
	 */
	async evaluateToolApproval(
		mcpId: string,
		toolName: string,
		toolArgs: Record<string, unknown>,
		agentId: string,
		tokenData: WorkerTokenData,
		token: string,
	): Promise<"allow" | "blocked-notified" | "blocked-no-channel"> {
		if (!this.grantStore) return "allow";

		const { found, annotations } = await this.getToolAnnotations(
			mcpId,
			toolName,
			agentId,
			tokenData,
			token,
		);
		// Fail closed: when tool annotations can't be fetched (upstream error,
		// SSRF block, timeout, etc.), `found` is false. The previous semantics
		// returned "allow" here, which let destructive tools bypass approval
		// whenever discovery failed. Require approval unless we have annotations
		// that explicitly say the tool is safe.
		if (found && !requiresToolApproval(annotations)) return "allow";

		const pattern = `/mcp/${mcpId}/tools/${toolName}`;
		if (await this.grantStore.hasGrant(agentId, pattern)) return "allow";

		logger.info("Tool call blocked: requires approval", {
			agentId,
			mcpId,
			toolName,
			pattern,
		});

		if (!this.onToolBlocked) return "blocked-no-channel";
		if (!tokenData.organizationId) {
			logger.error(
				{ agentId, mcpId, toolName },
				"Refusing to store pending MCP tool approval without organizationId",
			);
			return "blocked-no-channel";
		}

		const requestId = `ta_${randomUUID()}`;
		await storePendingTool(
			requestId,
			{
				mcpId,
				toolName,
				args: toolArgs,
				agentId,
				userId: tokenData.userId,
				organizationId: tokenData.organizationId,
				channelId: tokenData.channelId || "",
				conversationId: tokenData.conversationId || "",
				teamId: tokenData.teamId,
				connectionId: tokenData.connectionId,
				platform: tokenData.platform,
				source: tokenData.source,
				...pairAdminGrant(tokenData.adminTools, tokenData.adminActorUserId),
				deploymentName: tokenData.deploymentName,
			},
			this.PENDING_TOOL_TTL,
		).catch((err: unknown) =>
			logger.error(
				{ requestId, error: String(err) },
				"Failed to store pending tool invocation",
			),
		);

		await this.onToolBlocked(
			requestId,
			agentId,
			tokenData.userId,
			mcpId,
			toolName,
			toolArgs,
			pattern,
			tokenData.channelId || "",
			tokenData.conversationId || "",
			tokenData.teamId,
			tokenData.connectionId,
			tokenData.platform,
			tokenData.source,
			tokenData.messageId,
		).catch((err) =>
			logger.error(
				{ requestId, error: String(err) },
				"onToolBlocked callback failed",
			),
		);

		return "blocked-notified";
	}

	private async getToolAnnotations(
		mcpId: string,
		toolName: string,
		agentId: string,
		tokenData: WorkerTokenData,
		workerToken?: string,
	): Promise<{ found: boolean; annotations?: McpTool["annotations"] }> {
		let tools: McpTool[] | null = null;
		if (this.toolCache) {
			tools = this.toolCache.get(mcpId, agentId);
		}

		if (!tools) {
			// Forward the worker JWT so internal MCPs (lobu-memory) can enumerate
			// tools — without it the discovery call goes unauthenticated and
			// returns an empty list, which would silently bypass the approval gate
			// (`found=false` means "no approval needed" at call sites).
			const result = await this.fetchToolsForMcp(
				mcpId,
				agentId,
				tokenData,
				workerToken,
			);
			tools = result.tools;
		}

		if (tools.length === 0) {
			return { found: false };
		}

		const tool = tools.find((t) => t.name === toolName);
		return { found: true, annotations: tool?.annotations };
	}
}
