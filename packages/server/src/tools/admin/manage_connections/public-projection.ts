import { isSystemContext } from "../../access-control";
import type { ToolContext } from "../../registry";

/**
 * `manage_connections.list` and `get` are public-read actions. Keep their
 * non-member response to discovery metadata so new connection columns remain
 * private by default.
 */
const PUBLIC_CONNECTION_FIELDS: ReadonlySet<string> = new Set([
	"id",
	"slug",
	"display_name",
	"connector_key",
	"connector_name",
	"status",
	"visibility",
	"created_at",
	"updated_at",
	"feed_count",
	"data_feed_count",
	"entity_ids",
	"entity_names",
	"declares_chat",
	"has_feeds_schema",
	"has_operations",
	"operations_summary",
	"facets",
]);

/**
 * True for an in-process system call — an automation reaction and friends, which
 * run with `userId: null` + `isAuthenticated: true` + `tokenType: 'session'`
 * (automations/reaction-executor.ts). Those keep operational metadata: they read
 * `credential_mode` / `error_message` / device fields to decide what to do,
 * and narrowing them would break reactions silently rather than loudly.
 *
 * `isSystemContext` alone is NOT sufficient as a data-exposure boundary. It
 * was written to bypass role/scope policy at the handler boundary, and its
 * shape (`isAuthenticated && !userId && !memberRole`) is also satisfied by a
 * TOKEN minted without a user — `multi-tenant.ts` passes
 * `userId: tokenData.userId || undefined`, and `AuthInfo.userId` is
 * `string | null | undefined`. Such a token, non-member, on a public org over
 * MCP would otherwise read as "system" and be handed the full row including a
 * live `connect_token`. Requiring `tokenType: 'session'` excludes every token
 * caller (`pat` / `access_token` / `Bearer`) and every anonymous one
 * (`anonymous`). A real browser session also carries `session`, but it has a
 * `userId`, so `isSystemContext` already excludes it.
 */
function isInProcessSystemCall(ctx: ToolContext): boolean {
	return isSystemContext(ctx) && ctx.tokenType === "session";
}

/**
 * Narrow one connection row to the public field set when the caller is not a
 * member of the org.
 *
 * Gated on `memberRole` rather than `isAuthenticated`: an authenticated
 * non-member on a public org is admitted with `memberRole: null`
 * (workspace/multi-tenant.ts), and has the same read entitlement as an
 * anonymous caller.
 */
export function projectConnectionForReader(
	row: Record<string, unknown>,
	ctx: ToolContext
): Record<string, unknown> {
	if (ctx.memberRole || isInProcessSystemCall(ctx)) {
		// Inventory access does not include the bearer link that replaces a
		// person's credentials. Both list and get cross this projection.
		if (row.connect_token && (!ctx.userId || row.created_by !== ctx.userId)) {
			const { connect_token: _token, ...metadata } = row;
			return metadata;
		}
		return row;
	}

	const projected: Record<string, unknown> = {};
	for (const key of Object.keys(row)) {
		if (PUBLIC_CONNECTION_FIELDS.has(key)) projected[key] = row[key];
	}
	return projected;
}
