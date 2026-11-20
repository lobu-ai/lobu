/**
 * The `workspace-purge` task: reclaim a deleted workspace's storage.
 *
 * This task removes a requested workspace's rows in the background
 * (docs/design/workspace-deletion.md).
 * One FK cascade from `organization` cannot do it: a large workspace's
 * `events` → `event_embeddings` cascade outlives the statement timeout, a
 * handful of org-scoped tables have no FK to `organization` at all, and the
 * cascade through `oauth_clients` reaches other workspaces' tokens and events.
 *
 * Every step is idempotent and keyed only on the organization id, so a lost
 * lease or a crash simply resumes: the next attempt finds fewer rows. Each
 * batch commits on its own and is fenced on this task's lease, so a reclaimed
 * task never has two holders deleting at once.
 */

import { releaseClientHomedInOrganization } from '../auth/oauth/clients';
import { type DbClient, getDb, pgBigintArray } from '../db/client';
import { hardDeleteEntityRows, repointEntityRowsToOwnType } from '../utils/entity-management';
import { IDENTITY_DECISION_METADATA_KEY } from '../utils/relationship-claims';
import {
  lockIdentityOrganization,
  withAclPrivilege,
  withIdentityPrivilege,
} from '../utils/relationship-validation';
import logger from '../utils/logger';
import { DELETION_REQUESTED_AT_KEY } from './deletion-state';
import type { WorkspacePurgeTaskPayload } from './deletion';

export const WORKSPACE_PURGE_BATCH_SIZE = 2_000;

/** One literal batch delete per table this module empties by organization. */
const PURGE_BATCH_DELETES = {
  events:
    'DELETE FROM events WHERE ctid IN (SELECT ctid FROM events WHERE organization_id = $1 LIMIT $2)',
  runs:
    'DELETE FROM runs WHERE ctid IN (SELECT ctid FROM runs WHERE organization_id = $1 LIMIT $2)',
  agent_secrets:
    'DELETE FROM agent_secrets WHERE ctid IN (SELECT ctid FROM agent_secrets WHERE organization_id = $1 LIMIT $2)',
  agent_users:
    'DELETE FROM agent_users WHERE ctid IN (SELECT ctid FROM agent_users WHERE organization_id = $1 LIMIT $2)',
  authz_source_acl_state:
    'DELETE FROM authz_source_acl_state WHERE ctid IN (SELECT ctid FROM authz_source_acl_state WHERE organization_id = $1 LIMIT $2)',
  automation_reactions:
    'DELETE FROM automation_reactions WHERE ctid IN (SELECT ctid FROM automation_reactions WHERE organization_id = $1 LIMIT $2)',
  channel_messages:
    'DELETE FROM channel_messages WHERE ctid IN (SELECT ctid FROM channel_messages WHERE organization_id = $1 LIMIT $2)',
  classify_facet:
    'DELETE FROM classify_facet WHERE ctid IN (SELECT ctid FROM classify_facet WHERE organization_id = $1 LIMIT $2)',
  connect_tokens:
    'DELETE FROM connect_tokens WHERE ctid IN (SELECT ctid FROM connect_tokens WHERE organization_id = $1 LIMIT $2)',
  connector_versions:
    'DELETE FROM connector_versions WHERE ctid IN (SELECT ctid FROM connector_versions WHERE organization_id = $1 LIMIT $2)',
  deployment_pause:
    'DELETE FROM deployment_pause WHERE ctid IN (SELECT ctid FROM deployment_pause WHERE organization_id = $1 LIMIT $2)',
  device_workers:
    'DELETE FROM device_workers WHERE ctid IN (SELECT ctid FROM device_workers WHERE organization_id = $1 LIMIT $2)',
  grants:
    'DELETE FROM grants WHERE ctid IN (SELECT ctid FROM grants WHERE organization_id = $1 LIMIT $2)',
  inference_providers:
    'DELETE FROM inference_providers WHERE ctid IN (SELECT ctid FROM inference_providers WHERE organization_id = $1 LIMIT $2)',
  sandboxes:
    'DELETE FROM sandboxes WHERE ctid IN (SELECT ctid FROM sandboxes WHERE organization_id = $1 LIMIT $2)',
  user_auth_profiles:
    'DELETE FROM user_auth_profiles WHERE ctid IN (SELECT ctid FROM user_auth_profiles WHERE organization_id = $1 LIMIT $2)',
  views:
    'DELETE FROM views WHERE ctid IN (SELECT ctid FROM views WHERE organization_id = $1 LIMIT $2)',
} as const;

type PurgeBatchTable = keyof typeof PURGE_BATCH_DELETES;

/**
 * Org-scoped tables whose rows survive `DELETE FROM organization`: no
 * `organization_id` FK at all, or only a cascade path through a parent that
 * this list does not own. The purge deletes them by `organization_id` after
 * the organization row is gone (`automations.device_worker_id` blocks deleting
 * `device_workers` while the workspace's Automations still exist).
 *
 * `workspace-purge-coverage.test.ts` derives every org-scoped table from the
 * live schema and fails when one is neither cascaded from `organization` nor
 * listed here, so a new table cannot silently leak rows after a delete.
 */
export const WORKSPACE_PURGE_UNLINKED_TABLES = [
  'agent_secrets',
  'agent_users',
  'authz_source_acl_state',
  'automation_reactions',
  'channel_messages',
  'classify_facet',
  'connect_tokens',
  'connector_versions',
  'deployment_pause',
  'device_workers',
  'grants',
  'inference_providers',
  'sandboxes',
  'user_auth_profiles',
  'views',
] as const satisfies readonly PurgeBatchTable[];

interface PurgeContext {
  taskRunId: number;
  claimedBy: string | undefined;
}

type PurgeCounts = Record<string, number>;

/** Thrown when this attempt no longer holds the task's lease. */
export class WorkspacePurgeLeaseLostError extends Error {
  constructor(taskRunId: number) {
    super(`workspace-purge task ${taskRunId} lost its lease`);
    this.name = 'WorkspacePurgeLeaseLostError';
  }
}

export async function runWorkspacePurgeTask(
  payload: WorkspacePurgeTaskPayload,
  ctx: PurgeContext,
): Promise<PurgeCounts | null> {
  const sql = getDb();
  const organizationId = payload.organizationId;
  const [lease] = await sql<{ claimed_by: string | null; removed: PurgeCounts | null }>`
    SELECT claimed_by, action_output->'removed' AS removed
    FROM runs WHERE id = ${ctx.taskRunId} AND status = 'claimed'
  `;
  if (!ctx.claimedBy || lease?.claimed_by !== ctx.claimedBy) {
    throw new WorkspacePurgeLeaseLostError(ctx.taskRunId);
  }
  const owner = ctx.claimedBy;

  const [org] = await sql<{ requested_at: string | null }>`
    SELECT (metadata)::jsonb ->> ${DELETION_REQUESTED_AT_KEY} AS requested_at
    FROM organization WHERE id = ${organizationId}
  `;
  // Never purge a workspace nobody asked to delete. A missing row is a resumed
  // purge whose organization delete already committed.
  if (org && org.requested_at === null) {
    logger.error(
      { event: 'workspace_purge_refused', organizationId, taskRunId: ctx.taskRunId },
      '[workspace-purge] Refusing to purge a workspace with no deletion request',
    );
    return null;
  }

  // Progress belongs to the durable task, including batches from prior claims.
  const counts: PurgeCounts = { ...lease.removed };
  const batch = (step: string, fn: (tx: DbClient) => Promise<number>) =>
    fencedBatch(sql, ctx.taskRunId, owner, counts, async (tx) => ({ [step]: await fn(tx) }));

  logger.info(
    { event: 'workspace_purge_started', organizationId, taskRunId: ctx.taskRunId, resumed: !org },
    '[workspace-purge] Started',
  );

  if (org) {
    // 1. Events in bounded batches. Embeddings, classifications and the other
    //    event children cascade per batch. The transaction-scoped switch is the
    //    sanctioned path of `events_block_direct_delete`.
    while (
      (await batch('events', async (tx) => {
        await tx`SET LOCAL lobu.allow_event_delete = 'on'`;
        return deleteBatchByOrganization(tx, 'events', organizationId);
      })) > 0
    );

    // 2. Run history, for the same reason: it is unbounded per workspace.
    while ((await batch('runs', (tx) => deleteBatchByOrganization(tx, 'runs', organizationId))) > 0);

    // 3. Identity associations block both entity and organization deletes
    //    while live. Retire them through the governed unlink path.
    await batch('identity_edges', async (tx) => {
      await lockIdentityOrganization(tx, organizationId);
      return withIdentityPrivilege(tx, async () => {
        const retired = await tx`
          UPDATE entity_relationships r
          SET deleted_at = now(),
              metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object(
                ${IDENTITY_DECISION_METADATA_KEY}::text,
                COALESCE(r.metadata -> ${IDENTITY_DECISION_METADATA_KEY}, '{}'::jsonb)
                  || '{"outcome": "withdrawn", "reason": "workspace_deleted"}'::jsonb
              )
          FROM entity_relationship_types t
          WHERE t.id = r.relationship_type_id
            AND t.purpose = 'identity'
            AND r.organization_id = ${organizationId}
            AND r.deleted_at IS NULL
        `;
        return retired.count;
      });
    });

    // 4. Entities leaf-first: `entities.parent_id` is ON DELETE RESTRICT, so a
    //    parent can only go once its children are gone. Relationship edges
    //    cascade with their endpoints; authorization edges need the ACL switch.
    while (
      (await batch('entities', (tx) =>
        withAclPrivilege(tx, async () => {
          const leaves = await tx<{ id: number }>`
            SELECT e.id FROM entities e
            WHERE e.organization_id = ${organizationId}
              AND NOT EXISTS (SELECT 1 FROM entities child WHERE child.parent_id = e.id)
            LIMIT ${WORKSPACE_PURGE_BATCH_SIZE}
          `;
          const deleted = await hardDeleteEntityRows({
            tx,
            ids: leaves.map((row) => Number(row.id)),
          });
          return deleted.length;
        }),
      )) > 0
    );

    // 5. Other workspaces' edges to this workspace's public source types. A
    //    stored cross-workspace edge cascades with its endpoint entity; a
    //    source edge names the type instead, whose foreign key restricts, so
    //    it goes the same way explicitly before the types cascade.
    while (
      (await batch('foreign_source_edges', async (tx) => {
        const deleted = await tx`
          DELETE FROM entity_relationships WHERE id IN (
            SELECT r.id FROM entity_relationships r
            JOIN entity_types t ON t.id = r.to_entity_type_id
            WHERE t.organization_id = ${organizationId} AND r.organization_id <> ${organizationId}
            LIMIT ${WORKSPACE_PURGE_BATCH_SIZE}
          )
        `;
        return deleted.count;
      })) > 0
    );

    // 6. Types other workspaces borrowed. Creating an entity or link falls
    //    back to a public workspace's type with that slug, so other
    //    workspaces' rows can reference this workspace's types. The entity
    //    reference restricts the type cascade (the purge could never finish)
    //    and the relationship reference cascades (their edges would vanish),
    //    so each borrower first gets its own copy of the type, or keeps the
    //    same-slug type it already has, and its rows move onto it.
    while (
      (await fencedBatch(sql, ctx.taskRunId, owner, counts, (tx) =>
        rehomeBorrowedEntityTypes(tx, organizationId),
      )) > 0
    );
    while (
      (await fencedBatch(sql, ctx.taskRunId, owner, counts, (tx) =>
        withAclPrivilege(tx, () => rehomeBorrowedRelationshipTypes(tx, organizationId)),
      )) > 0
    );

    // 7. OAuth registrations homed here. `oauth_clients.organization_id` is
    //    only the first workspace that authorized a registration, yet the
    //    organization delete cascades through it into every workspace's tokens
    //    and `events.client_id`. So each one is settled first: this workspace's
    //    grants are revoked, then the registration is deleted if nothing else
    //    uses it and detached if something does. One registration per
    //    transaction, so the mutex it shares with token issuance is held
    //    briefly. Events are already gone (step 1), so an event that still
    //    names a registration belongs to another workspace.
    while (
      (await fencedBatch(sql, ctx.taskRunId, owner, counts, async (tx): Promise<PurgeCounts> => {
        const outcome = await releaseClientHomedInOrganization(tx, organizationId);
        if (outcome === null) return {};
        return outcome === 'deleted' ? { oauth_clients: 1 } : { oauth_clients_detached: 1 };
      })) > 0
    );

    // 8. The organization row. What still cascades is small by now.
    await batch('organization', (tx) =>
      withAclPrivilege(tx, async () => {
        // Hold the organization lock before revoking: a concurrent PAT mint's
        // FK check must finish before this update or fail after the delete.
        // The FK otherwise detaches live PATs with ON DELETE SET NULL.
        await tx`SELECT id FROM organization WHERE id = ${organizationId} FOR UPDATE`;
        await tx`
          UPDATE personal_access_tokens SET revoked_at = NOW(), updated_at = NOW()
          WHERE organization_id = ${organizationId} AND revoked_at IS NULL
        `;
        const deleted = await tx`DELETE FROM organization WHERE id = ${organizationId}`;
        return deleted.count;
      }),
    );
  }

  // 9. Tables the organization delete does not reach.
  for (const table of WORKSPACE_PURGE_UNLINKED_TABLES) {
    while ((await batch(table, (tx) => deleteBatchByOrganization(tx, table, organizationId))) > 0);
  }

  // 10. The public namespace entry. It is keyed by `ref_id`, not
  //    `organization_id`, so it is neither cascaded from `organization` nor
  //    part of the batch tables above. One row per workspace at most.
  await batch('namespace', async (tx) => {
    const deleted = await tx.unsafe(
      "DELETE FROM namespace WHERE type = 'organization' AND ref_id = $1",
      [organizationId],
    );
    return deleted.count;
  });

  logger.info(
    { event: 'workspace_purge_finished', organizationId, taskRunId: ctx.taskRunId, counts },
    '[workspace-purge] Finished',
  );
  return counts;
}

/**
 * One batch in its own transaction, fenced on the task lease. Locking the task
 * row makes a concurrent reclaim (or heartbeat) wait for this batch to commit,
 * so a batch never lands after another holder took the task over. The lock is
 * `FOR NO KEY UPDATE`, the strength of the progress write below: taking a
 * weaker lock and upgrading it later could deadlock against a waiting
 * heartbeat. Progress is written onto the task row in the same transaction:
 * the row outlives the
 * organization (it carries no `organization_id`), so it is the durable record.
 * A batch reports its rows per step, so one that settles rows more than one
 * way counts each outcome; the total is returned.
 */
async function fencedBatch(
  sql: DbClient,
  taskRunId: number,
  owner: string,
  counts: PurgeCounts,
  fn: (tx: DbClient) => Promise<PurgeCounts>,
): Promise<number> {
  return sql.begin(async (tx) => {
    const held = await tx`
      SELECT 1 FROM runs
      WHERE id = ${taskRunId} AND status = 'claimed' AND claimed_by = ${owner}
      FOR NO KEY UPDATE
    `;
    if (held.length === 0) throw new WorkspacePurgeLeaseLostError(taskRunId);
    let removed = 0;
    for (const [step, rows] of Object.entries(await fn(tx))) {
      if (rows <= 0) continue;
      counts[step] = (counts[step] ?? 0) + rows;
      removed += rows;
    }
    if (removed > 0) {
      await tx`
        UPDATE runs
        SET action_output = COALESCE(action_output, '{}'::jsonb)
          || jsonb_build_object('removed', ${tx.json(counts)}::jsonb)
        WHERE id = ${taskRunId}
      `;
    }
    return removed;
  });
}

/**
 * Move one batch of other workspaces' entities off this workspace's types.
 * Every row in the batch gets a target first: the borrower's live type with
 * the same slug, copied from this workspace's type when it has none. Keying
 * the copy on the borrower's unique slug makes a retry reuse it.
 */
async function rehomeBorrowedEntityTypes(tx: DbClient, organizationId: string): Promise<PurgeCounts> {
  // Live and retired rows are read separately so each uses its partial index.
  const rows = await tx<{ id: number }>`
    SELECT id FROM (
      (SELECT e.id FROM entity_types t
       JOIN entities e ON e.entity_type_id = t.id
       WHERE t.organization_id = ${organizationId} AND e.organization_id <> ${organizationId}
         AND e.deleted_at IS NULL
       LIMIT ${WORKSPACE_PURGE_BATCH_SIZE})
      UNION ALL
      (SELECT e.id FROM entity_types t
       JOIN entities e ON e.entity_type_id = t.id
       WHERE t.organization_id = ${organizationId} AND e.organization_id <> ${organizationId}
         AND e.deleted_at IS NOT NULL
       LIMIT ${WORKSPACE_PURGE_BATCH_SIZE})
    ) borrowed
    LIMIT ${WORKSPACE_PURGE_BATCH_SIZE}
  `;
  const ids = rows.map((row) => Number(row.id));
  if (ids.length === 0) return {};
  const copied = await tx`
    INSERT INTO entity_types (
      organization_id, slug, name, description, icon, color, metadata_schema,
      event_kinds, metrics_config, rules_source, rules_compiled
    )
    SELECT DISTINCT ON (e.organization_id, t.slug)
      e.organization_id, t.slug, t.name, t.description, t.icon, t.color, t.metadata_schema,
      t.event_kinds, t.metrics_config, t.rules_source, t.rules_compiled
    FROM entities e
    JOIN entity_types t ON t.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(ids)}::bigint[])
      AND NOT EXISTS (
        SELECT 1 FROM entity_types own
        WHERE own.organization_id = e.organization_id AND own.slug = t.slug AND own.deleted_at IS NULL
      )
    ORDER BY e.organization_id, t.slug, (t.deleted_at IS NULL) DESC, t.id DESC
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL DO NOTHING
  `;
  const moved = await repointEntityRowsToOwnType({ tx, ids });
  return { borrowed_entity_types: copied.count, borrowed_type_entities: moved.length };
}

/**
 * Move one batch of other workspaces' relationships off this workspace's
 * relationship types, copying each type (and its endpoint rules) to a
 * borrower that has no active type with the same slug. A live edge that
 * already exists on the borrower's own type is retired rather than
 * duplicated; every edge keeps its row.
 */
async function rehomeBorrowedRelationshipTypes(
  tx: DbClient,
  organizationId: string,
): Promise<PurgeCounts> {
  const rows = await tx<{ id: number }>`
    SELECT r.id FROM entity_relationship_types t
    JOIN entity_relationships r ON r.relationship_type_id = t.id
    WHERE t.organization_id = ${organizationId} AND r.organization_id <> ${organizationId}
    LIMIT ${WORKSPACE_PURGE_BATCH_SIZE}
  `;
  if (rows.length === 0) return {};
  const ids = pgBigintArray(rows.map((row) => Number(row.id)));
  const [copied] = await tx<{ count: number }>`
    WITH source AS (
      SELECT DISTINCT ON (r.organization_id, t.slug)
        r.organization_id, t.id AS source_type_id, t.slug, t.name, t.description,
        t.metadata_schema, t.is_symmetric, t.metadata, t.purpose
      FROM entity_relationships r
      JOIN entity_relationship_types t ON t.id = r.relationship_type_id
      WHERE r.id = ANY(${ids}::bigint[])
        AND NOT EXISTS (
          SELECT 1 FROM entity_relationship_types own
          WHERE own.organization_id = r.organization_id AND own.slug = t.slug AND own.status = 'active'
        )
      ORDER BY r.organization_id, t.slug, (t.status = 'active') DESC, t.id DESC
    ), copied AS (
      INSERT INTO entity_relationship_types (
        organization_id, slug, name, description, metadata_schema, is_symmetric, metadata, purpose
      )
      SELECT organization_id, slug, name, description, metadata_schema, is_symmetric, metadata, purpose
      FROM source
      ON CONFLICT (organization_id, slug) WHERE status = 'active' DO NOTHING
      RETURNING id, organization_id, slug
    ), copied_rules AS (
      INSERT INTO entity_relationship_type_rules (
        relationship_type_id, source_entity_type_slug, target_entity_type_slug
      )
      SELECT copied.id, rule.source_entity_type_slug, rule.target_entity_type_slug
      FROM copied
      JOIN source ON source.organization_id = copied.organization_id AND source.slug = copied.slug
      JOIN entity_relationship_type_rules rule
        ON rule.relationship_type_id = source.source_type_id AND rule.deleted_at IS NULL
    )
    SELECT count(*)::int AS count FROM copied
  `;
  // A duplicate is judged by the borrower's two live-edge unique indexes:
  // stored pairs by endpoints, source edges by their full endpoint tuple.
  const moved = await tx`
    UPDATE entity_relationships r
    SET relationship_type_id = own.id,
        deleted_at = CASE
          WHEN r.deleted_at IS NOT NULL THEN r.deleted_at
          WHEN r.from_entity_id IS NOT NULL AND r.to_entity_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM entity_relationships live
            WHERE live.from_entity_id = r.from_entity_id AND live.to_entity_id = r.to_entity_id
              AND live.relationship_type_id = own.id AND live.deleted_at IS NULL
          ) THEN now()
          WHEN (r.from_entity_id IS NULL OR r.to_entity_id IS NULL) AND EXISTS (
            SELECT 1 FROM entity_relationships live
            WHERE live.organization_id = r.organization_id
              AND COALESCE(live.from_entity_id, 0) = COALESCE(r.from_entity_id, 0)
              AND COALESCE(live.from_entity_type_id, 0) = COALESCE(r.from_entity_type_id, 0)
              AND COALESCE(live.from_source_key, '') = COALESCE(r.from_source_key, '')
              AND COALESCE(live.to_entity_id, 0) = COALESCE(r.to_entity_id, 0)
              AND COALESCE(live.to_entity_type_id, 0) = COALESCE(r.to_entity_type_id, 0)
              AND COALESCE(live.to_source_key, '') = COALESCE(r.to_source_key, '')
              AND live.relationship_type_id = own.id AND live.deleted_at IS NULL
              AND (live.from_entity_id IS NULL OR live.to_entity_id IS NULL)
          ) THEN now()
          ELSE NULL
        END,
        updated_at = now()
    FROM entity_relationship_types t, entity_relationship_types own
    WHERE r.id = ANY(${ids}::bigint[])
      AND t.id = r.relationship_type_id
      AND own.organization_id = r.organization_id AND own.slug = t.slug AND own.status = 'active'
      AND own.id <> r.relationship_type_id
  `;
  return { borrowed_relationship_types: copied.count, borrowed_type_relationships: moved.count };
}

/**
 * Delete up to one batch of `table`'s rows for the organization. Every
 * statement names its table literally (the entity-write funnel gate cannot
 * prove a dynamically named target is not `entities`).
 */
async function deleteBatchByOrganization(
  tx: DbClient,
  table: PurgeBatchTable,
  organizationId: string,
): Promise<number> {
  const deleted = await tx.unsafe(PURGE_BATCH_DELETES[table], [
    organizationId,
    WORKSPACE_PURGE_BATCH_SIZE,
  ]);
  return deleted.count;
}
