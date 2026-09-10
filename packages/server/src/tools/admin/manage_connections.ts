/**
 * Tool: manage_connections
 *
 * Manage integration connections (auth bindings to external services).
 *
 * Actions:
 * - list: List connections for the organization

 * - get: Get a specific connection by ID
 * - create: Create a new connection (requires pre-existing auth profiles)
 * - connect: Create connection + auth link in one call (recommended for MCP clients).
 *            Returns a connect_url for the user to complete OAuth auth for a reusable profile.
 *            Poll with get until status='active'.
 * - update: Update connection settings
 * - delete: Delete a connection
 * - test: Test connection credentials
 * - install_connector: Install connector from URL, inline source, or MCP server URL into the current org
 * - uninstall_connector: Archive the org-scoped connector definition
 * - get_connector_source: Read an installed connector's source + retained version history (org-local)
 * - validate_connector_source: Compile source and return diagnostics without persisting (preflight)
 * - update_connector_source: Replace an installed connector's source with explicit versioning
 * - rollback_connector_version: Re-activate a retained prior version in one operation
 * - toggle_connector_login: Toggle connector as a login provider
 * - update_connector_auth: Update reusable default auth profiles for an installed org connector
 */

import type { Static } from "@sinclair/typebox";
import type { ConnectionsArgs, ManageConnectionsResult } from "./manage_connections/schemas";
import type { ToolContext } from "../registry";
import { action, defineActionTool } from "./action-tool";
import {
	handleReauthenticate,
	handleTest,
} from "./manage_connections/handlers/auth-actions";
import { handleSetChannelAbout } from "./manage_connections/handlers/channel-about";
import { handleConnect } from "./manage_connections/handlers/connect";
import { handleSetupOptions } from "./manage_connections/handlers/setup-options";
import { handleConnectManaged } from "./manage_connections/handlers/connect-managed";
import {
	handleGetConnectorSource,
	handleInstallConnector,
	handleRollbackConnectorVersion,
	handleToggleConnectorLogin,
	handleUninstallConnector,
	handleUpdateConnectorAuth,
	handleUpdateConnectorDefaultConfig,
	handleUpdateConnectorSource,
	handleValidateConnectorSource,
} from "./manage_connections/handlers/connector-management";
import {
	handleApplyChatConnection,
	handleCreate,
	handleDelete,
	handleGet,
	handleList,
	handleListConnectorGroups,
	handleUpdate,
} from "./manage_connections/handlers/crud";
import {
	ApplyChatConnectionAction,
	SetupOptionsAction,
	ConnectAction,
	ConnectManagedAction,
	CreateAction,
	DeleteAction,
	GetAction,
	GetConnectorSourceAction,
	InstallConnectorAction,
	ListAction,
	ListConnectorGroupsAction,
	ReauthenticateAction,
	RollbackConnectorVersionAction,
	SetChannelAboutAction,
	TestAction,
	ToggleConnectorLoginAction,
	UninstallConnectorAction,
	UpdateAction,
	UpdateConnectorAuthAction,
	UpdateConnectorDefaultConfigAction,
	UpdateConnectorSourceAction,
	ValidateConnectorSourceAction,
} from "./manage_connections/schemas";

// ============================================
// Main Function (Action Router)
// ============================================

export async function withSetupOptions(result: ManageConnectionsResult, connectorKey: string, ctx: ToolContext, setup = handleSetupOptions): Promise<ManageConnectionsResult> {
	if (!('status' in result) || result.status !== 'setup_required') return result;
	try {
		const setup_options = await setup({ connector_key: connectorKey }, ctx);
		const offers = setup_options.options.filter(option => option.kind !== 'local');
		const guidance = offers.length
			? 'Managed or hosted options are available. Present setup_options before asking the user for app credentials; hosted chat runs in cloud.'
			: setup_options.cloud_status === 'unavailable'
				? 'Cloud setup discovery is unavailable. Retry connections.setupOptions before concluding no managed option exists.'
				: '';
		return { ...result, setup_options, instructions: `${guidance} ${result.instructions}`.trim() };
	} catch {
		// Optional discovery must not replace an actionable setup continuation with an error.
		return result;
	}
}

const manageConnectionsTool = defineActionTool("manage_connections", {
	list_connector_groups: action(
		ListConnectorGroupsAction,
		handleListConnectorGroups,
	),
	list: action(ListAction, handleList),
	get: action(GetAction, handleGet),
	create: action(CreateAction, async (args, ctx) => withSetupOptions(await handleCreate(args, ctx), args.connector_key, ctx)),
	// Bound to two args: the router's third slot is `env`, not the handler's
	// optional discovery deps (only in-process callers inject those).
	setup_options: action(SetupOptionsAction, (args, ctx) => handleSetupOptions(args, ctx)),
	connect: action(ConnectAction, async (args, ctx) => withSetupOptions(await handleConnect(args, ctx), args.connector_key, ctx)),
	connect_managed: action(ConnectManagedAction, handleConnectManaged),
	update: action(UpdateAction, handleUpdate),
	apply_chat_connection: action(
		ApplyChatConnectionAction,
		handleApplyChatConnection,
	),
	delete: action(DeleteAction, handleDelete),
	reauthenticate: action(ReauthenticateAction, handleReauthenticate),
	test: action(TestAction, handleTest),
	install_connector: action(InstallConnectorAction, handleInstallConnector),
	uninstall_connector: action(
		UninstallConnectorAction,
		handleUninstallConnector,
	),
	get_connector_source: action(
		GetConnectorSourceAction,
		handleGetConnectorSource,
	),
	validate_connector_source: action(
		ValidateConnectorSourceAction,
		handleValidateConnectorSource,
	),
	update_connector_source: action(
		UpdateConnectorSourceAction,
		handleUpdateConnectorSource,
	),
	rollback_connector_version: action(
		RollbackConnectorVersionAction,
		handleRollbackConnectorVersion,
	),
	toggle_connector_login: action(
		ToggleConnectorLoginAction,
		handleToggleConnectorLogin,
	),
	update_connector_auth: action(
		UpdateConnectorAuthAction,
		handleUpdateConnectorAuth,
	),
	update_connector_default_config: action(
		UpdateConnectorDefaultConfigAction,
		handleUpdateConnectorDefaultConfig,
	),
	set_channel_about: action(SetChannelAboutAction, handleSetChannelAbout),
});

export const ManageConnectionsSchema = manageConnectionsTool.schema;
export const manageConnections = manageConnectionsTool.run;

type AssertTrue<T extends true> = T;
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/**
 * @internal Compile-time fixture. core hand-lists `ConnectionsArgs` (it cannot
 * see this tool's union without a circular type) and derives every
 * `*Input` from that list, so a variant dispatched here but missing there
 * would have no derivable input and nothing would say so. Pin the two.
 */
export type ConnectionsArgsCoverEveryDispatchedVariant = AssertTrue<
	SameUnion<Static<typeof ManageConnectionsSchema>, ConnectionsArgs>
>;
// Re-export so the admin registry entry can wire `outputSchema`.
export { ManageConnectionsResultSchema } from "./manage_connections/schemas";
