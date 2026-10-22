import { eventAttachmentsFor } from "@lobu/core/contracts/tools/view-attach";
import { hasRequiredMcpScope } from "../auth/tool-access";
import { authzScopeFromToolContext } from "../authz/scope";
import { getDb, parsePgNumberArray, pgBigintArray } from "../db/client";
import type { Env } from "../index";
import { isInProcessSystemCall, isPublicReader } from "../tools/access-control";
import { buildExactIdScopeWhere } from "../tools/get_content/query";
import { getContent } from "../tools/get_content/handler";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { validateNumericId } from "../utils/sql-validation";
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
  // The SQL scope covers row visibility, not MCP scopes or entity read policy.
  // Let getContent enforce those gates before disclosing an attachment mismatch.
  const canProbe = !ctx.agentId && !ctx.actingAutomationId && (
    (ctx.tokenType !== "oauth" && ctx.tokenType !== "pat") ||
    hasRequiredMcpScope("read", ctx.scopes)
  );
  if (canProbe) {
    // Only reject a visible head: superseded/missing rows need the full lineage
    // read. Matching rows still use getContent for the returned subject.
    const validatedEventId = validateNumericId(eventId, 'event');
    const db = getDb();
    const probeScope = await buildExactIdScopeWhere(db, {
      organizationId: ctx.organizationId,
      visibilityScope: {
        organizationId: ctx.organizationId,
        userId: authzScopeFromToolContext(ctx).principal,
      },
      excludeWorkspaceAudit:
        ctx.memberRole !== 'owner' &&
        ctx.memberRole !== 'admin' &&
        !isInProcessSystemCall(ctx),
      excludeOperationalTrail: isPublicReader(ctx),
      baseParamIndex: 1,
    });
    const probe = await db.unsafe<EventViewSubject>(
      `SELECT f.id, f.origin_id, f.semantic_type, f.entity_ids, f.superseded_by
      FROM events f
      LEFT JOIN connections c ON c.id = f.connection_id
      WHERE f.id = ${validatedEventId} ${probeScope.sql}
      LIMIT 1`,
      probeScope.params
    );
    const head = probe[0] ?? null;
    if (head && head.superseded_by == null) {
      const kinds = eventAttachmentsFor(view.attach, head.semantic_type);
      if (kinds.length === 0) {
        throw new ToolUserError(`View '${view.key}' is not attached to '${head.semantic_type}' events`, 400);
      }
      if (kinds.every((attachment) => attachment.type !== undefined)) {
        const types = new Set((await fetchLinkedTypeSlugs(head.entity_ids, ctx.organizationId)).map((row) => row.slug));
        if (!kinds.some((attachment) => attachment.type !== undefined && types.has(attachment.type))) {
          throw new ToolUserError(`View '${view.key}' renders '${head.semantic_type}' events linked to ${kinds.map((a) => `a ${a.type}`).join(' or ')}; event ${validatedEventId} links none`, 400);
        }
      }
    }
  }
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
  const types = new Set((await fetchLinkedTypeSlugs(current.entity_ids, ctx.organizationId)).map((row) => row.slug));
  if (!kinds.some((attachment) => attachment.type !== undefined && types.has(attachment.type))) {
    throw new ToolUserError(`View '${view.key}' renders '${current.semantic_type}' events linked to ${kinds.map((a) => `a ${a.type}`).join(' or ')}; event ${eventId} links none`, 400);
  }
  return current;
}

/** Slugs of the entity types linked from an event, for the attachment check. */
async function fetchLinkedTypeSlugs(entityIds: unknown, organizationId: string): Promise<{ slug: string }[]> {
  // Raw rows may carry entity_ids as a Postgres array literal, not a JS
  // array — normalize exactly like the full read path does
  // (`render.ts` via `parsePgNumberArray`) so the probe agrees with it.
  const linkedIds = parsePgNumberArray(entityIds).filter(Number.isInteger);
  if (linkedIds.length === 0) return [];
  return getDb()<{ slug: string }>`
    SELECT DISTINCT et.slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(linkedIds)}::bigint[])
      AND e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL AND et.deleted_at IS NULL
  `;
}
