import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { getDb } from '../db/client';
import type { Env } from '../index';

const routes = new Hono<{ Bindings: Env }>();
const MAX_BIGINT = 9223372036854775807n;

function validId(value: string): boolean {
  return /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_BIGINT;
}

interface InvocationRow {
  id: string;
  tool_name: string;
  success: boolean;
  created_at: Date;
  duration_ms: number;
  organization_id: string | null;
  organization_slug: string | null;
  client_id: string | null;
  client_name: string | null;
  activity_id: string | null;
  request_status: string | null;
  payload_data?: Record<string, unknown>;
}

function summary(row: InvocationRow) {
  return {
    id: String(row.id), toolName: row.tool_name, success: row.success,
    createdAt: new Date(row.created_at).toISOString(), durationMs: Number(row.duration_ms),
    organizationId: row.organization_id, organizationSlug: row.organization_slug,
    clientId: row.client_id, clientName: row.client_name,
    activityId: row.activity_id, requestStatus: row.request_status,
  };
}

// Account history can contain calls from several grants/apps. A token's user
// identity does not authorize that app to read the user's complete history.
routes.use('*', requireAuth);
routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

routes.get('/', async (c) => {
  const userId = c.var.session!.userId;
  const before = c.req.query('before');
  const rawLimit = c.req.query('limit') ?? '50';
  const clientId = c.req.query('client_id');
  const activityId = c.req.query('activity_id');
  if ((before !== undefined && !validId(before)) || !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
      (clientId !== undefined && (clientId.length === 0 || clientId.length > 512)) ||
      (activityId !== undefined && (activityId.length === 0 || activityId.length > 512))) {
    return c.json({ error: 'Invalid history filter' }, 400);
  }
  const limit = Math.min(Number(rawLimit), 100);
  const sql = getDb();
  const rows = await sql<InvocationRow>`
    SELECT i.id::text, i.tool_name, i.success, i.created_at, i.duration_ms,
      i.organization_id, o.slug AS organization_slug,
      i.client_id, oc.client_name, i.activity_id,
      i.payload_data->>'request_status' AS request_status
    FROM user_tool_invocations i
    LEFT JOIN organization o ON o.id = i.organization_id
    LEFT JOIN oauth_clients oc ON oc.id = i.client_id
    WHERE i.user_id = ${userId}
      ${before ? sql`AND i.id < ${before}::bigint` : sql``}
      ${clientId ? sql`AND i.client_id = ${clientId}` : sql``}
      ${activityId ? sql`AND i.activity_id = ${activityId}` : sql``}
    ORDER BY i.id DESC LIMIT ${limit + 1}
  `;
  return c.json({
    invocations: rows.slice(0, limit).map(summary),
    nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null,
  });
});

routes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!validId(id)) return c.json({ error: 'Invocation not found' }, 404);
  const rows = await getDb()<InvocationRow>`
    SELECT i.id::text, i.tool_name, i.success, i.created_at, i.duration_ms,
      i.organization_id, o.slug AS organization_slug,
      i.client_id, oc.client_name, i.activity_id,
      i.payload_data->>'request_status' AS request_status, i.payload_data
    FROM user_tool_invocations i
    LEFT JOIN organization o ON o.id = i.organization_id
    LEFT JOIN oauth_clients oc ON oc.id = i.client_id
    WHERE i.user_id = ${c.var.session!.userId} AND i.id = ${id}::bigint
  `;
  const row = rows[0];
  if (!row) return c.json({ error: 'Invocation not found' }, 404);
  return c.json({ ...summary(row), payload: row.payload_data });
});

export const toolInvocationRoutes = routes;
