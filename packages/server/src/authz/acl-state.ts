/**
 * Shared ACL-enforcement-state helpers — used by BOTH read gates (the Slack
 * channel gate `./channel-visibility` and the generic resource gate
 * `./resource-visibility`) AND the audience read (`./audience`) so the "is this
 * connection enforcing right now?" rule and the team-scoped channel key live in
 * one place and cannot drift between them.
 */

import { type DbClient, pgTextArray } from "../db/client.js";
import { stripPlatformPrefix } from "../gateway/channels/bound-channels.js";
import { channelReadIdentityFor } from "./sources.js";

/**
 * How long a `fresh` ACL graph stays trusted without a re-sync. The background
 * sync re-stamps `last_synced_at`; if it stops, a connection's graph ages past
 * this window and the gate stops trusting it — failing closed rather than
 * serving stale membership. Generous vs. the ~15-min sync cadence so a transient
 * hiccup never blinks recall off.
 */
export const ACL_STALE_AFTER_MINUTES = 60;

/**
 * SQL subquery (no leading/trailing space) selecting the `connection_id`s that
 * are ACL-enforced right now: `acl_support='full'` AND `freshness_state='fresh'`
 * AND synced within {@link ACL_STALE_AFTER_MINUTES}. `orgParam` is an already-bound
 * `$N::text` placeholder. Returns the bare `SELECT …` (caller wraps in IN/NOT IN).
 */
export function enforcedConnectionsSelectSql(orgParam: string): string {
  return `SELECT connection_id FROM public.authz_source_acl_state
    WHERE organization_id = ${orgParam}
      AND acl_support = 'full'
      AND freshness_state = 'fresh'
      AND last_synced_at IS NOT NULL
      AND last_synced_at >= current_timestamp - make_interval(mins => ${ACL_STALE_AFTER_MINUTES})`;
}

/**
 * Per-connection enforcement state, the single shape BOTH the gate
 * (`./channel-visibility`) and the audience read (`./audience`) project from the
 * `authz_source_acl_state` row:
 *  - `enforced`    — `acl_support='full'` AND `freshness_state='fresh'` AND synced
 *                    within {@link ACL_STALE_AFTER_MINUTES}; recall is membership-gated.
 *  - `stale`       — onboarded (a row exists) but not currently enforcing
 *                    (partial/stale/aged-out) → fails closed.
 *  - `not-graphed` — no row at all (a connection ABSENT from
 *                    {@link getConnectionEnforcement}'s map); legacy per-agent fence.
 */
export type EnforcementStatus = "enforced" | "stale" | "not-graphed";

export interface ChannelEnforcement {
  status: EnforcementStatus;
  aclSupport: string | null;
  freshnessState: string | null;
  lastSyncedAt: string | null;
}

/** The state for a connection with no `authz_source_acl_state` row. */
export const NOT_GRAPHED: ChannelEnforcement = {
  status: "not-graphed",
  aclSupport: null,
  freshnessState: null,
  lastSyncedAt: null,
};

/**
 * Resolve each connection's enforcement state. A connection ABSENT from the
 * returned map has no `authz_source_acl_state` row — it was never graphed, so it
 * keeps the legacy per-agent fence ({@link NOT_GRAPHED}). A connection PRESENT is
 * either `enforced` (full+fresh+in-window) or `stale` (anything else, which fails
 * closed). This is the ONE place the enforce predicate is evaluated for the
 * parameterized read paths, so the gate and the audience can never disagree.
 */
export async function getConnectionEnforcement(
  sql: DbClient,
  organizationId: string,
  connectionIds: string[],
): Promise<Map<string, ChannelEnforcement>> {
  const ids = [...new Set(connectionIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await sql<{
    connection_id: string;
    acl_support: string | null;
    freshness_state: string | null;
    last_synced_at: Date | null;
    enforce: boolean;
  }>`
    SELECT
      connection_id,
      acl_support,
      freshness_state,
      last_synced_at,
      (
        acl_support = 'full'
        AND freshness_state = 'fresh'
        AND last_synced_at IS NOT NULL
        AND last_synced_at >= current_timestamp - make_interval(mins => ${ACL_STALE_AFTER_MINUTES})
      ) AS enforce
    FROM authz_source_acl_state
    WHERE organization_id = ${organizationId}
      AND connection_id = ANY(${pgTextArray(ids)}::text[])
  `;
  const out = new Map<string, ChannelEnforcement>();
  for (const r of rows) {
    out.set(String(r.connection_id), {
      status: r.enforce === true ? "enforced" : "stale",
      aclSupport: r.acl_support ?? null,
      freshnessState: r.freshness_state ?? null,
      lastSyncedAt: r.last_synced_at
        ? new Date(r.last_synced_at).toISOString()
        : null,
    });
  }
  return out;
}

/** A row carrying the fields needed to form a team-scoped channel key. */
export interface ChannelKeyRow {
  platform: string;
  /** As stored on the binding — may be platform-prefixed (`slack:C…`) or bare. */
  channel_id: string;
  /** Workspace/tenant id (Slack `T…`); required to form the key. */
  team_id: string | null;
}

/**
 * The team-scoped channel key (`T…:C…`) for a bound row, or null when the row's
 * platform has no enforced channel gate or has no team id (can't be keyed → the
 * gate drops it fail-closed, the audience reports an empty member set). The ONE
 * definition shared by the gate and the audience so a key-format change can't
 * desync them; the platform's key model comes from the channel-read-identity
 * registry so this file names no connector.
 */
export function rowToChannelKey(row: ChannelKeyRow): string | null {
  const identity = channelReadIdentityFor(row.platform);
  if (!identity) return null;
  return identity.buildChannelKey(
    row.team_id,
    stripPlatformPrefix(row.platform, row.channel_id),
  );
}
