import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getErrorMessage } from "@lobu/core";
import { getLoginProviderScopes } from "../auth/config";
import { getDb } from "../db/client";
import { getLocalActionKind } from "../operations/connector-operations";
import {
	getMcpOAuthRequestedScopes,
	probeMcpServer,
	selectMcpOAuthClientAuthMethod,
} from "../mcp-proxy/client";
import { computeCodeHash } from "../utils/compiler-core";
import {
	connectorSourcePathToUri,
	getCatalogConnectorInstallability,
	resolveFileSourcePath,
} from "../utils/connector-catalog";
import {
	extractConnectorMetadata,
	validateConnectorMetadata,
} from "../utils/connector-compiler";
import {
	type ConnectorInstallResult,
	resolveConnectorInstallSource,
	upsertConnectorDefinitionRecords,
} from "../utils/connector-definition-install";
import {
	resolveConnectorCode,
	upsertBundledConnectorForOrg,
} from "../utils/ensure-connector-installed";
import logger from "../utils/logger";
import { listCatalogEntries } from "./load";
import {
	ATLASSIAN_MCP_FEEDS,
	isAtlassianMcpUrl,
} from "../operations/atlassian-mcp-feed";

type AuthSchema =
	| { methods?: Array<Record<string, unknown>> }
	| Record<string, unknown>
	| null
	| undefined;

type OAuthAuthMethod = {
	type: "oauth";
	provider: string;
	loginScopes?: string[];
};

export type ScopedConnectorDefinitionRow = {
	id?: number;
	key: string;
	name: string;
	description: string | null;
	version: string;
	auth_schema: AuthSchema;
	feeds_schema: Record<string, unknown> | null;
	actions_schema: Record<string, unknown> | null;
	automation_events: Array<Record<string, unknown>> | null;
	options_schema: Record<string, unknown> | null;
	mcp_config?: Record<string, unknown> | null;
	openapi_config?: Record<string, unknown> | null;
	favicon_domain?: string | null;
	source_path?: string | null;
	/**
	 * The active version's connector_versions.organization_id. NULL means the
	 * version resolved to the SHARED row (a bundled install) or none exists;
	 * non-null means an org-scoped override is active.
	 */
	source_org_id?: string | null;
	default_connection_config?: Record<string, unknown> | null;
	status: string;
	login_enabled?: boolean | null;
	required_capability?: string | null;
	/**
	 * `runtime` is stored as raw jsonb (the catalog extractor doesn't narrow it),
	 * so the row type stays untyped here. Consumers narrow at the use site.
	 */
	runtime?: Record<string, unknown> | null;
	created_at?: string;
	updated_at?: string;
};

function getOAuthMethods(authSchema: AuthSchema | string): OAuthAuthMethod[] {
	const parsedAuthSchema =
		typeof authSchema === "string"
			? (() => {
					try {
						return JSON.parse(authSchema) as { methods?: unknown };
					} catch {
						return null;
					}
				})()
			: authSchema;

	const methods = (parsedAuthSchema as { methods?: unknown } | null)?.methods;
	if (!Array.isArray(methods)) return [];

	return methods.filter(
		(method): method is OAuthAuthMethod =>
			typeof method === "object" &&
			method !== null &&
			(method as { type?: unknown }).type === "oauth" &&
			typeof (method as { provider?: unknown }).provider === "string",
	);
}

export async function listScopedConnectorDefinitions(params: {
	organizationId: string;
}): Promise<ScopedConnectorDefinitionRow[]> {
	const sql = getDb();

	const rows = await sql`
    SELECT
      d.id,
      d.key,
      d.name,
      d.description,
      d.version,
      d.auth_schema,
      d.feeds_schema,
      d.actions_schema,
      d.automation_events,
      d.options_schema,
      d.mcp_config,
      d.openapi_config,
      d.favicon_domain,
      d.default_connection_config,
      d.status,
      d.login_enabled,
      d.required_capability,
      d.runtime,
      d.created_at,
      d.updated_at,
      cv.source_path,
      cv.organization_id AS source_org_id
    FROM connector_definitions d
    LEFT JOIN LATERAL (
      SELECT source_path, organization_id
      FROM connector_versions
      WHERE connector_key = d.key AND version = d.version
        AND (organization_id = d.organization_id OR organization_id IS NULL)
      ORDER BY organization_id NULLS LAST
      LIMIT 1
    ) cv ON TRUE
    WHERE d.status = 'active'
      AND d.organization_id = ${params.organizationId}
    ORDER BY d.name ASC
  `;

	return rows as unknown as ScopedConnectorDefinitionRow[];
}

export async function getScopedConnectorDefinition(params: {
	organizationId: string;
	connectorKey: string;
}): Promise<ScopedConnectorDefinitionRow | null> {
	const sql = getDb();

	const rows = await sql`
    SELECT *
    FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `;

	return (rows[0] as ScopedConnectorDefinitionRow | undefined) ?? null;
}

export async function installConnectorDefinitionFromSource(params: {
	organizationId: string;
	sourceUrl?: string;
	sourceUri?: string;
	sourceCode?: string;
	compiled?: boolean;
}): Promise<ConnectorInstallResult> {
	const sql = getDb();
	const resolved = await resolveConnectorInstallSource({
		sourceUrl: params.sourceUrl,
		sourceUri: params.sourceUri,
		sourceCode: params.sourceCode,
		compiled: params.compiled,
	});
	const { updated } = await upsertConnectorDefinitionRecords({
		sql,
		organizationId: params.organizationId,
		metadata: resolved.metadata,
		versionRecord: {
			compiledCode: resolved.compiledCode,
			compiledCodeHash: resolved.compiledCodeHash,
			compileConfigHash: resolved.compileConfigHash,
			sourceCode: resolved.sourceCode,
			sourcePath: resolved.sourcePath,
		},
		versionScope: "organization",
	});

	logger.info(
		{
			connector_key: resolved.metadata.key,
			version: resolved.metadata.version,
		},
		"Connector installed from source",
	);

	return {
		connectorKey: resolved.metadata.key,
		name: resolved.metadata.name,
		version: resolved.metadata.version,
		codeHash: resolved.compiledCodeHash,
		updated,
		authSchema: resolved.metadata.authSchema ?? null,
		mcpConfig: resolved.metadata.mcpConfig ?? null,
		openapiConfig: resolved.metadata.openapiConfig ?? null,
	};
}

export async function installCatalogConnectorDefinition(params: {
	organizationId: string;
	connectorId: string;
}): Promise<ConnectorInstallResult> {
	const catalog = (await listCatalogEntries(["connectors"])).connectors;
	const entry = catalog.find((item) => item.id === params.connectorId);
	if (!entry) {
		throw new Error(
			`Catalog connector '${params.connectorId}' was not found.`,
		);
	}
	const availability = getCatalogConnectorInstallability(entry.id);
	if (!availability.installable) throw new Error(availability.message);
	const installed = await upsertBundledConnectorForOrg({
		organizationId: params.organizationId,
		connectorKey: entry.id,
	});
	if (!installed) {
		throw new Error(
			`Catalog connector '${params.connectorId}' does not resolve to a bundled connector source.`,
		);
	}
	return installed;
}

export async function installConnectorFromMcpUrl(params: {
	organizationId: string;
	mcpUrl: string;
}): Promise<ConnectorInstallResult> {
	const sql = getDb();
	const probed = await probeMcpServer(params.mcpUrl);

	const serverName = probed.serverInfo.name || new URL(params.mcpUrl).hostname;
	const connectorKey = `mcp.${serverName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")}`;
	const toolPrefix = serverName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	const authSchema = probed.oauth
		? {
				methods: [
					{
						type: "oauth",
						provider: connectorKey,
						required: true,
						requiredScopes: getMcpOAuthRequestedScopes(probed.oauth),
						authorizationUrl: probed.oauth.authorizationUrl,
						tokenUrl: probed.oauth.tokenUrl,
						tokenEndpointAuthMethod:
							selectMcpOAuthClientAuthMethod(probed.oauth),
						usePkce:
							probed.oauth.codeChallengeMethodsSupported.includes("S256"),
						clientIdKey: "MCP_CLIENT_ID",
						clientSecretKey: "MCP_CLIENT_SECRET",
						resource: probed.oauth.resource,
						description:
							"Authorize Lobu to use this remote MCP server on your behalf.",
						setupInstructions: probed.oauth.registrationUrl
							? "Lobu registers the OAuth client automatically; connect an account to continue."
							: "Configure an OAuth client for this MCP server, then connect an account.",
					},
				],
			}
		: null;

	const metadata = {
		key: connectorKey,
		name: serverName,
		description: probed.instructions,
		version: probed.serverInfo.version || "0.0.0",
		authSchema,
		webhook: null,
		feeds: isAtlassianMcpUrl(params.mcpUrl) ? ATLASSIAN_MCP_FEEDS : null,
		actions: null,
		automationEvents: null,
		optionsSchema: null,
		faviconDomain: (() => {
			try {
				return new URL(params.mcpUrl).hostname;
			} catch {
				return null;
			}
		})(),
		mcpConfig: { upstream_url: params.mcpUrl, tool_prefix: toolPrefix },
	};

	const { updated } = await upsertConnectorDefinitionRecords({
		sql,
		organizationId: params.organizationId,
		metadata,
		versionRecord: {
			compiledCode: null,
			compiledCodeHash: null,
			compileConfigHash: null,
			sourceCode: null,
			sourcePath: null,
		},
		versionScope: "organization",
		replaceVersionArtifact: true,
	});

	logger.info(
		{
			connector_key: connectorKey,
			version: metadata.version,
			tool_count: probed.tools.length,
		},
		"Connector installed from MCP URL",
	);

	return {
		connectorKey,
		name: metadata.name,
		version: metadata.version,
		codeHash: createHash("sha256")
			.update(params.mcpUrl)
			.digest("hex")
			.slice(0, 16),
		updated,
		authSchema,
		mcpConfig: metadata.mcpConfig,
		...(probed.oauth ? { mcpOAuth: probed.oauth } : {}),
	};
}

// ============================================
// Connector source lifecycle (#2045)
// ============================================
//
// Organization-local operations over an installed connector's source. All of
// them key off the org's active `connector_definitions` row; the retained
// `connector_versions` rows (one per key+version, kept forever by the install
// upsert) are what make rollback a one-operation revert.

export type ConnectorVersionSummary = {
	version: string;
	created_at: string;
	has_source: boolean;
	has_compiled: boolean;
	active: boolean;
};

export type InstalledConnectorSource = {
	connectorKey: string;
	activeVersion: string;
	version: string;
	sourceCode: string | null;
	sourcePath: string | null;
	codeHash: string | null;
	versions: ConnectorVersionSummary[];
};

function assertInstalled(
	def: ScopedConnectorDefinitionRow | null,
	connectorKey: string,
): asserts def is ScopedConnectorDefinitionRow {
	if (!def) {
		throw new Error(
			`Connector '${connectorKey}' is not installed in this organization. Use install_connector to install it first.`,
		);
	}
}

/**
 * Read the installed source for a connector (org-local). Bundled connectors
 * store only a `source_path` on their version row; for those the on-disk
 * bundled source is read so the caller still sees the active code.
 */
export async function getInstalledConnectorSource(params: {
	organizationId: string;
	connectorKey: string;
	version?: string;
}): Promise<InstalledConnectorSource> {
	const sql = getDb();
	const def = await getScopedConnectorDefinition(params);
	assertInstalled(def, params.connectorKey);

	// Org fence (#2045): only this org's own rows and the shared rows are
	// visible — never another org's private artifact. When a version exists as
	// both (post-dual-write), the org's own row wins.
	const rows = (await sql`
    SELECT version, created_at, source_code, source_path, compiled_code_hash, has_compiled
    FROM (
      SELECT DISTINCT ON (version)
             version, created_at, id, source_code, source_path, compiled_code_hash,
             (compiled_code IS NOT NULL) AS has_compiled
      FROM connector_versions
      WHERE connector_key = ${params.connectorKey}
        AND (organization_id = ${params.organizationId} OR organization_id IS NULL)
      ORDER BY version, organization_id NULLS LAST
    ) v
    ORDER BY created_at DESC, id DESC
  `) as unknown as Array<{
		version: string;
		created_at: string;
		source_code: string | null;
		source_path: string | null;
		compiled_code_hash: string | null;
		has_compiled: boolean;
	}>;

	const targetVersion = params.version ?? def.version;
	const target = rows.find((row) => row.version === targetVersion);
	if (!target) {
		throw new Error(
			`No retained version '${targetVersion}' for connector '${params.connectorKey}'. ` +
				`Retained versions: ${rows.map((row) => row.version).join(", ") || "(none)"}.`,
		);
	}

	let sourceCode = target.source_code;
	if (sourceCode === null && target.source_path) {
		// Bundled install: the version row points at on-disk source instead of
		// carrying a copy. Best-effort read; a missing file just yields null.
		const uri = connectorSourcePathToUri(target.source_path);
		const filePath = uri ? resolveFileSourcePath(uri) : null;
		if (filePath) {
			sourceCode = await readFile(filePath, "utf-8").catch(() => null);
		}
	}

	return {
		connectorKey: params.connectorKey,
		activeVersion: def.version,
		version: target.version,
		sourceCode,
		sourcePath: target.source_path,
		codeHash: target.compiled_code_hash,
		versions: rows.map((row) => ({
			version: row.version,
			created_at: new Date(row.created_at).toISOString(),
			has_source: row.source_code !== null || row.source_path !== null,
			has_compiled: row.has_compiled,
			active: row.version === def.version,
		})),
	};
}

/**
 * Compact per-action semantic-policy summary surfaced by the preflight so an
 * author can confirm `kind` and `requiredScopes` survived extraction BEFORE
 * persisting — the whole point of a validate-without-install step. Keyed by
 * action key. Omits the (large) input/output schemas; those live in the
 * installed definition's actions_schema.
 */
export type ValidatedActionSummary = {
	kind: "read" | "write";
	requires_approval: boolean;
	required_scopes: string[];
};

export type ConnectorSourceValidation =
	| {
			valid: true;
			connectorKey: string;
			name: string;
			version: string;
			codeHash: string;
			installed: boolean;
			activeVersion: string | null;
			versionExists: boolean;
			actions: Record<string, ValidatedActionSummary>;
			feedKeys: string[];
	  }
	| { valid: false; diagnostics: string };

/**
 * Reduce the extracted `actions` blob to the semantic-policy fields authors
 * need to verify: kind (defaults to write, matching the runtime), whether it
 * requires approval, and requiredScopes. Tolerant of missing/legacy shapes.
 */
function summarizeValidatedActions(
	actions: Record<string, unknown> | null,
): Record<string, ValidatedActionSummary> {
	const out: Record<string, ValidatedActionSummary> = {};
	for (const [key, raw] of Object.entries(actions ?? {})) {
		const a = (raw ?? {}) as Record<string, unknown>;
		const scopes = Array.isArray(a.requiredScopes)
			? (a.requiredScopes.filter((s) => typeof s === "string") as string[])
			: [];
		out[key] = {
			// Reuse the exact runtime classifier so the preflight can't disagree
			// with how the action is actually treated (kind:'read' OR
			// annotations.readOnlyHint:true → read; else write).
			kind: getLocalActionKind(a),
			requires_approval: a.requiresApproval === true,
			required_scopes: scopes,
		};
	}
	return out;
}

/**
 * Compile + extract + validate connector source WITHOUT persisting anything —
 * the true preflight `install_connector`'s dry-run never was. Reuses the exact
 * install pipeline (`resolveConnectorInstallSource`), so a `valid: true` here
 * means `update_connector_source` with the same payload will compile.
 */
export async function validateConnectorSource(params: {
	organizationId: string;
	sourceCode: string;
	compiled?: boolean;
}): Promise<ConnectorSourceValidation> {
	let resolved: Awaited<ReturnType<typeof resolveConnectorInstallSource>>;
	try {
		resolved = await resolveConnectorInstallSource({
			sourceCode: params.sourceCode,
			compiled: params.compiled,
		});
	} catch (error) {
		return { valid: false, diagnostics: getErrorMessage(error) };
	}

	const sql = getDb();
	const def = await getScopedConnectorDefinition({
		organizationId: params.organizationId,
		connectorKey: resolved.metadata.key,
	});
	const versionRows = await sql`
    SELECT 1 FROM connector_versions
    WHERE connector_key = ${resolved.metadata.key}
      AND version = ${resolved.metadata.version}
      AND (organization_id = ${params.organizationId} OR organization_id IS NULL)
    LIMIT 1
  `;

	return {
		valid: true,
		connectorKey: resolved.metadata.key,
		name: resolved.metadata.name,
		version: resolved.metadata.version,
		codeHash: resolved.compiledCodeHash,
		installed: def !== null,
		activeVersion: def?.version ?? null,
		versionExists: versionRows.length > 0,
		actions: summarizeValidatedActions(resolved.metadata.actions),
		feedKeys: Object.keys(resolved.metadata.feeds ?? {}),
	};
}

export type ConnectorVersionChange = {
	connectorKey: string;
	name: string;
	previousVersion: string;
	version: string;
	codeHash: string;
};

/**
 * Replace an installed connector's source (org-local), reusing the install
 * persist path. Guards that make it safe where `install_connector` is not:
 * the connector must already be installed, the source's key must match, an
 * optional `expectedVersion` gives optimistic concurrency, and overwriting ANY
 * retained version's row with different code is rejected (a changed source must
 * bump `definition.version` so the prior code stays retained for rollback).
 */
export async function updateInstalledConnectorSource(params: {
	organizationId: string;
	connectorKey: string;
	sourceCode: string;
	compiled?: boolean;
	expectedVersion?: string;
}): Promise<ConnectorVersionChange> {
	const sql = getDb();
	const def = await getScopedConnectorDefinition(params);
	assertInstalled(def, params.connectorKey);

	if (params.expectedVersion && params.expectedVersion !== def.version) {
		throw new Error(
			`Version conflict: expected active version '${params.expectedVersion}' but '${def.version}' is active. ` +
				`Re-read with get_connector_source and retry.`,
		);
	}

	const resolved = await resolveConnectorInstallSource({
		sourceCode: params.sourceCode,
		compiled: params.compiled,
	});
	if (resolved.metadata.key !== params.connectorKey) {
		throw new Error(
			`source_code defines connector '${resolved.metadata.key}', not '${params.connectorKey}'. ` +
				`Refusing to update (use install_connector to install a new connector).`,
		);
	}

	// A retained version's stored code is immutable: overwriting ANY existing
	// (key, version) row with different code destroys a rollback target. The
	// guard must key on the version being WRITTEN (resolved.metadata.version) —
	// not the active version — because updating to a retained *non-active*
	// version silently clobbered its code otherwise (#2045 review finding).
	const targetVersion = resolved.metadata.version;
	const existing = (await sql`
      SELECT compiled_code_hash, source_code FROM connector_versions
      WHERE connector_key = ${params.connectorKey} AND version = ${targetVersion}
        AND (organization_id = ${params.organizationId} OR organization_id IS NULL)
      ORDER BY organization_id NULLS LAST
      LIMIT 1
    `) as unknown as Array<{
		compiled_code_hash: string | null;
		source_code: string | null;
	}>;
	const row = existing[0];
	const sameCode =
		!row ||
		row.source_code === resolved.sourceCode ||
		row.compiled_code_hash === resolved.compiledCodeHash;
	if (!sameCode) {
		throw new Error(
			`Version '${targetVersion}' of '${params.connectorKey}' is already retained with different code. ` +
				`Bump the version in the connector definition so the existing code stays retained for rollback_connector_version.`,
		);
	}

	await upsertConnectorDefinitionRecords({
		sql,
		organizationId: params.organizationId,
		metadata: resolved.metadata,
		versionRecord: {
			compiledCode: resolved.compiledCode,
			compiledCodeHash: resolved.compiledCodeHash,
			compileConfigHash: resolved.compileConfigHash,
			sourceCode: resolved.sourceCode,
			sourcePath: resolved.sourcePath,
		},
		versionScope: "organization",
	});

	logger.info(
		{
			connector_key: params.connectorKey,
			previous_version: def.version,
			version: resolved.metadata.version,
		},
		"Connector source updated",
	);

	return {
		connectorKey: params.connectorKey,
		name: resolved.metadata.name,
		previousVersion: def.version,
		version: resolved.metadata.version,
		codeHash: resolved.compiledCodeHash,
	};
}

/**
 * Re-activate a retained prior version (org-local, one operation). The stored
 * code is resolved through `resolveConnectorCode` (recompiles from retained
 * source when the compile config drifted) and re-validated BEFORE the
 * definition flips — a version whose code can no longer be resolved never
 * becomes active. The retained version row itself is untouched (the persist
 * upsert COALESCEs null fields).
 */
export async function rollbackConnectorVersion(params: {
	organizationId: string;
	connectorKey: string;
	version: string;
}): Promise<ConnectorVersionChange> {
	const sql = getDb();
	const def = await getScopedConnectorDefinition(params);
	assertInstalled(def, params.connectorKey);

	if (def.version === params.version) {
		throw new Error(
			`Version '${params.version}' is already the active version of '${params.connectorKey}'.`,
		);
	}

	// Org fence (#2045): a rollback target must be this org's own retained row
	// or a shared row — another org's private artifact is never activatable.
	const rows = (await sql`
    SELECT id, organization_id, version, compiled_code, compile_config_hash
    FROM connector_versions
    WHERE connector_key = ${params.connectorKey} AND version = ${params.version}
      AND (organization_id = ${params.organizationId} OR organization_id IS NULL)
    ORDER BY organization_id NULLS LAST
    LIMIT 1
  `) as unknown as Array<{
		id: number;
		organization_id: string | null;
		version: string;
		compiled_code: string | null;
		compile_config_hash: string | null;
	}>;
	if (rows.length === 0) {
		const retained = (await sql`
      SELECT DISTINCT ON (version) version, created_at, id
      FROM connector_versions
      WHERE connector_key = ${params.connectorKey}
        AND (organization_id = ${params.organizationId} OR organization_id IS NULL)
      ORDER BY version, organization_id NULLS LAST
    `) as unknown as Array<{ version: string }>;
		throw new Error(
			`No retained version '${params.version}' for connector '${params.connectorKey}'. ` +
				`Retained versions: ${retained.map((row) => row.version).join(", ") || "(none)"}.`,
		);
	}

	const code = await resolveConnectorCode(params.connectorKey, rows[0]);
	const metadata = await extractConnectorMetadata(code);
	validateConnectorMetadata(metadata);
	if (metadata.key !== params.connectorKey || metadata.version !== params.version) {
		throw new Error(
			`Retained code for '${params.connectorKey}@${params.version}' resolved to ` +
				`'${metadata.key}@${metadata.version}' — cannot roll back safely.`,
		);
	}

	// All-null versionRecord: the ON CONFLICT upsert COALESCEs, so the retained
	// row keeps its stored code — only the definition metadata flips. (And the
	// all-null record means no org row is created for it — see versionScope.)
	await upsertConnectorDefinitionRecords({
		sql,
		organizationId: params.organizationId,
		metadata,
		versionRecord: {
			compiledCode: null,
			compiledCodeHash: null,
			compileConfigHash: null,
			sourceCode: null,
			sourcePath: null,
		},
		versionScope: "organization",
	});

	logger.info(
		{
			connector_key: params.connectorKey,
			previous_version: def.version,
			version: params.version,
		},
		"Connector rolled back to retained version",
	);

	return {
		connectorKey: params.connectorKey,
		name: metadata.name,
		previousVersion: def.version,
		version: params.version,
		codeHash: computeCodeHash(code),
	};
}

export async function uninstallConnectorDefinition(params: {
	organizationId: string;
	connectorKey: string;
}): Promise<boolean> {
	const sql = getDb();

	// Block uninstall while ANY non-deleted connection references the connector.
	// Filtering on `status = 'active'` alone let pending_auth connections slip
	// through during an in-flight OAuth flow: uninstall would succeed mid-flow
	// and the callback would later activate the connection, leaving an active
	// connection with no matching connector_definitions row.
	const blockingConns = await sql`
    SELECT COUNT(*)::int AS count
    FROM connections
    WHERE connector_key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND deleted_at IS NULL
  `;

	const count = Number((blockingConns[0] as { count: number }).count);
	if (count > 0) {
		throw new Error(
			`Cannot uninstall connector '${params.connectorKey}': ${count} connection(s) still reference it. Delete them first.`,
		);
	}

	const archived = await sql`
    UPDATE connector_definitions
    SET status = 'archived', updated_at = NOW()
    WHERE key = ${params.connectorKey}
      AND status = 'active'
      AND organization_id = ${params.organizationId}
    RETURNING key
  `;

	return archived.length > 0;
}

export async function toggleConnectorLoginEnabled(params: {
	organizationId: string;
	connectorKey: string;
	enabled: boolean;
}): Promise<ScopedConnectorDefinitionRow | null> {
	const sql = getDb();

	const connector = await getScopedConnectorDefinition({
		organizationId: params.organizationId,
		connectorKey: params.connectorKey,
	});

	if (!connector) {
		return null;
	}

	if (connector.status !== "active") {
		throw new Error(
			`Connector is ${connector.status}, must be active to be a login provider`,
		);
	}

	const oauthMethods = getOAuthMethods(connector.auth_schema);
	if (oauthMethods.length === 0) {
		throw new Error(
			"Connector must have an OAuth auth method to be a login provider",
		);
	}

	const providers = [
		...new Set(
			oauthMethods.map((method) => method.provider.trim().toLowerCase()),
		),
	];
	if (providers.length !== 1) {
		throw new Error(
			"Connector must expose exactly one OAuth provider to be a login provider",
		);
	}

	const loginMethod = oauthMethods[0];
	const provider = loginMethod?.provider?.trim().toLowerCase();
	if (!provider || !getLoginProviderScopes(provider, loginMethod.loginScopes)) {
		throw new Error(
			`OAuth provider '${provider ?? "unknown"}' cannot be used as a login provider: ` +
				`the connector's oauth method must declare 'loginScopes'.`,
		);
	}

	if (params.enabled) {
		const rows = await sql`
      SELECT key, auth_schema
      FROM connector_definitions
      WHERE login_enabled = true
        AND status = 'active'
        AND organization_id = ${params.organizationId}
        AND key <> ${params.connectorKey}
    `;

		const conflictingConnectors = rows
			.filter((row) => {
				const rowProviders = new Set(
					getOAuthMethods((row as { auth_schema: AuthSchema }).auth_schema).map(
						(method) => method.provider.trim().toLowerCase(),
					),
				);
				return rowProviders.has(provider);
			})
			.map((row) => String((row as { key: string }).key));

		if (conflictingConnectors.length > 0) {
			throw new Error(
				`Login provider '${provider}' is already enabled on connector(s): ${conflictingConnectors.join(", ")}. ` +
					"Disable the existing connector first.",
			);
		}
	}

	await sql`
    UPDATE connector_definitions
    SET login_enabled = ${params.enabled}, updated_at = NOW()
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
  `;

	return connector;
}
