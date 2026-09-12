import { type DbClient, parsePgNumberArray } from '../db/client';
import type { Env } from '../index';
import type { ToolContext } from '../tools/registry';
import { requireAutomationAccess } from '../tools/admin/manage_automations/shared';
import type { DataSourceContext } from '../utils/execute-data-sources';
import { errorMessage, ToolUserError } from '../utils/errors';
import { verifyWindowToken } from '../utils/jwt';
import { automationTriggerSignals, isWorkspaceEventTriggerSignal } from './workspace-event-contract';

interface BoundAutomationRun {
  versionId: number | null;
  windowStart: Date;
  windowEnd: Date;
  triggerContentIds: number[];
  entityIds: number[];
  status: string;
  expiresAt: string | null;
  runType: string;
}

/**
 * Resolve execution inputs already snapshotted on a durable run.
 *
 * In Automation mode the existing run_id argument binds the read to the queued
 * run instead of recomputing the live cursor or current version.
 */
export async function loadBoundAutomationRun(
  sql: DbClient,
  organizationId: string,
  automationId: number,
  runId: number
): Promise<BoundAutomationRun> {
  const rows = await sql<{ approved_input: unknown; entity_ids: unknown; status: string; expires_at: Date | null; run_type: string }>`
    SELECT r.approved_input, r.status, r.expires_at, r.run_type, a.entity_ids
    FROM runs r
    JOIN automations a ON a.id = r.automation_id AND a.organization_id = r.organization_id
    WHERE r.id = ${runId}
      AND r.organization_id = ${organizationId}
      AND r.automation_id = ${automationId}
      AND r.run_type IN ('automation', 'automation_eval')
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(
      `Automation run ${runId} does not belong to Automation ${automationId}.`,
      404
    );
  }

  const raw = rows[0].approved_input;
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const windowStart = new Date(
    typeof input.window_start === 'string' ? input.window_start : ''
  );
  const windowEnd = new Date(
    typeof input.window_end === 'string' ? input.window_end : ''
  );
  if (
    Number.isNaN(windowStart.getTime()) ||
    Number.isNaN(windowEnd.getTime()) ||
    windowEnd.getTime() <= windowStart.getTime()
  ) {
    throw new ToolUserError(
      `Automation run ${runId} is missing a valid queued window snapshot.`,
      409
    );
  }
  const rawVersionId = input.version_id;
  const parsedVersionId =
    typeof rawVersionId === 'number'
      ? rawVersionId
      : typeof rawVersionId === 'string' && rawVersionId.trim()
        ? Number(rawVersionId)
        : Number.NaN;
  const versionId =
    Number.isSafeInteger(parsedVersionId) && parsedVersionId > 0
      ? parsedVersionId
      : null;

  return {
    versionId,
    entityIds: parsePgNumberArray(rows[0].entity_ids),
    status: rows[0].status,
    expiresAt: rows[0].expires_at ? new Date(rows[0].expires_at).toISOString() : null,
    runType: rows[0].run_type,
    windowStart,
    windowEnd,
    triggerContentIds: automationTriggerSignals(input)
      .filter(isWorkspaceEventTriggerSignal)
      .map((signal) => signal.event_id),
  };
}

/** A token selects event versions; it never substitutes for the caller's current access. */
export async function resolveWindowQueryContext(
  token: string,
  env: Env,
  ctx: ToolContext,
  sql: DbClient
): Promise<Pick<DataSourceContext, 'windowStart' | 'windowEnd' | 'entityIds' | 'excludeProducedByAutomationId'>> {
  let payload: Awaited<ReturnType<typeof verifyWindowToken>>;
  try {
    payload = await verifyWindowToken(token, env);
  } catch (error) {
    throw new ToolUserError(`Invalid SQL window_token: ${errorMessage(error)}`, 400);
  }
  if (!Number.isSafeInteger(payload.run_id) || !payload.run_id ||
      !Number.isSafeInteger(payload.automation_id) || payload.automation_id < 1) {
    throw new ToolUserError('SQL window_token must come from a run-bound Automation read.', 400);
  }
  await requireAutomationAccess(sql, [String(payload.automation_id)], ctx, 'read');
  const run = await loadBoundAutomationRun(sql, ctx.organizationId, payload.automation_id, payload.run_id);
  if (run.windowStart.toISOString() !== payload.window_start || run.windowEnd.toISOString() !== payload.window_end) {
    throw new ToolUserError('SQL window_token does not match the queued Automation window.', 409);
  }
  if (!['pending', 'claimed', 'running'].includes(run.status)) {
    throw new ToolUserError('SQL window_token belongs to an inactive Automation run.', 409);
  }
  if (run.runType !== (ctx.executionMode === 'capture' ? 'automation_eval' : 'automation')) {
    throw new ToolUserError('SQL window_token does not belong to this execution mode.', 409);
  }
  if (run.expiresAt !== (payload.lease_expires_at ?? null) ||
      (run.expiresAt && new Date(run.expiresAt).getTime() <= Date.now())) {
    throw new ToolUserError('SQL window_token has an expired or replaced lease; use the latest page token.', 409);
  }
  return {
    windowStart: payload.window_start,
    windowEnd: payload.window_end,
    entityIds: run.entityIds,
    excludeProducedByAutomationId: payload.automation_id,
  };
}
