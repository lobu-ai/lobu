/**
 * Conflict-safe batch edge writes for first-party materializers.
 *
 * Four call sites had hand-rolled the same statement one round trip per edge.
 * Three agreed; `auto-linker` had copied it WITHOUT the conflict clause and put
 * a `SELECT` in front instead, so two concurrent linkers could both pass the
 * check and the second raise `23505`.
 *
 * Not a replacement for `relationship-validation.ts`, which guards the
 * caller-facing `manage_entity` surface: its `validateSource` accepts only
 * `ui|llm|feed|api` and would reject the `config`/`manual` sources reconcilers
 * own, and that surface raises a 409 on a duplicate triple where a materializer
 * wants an idempotent no-op.
 *
 * `force_delete_tree` keeps its hard-delete SQL separate because it depends on
 * the deletion order of the complete tree.
 */

import { type DbClient, getDb, pgBigintArray } from '../db/client';
import { RELATIONSHIP_CLAIMS_METADATA_KEY } from './relationship-claims';
import type { RelationshipTypePurpose } from './relationship-validation';

interface EdgePair {
  fromEntityId: number;
  toEntityId: number;
}

interface UpsertEdgesParams {
  db: DbClient;
  organizationId: string;
  relationshipTypeId: number;
  pairs: EdgePair[];
  source: string;
  confidence?: number | null;
  createdBy?: string | null;
  metadata?: object | null;
  claimKey: string;
  claim?: object;
  onConflict: 'ignore' | 'update';
}

/**
 * Find-or-create an org-scoped relationship type.
 *
 * `description` only lands on first create; an existing type keeps its current
 * description.
 *
 * `purpose` classifies the type for the ACL readers. Passing it also REPAIRS an
 * existing row, which matters because this statement adopts rather than
 * create-or-fails: without the repair, a row that predates the classification
 * (or that an older pod created mid-rollout) would stay unclassified forever and
 * its members would lose access once reads require it. Omitting `purpose` never
 * clears an existing one — `mentions` and `member_of` share this function, and a
 * mentions upsert must not strip an authorization stamp.
 */
export async function ensureRelationshipType(params: {
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  purpose?: RelationshipTypePurpose;
}): Promise<number> {
  const sql = getDb();
  const rows = await sql<{ id: number }>`
    INSERT INTO entity_relationship_types
      (slug, name, description, organization_id, is_symmetric, created_by, purpose, created_at, updated_at)
    VALUES
      (${params.slug}, ${params.name}, ${params.description}, ${params.organizationId},
       false, NULL, ${params.purpose ?? null}, current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE status = 'active'
    DO UPDATE SET
      updated_at = EXCLUDED.updated_at,
      purpose = COALESCE(EXCLUDED.purpose, entity_relationship_types.purpose)
    RETURNING id
  `;
  return Number(rows[0].id);
}

/**
 * Write directed edges of one type in a single statement. In `ignore` mode the
 * returned ids are newly created rows; in `update` mode they are created or
 * refreshed rows.
 */
export async function upsertEdges(params: UpsertEdgesParams): Promise<number[]> {
  const { db, organizationId, relationshipTypeId, source, onConflict } = params;

  // `ON CONFLICT DO UPDATE` cannot affect the same row twice in one statement.
  // Self-edges are dropped rather than written: identity resolution can collapse
  // two source keys onto one entity, and a self-loop is meaningless for every
  // type written here.
  const seen = new Set<string>();
  const pairs: EdgePair[] = [];
  for (const pair of params.pairs) {
    if (pair.fromEntityId === pair.toEntityId) continue;
    const key = `${pair.fromEntityId}:${pair.toEntityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
  }
  if (pairs.length === 0) return [];
  // `unnest` feeds the INSERT in array order. Keep new-triple conflicts in one
  // deterministic order; existing rows are prelocked by id in the statement
  // below, matching the relationship reconcilers.
  pairs.sort(
    (left, right) =>
      left.fromEntityId - right.fromEntityId || left.toEntityId - right.toEntityId
  );

  const froms = pairs.map((p) => p.fromEntityId);
  const tos = pairs.map((p) => p.toEntityId);

  const claim = { [params.claimKey]: params.claim ?? {} };
  const metadata = {
    ...(params.metadata ?? {}),
    [RELATIONSHIP_CLAIMS_METADATA_KEY]: claim,
  };
  const conflictAction =
    onConflict === 'update'
      ? db`DO UPDATE SET
            metadata =
              (EXCLUDED.metadata - ${RELATIONSHIP_CLAIMS_METADATA_KEY})
              || jsonb_build_object(
                   ${RELATIONSHIP_CLAIMS_METADATA_KEY}::text,
                   COALESCE(
                     entity_relationships.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY},
                     '{}'::jsonb
                   ) || (EXCLUDED.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY})
                 ),
            source = EXCLUDED.source,
            updated_by = EXCLUDED.updated_by,
            updated_at = current_timestamp`
      : db`DO UPDATE SET
            metadata = jsonb_set(
              COALESCE(entity_relationships.metadata, '{}'::jsonb),
              ARRAY[${RELATIONSHIP_CLAIMS_METADATA_KEY}]::text[],
              COALESCE(
                entity_relationships.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY},
                '{}'::jsonb
              ) || (EXCLUDED.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}),
              true
            ),
            updated_at = current_timestamp
          WHERE NOT (
            COALESCE(
              entity_relationships.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY},
              '{}'::jsonb
            ) ? ${params.claimKey}
          )`;

  // The non-negative count predicate is an execution barrier, not validation:
  // it forces the materialized lock CTE to finish before the INSERT can begin.
  const written = await db<{ id: number; inserted: boolean }>`
    WITH input(from_entity_id, to_entity_id) AS (
      SELECT *
      FROM unnest(
        ${pgBigintArray(froms)}::bigint[],
        ${pgBigintArray(tos)}::bigint[]
      )
    ),
    locked AS MATERIALIZED (
      SELECT r.id
      FROM input i
      JOIN entity_relationships r
        ON r.from_entity_id = i.from_entity_id
       AND r.to_entity_id = i.to_entity_id
       AND r.relationship_type_id = ${relationshipTypeId}
      WHERE r.organization_id = ${organizationId}
        AND r.deleted_at IS NULL
      ORDER BY r.id
      FOR UPDATE OF r
    )
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by, created_at, updated_at
    )
    SELECT
      ${organizationId}, v.from_entity_id, v.to_entity_id, ${relationshipTypeId},
      ${db.json(metadata)},
      ${params.confidence ?? null}, ${source},
      ${params.createdBy ?? null}, ${params.createdBy ?? null},
      current_timestamp, current_timestamp
    FROM input v
    CROSS JOIN (SELECT count(*) FROM locked) AS lock_barrier
    WHERE lock_barrier.count >= 0
    ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
      WHERE deleted_at IS NULL
    ${conflictAction}
    RETURNING id, (xmax = 0) AS inserted
  `;

  return written
    .filter((row) => onConflict === 'update' || row.inserted === true)
    .map((row) => Number(row.id));
}
