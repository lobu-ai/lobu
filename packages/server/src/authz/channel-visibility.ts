/**
 * The chat channel visibility gate — "which channels may THIS requester read?"
 *
 * Reads the `member_of` edges the chat ACL sync materializes (via the generic
 * access-graph engine): a requester may recall a channel's transcript iff their
 * `$member` entity is
 * `member_of` that channel. This is the two-sided, fail-closed gate from the
 * authz program (docs/plans/authz-acl-permission-program.md §4) applied to chat
 * recall: the existing per-agent channel fence is one side (the agent only sees
 * its bound channels); this is the other (the user only sees channels they
 * belong to). The two INTERSECT — an agent acting for a user never widens past
 * either bound.
 *
 * A connection without source permission state is readable only by its recorded
 * owner (`connections.created_by`), still intersected with the agent's bindings.
 * Missing ownership denies access. Once an ACL state row exists, anything
 * short of full+fresh — partial/none support, stale/failed freshness, or a fresh
 * row aged past the window — fails CLOSED rather than passing through, so a
 * half-built or stalled graph can never mis-enforce.
 *
 * Fail-closed: for an ENFORCED connection, a channel is dropped unless the
 * requester is provably a member. An unresolved requester (anonymous/headless,
 * or no `$member` in this org) sees NONE of an enforced connection's channels.
 */

import { type DbClient, pgTextArray } from '../db/client.js';
import { getConnectionEnforcement, rowToChannelKey } from './acl-state.js';
import { ownedChatConnectionsSelectSql } from './connection-visibility.js';
import { CHANNEL_READ_IDENTITIES, channelReadIdentityFor } from './sources.js';

/** A bound channel the gate decides on. Mirrors the fields `resolveBoundChannelRows`
 * returns (`id` is the connection id). */
export interface GatedChannelRow {
  /** Connection id that owns the channel subscription. */
  id: string;
  platform: string;
  /** As projected from the Automation — may be platform-prefixed (`slack:C…`) or bare. */
  channel_id: string;
  /** Workspace/tenant id (Slack `T…`); required to form the team-scoped key. */
  team_id: string | null;
}

/** A (platform, team) pair whose connection is actively enforcing — used to
 * resolve an in-chat requester by that platform's team-scoped user key. */
interface EnforcingTenant {
  platform: string;
  teamId: string;
}

/**
 * Resolve the requester's `$member` entity id in a SPECIFIC org. Restricted to
 * the auth-server signup claim (`namespace='auth_user_id'`,
 * `source_connector='auth:signup'`) so a user-supplied identity row can't hijack
 * the lookup — the same guard `resolveTenantMember` uses, but scoped to the org
 * the read happens in rather than the user's personal org. Returns null when the
 * user has no `$member` here (→ fail closed for enforced connections).
 */
export async function resolveRequesterMemberEntityId(
  sql: DbClient,
  organizationId: string,
  userId: string | null,
): Promise<number | null> {
  if (!userId) return null;
  const rows = await sql<{ entity_id: number }>`
		SELECT e.id AS entity_id
		FROM entity_identities ei
		JOIN entities e
		  ON e.id = ei.entity_id
		 AND e.organization_id = ei.organization_id
		 AND e.deleted_at IS NULL
		JOIN entity_types et
		  ON et.id = e.entity_type_id
		 AND et.organization_id = e.organization_id
		 AND et.slug = '$member'
		WHERE ei.organization_id = ${organizationId}
		  AND ei.namespace = 'auth_user_id'
		  AND ei.identifier = ${userId}
		  AND ei.scope_key IS NULL
		  AND ei.deleted_at IS NULL
		  AND ei.source_connector = 'auth:signup'
		LIMIT 1
	`;
  return rows.length > 0 ? Number(rows[0].entity_id) : null;
}

/**
 * Fallback requester resolution for someone talking to the bot INSIDE a chat
 * platform, where the only id we have is their platform user id (the message
 * author), not an `auth_user_id`. For each enforcing (platform, team) tenant,
 * builds that platform's team-scoped user key (Slack: `T…:U…` under
 * `slack_user_id`) via the channel-read-identity registry and looks it up.
 * Without this, an in-chat requester always misses the auth lookup and fails
 * closed even on channels they belong to.
 *
 * Safe against hijack the same way the auth path is: the platform user-id claim
 * is only ever written server-side (by the graph builder / login promotion),
 * never from user-supplied input, so resolving on it can't be forged. Returns
 * the first entity that owns any such claim, or null.
 */
async function resolveRequesterByChatUserId(
  sql: DbClient,
  organizationId: string,
  userId: string | null,
  tenants: EnforcingTenant[],
): Promise<number | null> {
  if (!userId || tenants.length === 0) return null;
  // Group the team-scoped user keys by their namespace (a platform may share a
  // namespace across teams), so one indexed lookup covers each namespace.
  const keysByNamespace = new Map<string, Set<string>>();
  for (const { platform, teamId } of tenants) {
    const identity = channelReadIdentityFor(platform);
    if (!identity) continue;
    const key = identity.buildUserKey(teamId, userId);
    if (!key) continue;
    let set = keysByNamespace.get(identity.userNamespace);
    if (!set) {
      set = new Set<string>();
      keysByNamespace.set(identity.userNamespace, set);
    }
    set.add(key);
  }
  for (const [namespace, keys] of keysByNamespace) {
    const rows = await sql<{ entity_id: number }>`
			SELECT ei.entity_id
			FROM entity_identities ei
			JOIN entities e
			  ON e.id = ei.entity_id
			 AND e.organization_id = ei.organization_id
			 AND e.deleted_at IS NULL
			WHERE ei.organization_id = ${organizationId}
			  AND ei.namespace = ${namespace}
			  AND ei.identifier = ANY(${pgTextArray([...keys])}::text[])
			  AND ei.scope_key IS NULL
			  AND ei.deleted_at IS NULL
			LIMIT 1
		`;
    if (rows.length > 0) return Number(rows[0].entity_id);
  }
  return null;
}

/**
 * Resolve the requester to a `$member` entity id, combining BOTH paths the
 * authz program supports: prefer the auth-server signup claim (web/app sign-in),
 * then fall back to the platform's team-scoped user claim for someone talking to
 * the bot INSIDE a chat platform (whose only id is a platform user id).
 * `enforcingTenants` scopes the chat fallback to the (platform, team) tenants
 * whose connections are actually enforcing. Returns null when neither resolves
 * (→ fail closed).
 *
 * The single resolver shared by the gate ({@link filterChannelsForRequester})
 * and the audience read's "you" highlight, so the two never disagree on who the
 * requester is.
 */
export async function resolveRequesterMember(
  sql: DbClient,
  organizationId: string,
  userId: string | null,
  enforcingTenants: EnforcingTenant[],
): Promise<number | null> {
  if (!userId) return null;
  const byAuth = await resolveRequesterMemberEntityId(sql, organizationId, userId);
  if (byAuth !== null) return byAuth;
  return resolveRequesterByChatUserId(sql, organizationId, userId, enforcingTenants);
}

/** Every registered chat-channel identity namespace — the channel resource key
 * namespaces the member-visibility read unions over. */
const CHANNEL_KEY_NAMESPACES: string[] = [
  ...new Set(CHANNEL_READ_IDENTITIES.map((c) => c.channelNamespace)),
];

/**
 * The team-scoped channel keys the member can read, via `member_of` edges to
 * `$resource` entities carrying any registered chat-channel identity (Slack:
 * `slack_channel_id` = `T…:C…`). Unions across every registered chat platform's
 * channel namespace so a member spanning platforms sees all their channels.
 */
export async function getVisibleChannelKeysForMember(
  sql: DbClient,
  organizationId: string,
  memberEntityId: number,
): Promise<Set<string>> {
  if (CHANNEL_KEY_NAMESPACES.length === 0) return new Set();
  const rows = await sql<{ channel_key: string }>`
		SELECT ei.identifier AS channel_key
		FROM entity_relationships r
		JOIN entity_relationship_types rt
		  ON rt.id = r.relationship_type_id
		 AND rt.organization_id = r.organization_id
		 AND rt.slug = 'member_of'
		JOIN entity_identities ei
		  ON ei.entity_id = r.to_entity_id
		 AND ei.organization_id = r.organization_id
		 AND ei.namespace = ANY(${pgTextArray(CHANNEL_KEY_NAMESPACES)}::text[])
		 AND ei.scope_key IS NULL
		 AND ei.deleted_at IS NULL
		WHERE r.organization_id = ${organizationId}
		  AND r.from_entity_id = ${memberEntityId}
		  AND r.deleted_at IS NULL
	`;
  return new Set(rows.map((r) => String(r.channel_key)));
}

/**
 * Filter bound channels down to what the requester may actually read. Connections
 * without source permissions require explicit connection ownership. Channels on
 * enforced connections survive only when the requester is provably `member_of`
 * them. An enforced channel with no team id, or an unresolvable requester, is
 * dropped.
 *
 * Returns the surviving rows (same objects, filtered) — the caller keeps its
 * existing per-channel query shape, just over a possibly-smaller set.
 */
export async function filterChannelsForRequester<T extends GatedChannelRow>(
  sql: DbClient,
  params: {
    organizationId: string;
    userId: string | null;
    rows: T[];
  },
): Promise<T[]> {
  const { organizationId, userId, rows } = params;
  if (rows.length === 0) return rows;

  const states = await getConnectionEnforcement(
    sql,
    organizationId,
    rows.map((r) => r.id),
  );
  const ownedRows = userId && rows.some((r) => !states.has(r.id))
    ? await sql.unsafe<{ connection_id: string }>(
      ownedChatConnectionsSelectSql('$1::text', '$2::text'),
      [organizationId, userId],
    )
    : [];
  const ownedConnections = new Set(ownedRows.map((r) => r.connection_id));

  // Only resolve the requester's membership when at least one connection is
  // actively enforcing (full+fresh). Onboarded-but-stale connections fail closed
  // regardless of who is asking, so they need no membership lookup.
  const anyEnforcing = [...states.values()].some((s) => s.status === "enforced");
  const seenTenant = new Set<string>();
  const enforcingTenants: EnforcingTenant[] = [];
  for (const r of rows) {
    if (states.get(r.id)?.status !== "enforced" || !r.team_id) continue;
    const dedupe = `${r.platform}\u0000${r.team_id}`;
    if (seenTenant.has(dedupe)) continue;
    seenTenant.add(dedupe);
    enforcingTenants.push({ platform: r.platform, teamId: r.team_id });
  }
  const memberEntityId = anyEnforcing
    ? await resolveRequesterMember(sql, organizationId, userId, enforcingTenants)
    : null;
  const visibleKeys =
    memberEntityId === null
      ? new Set<string>()
      : await getVisibleChannelKeysForMember(sql, organizationId, memberEntityId);

  return rows.filter((r) => {
    const state = states.get(r.id);
    if (!state) return ownedConnections.has(r.id);
    if (state.status !== "enforced") return false; // stale/unsupported → fail closed
    const key = rowToChannelKey(r);
    if (key === null) return false; // no team id → can't form the key → fail closed
    return visibleKeys.has(key);
  });
}
