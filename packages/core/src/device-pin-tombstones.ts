/**
 * Device-pin tombstones on `connections.error_message`.
 *
 * DELETE /api/me/devices and PATCH device org-move un-pin connections and
 * stamp a fixed error string so the UI can explain why a connector stopped.
 * When a device re-registers / is re-pinned, every restore path MUST clear
 * those strings — otherwise the connection is `active` + green while the
 * header still shows red "Device was removed".
 *
 * Single source of truth for the stamp/clear literals and the live-pin
 * predicate. The gateway (`packages/server/src/utils/device-pin-tombstones.ts`,
 * which adds the DB clear) and the Owletto client
 * (`packages/owletto/src/lib/device-pin-tombstone.ts`, which adds the display
 * mask) both re-export this module. Keep stamp and clear sites on these exact
 * literals.
 */

/** Exact `connections.error_message` values written when a device pin is torn down. */
export const DEVICE_PIN_TOMBSTONE_MESSAGES = [
  "Device was removed",
  "Device was moved to another workspace",
] as const;

export type DevicePinTombstoneMessage =
  (typeof DEVICE_PIN_TOMBSTONE_MESSAGES)[number];

export const DEVICE_REMOVED_TOMBSTONE: DevicePinTombstoneMessage =
  "Device was removed";
export const DEVICE_MOVED_TOMBSTONE: DevicePinTombstoneMessage =
  "Device was moved to another workspace";

export function isDevicePinTombstone(
  message: string | null | undefined
): message is DevicePinTombstoneMessage {
  return (
    typeof message === "string" &&
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
