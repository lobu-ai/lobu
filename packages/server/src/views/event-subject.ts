import { eventAttachmentsFor } from "@lobu/core/contracts/tools/view-attach";
import { hasRequiredMcpScope } from "../auth/tool-access";
import { authzScopeFromToolContext } from "../authz/scope";
import { type DbClient, getDb, parsePgNumberArray, pgBigintArray } from "../db/client";
import type { Env } from "../index";
import { isInProcessSystemCall, isPublicReader, workspaceScopeDenialMessage } from "../tools/access-control";
import { buildExactIdScopeWhere } from "../tools/get_content/query";
import { assertContentEntityReadPolicy, getContent } from "../tools/get_content/handler";
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

/**
 * A new command needs the exact current event, not a rendered lineage.
 * Reuse knowledge-read policy and row visibility on the caller's transaction;
 * rendering through getContent would reserve another pooled connection.
 */
export async function resolveCurrentEventViewSubject(
  view: Pick<StoredView, 'key' | 'attach'>,
  eventId: number,
  ctx: ToolContext,
  sql: DbClient,
): Promise<EventViewSubject> {
  const validatedEventId = validateNumericId(eventId, 'event');
  if ((ctx.tokenType === 'oauth' || ctx.tokenType === 'pat') &&
    !hasRequiredMcpScope('read', ctx.scopes)) {
    throw new ToolUserError(
      await workspaceScopeDenialMessage(ctx, 'read_knowledge', 'read', undefined, sql),
      403,
    );
  }
  await assertContentEntityReadPolicy(sql, ctx, { content_ids: [Number(validatedEventId)] });
  const scope = await buildExactIdScopeWhere(sql, {
    organizationId: ctx.organizationId,
    visibilityScope: {
      organizationId: ctx.organizationId,
      userId: authzScopeFromToolContext(ctx).principal,
    },
    excludeWorkspaceAudit: ctx.memberRole !== 'owner' && ctx.memberRole !== 'admin' &&
      !isInProcessSystemCall(ctx),
    excludeOperationalTrail: isPublicReader(ctx),
    baseParamIndex: 2,
  });
  const [row] = await sql.unsafe<EventViewSubject>(
    `SELECT f.id, f.origin_id, f.semantic_type, f.entity_ids, f.superseded_by
    FROM events f
    LEFT JOIN connections c ON c.id = f.connection_id
    WHERE f.id = $1 ${scope.sql}
    FOR SHARE OF f`,
    [validatedEventId, ...scope.params],
  );
  if (!row) throw new ToolUserError(`Event ${validatedEventId} not found`, 404);
  if (row.superseded_by != null) {
    throw new ToolUserError("This event has been replaced. Reopen it before submitting.", 409);
  }
  const current = { ...row, id: Number(row.id), entity_ids: parsePgNumberArray(row.entity_ids) };
  await assertEventViewAttachment(view, current, ctx.organizationId, sql);
  return current;
}

/** Resolve through the normal read policy before checking the current view's
 * attachment. Opening follows the permalink; a new action must name this exact
 * current version so an old form cannot act on a replacement event. */
export async function resolveEventViewSubject(
  view: Pick<StoredView, 'key' | 'attach'>,
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
  await assertEventViewAttachment(view, current, ctx.organizationId, getDb());
  return current;
}

async function assertEventViewAttachment(
  view: Pick<StoredView, 'key' | 'attach'>,
  current: EventViewSubject,
  organizationId: string,
  sql: DbClient,
): Promise<void> {
  const kinds = eventAttachmentsFor(view.attach, current.semantic_type);
  if (kinds.length === 0) {
    throw new ToolUserError(`View '${view.key}' is not attached to '${current.semantic_type}' events`, 400);
  }
  if (kinds.some((attachment) => attachment.type === undefined)) return;
  const types = new Set((await fetchLinkedTypeSlugs(current.entity_ids, organizationId, sql)).map((row) => row.slug));
  if (!kinds.some((attachment) => attachment.type !== undefined && types.has(attachment.type))) {
    throw new ToolUserError(`View '${view.key}' renders '${current.semantic_type}' events linked to ${kinds.map((a) => `a ${a.type}`).join(' or ')}; event ${current.id} links none`, 400);
  }
}

/** Slugs of the entity types linked from an event, for the attachment check. */
async function fetchLinkedTypeSlugs(entityIds: unknown, organizationId: string, sql: DbClient = getDb()): Promise<{ slug: string }[]> {
  // Raw rows may carry entity_ids as a Postgres array literal, not a JS
  // array — normalize exactly like the full read path does
  // (`render.ts` via `parsePgNumberArray`) so the probe agrees with it.
  const linkedIds = parsePgNumberArray(entityIds).filter(Number.isInteger);
  if (linkedIds.length === 0) return [];
  return sql<{ slug: string }>`
    SELECT DISTINCT et.slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(linkedIds)}::bigint[])
      AND e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL AND et.deleted_at IS NULL
  `;
}
