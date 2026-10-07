/**
 * Slack channel-membership SYNC — the production path that populates the authz
 * graph the visibility gate reads.
 *
 * Per Slack connection: resolve the channels it actually captures
 * (`resolveBoundChannelRows` — the same source of truth the gate filters), fetch
 * each channel's current membership from Slack (`conversations.members`), and
 * hand the normalized resources to `buildAccessGraph`, which materializes the
 * `member_of` edges and reconciles departures. The sync stamps the connection
 * `full`/`fresh` after all workspaces complete. A periodic tick (`runSlackAclSyncTick`, wired in
 * `scheduled/jobs.ts`) re-runs this so membership changes (joins/leaves) converge
 * within the sync cadence, and the gate's freshness window fails the connection
 * closed if the tick ever stops.
 *
 * Fail-closed on error: the sync is ATOMIC per connection. If ANY channel's
 * membership fetch throws (Slack outage, bot removed, missing token), we do NOT
 * build a half-synced graph — we mark the connection's ACL state `failed` so the
 * gate drops all its channels until a later tick succeeds. We only DOWNGRADE an
 * existing row; a connection that has never been graphed remains readable only
 * by its recorded connection owner.
 */

import { createLogger } from '@lobu/core';
import { getDb } from '../db/client.js';
import {
  resolveBoundChannelRows,
  stripPlatformPrefix,
} from '../gateway/channels/bound-channels.js';
import { createSlackWebApi, type SlackWebApi } from '../gateway/connections/slack-web.js';
import { resolveSecretValue } from '../gateway/secrets/index.js';
import type { SecretStore } from '../gateway/secrets/index.js';
import type { CoreServices } from '../gateway/services/core-services.js';
import {
  runtimeConnectionIdToSlug,
  slugToRuntimeConnectionId,
} from '../lobu/stores/connections-projection.js';
import {
  getSlackInstallById,
  getSlackInstallByTeamId,
} from '../lobu/stores/slack-installations.js';
import { orgContext } from '../lobu/stores/org-context.js';
import {
  type SlackChannelInput,
  slackAclSource,
  slackChannelsToResources,
} from '@lobu/connectors/slack-identity';
import {
  clearConnectionAclError,
  markConnectionAclFailed,
} from './acl-observability.js';
import { buildAccessGraph, markAclFresh } from './access-graph.js';
import { bumpAclGeneration, captureAclSyncFence } from './acl-generation.js';
import { withAclConnectionSyncLock } from './acl-sync-lock.js';

const logger = createLogger('slack-acl-sync');

/**
 * Fail closed immediately when Slack reports that a member left a channel.
 * The periodic ACL sync remains the sole graph reconciler; this only flips the
 * graph out of the trusted `fresh` state until that sync rebuilds it.
 *
 * The row is UPSERTED rather than updated, because a plain UPDATE loses the
 * first-sync race: a connection that has never been graphed has no row, the
 * revocation matches nothing, and the sync already holding a pre-departure
 * snapshot then INSERTs `fresh` — blessing exactly the membership Slack just
 * told us was gone. Writing the stale row fails closed immediately; bumping the
 * org generation in the same transaction prevents that older sync from
 * overwriting or bypassing it.
 *
 * Writing the row DOES change enforcement, and that is the point: any existing
 * `authz_source_acl_state` row moves the connection from `not-graphed`
 * (recorded connection owner only) to `stale`, which fails closed (`acl-state.ts` —
 * "onboarded-but-stale ... must fail closed"). So a first-ever revocation on an
 * ungraphed connection denies its channel recall until the first sync completes,
 * rather than serving a membership Slack has already contradicted. The sentinel
 * is `acl_support = 'none'` so the row records onboarding without claiming a
 * `full` graph it does not have; an existing row keeps its own `acl_support`.
 */
export async function invalidateSlackConnectionAcl(params: {
  organizationId: string;
  connectionId: string;
}): Promise<{ aclSupport: string }> {
  // `clock_timestamp()`, not transaction-start `current_timestamp`, preserves
  // the secondary ordering fence between syncs in the same generation. The
  // `markAclFresh` generation comparison handles commit visibility across
  // invalidations.
  // The stale write and the generation bump commit together: a sync observing
  // one without the other would see an inconsistent invalidation.
  const rows = await getDb().begin(async (tx) => {
    await bumpAclGeneration(tx, params.organizationId);
    const stamped = await tx<{ acl_support: string }>`
		INSERT INTO authz_source_acl_state
			(organization_id, connection_id, acl_support, freshness_state, updated_at)
		VALUES (${params.organizationId}, ${params.connectionId}, 'none', 'stale', clock_timestamp())
		ON CONFLICT (organization_id, connection_id)
		DO UPDATE SET freshness_state = 'stale', updated_at = clock_timestamp()
		RETURNING acl_support
	`;
    return stamped;
  });
  // The upsert always yields a row, so a boolean "did it work" would be a
  // constant. Report the resulting support level instead — 'full' means an
  // already-enforcing connection went stale, 'none' means this revocation is
  // what onboarded it.
  return { aclSupport: rows[0].acl_support };
}

/** Injectable seams so tests drive the real graph build + gate with a stubbed
 * Slack API and token resolver, and the live tick wires the real ones. */
export interface SlackAclSyncDeps {
  slackWeb: Pick<SlackWebApi, 'conversationMembers' | 'conversationInfo'>;
  /**
   * Resolve the bot IDENTITY for a workspace — its token plus the bot's own
   * Slack user id — or null if none is available (no active install AND no BYO
   * token / unresolvable secret), which is treated fail-closed. The OAuth-install
   * path sources the bot id from the install (stamped at install time). The BYO
   * fallback sources it from the connection's `chatMetadata.botUserId`, which is
   * backfilled lazily at adapter init: if it is still null (pre-first-run window)
   * the bot is NOT filtered out and can transiently gain a `member_of` edge —
   * self-healing on the next sync once the id backfills (a bot id maps to no
   * human requester, so this is audience inflation, never access leakage).
   */
  resolveBotIdentity: (params: {
    organizationId: string;
    teamId: string;
    /**
     * The connection being synced. Lets the resolver fall back to the
     * connection's own BYO bot credentials when the team has no OAuth
     * app-installation — otherwise a BYO Slack connection (active bot, real
     * bindings, no install row) never gets ACL-graphed and its channel memory
     * silently degrades to org scope.
     */
    connectionId: string;
  }) => Promise<{ token: string; botUserId: string | null } | null>;
}

export interface SlackAclSyncResult {
  /** True when every bound Slack channel was fetched and graphed. */
  ok: boolean;
  /**
   * True when another sync already held this connection and this call published
   * nothing. Distinct from `ok: false`: a skip is not a failure and must NOT
   * mark the connection failed, but it is not success either — nothing was
   * reconciled, so the tick must not count it as a completed sync.
   */
  skipped?: boolean;
  teamsSynced: number;
  channelsSynced: number;
}

/**
 * Sync ONE Slack connection's channel-membership graph. Resolves its captured
 * channels, fetches members per channel, and builds the graph (per team). See
 * the file header for the fail-closed contract.
 */
export async function syncSlackConnectionAcl(
  deps: SlackAclSyncDeps,
  params: { connectionId: string; organizationId: string },
): Promise<SlackAclSyncResult> {
  const outcome = await withAclConnectionSyncLock(params.connectionId, () =>
    syncSlackConnectionAclLocked(deps, params),
  );
  if (!outcome.ran) {
    logger.info('Slack ACL sync skipped: another sync holds this connection', {
      organization_id: params.organizationId,
      connection_id: params.connectionId,
    });
    return { ok: false, skipped: true, teamsSynced: 0, channelsSynced: 0 };
  }
  return outcome.value;
}

async function syncSlackConnectionAclLocked(
  deps: SlackAclSyncDeps,
  params: { connectionId: string; organizationId: string },
): Promise<SlackAclSyncResult> {
  const { connectionId, organizationId } = params;
  const sql = getDb();

  const bound = await resolveBoundChannelRows(sql, {
    organizationId,
    connectionId,
  });

  // `resolveBoundChannelRows` narrows bindings to THIS connection (by slug), so
  // every row here already belongs to it — we trust connection_id as the scope,
  // NOT a team-string round-trip. `connTeamId` is only used to guard the BYO
  // multi-workspace case: when the connection's tenant id is itself a WORKSPACE
  // (`T…`), a binding for a DIFFERENT workspace is a stray second-connection row
  // and is dropped (fetched with the wrong token → fail-closed otherwise). When
  // the tenant id is NOT a workspace — a Grid ENTERPRISE (`E…`) org-wide install,
  // whose bindings correctly carry the sibling workspace `T…`, or a preview
  // connection (no teamId) — we accept EVERY real-team binding on the connection
  // and group by the binding's own team. Without this relaxation an org-wide
  // install (connTeamId = E…) drops all its `T…` bindings and silently
  // downgrades to the not-graphed, owner-only path.
  const [conn] = await sql<{ team_id: string | null }>`
		SELECT COALESCE(external_tenant_id, config->'chatMetadata'->>'teamId') AS team_id
		FROM connections
		WHERE slug = ${runtimeConnectionIdToSlug(connectionId)}
		  AND organization_id = ${organizationId}
		  AND credential_mode IS NOT NULL
		  AND deleted_at IS NULL
		LIMIT 1
	`;
  const connTeamId = conn?.team_id ?? null;
  // Is the connection's tenant id itself a concrete workspace? Only then do we
  // enforce workspace equality (BYO foreign-workspace guard). An enterprise `E…`
  // or absent tenant id does NOT constrain the binding team.
  const connScopesWorkspace = /^T[A-Z0-9]+$/i.test(connTeamId ?? '');

  // Only Slack rows that carry a real workspace team can be team-scoped into the
  // graph; a channel with no team id is dropped fail-closed by the gate anyway.
  const slackRows = bound.filter(
    (r) =>
      r.platform.startsWith('slack') &&
      r.team_id &&
      (!connScopesWorkspace || r.team_id === connTeamId),
  );
  if (slackRows.length === 0) {
    return { ok: true, teamsSynced: 0, channelsSynced: 0 };
  }

  // Group channels by workspace/team — one graph build per team.
  const byTeam = new Map<string, string[]>();
  for (const r of slackRows) {
    const channelId = stripPlatformPrefix(r.platform, r.channel_id);
    const list = byTeam.get(r.team_id as string) ?? [];
    list.push(channelId);
    byTeam.set(r.team_id as string, list);
  }

  let teamsSynced = 0;
  let channelsSynced = 0;
  /*
   * One cutoff for the whole sync. The ACL state row is keyed by (org,
   * connection), not by team, so freshness is a single connection-level
   * decision: either no revocation landed after this sync began and the
   * connection may be blessed fresh, or one did and it may not. The cutoff is
   * taken before the FIRST workspace is read, so it covers every workspace's
   * snapshot — a per-team cutoff would let a late team bless membership the
   * revocation had already contradicted for an earlier one.
   */
  const syncFence = await captureAclSyncFence(organizationId, sql);
  try {
    for (const [teamId, channelIds] of byTeam) {
      const identity = await deps.resolveBotIdentity({ organizationId, teamId, connectionId });
      if (!identity) {
        throw new Error(`No bot token for team ${teamId}`);
      }
      const { token, botUserId } = identity;
      const channels: SlackChannelInput[] = [];
      for (const channelId of channelIds) {
        // Per-channel tolerance for a STALE binding: if the bot was kicked, the
        // channel was archived/deleted, or it's simply not in it, Slack throws
        // `channel_not_found` / `not_in_channel` / `is_archived`. That channel
        // has no readable audience — DROP it from the graph and keep going;
        // fail-closing the whole connection over one dead binding would ungraph
        // every OTHER (readable) channel too. Systemic errors (auth, rate limit)
        // still propagate to the outer catch and fail the connection closed.
        let rawMembers: string[];
        try {
          rawMembers = await deps.slackWeb.conversationMembers(token, channelId);
        } catch (error) {
          const msg = String(error);
          if (
            /channel_not_found|not_in_channel|is_archived|method_not_supported_for_channel_type/.test(
              msg,
            )
          ) {
            // Definitively unreadable (bot kicked / channel archived/gone),
            // NOT transient. Push it with an EMPTY member set so graph
            // reconciliation soft-deletes its stale `member_of` edges (revokes
            // recall) — skipping would leave them alive (fail-OPEN). Transient
            // errors (ratelimit/auth) fall through to `throw` → whole connection
            // fails closed, so we never wipe edges on a flaky fetch.
            logger.warn(
              'Slack conversations.members: channel unreadable (stale binding) — reconciling to no members',
              {
                organization_id: organizationId,
                connection_id: connectionId,
                channel_id: channelId,
                error: msg,
              },
            );
            channels.push({ channelId, memberSlackUserIds: [] });
            continue;
          }
          throw error;
        }
        // The bot is itself a member of every channel it's in, so
        // `conversations.members` includes it. Drop it: a bot is not an audience
        // and must never gain a `member_of` edge (it would inflate "who can
        // recall" AND, via the gate, count as a member). The bot id is the
        // install's, scoped to THIS team. Absent it, we don't filter (no regression).
        const memberSlackUserIds = botUserId
          ? rawMembers.filter((u) => u !== botUserId)
          : rawMembers;
        // Channel name + privacy are BEST-EFFORT display metadata — a failure
        // here must NOT fail-close the whole sync (membership is the contract),
        // so swallow and let slackChannelsToResources use the channel id as its name.
        let name: string | undefined;
        let isPrivate: boolean | undefined;
        try {
          const info = await deps.slackWeb.conversationInfo(token, channelId);
          name = info.name ?? undefined;
          isPrivate = info.isPrivate;
        } catch (error) {
          logger.warn(
            'Slack conversations.info failed — syncing channel without a name',
            {
              organization_id: organizationId,
              connection_id: connectionId,
              channel_id: channelId,
              error: String(error),
            },
          );
        }
        channels.push({ channelId, name, isPrivate, memberSlackUserIds });
      }
      await buildAccessGraph({
        organizationId,
        connectionId,
        connectorKey: slackAclSource.key,
        resourceNamespace: slackAclSource.resourceNamespace,
        memberIdentities: slackAclSource.memberIdentities,
        resources: slackChannelsToResources(teamId, channels),
        syncFence,
        // The stamp is connection-wide; this loop is per-workspace. See below.
        markFresh: false,
      });
      teamsSynced += 1;
      channelsSynced += channels.length;
    }
    /*
     * Stamp ONCE, after every workspace is reconciled — never inside the loop.
     * A Grid connection is one `authz_source_acl_state` row spanning several
     * workspaces, so a stamp after workspace 1 reopens the connection-wide gate
     * while workspaces 2..n still hold their pre-revocation edges, briefly
     * restoring recall for a member who just left a channel in one of them.
     * Reaching this line means every workspace succeeded: any failure throws
     * out of the loop to the catch below, which marks the connection failed
     * instead, so a partial reconcile can never be blessed fresh.
     */
    await markAclFresh(organizationId, connectionId, syncFence);
    await clearConnectionAclError(organizationId, connectionId);
    return { ok: true, teamsSynced, channelsSynced };
  } catch (error) {
    logger.error(
      'Slack ACL sync failed — marking connection fail-closed',
      {
        organization_id: organizationId,
        connection_id: connectionId,
        error: String(error),
      },
    );
    await markConnectionAclFailed(
      organizationId,
      connectionId,
      `Slack ACL sync failed: ${String(error)}`,
    );
    return { ok: false, teamsSynced, channelsSynced };
  }
}

/**
 * Resolve the bot token + user id for one Slack connection's ACL sync. Prefers
 * the workspace OAuth app-installation (hosted/managed path); falls back to the
 * connection's OWN bot credentials for a BYO Slack connection that has no
 * install row. Exported so both branches are unit-testable — the BYO fallback
 * is what lets an active-but-BYO connection (real bindings, no install) actually
 * graph instead of failing closed and silently degrading channel memory to org
 * scope.
 */
export async function resolveSlackBotIdentity(
  deps: {
    installStore: ReturnType<CoreServices['getAppInstallationStore']>;
    // Only the read side (`.get`) is used, via resolveSecretValue — accept the
    // minimal SecretStore so callers with either the WritableSecretStore
    // (platform.ts CoreServices) or the SecretStoreRegistry (concrete) type fit.
    secretStore: SecretStore;
    slackWeb: SlackWebApi;
  },
  params: { organizationId: string; teamId: string; connectionId: string },
): Promise<{ token: string; botUserId: string | null } | null> {
  const { installStore, secretStore, slackWeb } = deps;
  const { organizationId, teamId, connectionId } = params;

  // Primary: resolve the install by THIS connection's concrete id
  // (`slackinst-<uuid>` slug = the install external id), NOT by round-tripping
  // the team string. On a Grid ORG-WIDE install the install row is keyed on the
  // ENTERPRISE id, so a per-team `getSlackInstallByTeamId(T…)` lookup misses for
  // every sibling workspace — but the one bot token is enterprise-wide and reads
  // every workspace's channels. Resolving by connection id gives us that token
  // for any `T…` we're graphing. Only slackinst- slugs are installs; a BYO slug
  // (`agentconn-…`) skips straight to the fallback below.
  const connSlug = runtimeConnectionIdToSlug(connectionId);
  const installById = connSlug.startsWith('slackinst-')
    ? await getSlackInstallById(installStore, connSlug)
    : null;
  if (installById && installById.status === 'active') {
    const tokenRef = (installById.config as { botToken?: string }).botToken;
    const token = await orgContext.run(
      { organizationId: installById.organizationId },
      () => resolveSecretValue(secretStore, tokenRef),
    );
    if (token) return { token, botUserId: installById.botUserId ?? null };
  }

  // Secondary: the workspace OAuth app-installation keyed by team (a normal,
  // non-org-wide install whose connection slug may not be the install id).
  const install = await getSlackInstallByTeamId(installStore, teamId);
  if (install && install.status === 'active') {
    const tokenRef = (install.config as { botToken?: string }).botToken;
    const token = await orgContext.run({ organizationId: install.organizationId }, () =>
      resolveSecretValue(secretStore, tokenRef),
    );
    if (token) return { token, botUserId: install.botUserId ?? null };
  }

  // Fallback: a BYO Slack connection has no install row — its bot token + user
  // id live on the connection's own config. The token is a `secret://` ref,
  // resolved under the connection's org exactly like the install path.
  //
  // We fetch by (slug, org) only and check the team OURSELVES rather than in the
  // predicate: a BYO connection created without an OAuth install NEVER persists a
  // teamId (see slack-connection-coordinator: "created without an OAuth install
  // never gets a metadata.teamId"), so a `= ${teamId}` predicate would drop it
  // entirely and the sync would fail closed forever. Instead we self-heal.
  const sql = getDb();
  const [conn] = await sql<{
    organization_id: string;
    // Slack connection config stores botToken at the top level (the
    // OAuth-install writer's shape); COALESCE the chatMetadata nesting too.
    bot_token_ref: string | null;
    bot_user_id: string | null;
    // The team this connection is already known to belong to, if any.
    stored_team_id: string | null;
  }>`
		SELECT organization_id,
		       COALESCE(config->>'botToken', config->'chatMetadata'->>'botToken') AS bot_token_ref,
		       config->'chatMetadata'->>'botUserId' AS bot_user_id,
		       COALESCE(external_tenant_id, config->'chatMetadata'->>'teamId') AS stored_team_id
		FROM connections
		WHERE slug = ${runtimeConnectionIdToSlug(connectionId)}
		  AND organization_id = ${organizationId}
		  AND connector_key = 'slack'
		  AND status = 'active'
		  AND deleted_at IS NULL
		LIMIT 1
	`;
  if (!conn?.bot_token_ref) return null;

  // Guard the FOREIGN-team case: a connection that already carries a DIFFERENT
  // team id must NOT hand back its token for the team we're graphing. Without
  // this, its token would answer channel_not_found for every foreign channel and
  // the empty-member reconcile would wipe live edges the team's REAL connection
  // maintains. A matching stored team is the fast path (no Slack round-trip).
  if (conn.stored_team_id && conn.stored_team_id !== teamId) return null;

  const token = await orgContext.run({ organizationId: conn.organization_id }, () =>
    resolveSecretValue(secretStore, conn.bot_token_ref as string),
  );
  if (!token) return null;

  // Self-heal the teamId-less BYO connection: confirm the token's REAL team from
  // Slack (a stronger guard than a stored string — it verifies the LIVE
  // credential's team), then backfill THAT team onto the row so future ticks take
  // the fast/foreign-team paths above without another auth.test. We backfill the
  // real team even when it isn't the one we were asked to graph: otherwise a
  // connection reached first for a foreign binding would re-hit auth.test every
  // tick forever. Graphing itself still requires the real team to match.
  if (!conn.stored_team_id) {
    let realTeamId: string;
    try {
      ({ teamId: realTeamId } = await slackWeb.authTest(token));
    } catch (error) {
      // A dead/invalid token can't be identified — fail closed for THIS team
      // (leave the connection ungraphed rather than risk wiping a foreign
      // team's edges). Transient failures retry on the next tick.
      logger.warn(
        'Slack auth.test failed resolving BYO connection team; skipping',
        {
          organization_id: organizationId,
          connection_id: connectionId,
          team_id: teamId,
          error: String(error),
        },
      );
      return null;
    }
    await sql`
			UPDATE connections
			SET external_tenant_id = ${realTeamId}
			WHERE slug = ${runtimeConnectionIdToSlug(connectionId)}
			  AND organization_id = ${organizationId}
			  AND connector_key = 'slack'
			  AND external_tenant_id IS NULL
		`;
    logger.info(
      'Backfilled teamId onto BYO Slack connection from auth.test',
      {
        organization_id: organizationId,
        connection_id: connectionId,
        team_id: realTeamId,
      },
    );
    // Only hand back the token when the confirmed team is the one being graphed;
    // a token for a different workspace must not touch this team's edges.
    if (realTeamId !== teamId) return null;
  }

  return { token, botUserId: conn.bot_user_id };
}

/**
 * The periodic production caller (registered in `scheduled/jobs.ts`). Re-syncs
 * every active Slack connection's channel-membership graph so joins/leaves
 * converge within the tick cadence and the gate's freshness window keeps a
 * stalled connection fail-closed. Runs on one replica per tick (the TaskScheduler
 * runs-queue claim), iterating connections sequentially — membership sync is not
 * latency-critical.
 *
 * Token resolution ({@link resolveSlackBotIdentity}) prefers the workspace OAuth
 * install and falls back to the connection's own BYO bot credentials, so both
 * managed and BYO Slack connections graph. A connection with neither still
 * fails closed via {@link syncSlackConnectionAcl}.
 */
export async function runSlackAclSyncTick(coreServices: CoreServices): Promise<void> {
  const sql = getDb();
  const connRows = await sql<{ slug: string; organization_id: string }>`
		SELECT slug, organization_id
		FROM connections
		WHERE connector_key = 'slack'
		  AND status = 'active'
		  AND credential_mode IS NOT NULL
		  AND deleted_at IS NULL
	`;
  const connections = connRows.map((r) => ({
    id: slugToRuntimeConnectionId(r.slug),
    organization_id: r.organization_id,
  }));
  if (connections.length === 0) return;

  const installStore = coreServices.getAppInstallationStore();
  const secretStore = coreServices.getSecretStore();
  const slackWeb = createSlackWebApi();

  const deps: SlackAclSyncDeps = {
    slackWeb,
    resolveBotIdentity: (params) =>
      resolveSlackBotIdentity({ installStore, secretStore, slackWeb }, params),
  };

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const conn of connections) {
    const result = await syncSlackConnectionAcl(deps, {
      connectionId: conn.id,
      organizationId: conn.organization_id,
    });
    if (result.ok) ok += 1;
    // A skip means another sync of this connection is in flight and will
    // publish; counting it as failed would make an overlapping tick look like
    // an outage.
    else if (result.skipped) skipped += 1;
    else failed += 1;
  }
  logger.info('Slack ACL sync tick complete', {
    connections: connections.length,
    ok,
    failed,
    skipped,
  });
}
