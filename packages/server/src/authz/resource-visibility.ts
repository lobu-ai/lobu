/**
 * THE generic resource-visibility compiler — gates `events` (connector-sourced
 * content AND server-derived knowhow) by RESOURCE membership.
 *
 * Rule — an event is visible when ANY of these hold:
 *   1. it is a server-authored interaction event (`interaction_type <>
 *      'none'`: approvals, suggestions) and the caller is an organization
 *      member, in every graph state (prod run 757649 — hiding an approval
 *      because an ACL sync stalled wedges the operation it gates);
 *   2. it links to NO access resource (`$resource` entity in `entity_ids`)
 *      AND its connection was never graphed (`connection_id IS NULL` or no
 *      `authz_source_acl_state` row): ordinary workspace content, unchanged.
 *      An unattributed row on a graphed connection stays fail-closed — a
 *      missing stamp is not proof of workspace visibility;
 *   3. it links to at least one access resource AND EVERY linked resource is
 *      satisfied by the caller: a live `member_of` edge from the caller's
 *      `$member` entity to the resource whose claim is `manual`, or is owned
 *      by a connection whose ACL graph is currently enforced (`full` +
 *      `fresh` + in-window).
 *
 * Multiple linked resources mean ALL are required (AND). A derived summary of
 * two repos is readable only by a member of both — membership in one is not
 * enough. The envelope is connection-independent: a server-derived event with
 * `connection_id IS NULL` (e.g. a channel-stamped `save_content` summary) is
 * gated by its stamps exactly like a connector-synced row, and a stamped event
 * whose authority went stale (or was never graphed) fails closed rather than
 * falling back to the legacy fence. An unstamped event on a never-graphed
 * connection keeps the legacy visibility the source messages have; once a
 * connection is graphed, its unattributed rows never fall back.
 *
 * Fail-closed: an edge with no ownership claim, a claim owned by a stale /
 * failed / never-enforced connection, a headless/null principal on stamped
 * content, or a missing resource entity satisfies nothing. Claimless
 * `member_of` rows cannot occur: migration `20260827174500` tombstoned legacy
 * authorization edges and every writer since carries `_lobu_claims`.
 *
 * Connector sync never writes `interaction_type`, so no synced resource
 * content can ride the branch-2 exemption. Generic across sources — GitHub
 * repos and Linear teams gate identically; a new source needs only a registry
 * entry (`./sources`) plus its connector stamping the resource identity on its
 * events so they link to the resource entity.
 */

import { ACL_RESOURCE_TYPE_SLUG } from '@lobu/connector-sdk';
import { aclStateExistsSelectSql, enforcedConnectionsSelectSql } from './acl-state.js';
import { aclConnectionIdSql } from './acl-observability.js';
import type { AuthzScope } from './scope.js';
import {
  MANUAL_RELATIONSHIP_CLAIM_KEY,
  RELATIONSHIP_CLAIMS_METADATA_KEY,
} from '../utils/relationship-claims.js';

/** Sole ACL resource type slug, inlined as a SQL string literal (constant). */
const RESOURCE_TYPE_SQL = `'${ACL_RESOURCE_TYPE_SLUG}'`;

/**
 * Predicate for a table holding events (alias has `connection_id` + `entity_ids`).
 * Binds two params from `baseParamIndex`: the org id and the principal. Returns an
 * `AND (...)` fragment (no leading space). Compose alongside
 * `compileConnectionFkVisibility` at the same seam.
 */
export function compileResourceVisibility(
  scope: AuthzScope,
  baseParamIndex: number,
  tableAlias: string,
): { sql: string; params: Array<string | null> } {
  const orgParam = `$${baseParamIndex}::text`;
  const userParam = `$${baseParamIndex + 1}::text`;

  // The caller's verified `$member` entity — the `from` side of every
  // membership edge below. Resolved once per query, not once per row.
  const memberSubquery = `(
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

  // The access resources linked to this event: live `$resource` entities in
  // `entity_ids`. Scoped so the coarse person→`company` (org) `member_of` edge
  // never counts — org membership must NOT grant resource-level read. A
  // missing, deleted, or non-resource link contributes no requirement.
  const linkedResources = `SELECT re.id AS resource_id
      FROM unnest(COALESCE(${tableAlias}.entity_ids, '{}'::bigint[])) AS linked_id
      JOIN public.entities re
        ON re.id = linked_id
        AND re.organization_id = ${orgParam}
        AND re.deleted_at IS NULL
      JOIN public.entity_types ret
        ON ret.id = re.entity_type_id
        AND ret.organization_id = re.organization_id
        AND ret.slug = ${RESOURCE_TYPE_SQL}`;

  // One linked resource is satisfied when a live `member_of` edge from the
  // caller's `$member` carries `manual` ownership, or ownership by a
  // connection whose ACL graph is currently enforced. `left(ck, 11)` avoids a
  // LIKE pattern (identifiers may contain `_`/`%`); the connection id is the
  // second `:`-separated segment of `connection:<id>:<owner>`.
  //
  // That segment is the STORED numeric row (`connections.id`, written by
  // `buildAccessGraph` via `identityConnectionId`), while the ACL state is
  // keyed by the RUNTIME id (`connections.id::text` for data connectors,
  // the `slackinst-…`/`agentconn-…` slug for chat) — so the segment is
  // resolved through the `connections` row and compared with the same
  // `aclConnectionIdSql` expression the sync stamps. Comparing the raw
  // segment would never match a chat runtime id and would fail closed for
  // channel members on their own channel-stamped saves.
  const resourceSatisfied = `EXISTS (
        SELECT 1
        FROM public.entity_relationships rr
        JOIN public.entity_relationship_types rt
          ON rt.id = rr.relationship_type_id
          AND rt.organization_id = rr.organization_id
          AND rt.slug = 'member_of'
        WHERE rr.organization_id = ${orgParam}
          AND rr.deleted_at IS NULL
          AND rr.to_entity_id = lr.resource_id
          AND rr.from_entity_id = ${memberSubquery}
          AND (
            (rr.metadata -> '${RELATIONSHIP_CLAIMS_METADATA_KEY}') ? '${MANUAL_RELATIONSHIP_CLAIM_KEY}'
            OR EXISTS (
              SELECT 1
              FROM jsonb_object_keys(rr.metadata -> '${RELATIONSHIP_CLAIMS_METADATA_KEY}') AS ck
              WHERE left(ck, 11) = 'connection:'
                AND EXISTS (
                  SELECT 1
                  FROM public.connections c
                  WHERE c.organization_id = ${orgParam}
                    AND c.deleted_at IS NULL
                    AND c.id::text = split_part(ck, ':', 2)
                    AND ${aclConnectionIdSql('c')} IN (${enforcedConnectionsSelectSql(orgParam)})
                )
            )
          )
      )`;

  // `events.connection_id` is the bigint `connections.id`, but
  // `authz_source_acl_state.connection_id` is text — the ACL sync stamps it as
  // `String(connections.id)` (see `github-acl-sync` → `buildAccessGraph`). Cast
  // `events.connection_id::text` so the "was this connection ever graphed?"
  // check compares on the SAME key.
  const sql = `AND (
      (${tableAlias}.interaction_type <> 'none'
      AND EXISTS (
        SELECT 1
        FROM public."member" om
        WHERE om."organizationId" = ${orgParam}
          AND om."userId" = ${userParam}
      ))
      OR (NOT EXISTS (${linkedResources})
      AND (${tableAlias}.connection_id IS NULL
        OR ${tableAlias}.connection_id::text NOT IN (${aclStateExistsSelectSql(orgParam)})))
      OR (EXISTS (${linkedResources})
      AND (NOT EXISTS (
        SELECT 1
        FROM (${linkedResources}) AS lr
        WHERE NOT (${resourceSatisfied})
      )))
    )`;
  return { sql, params: [scope.organizationId, scope.principal] };
}
