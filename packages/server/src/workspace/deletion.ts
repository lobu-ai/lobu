/**
 * Workspace deletion request.
 *
 * Deleting a workspace is two steps (docs/design/workspace-deletion.md):
 *  1. The request stamps `organization.metadata.deletion_requested_at`, writes
 *     the audit row and enqueues one `workspace-purge` task, all in one
 *     transaction. Readers using `workspace/deletion-state.ts` then hide it.
 *  2. The task (`workspace/purge.ts`) reclaims the storage in the background.
 */

import type { DbClient } from '../db/client';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import { WORKSPACE_PURGE_TASK } from '../scheduled/task-definitions';
import type { ConfigActorSource } from '../utils/apply-context';
import { insertWorkspaceChangeEventInTransaction } from '../utils/insert-event';
import {
  DELETION_REQUESTED_AT_KEY,
  DELETION_REQUESTED_BY_KEY,
} from './deletion-state';

export interface WorkspacePurgeTaskPayload {
  organizationId: string;
}

export function workspacePurgeIdempotencyKey(organizationId: string): string {
  return `workspace-purge:${organizationId}`;
}

/**
 * Record a deletion request and hand the purge to the task queue.
 *
 * Idempotent: a repeated request for a workspace that is already deleting
 * keeps the first request's marker and re-enqueues nothing while the task is
 * still active (the idempotency key dedups it). Authorization is the caller's
 * job — this function trusts that the actor may delete the workspace.
 *
 * The task row carries no `organization_id` on purpose: `runs` cascades from
 * `organization`, and the purge's final step deletes that row. Keeping the
 * task row org-less lets it survive as the durable record of the purge.
 */
export async function requestWorkspaceDeletion(
  sql: DbClient,
  params: {
    organizationId: string;
    requestedBy: string | null;
    actorSource: ConfigActorSource;
  },
): Promise<{ alreadyRequested: boolean } | null> {
  return sql.begin(async (tx) => {
    const [org] = await tx<{
      id: string;
      name: string;
      slug: string;
      requested_at: string | null;
    }>`
      SELECT id, name, slug,
             (metadata)::jsonb ->> ${DELETION_REQUESTED_AT_KEY} AS requested_at
      FROM organization
      WHERE id = ${params.organizationId}
      FOR UPDATE
    `;
    if (!org) return null;
    const alreadyRequested = org.requested_at !== null;
    if (!alreadyRequested) {
      await tx`
        UPDATE organization
        SET metadata = (
          COALESCE((metadata)::jsonb, '{}'::jsonb)
          || jsonb_build_object(
            ${DELETION_REQUESTED_AT_KEY}::text, to_jsonb(now()),
            ${DELETION_REQUESTED_BY_KEY}::text, ${params.requestedBy}::text
          )
        )::text,
            -- Every anonymous read of a workspace (public REST, public pages,
            -- sitemap, cross-workspace schema and search reads) filters on
            -- visibility = 'public', so this hides it from all of them at
            -- once. Deletion is terminal: nothing restores it.
            visibility = 'private'
        WHERE id = ${org.id}
      `;
      await insertWorkspaceChangeEventInTransaction(
        {
          organizationId: org.id,
          resourceKind: 'organization',
          resourceId: org.id,
          op: 'deleted',
          summary: `Workspace "${org.name}" deletion requested`,
          state: null,
          changedFields: [DELETION_REQUESTED_AT_KEY],
          actorSource: params.actorSource,
          createdBy: params.requestedBy,
        },
        tx,
      );
    }
    // Work already queued for the workspace must not run after it is gone:
    // the schedulers stop materializing new runs, and this drops the queued
    // ones. Runs already executing finish; the purge removes every run row.
    await tx`
      UPDATE runs
      SET status = 'cancelled',
          error_message = 'Workspace deletion requested',
          completed_at = now()
      WHERE organization_id = ${org.id}
        AND status IN ('pending', 'awaiting_approval')
    `;
    // No session stays on the workspace: Better Auth's organization endpoints
    // fall back to the active organization (there is no session cookie cache,
    // so the row is authoritative).
    await tx`
      UPDATE session SET "activeOrganizationId" = NULL
      WHERE "activeOrganizationId" = ${org.id}
    `;
    await enqueueTasksInTransaction<WorkspacePurgeTaskPayload>(tx, [
      {
        name: WORKSPACE_PURGE_TASK,
        payload: { organizationId: org.id },
        opts: {
          idempotencyKey: workspacePurgeIdempotencyKey(org.id),
          // Every attempt resumes where the last one stopped, so a generous
          // budget only buys more progress, never repeated work.
          maxAttempts: 20,
        },
      },
    ]);
    return { alreadyRequested };
  });
}
