import { getDb } from "../db/client";
import { fetchPublicUrl } from "@lobu/connector-worker/egress";
import { discoverTools } from "../mcp-proxy/client";
import type { DiscoveredTool, McpProxyConfig } from "../mcp-proxy/types";
import { errorMessage } from "../utils/errors";
import { selectedConnectorVersionArtifactSql } from "../utils/connector-execution-placement";
import {
	cancelResponseBody,
	readResponseTextWithLimit,
} from "../utils/bounded-response";
import logger from "../utils/logger";
import { filterOperationsByActionModes } from "./action-modes";
import type {
	AvailableOperation,
	OperationAnnotations,
	OperationDescriptor,
} from "./types";

type ConnectorRow = {
	key: string;
	name: string;
	actions_schema: Record<string, any> | null;
	mcp_config: Record<string, unknown> | null;
	openapi_config: Record<string, unknown> | null;
	// #2033 item 2: NULL (legacy) is treated as supported; only an explicit
	// `false` marks local_action ops unsupported.
	supports_execute?: boolean | null;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;
const OPENAPI_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENAPI_FETCH_TIMEOUT_MS = 30_000;
const MAX_OPENAPI_SPEC_BYTES = 5 * 1024 * 1024;

const openApiCache = new Map<
	string,
	{ expiresAt: number; spec: Record<string, unknown> }
>();

function normalizeMcpConfig(
	raw: Record<string, unknown> | null,
): McpProxyConfig | null {
	if (!raw) return null;
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

type OpenApiConfig = {
	specUrl: string;
	includeOperations?: string[];
	excludeOperations?: string[];
	includeTags?: string[];
	serverUrl?: string;
};

function normalizeOpenApiConfig(
	raw: Record<string, unknown> | null,
): OpenApiConfig | null {
	if (!raw) return null;
	const specUrl = typeof raw.specUrl === "string" ? raw.specUrl : null;
	if (!specUrl) return null;
	return {
		specUrl,
		includeOperations: Array.isArray(raw.includeOperations)
			? raw.includeOperations.filter((v): v is string => typeof v === "string")
			: undefined,
		excludeOperations: Array.isArray(raw.excludeOperations)
			? raw.excludeOperations.filter((v): v is string => typeof v === "string")
			: undefined,
		includeTags: Array.isArray(raw.includeTags)
			? raw.includeTags.filter((v): v is string => typeof v === "string")
			: undefined,
		serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : undefined,
	};
}

function normalizeAnnotations(raw: unknown): OperationAnnotations | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const annotations: OperationAnnotations = {};
	if (typeof obj.destructiveHint === "boolean")
		annotations.destructiveHint = obj.destructiveHint;
	if (typeof obj.openWorldHint === "boolean")
		annotations.openWorldHint = obj.openWorldHint;
	if (typeof obj.idempotentHint === "boolean")
		annotations.idempotentHint = obj.idempotentHint;
	return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function normalizeRequiredScopes(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const scopes = raw
		.filter((scope): scope is string => typeof scope === "string")
		.map((scope) => scope.trim())
		.filter(Boolean);
	return scopes.length > 0 ? scopes : undefined;
}

function operationIdFromPath(method: string, pathTemplate: string): string {
	return `${method}_${pathTemplate.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(
		/^_+|_+$/g,
		"",
	);
}

function humanizeOperationKey(key: string): string {
	return key
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function getSectionSchema(
	properties: Record<string, unknown>,
	required: string[],
): Record<string, unknown> {
	const schema: Record<string, unknown> = {
		type: "object",
		properties,
	};
	if (required.length > 0) schema.required = required;
	return schema;
}

function resolveRef(spec: Record<string, unknown>, value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const ref = (value as { $ref?: unknown }).$ref;
	if (typeof ref !== "string" || !ref.startsWith("#/")) return value;
	const parts = ref.slice(2).split("/");
	let current: unknown = spec;
	for (const part of parts) {
		if (!current || typeof current !== "object") return value;
		current = (current as Record<string, unknown>)[part];
	}
	return current ?? value;
}

function getJsonBodySchema(
	spec: Record<string, unknown>,
	requestBody: unknown,
): Record<string, unknown> | undefined {
	const resolvedBody = resolveRef(spec, requestBody) as
		| Record<string, unknown>
		| undefined;
	const content = resolvedBody?.content as Record<string, unknown> | undefined;
	if (!content) return undefined;
	const entry =
		(content["application/json"] as Record<string, unknown> | undefined) ??
		(content["application/*+json"] as Record<string, unknown> | undefined) ??
		(content["*/*"] as Record<string, unknown> | undefined);
	const schema = resolveRef(spec, entry?.schema);
	return schema && typeof schema === "object"
		? (schema as Record<string, unknown>)
		: undefined;
}

function getResponseSchema(
	spec: Record<string, unknown>,
	responses: unknown,
): Record<string, unknown> | undefined {
	const resolved = resolveRef(spec, responses) as
		| Record<string, unknown>
		| undefined;
	if (!resolved) return undefined;
	for (const code of ["200", "201", "202", "default"]) {
		const response = resolveRef(spec, resolved[code]) as
			| Record<string, unknown>
			| undefined;
		const schema = getJsonBodySchema(spec, response);
		if (schema) return schema;
	}
	return undefined;
}

function getOperationInputSchema(
	spec: Record<string, unknown>,
	pathParameters: unknown[],
	operationParameters: unknown[],
	requestBody: unknown,
): Record<string, unknown> | undefined {
	const mergedParameters = [...pathParameters, ...operationParameters]
		.map((param) => resolveRef(spec, param))
		.filter(
			(param): param is Record<string, unknown> =>
				!!param && typeof param === "object",
		);

	const pathProps: Record<string, unknown> = {};
	const pathRequired: string[] = [];
	const queryProps: Record<string, unknown> = {};
	const queryRequired: string[] = [];
	const headerProps: Record<string, unknown> = {};
	const headerRequired: string[] = [];

	for (const param of mergedParameters) {
		const name = typeof param.name === "string" ? param.name : null;
		const location = typeof param.in === "string" ? param.in : null;
		if (!name || !location) continue;
		const schema = resolveRef(spec, param.schema);
		const finalSchema =
			schema && typeof schema === "object"
				? (schema as Record<string, unknown>)
				: { type: "string" };
		const required = param.required === true;
		if (location === "path") {
			pathProps[name] = finalSchema;
			if (required) pathRequired.push(name);
		} else if (location === "query") {
			queryProps[name] = finalSchema;
			if (required) queryRequired.push(name);
		} else if (location === "header") {
			headerProps[name] = finalSchema;
			if (required) headerRequired.push(name);
		}
	}

	const properties: Record<string, unknown> = {};
	const requiredSections: string[] = [];

	if (Object.keys(pathProps).length > 0) {
		properties.path = getSectionSchema(pathProps, pathRequired);
		if (pathRequired.length > 0) requiredSections.push("path");
	}
	if (Object.keys(queryProps).length > 0) {
		properties.query = getSectionSchema(queryProps, queryRequired);
	}
	if (Object.keys(headerProps).length > 0) {
		properties.headers = getSectionSchema(headerProps, headerRequired);
	}

	const bodySchema = getJsonBodySchema(spec, requestBody);
	if (bodySchema) {
		properties.body = bodySchema;
		const resolvedRequestBody = resolveRef(spec, requestBody) as
			| Record<string, unknown>
			| undefined;
		if (resolvedRequestBody?.required === true) requiredSections.push("body");
	}

	if (Object.keys(properties).length === 0) return undefined;
	const schema: Record<string, unknown> = {
		type: "object",
		properties,
	};
	if (requiredSections.length > 0) schema.required = requiredSections;
	return schema;
}

async function fetchOpenApiSpec(
	specUrl: string,
	limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
	const cached = openApiCache.get(specUrl);
	if (cached && cached.expiresAt > Date.now()) return cached.spec;
	const timeoutMs = limits.timeoutMs ?? OPENAPI_FETCH_TIMEOUT_MS;
	const maxBytes = limits.maxBytes ?? MAX_OPENAPI_SPEC_BYTES;
	const controller = new AbortController();
	const timeout = setTimeout(
		() =>
			controller.abort(
				new Error(`OpenAPI spec fetch timed out after ${timeoutMs}ms`),
			),
		timeoutMs,
	);
	try {
		const response = await fetchPublicUrl(specUrl, {
			signal: controller.signal,
		});
		if (!response.ok) {
			await cancelResponseBody(response);
			throw new Error(
				`Failed to fetch OpenAPI spec from ${specUrl}: ${response.status}`,
			);
		}
		const text = await readResponseTextWithLimit(
			response,
			maxBytes,
			"OpenAPI spec too large",
		);
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`OpenAPI spec from ${specUrl} was not a JSON object.`);
		}
		const spec = parsed as Record<string, unknown>;
		openApiCache.set(specUrl, {
			spec,
			expiresAt: Date.now() + OPENAPI_CACHE_TTL_MS,
		});
		return spec;
	} finally {
		clearTimeout(timeout);
	}
}

export const __connectorOperationsTestOnly = {
	fetchOpenApiSpec,
	MAX_OPENAPI_SPEC_BYTES,
};

function getServerUrl(
	spec: Record<string, unknown>,
	config: OpenApiConfig,
): string | null {
	if (config.serverUrl) return config.serverUrl;
	const servers = spec.servers;
	if (!Array.isArray(servers)) return null;
	const first = servers.find(
		(entry): entry is Record<string, unknown> =>
			!!entry && typeof entry === "object" && typeof entry.url === "string",
	);
	return first?.url ? String(first.url) : null;
}

async function getOpenApiOperations(
	connectorKey: string,
	connectorName: string,
	rawConfig: Record<string, unknown> | null,
): Promise<OperationDescriptor[]> {
	const config = normalizeOpenApiConfig(rawConfig);
	if (!config) return [];
	const spec = await fetchOpenApiSpec(config.specUrl);
	const serverUrl = getServerUrl(spec, config);
	if (!serverUrl) return [];

	const paths = spec.paths as Record<string, unknown> | undefined;
	if (!paths || typeof paths !== "object") return [];

	const includeOperations = new Set(config.includeOperations ?? []);
	const excludeOperations = new Set(config.excludeOperations ?? []);
	const includeTags = new Set(config.includeTags ?? []);
	const operations: OperationDescriptor[] = [];

	for (const [pathTemplate, pathItem] of Object.entries(paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;
		const pathRecord = pathItem as Record<string, unknown>;
		const pathParameters = Array.isArray(pathRecord.parameters)
			? pathRecord.parameters
			: [];

		for (const method of HTTP_METHODS) {
			const operation = pathRecord[method];
			if (!operation || typeof operation !== "object") continue;
			const opRecord = operation as Record<string, unknown>;
			const operationKey =
				typeof opRecord.operationId === "string"
					? opRecord.operationId
					: operationIdFromPath(method, pathTemplate);
			if (includeOperations.size > 0 && !includeOperations.has(operationKey))
				continue;
			if (excludeOperations.has(operationKey)) continue;
			const tags = Array.isArray(opRecord.tags)
				? opRecord.tags.filter((tag): tag is string => typeof tag === "string")
				: [];
			if (includeTags.size > 0 && !tags.some((tag) => includeTags.has(tag)))
				continue;

			const kind = method === "get" || method === "head" ? "read" : "write";
			const requiresApproval = kind === "write";
			operations.push({
				connector_key: connectorKey,
				connector_name: connectorName,
				operation_key: operationKey,
				name:
					typeof opRecord.summary === "string" &&
					opRecord.summary.trim().length > 0
						? opRecord.summary
						: humanizeOperationKey(operationKey),
				description:
					typeof opRecord.description === "string"
						? opRecord.description
						: typeof opRecord.summary === "string"
							? opRecord.summary
							: undefined,
				kind,
				backend: "http_operation",
				requires_approval: requiresApproval,
				annotations:
					kind === "read"
						? { idempotentHint: true }
						: {
								openWorldHint: true,
								...(method === "delete" ? { destructiveHint: true } : {}),
							},
				input_schema: getOperationInputSchema(
					spec,
					pathParameters,
					Array.isArray(opRecord.parameters) ? opRecord.parameters : [],
					opRecord.requestBody,
				),
				output_schema: getResponseSchema(spec, opRecord.responses),
				backend_config: {
					backend: "http_operation",
					method: method.toUpperCase(),
					pathTemplate,
					serverUrl,
				},
			});
		}
	}

	return operations;
}

function getMcpToolKind(tool: DiscoveredTool): "read" | "write" {
	// Preserve the upstream classification for display and policy targeting.
	// Authorization does not trust it: remote reads are approval-gated below.
	return tool.annotations?.readOnlyHint ? "read" : "write";
}

async function getMcpOperations(
	connectorKey: string,
	connectorName: string,
	rawConfig: Record<string, unknown> | null,
	organizationId: string,
	connectionId?: number,
): Promise<OperationDescriptor[]> {
	const config = normalizeMcpConfig(rawConfig);
	if (!config) return [];
	const tools = await discoverTools(
		connectorKey,
		config,
		organizationId,
		connectionId,
	);
	return tools.map((tool) => ({
		connector_key: connectorKey,
		connector_name: connectorName,
		operation_key: tool.originalName,
		name: humanizeOperationKey(tool.originalName),
		description: tool.description || undefined,
		kind: getMcpToolKind(tool),
		backend: "mcp_tool",
		// Upstream annotations describe a tool but are not an authorization
		// boundary. Default every dynamically discovered operation to approval;
		// a human may explicitly configure a narrower action mode on this
		// connection.
		requires_approval: true,
		annotations:
			tool.annotations ??
			(getMcpToolKind(tool) === "read"
				? { idempotentHint: true }
				: { openWorldHint: true }),
		input_schema: tool.inputSchema,
		output_schema: undefined,
		backend_config: {
			backend: "mcp_tool",
			toolName: tool.originalName,
			upstreamUrl: tool.upstreamUrl,
		},
	}));
}

export function getLocalActionKind(def: Record<string, any>): "read" | "write" {
	return def.kind === "read" || def.annotations?.readOnlyHint === true
		? "read"
		: "write";
}

function getLocalActionOperations(
	connectorKey: string,
	connectorName: string,
	actionsSchema: Record<string, any> | null,
	supportsExecute: boolean | null | undefined,
): OperationDescriptor[] {
	if (!actionsSchema) return [];
	// NULL/undefined (legacy definition installed before the flag) is treated as
	// supported so nothing regresses; only an explicit `false` marks the op
	// unsupported (#2033 item 2).
	const executeSupported = supportsExecute !== false;
	return Object.entries(actionsSchema).map(([key, def]) => ({
		connector_key: connectorKey,
		connector_name: connectorName,
		operation_key: key,
		name: def.name ?? humanizeOperationKey(key),
		description: def.description,
		kind: getLocalActionKind(def),
		backend: "local_action",
		requires_approval: def.requiresApproval ?? false,
		required_scopes: normalizeRequiredScopes(def.requiredScopes),
		annotations: normalizeAnnotations(def.annotations),
		input_schema: def.input_schema ?? def.inputSchema,
		output_schema: def.output_schema ?? def.outputSchema,
		supports_execute: executeSupported,
		backend_config: {
			backend: "local_action",
			actionKey: key,
		},
	}));
}

function dedupeOperations(
	operations: OperationDescriptor[],
): OperationDescriptor[] {
	const priority: Record<OperationDescriptor["backend"], number> = {
		local_action: 0,
		mcp_tool: 1,
		http_operation: 2,
	};
	const byKey = new Map<string, OperationDescriptor>();
	for (const operation of operations) {
		const existing = byKey.get(operation.operation_key);
		if (!existing || priority[operation.backend] < priority[existing.backend]) {
			byKey.set(operation.operation_key, operation);
		}
	}
	return [...byKey.values()];
}

async function buildConnectorOperations(
	connector: ConnectorRow,
	organizationId: string,
	options: { connectionId?: number; tolerateMcpFailure?: boolean } = {},
): Promise<OperationDescriptor[]> {
	const mcpOperations = getMcpOperations(
		connector.key,
		connector.name,
		connector.mcp_config,
		organizationId,
		options.connectionId,
	);
	const [localActions, mcpTools, openApiOps] = await Promise.all([
		Promise.resolve(
			getLocalActionOperations(
				connector.key,
				connector.name,
				connector.actions_schema,
				connector.supports_execute,
			),
		),
		options.tolerateMcpFailure
			? mcpOperations.catch((error) => {
					logger.warn(
						{
							connectorKey: connector.key,
							error: errorMessage(error),
						},
						"Skipping unavailable MCP operations in broad connector catalog",
					);
					return [];
				})
			: mcpOperations,
		getOpenApiOperations(
			connector.key,
			connector.name,
			connector.openapi_config,
		).catch(() => []),
	]);
	return dedupeOperations([...localActions, ...mcpTools, ...openApiOps]);
}

async function getConnectorsForListing(params: {
	organizationId: string;
	connectorKey?: string;
	connectionId?: number;
	entityId?: number;
}): Promise<ConnectorRow[]> {
	const sql = getDb();

	if (params.connectionId) {
		const rows = await sql`
      SELECT cd.key, cd.name, cd.actions_schema, cd.mcp_config, cd.openapi_config, cd.supports_execute
      FROM connections c
      JOIN connector_definitions cd
        ON cd.key = c.connector_key
       AND cd.status = 'active'
       AND cd.organization_id = ${params.organizationId}
      WHERE c.id = ${params.connectionId}
        AND c.organization_id = ${params.organizationId}
        AND c.deleted_at IS NULL
      ORDER BY cd.updated_at DESC
      LIMIT 1
    `;
		return rows as unknown as ConnectorRow[];
	}

	if (params.entityId) {
		const rows = await sql`
      SELECT DISTINCT ON (cd.key)
        cd.key, cd.name, cd.actions_schema, cd.mcp_config, cd.openapi_config, cd.supports_execute
      FROM connections c
      JOIN feeds f ON f.connection_id = c.id
      JOIN connector_definitions cd
        ON cd.key = c.connector_key
       AND cd.status = 'active'
       AND cd.organization_id = ${params.organizationId}
      WHERE c.organization_id = ${params.organizationId}
        AND c.deleted_at IS NULL
        AND c.status = 'active'
        AND f.deleted_at IS NULL
        AND ${params.entityId} = ANY(f.entity_ids)
      ORDER BY cd.key, cd.updated_at DESC
    `;
		return rows as unknown as ConnectorRow[];
	}

	let query = sql`
    SELECT DISTINCT ON (cd.key)
      cd.key, cd.name, cd.actions_schema, cd.mcp_config, cd.openapi_config, cd.supports_execute
    FROM connector_definitions cd
    WHERE cd.status = 'active'
      AND cd.organization_id = ${params.organizationId}
  `;

	if (params.connectorKey) {
		query = sql`${query} AND cd.key = ${params.connectorKey}`;
	}

	query = sql`${query} ORDER BY cd.key, cd.updated_at DESC`;
	const rows = await query;
	return rows as unknown as ConnectorRow[];
}

export async function listOperations(params: {
	organizationId: string;
	connectorKey?: string;
	connectionId?: number;
	entityId?: number;
	kind?: "read" | "write";
	backend?: "local_action" | "mcp_tool" | "http_operation";
	includeInputSchema?: boolean;
	includeOutputSchema?: boolean;
	/** Keep disabled operations visible so callers can render enablement help. */
	includeDisabled?: boolean;
	limit?: number;
	offset?: number;
}): Promise<{
	operations: OperationDescriptor[];
	total: number;
	limit: number;
	offset: number;
}> {
	const connectors = await getConnectorsForListing(params);
	let operations = (
		await Promise.all(
			connectors.map((connector) =>
				buildConnectorOperations(connector, params.organizationId, {
					connectionId: params.connectionId,
					tolerateMcpFailure: params.connectionId === undefined,
				}),
			),
		)
	).flat();

	// When listing for a specific connection, hide ops the user has marked
	// 'disabled' in connection.config.action_modes so they never reach the
	// agent (e.g. Automation reaction context). manage_operations.list_available
	// opts out via includeDisabled to surface them with readiness 'disabled'
	// and enablement help instead; execution still refuses disabled ops.
	if (params.connectionId && !params.includeDisabled) {
		const sql = getDb();
		const configRows = await sql`
      SELECT config FROM connections
      WHERE id = ${params.connectionId}
        AND organization_id = ${params.organizationId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
		const config =
			(configRows[0] as { config: Record<string, unknown> | null } | undefined)
				?.config ?? null;
		operations = filterOperationsByActionModes(operations, config);
	}

	const filtered = operations.filter((operation) => {
		if (params.kind && operation.kind !== params.kind) return false;
		if (params.backend && operation.backend !== params.backend) return false;
		return true;
	});

	const total = filtered.length;
	const limit = params.limit ?? 100;
	const offset = params.offset ?? 0;

	return {
		operations: filtered.slice(offset, offset + limit).map((operation) => ({
			...operation,
			...(params.includeInputSchema === false
				? { input_schema: undefined }
				: {}),
			...(params.includeOutputSchema === true
				? {}
				: { output_schema: undefined }),
		})),
		total,
		limit,
		offset,
	};
}

export async function getOperationForConnection(
	organizationId: string,
	connectionId: number,
	operationKey: string,
): Promise<{
	connection: {
		id: number;
		connector_key: string;
		connector_version: string;
		status: string;
		auth_profile_id: number | null;
		app_auth_profile_id: number | null;
		display_name: string | null;
		config: Record<string, unknown> | null;
		device_worker_id: string | null;
		device_platform: string | null;
		connector_runtime: Record<string, unknown> | null;
		connector_manifest_backed: boolean;
		connector_artifact_source_path: string | null;
		name: string;
	};
	operation: OperationDescriptor;
} | null> {
	const sql = getDb();
	const rows = await sql`
    SELECT
      c.id,
      c.connector_key,
      cd.version AS connector_version,
      c.status,
      c.auth_profile_id,
      c.app_auth_profile_id,
      c.display_name,
      c.config,
      c.device_worker_id,
      dw.platform AS device_platform,
      cd.name,
      cd.actions_schema,
      cd.mcp_config,
      cd.openapi_config,
      cd.runtime AS connector_runtime,
      COALESCE(cv.manifest_backed, false) AS connector_manifest_backed,
      cv.artifact_source_path AS connector_artifact_source_path
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.status = 'active'
     AND cd.organization_id = ${organizationId}
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    LEFT JOIN LATERAL (
      ${selectedConnectorVersionArtifactSql(sql, {
        connectorKey: sql`cd.key`,
        version: sql`cd.version`,
        organizationId: sql`cd.organization_id`,
      })}
    ) cv ON true
    WHERE c.id = ${connectionId}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
    ORDER BY cd.updated_at DESC
    LIMIT 1
  `;

	if (rows.length === 0) return null;
	const row = rows[0] as unknown as ConnectorRow & {
		id: number;
		connector_key: string;
		connector_version: string;
		status: string;
		auth_profile_id: number | null;
		app_auth_profile_id: number | null;
		display_name: string | null;
		config: Record<string, unknown> | null;
		device_worker_id: string | null;
		device_platform: string | null;
		connector_runtime: Record<string, unknown> | null;
		connector_manifest_backed: boolean;
		connector_artifact_source_path: string | null;
	};
	const operations = await buildConnectorOperations(
		{
			key: row.connector_key,
			name: row.name,
			actions_schema: row.actions_schema,
			mcp_config: row.mcp_config,
			openapi_config: row.openapi_config,
		},
		organizationId,
		{ connectionId },
	);
	const operation = operations.find(
		(entry) => entry.operation_key === operationKey,
	);
	if (!operation) return null;
	return {
		connection: {
			id: row.id,
			connector_key: row.connector_key,
			connector_version: row.connector_version,
			status: row.status,
			auth_profile_id: row.auth_profile_id,
			app_auth_profile_id: row.app_auth_profile_id,
			display_name: row.display_name,
			config: row.config,
			device_worker_id: row.device_worker_id,
			device_platform: row.device_platform,
			connector_runtime: row.connector_runtime,
			connector_manifest_backed: row.connector_manifest_backed,
			connector_artifact_source_path: row.connector_artifact_source_path,
			name: row.name,
		},
		operation,
	};
}

type OperationsSummary = {
	total: number;
	reads: number;
	writes: number;
	local_action: number;
	mcp_tool: number;
	http_operation: number;
};

export const EMPTY_SUMMARY: OperationsSummary = {
	total: 0,
	reads: 0,
	writes: 0,
	local_action: 0,
	mcp_tool: 0,
	http_operation: 0,
};

function summarizeOperations(
	operations: AvailableOperation[],
): OperationsSummary {
	return operations.reduce(
		(summary, operation) => {
			summary.total += 1;
			if (operation.kind === "read") summary.reads += 1;
			else summary.writes += 1;
			summary[operation.backend] += 1;
			return summary;
		},
		{ ...EMPTY_SUMMARY },
	);
}

export async function getOperationsSummary(
	organizationId: string,
	connectorKey: string,
	connectionId?: number,
): Promise<OperationsSummary> {
	const connectors = await getConnectorsForListing({
		organizationId,
		connectorKey,
		connectionId,
	});
	if (connectors.length === 0) return { ...EMPTY_SUMMARY };
	const operations = await buildConnectorOperations(
		connectors[0],
		organizationId,
		{ connectionId, tolerateMcpFailure: true },
	);
	return summarizeOperations(operations);
}

/**
 * Connector-keyed summaries for catalog/group views. Fetches the org's
 * definitions once, then builds summaries in parallel.
 *
 * OAuth-protected MCP tools are connection-scoped. Pass `connectionIdByKey`
 * whenever the caller already has a connection so discovery uses that
 * account's credentials instead of an unauthenticated probe. Per-row
 * connection lists should use `getOperationsSummariesByConnection`.
 */
export async function getOperationsSummaryBatch(
	organizationId: string,
	connectorKeys: string[],
	connectionIdByKey?: ReadonlyMap<string, number>,
): Promise<Map<string, OperationsSummary>> {
	if (connectorKeys.length === 0) return new Map();

	const connectors = await getConnectorsForListing({ organizationId });
	const relevant = connectors.filter((c) => connectorKeys.includes(c.key));

	const entries = await Promise.all(
		relevant.map(async (connector) => {
			const operations = await buildConnectorOperations(
				connector,
				organizationId,
				{
					connectionId: connectionIdByKey?.get(connector.key),
					tolerateMcpFailure: true,
				},
			);
			return [connector.key, summarizeOperations(operations)] as const;
		}),
	);

	const result = new Map<string, OperationsSummary>(entries);
	// Fill in missing keys with empty summaries
	for (const key of connectorKeys) {
		if (!result.has(key)) result.set(key, { ...EMPTY_SUMMARY });
	}
	return result;
}

/**
 * Per-connection summaries. Remote MCP catalogs can differ by account, so
 * list/get must not collapse two connections of the same connector key.
 */
export async function getOperationsSummariesByConnection(
	organizationId: string,
	connections: Array<{ id: number; connectorKey: string }>,
): Promise<Map<number, OperationsSummary>> {
	if (connections.length === 0) return new Map();

	const connectors = await getConnectorsForListing({ organizationId });
	const byKey = new Map(connectors.map((connector) => [connector.key, connector]));

	const entries = await Promise.all(
		connections.map(async (connection) => {
			const connector = byKey.get(connection.connectorKey);
			if (!connector) return [connection.id, { ...EMPTY_SUMMARY }] as const;
			const operations = await buildConnectorOperations(
				connector,
				organizationId,
				{
					connectionId: connection.id,
					tolerateMcpFailure: true,
				},
			);
			return [connection.id, summarizeOperations(operations)] as const;
		}),
	);

	return new Map(entries);
}
