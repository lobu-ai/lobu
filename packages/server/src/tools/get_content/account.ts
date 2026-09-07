/** Account-owned MCP audit detail, rendered by the existing events UI. */
import { Type, type Static } from '@sinclair/typebox';
import { hasRequiredMcpScope } from '../../auth/tool-access';
import { getDb, pgBigintArray, pgTextArray } from '../../db/client';
import type { Env } from '../../index';
import { ToolUserError } from '../../utils/errors';
import { getPublicWebUrl } from '../../utils/url-builder';
import type { AuthContext } from '../execute';
import { withValidatedArgs } from '../validate-args';
import { buildContentItems, hydrateToolInvocationRequests } from './render';
import { GetContentSchema } from './schema';
import type { ContentRow, GetContentResult } from './types';

const AccountContentSchema = Type.Pick(GetContentSchema, [
  'client_ids', 'mcp_activity_id', 'content_ids', 'limit', 'offset',
  'before_occurred_at', 'before_id', 'after_occurred_at', 'after_id',
  'sort_by', 'sort_order', 'include_classification',
]);
type AccountContentArgs = Static<typeof AccountContentSchema>;
type AccountContentContext = Pick<AuthContext,
  'userId' | 'isAuthenticated' | 'tokenType' | 'scopes' | 'agentId' |
  'actingAutomationId' | 'requestUrl' | 'baseUrl'>;

export const getAccountContent = withValidatedArgs(
  'read_knowledge', AccountContentSchema, readAccountContent,
);

async function readAccountContent(
  args: AccountContentArgs,
  _env: Env,
  ctx: AccountContentContext,
): Promise<GetContentResult> {
  if (!ctx.isAuthenticated || !ctx.userId || ctx.agentId || ctx.actingAutomationId) {
    throw new ToolUserError('Authenticated user required for personal MCP activity.', 401);
  }
  if ((ctx.tokenType === 'oauth' || ctx.tokenType === 'pat') &&
      !hasRequiredMcpScope('read', ctx.scopes)) {
    throw new ToolUserError('read_knowledge requires an MCP session with read access.', 403);
  }
  const exact = (args.content_ids?.length ?? 0) > 0;
  if (exact ? args.mcp_activity_id !== undefined || args.client_ids !== undefined
    : !args.mcp_activity_id?.trim() || !args.client_ids?.length) {
    throw new ToolUserError('Select content_ids or an exact mcp_activity_id with client_ids.', 400);
  }
  const limit = args.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (args.content_ids?.length ?? 0) > 100 ||
      args.content_ids?.some(id => !Number.isSafeInteger(id) || id < 1) ||
      (args.client_ids?.length ?? 0) > 100 ||
      args.client_ids?.some(id => !id.trim() || id.length > 512)) {
    throw new ToolUserError('Personal MCP activity reads accept 1–100 rows and valid exact IDs.', 400);
  }
  if ((args.offset ?? 0) !== 0 || (args.sort_by && args.sort_by !== 'date') ||
      (args.sort_order && args.sort_order !== 'desc') ||
      (args.include_classification && args.include_classification !== 'summary')) {
    throw new ToolUserError('Personal MCP activity uses date-descending cursor pagination.', 400);
  }
  const before = args.before_occurred_at !== undefined || args.before_id !== undefined;
  const after = args.after_occurred_at !== undefined || args.after_id !== undefined;
  const cursorAt = before ? args.before_occurred_at : args.after_occurred_at;
  const cursorId = before ? args.before_id : args.after_id;
  if ((before && after) || (exact && (before || after)) ||
      ((before || after) && (!cursorAt || !Number.isFinite(Date.parse(cursorAt)) ||
        !Number.isSafeInteger(cursorId) || (cursorId ?? 0) < 1))) {
    throw new ToolUserError('Provide one complete date/id cursor for an activity listing.', 400);
  }

  const sql = getDb();
  // Select the indexed page before rendering. Audit ownership does not confer
  // access to entities, parent events, artifacts, or other referenced data.
  // In particular this query must never join a referenced workspace resource.
  const actor = sql`e.created_by = ${ctx.userId}
    AND e.semantic_type = 'audit' AND e.origin_type = 'tool_invocation'`;
  const cursor = before
    ? sql`AND (e.occurred_at, e.id) < (${cursorAt!}::timestamptz, ${cursorId!}::bigint)`
    : after ? sql`AND (e.occurred_at, e.id) > (${cursorAt!}::timestamptz, ${cursorId!}::bigint)` : sql``;
  const order = sql`e.occurred_at ${after ? sql`ASC` : sql`DESC`}, e.id ${after ? sql`ASC` : sql`DESC`}`;
  const page = exact
    ? sql`SELECT e.* FROM events e WHERE ${actor}
        AND e.id = ANY(${pgBigintArray(args.content_ids!)}::bigint[])
        ORDER BY ${order} LIMIT ${limit + 1}`
    : sql`SELECT e.* FROM unnest(${pgTextArray([...new Set(args.client_ids!)])}::text[]) requested(client_id)
        CROSS JOIN LATERAL (
          SELECT e.* FROM events e WHERE ${actor}
            AND e.client_id = requested.client_id
            AND COALESCE(NULLIF(e.metadata->>'mcp_conversation_id', ''),
              NULLIF(e.metadata->>'mcp_session_id', '')) = ${args.mcp_activity_id!}
            ${cursor}
          ORDER BY ${order} LIMIT ${limit + 1}
        ) e
        ORDER BY ${order} LIMIT ${limit + 1}`;
  // Equality per registration preserves the index order. ANY(client_ids) can
  // sort an entire conversation; merging these limited pages is bounded by
  // the number of registrations even after years of activity.
  const rows = await sql<ContentRow>`
    SELECT e.id, e.title, e.author_name, e.source_url, e.occurred_at,
      e.created_at, e.origin_id, e.origin_type, e.semantic_type, e.payload_type,
      e.payload_text, e.metadata, e.client_id, oc.client_name,
      ${exact ? sql`e.payload_data` : sql`e.payload_data - 'request' - 'request_bytes'`} AS payload_data,
      e.connector_key AS platform, e.score, '{}'::jsonb AS classifications,
      ARRAY[]::bigint[] AS entity_ids
    FROM (${page}) e
    LEFT JOIN oauth_clients oc ON oc.id = e.client_id
    ORDER BY ${order}
  `;
  const hasMore = rows.length > limit;
  const rawContent = rows.slice(0, limit);
  if (after) rawContent.reverse();
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  const content = await buildContentItems({
    sql, rawContent, organizationId: null, ownerSlug: 'me',
    baseUrl,
    excerptsMap: new Map(), includePrivateAttribution: true,
  });
  for (const item of content) {
    item.permalink = `${baseUrl ?? ''}/me/events?content_ids=${item.id}`;
  }
  await hydrateToolInvocationRequests({
    sql, items: content, userId: ctx.userId, restoreRequests: exact,
  });
  return {
    content,
    // Like the chronological workspace reader, avoid counting growing history.
    total: content.length,
    page: { limit, offset: 0, has_more: hasMore,
      has_older: after ? true : hasMore,
      has_newer: after ? hasMore : before },
  };
}
