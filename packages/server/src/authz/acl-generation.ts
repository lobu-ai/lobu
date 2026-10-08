import { type DbClient, getDb } from '../db/client.js';

/**
 * The pair a sync must capture BEFORE it reads anything — provider snapshot or
 * membership — and carry through to its fresh stamp.
 */
export interface AclSyncFence {
  /** Cutoff for the secondary same-generation ordering fence. */
  startedAt: string;
  /** Null only when the organization row is absent. */
  generation: string | null;
}

/**
 * Capture the cutoff and the generation in ONE statement.
 *
 * Two statements would let an invalidation land between them and produce an
 * incoherent fence: a generation from before it paired with a cutoff from
 * after, which passes both checks while describing neither state.
 */
export async function captureAclSyncFence(
  orgId: string,
  sql: DbClient = getDb()
): Promise<AclSyncFence> {
  const [observed] = await sql<{
    sync_started_at: string;
    acl_generation: string | null;
  }>`
    SELECT clock_timestamp()::text AS sync_started_at,
           (SELECT o.acl_generation::text FROM organization o WHERE o.id = ${orgId})
             AS acl_generation
  `;
  return {
    startedAt: observed.sync_started_at,
    generation: observed.acl_generation ?? null,
  };
}

/**
 * Invalidate in-flight ACL syncs for an organization.
 *
 * This must share the transaction that mutates the projection. Committing the
 * bump separately could let a sync observe it without the mutation it fences.
 */
export async function bumpAclGeneration(tx: DbClient, orgId: string): Promise<void> {
  await tx`
    UPDATE organization
    SET acl_generation = acl_generation + 1
    WHERE id = ${orgId}
  `;
}

/**
 * Take the organization row FIRST, before a transaction locks any row beneath
 * it that will later bump the generation.
 *
 * Organization deletion locks the org row and then cascades into `entities`,
 * `connections`, and the rest. A transaction that locks entity or connection
 * rows first and only afterwards updates `organization` inverts that order and
 * deadlocks against a concurrent delete. Every invalidating transaction —
 * relationship retraction and force-delete — therefore claims the
 * parent up front.
 */
export async function lockOrgForAclInvalidation(
  tx: DbClient,
  orgId: string
): Promise<void> {
  await tx`
    SELECT 1
    FROM organization
    WHERE id = ${orgId}
    FOR UPDATE
  `;
}

/** Fail closed every ACL projection whose entity graph changed outside a sync. */
export async function invalidateOrgAcl(tx: DbClient, orgId: string): Promise<void> {
  // Lock the generation before ACL-state rows. `markAclFresh` uses the same
  // order, so its comparison cannot read an old generation and then wait behind
  // the invalidation's state-row lock.
  await bumpAclGeneration(tx, orgId);
  await tx`
    UPDATE authz_source_acl_state
    SET freshness_state = 'stale', updated_at = clock_timestamp()
    WHERE organization_id = ${orgId}
  `;
}
