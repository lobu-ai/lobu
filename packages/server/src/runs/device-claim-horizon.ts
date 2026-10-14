/**
 * Claim horizons of device actions queued behind a busy device.
 *
 * A pinned device action is claimable until `runs.expires_at` (stamped by
 * queue-service: the 60s queue budget for foreground work). Poll, the stale-run
 * reaper and the gateway waiter all enforce that one horizon. A device whose
 * slots are full still polls, with `capacity_available = 0`, and claims
 * nothing. Renewal lets queued work survive commands longer than that budget.
 *
 * So a zero-capacity poll renews the horizon of the runs pinned to the polling
 * device, but only when its claim of being full is backed by rows: a run the
 * device is actually executing. A device reporting zero capacity with nothing
 * running is not busy, and its queued runs lapse on schedule, as do those of a
 * device that stops polling. The renewal never revives a lapsed horizon, never
 * shortens one (explicit background runs already carry ten minutes), and never
 * extends past {@link DEVICE_BUSY_ACTION_QUEUE_CEILING_MS} from when the run
 * became claimable, so a wedged device cannot hold work forever.
 *
 * Source feed reads are excluded: they carry a caller's recall terms and the
 * reaper's lapsed-horizon scrub is their retention guarantee. Page-activated
 * runs keep their activation clock.
 */

import {
  DEVICE_ACTION_QUEUE_BUDGET_MS,
  DEVICE_BUSY_ACTION_QUEUE_CEILING_MS,
} from '../config/intervals';
import { type DbClient, pgTextArray } from '../db/client';
import {
  DEVICE_FEED_READ_ACTION_KEY,
  SOURCE_FEED_READ_METADATA_KEY,
} from '../lib/device-feed-read-protocol';

/**
 * Renew the claim horizons of pending actions pinned to a device that just
 * polled with no free slot. Returns how many horizons moved.
 */
export async function renewBusyDeviceClaimHorizons(
  sql: DbClient,
  deviceWorkerId: string,
  claimableOrgIds: string[]
): Promise<number> {
  const rows = await sql`
    WITH renewed AS (
      SELECT q.id,
        LEAST(
          now() + ${DEVICE_ACTION_QUEUE_BUDGET_MS}::int * interval '1 millisecond',
          CASE WHEN q.approval_status = 'approved' THEN q.run_at ELSE q.created_at END
            + ${DEVICE_BUSY_ACTION_QUEUE_CEILING_MS}::int * interval '1 millisecond'
        ) AS expires_at
      FROM runs q
      WHERE q.target_device_worker_id = ${deviceWorkerId}::uuid
        AND q.organization_id = ANY(${pgTextArray(claimableOrgIds)}::text[])
        AND q.status = 'pending'
        AND q.run_type = 'action'
        AND q.approval_status IN ('auto', 'approved')
        AND q.activation_kind IS NULL
        AND q.expires_at > now()
        AND q.action_key IS DISTINCT FROM ${DEVICE_FEED_READ_ACTION_KEY}
        AND q.run_metadata->>${SOURCE_FEED_READ_METADATA_KEY} IS DISTINCT FROM 'true'
        AND EXISTS (
          SELECT 1 FROM runs busy
          WHERE busy.executed_by_device_worker_id = ${deviceWorkerId}::uuid
            AND busy.status IN ('claimed', 'running')
        )
    )
    UPDATE runs r
    SET expires_at = renewed.expires_at
    FROM renewed
    WHERE r.id = renewed.id
      AND r.status = 'pending'
      AND renewed.expires_at > r.expires_at
    RETURNING r.id
  `;
  return rows.length;
}
