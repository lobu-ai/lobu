import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { getDb, pgTextArray } from "../db/client";
import type { Env } from "../index";
import { requireOrgUser } from "../utils/require-org-user";

/**
 * Recent materialized MCP activity identities for connected OAuth apps.
 * A row is either a host conversation or a transport session; the write-time
 * `activity_kind` discriminator preserves that distinction without request-time
 * event-history aggregation. Unread counts inspect only this viewer's live
 * inbox targets and join their notification events by primary key.
 */
const routes = new Hono<{ Bindings: Env }>();
const ACTIVITY_WINDOW_DAYS = 14;
const LOBU_COMMAND_CLIENT_SOFTWARE_ID = "lobu-cli";

interface ActivityScopeRow {
	activity_kind: "conversation" | "session";
	conversation_id: string;
	client_id: string;
	client_name: string | null;
	title: string | null;
	last_action: string;
	first_activity_at: Date;
	last_activity_at: Date;
	call_count: number | string;
	failed_count: number | string;
	tools: unknown;
	unread_notification_count: number;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function displayAction(value: string): string {
	if (!value.includes("_")) return value;
	return value
		.split("_")
		.filter(Boolean)
		.map((part) => {
			const lower = part.toLowerCase();
			if (["sdk", "sql", "mcp"].includes(lower)) return lower.toUpperCase();
			return lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join(" ");
}

routes.get("/", mcpAuth, async (c) => {
	const auth = requireOrgUser(c);
	if (!auth) return c.json({ error: "Organization user required" }, 401);
	const { organizationId, userId } = auth;
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
	const limit = Math.min(
		Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1),
		100,
	);
	const clientIds = (c.req.query("client_ids") ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (clientIds.some((clientId) => clientId.length > 512)) {
		return c.json({ error: "Invalid client ID" }, 400);
	}
	const excludeCommandClients =
		c.req.query("exclude_command_clients") === "true";
	const activityKind = c.req.query("activity_kind")?.trim() || null;
	if (
		activityKind !== null &&
		activityKind !== "conversation" &&
		activityKind !== "session"
	) {
		return c.json({ error: "Invalid activity kind" }, 400);
	}
	const sql = getDb();
	const rows = await sql<ActivityScopeRow>`
    WITH unread_notifications AS (
      SELECT e.client_id,
        COALESCE(
          e.metadata->>'mcp_conversation_id',
          e.metadata->>'mcp_session_id'
        ) AS activity_id,
        count(*)::integer AS unread_notification_count
      FROM public.notification_targets target
      JOIN public.events e ON e.id = target.event_id
      WHERE target.user_id = ${userId}
        AND target.read_at IS NULL
        AND e.organization_id = ${organizationId}
        AND e.client_id IS NOT NULL
        AND COALESCE(
          e.metadata->>'mcp_conversation_id',
          e.metadata->>'mcp_session_id'
        ) IS NOT NULL
      GROUP BY e.client_id, activity_id
    )
    SELECT mc.activity_kind, mc.conversation_id, mc.client_id, oc.client_name,
      mc.title, mc.last_action, mc.first_activity_at, mc.last_activity_at,
      mc.call_count, mc.failed_count,
      jsonb_path_query_array(mc.tools, '$[0 to 7]') AS tools,
      COALESCE(notification_count.unread_notification_count, 0)::integer
        AS unread_notification_count
    FROM public.mcp_client_conversations mc
    JOIN public.oauth_clients oc ON oc.id = mc.client_id
    LEFT JOIN unread_notifications notification_count
      ON notification_count.client_id = mc.client_id
      AND notification_count.activity_id = mc.conversation_id
    WHERE mc.organization_id = ${organizationId}
      ${
				clientIds.length > 0
					? sql`AND mc.client_id = ANY(${pgTextArray(clientIds)}::text[])`
					: sql``
			}
      AND mc.call_count > 0
      ${activityKind ? sql`AND mc.activity_kind = ${activityKind}` : sql``}
      AND mc.last_activity_at > now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS})
      ${
				excludeCommandClients
					? sql`AND mc.client_software_id IS DISTINCT FROM ${LOBU_COMMAND_CLIENT_SOFTWARE_ID}`
					: sql``
			}
    ORDER BY mc.last_activity_at DESC
    LIMIT ${limit}
  `;

	return c.json({
		scopes: rows.map((row) => ({
			activityId: row.conversation_id,
			activityKind: row.activity_kind,
			clientId: row.client_id,
			clientName: row.client_name,
			title: row.title,
			lastAction: displayAction(row.last_action),
			firstCallAt: new Date(row.first_activity_at).getTime(),
			lastCallAt: new Date(row.last_activity_at).getTime(),
			callCount: Number(row.call_count),
			failedCount: Number(row.failed_count),
			tools: stringArray(row.tools),
			unreadNotificationCount: Number(row.unread_notification_count),
		})),
	});
});

export const clientActivityScopeRoutes = routes;
