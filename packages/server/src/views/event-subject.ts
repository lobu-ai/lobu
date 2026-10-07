import { eventAttachmentsFor } from "@lobu/core/contracts/tools/view-attach";
import type { Env } from "../index";
import { getDb, pgBigintArray } from "../db/client";
import { getContent } from "../tools/get_content/handler";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import type { StoredView } from "./views";

export interface EventViewSubject {
  id: number;
  origin_id: string;
  semantic_type: string;
  entity_ids: number[];
  superseded_by?: number | null;
}

/** Resolve through the normal read policy before checking the current view's
 * attachment. Opening follows the permalink; a new action must name this exact
 * current version so an old form cannot act on a replacement event. */
export async function resolveEventViewSubject(
  view: StoredView,
  eventId: number,
  env: Env,
  ctx: ToolContext,
): Promise<EventViewSubject> {
  let current: EventViewSubject | null = null;
  for (let offset = 0; !current; offset += 100) {
    const read = await getContent({ content_ids: [eventId], limit: 100, offset }, env, ctx);
    current = (read.content as EventViewSubject[]).find((row) => row.superseded_by == null) ?? null;
    if (!read.page?.has_more) break;
  }
  if (!current) throw new ToolUserError(`Event ${eventId} not found`, 404);
  const kinds = eventAttachmentsFor(view.attach, current.semantic_type);
  if (kinds.length === 0) {
    throw new ToolUserError(`View '${view.key}' is not attached to '${current.semantic_type}' events`, 400);
  }
  if (kinds.some((attachment) => attachment.type === undefined)) return current;
  const entityIds = current.entity_ids.filter(Number.isInteger);
  const linkedTypes = entityIds.length === 0 ? [] : await getDb()<{ slug: string }>`
    SELECT DISTINCT et.slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(entityIds)}::bigint[])
      AND e.organization_id = ${ctx.organizationId}
      AND e.deleted_at IS NULL AND et.deleted_at IS NULL
  `;
  const types = new Set(linkedTypes.map((row) => row.slug));
  if (!kinds.some((attachment) => attachment.type !== undefined && types.has(attachment.type))) {
    throw new ToolUserError(`View '${view.key}' renders '${current.semantic_type}' events linked to ${kinds.map((a) => `a ${a.type}`).join(' or ')}; event ${eventId} links none`, 400);
  }
  return current;
}
