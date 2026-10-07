/**
 * Source ownership for ordinary entity relationships.
 *
 * A live edge is one graph fact with one or more independent claims. Connector
 * claims are keyed by the same durable source identity as connector events:
 * (connection_id, origin_id). Reconciliation removes only that exact claim;
 * the edge is tombstoned only after its final claim disappears.
 */

import { type DbClient, pgBigintArray, pgTextArray } from '../db/client';
import { ToolUserError } from './errors';
import {
  assertNotAclManagedEdge,
  canonicalizeSymmetricEdge,
  validateNoSelfReference,
  validateTypeRule,
  withAclPrivilege,
} from './relationship-validation';

export const RELATIONSHIP_CLAIMS_METADATA_KEY = '_lobu_claims';
export const MANUAL_RELATIONSHIP_CLAIM_KEY = 'manual';
export const IDENTITY_DECISION_METADATA_KEY = '_lobu_identity_decision';

export interface ConnectorRelationshipDeclaration {
  type: string;
  from: string;
  to: string;
}

interface DesiredConnectorRelationship {
  declaration: ConnectorRelationshipDeclaration;
  fromEntityId: number;
  toEntityId: number;
}

interface RelationshipTypeRow {
  id: number | string;
  slug: string;
  is_symmetric: boolean;
  purpose: string | null;
}

interface ClaimedRelationshipRow {
  id: number | string;
  from_entity_id: number | string;
  to_entity_id: number | string;
  relationship_type_id: number | string;
  metadata: unknown;
  confidence: number | null;
  source: string | null;
  inserted?: boolean;
}

interface ClaimedRelationshipWithPurposeRow extends ClaimedRelationshipRow {
  relationship_type_slug: string | null;
  relationship_type_purpose: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function connectorRelationshipClaimKey(
  connectionId: number | string,
  originId: string
): string {
  return connectionRelationshipClaimKey(connectionId, `feed:${originId}`);
}

function connectionRelationshipClaimPrefix(connectionId: number | string): string {
  return `connection:${connectionId}:`;
}

export function connectionRelationshipClaimKey(
  connectionId: number | string,
  owner: string
): string {
  return `${connectionRelationshipClaimPrefix(connectionId)}${owner}`;
}

export function relationshipMetadataWithoutClaims(value: unknown): Record<string, unknown> | null {
  const metadata = record(value);
  if (!metadata) return null;
  const { [RELATIONSHIP_CLAIMS_METADATA_KEY]: _claims, ...visible } = metadata;
  return Object.keys(visible).length > 0 ? visible : null;
}

function claimsFromMetadata(value: unknown): Record<string, unknown> | null {
  const metadata = record(value);
  return record(metadata?.[RELATIONSHIP_CLAIMS_METADATA_KEY]);
}

export function assertManualRelationshipMutationAllowed(
  row: { id: number | string; metadata: unknown },
  action: string
): void {
  const claims = claimsFromMetadata(row.metadata);
  if (!claims) throw migrationRequired(row);
  if (!Object.hasOwn(claims, MANUAL_RELATIONSHIP_CLAIM_KEY)) {
    throw new ToolUserError(
      `Relationship ${row.id} is source-managed and cannot be ${action} manually. ` +
        'Change or remove it through the connector that owns its remaining claims.',
      409
    );
  }
}

export function assertNoReservedRelationshipMetadata(metadata: unknown): void {
  const reserved = record(metadata) && [RELATIONSHIP_CLAIMS_METADATA_KEY, IDENTITY_DECISION_METADATA_KEY].find(key => Object.hasOwn(metadata as object, key));
  if (reserved) {
    throw new ToolUserError(
      `Metadata key '${reserved}' is reserved for relationship ownership.`,
      400
    );
  }
}

function migrationRequired(row: { id: number | string }): ToolUserError {
  return new ToolUserError(
    `Relationship ${row.id} has no ${RELATIONSHIP_CLAIMS_METADATA_KEY} ownership metadata. ` +
      'Migrate the relationship to a manual or source claim before connector ingestion.',
    409
  );
}

export async function lockOrganizationForRelationshipClaims(
  tx: DbClient,
  organizationId: string
): Promise<void> {
  const rows = await tx`
    SELECT 1 FROM organization
    WHERE id = ${organizationId}
    FOR KEY SHARE
  `;
  if (rows.length === 0) throw new ToolUserError('Organization not found', 404);
}

export async function lockLiveConnectionForRelationshipClaims(
  tx: DbClient,
  organizationId: string,
  connectionId: number
): Promise<void> {
  const rows = await tx`
    SELECT 1 FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    FOR SHARE
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Connection ${connectionId} is not active`, 409);
  }
}

interface RelationshipClaimParams {
  organizationId: string;
  fromEntityId: number;
  toEntityId: number;
  relationshipTypeId: number;
  claimKey: string;
  claim: Record<string, unknown>;
  source: string;
  confidence?: number | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown> | null;
}

type RelationshipClaimResult = { id: number; inserted: boolean; claimAdded: boolean };

function initialRelationshipMetadata(params: RelationshipClaimParams): Record<string, unknown> {
  return {
    ...(params.metadata ?? {}),
    [RELATIONSHIP_CLAIMS_METADATA_KEY]: { [params.claimKey]: params.claim },
  };
}

async function lockExistingRelationship(
  tx: DbClient,
  params: RelationshipClaimParams
): Promise<ClaimedRelationshipRow> {
  const rows = await tx<ClaimedRelationshipRow>`
    SELECT id, from_entity_id, to_entity_id, relationship_type_id,
           metadata, confidence, source
    FROM entity_relationships
    WHERE organization_id = ${params.organizationId}
      AND from_entity_id = ${params.fromEntityId}
      AND to_entity_id = ${params.toEntityId}
      AND relationship_type_id = ${params.relationshipTypeId}
      AND deleted_at IS NULL
    LIMIT 1
    FOR UPDATE
  `;
  if (!rows[0]) throw new Error('Relationship claim insert returned no live relationship');
  return rows[0];
}

function finishRelationshipClaimWrite(row: ClaimedRelationshipRow): RelationshipClaimResult {
  const inserted = row.inserted === true;
  return { id: Number(row.id), inserted, claimAdded: true };
}

async function insertOnlyRelationshipClaim(
  tx: DbClient,
  params: RelationshipClaimParams
): Promise<RelationshipClaimResult> {
  const written = await tx<ClaimedRelationshipRow>`
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${params.organizationId}, ${params.fromEntityId}, ${params.toEntityId},
      ${params.relationshipTypeId}, ${tx.json(initialRelationshipMetadata(params))},
      ${params.confidence ?? null}, ${params.source}, ${params.createdBy ?? null},
      ${params.createdBy ?? null}, current_timestamp, current_timestamp
    )
    ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
      WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING id, from_entity_id, to_entity_id, relationship_type_id,
              metadata, confidence, source, true AS inserted
  `;
  if (written[0]) return finishRelationshipClaimWrite(written[0]);
  const existing = await lockExistingRelationship(tx, params);
  return { id: Number(existing.id), inserted: false, claimAdded: false };
}

async function mergeRelationshipClaim(
  tx: DbClient,
  params: RelationshipClaimParams
): Promise<RelationshipClaimResult> {
  const written = await tx<ClaimedRelationshipRow>`
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${params.organizationId}, ${params.fromEntityId}, ${params.toEntityId},
      ${params.relationshipTypeId}, ${tx.json(initialRelationshipMetadata(params))},
      ${params.confidence ?? null}, ${params.source}, ${params.createdBy ?? null},
      ${params.createdBy ?? null}, current_timestamp, current_timestamp
    )
    ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
      WHERE deleted_at IS NULL
    DO UPDATE SET
      metadata = jsonb_set(
        COALESCE(entity_relationships.metadata, '{}'::jsonb),
        ARRAY[${RELATIONSHIP_CLAIMS_METADATA_KEY}]::text[],
        (entity_relationships.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY})
          || jsonb_build_object(${params.claimKey}::text, ${tx.json(params.claim)}::jsonb),
        true
      ),
      updated_at = current_timestamp
    WHERE entity_relationships.metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
      AND entity_relationships.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY} -> ${params.claimKey}
          IS DISTINCT FROM ${tx.json(params.claim)}::jsonb
    RETURNING id, from_entity_id, to_entity_id, relationship_type_id,
              metadata, confidence, source, (xmax = 0) AS inserted
  `;
  if (written[0]) return finishRelationshipClaimWrite(written[0]);

  const existing = await lockExistingRelationship(tx, params);
  const claims = claimsFromMetadata(existing.metadata);
  if (!claims) throw migrationRequired(existing);
  if (!Object.hasOwn(claims, params.claimKey)) {
    throw new Error(`Relationship ${existing.id} did not persist claim '${params.claimKey}'`);
  }
  return { id: Number(existing.id), inserted: false, claimAdded: false };
}

/** Add the caller-owned claim to a manual relationship assertion. */
export async function assertManualRelationshipClaim(
  tx: DbClient,
  params: {
    organizationId: string;
    fromEntityId: number;
    toEntityId: number;
    relationshipTypeId: number;
    source: string;
    confidence?: number | null;
    createdBy?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<RelationshipClaimResult> {
  await lockOrganizationForRelationshipClaims(tx, params.organizationId);
  return insertOnlyRelationshipClaim(tx, {
    ...params,
    claimKey: MANUAL_RELATIONSHIP_CLAIM_KEY,
    claim: {},
  });
}

async function retractLockedRelationshipClaims(
  tx: DbClient,
  params: {
    claimKeys: readonly string[];
    row: ClaimedRelationshipRow;
    updatedBy?: string | null;
  }
): Promise<{ relationshipRemoved: boolean }> {
  const claims = claimsFromMetadata(params.row.metadata);
  if (!claims) throw migrationRequired(params.row);
  const retracted = params.claimKeys.filter((key) => Object.hasOwn(claims, key));
  if (retracted.length === 0) {
    throw new Error(
      `Relationship ${params.row.id} does not carry claim '${params.claimKeys.join("', '")}'`
    );
  }
  const relationshipId = Number(params.row.id);
  const remainingClaims = Object.keys(claims).filter((key) => !retracted.includes(key));
  if (remainingClaims.length > 0) {
    await tx`
      UPDATE entity_relationships
      SET metadata = jsonb_set(
            metadata,
            ARRAY[${RELATIONSHIP_CLAIMS_METADATA_KEY}]::text[],
            (metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) - ${pgTextArray([...retracted])}::text[],
            true
          ),
          updated_by = COALESCE(${params.updatedBy ?? null}, updated_by),
          updated_at = current_timestamp
      WHERE id = ${relationshipId} AND deleted_at IS NULL
    `;
    return { relationshipRemoved: false };
  }

  await tx`
    UPDATE entity_relationships
    SET deleted_at = current_timestamp,
        updated_by = COALESCE(${params.updatedBy ?? null}, updated_by),
        updated_at = current_timestamp
    WHERE id = ${relationshipId} AND deleted_at IS NULL
  `;
  return { relationshipRemoved: true };
}

/** Remove only the manual claim; retain a source-claimed edge. */
export async function retractManualRelationshipClaim(
  tx: DbClient,
  params: {
    organizationId: string;
    relationshipId: number;
    updatedBy?: string | null;
  }
): Promise<{
  relationshipRemoved: boolean;
  relationship: {
    id: number;
    fromEntityId: number;
    toEntityId: number;
    relationshipTypeId: number;
    relationshipTypeSlug: string | null;
    metadata: Record<string, unknown> | null;
    confidence: number | null;
    source: string | null;
  };
}> {
  await lockOrganizationForRelationshipClaims(tx, params.organizationId);
  const rows = await tx<ClaimedRelationshipWithPurposeRow>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relationship_type_id,
           rt.slug AS relationship_type_slug, rt.purpose AS relationship_type_purpose,
           r.metadata, r.confidence, r.source
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.id = ${params.relationshipId}
      AND r.organization_id = ${params.organizationId}
      AND r.deleted_at IS NULL
    LIMIT 1
    FOR UPDATE OF r
  `;
  const row = rows[0];
  if (!row) throw new ToolUserError(`Relationship ${params.relationshipId} not found`, 404);
  assertNotAclManagedEdge(
    { slug: row.relationship_type_slug, purpose: row.relationship_type_purpose },
    'unlink'
  );
  assertManualRelationshipMutationAllowed(row, 'unlinked');
  const result = await retractLockedRelationshipClaims(tx, {
    claimKeys: [MANUAL_RELATIONSHIP_CLAIM_KEY],
    row,
    updatedBy: params.updatedBy,
  });
  return {
    ...result,
    relationship: {
      id: Number(row.id),
      fromEntityId: Number(row.from_entity_id),
      toEntityId: Number(row.to_entity_id),
      relationshipTypeId: Number(row.relationship_type_id),
      relationshipTypeSlug: row.relationship_type_slug,
      metadata: relationshipMetadataWithoutClaims(row.metadata),
      confidence: row.confidence,
      source: row.source,
    },
  };
}

export async function retractRelationshipClaimExcept(
  tx: DbClient,
  params: {
    organizationId: string;
    claimKey: string;
    keepRelationshipIds: ReadonlySet<number>;
  }
): Promise<void> {
  const rows = await tx<ClaimedRelationshipRow>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relationship_type_id,
           r.metadata, r.confidence, r.source
    FROM entity_relationships r
    WHERE r.organization_id = ${params.organizationId}
      AND r.deleted_at IS NULL
      AND r.metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
      AND (r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) ? ${params.claimKey}
    ORDER BY r.id
    FOR UPDATE OF r
  `;

  for (const row of rows) {
    if (params.keepRelationshipIds.has(Number(row.id))) continue;
    await retractLockedRelationshipClaims(tx, {
      claimKeys: [params.claimKey],
      row,
    });
  }
}

/** Retract one owner's claims for members absent from a complete destination sync. */
export async function retractRelationshipClaimFromDepartures(
  tx: DbClient,
  params: {
    organizationId: string;
    relationshipTypeId: number;
    toEntityId: number;
    claimKey: string;
    keepFromEntityIds: readonly number[];
  }
): Promise<number> {
  const rows = await tx<ClaimedRelationshipRow>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relationship_type_id,
           r.metadata, r.confidence, r.source
    FROM entity_relationships r
    WHERE r.organization_id = ${params.organizationId}
      AND r.relationship_type_id = ${params.relationshipTypeId}
      AND r.to_entity_id = ${params.toEntityId}
      AND r.deleted_at IS NULL
      AND r.metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
      AND (r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) ? ${params.claimKey}
      AND r.from_entity_id <> ALL(${pgBigintArray([...params.keepFromEntityIds])}::bigint[])
    ORDER BY r.id
    FOR UPDATE OF r
  `;

  let removedRelationships = 0;
  for (const row of rows) {
    const { relationshipRemoved } = await retractLockedRelationshipClaims(tx, {
      claimKeys: [params.claimKey],
      row,
    });
    if (relationshipRemoved) removedRelationships++;
  }
  return removedRelationships;
}

/** Reconcile one connector event's complete declared relationship set. */
export async function reconcileConnectorRelationshipClaims(
  tx: DbClient,
  params: {
    organizationId: string;
    connectionId: number;
    originId: string;
    desired: DesiredConnectorRelationship[];
  }
): Promise<void> {
  const claimKey = connectorRelationshipClaimKey(params.connectionId, params.originId);
  if (params.desired.length === 0) {
    const existing = await tx`
      SELECT 1
      FROM entity_relationships
      WHERE organization_id = ${params.organizationId}
        AND deleted_at IS NULL
        AND metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
        AND (metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) ? ${claimKey}
      LIMIT 1
    `;
    if (existing.length === 0) return;
  }

  await lockOrganizationForRelationshipClaims(tx, params.organizationId);
  await lockLiveConnectionForRelationshipClaims(
    tx,
    params.organizationId,
    params.connectionId
  );

  const typeSlugs = [...new Set(params.desired.map((edge) => edge.declaration.type))];
  const typeRows =
    typeSlugs.length === 0
      ? []
      : await tx<RelationshipTypeRow>`
          SELECT id, slug, is_symmetric, purpose
          FROM entity_relationship_types
          WHERE organization_id = ${params.organizationId}
            AND slug = ANY(${pgTextArray(typeSlugs)}::text[])
            AND status = 'active'
            AND deleted_at IS NULL
        `;
  const typeBySlug = new Map(typeRows.map((row) => [row.slug, row]));
  for (const slug of typeSlugs) {
    const type = typeBySlug.get(slug);
    if (!type) {
      throw new ToolUserError(`Connector relationship type '${slug}' is not active`, 409);
    }
    assertNotAclManagedEdge(type, 'connector relationship materialization');
    if (type.purpose === 'identity') {
      throw new ToolUserError('Connector evidence cannot materialize identity-purpose relationships', 409);
    }
  }

  const aggregated = new Map<
    string,
    {
      fromEntityId: number;
      toEntityId: number;
      relationshipTypeId: number;
    }
  >();
  for (const desired of params.desired) {
    const type = typeBySlug.get(desired.declaration.type)!;
    validateNoSelfReference(desired.fromEntityId, desired.toEntityId);
    await validateTypeRule(
      Number(type.id),
      desired.fromEntityId,
      desired.toEntityId,
      tx
    );
    const endpoints = type.is_symmetric
      ? canonicalizeSymmetricEdge(desired.fromEntityId, desired.toEntityId)
      : { from: desired.fromEntityId, to: desired.toEntityId };
    const key = `${endpoints.from}:${endpoints.to}:${type.id}`;
    if (!aggregated.has(key)) {
      aggregated.set(key, {
        fromEntityId: endpoints.from,
        toEntityId: endpoints.to,
        relationshipTypeId: Number(type.id),
      });
    }
  }

  const keepRelationshipIds = new Set<number>();
  const orderedEdges = [...aggregated.values()].sort(
    (left, right) =>
      left.fromEntityId - right.fromEntityId ||
      left.toEntityId - right.toEntityId ||
      left.relationshipTypeId - right.relationshipTypeId
  );

  // A move asserts the new triple before retracting the old one. Lock both the
  // desired existing rows and every row this source currently owns in one
  // ascending-id pass, so two sources swapping edges cannot each hold their
  // destination while waiting to retract the other's source row.
  //
  // The two candidate sets are collected separately so each keeps its own index
  // (`idx_entity_relationships_live_triple` and `idx_entity_relationships_live_claims`).
  // ORing them in a single predicate turns this into a scan of the org's whole
  // live edge set, once per ingested item.
  const desiredFroms = orderedEdges.map((edge) => edge.fromEntityId);
  const desiredTos = orderedEdges.map((edge) => edge.toEntityId);
  const desiredTypeIds = orderedEdges.map((edge) => edge.relationshipTypeId);
  await tx`
    WITH desired(from_entity_id, to_entity_id, relationship_type_id) AS (
      SELECT *
      FROM unnest(
        ${pgBigintArray(desiredFroms)}::bigint[],
        ${pgBigintArray(desiredTos)}::bigint[],
        ${pgBigintArray(desiredTypeIds)}::bigint[]
      )
    ),
    candidates AS (
      SELECT r.id
      FROM desired d
      JOIN entity_relationships r
        ON r.from_entity_id = d.from_entity_id
       AND r.to_entity_id = d.to_entity_id
       AND r.relationship_type_id = d.relationship_type_id
      WHERE r.organization_id = ${params.organizationId}
        AND r.deleted_at IS NULL
      UNION
      SELECT r.id
      FROM entity_relationships r
      WHERE r.organization_id = ${params.organizationId}
        AND r.deleted_at IS NULL
        AND r.metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
        AND (r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) ? ${claimKey}
    )
    SELECT r.id
    FROM entity_relationships r
    WHERE r.id IN (SELECT id FROM candidates)
    ORDER BY r.id
    FOR UPDATE OF r
  `;

  for (const edge of orderedEdges) {
    const asserted = await mergeRelationshipClaim(tx, {
      organizationId: params.organizationId,
      fromEntityId: edge.fromEntityId,
      toEntityId: edge.toEntityId,
      relationshipTypeId: edge.relationshipTypeId,
      claimKey,
      claim: {},
      source: 'feed',
    });
    keepRelationshipIds.add(asserted.id);
  }

  await retractRelationshipClaimExcept(tx, {
    organizationId: params.organizationId,
    claimKey,
    keepRelationshipIds,
  });
}

/** Remove every feed or config relationship claim owned by a connection. */
export async function retractConnectionRelationshipClaims(
  tx: DbClient,
  params: { organizationId: string; connectionId: number | string }
): Promise<void> {
  await lockOrganizationForRelationshipClaims(tx, params.organizationId);
  const prefix = connectionRelationshipClaimPrefix(params.connectionId);
  await withAclPrivilege(tx, async () => {
    // One ascending-id pass over the org's live claimed edges, retracting every
    // key this connection owns per row. Resolving the distinct claim keys first
    // and re-scanning per key would cost one scan per ingested source item,
    // inside the connection-delete transaction that already holds these rows.
    // The prefix predicate cannot use the exact-claim GIN index, so this scan is
    // deliberately constrained to one organization and runs only on deletion.
    const rows = await tx<ClaimedRelationshipRow>`
      SELECT r.id, r.from_entity_id, r.to_entity_id, r.relationship_type_id,
             r.metadata, r.confidence, r.source
      FROM entity_relationships r
      WHERE r.organization_id = ${params.organizationId}
        AND r.deleted_at IS NULL
        AND r.metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
        AND EXISTS (
          SELECT 1
          FROM jsonb_object_keys(r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) AS claim(key)
          WHERE left(claim.key, length(${prefix})) = ${prefix}
        )
      ORDER BY r.id
      FOR UPDATE OF r
    `;

    for (const row of rows) {
      const claims = claimsFromMetadata(row.metadata);
      if (!claims) throw migrationRequired(row);
      await retractLockedRelationshipClaims(tx, {
        claimKeys: Object.keys(claims).filter((key) => key.startsWith(prefix)),
        row,
      });
    }
  });
}
