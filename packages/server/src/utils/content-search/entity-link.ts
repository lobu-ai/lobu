/**
 * Entity-link SQL helpers: event-recall identity namespaces,
 * entityLinkMatchSql, EntityIdentityScope, fetchEntityIdentityScopes,
 * buildEntityLinkUnion.
 */

import { EVENT_RECALL_IDENTITY_NAMESPACES } from '@lobu/connector-sdk/identity-namespaces';
import { type DbClient, pgTextArray } from '../../db/client';
import { identityMemberIdsSql } from '../entity-identity';
import { CONNECTOR_RECALL_NAMESPACES } from '../../identity/connector-identity-modules';
import {
  IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY,
  ORGANIZATION_SCOPE_PROJECTION,
} from '../../identity/scope-projection';

/**
 * Identity namespaces backed by partial BTREE indexes on `events.metadata`.
 *
 * The canonical registry lives in connector-sdk so connectors, the identity
 * engine, and read-time recall share one vocabulary. This server-side export
 * assembles the registry used by event-attribution recall and its index invariant.
 *
 * Non-recall namespaces are intentionally unsupported here: without a matching
 * index the identity branch seq-scans `events`, which blows up the entire
 * content query. If a connector needs a new recall namespace, declare it in the
 * connector's identity module (`recallNamespaces`) and add the matching
 * `idx_events_metadata_<ns>` migration — a startup/CI invariant asserts the two
 * stay in sync.
 *
 * The generic recall namespaces come from connector-sdk; the connector-specific
 * ones are contributed by each connector module and assembled server-side.
 */
export const STANDARD_IDENTITY_NAMESPACES: readonly string[] = [
  ...EVENT_RECALL_IDENTITY_NAMESPACES,
  ...CONNECTOR_RECALL_NAMESPACES,
];

/**
 * SQL predicate: "event `<alias>` is linked to entity `<paramRef>`".
 *
 * Matches two ways:
 *   1. Direct attribution: a group member appears in
 *      `events.entity_ids`.
 *   2. Identity-graph attribution: a group member's live `entity_identities` row claims an
 *      identifier that the event carries in `metadata->>namespace` (stamped
 *      there by `applyEventAttributions` at ingestion; see src/utils/entity-link-upsert.ts).
 *
 * Events are append-only, so (2) is how connector-driven auto-linking is
 * surfaced at read time — `entity_ids` is never mutated post-insert.
 *
 * Shape: `alias.id IN (WITH entity_link_ids AS MATERIALIZED (UNION …) SELECT id FROM entity_link_ids)`.
 * Each standard namespace gets its own UNION branch with a literal
 * `ei.namespace = '<ns>'` so Postgres can evaluate the join against
 * `entity_identities` first, then probe `events` via the per-namespace
 * partial BTREE index `idx_events_metadata_<ns>`. Writing this as a top-level
 * OR of EXISTS branches — or as a single identity branch with `OR` across
 * namespaces — forces Parallel Seq Scan on `events` because the namespace
 * becomes a join filter instead of a restrictable predicate.
 *
 * MATERIALIZED keeps the candidate-id union separate from the outer event
 * scan so the branches can use their attribution indexes.
 */
export function entityLinkMatchSql(paramRef: string, alias = 'f'): string {
  const directBranch = directEntityLinkBranch(paramRef);

  const standardBranches = STANDARD_IDENTITY_NAMESPACES.map(
    (ns) => `SELECT e2.id FROM events e2
      JOIN entity_identities ei
        ON ei.entity_id IN (${identityMemberIdsSql(paramRef)})
       AND ei.namespace = '${ns}'
       AND ei.deleted_at IS NULL
      WHERE e2.metadata ? '${ns}'
        AND e2.metadata->>'${ns}' = ei.identifier
        AND COALESCE((e2.metadata->'${IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY}')->>'${ns}', '${ORGANIZATION_SCOPE_PROJECTION}') = COALESCE(ei.scope_key, '${ORGANIZATION_SCOPE_PROJECTION}')`
  );

  const branches = [directBranch, ...standardBranches].join('\n    UNION\n    ');
  return `${alias}.id IN (WITH entity_link_ids AS MATERIALIZED (\n    ${branches}\n  ) SELECT id FROM entity_link_ids)`;
}

/** Match the IDs of the current identity component. */
function directEntityLinkBranch(entityRef: string): string {
  return `SELECT e2.id FROM events e2
    WHERE e2.entity_ids && ARRAY(
      ${identityMemberIdsSql(entityRef)}
    )`;
}

/**
 * One identity claim for an entity — `(namespace, identifier, scope key)`.
 *
 * Used by `fetchEntityIdentityScopes` + `buildEntityLinkUnion` to skip the
 * UNION branches that would never match for this entity. On a 4.7GB events
 * table the empty-branches-still-cost-real-time issue is the difference
 * between 200ms and 1.2s on the candidate_set scan alone.
 */
export interface EntityIdentityScope {
  namespace: string;
  identifier: string;
  scopeKey: string | null;
}

/**
 * Pre-fetch live identity claims for the current group, restricted to
 * the namespaces we have backing indexes for (`STANDARD_IDENTITY_NAMESPACES`).
 *
 * Cheap: indexed scan via `idx_entity_identities_by_entity`. Typical entity
 * has 0-3 rows. Run once per request, not per query.
 */
export async function fetchEntityIdentityScopes(
  sql: DbClient,
  entityId: number
): Promise<EntityIdentityScope[]> {
  const rows = (await sql.unsafe(`
    SELECT identity.namespace,
           identity.identifier,
           identity.scope_key
    FROM entity_identities identity
    WHERE identity.entity_id IN (${identityMemberIdsSql('$1::bigint')})
      AND identity.deleted_at IS NULL
      AND identity.namespace = ANY($2::text[])
  `, [entityId, pgTextArray([...STANDARD_IDENTITY_NAMESPACES])])) as Array<{ namespace: unknown; identifier: unknown; scope_key: unknown }>;
  return rows.map((r) => ({
    namespace: String(r.namespace),
    identifier: String(r.identifier),
    scopeKey: r.scope_key == null ? null : String(r.scope_key),
  }));
}

/**
 * Build the same materialized candidate-id predicate as `entityLinkMatchSql`,
 * but emit only the branches an entity actually needs.
 *
 * Differences from `entityLinkMatchSql`:
 *  - The direct `entity_ids && ARRAY[group members]` branch is always included.
 *  - One `metadata->>'<ns>' = $N` branch per pre-fetched scope (no JOIN to
 *    `entity_identities`; the identifier is bound as a parameter). For an
 *    entity with no identities, that's zero extra branches — Postgres only
 *    plans the direct scan.
 *  - Uses an inline `entityIdLiteral` (already validated as a numeric id) so
 *    the planner sees the actual id and picks the entity-specific GIN scan
 *    instead of building a generic plan.
 *
 * Identifier values are bound params (caller appends them to its params
 * array), defending against tampering even though `entity_identities` is
 * write-controlled.
 */
export function buildEntityLinkUnion(opts: {
  /** Already-validated entity id, will be inlined as `<id>::bigint`. */
  entityIdLiteral: number;
  scopes: EntityIdentityScope[];
  alias?: string;
  baseParamIndex: number;
}): { sql: string; params: string[] } {
  const alias = opts.alias ?? 'f';
  const { branches, params } = buildEntityLinkBranches({
    entityIdLiteral: opts.entityIdLiteral,
    scopes: opts.scopes,
    baseParamIndex: opts.baseParamIndex,
  });
  return {
    sql: `${alias}.id IN (WITH entity_link_ids AS MATERIALIZED (\n    ${branches.join('\n    UNION\n    ')}\n  ) SELECT id FROM entity_link_ids)`,
    params,
  };
}

/**
 * The standalone `SELECT e2.id ...` branches behind {@link buildEntityLinkUnion}:
 * always the direct `entity_ids` branch, plus one indexed probe per pre-fetched
 * identity scope. Batch counts apply org/liveness/visibility filters to each
 * branch before deduplication, avoiding an outer scan of the event table.
 */
export function buildEntityLinkBranches(opts: {
  /** Already-validated entity id, will be inlined as `<id>::bigint`. */
  entityIdLiteral: number;
  scopes: EntityIdentityScope[];
  baseParamIndex: number;
  /**
   * Override for the direct branch's member array. Defaults to the recursive
   * identity-members CTE; pass `` `ARRAY[<id>]` `` when the entity provably
   * has no identity edges (its own whole group) to skip graph traversal.
   */
  directMembersSql?: string;
}): { branches: string[]; params: string[] } {
  const direct = opts.directMembersSql
    ? `SELECT e2.id FROM events e2 WHERE e2.entity_ids && ${opts.directMembersSql}`
    : directEntityLinkBranch(`${opts.entityIdLiteral}::bigint`);
  const params: string[] = [];
  let paramIndex = opts.baseParamIndex;

  // Skip namespaces we have no backing index for (e.g. anything outside
  // STANDARD_IDENTITY_NAMESPACES) — they'd seq-scan events. The fetch helper
  // already filters to the standard list, but we double-check here so a
  // future caller that builds scopes manually can't blow up the scan.
  const indexed = new Set<string>(STANDARD_IDENTITY_NAMESPACES);
  const scopeBranches: string[] = [];
  for (const scope of opts.scopes) {
    if (!indexed.has(scope.namespace)) continue;
    params.push(scope.identifier, scope.scopeKey ?? ORGANIZATION_SCOPE_PROJECTION);
    scopeBranches.push(
      `SELECT e2.id FROM events e2 WHERE e2.metadata ? '${scope.namespace}' AND e2.metadata->>'${scope.namespace}' = $${paramIndex} AND COALESCE((e2.metadata->'${IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY}')->>'${scope.namespace}', '${ORGANIZATION_SCOPE_PROJECTION}') = $${paramIndex + 1}`
    );
    paramIndex += 2;
  }

  return { branches: [direct, ...scopeBranches], params };
}
