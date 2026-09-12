import type { FeedReadResult, FeedReadWindow } from '@lobu/connector-sdk';
/**
 * Atlassian Rovo MCP feed-read adapter.
 *
 * MCP install is tools-only (`feeds: null`). Rovo already exposes
 * `searchJiraIssuesUsingJql`, the same primitive the bundled Jira feed's
 * `read` handler uses. This module stamps that feed onto an Atlassian MCP definition
 * and reads it through the existing MCP proxy — no second connector, no
 * approval-gated manage_operations execute.
 */

import { callTool } from "../mcp-proxy/client";
import type { McpProxyConfig } from "../mcp-proxy/types";
import {
	pickUniqueJiraSite,
	type AtlassianAccessibleResource,
	type JiraCloudSite,
} from "../connect/atlassian-resources";

export const ATLASSIAN_JIRA_ISSUES_FEED_KEY = "issues";

function sourceCallOptions(params: {
	signal?: AbortSignal;
	deadlineAt?: number;
}): { signal?: AbortSignal; timeoutMs?: number } {
	const timedOut = (): Error & { exitReason: "timeout" } =>
		Object.assign(new Error("Atlassian source read timed out"), {
			exitReason: "timeout" as const,
		});
	if (params.signal?.aborted) throw timedOut();
	if (params.deadlineAt === undefined) return { signal: params.signal };
	const timeoutMs = Math.trunc(params.deadlineAt - Date.now());
	if (timeoutMs <= 0) throw timedOut();
	return { signal: params.signal, timeoutMs };
}

export const ATLASSIAN_JIRA_ISSUE_COLUMNS = [
	{ name: "id", type: "string" },
	{ name: "key", type: "string" },
	{ name: "summary", type: "string" },
	{ name: "status", type: "string" },
	{ name: "assignee", type: "string" },
	{ name: "reporter", type: "string" },
	{ name: "priority", type: "string" },
	{ name: "project_key", type: "string" },
	{ name: "project_name", type: "string" },
	{ name: "labels", type: "string" },
	{ name: "created_at", type: "string" },
	{ name: "updated_at", type: "string" },
	{ name: "description", type: "string" },
	{ name: "url", type: "string" },
] as const;

/** Same issues feed the bundled Jira connector declares. */
export const ATLASSIAN_MCP_FEEDS = {
	issues: {
		key: ATLASSIAN_JIRA_ISSUES_FEED_KEY,
		name: "Issues",
		description:
			"Live Jira issues via JQL. Reads call Rovo searchJiraIssuesUsingJql; signed Jira issue/comment webhooks are copied into events.",
		operations: ["read"],
		readWindowAxis: "updated_at",
		configSchema: {
			type: "object",
			properties: {
				cloud_id: {
					type: "string",
					description:
						"Atlassian Cloud id (usually auto-set on the connection after OAuth). Optional feed-level override for multi-site tokens.",
				},
				query: {
					type: "string",
					description:
						"Base JQL for source reads. Empty defaults to updated >= -90d.",
				},
				jql: {
					type: "string",
					description:
						"Fallback JQL when query is unset (same as the bundled Jira feed).",
				},
				max_results: {
					type: "integer",
					minimum: 1,
					maximum: 100,
					description:
						"Page size per Rovo search request (default min(limit, 50), max 100).",
				},
			},
		},
		eventKinds: {
			issue: {
				description: "A Jira issue",
				metadataSchema: {
					type: "object",
					properties: {
						key: { type: "string" },
						status: { type: "string" },
						assignee: { type: "string" },
						reporter: { type: "string" },
						updated_at: { type: "string" },
					},
				},
			},
			comment: {
				description: "A comment on a Jira issue",
				metadataSchema: {
					type: "object",
					properties: {
						updated_at: { type: "string" },
					},
				},
			},
		},
	},
};

const SORT_COLUMNS: Record<string, string> = {
	updated: "updated",
	updated_at: "updated",
	created: "created",
	created_at: "created",
	key: "key",
	priority: "priority",
	status: "status",
};

export function isAtlassianMcpUrl(url: string | null | undefined): boolean {
	if (!url) return false;
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "mcp.atlassian.com" || host.endsWith(".mcp.atlassian.com");
	} catch {
		return false;
	}
}

export function isAtlassianMcpConfig(
	raw: Record<string, unknown> | null | undefined,
): raw is Record<string, unknown> & { upstream_url: string } {
	if (!raw) return false;
	const upstream =
		typeof raw.upstream_url === "string"
			? raw.upstream_url
			: typeof raw.upstreamUrl === "string"
				? raw.upstreamUrl
				: null;
	return isAtlassianMcpUrl(upstream);
}

export function normalizeMcpProxyConfig(
	raw: Record<string, unknown>,
): McpProxyConfig | null {
	const upstream =
		typeof raw.upstream_url === "string"
			? raw.upstream_url
			: typeof raw.upstreamUrl === "string"
				? raw.upstreamUrl
				: null;
	if (!upstream) return null;
	return {
		upstream_url: upstream,
		tool_prefix:
			typeof raw.tool_prefix === "string"
				? raw.tool_prefix
				: typeof raw.toolPrefix === "string"
					? raw.toolPrefix
					: "",
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function actorName(user: unknown): string | undefined {
	if (!user || typeof user !== "object") {
		return typeof user === "string" && user.trim() ? user.trim() : undefined;
	}
	const record = user as Record<string, unknown>;
	return (
		asString(record.displayName) ??
		asString(record.emailAddress) ??
		asString(record.name)
	);
}

function namedField(value: unknown): string | undefined {
	if (typeof value === "string") return asString(value);
	if (!value || typeof value !== "object") return undefined;
	return asString((value as Record<string, unknown>).name);
}

export function atlassianDocumentToText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const node = value as { type?: string; text?: string; content?: unknown[] };
	if (node.type === "hardBreak") return "\n";
	if (typeof node.text === "string") return node.text;
	if (Array.isArray(node.content)) {
		return node.content
			.map((child) => atlassianDocumentToText(child))
			.join("")
			.trim();
	}
	return "";
}

function splitTrailingOrderBy(jql: string): { body: string; orderBy: string | null } {
	let quote: '"' | "'" | null = null;
	let escaped = false;
	let depth = 0;
	for (let i = 0; i < jql.length; i += 1) {
		const char = jql[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (
			depth === 0 &&
			(i === 0 || /\s/.test(jql[i - 1])) &&
			/^order\s+by\b/i.test(jql.slice(i))
		) {
			return { body: jql.slice(0, i).trim(), orderBy: jql.slice(i).trim() };
		}
	}
	return { body: jql.trim(), orderBy: null };
}

export function buildAtlassianMcpJql(args: {
	baseQuery: string;
	window?: FeedReadWindow;
	query?: string;
	sort?: { column: string; order: "asc" | "desc" };
}): string {
	const trimmed = args.baseQuery.trim();
	const jql = trimmed.length > 0 ? trimmed : (args.window ? "" : "updated >= -90d");
	let { body, orderBy } = splitTrailingOrderBy(jql);
	if (!body && orderBy) body = args.window ? "" : "updated >= -90d";

	const callerQuery = args.query?.trim() ?? "";
	if (args.window) {
		const bounds = `updated >= ${Date.parse(args.window.start)} AND updated < ${Date.parse(args.window.end)}`;
		body = body ? `(${body}) AND (${bounds})` : bounds;
	}
	if (callerQuery) {
		const caller = splitTrailingOrderBy(callerQuery);
		if (caller.body) {
			body = body.length > 0 ? `(${body}) AND (${caller.body})` : caller.body;
		}
		if (caller.orderBy) {
			throw new Error(
				"Jira source read query cannot contain ORDER BY; use the separate sort field",
			);
		}
	}

	if (orderBy) {
		if (args.sort) {
			throw new Error(
				"Jira source read: cannot apply sort when the base JQL already contains ORDER BY",
			);
		}
		return body.length > 0 ? `${body} ${orderBy}` : orderBy;
	}

	if (args.sort) {
		const field = SORT_COLUMNS[args.sort.column];
		if (!field) {
			throw new Error(
				`Jira source read sort column '${args.sort.column}' is unsupported`,
			);
		}
		const dir = args.sort.order === "asc" ? "ASC" : "DESC";
		return body.length > 0
			? `${body} ORDER BY ${field} ${dir}`
			: `ORDER BY ${field} ${dir}`;
	}

	return body.length > 0
		? `${body} ORDER BY updated DESC`
		: "updated >= -90d ORDER BY updated DESC";
}

function issueUrl(
	issue: Record<string, unknown>,
	fields: Record<string, unknown>,
	config: Record<string, unknown>,
): string | undefined {
	const key = asString(issue.key);
	const siteUrl = asString(config.site_url);
	const cloudId = asString(config.cloud_id);
	const siteCloudId = asString(config.site_cloud_id);
	if (siteUrl && key && cloudId && siteCloudId && cloudId === siteCloudId) {
		return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
	}
	return asString(issue.self) ?? asString(fields.url) ?? asString(issue.url);
}

export function mapAtlassianIssueToRow(
	raw: unknown,
	config: Record<string, unknown> = {},
): Record<string, unknown> | null {
	if (!raw || typeof raw !== "object") return null;
	const issue = raw as Record<string, unknown>;
	const fields =
		issue.fields && typeof issue.fields === "object"
			? (issue.fields as Record<string, unknown>)
			: issue;
	const id = asString(issue.id) ?? asString(issue.key) ?? asString(fields.id);
	if (!id) return null;
	const labelsRaw = fields.labels ?? issue.labels;
	const labels = Array.isArray(labelsRaw)
		? labelsRaw.filter((label): label is string => typeof label === "string").join(", ")
		: asString(labelsRaw) ?? null;
	return {
		id,
		key: asString(issue.key) ?? asString(fields.key) ?? null,
		summary: asString(fields.summary) ?? asString(issue.summary) ?? null,
		status: namedField(fields.status) ?? namedField(issue.status) ?? null,
		assignee: actorName(fields.assignee ?? issue.assignee) ?? null,
		reporter: actorName(fields.reporter ?? issue.reporter) ?? null,
		priority: namedField(fields.priority) ?? namedField(issue.priority) ?? null,
		project_key:
			asString((fields.project as { key?: unknown } | undefined)?.key) ??
			asString(fields.projectKey) ??
			asString(issue.project_key) ??
			null,
		project_name:
			asString((fields.project as { name?: unknown } | undefined)?.name) ??
			asString(fields.projectName) ??
			null,
		labels,
		created_at: asString(fields.created) ?? asString(issue.created) ?? null,
		updated_at: asString(fields.updated) ?? asString(issue.updated) ?? null,
		description:
			atlassianDocumentToText(fields.description ?? issue.description) || null,
		url: issueUrl(issue, fields, config) ?? null,
	};
}

function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.search(/[\[{]/);
		if (start < 0) return null;
		try {
			return JSON.parse(trimmed.slice(start));
		} catch {
			return null;
		}
	}
}

function collectIssues(value: unknown, into: unknown[], requirePage = false): number {
	if (typeof value === "string") {
		return collectIssues(tryParseJson(value), into, requirePage);
	}
	if (Array.isArray(value)) {
		return value.reduce(
			(count, item) => count + collectIssues(item, into, requirePage),
			0,
		);
	}
	if (!value || typeof value !== "object") return 0;
	const record = value as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") {
		return collectIssues(tryParseJson(record.text), into, requirePage);
	}
	const issues = Array.isArray(record.issues)
		? record.issues
		: Array.isArray(record.values)
			? record.values
			: null;
	if (issues) {
		const cursor = parseAtlassianMcpNextPageToken(record);
		if (
			requirePage &&
			((record.isLast !== true && !cursor) ||
				(record.isLast === true && Boolean(cursor)))
		) {
			throw new Error("Jira MCP returned an ambiguous page cursor/exhaustion state.");
		}
		into.push(...issues);
		return 1;
	}
	if (Array.isArray(record.content)) {
		return collectIssues(record.content, into, requirePage);
	}
	if (!requirePage && (asString(record.id) || asString(record.key))) {
		into.push(record);
	}
	return 0;
}

export function parseAtlassianMcpIssues(
	payload: unknown,
	config: Record<string, unknown> = {},
	requirePage = false,
): Record<string, unknown>[] {
	const collected: unknown[] = [];
	const pages = collectIssues(payload, collected, requirePage);
	if (requirePage && pages !== 1) {
		throw new Error("Jira MCP did not return one recognizable result page.");
	}
	const rows: Record<string, unknown>[] = [];
	for (const item of collected) {
		const row = mapAtlassianIssueToRow(item, config);
		if (
			requirePage &&
			(!row || !Number.isFinite(Date.parse(String(row.updated_at ?? ""))))
		) {
			throw new Error("Jira MCP returned a malformed issue or updated timestamp.");
		}
		if (row) rows.push(row);
	}
	return rows;
}

export function parseAtlassianMcpNextPageToken(payload: unknown): string | undefined {
	if (!payload) return undefined;
	if (typeof payload === "string") {
		return parseAtlassianMcpNextPageToken(tryParseJson(payload));
	}
	if (Array.isArray(payload)) {
		for (const item of payload) {
			const token = parseAtlassianMcpNextPageToken(item);
			if (token) return token;
		}
		return undefined;
	}
	if (typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") {
		return parseAtlassianMcpNextPageToken(tryParseJson(record.text));
	}
	return (
		asString(record.nextPageToken) ??
		asString(record.next_page_token) ??
		parseAtlassianMcpNextPageToken(record.content)
	);
}

function mcpTextError(content: unknown, fallback: string): string {
	if (Array.isArray(content)) {
		const text = (content[0] as { text?: string } | undefined)?.text;
		if (typeof text === "string" && text.trim()) return text;
	}
	return fallback;
}

function collectAtlassianResources(
	value: unknown,
	into: AtlassianAccessibleResource[],
): void {
	if (!value) return;
	if (typeof value === "string") {
		collectAtlassianResources(tryParseJson(value), into);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectAtlassianResources(item, into);
		return;
	}
	if (typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") {
		collectAtlassianResources(record.text, into);
		return;
	}
	const id =
		asString(record.id) ?? asString(record.cloudId) ?? asString(record.cloud_id);
	if (id) {
		into.push({
			id,
			url: asString(record.url) ?? null,
			name: asString(record.name) ?? null,
			scopes: Array.isArray(record.scopes)
				? record.scopes.filter(
						(scope): scope is string => typeof scope === "string",
					)
				: [],
		});
		return;
	}
	for (const nested of [record.content, record.values, record.resources]) {
		collectAtlassianResources(nested, into);
	}
}

export function parseAtlassianMcpResources(
	payload: unknown,
): AtlassianAccessibleResource[] {
	const resources: AtlassianAccessibleResource[] = [];
	collectAtlassianResources(payload, resources);
	return [
		...new Map(resources.map((resource) => [resource.id, resource])).values(),
	];
}

export function parseAtlassianMcpJiraSite(
	payload: unknown,
	preferredCloudId?: string,
): JiraCloudSite | null {
	const resources = parseAtlassianMcpResources(payload);
	if (preferredCloudId) {
		const preferred = resources.find(
			(resource) => resource.id === preferredCloudId,
		);
		return preferred
			? {
					cloudId: preferred.id,
					siteUrl: preferred.url,
					siteName: preferred.name,
					resourceCount: resources.length,
				}
			: null;
	}
	return pickUniqueJiraSite(resources);
}

export async function resolveAtlassianMcpJiraSite(params: {
	organizationId: string;
	connectionId: number;
	connectorKey: string;
	mcpConfig: McpProxyConfig;
	preferredCloudId?: string;
	signal?: AbortSignal;
	deadlineAt?: number;
}): Promise<JiraCloudSite> {
	const result = await callTool(
		params.connectorKey,
		params.mcpConfig,
		params.organizationId,
		"getAccessibleAtlassianResources",
		{},
		params.connectionId,
		sourceCallOptions(params),
	);
	if (result.isError) {
		throw new Error(
			mcpTextError(
				result.content,
				"Atlassian MCP did not return an accessible Jira site",
			),
		);
	}
	const resources = parseAtlassianMcpResources(result.content);
	if (resources.length === 0) {
		throw new Error(
			"Atlassian MCP did not return an accessible Jira site for this connection",
		);
	}
	const site = parseAtlassianMcpJiraSite(
		result.content,
		params.preferredCloudId,
	);
	if (site) return site;
	if (params.preferredCloudId) {
		throw new Error(
			`Atlassian cloud_id '${params.preferredCloudId}' is not accessible to this connection`,
		);
	}
	throw new Error(
		"Atlassian MCP returned multiple accessible Jira sites; set feed config.cloud_id explicitly",
	);
}

export async function readAtlassianMcpFeed(params: {
	organizationId: string;
	connectionId: number;
	connectorKey: string;
	mcpConfig: McpProxyConfig;
	feedConfig: Record<string, unknown>;
	connectionConfig: Record<string, unknown>;
	baseQuery: string;
	query?: string;
	cursor?: string;
	window?: FeedReadWindow;
	limit?: number;
	offset?: number;
	sort?: { column: string; order: "asc" | "desc" };
	signal?: AbortSignal;
	deadlineAt?: number;
}): Promise<FeedReadResult> {
	const config = { ...params.connectionConfig, ...params.feedConfig };
	let cloudId = asString(config.cloud_id) ?? asString(config.cloudId);
	if (!cloudId) {
		cloudId = (
			await resolveAtlassianMcpJiraSite({
				organizationId: params.organizationId,
				connectionId: params.connectionId,
				connectorKey: params.connectorKey,
				mcpConfig: params.mcpConfig,
				signal: params.signal,
				deadlineAt: params.deadlineAt,
			})
		).cloudId;
	}
	if (!cloudId) {
		throw new Error(
			"Jira source read requires a cloud_id. Reconnect the Atlassian connection or set config.cloud_id.",
		);
	}

	const jql = buildAtlassianMcpJql({
		baseQuery: params.baseQuery,
		window: params.window,
		query: params.query,
		sort: params.sort,
	});
	const offset = Math.max(0, params.offset ?? 0);
	if (offset > 0) {
		throw new Error(
			"Jira source reads paginate with the returned cursor, not an offset.",
		);
	}
	const limit = Math.max(1, params.limit ?? 50);
	const configuredMax = Math.max(1, Number(config.max_results) || limit);
	const pageSize = Math.min(100, limit, configuredMax);
	const result = await callTool(
		params.connectorKey,
		params.mcpConfig,
		params.organizationId,
		"searchJiraIssuesUsingJql",
		{
			cloudId,
			jql,
			maxResults: pageSize,
			...(params.cursor ? { nextPageToken: params.cursor } : {}),
		},
		params.connectionId,
		sourceCallOptions(params),
	);
	if (result.isError) {
		throw new Error(mcpTextError(result.content, "searchJiraIssuesUsingJql failed"));
	}
	const rows = parseAtlassianMcpIssues(result.content, config, Boolean(params.window));
	const nextCursor = parseAtlassianMcpNextPageToken(result.content);

	return {
		rows,
		columns: [...ATLASSIAN_JIRA_ISSUE_COLUMNS],
		...(params.window ? { window: { ...params.window, axis: "updated_at" } } : {}),
		nextCursor,
		hasMore: Boolean(nextCursor),
	};
}
