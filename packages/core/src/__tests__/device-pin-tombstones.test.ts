import { describe, expect, test } from "bun:test";
import {
  connectionHasLiveDevicePin,
  DEVICE_MOVED_TOMBSTONE,
  DEVICE_PIN_TOMBSTONE_MESSAGES,
  DEVICE_REMOVED_TOMBSTONE,
  effectiveConnectionErrorMessage,
  isDevicePinTombstone,
} from "../device-pin-tombstones";

describe("device-pin tombstones", () => {
  test("recognizes exactly the two stamp literals", () => {
    expect(DEVICE_PIN_TOMBSTONE_MESSAGES).toEqual([
      "Device was removed",
      "Device was moved to another workspace",
    ]);
    expect(DEVICE_REMOVED_TOMBSTONE).toBe("Device was removed");
    expect(DEVICE_MOVED_TOMBSTONE).toBe(
      "Device was moved to another workspace"
    );
    expect(isDevicePinTombstone("Device was removed")).toBe(true);
    expect(isDevicePinTombstone("OAuth token expired")).toBe(false);
    expect(isDevicePinTombstone(null)).toBe(false);
  });

  test("a live pin suppresses the tombstone, a dead pin keeps it", () => {
    expect(
      connectionHasLiveDevicePin({
        device_worker_id: "w1",
        device_label: "Mac",
      })
    ).toBe(true);
    expect(connectionHasLiveDevicePin({ device_worker_id: null })).toBe(false);
    expect(
      effectiveConnectionErrorMessage({
        error_message: "Device was removed",
        device_worker_id: "w1",
        device_label: "Mac",
      })
    ).toBeNull();
    expect(
      effectiveConnectionErrorMessage({
        error_message: "Device was removed",
        device_worker_id: null,
      })
    ).toBe("Device was removed");
    expect(
      effectiveConnectionErrorMessage({
        error_message: "OAuth token expired",
        device_worker_id: "w1",
        device_label: "Mac",
      })
    ).toBe("OAuth token expired");
  });
});
