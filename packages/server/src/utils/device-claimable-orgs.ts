/**
 * Resolve which orgs a user-scoped device worker may claim runs in.
 *
 * Base scope (computed in the /api/workers/* auth middleware) is the token's
 * bound org plus the user's personal org. On top of that, a device may claim
 * runs in any org where it has a pinned automation/connection AND its owner is
 * still a member of that org.
 *
 * The pin IS the consent. A connection pin requires the device's owner and a
 * device attached to that org (`device-binding.ts`); an Automation pin
 * requires the owner, or an owner/admin of the org the device is attached to
 * (`evaluateDeviceWorkerAccess`). Either way a pin in org B was placed by
 * someone entitled to opt this device into serving org B. The membership join
 * means access is revoked automatically if the owner later leaves the org. Within-org claiming
 * still follows the pinned/capability rules in the poll, so the device only
 * ever runs the resource it was actually pinned to.
 *
 * Only `active` automations and non-deleted connections count — an archived
 * automation or deleted connection must not keep an org in scope.
 */
import type { DbClient } from '../db/client';

export async function resolveDeviceClaimableOrgs(
  sql: DbClient,
  params: { deviceWorkerId: string; ownerUserId: string; baseOrgIds: string[] }
): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT src.organization_id
    FROM (
      SELECT organization_id FROM automations
        WHERE device_worker_id = ${params.deviceWorkerId} AND status = 'active'
      UNION
      SELECT organization_id FROM connections
        WHERE device_worker_id = ${params.deviceWorkerId} AND deleted_at IS NULL
    ) src
    JOIN "member" m
      ON m."organizationId" = src.organization_id AND m."userId" = ${params.ownerUserId}
    WHERE src.organization_id IS NOT NULL
  `) as unknown as Array<{ organization_id: string }>;

  const pinnedOrgIds = rows
    .map((r) => r.organization_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return Array.from(new Set([...params.baseOrgIds, ...pinnedOrgIds]));
}

/**
 * Whether a user-scoped device worker may act on a run (claim / complete /
 * heartbeat). True when the run's org is in the worker's base scope, OR the
 * worker's user owns the device the run is pinned to — via either a pinned
 * connection (`device_owner`) or a pinned automation (`automation_device_owner`).
 * A pin is that consent (see above), so a device may finish a run it was attached
 * to in any org, mirroring the claim-side scope.
 */
export function runInWorkerScope(
  run: {
    organization_id: string;
    device_owner: string | null;
    automation_device_owner: string | null;
  },
  ctx: { workerUserId: string | null; orgIds: string[] }
): boolean {
  if (ctx.orgIds.includes(run.organization_id)) return true;
  if (!ctx.workerUserId) return false;
  return (
    run.device_owner === ctx.workerUserId || run.automation_device_owner === ctx.workerUserId
  );
}
