/**
 * Device-pin tombstones on `connections.error_message`.
 *
 * DELETE /api/me/devices and PATCH device org-move un-pin connections and
 * stamp a fixed error string so the UI can explain why a connector stopped.
 * When a device re-registers / is re-pinned, every restore path MUST clear
 * those strings — otherwise the connection is `active` + green while the
 * header still shows red "Device was removed".
 *
 * Keep stamp and clear sites on these exact literals (single source of truth).
 */

import { pgTextArray, type DbClient } from '../db/client';

/** Exact `connections.error_message` values written when a device pin is torn down. */
export const DEVICE_PIN_TOMBSTONE_MESSAGES = [
	'Device was removed',
	'Device was moved to another workspace',
] as const;

export type DevicePinTombstoneMessage =
	(typeof DEVICE_PIN_TOMBSTONE_MESSAGES)[number];

export const DEVICE_REMOVED_TOMBSTONE: DevicePinTombstoneMessage =
	'Device was removed';
export const DEVICE_MOVED_TOMBSTONE: DevicePinTombstoneMessage =
	'Device was moved to another workspace';

export function isDevicePinTombstone(
	message: string | null | undefined,
): message is DevicePinTombstoneMessage {
	return (
		typeof message === 'string' &&
		(DEVICE_PIN_TOMBSTONE_MESSAGES as readonly string[]).includes(message)
	);
}

/**
 * True when a listed connection still has a live device_workers row for its pin
 * (join populated `device_last_seen_at` / handle). Tombstone should not be shown.
 */
export function connectionHasLiveDevicePin(row: {
	device_worker_id?: string | null;
	device_last_seen_at?: string | Date | null;
	device_worker_handle?: string | null;
	device_label?: string | null;
}): boolean {
	if (!row.device_worker_id) return false;
	// Any of these being set means the LEFT JOIN to device_workers matched.
	return (
		row.device_last_seen_at != null ||
		row.device_worker_handle != null ||
		row.device_label != null
	);
}

/**
 * Effective error for API responses: suppress pin-tombstones once a device is
 * pinned again (even if a write path forgot to clear the column).
 */
export function effectiveConnectionErrorMessage(row: {
	error_message?: string | null;
	device_worker_id?: string | null;
	device_last_seen_at?: string | Date | null;
	device_worker_handle?: string | null;
	device_label?: string | null;
}): string | null {
	const msg = row.error_message ?? null;
	if (isDevicePinTombstone(msg) && connectionHasLiveDevicePin(row)) {
		return null;
	}
	return msg;
}

/**
 * Clear device-pin tombstones (and un-pause if needed) when a connection is
 * pinned to one of `matchingDeviceIds` (fresh devices that can serve it).
 *
 * Safe no-op when the connection has no such pin or a different error.
 */
export async function clearDevicePinTombstoneIfPinned(
	db: DbClient,
	params: {
		connectionId: number;
		/** Device worker ids currently allowed to hold this pin (fresh fleet). */
		matchingDeviceIds: string[];
	},
): Promise<void> {
	if (params.matchingDeviceIds.length === 0) return;
	await db`
    UPDATE connections
    SET error_message = NULL,
        status = CASE
          WHEN status = 'paused' THEN 'active'
          ELSE status
        END,
        updated_at = NOW()
    WHERE id = ${params.connectionId}
      AND device_worker_id IS NOT NULL
      AND device_worker_id::text = ANY(${pgTextArray(params.matchingDeviceIds)}::text[])
      AND error_message = ANY(${pgTextArray([...DEVICE_PIN_TOMBSTONE_MESSAGES])}::text[])
      AND deleted_at IS NULL
  `;
}


/**
 * `connections.error_message` prefix stamped when a team-workspace member's
 * devices homed there advertise only an OLDER version of the connector than
 * the one the workspace runs. Their connection and its feeds are paused until
 * a device of theirs advertises the workspace's version; device
 * reconciliation then clears this stamp (`clearDeviceUpgradeRequired`).
 */
export const DEVICE_UPGRADE_REQUIRED_PREFIX = 'Update Lobu on this device to use ';

export function deviceUpgradeRequiredMessage(params: {
	connectorName: string;
	workspaceName: string;
	workspaceVersion: string;
	deviceVersion: string;
}): string {
	return `${DEVICE_UPGRADE_REQUIRED_PREFIX}${params.connectorName} in ${params.workspaceName}: this workspace runs version ${params.workspaceVersion}, your device has ${params.deviceVersion}.`;
}

/**
 * Clear an upgrade-required stamp once the connection's owner has a device
 * advertising the workspace's version: re-activate the connection and resume
 * the feeds that pause stopped. A feed the failure policy hard-paused
 * (`consecutive_failures` at the pause threshold) stays paused, as on every
 * device re-arm path. Safe no-op for any other error message.
 */
export async function clearDeviceUpgradeRequired(
	db: DbClient,
	params: { connectionId: number; feedPauseThreshold: number },
): Promise<void> {
	await db`
    WITH cleared AS (
      UPDATE connections
      SET error_message = NULL,
          status = CASE WHEN status = 'paused' THEN 'active' ELSE status END,
          updated_at = NOW()
      WHERE id = ${params.connectionId}
        AND starts_with(error_message, ${DEVICE_UPGRADE_REQUIRED_PREFIX})
        AND deleted_at IS NULL
      RETURNING id
    )
    UPDATE feeds f
    SET status = 'active',
        next_run_at = CASE WHEN f.schedule IS NULL THEN f.next_run_at
                           ELSE COALESCE(f.next_run_at, NOW()) END,
        updated_at = current_timestamp
    FROM cleared
    WHERE f.connection_id = cleared.id
      AND f.status = 'paused'
      AND f.deleted_at IS NULL
      AND f.consecutive_failures < ${params.feedPauseThreshold}
  `;
}
