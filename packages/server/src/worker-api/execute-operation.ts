import { ExecuteConnectorOperationRequestSchema } from '@lobu/core/contracts/worker/protocol';
import { Value } from '@sinclair/typebox/value';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../index';
import { executeConnectorOperation as delegateOperation } from '../operations/connector-delegation';
import { handleExecute } from '../tools/admin/manage_operations/handlers/execute';
import { ToolUserError } from '../utils/errors';

export function executeConnectorOperation(params: Parameters<typeof delegateOperation>[0]) {
  return delegateOperation(params, handleExecute);
}

export async function executeWorkerOperation(c: Context<{ Bindings: Env }>) {
  if (c.var.workerAuthMode !== 'trusted' && c.var.workerAuthMode !== 'anonymous') {
    return c.json({ error: 'Endpoint not available to this worker' }, 403);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!Value.Check(ExecuteConnectorOperationRequestSchema, raw) || !raw.worker_id.trim()) {
    return c.json({ error: 'Invalid connector operation request' }, 400);
  }
  try {
    return c.json(await executeConnectorOperation({
      parentRunId: raw.parent_run_id,
      claimedBy: raw.worker_id,
      request: raw.request,
      abortSignal: c.req.raw.signal,
    }));
  } catch (err) {
    // A lost parent claim, blocked parent or idempotency conflict is a typed
    // refusal for the guest, not an unhandled server error.
    if (err instanceof ToolUserError) {
      return c.json({ error: err.message }, err.httpStatus as ContentfulStatusCode);
    }
    throw err;
  }
}
