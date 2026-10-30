import { describe, expect, test } from "bun:test";
import { describeInFlightDeviceWaits } from "../../sandbox/device-wait-activity";
import type { DeviceWaitActivity } from "../../tools/registry";

describe("describeInFlightDeviceWaits", () => {
	test("nothing in flight, or no collector at all, adds nothing", () => {
		expect(describeInFlightDeviceWaits(undefined)).toBeNull();
		expect(describeInFlightDeviceWaits(new Map())).toBeNull();
	});

	test("several runs are listed with their phases, bounded", () => {
		const deviceWaits: DeviceWaitActivity = new Map();
		for (let runId = 1; runId <= 8; runId++) {
			deviceWaits.set(runId, runId % 2 ? "executing" : "waiting for claim");
		}
		const text = describeInFlightDeviceWaits(deviceWaits);
		expect(text).toStartWith(
			"operations.execute runs 1 (executing), 2 (waiting for claim), 3 (executing), 4 (waiting for claim), 5 (executing) and 3 more reached the script deadline.",
		);
		expect(text).toContain("Don't rerun them blindly: read operations.getRun(run_id) for each first.");
	});
});
