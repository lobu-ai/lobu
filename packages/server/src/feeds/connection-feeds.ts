import { getDb } from "../db/client.js";
import { runtimeConnectionIdToSlug } from "../lobu/stores/connections-projection.js";
import type { FeedOperation, FeedSpec, FeedStatus, FeedStore } from "./types.js";

interface FeedRow {
	id: string;
	feed_key: string;
	operations: FeedOperation[];
	store: FeedStore;
	label: string;
	status: string;
	last_sync_at: Date | string | null;
	items_collected: string | number;
	target_agent_id: string | null;
}

/**
 * List every feed on a connection, fenced to `(organization_id,
 * connection_id)` so it never scans globally. A channel-message feed is
 * decorated with the agent subscribed to its channel via an Automation trigger
 * (channel_id = feed_key).
 *
 * `connectionId` is the RUNTIME connection id (e.g. a BYO uuid or a managed
 * `slackinst-…` id), not the numeric `connections.id` that `feeds.connection_id`
 * stores. We resolve it through `connections.slug` — never cast it to bigint,
 * which throws for every non-numeric (managed / slug-shaped) id.
 */
export async function listConnectionFeeds(
	organizationId: string,
	connectionId: string,
): Promise<FeedSpec[]> {
	const sql = getDb();
	const slug = runtimeConnectionIdToSlug(connectionId);
	const rows = await sql<FeedRow>`
		SELECT
			f.id::text                            AS id,
			f.feed_key                            AS feed_key,
			COALESCE((
				SELECT definition.feeds_schema -> f.feed_key -> 'operations'
				FROM connector_definitions definition
				JOIN connections definition_connection ON definition_connection.id = f.connection_id
				WHERE definition.key = definition_connection.connector_key
					AND definition.organization_id = f.organization_id
					AND (
						(f.pinned_version IS NULL AND definition.status = 'active')
						OR (
							f.pinned_version IS NOT NULL
							AND (
								definition.version = f.pinned_version
								OR definition.status = 'active'
							)
						)
					)
				ORDER BY (definition.version = f.pinned_version) DESC,
					(definition.status = 'active') DESC,
					definition.updated_at DESC,
					definition.id DESC
				LIMIT 1
			), '[]'::jsonb)                    AS operations,
			COALESCE(f.config ->> 'store', 'events') AS store,
			COALESCE(f.display_name, f.feed_key)  AS label,
			f.status                              AS status,
			f.last_sync_at                        AS last_sync_at,
			f.items_collected                     AS items_collected,
			(
				SELECT subscription.agent_id
				FROM automation_message_subscriptions subscription
				WHERE subscription.organization_id = f.organization_id
					AND subscription.connection_id = f.connection_id
					AND subscription.channel_id = f.feed_key
				LIMIT 1
			)                                     AS target_agent_id
		FROM feeds f
		WHERE f.organization_id = ${organizationId}
			AND f.connection_id = (
				SELECT c.id FROM connections c
				WHERE c.organization_id = ${organizationId}
					AND c.slug = ${slug}
					-- Only the LIVE row: a slug is unique per org among non-deleted
					-- connections (connections_org_slug_unique), but a soft-deleted
					-- row keeps the slug — without this the scalar subquery could
					-- match several rows and error (500).
					AND c.deleted_at IS NULL
			)
			AND f.deleted_at IS NULL
		ORDER BY COALESCE(f.last_sync_at, f.updated_at) DESC
	`;

	return rows.map((r) => ({
		id: r.id,
		feedKey: r.feed_key,
		operations: r.operations,
		store: r.store,
		connectionId,
		label: r.label,
		status: r.status as FeedStatus,
		lastSyncAt:
			r.last_sync_at == null ? null : new Date(r.last_sync_at).toISOString(),
		itemsCollected: Number(r.items_collected),
		targetAgentId: r.target_agent_id,
	}));
}
