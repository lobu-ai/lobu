/**
 * Device-pin tombstones on `connections.error_message`.
 *
 * Pure literals and predicates live in `@lobu/core/device-pin-tombstones`
 * (single source of truth, shared with the Owletto client) and are
 * re-exported here so existing import sites keep working. This module adds
 * the DB-backed clear used by device restore paths.
 *
 * When a device re-registers / is re-pinned, every restore path MUST clear
 * those strings — otherwise the connection is `active` + green while the
 * header still shows red "Device was removed".
 */

import { pgTextArray, type DbClient } from '../db/client';

export {
	DEVICE_MOVED_TOMBSTONE,
	DEVICE_PIN_TOMBSTONE_MESSAGES,
	DEVICE_REMOVED_TOMBSTONE,
	connectionHasLiveDevicePin,
	effectiveConnectionErrorMessage,
	isDevicePinTombstone,
	type DevicePinTombstoneMessage,
} from '@lobu/core/device-pin-tombstones';
import { DEVICE_PIN_TOMBSTONE_MESSAGES } from '@lobu/core/device-pin-tombstones';

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
