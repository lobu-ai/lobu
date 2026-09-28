/**
 * The generic access-graph engine — ONE materializer behind every ACL source.
 *
 * A "source" (a Slack workspace, a GitHub org, later Jira/Drive/…) reduces to the
 * same shape: a set of RESOURCES (channels, repos, projects), each with an
 * AUDIENCE of MEMBERS who may read it. This engine takes that normalized shape
 * and writes it into the existing entity graph — exactly the way the original
 * `buildSlackChannelGraph` did, but with the resource/member specifics lifted
 * into parameters so a second source reuses the whole body instead of copying it.
 *
 * It owns everything that was identical (or should have been) between the Slack
 * channel graph and the GitHub team graph:
 *   - resolve an org owner/admin to attribute entities/edges to (`created_by`);
 *   - find-or-create the resource entity TYPE and the `member_of` relationship
 *     type (reuse, no migration);
 *   - resolve each resource to its entity, keyed on a source-specific identity
 *     namespace (`slack_channel_id`, `github_repo_id`, …);
 *   - resolve each member IDENTITY-FIRST and TYPE-AGNOSTICALLY — a member who has
 *     already signed in owns their identity claim on a `$member` entity, so we
 *     collapse onto THAT entity rather than forking a duplicate `person` (the
 *     correctness fix the Slack builder had and the original GitHub builder did
 *     NOT — folding GitHub onto this engine fixes it for free);
 *   - write `member_of` (member → resource) edges idempotently;
 *   - RECONCILE departures (soft-delete edges to a synced resource whose member is
 *     no longer present) so leavers lose access on the next sync;
 *   - stamp `authz_source_acl_state` ('full','fresh') so the gate begins enforcing
 *     the connection.
 *
 * Tenant-scoped, idempotent, best-effort: everything filters on `organizationId`;
 * edges dedupe on the live-triple unique index; nothing here throws on a
 * data-shaped problem (the CALLER's fetch layer owns fail-closed-on-error).
 */

import { validateEntityRowPatch } from "./entity-row-validation";
import { createLogger } from '@lobu/core';
import {
  ACL_RESOURCE_TYPE_SLUG,
  type AccessIdentitySpec,
  type AccessMember,
  type AccessResource,
} from '@lobu/connector-sdk';
import { getDb, pgBigintArray, pgTextArray } from '../db/client.js';
import { runtimeConnectionIdToSlug } from '../lobu/stores/connections-projection.js';
import { applyEventAttributions } from '../utils/entity-link-upsert.js';
import {
  patchEntityRows,
  withEntityWriteTransaction,
} from '../utils/entity-management.js';
import { ensureRelationshipType, upsertEdges } from '../utils/edge-writes.js';
import {
  connectionRelationshipClaimKey,
  lockLiveConnectionForRelationshipClaims,
  lockOrganizationForRelationshipClaims,
  retractRelationshipClaimFromDepartures,
} from '../utils/relationship-claims.js';
import {
  PURPOSE_AUTHORIZATION,
  withAclEdgeWrite,
} from '../utils/relationship-validation.js';
import { aclConnectionIdSql } from './acl-observability.js';
import { type AclSyncFence, captureAclSyncFence } from './acl-generation.js';
import { ensureResourceEntityType } from './acl-resource-type.js';

const logger = createLogger('access-graph');

const MEMBER_OF_TYPE_SLUG = 'member_of';

export type { AccessIdentitySpec, AccessMember, AccessResource };
export { ensureResourceEntityType } from './acl-resource-type.js';

export interface AccessGraphResult {
  /** Resource key → the entity id that now represents it. */
  resourceEntityIds: Record<string, number>;
  /** Distinct member entity ids that gained a `member_of` edge. */
  memberEntityIds: number[];
  createdEdges: number;
  removedEdges: number;
}

const EMPTY_RESULT: AccessGraphResult = {
  resourceEntityIds: {},
  memberEntityIds: [],
  createdEdges: 0,
  removedEdges: 0,
};

/** Resolve an org owner/admin as `entities.created_by` / edge `created_by`
 * (NOT NULL). Same query both source builders used. */
async function resolveOrgCreator(orgId: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql<{ userId: string }>`
		SELECT "userId"
		FROM "member"
		WHERE "organizationId" = ${orgId}
		ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
		         "createdAt" ASC
		LIMIT 1
	`;
  return rows.length > 0 ? rows[0].userId : null;
}

/** Ensure the org has a `person` entity type — the type new (genuinely-unknown)
 * members are auto-created as. Prod seeds default types at org creation, but a
 * brand-new/default org may not have it yet; without it those members would
 * silently fail to resolve while the connection is still stamped enforced (their
 * recall would then fail closed). */
async function ensurePersonEntityType(orgId: string): Promise<void> {
  const sql = getDb();
  await sql`
		INSERT INTO entity_types (slug, name, organization_id, created_at, updated_at)
		VALUES ('person', 'Person', ${orgId}, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
		DO NOTHING
	`;
}

/** Shared initializer for the org-scoped `member_of` relationship type.
 *  Exported because the GitHub team graph writes the SAME slug in the SAME org
 *  and so always shared this row; it used to keep a second copy of this
 *  function with a different description. */
export function ensureMemberOfType(orgId: string): Promise<number> {
  return ensureRelationshipType({
    organizationId: orgId,
    slug: MEMBER_OF_TYPE_SLUG,
    name: 'Member of',
    description: 'A member belongs to an ACL resource (channel, repo, org, …)',
    // lobu#2825 made every ACL writer set `lobu.acl_write` while leaving
    // classification inert. This later release can therefore stamp the type
    // without a rolling-deploy window in which an older pod's sync is rejected.
    //
    // This also REPAIRS: the upsert adopts a pre-existing `member_of` row, so an
    // org whose type predates the backfill is classified on its next sync rather
    // than staying an unguarded ACL type forever.
    purpose: PURPOSE_AUTHORIZATION,
  });
}

/**
 * Stamp the connection fresh only if its ACL state did not change mid-snapshot.
 *
 * The case this exists for: a `member_left_channel` webhook marks the
 * connection `stale` while this snapshot was in flight. That departure is not
 * in the snapshot, so blessing it `fresh` would re-trust a membership Slack has
 * already contradicted. Skipping the stamp leaves the row `stale`, the gate
 * fails closed, and the next sync rebuilds from current membership.
 *
 * This fence covers the STAMP only. It cannot see an EDGE write, so on its own
 * it does not stop two overlapping syncs of one connection from interleaving:
 * the loser's stamp is refused, but its edges are already written. That half is
 * closed by `withAclConnectionSyncLock`, which orders syncs of a connection so
 * the interleaving cannot arise; this fence then covers the case no
 * per-connection lock can order — an invalidation racing a sync.
 *
 * Exported because the stamp is CONNECTION-wide while a build is per-resource-
 * set: a caller that reconciles one connection across several source scopes
 * (Slack Grid — one connection, many workspaces) must pass `markFresh: false`
 * and call this once, after every scope has been reconciled. Stamping inside
 * such a loop reopens the connection-wide gate while later scopes still hold
 * pre-revocation edges.
 */
export async function markAclFresh(
  orgId: string,
  connectionId: string,
  fence: AclSyncFence,
): Promise<void> {
  const { startedAt: syncStartedAt, generation: aclGeneration } = fence;
  const sql = getDb();
  await sql.begin(async (tx) => {
    // ORGANIZATION FIRST, and the order is the whole point.
    //
    // Every writer here takes organization -> connections -> ACL state. That
    // matches the one path that already locks in that order and cannot be
    // changed: deleting an organization locks the org row, then its
    // `ON DELETE CASCADE` deletes the connections beneath it
    // (`connections_organization_id_fkey`). Locking the connection first and
    // then waiting for the org row would invert that and deadlock a stamp
    // against a concurrent org deletion.
    //
    // Holding it as FOR SHARE also fences the comparison: an invalidation's
    // `UPDATE organization` conflicts with the share lock, so if it began first
    // this waits and then reads the NEW generation, and if this began first the
    // invalidation waits and applies after this transaction commits.
    const generationRows = await tx<{ acl_generation: string }>`
      SELECT acl_generation::text AS acl_generation
      FROM organization
      WHERE id = ${orgId}
      FOR SHARE
    `;

    // Serialize the state stamp with the connection tombstone. A sync can spend
    // seconds fetching a remote membership snapshot after the scheduler selected
    // the row; without this lock, deletion can remove the old ACL state and the
    // in-flight sync can recreate it after the delete commits. Standalone graph
    // tests intentionally use synthetic connection ids, so no matching row keeps
    // the historical materializer semantics; a matching tombstoned row skips the
    // stamp.
    const connections = await tx<{ deleted_at: Date | string | null }>`
      SELECT c.deleted_at
      FROM connections c
      WHERE c.organization_id = ${orgId}
        AND ${tx.unsafe(aclConnectionIdSql('c'))} = ${connectionId}
      FOR UPDATE
    `;
    if (connections.length > 0 && connections.every((row) => row.deleted_at != null)) return;

    // A missing organization row is not a fence we can evaluate: there is no
    // generation to compare, so refuse the stamp rather than publish a
    // projection whose freshness cannot be verified. `connections` has an
    // ON DELETE CASCADE FK to `organization`, so a live connection cannot
    // outlive its org — this fires only for an orphaned state row or a job
    // racing org deletion, and both must fail closed.
    if (generationRows.length === 0) return;
    if (generationRows[0].acl_generation !== aclGeneration) return;

    // Two fences, and both are load-bearing.
    //
    // The generation is the real one: it was captured before this sync read or
    // reconciled membership, so an invalidation that COMMITTED mid-sync fails
    // the comparison even though its statement timestamp precedes
    // `syncStartedAt`. It also guards the INSERT, which the timestamp cannot —
    // `ON CONFLICT … WHERE` never runs when there is no conflicting row, so a
    // sync that began pre-invalidation could otherwise create a brand-new
    // `fresh` row afterward.
    //
    // The timestamp fence stays for the same-generation case: two concurrent
    // syncs of one connection, where the later-starting one must not be
    // overwritten by an older snapshot finishing after it.
    //
    await tx`
		INSERT INTO authz_source_acl_state
			(organization_id, connection_id, acl_support, freshness_state, last_synced_at, created_at, updated_at)
		VALUES (${orgId}, ${connectionId}, 'full', 'fresh', current_timestamp, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, connection_id)
		DO UPDATE SET acl_support = 'full', freshness_state = 'fresh',
		              last_synced_at = clock_timestamp(), updated_at = clock_timestamp()
		WHERE authz_source_acl_state.updated_at < ${syncStartedAt}::timestamptz
	`;
  });
}

/**
 * Resolve every distinct member to an entity id, IDENTITY-FIRST and
 * TYPE-AGNOSTIC: a member collapses onto any existing entity (`$member`,
 * `person`, …) carrying ANY of their identities; only genuinely-new members get
 * a freshly-created `person`. Returns a map member.key → entity id.
 */
async function resolveMembers(
  orgId: string,
  connectorKey: string,
  connectionId: number | null,
  members: AccessMember[],
  memberIdentities: AccessIdentitySpec[],
): Promise<Map<string, number>> {
  const byKey = new Map<string, number>();
  if (members.length === 0) return byKey;

  // Gather identity values per namespace and look up existing owners (any type).
  const valuesByNamespace = new Map<string, Set<string>>();
  for (const m of members) {
    for (const id of m.identities) {
      if (!id.value) continue;
      const set = valuesByNamespace.get(id.namespace) ?? new Set<string>();
      set.add(id.value);
      valuesByNamespace.set(id.namespace, set);
    }
  }
  const existing = new Map<string, number>(); // `${namespace}|${value}` → entity id
  const sql = getDb();
  for (const [namespace, values] of valuesByNamespace) {
    const list = [...values];
    if (list.length === 0) continue;
    // The JOIN is load-bearing: an ordinary entity delete soft-deletes the
    // ENTITY but leaves its `entity_identities` rows live, still pointing at
    // it (only a merge or sign-in adoption repoints them). Matching on the
    // identity alone therefore resolves onto a dead entity, writes `member_of`
    // to it, and never mints a replacement — so the member silently vanishes
    // from the audience of every channel they are in. `lookupMatches` in
    // entity-link-upsert already joins for this reason; this matcher did not.
    const rows = await sql<{ identifier: string; entity_id: number }>`
			SELECT ei.identifier, ei.entity_id
			FROM entity_identities ei
			JOIN entities e ON e.id = ei.entity_id
			WHERE ei.organization_id = ${orgId}
			  AND ei.namespace = ${namespace}
			  AND ei.identifier = ANY(${pgTextArray(list)}::text[])
			  AND ei.scope_key IS NULL
			  AND ei.deleted_at IS NULL
			  AND e.deleted_at IS NULL
		`;
    for (const r of rows) {
      existing.set(`${namespace}|${String(r.identifier)}`, Number(r.entity_id));
    }
  }

  // Which entity a member's claims resolve to follows the tier semantics the
  // create path below (`applyEventAttributions`) already implements —
  // see `primary` in connector-types.ts. Stopping at the first array hit made
  // the answer depend on the order a connector pushed its identities, and
  // `member_of` is a read ACL, so that was a mis-grant waiting to happen: a
  // stale or recycled secondary claim (an old email, a reused login) would hand
  // one person another person's channel access. A PRESENT primary identity —
  // the source's stable per-account key — therefore governs alone and never
  // falls through to a secondary match: a fresh primary means a distinct
  // account even when a recycled secondary still points at the old person.
  // This fast path only claims a member when its answer matches what the
  // create-path engine would decide; every other case (primary present but
  // unmatched, a same-tier conflict) falls through to `toCreate`, where that
  // engine mints a new entity keyed on the primary or refuses the ambiguous
  // match outright (no edge — fail closed) with its 'merge candidate' warning.
  const primaryNamespaces = new Set(
    memberIdentities.filter((s) => s.primary).map((s) => s.namespace)
  );
  const toCreate: AccessMember[] = [];
  for (const m of members) {
    const primaryHits = new Set<number>();
    const secondaryHits = new Set<number>();
    let primaryPresent = false;
    for (const id of m.identities) {
      if (!id.value) continue;
      const isPrimary = primaryNamespaces.has(id.namespace);
      if (isPrimary) primaryPresent = true;
      const found = existing.get(`${id.namespace}|${id.value}`);
      if (found === undefined) continue;
      (isPrimary ? primaryHits : secondaryHits).add(found);
    }
    let hit: number | undefined;
    if (primaryPresent) {
      if (primaryHits.size === 1) {
        hit = [...primaryHits][0];
        const overridden = [...secondaryHits].filter((id) => id !== hit);
        if (overridden.length > 0) {
          logger.warn(
            {
              organization_id: orgId,
              connector_key: connectorKey,
              member_key: m.key,
              resolved_to: hit,
              overridden_entity_ids: overridden,
            },
            'access-graph: member matched multiple entities — resolved via the primary identity'
          );
        }
      }
    } else if (secondaryHits.size === 1) {
      hit = [...secondaryHits][0];
    }
    if (hit !== undefined) byKey.set(m.key, hit);
    else toCreate.push(m);
  }

  if (toCreate.length === 0) return byKey;

  // Auto-create a `person` for each genuinely-new member, carrying ALL their
  // declared identities so a later source (or login) collapses onto them.
  const items = toCreate.map((m) => {
    const metadata: Record<string, unknown> = { display_name: m.name ?? m.key };
    for (const id of m.identities) metadata[id.namespace] = id.value;
    return { origin_type: 'access_member', metadata };
  });
  const resolved = await applyEventAttributions({
    connectorKey,
    connectionId,
    orgId,
    items,
    rules: {
      access_member: [
        {
          role: 'authored_by',
          entityType: 'person',
          autoCreate: true,
          titlePath: 'metadata.display_name',
          identities: memberIdentities.map((spec) => ({
            namespace: spec.namespace,
            eventPath: `metadata.${spec.namespace}`,
            primary: spec.primary,
          })),
        },
      ],
    },
  });
  for (let i = 0; i < toCreate.length; i++) {
    const ids = resolved.entityIdsByItem.get(i);
    if (ids && ids.length > 0) byKey.set(toCreate[i].key, ids[0]);
  }
  return byKey;
}

/**
 * Materialize a source's resource→audience graph and mark the connection
 * ACL-enforced. The CALLER normalizes its raw API shape into `resources`
 * (Slack channels with `T:C`/`T:U` keys, GitHub repos with collaborators, …);
 * this body is source-agnostic.
 */
export async function buildAccessGraph(params: {
  organizationId: string;
  connectionId: string;
  connectorKey: string;
  /** Identity namespace for resource keys (e.g. `slack_channel_id`). */
  resourceNamespace: string;
  memberIdentities: AccessIdentitySpec[];
  resources: AccessResource[];
  /**
   * Database time and org generation captured together before the source
   * snapshot began. A caller that captures its own remote snapshot supplies
   * this pair; otherwise the graph builder captures it before reconciliation.
   */
  syncFence?: AclSyncFence;
  /**
   * Whether this build may stamp the connection fresh. Default true — one build
   * IS the whole connection for a single-scope source (GitHub). A caller that
   * loops several scopes over one connection passes false and calls
   * `markAclFresh` itself after the last scope; see that function.
   */
  markFresh?: boolean;
}): Promise<AccessGraphResult> {
  const { organizationId, connectionId, connectorKey, resourceNamespace, memberIdentities } =
    params;
  const resources = params.resources.filter((r) => r.key);
  if (resources.length === 0) return EMPTY_RESULT;

  // A caller that reads a remote snapshot BEFORE calling this must capture its
  // own fence first and pass it — capturing here would observe a generation an
  // invalidation had already bumped during that read, so the stale snapshot
  // would satisfy its own fence. Both production syncs do exactly that; this
  // fallback serves direct callers that build from data already in hand.
  const syncFence = params.syncFence ?? (await captureAclSyncFence(organizationId));

  const creatorUserId = await resolveOrgCreator(organizationId);
  if (!creatorUserId) {
    logger.warn(
      { organization_id: organizationId, connector: connectorKey },
      'Access graph skipped: org has no member to attribute as entity creator',
    );
    return EMPTY_RESULT;
  }

  await ensureResourceEntityType(getDb(), organizationId);
  await ensurePersonEntityType(organizationId);

  // ACL state uses a runtime connection id, while identity provenance references
  // the stored numeric row. Resolve by slug (chat connections) or id text (data
  // connectors) without assuming the runtime id itself is numeric.
  const [storedConnection] = await getDb()<{ id: number }>`
    SELECT id
    FROM connections
    WHERE organization_id = ${organizationId}
      AND connector_key = ${connectorKey}
      AND deleted_at IS NULL
      AND (
        slug = ${runtimeConnectionIdToSlug(connectionId)}
        OR id::text = ${connectionId}
      )
    LIMIT 1
  `;
  const identityConnectionId = storedConnection
    ? Number(storedConnection.id)
    : null;

  // 1) Resolve every resource to its entity, keyed on the source identity namespace.
  const resourceItems = resources.map((r) => ({
    origin_type: 'access_resource',
    metadata: { resource_key: r.key, resource_name: r.name ?? r.key },
  }));
  const resolvedResources = await applyEventAttributions({
    connectorKey,
    connectionId: identityConnectionId,
    orgId: organizationId,
    items: resourceItems,
    rules: {
      access_resource: [
        {
          role: 'belongs_to',
          entityType: ACL_RESOURCE_TYPE_SLUG,
          autoCreate: true,
          titlePath: 'metadata.resource_name',
          identities: [
            {
              namespace: resourceNamespace,
              eventPath: 'metadata.resource_key',
              primary: true,
            },
          ],
        },
      ],
    },
  });
  const resourceEntityIds: Record<string, number> = {};
  const resourceEntityIdByIndex = new Map<number, number>();
  for (let i = 0; i < resources.length; i++) {
    const ids = resolvedResources.entityIdsByItem.get(i);
    if (ids && ids.length > 0) {
      resourceEntityIds[resources[i].key] = ids[0];
      resourceEntityIdByIndex.set(i, ids[0]);
    }
  }

  // 2) Resolve every DISTINCT member (identity-first, type-agnostic).
  const distinctMembers = new Map<string, AccessMember>();
  for (const r of resources) {
    for (const m of r.members) {
      if (m.key && !distinctMembers.has(m.key)) distinctMembers.set(m.key, m);
    }
  }
  const memberEntityByKey = await resolveMembers(
    organizationId,
    connectorKey,
    identityConnectionId,
    [...distinctMembers.values()],
    memberIdentities,
  );

  // 3) Write member → resource `member_of` edges, idempotent on the live-triple
  // unique index. Accumulate the CURRENT member set per resource for reconcile.
  const typeId = await ensureMemberOfType(organizationId);
  const sql = getDb();

  // Keep each resource entity's display name fresh. `titlePath` only sets the
  // name on auto-CREATE, so a name that wasn't available at first graph (or a
  // later channel/repo RENAME) would otherwise stick to the stale value / the
  // raw id. Refresh from the source-provided name here. Scoped to the resources
  // in this build; idempotent (the locked selector skips unchanged names).
  const resourceNames = new Map<number, string>();
  for (let i = 0; i < resources.length; i++) {
    const id = resourceEntityIdByIndex.get(i);
    const name = resources[i].name;
    if (id && name) {
      resourceNames.set(id, name);
    }
  }
  if (resourceNames.size > 0) {
    await withEntityWriteTransaction(sql, async (tx) => {
      // `ORDER BY id` before FOR UPDATE takes the row locks in id order, so
      // overlapping graph builds over the same resources cannot deadlock.
      const lockedRows = await tx<{ id: number; name: string }>`
        SELECT id, name
        FROM entities
        WHERE id = ANY(${pgBigintArray([...resourceNames.keys()])}::bigint[])
          AND organization_id = ${organizationId}
          AND deleted_at IS NULL
        ORDER BY id
        FOR UPDATE
      `;
      for (const row of lockedRows) {
        const id = Number(row.id);
        const name = resourceNames.get(id);
        if (name !== undefined && row.name !== name) {
          await patchEntityRows({
            tx,
            ids: [id],
            patch: await validateEntityRowPatch({
              tx,
              ids: [id],
              patch: { name },
            }),
          });
        }
      }
    });
  }

  const memberEntityIds = new Set<number>();
  const currentMembersByResource = new Map<number, Set<number>>();
  const edgePairs: { fromEntityId: number; toEntityId: number }[] = [];
  for (let i = 0; i < resources.length; i++) {
    const resourceEntityId = resourceEntityIdByIndex.get(i);
    if (resourceEntityId === undefined) continue;
    const resourceMembers = currentMembersByResource.get(resourceEntityId) ?? new Set<number>();
    currentMembersByResource.set(resourceEntityId, resourceMembers);
    for (const m of resources[i].members) {
      const memberEntityId = memberEntityByKey.get(m.key);
      if (memberEntityId === undefined) continue;
      memberEntityIds.add(memberEntityId);
      resourceMembers.add(memberEntityId);
      edgePairs.push({ fromEntityId: memberEntityId, toEntityId: resourceEntityId });
    }
  }

  // A resource's membership is re-affirmed rather than rewritten, so a
  // steady-state resync creates nothing.
  // Grants and departures commit together under the ACL write flag. The trigger
  // requires it now that `member_of` is classified.
  // Enforcement lives in the database rather than at each call site because
  // this table has several writers, and `source='feed'` cannot mark a write as
  // ours — it is caller-settable too.
  //
  // The transaction is also a correctness fix in its own right: these used to be
  // separate autocommits, so a crash between them left grants written and
  // departures unreconciled — i.e. access that should have been revoked.
  const { createdEdges, removedEdges } = await withAclEdgeWrite(
    sql,
    async (tx) => {
      if (identityConnectionId !== null) {
        await lockOrganizationForRelationshipClaims(tx, organizationId);
        await lockLiveConnectionForRelationshipClaims(
          tx,
          organizationId,
          identityConnectionId
        );
      }
      // Connection cleanup is keyed by the stored row id. Chat ACL syncs use a
      // runtime id derived from the row slug, so claiming under that runtime id
      // would leave authorization edges behind when the numeric row is deleted.
      // Synthetic direct callers have no row and retain their supplied id.
      const claimKey = connectionRelationshipClaimKey(
        identityConnectionId ?? connectionId,
        'config:access-graph',
      );
      const created = await upsertEdges({
        db: tx,
        organizationId,
        relationshipTypeId: typeId,
        pairs: edgePairs,
        source: 'feed',
        confidence: 1.0,
        createdBy: creatorUserId,
        claimKey,
        onConflict: 'ignore',
      });

      // 4) Reconcile DEPARTURES — the build is a full re-sync of each resource's
      // membership, so a `member_of` edge to a synced resource whose member is NOT
      // in the current set means that person left: soft-delete it so they lose
      // access immediately. Scoped to `to_entity_id` = a resource we just synced, so
      // edges to OTHER resource types (a different source's graph) are never touched.
      // An empty member set deletes all of that resource's edges — the caller must
      // not pass empty-on-fetch-error.
      let removedEdges = 0;
      for (const [resourceEntityId, resourceMembers] of currentMembersByResource) {
        removedEdges += await retractRelationshipClaimFromDepartures(tx, {
          organizationId,
          relationshipTypeId: typeId,
          toEntityId: resourceEntityId,
          claimKey,
          keepFromEntityIds: [...resourceMembers],
        });
      }
      return { createdEdges: created.length, removedEdges };
    },
  );

  if (params.markFresh !== false) {
    await markAclFresh(organizationId, connectionId, syncFence);
  }

  logger.info(
    {
      organization_id: organizationId,
      connection_id: connectionId,
      connector: connectorKey,
      resource_type: ACL_RESOURCE_TYPE_SLUG,
      resource_namespace: resourceNamespace,
      resources: Object.keys(resourceEntityIds).length,
      members: memberEntityIds.size,
      created_edges: createdEdges,
      removed_edges: removedEdges,
    },
    'Built access graph',
  );

  return {
    resourceEntityIds,
    memberEntityIds: [...memberEntityIds],
    createdEdges,
    removedEdges,
  };
}
