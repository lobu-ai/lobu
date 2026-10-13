/**
 * Channel-membership gate for the `channel_messages` read seam — the SQL analog
 * of `./channel-visibility`'s `filterChannelsForRequester`, expressed as a WHERE
 * fragment so raw-SQL callers (automation @feed sources, query_sql) read chat
 * transcripts with the same fail-closed membership contract.
 *
 * Rule (keyed on the channel identity rather than `events.entity_ids`, because
 * `channel_messages` carries no entity_ids), matching `getConnectionEnforcement`'s
 * three states:
 *   - `not-graphed` (NO acl state row) → recorded connection owner only;
 *   - `enforced` (acl row is full + fresh) → visible ONLY when the requester is
 *     `member_of` the `channel` entity keyed `slack_channel_id = UPPER(team:chan)`,
 *     where the team is resolved from the row's connection;
 *   - `stale` / partial / failed (acl row EXISTS but isn't fresh-enforcing) →
 *     fails CLOSED (neither branch matches). A bare `NOT IN (enforced)` would
 *     instead leak a channel whose ACL snapshot merely aged out.
 *
 * Fail-closed: a headless/null principal, an enforced channel the requester
 * doesn't belong to, or a stale-ACL connection all see nothing. This is what
 * makes a headless automation run fail closed on a streaming @feed. A run must
 * carry its acting user's identity to establish ownership or channel membership.
 *
 * Requester resolution is the auth-signup `$member` claim only (same as
 * `compileResourceVisibility`) — the recap/query_sql reader is a web/app user, not
 * an in-chat author, so the platform user-id fallback isn't needed on this seam.
 *
 * Platform-parametric: the channel-key match is emitted once per registered chat
 * platform (each contributes its `channelNamespace` + `channelKeySql` via the
 * channel-read-identity registry), gated on the row's `platform`. This file names
 * no connector; adding a chat platform is a registry entry, not a SQL edit.
 */

import { CHANNEL_READ_IDENTITIES } from './sources.js';
import { enforcedConnectionsSelectSql } from './acl-state.js';
import { ownedChatConnectionsSelectSql } from './connection-visibility.js';
import type { ChannelReadIdentity } from '@lobu/connector-sdk';
import type { AuthzScope } from './scope.js';

/**
 * Predicate for a `channel_messages` table (alias has `connection_id` [text
 * runtime id], `channel_id` [bare], `organization_id`). Binds two params from
 * `baseParamIndex`: the org id and the principal. Returns an `AND (...)` fragment
 * (no leading space).
 *
 * `channel_messages.connection_id` and `authz_source_acl_state.connection_id` are
 * BOTH the runtime connection id (see `slack-acl-sync`/`persistChannelMessage`),
 * so the enforced-set membership check compares like-for-like. The channel entity
 * is team-scoped (`T:C`), so the team is resolved from the row's connection
 * (`external_tenant_id` / `config.chatMetadata.teamId`), matched by slug via both
 * the BYO (`agentconn-<id>`) and slack-install (`<id>`) namespaces.
 */
export function compileChannelMessagesVisibility(
  scope: AuthzScope,
  baseParamIndex: number,
  tableAlias: string,
  // The registered chat platforms whose channel gate is emitted. Defaults to the
  // production registry; injectable so the multi-platform OR (≥2 branches) can be
  // exercised without registering a real second connector.
  identities: ChannelReadIdentity[] = CHANNEL_READ_IDENTITIES,
): { sql: string; params: Array<string | null> } {
  const orgParam = `$${baseParamIndex}::text`;
  const userParam = `$${baseParamIndex + 1}::text`;

  // The requester's `$member` entity, resolved on the auth-signup claim only
  // (same guard as compileResourceVisibility — server-written, unforgeable).
  const requesterMemberSubquery = `(
    SELECT mei.entity_id
    FROM public.entity_identities mei
    JOIN public.entities me
      ON me.id = mei.entity_id
     AND me.organization_id = mei.organization_id
     AND me.deleted_at IS NULL
    JOIN public.entity_types met
      ON met.id = me.entity_type_id
     AND met.organization_id = me.organization_id
     AND met.slug = '$member'
    WHERE mei.organization_id = ${orgParam}
      AND mei.namespace = 'auth_user_id'
      AND mei.identifier = ${userParam}
      AND mei.scope_key IS NULL
      AND mei.source_connector = 'auth:signup'
      AND mei.deleted_at IS NULL
    LIMIT 1
  )`;

  // The tenant/team the channel key is scoped by, resolved from the row's
  // connection (platform-neutral): the row's own team_id, else the connection's
  // external tenant id / chatMetadata teamId. Passed as the team expression to
  // each platform's channel-key builder.
  const teamExpr = `COALESCE(
    ${tableAlias}.team_id,
    conn.external_tenant_id,
    conn.config->'chatMetadata'->>'teamId'
  )`;

  // One channel-membership EXISTS branch per registered chat platform: the
  // requester is `member_of` the `$resource` entity keyed by THIS platform's
  // channel identity + key expression, gated on the row's platform. OR-ed so a
  // multi-platform transcript table is covered without naming any connector.
  const membershipBranch = (
    channelNamespace: string,
    channelKeySql: string,
  ): string => `EXISTS (
          SELECT 1
          FROM public.connections conn
          JOIN public.entity_identities cei
            ON cei.organization_id = ${orgParam}
           AND cei.namespace = '${channelNamespace}'
           AND cei.scope_key IS NULL
           AND cei.deleted_at IS NULL
           AND cei.identifier = ${channelKeySql}
          JOIN public.entity_relationships rr
            ON rr.organization_id = ${orgParam}
           AND rr.to_entity_id = cei.entity_id
           AND rr.deleted_at IS NULL
          JOIN public.entity_relationship_types rt
            ON rt.id = rr.relationship_type_id
           AND rt.organization_id = rr.organization_id
           AND rt.slug = 'member_of'
          WHERE conn.organization_id = ${orgParam}
            AND conn.slug IN (${tableAlias}.connection_id, 'agentconn-' || ${tableAlias}.connection_id)
            AND rr.from_entity_id = ${requesterMemberSubquery}
        )`;

  const platformBranches = identities.map((identity) => {
    const keySql = identity.channelKeySql(teamExpr, `${tableAlias}.channel_id`);
    return `(${tableAlias}.platform = '${identity.platform}' AND ${membershipBranch(
      identity.channelNamespace,
      keySql,
    )})`;
  });
  // No registered chat platform → only explicit connection ownership can admit
  // an ungraphed connection. FALSE keeps the enforced branch closed.
  const memberVisible = platformBranches.length > 0 ? platformBranches.join('\n        OR ') : 'FALSE';

  // Unknown source permissions are owner-only; stale source permissions deny
  // everyone. Workspace membership alone never grants channel access.
  const sql = `AND (
      (
        ${tableAlias}.connection_id IN (${ownedChatConnectionsSelectSql(orgParam, userParam)})
        AND NOT EXISTS (
          SELECT 1 FROM public.authz_source_acl_state a
          WHERE a.organization_id = ${orgParam}
            AND a.connection_id = ${tableAlias}.connection_id
        )
      )
      OR (
        ${tableAlias}.connection_id IN (${enforcedConnectionsSelectSql(orgParam)})
        AND (
          ${memberVisible}
        )
      )
    )`;
  return { sql, params: [scope.organizationId, scope.principal] };
}
