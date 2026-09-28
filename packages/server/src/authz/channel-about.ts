/**
 * Business-context links for chat channels: typed `about` edges from a channel
 * resource entity to org business entities (customer, project, company, …).
 *
 * ACL membership (`member_of`) and business context (`about`) share the same
 * `entity_relationships` graph but use different relationship types — ACL
 * reconcile never touches `about` edges.
 */

import { ACL_RESOURCE_TYPE_SLUG } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../db/client.js";
import { upsertEdges } from "../utils/edge-writes.js";
import { withEntityWriteTransaction } from "../utils/entity-management.js";
import {
	connectionRelationshipClaimKey,
	lockLiveConnectionForRelationshipClaims,
	lockOrganizationForRelationshipClaims,
	RELATIONSHIP_CLAIMS_METADATA_KEY,
	retractRelationshipClaimExcept,
} from "../utils/relationship-claims.js";
import { applyEventAttributions } from "../utils/entity-link-upsert.js";
import { ensureResourceEntityType } from "./access-graph.js";
import { EDGE_SOURCE_MANUAL } from "../utils/relationship-validation";
import { aclSourceFor, channelReadIdentityFor } from "./sources.js";

export const ABOUT_RELATIONSHIP_SLUG = "about";

export interface ChannelAboutMetadata {
	connection_id: string;
	channel_key: string;
}

/** Find-or-create the org-scoped `about` relationship type. */
export async function ensureAboutRelationshipType(
	organizationId: string,
	sql: DbClient = getDb(),
): Promise<number> {
	const existing = await findAboutRelationshipTypeId(organizationId, sql);
	if (existing !== null) return existing;

	const inserted = await sql<{ id: number }>`
	    INSERT INTO entity_relationship_types
	      (slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at)
	    VALUES
	      (${ABOUT_RELATIONSHIP_SLUG}, 'About', 'A chat channel is about a business entity',
	       ${organizationId}, false, NULL, current_timestamp, current_timestamp)
	    ON CONFLICT (organization_id, slug) WHERE status = 'active'
	    DO NOTHING
	    RETURNING id
	  `;
	if (inserted[0]) return Number(inserted[0].id);

	const raced = await findAboutRelationshipTypeId(organizationId, sql);
	if (raced !== null) return raced;
	throw new Error("Failed to initialize about relationship type");
}

async function findAboutRelationshipTypeId(
	organizationId: string,
	sql: DbClient,
): Promise<number | null> {
	const rows = await sql<{ id: number }>`
    SELECT id
    FROM entity_relationship_types
    WHERE organization_id = ${organizationId}
      AND slug = ${ABOUT_RELATIONSHIP_SLUG}
      AND status = 'active'
      AND deleted_at IS NULL
    LIMIT 1
  `;
	return rows[0] ? Number(rows[0].id) : null;
}

/** Team-scoped resource key + identity namespace for a chat channel.
 *
 * Connector-agnostic: a connector that registers a `ChannelReadIdentity`
 * contributes both its channel identity namespace and the exact team-scoped key
 * construction the ACL sync writes, so this names no platform. Connectors with
 * no registered chat gate fall back to the generic `chat_channel_id` form. */
export function channelResourceIdentity(
	connectorKey: string,
	teamId: string | null | undefined,
	channelId: string,
): { namespace: string; key: string } {
	const bare = channelId.includes(":")
		? channelId.slice(channelId.indexOf(":") + 1)
		: channelId;
	const readIdentity = channelReadIdentityFor(connectorKey);
	const key = readIdentity?.buildChannelKey(teamId, bare);
	if (readIdentity && key) {
		return { namespace: readIdentity.channelNamespace, key };
	}
	const team = teamId?.trim() || "";
	return {
		namespace: "chat_channel_id",
		key: `${connectorKey}:${team}:${bare}`.toUpperCase(),
	};
}

/**
 * Ensure a channel resource entity exists (eager, before ACL sync). Returns the
 * entity id, or null when the key cannot be formed (e.g. a chat connector whose
 * team-scoped key needs a team id that wasn't supplied).
 */
export async function ensureChannelResourceEntity(opts: {
	organizationId: string;
	connectorKey: string;
	teamId: string | null | undefined;
	channelId: string;
	displayName?: string | null;
	sql?: DbClient;
}): Promise<number | null> {
	const sql = opts.sql ?? getDb();
	const bare = opts.channelId.includes(":")
		? opts.channelId.slice(opts.channelId.indexOf(":") + 1)
		: opts.channelId;
	// A registered chat connector's key construction can refuse (return null) when
	// its team-scoped key can't be formed — bail rather than materialize a bad
	// resource under the generic fallback namespace.
	const readIdentity = channelReadIdentityFor(opts.connectorKey);
	if (readIdentity && readIdentity.buildChannelKey(opts.teamId, bare) === null) {
		return null;
	}
	// Connector must register an ACL source; otherwise there is no resource to
	// materialize.
	const aclSource = aclSourceFor(opts.connectorKey);
	if (!aclSource) return null;

	const { namespace, key } = channelResourceIdentity(
		opts.connectorKey,
		opts.teamId,
		opts.channelId,
	);
	// `sql`, never `getDb()` — the caller may have handed us its transaction, and
	// a pooled query inside one starves the pool (#2818).
	await ensureResourceEntityType(sql, opts.organizationId);

	const resolved = await applyEventAttributions(
		{
			connectorKey: opts.connectorKey,
			orgId: opts.organizationId,
			items: [
				{
					origin_type: "channel_about",
					metadata: {
						resource_key: key,
						resource_name: opts.displayName ?? key,
					},
				},
			],
			rules: {
				channel_about: [
					{
						role: "about",
						entityType: ACL_RESOURCE_TYPE_SLUG,
						autoCreate: true,
						titlePath: "metadata.resource_name",
						identities: [
							{
								namespace,
								eventPath: "metadata.resource_key",
								primary: true,
							},
						],
					},
				],
			},
		},
		sql,
	);
	const ids = resolved.entityIdsByItem.get(0);
	return ids?.[0] ?? null;
}

/**
 * Take ownership of one channel's `about` edges: create what is missing and
 * add this connection's claim to what already exists.
 *
 * The claim payload is per-channel (it carries `channel_key`), so this is one
 * batch per channel rather than one for the whole sync.
 */
async function upsertAboutEdges(opts: {
	organizationId: string;
	fromChannelEntityId: number;
	toBusinessEntityIds: number[];
	source: string;
	userId: string | null | undefined;
	typeId: number;
	claimKey: string;
	claim: ChannelAboutMetadata;
	sql: DbClient;
}): Promise<number[]> {
	// The partial conflict target only matches live rows; a tombstoned triple
	// therefore gets a fresh live row, exactly as this path did before.
	return upsertEdges({
		db: opts.sql,
		organizationId: opts.organizationId,
		relationshipTypeId: opts.typeId,
		pairs: opts.toBusinessEntityIds.map((toBusinessEntityId) => ({
			fromEntityId: opts.fromChannelEntityId,
			toEntityId: toBusinessEntityId,
		})),
		source: opts.source,
		confidence: 1.0,
		createdBy: opts.userId ?? null,
		claimKey: opts.claimKey,
		claim: opts.claim,
		onConflict: 'update',
	});
}

/** Replace manual `about` edges for one channel, taking ownership of desired pairs. */
export async function setManualChannelAboutEdges(opts: {
	organizationId: string;
	connectionId: number;
	connectorKey: string;
	teamId: string | null | undefined;
	channelId: string;
	aboutEntityIds: number[];
	userId?: string | null;
	sql?: DbClient;
}): Promise<void> {
	const db = opts.sql ?? getDb();
	await withEntityWriteTransaction(db, async (sql) => {
		await lockOrganizationForRelationshipClaims(sql, opts.organizationId);
		await lockLiveConnectionForRelationshipClaims(
			sql,
			opts.organizationId,
			opts.connectionId,
		);

		const typeId = await ensureAboutRelationshipType(opts.organizationId, sql);
		const connectionId = String(opts.connectionId);
		const { key } = channelResourceIdentity(
			opts.connectorKey,
			opts.teamId,
			opts.channelId,
		);
		const channelEntityId = await ensureChannelResourceEntity({
			organizationId: opts.organizationId,
			connectorKey: opts.connectorKey,
			teamId: opts.teamId,
			channelId: opts.channelId,
			sql,
		});
		if (channelEntityId === null) {
			throw new Error("Channel entity could not be resolved for this channel");
		}

		const metadata: ChannelAboutMetadata = {
			connection_id: connectionId,
			channel_key: key,
		};
		const claimKey = connectionRelationshipClaimKey(
			connectionId,
			`config:channel-about:${key}`,
		);
		const keepRelationshipIds = await upsertAboutEdges({
			organizationId: opts.organizationId,
			fromChannelEntityId: channelEntityId,
			toBusinessEntityIds: opts.aboutEntityIds,
			source: EDGE_SOURCE_MANUAL,
			userId: opts.userId,
			typeId,
			claimKey,
			claim: metadata,
			sql,
		});
		await retractRelationshipClaimExcept(sql, {
			organizationId: opts.organizationId,
			claimKey,
			keepRelationshipIds: new Set(keepRelationshipIds),
		});
	});
}

/** Business entity ids linked to a channel via `about` (any source). */
export async function listChannelAboutEntityIds(opts: {
	organizationId: string;
	channelEntityId: number;
	sql?: DbClient;
}): Promise<number[]> {
	const sql = opts.sql ?? getDb();
	const typeId = await findAboutRelationshipTypeId(opts.organizationId, sql);
	if (typeId === null) return [];
	const rows = await sql<{ to_entity_id: number }>`
    SELECT r.to_entity_id
    FROM entity_relationships r
    WHERE r.organization_id = ${opts.organizationId}
      AND r.from_entity_id = ${opts.channelEntityId}
      AND r.relationship_type_id = ${typeId}
      AND r.deleted_at IS NULL
    ORDER BY r.to_entity_id
  `;
	return rows.map((r) => Number(r.to_entity_id));
}

/** Reverse lookup: channel resource entities with an `about` edge to a business entity. */
export async function listChannelEntitiesAboutBusinessEntity(opts: {
	organizationId: string;
	businessEntityId: number;
	sql?: DbClient;
}): Promise<
	Array<{
		channelEntityId: number;
		channelName: string | null;
		connectionId: string | null;
		channelKey: string | null;
	}>
> {
	const sql = opts.sql ?? getDb();
	const typeId = await findAboutRelationshipTypeId(opts.organizationId, sql);
	if (typeId === null) return [];
	const rows = await sql<{
		channel_entity_id: number;
		channel_name: string | null;
		connection_id: string | null;
		channel_key: string | null;
	}>`
    SELECT
      r.from_entity_id AS channel_entity_id,
      e.name AS channel_name,
      claim.value->>'connection_id' AS connection_id,
      claim.value->>'channel_key' AS channel_key
    FROM entity_relationships r
    CROSS JOIN LATERAL jsonb_each(
      COALESCE(r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}, '{}'::jsonb)
    ) AS claim(key, value)
    JOIN entities e
      ON e.id = r.from_entity_id
     AND e.organization_id = r.organization_id
     AND e.deleted_at IS NULL
    WHERE r.organization_id = ${opts.organizationId}
      AND r.to_entity_id = ${opts.businessEntityId}
      AND r.relationship_type_id = ${typeId}
      AND r.deleted_at IS NULL
      AND claim.value ? 'connection_id'
      AND claim.value ? 'channel_key'
      AND claim.key =
        'connection:' || (claim.value->>'connection_id') ||
        ':config:channel-about:' || (claim.value->>'channel_key')
    ORDER BY e.name NULLS LAST, r.from_entity_id, connection_id
  `;
	return rows.map((r) => ({
		channelEntityId: Number(r.channel_entity_id),
		channelName: r.channel_name,
		connectionId: r.connection_id,
		channelKey: r.channel_key,
	}));
}

function channelAboutClaimExistsSql(
	relationshipAlias: string,
	connectionIdExpr: string,
	channelKeyExpr?: string,
): string {
	const channelMatch = channelKeyExpr
		? `AND claim.value->>'channel_key' = ${channelKeyExpr}`
		: "";
	return `EXISTS (
    SELECT 1
    FROM jsonb_each(
      COALESCE(
        ${relationshipAlias}.metadata -> '${RELATIONSHIP_CLAIMS_METADATA_KEY}',
        '{}'::jsonb
      )
    ) AS claim(key, value)
    WHERE claim.value->>'connection_id' = (${connectionIdExpr})::text
      AND claim.key =
        'connection:' || (${connectionIdExpr})::text ||
        ':config:channel-about:' || (claim.value->>'channel_key')
      ${channelMatch}
  )`;
}

/** Channel key stored in `about` claim metadata for a channel feed row.
 *
 * The team half is the channel's CONCRETE workspace, taken from the streaming
 * feed's Automation subscription team — the SAME real team the
 * about-edge writer keyed on. For a Grid org-wide install the connection's
 * `external_tenant_id` is the enterprise `E…`, so it must NOT be used as the
 * team; the subscription holds the real `T…`. The `external_tenant_id` fallback
 * supports connectors whose tenant identity is their workspace. A not-yet-healed
 * Grid subscription has no matching about edge until its concrete team is known.
 * The subscription channel id equals feed_key, so the correlation is exact. */
export function channelFeedChannelKeyExpr(
	feedAlias = "f",
	connectionAlias = "c",
): string {
	return `UPPER(
    COALESCE(
      (
        SELECT subscription.trigger_team_id
        FROM automation_message_subscriptions subscription
        WHERE subscription.organization_id = ${feedAlias}.organization_id
          AND subscription.connection_id = ${feedAlias}.connection_id
          AND subscription.channel_id = ${feedAlias}.feed_key
          AND subscription.trigger_team_id IS NOT NULL
        LIMIT 1
      ),
      ${connectionAlias}.external_tenant_id,
      ''
    ) || ':' ||
    CASE
      WHEN ${feedAlias}.feed_key LIKE '%:%'
        THEN split_part(${feedAlias}.feed_key, ':', 2)
      ELSE ${feedAlias}.feed_key
    END
  )`;
}

/**
 * True when a feed row is business-linked to `entityIdExpr` via `entity_ids`
 * tag or a streaming channel's `about` edge.
 */
export function feedLinkedToBusinessEntitySql(
	entityIdExpr: string,
	feedAlias = "f",
	connectionAlias = "c",
	orgIdExpr?: string,
): string {
	const org = orgIdExpr ?? `${feedAlias}.organization_id`;
	const tagMatch = `${entityIdExpr} = ANY(${feedAlias}.entity_ids)`;
	const claimMatch = channelAboutClaimExistsSql(
		"r",
		`${feedAlias}.connection_id`,
		channelFeedChannelKeyExpr(feedAlias, connectionAlias),
	);
	const aboutMatch = `(
    ${feedAlias}.config ->> 'store' = 'channel_messages'
    AND EXISTS (
      SELECT 1
      FROM entity_relationships r
      JOIN entity_relationship_types rt
        ON rt.id = r.relationship_type_id
       AND rt.organization_id = r.organization_id
       AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
       AND rt.status = 'active'
      WHERE r.organization_id = ${org}
        AND r.to_entity_id = ${entityIdExpr}
        AND r.deleted_at IS NULL
        AND ${claimMatch}
    )
  )`;
	return `(${tagMatch} OR ${aboutMatch})`;
}

/** Business-entity ids linked to any channel on a connection via `about`. */
export function connectionAboutBusinessEntityIdsSubquery(
	connectionAlias = "c",
	orgIdExpr?: string,
): string {
	const org = orgIdExpr ?? `${connectionAlias}.organization_id`;
	const claimMatch = channelAboutClaimExistsSql(
		"r",
		`${connectionAlias}.id`,
	);
	return `(
    SELECT r.to_entity_id
    FROM entity_relationships r
    JOIN entity_relationship_types rt
      ON rt.id = r.relationship_type_id
     AND rt.organization_id = r.organization_id
     AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
     AND rt.status = 'active'
    WHERE r.organization_id = ${org}
      AND r.deleted_at IS NULL
      AND ${claimMatch}
  )`;
}

/** Entity ids whose names should appear in a connection's `entity_names`. */
export function connectionLinkedEntityIdsSql(connectionAlias = "c"): string {
	return `(
    SELECT unnest(${connectionAlias}.entity_ids)
    UNION
    SELECT unnest(f.entity_ids)
    FROM feeds f
    WHERE f.connection_id = ${connectionAlias}.id
      AND f.deleted_at IS NULL
    UNION
    ${connectionAboutBusinessEntityIdsSubquery(connectionAlias)}
  )`;
}

/** True when a connection is business-linked to `entityIdExpr` (tag or about). */
export function connectionLinkedToBusinessEntitySql(
	entityIdExpr: string,
	connectionAlias = "c",
	orgIdExpr?: string,
): string {
	const org = orgIdExpr ?? `${connectionAlias}.organization_id`;
	const claimMatch = channelAboutClaimExistsSql(
		"r",
		`${connectionAlias}.id`,
	);
	return `(
    ${entityIdExpr} = ANY(${connectionAlias}.entity_ids)
    OR EXISTS (
      SELECT 1
      FROM feeds f
      WHERE f.connection_id = ${connectionAlias}.id
        AND f.deleted_at IS NULL
        AND ${entityIdExpr} = ANY(f.entity_ids)
    )
    OR EXISTS (
      SELECT 1
      FROM entity_relationships r
      JOIN entity_relationship_types rt
        ON rt.id = r.relationship_type_id
       AND rt.organization_id = r.organization_id
       AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
       AND rt.status = 'active'
      WHERE r.organization_id = ${org}
        AND r.to_entity_id = ${entityIdExpr}
        AND r.deleted_at IS NULL
        AND ${claimMatch}
    )
  )`;
}

/** Entity ids whose names should appear on a feed's `entity_names`. */
export function feedLinkedEntityIdsSql(
	feedAlias = "f",
	connectionAlias = "c",
): string {
	const claimMatch = channelAboutClaimExistsSql(
		"r",
		`${feedAlias}.connection_id`,
		channelFeedChannelKeyExpr(feedAlias, connectionAlias),
	);
	return `(
    SELECT unnest(${feedAlias}.entity_ids)
    UNION
    SELECT r.to_entity_id
    FROM entity_relationships r
    JOIN entity_relationship_types rt
      ON rt.id = r.relationship_type_id
     AND rt.organization_id = r.organization_id
     AND rt.slug = '${ABOUT_RELATIONSHIP_SLUG}'
     AND rt.status = 'active'
    WHERE ${feedAlias}.config ->> 'store' = 'channel_messages'
      AND r.organization_id = ${feedAlias}.organization_id
      AND r.deleted_at IS NULL
      AND ${claimMatch}
  )`;
}
