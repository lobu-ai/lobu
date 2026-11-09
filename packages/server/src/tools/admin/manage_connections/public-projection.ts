import { isInProcessSystemCall } from "../../access-control";
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
 * Narrow one connection row to the public field set when the caller is not a
 * member of the org.
 *
 * Gated on `memberRole` rather than `isAuthenticated`: an authenticated
 * non-member on a public org is admitted with `memberRole: null`
 * (workspace/multi-tenant.ts), and has the same read entitlement as an
 * anonymous caller. System-call detection is the canonical
 * {@link isInProcessSystemCall} — a local copy here once drifted, so this
 * seam imports it instead of re-deriving the shape.
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
