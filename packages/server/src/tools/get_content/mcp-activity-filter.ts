import { type DbClient, pgTextArray } from "../../db/client";
import { ToolUserError } from "../../utils/errors";

interface ActivityTransportRow {
	transport_session_ids: unknown;
}

/**
 * Resolve an exact materialized MCP activity scope for one Connected App.
 * `clientIds` contains the OAuth registrations grouped on that app page. The
 * activity id is still exact: distinct ChatGPT host conversation ids never
 * share transport sessions or events.
 */
export async function resolveMcpActivitySessionIds(
	sql: DbClient,
	organizationId: string,
	clientIds: string[],
	activityId: string,
): Promise<string[]> {
	const rows = await sql<ActivityTransportRow>`
    SELECT transport_session_ids
    FROM public.mcp_client_conversations
    WHERE organization_id = ${organizationId}
      AND client_id = ANY(${pgTextArray(clientIds)}::text[])
      AND conversation_id = ${activityId}
  `;
	if (rows.length === 0) {
		throw new ToolUserError("MCP activity not found.", 404);
	}

	const sessionIds = new Set<string>();
	for (const row of rows) {
		if (!Array.isArray(row.transport_session_ids)) {
			throw new Error(
				"MCP activity has an invalid transport-session projection.",
			);
		}
		for (const value of row.transport_session_ids) {
			if (
				typeof value !== "string" ||
				value.length === 0 ||
				value.includes("\0")
			) {
				throw new Error(
					"MCP activity has an invalid transport-session projection.",
				);
			}
			sessionIds.add(value);
		}
	}

	return [...sessionIds];
}
