import { ConnectorHttpRequestSchema } from '@lobu/core/contracts/worker/protocol';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Context } from 'hono';
import { intervals } from '../config/intervals';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { fetchConnectionHttp } from '../utils/http-auth';

const HttpFetchRequestSchema = Type.Object({
  worker_id: Type.String({ minLength: 1 }),
  run_id: Type.Integer({ minimum: 1 }),
  request: ConnectorHttpRequestSchema,
}, { additionalProperties: false });

/** Spend only the HTTP credential bound to this fleet worker's live run. */
export async function fetchWorkerHttp(c: Context<{ Bindings: Env }>) {
  // Also enforce the fleet boundary when this handler is mounted independently.
  if (c.var.workerAuthMode !== 'trusted' && c.var.workerAuthMode !== 'anonymous') {
    return c.json({ error: 'Endpoint not available to this worker' }, 403);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!Value.Check(HttpFetchRequestSchema, raw) || !raw.worker_id.trim()) {
    return c.json({ error: 'Invalid HTTP fetch request' }, 400);
  }

  const sql = getDb();
  // Ownership, admission and liveness are checked for fleet workers too;
  // authorizeRunForWorker intentionally only scopes user-token requests.
  const [run] = await sql<{ organization_id: string; connection_id: number }>`
    SELECT r.organization_id, r.connection_id
    FROM runs r
    JOIN connections con
      ON con.id = r.connection_id AND con.organization_id = r.organization_id
    WHERE r.id = ${raw.run_id}
      AND r.run_type IN ('sync', 'action')
      AND r.status = 'running'
      AND r.claimed_by = ${raw.worker_id}
      AND r.approval_status IN ('auto', 'approved')
      AND COALESCE(r.last_heartbeat_at, r.claimed_at)
        >= current_timestamp - make_interval(secs => ${intervals.runsReaperStaleAfterSeconds})
      AND con.deleted_at IS NULL
    LIMIT 1
  `;
  if (!run) return c.json({ error: 'Run is not an authorized live claim' }, 409);

  try {
    return c.json(await fetchConnectionHttp({
      organizationId: run.organization_id,
      connectionId: Number(run.connection_id),
      request: raw.request,
      signal: c.req.raw.signal,
    }));
  } catch {
    // A transport error can contain the authenticated URL or request headers.
    return c.json({ error: 'Gateway HTTP request failed' }, 502);
  }
}
