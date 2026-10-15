/**
 * POST /api/workers/me/automations/:automation_id/trigger
 *
 * Manually fire an automation run from the device that owns it. The Mac app's
 * "Run now" action posts here. Unlike the scheduled path, this:
 *   - does NOT advance `automations.next_run_at` (manual fires shouldn't shift
 *     the cron schedule);
 *   - is idempotent against active runs — re-trigger while a previous run is
 *     pending/claimed/running returns the existing `run_id` with
 *     `already_queued: true`;
 *   - requires the calling token's bound `device_workers.id` to match
 *     `automations.device_worker_id`. No cross-device triggering.
 *
 * Auth: same `/api/workers/*` middleware. `device_worker:run` scope (granted
 * to Mac-app PATs minted via the device-link flow).
 */

import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { errorMessage, ToolUserError } from '../utils/errors';
import logger from '../utils/logger';
import { enqueueAutomationRunForAutomation } from '../automations/automation';

export async function triggerAutomationForDevice(c: Context<{ Bindings: Env }>) {
  const automationIdParam = c.req.param('automation_id');
  if (!automationIdParam) {
    return c.json({ error: 'automation_id is required' }, 400);
  }
  const automationId = Number(automationIdParam);
  if (!Number.isFinite(automationId) || automationId <= 0) {
    return c.json({ error: 'Invalid automation_id' }, 400);
  }

  // The middleware already verified a device token (`device_worker:run`, no
  // MCP resource). The trigger surface is user-scoped only — trusted server
  // workers shouldn't be triggering device-pinned automations, that's what the
  // scheduled path is for.
  if (c.var.workerAuthMode !== 'user') {
    return c.json({ error: 'Endpoint is user-scoped only' }, 403);
  }
  const workerUserId = c.var.workerUserId;
  if (!workerUserId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Resolve the caller's bound device worker. mcpAuth populates
  // `mcpAuthInfo.workerId` from the PAT row. Without a bound workerId there's
  // no way to authorize the trigger — manual fires must come from a known
  // physical device.
  const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
  if (!boundWorkerId) {
    return c.json({ error: 'Token is not bound to a device worker' }, 403);
  }

  const sql = getDb();
  let resolvedDeviceWorkerId: string;
  try {
    const deviceRows = (await sql`
      SELECT id, organization_id
      FROM device_workers
      WHERE user_id = ${workerUserId} AND worker_id = ${boundWorkerId}
      LIMIT 1
    `) as unknown as Array<{ id: string; organization_id: string | null }>;
    const device = deviceRows[0];
    if (!device) {
      return c.json({ error: 'Device not registered yet — poll first' }, 404);
    }
    resolvedDeviceWorkerId = device.id;
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[triggerAutomationForDevice] device lookup failed');
    return c.json({ error: 'Internal error' }, 500);
  }

  // Load the automation and enforce two checks:
  //   (1) the automation is in the caller's org scope (auth middleware computed
  //       `workerOrgIds` from the token-bound org + the user's personal org);
  //   (2) `automations.device_worker_id` matches the caller's device. Even if
  //       the user owns both devices, A cannot trigger an automation pinned to B
  //       — that's a different pairing in the UI.
  const automationRows = (await sql`
    SELECT id, organization_id, managed_agent_id, status, device_worker_id::text AS device_worker_id
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `) as unknown as Array<{
    id: number;
    organization_id: string;
    managed_agent_id: string | null;
    status: string;
    device_worker_id: string | null;
  }>;
  const automation = automationRows[0];
  if (!automation) {
    return c.json({ error: 'Automation not found' }, 404);
  }

  // Org scope: the automation's org must be in the caller's base scope OR be a
  // cross-org pin the caller still has access to. The pin to THIS device is
  // verified next (the consent); here we just confirm membership of the
  // automation's org for the cross-org case, mirroring the poll's membership gate.
  const orgIds = c.var.workerOrgIds ?? [];
  if (!orgIds.includes(automation.organization_id)) {
    // workerUserId is guaranteed non-null by the guard above.
    const memberRows = (await sql`
      SELECT 1 FROM "member"
      WHERE "organizationId" = ${automation.organization_id} AND "userId" = ${workerUserId}
      LIMIT 1
    `) as unknown as Array<unknown>;
    if (memberRows.length === 0) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }
  if (!automation.device_worker_id || automation.device_worker_id !== resolvedDeviceWorkerId) {
    return c.json({ error: 'Automation is not pinned to this device' }, 403);
  }
  if ((automation.status ?? 'active') !== 'active') {
    return c.json({ error: 'Automation is not active' }, 409);
  }

  // Enqueue (or re-use) the run. `enqueueAutomationRunForAutomation` delegates to
  // `createAutomationRun`, which checks for an active run in the same automation_id
  // lane and reuses it (returns `created: false`). That gives us broad
  // idempotency across pending/claimed/running — re-trigger never starts a
  // second run while the first is still in flight. We intentionally do NOT
  // advance `automations.next_run_at` here so a manual fire doesn't shift the
  // cron schedule.
  try {
    const result = await enqueueAutomationRunForAutomation(automationId, 'manual');
    return c.json(
      {
        run_id: result.runId,
        status: result.status,
        already_queued: !result.created,
        queued_at: new Date().toISOString(),
      },
      200
    );
  } catch (err) {
    if (err instanceof ToolUserError) {
      return c.json(
        { error: err.message },
        err.httpStatus as import("hono/utils/http-status").ContentfulStatusCode
      );
    }
    logger.error(
      { error: errorMessage(err), automationId },
      '[triggerAutomationForDevice] enqueue failed'
    );
    return c.json({ error: errorMessage(err) }, 500);
  }
}
