/**
 * ClientSDK `connections` namespace. Thin, action-complete wrapper over
 * `manageConnections`.
 *
 * `connect` returns a `connect_url`. `reauthenticate` returns a `connect_url`
 * for OAuth accounts or an `auth_run_id` for interactive pairing. Field names
 * follow the handler schema.
 */

import type {
	ConnectionReauthenticateOptions,
	ConnectionSetupOptionsInput,
	ConnectionConnectInput,
	ConnectionConnectManagedInput,
	ConnectionCreateInput,
	ConnectionListInput,
	ConnectionUpdateInput,
	GetConnectorSourceInput,
	InstallConnectorInput,
	RollbackConnectorVersionInput,
	ToggleConnectorLoginInput,
	UpdateConnectorAuthInput,
	UpdateConnectorDefaultConfigInput,
	UpdateConnectorSourceInput,
	ValidateConnectorSourceInput,
} from "@lobu/core/contracts/tools/manage-connections";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

export interface ConnectionsNamespace {
	/** Raw escape hatch for any manage_connections action. Prefer named methods. */
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: ConnectionListInput): Promise<unknown>;
	get(connection_id: number): Promise<unknown>;
	create(input: ConnectionCreateInput): Promise<unknown>;
	setupOptions(input: ConnectionSetupOptionsInput): Promise<unknown>;
	connect(input: ConnectionConnectInput): Promise<unknown>;
	connectManaged(input: ConnectionConnectManagedInput): Promise<unknown>;
	update(input: ConnectionUpdateInput): Promise<unknown>;
	delete(connection_id: number): Promise<unknown>;
	reauthenticate(
		connection_id: number,
		options?: ConnectionReauthenticateOptions,
	): Promise<unknown>;
	test(connection_id: number): Promise<unknown>;
	installConnector(input: InstallConnectorInput): Promise<unknown>;
	uninstallConnector(connector_key: string): Promise<unknown>;
	getConnectorSource(input: GetConnectorSourceInput): Promise<unknown>;
	validateConnectorSource(
		input: ValidateConnectorSourceInput,
	): Promise<unknown>;
	updateConnectorSource(input: UpdateConnectorSourceInput): Promise<unknown>;
	rollbackConnectorVersion(
		input: RollbackConnectorVersionInput,
	): Promise<unknown>;
	toggleConnectorLogin(
		input: ToggleConnectorLoginInput,
	): Promise<unknown>;
	updateConnectorAuth(
		input: UpdateConnectorAuthInput,
	): Promise<unknown>;
	updateConnectorDefaultConfig(
		input: UpdateConnectorDefaultConfigInput,
	): Promise<unknown>;
}

export function buildConnectionsNamespace(
	ctx: ToolContext,
	env: Env,
): ConnectionsNamespace {
	const { manage, method } = createActionCaller(
		manageConnections,
		env,
		ctx,
		"connections",
	);

	return {
		manage,
		list: method("list"),
		get: method("get", {
			mapArgs: (connection_id) => ({
				connection_id: idArg(
					"connections.get",
					"connection_id",
					connection_id,
					"number",
				),
			}),
		}),
		create: method("create"),
		setupOptions: method("setup_options", { publicMethod: "setupOptions" }),
		connect: method("connect"),
		connectManaged: method("connect_managed", {
			publicMethod: "connectManaged",
		}),
		update: method("update"),
		delete: method("delete", {
			mapArgs: (connection_id) => ({
				connection_id: idArg(
					"connections.delete",
					"connection_id",
					connection_id,
					"number",
				),
			}),
		}),
		reauthenticate: method("reauthenticate", {
			mapArgs: (connection_id, options) => ({
				...(options as ConnectionReauthenticateOptions | undefined),
				connection_id: idArg(
					"connections.reauthenticate",
					"connection_id",
					connection_id,
					"number",
				),
			}),
		}),
		test: method("test", {
			mapArgs: (connection_id) => ({
				connection_id: idArg(
					"connections.test",
					"connection_id",
					connection_id,
					"number",
				),
			}),
		}),
		installConnector: method("install_connector", {
			publicMethod: "installConnector",
		}),
		uninstallConnector: method("uninstall_connector", {
			publicMethod: "uninstallConnector",
			mapArgs: (connector_key) => ({
				connector_key: idArg(
					"connections.uninstallConnector",
					"connector_key",
					connector_key,
					"string",
				),
			}),
		}),
		getConnectorSource: method("get_connector_source", {
			publicMethod: "getConnectorSource",
		}),
		validateConnectorSource: method("validate_connector_source", {
			publicMethod: "validateConnectorSource",
		}),
		updateConnectorSource: method("update_connector_source", {
			publicMethod: "updateConnectorSource",
		}),
		rollbackConnectorVersion: method("rollback_connector_version", {
			publicMethod: "rollbackConnectorVersion",
		}),
		toggleConnectorLogin: method("toggle_connector_login", {
			publicMethod: "toggleConnectorLogin",
		}),
		updateConnectorAuth: method("update_connector_auth", {
			publicMethod: "updateConnectorAuth",
		}),
		updateConnectorDefaultConfig: method("update_connector_default_config", {
			publicMethod: "updateConnectorDefaultConfig",
		}),
	};
}
