import { describe, expect, test } from "bun:test";
import { describeInFlightDeviceWaits } from "../../sandbox/device-wait-activity";
import type { DeviceWaitActivity } from "../../tools/registry";

describe("describeInFlightDeviceWaits", () => {
	test("nothing in flight, or no collector at all, adds nothing", () => {
		expect(describeInFlightDeviceWaits(undefined)).toBeNull();
		expect(describeInFlightDeviceWaits(new Map())).toBeNull();
	});

	test("names the run, its phase, the risk, what to check and how to avoid it", () => {
		const deviceWaits: DeviceWaitActivity = new Map([[41, "executing"]]);
		expect(describeInFlightDeviceWaits(deviceWaits)).toBe(
			"operations.execute run 41 reached the script deadline (phase: executing). " +
				"The command may still be running on the device or may already have changed things; once the run is marked timeout, its output is discarded. " +
				"Don't rerun it blindly: read operations.getRun(41) first. " +
				"For long device work, pass background: true and an idempotency_key on the first operations.execute call, then read operations.getRun(run_id) in a later call.",
		);
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
