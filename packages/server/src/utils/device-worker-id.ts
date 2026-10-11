import { z } from 'zod';
import type { DbClient } from '../db/client';

/**
 * Reject non-UUID inputs before a device lookup can fail with a Postgres cast
 * error. If the caller supplied their own worker_id instead of device_workers.id,
 * suggest the corresponding device id without exposing another user's device.
 * UUID-shaped inputs still need the caller's normal existence and access checks.
 */
export async function describeNonDeviceWorkerId(
  sql: DbClient,
  deviceWorkerId: string,
  userId: string | null | undefined
): Promise<string | null> {
  if (z.guid().safeParse(deviceWorkerId).success) return null;
  const byWorkerId = (await sql`
    SELECT id FROM device_workers
    WHERE worker_id = ${deviceWorkerId} AND user_id = ${userId ?? null}
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
  return byWorkerId[0]
    ? `'${deviceWorkerId}' is a worker id — pass the device id '${byWorkerId[0].id}' as device_worker_id.`
    : `device_worker_id must be a device id (a UUID from your device list); got '${deviceWorkerId}'.`;
}
