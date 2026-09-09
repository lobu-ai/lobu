/**
 * $member entity lifecycle utilities.
 * Used by auth hooks to auto-manage member entities when users join/leave orgs.
 *
 * All functions use skipHooks: true to prevent circular calls
 * (auth hook → ensureMemberEntity → createEntity → beforeCreate hook → invitation insert).
 */

import { unvalidatedEntityRowPatch, validateEntityRowPatch } from "../authz/entity-row-validation";
import { type DbClient, getDb } from '../db/client';
import {
  createEntity,
  type EntityData,
  patchEntityRows,
  withEntityWriteTransaction,
} from './entity-management';
import { ensureMemberEntityType, resolveMemberSchemaFieldsFromSchema } from './member-entity-type';

/**
 * Resolve annotated field names from the $member entity type's metadata_schema.
 * Uses the `x-email`/`x-image` annotations; falls back to 'email' for email.
 */
export async function resolveMemberSchemaFields(
  organizationId: string,
  sql: DbClient = getDb()
): Promise<{
  emailField: string;
  imageField?: string;
}> {
  const rows = await sql`
    SELECT metadata_schema FROM entity_types
    WHERE slug = '$member' AND deleted_at IS NULL AND organization_id = ${organizationId}
    LIMIT 1
  `;
  return resolveMemberSchemaFieldsFromSchema(
    (rows[0]?.metadata_schema as Record<string, unknown> | null | undefined) ?? null
  );
}

interface EnsureMemberEntityParams {
  organizationId: string;
  /**
   * The auth user whose IDENTITY this $member represents. Drives the
   * `auth_user_id` claim (source `auth:signup`) the authz gate resolves on, and
   * — for a self-provisioning caller — authorship. Pass this ONLY when the
   * member being provisioned is `userId`'s own row (sign-in, self-join). Never
   * pass a third party's id here: the claim is written onto the entity resolved
   * BY EMAIL, so a mismatched id would let that user resolve to — and inherit
   * the channel visibility of — this member. For a pending invitee (no signed-in
   * identity yet) leave this unset; use `createdByUserId` for authorship.
   */
  userId?: string;
  /**
   * Authorship-only attribution (entities.created_by), used when the actor
   * creating the row is NOT the member's own identity — e.g. an inviter creating
   * an invitee placeholder. Never writes an identity claim. Ignored when
   * `userId` is set (self-provisioning already covers authorship).
   */
  createdByUserId?: string;
  name: string;
  email: string;
  image?: string;
  role?: string;
  status?: 'active' | 'invited';
}

/**
 * Create a $member entity if one doesn't already exist for the given email in the org.
 * Ensures the built-in $member type has the expected metadata schema first.
 * Uses skipHooks to avoid circular invitation creation from auth callbacks.
 */
export async function ensureMemberEntity(params: EnsureMemberEntityParams): Promise<void> {
  const sql = getDb();

  await ensureMemberEntityType(params.organizationId);
  const { emailField, imageField } = await resolveMemberSchemaFields(params.organizationId);

  // Validate before creating the $member: checking after creation leaves a
  // claimless entity when userId does not own the email used for lookup.
  if (params.userId) {
    const owner = await sql<{ email: string | null }>`
      SELECT email FROM "user" WHERE id = ${params.userId} LIMIT 1
    `;
    const ownerEmail = owner[0]?.email?.trim().toLowerCase();
    if (ownerEmail !== params.email.trim().toLowerCase()) {
      throw new Error(
        `Refusing to provision $member for user ${params.userId}: user does not own the member email`
      );
    }
  }

  const findIdByEmail = async (): Promise<number | null> => {
    const rows = await sql.unsafe<{ id: number }>(
      `SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE et.slug = '$member'
        AND e.organization_id = $1
        AND e.metadata->>$2 = $3
        AND e.deleted_at IS NULL
      LIMIT 1`,
      [params.organizationId, emailField, params.email]
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  };

  // Check if a $member entity with this email already exists; create it if not.
  let memberEntityId = await findIdByEmail();
  if (memberEntityId === null) {
    const metadata: Record<string, unknown> = {
      [emailField]: params.email,
      status: params.status ?? 'active',
    };
    if (params.image && imageField) metadata[imageField] = params.image;
    if (params.role) metadata.role = params.role;

    const entityData: EntityData = {
      entity_type: '$member',
      name: params.name.trim(),
      organization_id: params.organizationId,
      metadata,
    };
    // Authorship: the member's own id when self-provisioning, else the explicit
    // actor (inviter). Identity attribution (the auth_user_id claim below) is a
    // SEPARATE concern — only `userId` ever drives it.
    const createdBy = params.userId ?? params.createdByUserId;
    if (createdBy) {
      entityData.created_by = createdBy;
    }
    await createEntity(entityData, { skipHooks: true });
    memberEntityId = await findIdByEmail();
  }

  // Write the org-scoped auth_user_id identity so identity-based resolution (the
  // authz channel-visibility gate's resolveRequesterMemberEntityId) can find this
  // member in THIS org — not only the user's personal org. Without it, a member
  // provisioned via a shared-org join (join-public) would resolve to nothing and
  // every enforced connection would fail closed for them. Idempotent, and applied
  // to existing members too so ones created before this gets backfilled. The
  // 'auth:signup' source is the gate's anti-hijack guard — only written here from
  // trusted server-side provisioning with a verified user id.
  if (params.userId && memberEntityId !== null) {
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector, scope_key
      ) VALUES (
        ${params.organizationId}, ${memberEntityId}, 'auth_user_id', ${params.userId}, 'auth:signup', NULL
      )
      ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
      DO NOTHING
    `;
  }
}

/**
 * Update a $member entity's status by email.
 */
export async function updateMemberEntityStatus(
  organizationId: string,
  email: string,
  status: string
): Promise<void> {
  await ensureMemberEntityType(organizationId);
  const { emailField } = await resolveMemberSchemaFields(organizationId);
  const sql = getDb();
  await withEntityWriteTransaction(sql, async (tx) => {
    // `OF e` keeps the lock on the member rows: a bare FOR UPDATE would also
    // lock the org's shared `$member` entity_types row, serializing unrelated
    // member writes against each other and against ensureMemberEntityType.
    const rows = await tx.unsafe<{ id: number; metadata: Record<string, unknown> | null }>(
      `SELECT e.id, e.metadata
       FROM entities e
       JOIN entity_types et ON et.id = e.entity_type_id
       WHERE et.slug = '$member'
         AND et.organization_id = $1
         AND et.deleted_at IS NULL
         AND e.organization_id = $1
         AND e.metadata->>$2 = $3
         AND e.deleted_at IS NULL
       ORDER BY e.id
       FOR UPDATE OF e`,
      [organizationId, emailField, email]
    );

    // Duplicate live members are legacy-invalid but the old status projection
    // updated all of them. Preserve that repair-friendly result while each
    // row's unrelated metadata survives the full-row kernel patch.
    for (const row of rows) {
      await patchEntityRows({
        tx,
        ids: [Number(row.id)],
        patch: await validateEntityRowPatch({
          tx,
          ids: [Number(row.id)],
          patch: { metadata: { ...(row.metadata ?? {}), status } },
        }),
      });
    }
  });
}

/** Project role/status using the trusted authentication identity claim. */
export async function updateMemberEntityAccess(
  organizationId: string,
  authUserId: string,
  updates: { role?: string; status?: 'active' | 'invited' },
  transaction?: DbClient,
): Promise<void> {
  const sql = transaction ?? getDb();
  await withEntityWriteTransaction(sql, async (tx) => {
    const rows = await tx.unsafe<{ id: number; metadata: Record<string, unknown> | null }>(
      `SELECT e.id, e.metadata
       FROM entities e
       JOIN entity_types et ON et.id = e.entity_type_id
       WHERE et.slug = '$member'
         AND et.organization_id = $1
         AND et.deleted_at IS NULL
         AND e.organization_id = $1
         AND EXISTS (
           SELECT 1 FROM entity_identities ei WHERE ei.entity_id = e.id
             AND ei.organization_id = e.organization_id AND ei.namespace = 'auth_user_id'
             AND ei.source_connector = 'auth:signup' AND ei.deleted_at IS NULL
             AND ei.identifier = $2
         )
         AND e.deleted_at IS NULL
       ORDER BY e.id
       LIMIT 1
       FOR UPDATE OF e`,
      [organizationId, authUserId]
    );
    if (rows.length === 0) return;

    const metadata = { ...(rows[0].metadata ?? {}) } as Record<string, unknown>;
    if (updates.role !== undefined) metadata.role = updates.role;
    if (updates.status !== undefined) metadata.status = updates.status;

    await patchEntityRows({
      tx,
      ids: [Number(rows[0].id)],
      patch: await validateEntityRowPatch({
        tx,
        ids: [Number(rows[0].id)],
        patch: { metadata },
      }),
    });
  });
}

/**
 * Delete a $member entity by email (soft-delete).
 */
export async function deleteMemberEntity(organizationId: string, email: string): Promise<void> {
  await ensureMemberEntityType(organizationId);
  const { emailField } = await resolveMemberSchemaFields(organizationId);
  const sql = getDb();
  await withEntityWriteTransaction(sql, async (tx) => {
    const rows = await tx.unsafe<{ id: number }>(
      `SELECT e.id
       FROM entities e
       JOIN entity_types et ON et.id = e.entity_type_id
       WHERE et.slug = '$member'
         AND et.organization_id = $1
         AND et.deleted_at IS NULL
         AND e.organization_id = $1
         AND e.metadata->>$2 = $3
         AND e.deleted_at IS NULL
       ORDER BY e.id
       FOR UPDATE OF e`,
      [organizationId, emailField, email]
    );
    await patchEntityRows({
      tx,
      ids: rows.map((row) => Number(row.id)),
      patch: unvalidatedEntityRowPatch({
        patch: { softDelete: true },
        reason:
          'membership deprovisioning: removing a user must never be blockable by a tenant state rule',
      }),
    });
  });
}
