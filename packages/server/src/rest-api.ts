/**
 * REST API Wrapper for ChatGPT Custom Actions
 *
 * Provides simple REST endpoints that wrap the MCP tools
 * for use with ChatGPT, Zapier, and other REST-based integrations
 */

import { toJsonSafe } from "@lobu/core";
import * as Sentry from "@sentry/node";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
	hasRequiredMcpScope,
	resolveMaxAccessLevel,
	SCOPE_CHECK_NOT_APPLICABLE,
} from "./auth/tool-access";
import { getScopedConnectorDefinition } from "./catalog/connector-definitions";
import { listOrgInstalled } from "./catalog/installed";
import { getDb } from "./db/client";
import { streamInvalidationEvents } from "./events/sse";
import { fixedActionArgs } from "./http/rest-tool-routes";
import type { Env } from "./index";
import { invokeTemplateEventAction } from "./interactions/template-event-actions";
import { invokeViewAction } from "./interactions/template-event-actions";
import { getView, isValidViewKey, renderViewShell } from "./views/views";
import { getOperationsSummary } from "./operations/connector-operations";
import { manageClassifiers } from "./tools/admin/manage_classifiers";
import { manageAutomations } from "./tools/admin/manage_automations";
import {
	executeTool,
	extractAuthContext,
	toToolContext,
} from "./tools/execute";
import { getContent } from "./tools/get_content";
import { getAutomation } from "./tools/get_automation";
import { toMcpPublicSdkScriptResult } from "./tools/sdk_run";
import {
	getAllTools,
	getTool,
	isRestDispatchTool,
	type ToolContext,
} from "./tools/registry";
import {
	errorMessage,
	parsePositiveIntegerId,
	ToolNotRegisteredError,
	ToolUserError,
} from "./utils/errors";
import logger from "./utils/logger";
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from "./utils/run-statuses";
import { getRuntimeInfo } from "./utils/runtime-info";

type GetAutomationArgs = Parameters<typeof getAutomation>[0];

function clamp(
	value: number,
	options?: { min?: number; max?: number }
): number {
	let result = value;
	if (options?.min !== undefined) result = Math.max(options.min, result);
	if (options?.max !== undefined) result = Math.min(options.max, result);
	return result;
}

function safeParseInt(
	value: string | undefined,
	options?: { min?: number; max?: number }
): number | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!/^[+-]?\d+$/.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) ? clamp(parsed, options) : undefined;
}

function parseAutomationId(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	return parsePositiveIntegerId(value, "automation_id");
}

function safeParseFloat(
	value: string | undefined,
	options?: { min?: number; max?: number }
): number | undefined {
	if (!value) return undefined;
	const parsed = parseFloat(value);
	return Number.isNaN(parsed) ? undefined : clamp(parsed, options);
}

async function resolvePublicOrganizationId(
	orgSlug: string
): Promise<string | null> {
	const sql = getDb();
	const rows = await sql`
    SELECT id
    FROM "organization"
    WHERE slug = ${orgSlug}
      AND visibility = 'public'
    LIMIT 1
  `;
	return (rows[0]?.id as string | undefined) ?? null;
}

function publicToolContext(
	requestUrl: string,
	organizationId: string
): ToolContext {
	return {
		organizationId,
		userId: null,
		memberRole: null,
		isAuthenticated: false,
		clientId: null,
		tokenType: "anonymous",
		// Anonymous public REST readers have no MCP scope dimension (gated by
		// org-scoping + public-readability). Sentinel keeps the read-scope guard
		// from failing closed on legitimate public reads.
		scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
		scopedToOrg: true,
		allowCrossOrg: false,
		grantedOrganizationIds: null,
		directSearchFederation: false,
		requestUrl,
		baseUrl: new URL(requestUrl).origin,
	};
}

async function withPublicOrg<T>(
	c: Context<{ Bindings: Env }>,
	handler: (organizationId: string) => Promise<T>
): Promise<Response> {
	try {
		const orgSlug = c.req.param("orgSlug");
		if (!orgSlug) {
			return c.json({ error: "Organization slug is required" }, 400);
		}
		const organizationId = await resolvePublicOrganizationId(orgSlug);
		if (!organizationId) {
			return c.json({ error: "Not found" }, 404);
		}
		const result = await handler(organizationId);
		return c.json(toJsonSafe(result));
	} catch (error) {
		return restErrorResponse(c, error);
	}
}

/**
 * Build the JSON body for a ToolUserError, including the structured taxonomy
 * (lobu#2051 Item 2) — `code`/`retryable`/`call_id` — when the error carries a code.
 */
function toolUserErrorBody(error: ToolUserError): Record<string, unknown> {
	return {
		error: error.message,
		...(error.code
			? {
					code: error.code,
					retryable: error.retryable,
					...(error.callId ? { call_id: error.callId } : {}),
				}
			: {}),
	};
}

function restErrorResponse(
	c: Context<{ Bindings: Env }>,
	error: unknown
): Response {
	if (error instanceof ToolUserError) {
		return c.json(
			toolUserErrorBody(error),
			error.httpStatus as ContentfulStatusCode
		);
	}
	return c.json({ error: errorMessage(error) }, 400);
}

/**
 * GET /api/automations
 * Get or list Automations.
 */
export async function restGetAutomations(c: Context<{ Bindings: Env }>) {
	try {
		const automationId = parseAutomationId(c.req.query("automation_id"));
		const entityId = safeParseInt(c.req.query("entity_id"), { min: 1 });

		if (!automationId) {
			const result = await manageAutomations(
				{
					action: "list",
					automation_id: automationId,
					entity_id: entityId,
					status: c.req.query("status") || undefined,
					include_details: c.req.query("include_details") === "true",
				} as any,
				c.env,
				toToolContext(extractAuthContext(c))
			);
			return c.json(toJsonSafe(result));
		}

		const params = {
			automation_id: String(automationId),
			entity_id: entityId,
			content_since: c.req.query("content_since"),
			content_until: c.req.query("content_until"),
			template_version: safeParseInt(c.req.query("template_version"), {
				min: 1,
			}),
			page: safeParseInt(c.req.query("page"), { min: 1 }),
			page_size: safeParseInt(c.req.query("page_size"), { min: 1, max: 500 }),
			include_classification:
				c.req.query("include_classification") || undefined,
			include_versions: c.req.query("include_versions") === "true",
			include_pending_ranges: c.req.query("include_pending_ranges") === "true",
		} satisfies GetAutomationArgs;

		const ctx = toToolContext(extractAuthContext(c));
		const result = await getAutomation(params, c.env, ctx);
		return c.json(toJsonSafe(result));
	} catch (error) {
		return restErrorResponse(c, error);
	}
}

export async function publicRestGetAutomations(c: Context<{ Bindings: Env }>) {
	return withPublicOrg(c, async (organizationId) => {
		const automationId = parseAutomationId(c.req.query("automation_id"));
		const entityId = safeParseInt(c.req.query("entity_id"), { min: 1 });
		const ctx = publicToolContext(c.req.url, organizationId);
		const detailRequested =
			!!automationId ||
			[
				"content_since",
				"content_until",
				"template_version",
				"page",
				"page_size",
				"include_classification",
				"include_versions",
				"include_pending_ranges",
			].some((key) => c.req.query(key) !== undefined);

		if (!detailRequested) {
			return manageAutomations(
				{
					action: "list",
					entity_id: entityId,
					status: c.req.query("status") || undefined,
					include_details: c.req.query("include_details") === "true",
				} as any,
				c.env,
				ctx
			);
		}

		const params = {
			automation_id: automationId === undefined ? undefined : String(automationId),
			entity_id: entityId,
			content_since: c.req.query("content_since"),
			content_until: c.req.query("content_until"),
			template_version: safeParseInt(c.req.query("template_version"), {
				min: 1,
			}),
			page: safeParseInt(c.req.query("page"), { min: 1 }),
			page_size: safeParseInt(c.req.query("page_size"), { min: 1, max: 500 }),
			include_classification:
				c.req.query("include_classification") || undefined,
			include_versions: c.req.query("include_versions") === "true",
			include_pending_ranges:
				c.req.query("include_pending_ranges") === "true",
		} satisfies Partial<GetAutomationArgs>;

		// Partial + cast (not `satisfies GetAutomationArgs`): detailRequested can
		// be triggered by a detail query param without automation_id, so
		// automation_id may be undefined here — the tool's own arg validation
		// turns that into the 400 naming the missing field.
		return getAutomation(params as GetAutomationArgs, c.env, ctx);
	});
}

/**
 * GET /api/health
 * Health check endpoint
 */
export async function restHealth(c: Context<{ Bindings: Env }>) {
	return c.json({
		status: "healthy",
		service: "lobu-api",
		timestamp: new Date().toISOString(),
		...getRuntimeInfo(c.env),
	});
}

/** Proxy a fixed-action REST route without letting request params retarget it. */
export async function restToolAction(
	c: Context<{ Bindings: Env }>,
	toolName: string,
	action: string,
	callerArgs?: Record<string, unknown>
) {
	return restToolProxy(c, toolName, fixedActionArgs(action, callerArgs));
}

/** Match the concise SDK result contract exposed by MCP and OpenAPI. */
export function toRestPublicToolResult(
	toolName: string,
	result: unknown,
): unknown {
	return toolName === "run_sdk" || toolName === "query_sdk"
		? toMcpPublicSdkScriptResult(result)
		: result;
}

/**
 * POST /api/:orgSlug/:toolName
 * Generic proxy endpoint for the REST dispatch tool surface.
 *
 * Agent and internal tools can be called without individual wrappers. MCP Apps
 * presentation tools remain MCP-only and are rejected here.
 */
export async function restToolProxy(
	c: Context<{ Bindings: Env }>,
	explicitToolName?: string,
	explicitArgs?: Record<string, unknown>
) {
	try {
		const toolName = explicitToolName ?? c.req.param("toolName");
		if (!toolName) {
			return c.json({ error: "Tool name is required" }, 400);
		}
		if (!isRestDispatchTool(toolName)) {
			throw new ToolNotRegisteredError(toolName);
		}
		const args: Record<string, unknown> = explicitArgs ?? (await c.req.json());
		const authCtx = extractAuthContext(c);
		const result = await executeTool(toolName, args, c.env, authCtx);
		return c.json(toJsonSafe(toRestPublicToolResult(toolName, result)));
	} catch (error) {
		if (error instanceof ToolNotRegisteredError) {
			// Registry/frontend drift — surface to Sentry so the next "Tool not
			// found" outage doesn't sit silent behind a 400 the page swallows.
			// `tool_name` goes in `extra` (not `tags`) because the URL segment is
			// attacker-controlled and would otherwise blow up tag cardinality.
			Sentry.captureException(error, {
				tags: { source: "rest_proxy" },
				extra: { tool_name: error.toolName },
			});
		}
		return restErrorResponse(c, error);
	}
}

/**
 * POST /api/:orgSlug/events/:eventId/actions/:action
 *
 * Web counterpart of the MCP App/chat adapters. Identity comes exclusively
 * from the authenticated session; the body carries only the rendered value
 * and the browser retry id.
 */
export async function restInvokeEventAction(c: Context<{ Bindings: Env }>) {
	try {
		const ctx = toToolContext(extractAuthContext(c));
		if (!ctx.isAuthenticated || !ctx.userId) {
			throw new ToolUserError(
				"A signed-in Lobu user is required for this interaction.",
				401,
			);
		}
		if (
			!hasRequiredMcpScope("write", ctx.scopes) ||
			resolveMaxAccessLevel(ctx.memberRole, ctx.scopes) === "read"
		) {
			throw new ToolUserError("This interaction requires write access.", 403);
		}
		const rawEventId = c.req.param("eventId");
		const action = c.req.param("action");
		if (!rawEventId || !action) {
			throw new ToolUserError("event_id and action are required", 400);
		}
		const eventId = parsePositiveIntegerId(rawEventId, "event_id");
		const body = await c.req.json<{
			value?: unknown;
			interaction_id?: unknown;
		}>();
		if (body.value !== undefined && body.value !== null && typeof body.value !== "string") {
			throw new ToolUserError("value must be a string or null", 400);
		}
		if (typeof body.interaction_id !== "string") {
			throw new ToolUserError("interaction_id is required", 400);
		}
		const result = await invokeTemplateEventAction({
			organizationId: ctx.organizationId,
			sourceEventId: eventId,
			action,
			value: body.value ?? null,
			interactionId: body.interaction_id,
			surface: "web",
			actor: {
				platform: "lobu",
				platformUserId: ctx.userId,
				userId: ctx.userId,
			},
			source: { clientId: ctx.clientId ?? null },
		});
		return c.json(
			toJsonSafe({
				created: result.created,
				event_id: result.eventId,
				event_type: result.eventType,
			}),
		);
	} catch (error) {
		return restErrorResponse(c, error);
	}
}

/**
 * GET /api/:orgSlug/views/:key/shell
 *
 * One view's HTML shell with the compiled bundle inlined. Authenticated like
 * every other org route — the web host fetches it with the session and mounts
 * it `srcdoc` into the sandboxed frame, so there is deliberately no public
 * (unauthenticated) shell route.
 */
export async function restGetViewShell(c: Context<{ Bindings: Env }>) {
	try {
		const ctx = toToolContext(extractAuthContext(c));
		if (!ctx.isAuthenticated || !ctx.userId) {
			throw new ToolUserError(
				"A signed-in Lobu user is required to read views.",
				401
			);
		}
		if (!hasRequiredMcpScope("read", ctx.scopes)) {
			throw new ToolUserError("Reading views requires read access.", 403);
		}
		const key = c.req.param("key") ?? "";
		if (!isValidViewKey(key)) {
			throw new ToolUserError("Invalid view key", 400);
		}
		const view = await getView(ctx.organizationId, key);
		if (!view) {
			throw new ToolUserError(`Unknown view: ${key}`, 404);
		}
		const html = renderViewShell(view);
		c.header("Content-Type", "text/html; charset=utf-8");
		c.header("Cache-Control", "no-store");
		c.header("X-Lobu-View-Hash", view.content_hash);
		c.header(
			"X-Lobu-View-Bytes",
			String(Buffer.byteLength(view.compiled_code, "utf8"))
		);
		return c.body(html);
	} catch (error) {
		return restErrorResponse(c, error);
	}
}

/**
 * POST /api/:orgSlug/views/:key/actions/:action
 *
 * Web counterpart of `invoke_view_action`. Identity comes exclusively from
 * the authenticated session; the body carries the action payload and the
 * browser retry id.
 */
export async function restInvokeViewAction(c: Context<{ Bindings: Env }>) {
	try {
		const ctx = toToolContext(extractAuthContext(c));
		if (!ctx.isAuthenticated || !ctx.userId) {
			throw new ToolUserError(
				"A signed-in Lobu user is required for this interaction.",
				401
			);
		}
		if (
			!hasRequiredMcpScope("write", ctx.scopes) ||
			resolveMaxAccessLevel(ctx.memberRole, ctx.scopes) === "read"
		) {
			throw new ToolUserError("This interaction requires write access.", 403);
		}
		const key = c.req.param("key") ?? "";
		const action = c.req.param("action") ?? "";
		if (!isValidViewKey(key) || !action) {
			throw new ToolUserError("view key and action are required", 400);
		}
		const body = await c.req.json<{
			value?: unknown;
			interaction_id?: unknown;
		}>();
		if (
			body.value !== undefined &&
			body.value !== null &&
			(typeof body.value !== "object" || Array.isArray(body.value))
		) {
			throw new ToolUserError("value must be an object or null", 400);
		}
		if (typeof body.interaction_id !== "string" || !body.interaction_id) {
			throw new ToolUserError("interaction_id is required", 400);
		}
		const result = await invokeViewAction({
			organizationId: ctx.organizationId,
			viewKey: key,
			action,
			value: (body.value ?? null) as Record<string, unknown> | null,
			interactionId: body.interaction_id,
			surface: "web",
			actor: {
				platform: "lobu",
				platformUserId: ctx.userId,
				userId: ctx.userId,
			},
			source: { clientId: ctx.clientId ?? null },
		});
		return c.json(
			toJsonSafe({
				created: result.created,
				event_id: result.eventId,
				event_type: result.eventType,
			})
		);
	} catch (error) {
		return restErrorResponse(c, error);
	}
}

/**
 * GET /api/:orgSlug/tools
 * List the REST dispatch surface available to the caller, filtered by the
 * caller's access level (role × scope). MCP Apps presentation tools are not
 * part of this surface.
 */
export async function restListTools(c: Context<{ Bindings: Env }>) {
	try {
		const authCtx = extractAuthContext(c);
		if (!authCtx.organizationId) {
			return c.json(
				{
					error:
						"Organization context required. Authenticate with OAuth or API key.",
				},
				401
			);
		}
		const maxAccessLevel = resolveMaxAccessLevel(
			authCtx.memberRole,
			authCtx.scopes
		);
		const tools = getAllTools({
			publicOnly: false,
			maxAccessLevel,
		});
		return c.json({
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				...(tool.annotations && { annotations: tool.annotations }),
			})),
		});
	} catch (error) {
		return restErrorResponse(c, error);
	}
}

/**
 * GET /api/knowledge/search
 * Wrapper for read_knowledge MCP tool (search mode)
 *
 * Query Parameters (must be a subset of GetContentSchema — withValidatedArgs
 * rejects unknown keys):
 * - query (required on auth route): Search text (min 3 characters)
 * - entity_id, connection_ids / connection_id, feed_ids, run_ids
 * - platforms / platform (singular is mapped to platforms[])
 * - since, until, min_similarity, limit, offset, cursors
 * - include_classification (optional): aggregates only — "summary"
 *
 * Per-item classifications are always attached by the tool handler; there is
 * no client flag for that (legacy `include_classifications` was internal-only
 * and must never be forwarded into getContent).
 */
function parseIdListParam(raw: string | undefined): number[] | undefined {
	if (!raw) return undefined;
	const ids = raw
		.split(",")
		.map((id) => safeParseInt(id.trim(), { min: 1 }))
		.filter((id): id is number => id !== undefined);
	return ids.length > 0 ? ids : undefined;
}

function parseStringListParam(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	const values = raw
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return values.length > 0 ? values : undefined;
}

/** Merge `platforms=a,b` with legacy singular `platform=a` into schema `platforms`. */
export function parsePlatformsQuery(
	platformsCsv: string | undefined,
	platformSingular: string | undefined
): string[] | undefined {
	const fromList = parseStringListParam(platformsCsv);
	const singular = platformSingular?.trim();
	if (!singular) return fromList;
	if (!fromList) return [singular];
	if (fromList.includes(singular)) return fromList;
	return [...fromList, singular];
}

export async function restSearchKnowledge(c: Context<{ Bindings: Env }>) {
	try {
		const query = c.req.query("query");
		if (!query || query.trim().length < 3) {
			return c.json({ error: "Query must be at least 3 characters" }, 400);
		}

		const connectionId = safeParseInt(c.req.query("connection_id"), { min: 1 });
		const params = {
			query,
			entity_id: safeParseInt(c.req.query("entity_id"), { min: 1 }),
			connection_ids:
				parseIdListParam(c.req.query("connection_ids")) ??
				(connectionId ? [connectionId] : undefined),
			feed_ids: parseIdListParam(c.req.query("feed_ids")),
			run_ids: parseIdListParam(c.req.query("run_ids")),
			platforms: parsePlatformsQuery(
				c.req.query("platforms"),
				c.req.query("platform")
			),
			since: c.req.query("since"),
			until: c.req.query("until"),
			min_similarity: safeParseFloat(c.req.query("min_similarity"), {
				min: 0,
				max: 1,
			}),
			include_classification:
				c.req.query("include_classification") || undefined,
			limit: safeParseInt(c.req.query("limit"), { min: 1, max: 500 }),
			offset: safeParseInt(c.req.query("offset"), { min: 0 }),
			before_occurred_at: c.req.query("before_occurred_at") || undefined,
			before_id: safeParseInt(c.req.query("before_id"), { min: 1 }),
			after_occurred_at: c.req.query("after_occurred_at") || undefined,
			after_id: safeParseInt(c.req.query("after_id"), { min: 1 }),
			interaction_status: c.req.query("interaction_status") || undefined,
			entity_types: parseStringListParam(c.req.query("entity_types")),
		};

		const ctx = toToolContext(extractAuthContext(c));
		const result = await getContent(params as any, c.env, ctx);
		return c.json(toJsonSafe(result));
	} catch (error) {
		logger.error({ error }, "[REST API] Knowledge search error");
		return restErrorResponse(c, error);
	}
}

export async function publicRestSearchKnowledge(c: Context<{ Bindings: Env }>) {
	return withPublicOrg(c, async (organizationId) => {
		const query = c.req.query("query");

		const connectionId = safeParseInt(c.req.query("connection_id"), { min: 1 });
		const contentIds = c.req.query("content_ids");
		const params = {
			query: query?.trim() || undefined,
			entity_id: safeParseInt(c.req.query("entity_id"), { min: 1 }),
			connection_ids:
				parseIdListParam(c.req.query("connection_ids")) ??
				(connectionId ? [connectionId] : undefined),
			feed_ids: parseIdListParam(c.req.query("feed_ids")),
			run_ids: parseIdListParam(c.req.query("run_ids")),
			platforms: parsePlatformsQuery(
				c.req.query("platforms"),
				c.req.query("platform")
			),
			since: c.req.query("since"),
			until: c.req.query("until"),
			engagement_min: safeParseInt(c.req.query("engagement_min"), {
				min: 0,
				max: 100,
			}),
			engagement_max: safeParseInt(c.req.query("engagement_max"), {
				min: 0,
				max: 100,
			}),
			classification_filters: (() => {
				const raw = c.req.query("classification_filters");
				if (!raw) return undefined;
				try {
					return JSON.parse(raw);
				} catch {
					return undefined;
				}
			})(),
			classification_source: c.req.query("classification_source") || undefined,
			run_id: safeParseInt(c.req.query("run_id"), { min: 1 }),
			content_ids: contentIds
				? contentIds
						.split(",")
						.map((id) => safeParseInt(id.trim(), { min: 1 }))
						.filter((id): id is number => id !== undefined)
				: undefined,
			min_similarity: safeParseFloat(c.req.query("min_similarity"), {
				min: 0,
				max: 1,
			}),
			include_classification:
				c.req.query("include_classification") || undefined,
			limit: safeParseInt(c.req.query("limit"), { min: 1, max: 500 }),
			offset: safeParseInt(c.req.query("offset"), { min: 0 }),
			sort_by: c.req.query("sort_by") || undefined,
			sort_order: c.req.query("sort_order") || undefined,
			before_occurred_at: c.req.query("before_occurred_at") || undefined,
			before_id: safeParseInt(c.req.query("before_id"), { min: 1 }),
			after_occurred_at: c.req.query("after_occurred_at") || undefined,
			after_id: safeParseInt(c.req.query("after_id"), { min: 1 }),
			interaction_status: c.req.query("interaction_status") || undefined,
			entity_types: parseStringListParam(c.req.query("entity_types")),
		};

		return getContent(
			params as any,
			c.env,
			publicToolContext(c.req.url, organizationId)
		);
	});
}

export async function publicRestListClassifiers(c: Context<{ Bindings: Env }>) {
	return withPublicOrg(c, async (organizationId) => {
		const entityId = safeParseInt(c.req.query("entity_id"), { min: 1 });
		return manageClassifiers(
			{ action: "list", entity_id: entityId },
			c.env,
			publicToolContext(c.req.url, organizationId)
		);
	});
}

export async function publicRestListConnectors(c: Context<{ Bindings: Env }>) {
	return withPublicOrg(c, async (organizationId) => {
		const entityId = safeParseInt(c.req.query("entity_id"), { min: 1 });

		let entityConnectorKeys: Set<string> | null = null;
		if (entityId !== undefined) {
			const sql = getDb();
			const keyRows = await sql`
        SELECT DISTINCT c.connector_key
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id
        WHERE f.organization_id = ${organizationId}
          AND ${entityId}::int = ANY(f.entity_ids)
          AND c.deleted_at IS NULL
          AND f.deleted_at IS NULL
          AND c.visibility = 'org'
      `;
			entityConnectorKeys = new Set(
				keyRows.map((r) =>
					String((r as { connector_key: string }).connector_key)
				)
			);
		}

		const installed = await listOrgInstalled(organizationId, ["connectors"], {
			organizationId,
			userId: null,
			memberRole: null,
			isAuthenticated: false,
		});
		let items = installed.connectors?.items ?? [];
		if (entityConnectorKeys) {
			items = items.filter((item) => entityConnectorKeys.has(item.id));
		}

		return {
			installed: {
				connectors: {
					kind: "connectors",
					items,
				},
			},
		};
	});
}

export async function publicRestGetConnector(c: Context<{ Bindings: Env }>) {
	return withPublicOrg(c, async (organizationId) => {
		const sql = getDb();
		const connectorKey = c.req.param("connectorKey");
		if (!connectorKey) {
			throw new Error("Connector key is required");
		}

		const connector = await getScopedConnectorDefinition({
			organizationId,
			connectorKey,
		});

		if (!connector) {
			throw new ToolUserError("Connector not found", 404);
		}

		const feeds = await sql`
      SELECT
        f.id,
        f.connection_id,
        f.display_name,
        f.feed_key,
        f.status,
        f.config,
        f.entity_ids,
        (
          SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
          FROM entities ent
          WHERE ent.id = ANY(f.entity_ids)
        ) AS entity_names,
        c.connector_key,
        c.display_name AS connection_name,
        c.status AS connection_status,
        (
          SELECT COUNT(*) FROM runs r
          WHERE r.feed_id = f.id AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        )::int AS active_runs,
        (
          SELECT COUNT(*) FROM current_event_records e
          WHERE e.connection_id = f.connection_id AND e.feed_key = f.feed_key
        )::int AS event_count,
        f.last_sync_at,
        f.last_sync_status,
        f.next_run_at,
        f.created_at,
        f.updated_at
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE f.organization_id = ${organizationId}
        AND c.connector_key = ${connectorKey}
        AND c.deleted_at IS NULL
        AND f.deleted_at IS NULL
        AND c.visibility = 'org'
      ORDER BY COALESCE(f.updated_at, f.created_at) DESC
    `;

		const firstConnectionId = (feeds as Array<{ connection_id?: unknown }>)
			.map((feed) => Number(feed.connection_id))
			.find((id) => Number.isFinite(id) && id > 0);

		const operationsSummary = await getOperationsSummary(
			organizationId,
			connector.key,
			firstConnectionId,
		);

		return {
			connector: {
				...connector,
				source_path: undefined,
				actions_schema: undefined,
				operations_summary: operationsSummary,
				has_operations: operationsSummary.total > 0,
			},
			feeds,
		};
	});
}

/**
 * GET /api/:orgSlug/public/organization
 * Sanitized org metadata for non-members of a public workspace.
 * No member roster, no internal settings.
 */
export async function publicRestGetOrganization(c: Context<{ Bindings: Env }>) {
	return withPublicOrg(c, async (organizationId) => {
		const sql = getDb();
		const rows = await sql<{
			id: string;
			slug: string;
			name: string;
			description: string | null;
			logo: string | null;
			visibility: string;
			created_at: string;
		}>`
      SELECT id, slug, name, description, logo, visibility, "createdAt" AS created_at
      FROM "organization"
      WHERE id = ${organizationId}
      LIMIT 1
    `;
		const org = rows[0];
		if (!org) throw new Error("Organization not found");

		const [{ count: agent_count }] = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM agents
      WHERE organization_id = ${organizationId}
    `;
		const [{ count: entity_type_count }] = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM entity_types
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
    `;
		return {
			organization: {
				...org,
				agent_count,
				entity_type_count,
			},
		};
	});
}

/**
 * Cache keys safe to forward to anonymous / non-member viewers of a public org.
 * Must exclude notifications, member-admin, and connector-admin events.
 */
const PUBLIC_INVALIDATION_KEYS = new Set([
	"resolve-path",
	"entity-types",
	"view-template-history",
	"contents-filtered",
]);

/**
 * GET /api/:orgSlug/public/events
 * SSE stream of cache invalidation events for non-members of a public workspace.
 * Only public-readable keys are forwarded; notifications / member / connector
 * admin invalidations are filtered out.
 */
export async function publicRestEventsStream(c: Context<{ Bindings: Env }>) {
	const orgSlug = c.req.param("orgSlug");
	if (!orgSlug) return c.json({ error: "Organization slug is required" }, 400);

	const organizationId = await resolvePublicOrganizationId(orgSlug);
	if (!organizationId) return c.json({ error: "Not found" }, 404);

	return streamInvalidationEvents(c, organizationId, {
		filter: (event) => {
			const publicKeys = event.keys.filter((k) =>
				PUBLIC_INVALIDATION_KEYS.has(k)
			);
			if (publicKeys.length === 0) return null;
			return { ...event, keys: publicKeys };
		},
	});
}

/**
 * PATCH /api/content/:id/classifications/:classifier_slug
 * Update a single content item's classification manually
 *
 * Path Parameters:
 * - id: Content ID (integer)
 * - classifier_slug: Classifier slug (e.g., "sentiment", "bug-severity")
 *
 * Body:
 * - value: string | null (null to unset)
 */
export async function restUpdateContentClassification(
	c: Context<{ Bindings: Env }>
) {
	try {
		const contentId = parseInt(c.req.param("id") ?? "", 10);
		const classifierSlug = c.req.param("classifier_slug");
		const body = await c.req.json<{ value: string | null }>();

		if (Number.isNaN(contentId)) {
			return c.json({ error: "Invalid content ID" }, 400);
		}

		if (!classifierSlug) {
			return c.json({ error: "Classifier slug is required" }, 400);
		}

		// Call the MCP tool (manage_classifiers with classify action)
		const tool = getTool("manage_classifiers");
		if (!tool) {
			return c.json({ error: "Tool not found" }, 500);
		}

		const role = c.var.memberRole;
		if (role !== "owner" && role !== "admin") {
			return c.json(
				{ error: "Forbidden", message: "Owner or admin role required" },
				403
			);
		}

		const ctx = toToolContext(extractAuthContext(c));
		const result = await tool.handler(
			{
				action: "classify",
				content_id: contentId,
				classifier_slug: classifierSlug,
				value: body.value,
			},
			c.env,
			ctx
		);

		if (!result.success) {
			return c.json({ error: result.message }, 400);
		}

		// Fetch the updated classification to return to frontend
		const sql = getDb();
		const classificationResult = await sql`
      SELECT
        fc.attribute_key,
        cc.values,
        cc.confidences,
        cc.source,
        cc.is_manual
      FROM event_classifications cc
      JOIN classify_facet fc ON cc.classifier_id = fc.id
      WHERE cc.event_id = ${contentId}
        AND fc.slug = ${classifierSlug}
      ORDER BY
        CASE cc.source WHEN 'user' THEN 1 WHEN 'llm' THEN 2 ELSE 3 END,
        cc.created_at DESC
      LIMIT 1
    `;

		if (classificationResult.length === 0) {
			return c.json({ error: "Classification not found after update" }, 500);
		}

		const { attribute_key, values, confidences, source, is_manual } =
			classificationResult[0];
		const classificationData = { values, confidences, source, is_manual };

		return c.json(
			toJsonSafe({
				attribute_key,
				classification: classificationData,
			})
		);
	} catch (error) {
		logger.error({ error }, "[REST API] Update classification error");
		return restErrorResponse(c, error);
	}
}
