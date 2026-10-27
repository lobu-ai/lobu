/**
 * Tool: delete_knowledge
 *
 * The `events` table is append-only — no row is ever physically removed. To
 * "delete" an event we insert a small tombstone event whose
 * `supersedes_event_id` points at the target. The `current_event_records`
 * view filters out events that have a newer superseder, so the original
 * disappears from default search/query/read paths. The full history stays
 * recoverable via `include_superseded` and direct `events`-table reads.
 *
 * This matches the contract advertised by `save_memory`:
 *   "Storage is append-only — pass `supersedes_event_id` to replace an
 *    existing fact (the old event is hidden from future searches without
 *    losing history)."
 *
 * Authorization mirrors `save_memory` since the underlying primitive is
 * the same (insert an event with `supersedes_event_id`).
 */

import { type DeleteContentArgs, DeleteContentSchema } from '@lobu/core/contracts/tools/delete-knowledge';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { getDb, pgBigintArray } from '../db/client';
import type { Env } from '../index';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { assertCanRemoveGuidance } from '../utils/org-guidance';
import { isSystemContext, workspaceScopeDenialMessage } from './access-control';
import { TOMBSTONE_SEMANTIC_TYPE } from './constants';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { eventClientId } from '../auth/event-client-id';

interface DeleteContentResult {
  deleted_ids: number[];
  tombstone_ids: number[];
  not_found_ids: number[];
  already_superseded_ids: number[];
}

export const deleteContent = withValidatedArgs(
  'delete_knowledge',
  DeleteContentSchema,
  deleteContentImpl
);

async function deleteContentImpl(
  args: DeleteContentArgs,
  _env: Env,
  ctx: ToolContext
): Promise<DeleteContentResult> {
  if (!isSystemContext(ctx)) {
    if (!ctx.memberRole) {
      throw new Error('delete_knowledge requires workspace membership with write access.');
    }
    if (!hasRequiredMcpScope('write', ctx.scopes)) {
      throw new Error(await workspaceScopeDenialMessage(ctx, 'delete_knowledge', 'write'));
    }
  }

  const requested = collectIds(args);
  if (requested.length === 0) {
    throw new Error('Provide content_id or a non-empty content_ids array');
  }

  const sql = getDb();

  const inOrg = await sql<{ id: number }>`
    SELECT id FROM events
    WHERE id = ANY(${pgBigintArray(requested)}::bigint[])
      AND organization_id = ${ctx.organizationId}
  `;
  const inOrgIds = new Set(inOrg.map((row) => Number(row.id)));
  const notFoundIds = requested.filter((id) => !inOrgIds.has(id));

  const candidateIds = [...inOrgIds];
  const alreadySupersededRows =
    candidateIds.length > 0
      ? await sql<{ supersedes_event_id: number }>`
        SELECT supersedes_event_id FROM events
        WHERE supersedes_event_id = ANY(${pgBigintArray(candidateIds)}::bigint[])
      `
      : [];
  const alreadySupersededIds = Array.from(
    new Set(alreadySupersededRows.map((row) => Number(row.supersedes_event_id)))
  );
  const alreadySupersededSet = new Set(alreadySupersededIds);

  const targetIds = candidateIds.filter((id) => !alreadySupersededSet.has(id));

  // Deleting a `guidance` target tombstones it out of every agent prompt — the
  // same removal that supersede performs. Authorship is admin-gated (and rejects
  // system contexts), so removal is too: an Automation/agent must not be able
  // to erase admin org-context either. memberRole is owner/admin only.
  await assertCanRemoveGuidance(ctx.organizationId, targetIds, ctx.memberRole);

  const tombstoneIds: number[] = [];
  for (const targetId of targetIds) {
    const tombstone = await insertEvent({
      entityIds: [],
      organizationId: ctx.organizationId,
      originId: `tomb_${crypto.randomUUID()}`,
      semanticType: TOMBSTONE_SEMANTIC_TYPE,
      payloadType: 'empty',
      content: null,
      metadata: {
        tombstone: true,
        deleted_event_id: targetId,
        ...(args.reason ? { reason: args.reason } : {}),
      },
      supersedesEventId: targetId,
      createdBy: ctx.userId,
      clientId: eventClientId(ctx),
    });
    tombstoneIds.push(Number(tombstone.id));
  }

  logger.info(
    {
      organizationId: ctx.organizationId,
      deletedIds: targetIds,
      tombstoneIds,
      notFoundIds,
      alreadySupersededIds,
    },
    'delete_knowledge'
  );

  return {
    deleted_ids: targetIds,
    tombstone_ids: tombstoneIds,
    not_found_ids: notFoundIds,
    already_superseded_ids: alreadySupersededIds,
  };
}

function collectIds(args: DeleteContentArgs): number[] {
  const ids: number[] = [];
  if (typeof args.content_id === 'number') ids.push(args.content_id);
  if (Array.isArray(args.content_ids)) ids.push(...args.content_ids);
  return Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
}
