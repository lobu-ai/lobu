/**
 * Connector management action handlers:
 * install_connector, uninstall_connector, get_connector_source,
 * validate_connector_source, update_connector_source,
 * rollback_connector_version, toggle_connector_login,
 * update_connector_auth, update_connector_default_config.
 */

import { getErrorMessage, parseJsonObject } from "@lobu/core";
import { getDb } from "../../../../db/client";
import { recordToolConfigChange } from "../../helpers/config-audit";
import { normalizeAuthValues } from "../../../../utils/auth-profiles";
import {
	DEVICE_AUTOWIRE_SUPPRESSION_ERROR,
	hasDeviceAutowireSuppressionMarker,
} from "../../../../utils/device-autowire-suppression";
import logger from "../../../../utils/logger";
import {
	actionModesChanged,
	denyNonHumanActionModesWrite,
} from "./action-modes-guard";
import type { ToolContext } from "../../../registry";
import {
	getInstalledConnectorSource,
	installCatalogConnectorDefinition,
	installConnectorDefinitionFromSource,
	installConnectorFromMcpUrl,
	rollbackConnectorVersion,
	toggleConnectorLoginEnabled,
	uninstallConnectorDefinition,
	updateInstalledConnectorSource,
	validateConnectorSource,
} from "../../../../catalog/connector-definitions";
import {
	maybeUpsertAuthAfterInstall,
	upsertConnectorAuthProfiles,
} from "../../helpers/connection-helpers";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";

// ============================================
// handleInstallConnector
// ============================================

export async function handleInstallConnector(
	args: Extract<ConnectionsArgs, { action: "install_connector" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	try {
		const connectorId = args.connector_id?.trim();
		const mcpUrl = args.mcp_url?.trim();
		const sourceUrl = args.source_url?.trim();
		const sourceUri = args.source_uri?.trim();
		const sourceCode = args.source_code;
		const sourceCodeProvided =
			typeof sourceCode === "string" && sourceCode.trim().length > 0;
		const sources = [connectorId, mcpUrl, sourceUrl, sourceUri].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		if (sourceCodeProvided) sources.push(sourceCode);
		if (sources.length !== 1) {
			return {
				error:
					"Provide exactly one of connector_id, source_url, source_uri, source_code, or mcp_url.",
			};
		}

		const installed = connectorId
			? await installCatalogConnectorDefinition({
					organizationId: ctx.organizationId,
					connectorId,
				})
			: mcpUrl
				? await installConnectorFromMcpUrl({
						organizationId: ctx.organizationId,
						mcpUrl,
					})
				: await installConnectorDefinitionFromSource({
						organizationId: ctx.organizationId,
						sourceUrl,
						sourceUri,
						sourceCode,
						compiled: args.compiled,
						compiledCode: args.compiled_code,
						sourceFiles: args.source_files,
						dependencies: args.dependencies,
					});

		await maybeUpsertAuthAfterInstall(installed, args.auth_values, ctx);

		recordToolConfigChange(ctx, {
			resourceKind: "connector-definition",
			resourceId: installed.connectorKey,
			op: installed.updated ? "updated" : "created",
			summary: `Connector '${installed.name ?? installed.connectorKey}' ${installed.updated ? "updated" : "installed"} (v${installed.version})`,
			// Intentionally small: key/version/source only — never compiled code.
			state: {
				connector_key: installed.connectorKey,
				name: installed.name,
				version: installed.version,
				code_hash: installed.codeHash,
				...(connectorId ? { connector_id: connectorId } : {}),
				...(mcpUrl ? { mcp_url: mcpUrl } : {}),
				...(sourceUrl ? { source_url: sourceUrl } : {}),
				...(sourceUri ? { source_uri: sourceUri } : {}),
			},
		});

		return {
			action: "install_connector",
			installed: true,
			connector_key: installed.connectorKey,
			name: installed.name,
			version: installed.version,
			code_hash: installed.codeHash,
			updated: installed.updated,
		};
	} catch (error) {
		return {
			error: `Install failed: ${getErrorMessage(error)}`,
		};
	}
}

// ============================================
// handleUninstallConnector
// ============================================

export async function handleUninstallConnector(
	args: Extract<ConnectionsArgs, { action: "uninstall_connector" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	try {
		const archived = await uninstallConnectorDefinition({
			organizationId: ctx.organizationId,
			connectorKey: args.connector_key,
		});
		if (!archived) {
			return {
				error: `Connector '${args.connector_key}' not found or already archived`,
			};
		}
	} catch (error) {
		return { error: getErrorMessage(error) };
	}

	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "deleted",
		summary: `Connector '${args.connector_key}' uninstalled`,
		state: null,
	});

	return {
		action: "uninstall_connector",
		uninstalled: true,
		connector_key: args.connector_key,
	};
}

// ============================================
// Connector source lifecycle (#2045)
// ============================================

export async function handleGetConnectorSource(
	args: Extract<ConnectionsArgs, { action: "get_connector_source" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	try {
		const source = await getInstalledConnectorSource({
			organizationId: ctx.organizationId,
			connectorKey: args.connector_key,
			version: args.version,
		});
		return {
			action: "get_connector_source",
			connector_key: source.connectorKey,
			active_version: source.activeVersion,
			version: source.version,
			source_code: source.sourceCode,
			source_files: source.sourceFiles,
			dependencies: source.dependencies,
			source_complete: source.sourceComplete,
			source_path: source.sourcePath,
			code_hash: source.codeHash,
			versions: source.versions,
		};
	} catch (error) {
		return { error: getErrorMessage(error) };
	}
}

export async function handleValidateConnectorSource(
	args: Extract<ConnectionsArgs, { action: "validate_connector_source" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const result = await validateConnectorSource({
		organizationId: ctx.organizationId,
		sourceCode: args.source_code,
		compiled: args.compiled,
		compiledCode: args.compiled_code,
		sourceFiles: args.source_files,
		dependencies: args.dependencies,
	});
	if (!result.valid) {
		// A failed compile is the preflight WORKING, not a tool error — return it
		// as a value so run_sdk callers can read the diagnostics.
		return {
			action: "validate_connector_source",
			valid: false,
			diagnostics: result.diagnostics,
		};
	}
	return {
		action: "validate_connector_source",
		valid: true,
		connector_key: result.connectorKey,
		name: result.name,
		version: result.version,
		code_hash: result.codeHash,
		installed: result.installed,
		active_version: result.activeVersion,
		version_exists: result.versionExists,
		// Extracted per-action kind/requiredScopes + feed keys, so an author can
		// confirm the semantic-policy fields survived extraction before persisting.
		actions: result.actions,
		feed_keys: result.feedKeys,
	};
}

export async function handleUpdateConnectorSource(
	args: Extract<ConnectionsArgs, { action: "update_connector_source" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	try {
		const updated = await updateInstalledConnectorSource({
			organizationId: ctx.organizationId,
			connectorKey: args.connector_key,
			sourceCode: args.source_code,
			compiled: args.compiled,
			compiledCode: args.compiled_code,
			sourceFiles: args.source_files,
			dependencies: args.dependencies,
			expectedVersion: args.expected_version,
		});

		recordToolConfigChange(ctx, {
			resourceKind: "connector-definition",
			resourceId: updated.connectorKey,
			op: "updated",
			summary: `Connector '${updated.connectorKey}' source updated (v${updated.previousVersion} → v${updated.version})`,
			// key/version/hash only — never compiled code.
			state: {
				connector_key: updated.connectorKey,
				previous_version: updated.previousVersion,
				version: updated.version,
				code_hash: updated.codeHash,
			},
			changedFields: ["source_code", "version"],
		});

		return {
			action: "update_connector_source",
			success: true,
			connector_key: updated.connectorKey,
			name: updated.name,
			previous_version: updated.previousVersion,
			version: updated.version,
			code_hash: updated.codeHash,
		};
	} catch (error) {
		return { error: `Update failed: ${getErrorMessage(error)}` };
	}
}

export async function handleRollbackConnectorVersion(
	args: Extract<ConnectionsArgs, { action: "rollback_connector_version" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	try {
		const rolled = await rollbackConnectorVersion({
			organizationId: ctx.organizationId,
			connectorKey: args.connector_key,
			version: args.version,
		});

		recordToolConfigChange(ctx, {
			resourceKind: "connector-definition",
			resourceId: rolled.connectorKey,
			op: "updated",
			summary: `Connector '${rolled.connectorKey}' rolled back (v${rolled.previousVersion} → v${rolled.version})`,
			state: {
				connector_key: rolled.connectorKey,
				previous_version: rolled.previousVersion,
				version: rolled.version,
				code_hash: rolled.codeHash,
			},
			changedFields: ["version"],
		});

		return {
			action: "rollback_connector_version",
			success: true,
			connector_key: rolled.connectorKey,
			name: rolled.name,
			previous_version: rolled.previousVersion,
			version: rolled.version,
			code_hash: rolled.codeHash,
		};
	} catch (error) {
		return { error: `Rollback failed: ${getErrorMessage(error)}` };
	}
}

// ============================================
// handleToggleConnectorLogin
// ============================================

/**
 * Toggle connector as a login provider.
 * Requires OAuth auth method in the connector's auth_schema.
 */
export async function handleToggleConnectorLogin(
	args: Extract<ConnectionsArgs, { action: "toggle_connector_login" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	try {
		const connector = await toggleConnectorLoginEnabled({
			organizationId: ctx.organizationId,
			connectorKey: args.connector_key,
			enabled: args.enabled,
		});

		if (!connector) {
			return {
				error: `Connector '${args.connector_key}' not found for this organization. Install it first.`,
			};
		}

		logger.info(
			{ connector_key: args.connector_key, login_enabled: args.enabled },
			"Connector login provider toggled",
		);

		recordToolConfigChange(ctx, {
			resourceKind: "connector-definition",
			resourceId: args.connector_key,
			op: "updated",
			summary: `Connector '${args.connector_key}' login provider ${args.enabled ? "enabled" : "disabled"}`,
			state: { connector_key: args.connector_key, login_enabled: args.enabled },
			changedFields: ["login_enabled"],
		});

		return {
			action: "toggle_connector_login",
			success: true,
			connector_key: args.connector_key,
			login_enabled: args.enabled,
		};
	} catch (error) {
		return { error: getErrorMessage(error) };
	}
}

// ============================================
// handleUpdateConnectorAuth
// ============================================

export async function handleUpdateConnectorAuth(
	args: Extract<ConnectionsArgs, { action: "update_connector_auth" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const sql = getDb();
	const organizationId = ctx.organizationId;
	const userId = ctx.userId ?? "api";

	const authValues = normalizeAuthValues(args.auth_values);
	if (Object.keys(authValues).length === 0) {
		return { error: "No auth values provided." };
	}

	const connectorRows = await sql`
    SELECT key, name, auth_schema
    FROM connector_definitions
    WHERE key = ${args.connector_key}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
	if (connectorRows.length === 0) {
		return {
			error: `Connector '${args.connector_key}' not found for this organization.`,
		};
	}

	const connector = connectorRows[0] as {
		key: string;
		name: string;
		auth_schema: Record<string, unknown> | null;
	};

	await upsertConnectorAuthProfiles({
		organizationId,
		connectorKey: args.connector_key,
		connectorName: connector.name,
		authSchema: connector.auth_schema,
		authValues,
		createdBy: userId,
	});

	logger.info(
		{ connector_key: args.connector_key, keys: Object.keys(authValues) },
		"Connector auth profiles updated",
	);

	// Metadata-only (state null): auth values are secret material, and the
	// key NAMES alone already say which credentials were rotated.
	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "updated",
		summary: `Connector '${args.connector_key}' auth updated (${Object.keys(authValues).join(", ")})`,
		state: null,
		changedFields: ["auth_profiles"],
	});

	return {
		action: "update_connector_auth",
		success: true,
		connector_key: args.connector_key,
		keys_updated: Object.keys(authValues),
	};
}

// ============================================
// handleUpdateConnectorDefaultConfig
// ============================================

export async function handleUpdateConnectorDefaultConfig(
	args: Extract<ConnectionsArgs, { action: "update_connector_default_config" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	// Auto-wire seeds these defaults into the connection rows it creates, so
	// this is a config-write path for the reserved suppression marker too.
	if (hasDeviceAutowireSuppressionMarker(args.default_connection_config)) {
		return { error: DEVICE_AUTOWIRE_SUPPRESSION_ERROR };
	}
	// This is a full replacement, so removal is a modes change too. Compare and
	// write under one row lock to preserve a concurrent human edit.
	const sql = getDb();
	const outcome = await sql.begin(
		async (tx): Promise<"not_found" | { error: string } | null> => {
			const rows = (await tx`
				SELECT default_connection_config
				FROM connector_definitions
				WHERE key = ${args.connector_key}
					AND organization_id = ${ctx.organizationId}
					AND status = 'active'
				FOR UPDATE
			`) as unknown as Array<{ default_connection_config: unknown }>;
			if (rows.length === 0) return "not_found";
			const storedDefaults = parseJsonObject(rows[0].default_connection_config);
			if (actionModesChanged(storedDefaults, args.default_connection_config)) {
				const denied = denyNonHumanActionModesWrite(ctx);
				if (denied) return denied;
			}
			await tx`
				UPDATE connector_definitions
				SET default_connection_config = ${tx.json(args.default_connection_config)},
					updated_at = NOW()
				WHERE key = ${args.connector_key}
					AND organization_id = ${ctx.organizationId}
					AND status = 'active'
			`;
			return null;
		},
	);

	if (outcome === "not_found") {
		return { error: `Connector '${args.connector_key}' not found` };
	}
	if (outcome) return outcome;

	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "updated",
		summary: `Connector '${args.connector_key}' default connection config updated`,
		state: {
			connector_key: args.connector_key,
			default_connection_config: args.default_connection_config,
		},
		changedFields: ["default_connection_config"],
	});

	return {
		action: "update_connector_default_config",
		success: true,
		connector_key: args.connector_key,
	};
}
