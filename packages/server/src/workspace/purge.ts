/**
 * The `workspace-purge` task: reclaim a deleted workspace's storage.
 *
 * This task removes a requested workspace's rows in the background
 * (docs/design/workspace-deletion.md).
 * One FK cascade from `organization` cannot do it: a large workspace's
 * `events` → `event_embeddings` cascade outlives the statement timeout, and a
 * handful of org-scoped tables have no FK to `organization` at all.
 *
 * Every step is idempotent and keyed only on the organization id, so a lost
 * lease or a crash simply resumes: the next attempt finds fewer rows. Each
 * batch commits on its own and is fenced on this task's lease, so a reclaimed
 * task never has two holders deleting at once.
 */

import { type DbClient, getDb } from '../db/client';
import { hardDeleteEntityRows } from '../utils/entity-management';
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
    fencedBatch(sql, ctx.taskRunId, owner, counts, step, fn);

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

    // 5. The organization row. What still cascades is small by now.
    await batch('organization', (tx) =>
      withAclPrivilege(tx, async () => {
        const deleted = await tx`DELETE FROM organization WHERE id = ${organizationId}`;
        return deleted.count;
      }),
    );
  }

  // 6. Tables the organization delete does not reach.
  for (const table of WORKSPACE_PURGE_UNLINKED_TABLES) {
    while ((await batch(table, (tx) => deleteBatchByOrganization(tx, table, organizationId))) > 0);
  }

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
 */
async function fencedBatch(
  sql: DbClient,
  taskRunId: number,
  owner: string,
  counts: PurgeCounts,
  step: string,
  fn: (tx: DbClient) => Promise<number>,
): Promise<number> {
  return sql.begin(async (tx) => {
    const held = await tx`
      SELECT 1 FROM runs
      WHERE id = ${taskRunId} AND status = 'claimed' AND claimed_by = ${owner}
      FOR NO KEY UPDATE
    `;
    if (held.length === 0) throw new WorkspacePurgeLeaseLostError(taskRunId);
    const removed = await fn(tx);
    if (removed > 0) {
      counts[step] = (counts[step] ?? 0) + removed;
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
