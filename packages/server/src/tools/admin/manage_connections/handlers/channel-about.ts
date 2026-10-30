import { setManualChannelAboutEdges } from "../../../../authz/channel-about";
import { getDb } from "../../../../db/client";
import { withFailureCode } from "../../../../utils/errors";
import { resolveSubscriptionTeam } from "../../../../gateway/channels/subscription-scope-resolver";
import { assertEntityIdsInOrg } from "../../helpers/db-helpers";
import type { ToolContext } from "../../../registry";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";

/** Set manual business-entity links for a chat channel (UI picker). */
export async function handleSetChannelAbout(
	args: Extract<ConnectionsArgs, { action: "set_channel_about" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId, userId } = ctx;
	const sql = getDb();
	const rows = await sql<{
		id: number;
		connector_key: string;
		external_tenant_id: string | null;
	}>`
		SELECT id, connector_key, external_tenant_id
		FROM connections
		WHERE id = ${args.connection_id}
		  AND organization_id = ${organizationId}
		  AND credential_mode IS NOT NULL
		  AND deleted_at IS NULL
		LIMIT 1
	`;
	const connection = rows[0];
	if (!connection) return withFailureCode({ error: "Chat connection not found" }, "NOT_FOUND");

	const subscribedTeam = await sql<{ team_id: string | null }>`
		SELECT team_id
		FROM automation_message_subscriptions
		WHERE organization_id = ${organizationId}
		  AND connection_id = ${connection.id}
		  AND channel_id = ${args.channel_id}
		  AND team_id IS NOT NULL
		LIMIT 1
	`;
	const teamId =
		subscribedTeam[0]?.team_id ??
		(await resolveSubscriptionTeam({
			connection: {
				connectorKey: connection.connector_key,
				externalTenantId: connection.external_tenant_id,
				connectionId: connection.id,
				organizationId,
			},
			channelId: args.channel_id,
		})) ??
		undefined;

	try {
		await assertEntityIdsInOrg(sql, organizationId, args.about_entity_ids);
		await setManualChannelAboutEdges({
			organizationId,
			connectionId: connection.id,
			connectorKey: connection.connector_key,
			teamId,
			channelId: args.channel_id,
			aboutEntityIds: args.about_entity_ids,
			userId,
			sql,
		});
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Failed to set channel about links",
		};
	}

	return {
		action: "set_channel_about",
		success: true,
		connection_id: connection.id,
		channel_id: args.channel_id,
		about_entity_ids: args.about_entity_ids,
	};
}
