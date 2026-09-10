/**
 * POST /api/workers/read-operation
 *
 * Bridge for `ctx.operations.read` inside a connector running on a worker:
 * the guest names an imported operation, and the gateway resolves the
 * connection from the run this worker currently holds.
 *
 * Two gates, because they cover different callers: `authorizeRunForWorker`
 * scopes a user-bound device worker to runs in its own reach, and the query
 * below is what constrains a trusted fleet worker — the run must still be a
 * running connector execution claimed by this worker id.
 */

import type { ReadConnectorOperationRequest } from '@lobu/core/contracts/worker/protocol';
import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { connectorOperationReader } from '../tools/admin/manage_operations/handlers/execute';
import { authorizeRunForWorker } from './shared';

export async function readConnectorOperation(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as ReadConnectorOperationRequest | null;
  if (!body || !Number.isSafeInteger(body.parent_run_id) || body.parent_run_id < 1 ||
      typeof body.worker_id !== 'string' || !body.worker_id.trim() ||
      typeof body.operation_key !== 'string' || !body.operation_key.trim() ||
      (body.input !== undefined && (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)))) {
    return c.json({ error: 'Invalid connector operation request' }, 400);
  }
  const boundWorkerId = c.var.mcpAuthInfo?.workerId;
  if (boundWorkerId && boundWorkerId !== body.worker_id) return c.json({ error: 'worker_id_mismatch' }, 403);
  const denied = await authorizeRunForWorker(c, body.parent_run_id, body.worker_id);
  if (denied) return denied;
  const sql = getDb();
  // Scheduled syncs have no requester. The already-authorized active feed
  // runs for its connection owner, exactly on that connection. Do not apply
  // this fallback to action runs or to a missing/paused/mismatched feed.
  const [run] = await sql`
    SELECT r.organization_id, r.connection_id, r.automation_id,
           COALESCE(r.created_by_user_id,
             CASE WHEN r.run_type = 'sync' AND f.id IS NOT NULL THEN con.created_by END
           ) AS execution_user_id
    FROM runs r
    JOIN connections con ON con.id = r.connection_id AND con.organization_id = r.organization_id
    LEFT JOIN feeds f ON f.id = r.feed_id AND f.connection_id = r.connection_id
      AND f.organization_id = r.organization_id AND f.status = 'active' AND f.deleted_at IS NULL
    WHERE r.id = ${body.parent_run_id} AND r.status = 'running'
      AND r.claimed_by = ${body.worker_id} AND r.run_type IN ('sync', 'action')
      AND con.deleted_at IS NULL
  `;
  if (!run) return c.json({ error: 'No running connector execution claimed by this worker' }, 403);
  try {
    const output = await connectorOperationReader({
      organizationId: run.organization_id, principal: run.execution_user_id,
      actingAutomationId: run.automation_id == null ? undefined : Number(run.automation_id),
    }, Number(run.connection_id))(body.operation_key, body.input ?? {});
    return c.json({ output });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Imported read failed' }, 422);
  }
}
