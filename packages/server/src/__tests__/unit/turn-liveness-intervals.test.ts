/**
 * Turn-liveness timing invariants.
 *
 * These constants are not independent knobs: each deadline below is only
 * correct relative to the signal that extends it. They drifted apart once
 * already — `turnDefaultDeadlineMs` was 60s, sized for the subprocess lane's
 * 20s `status_update`, and stayed 60s after the isolate lane replaced that lane
 * with a 30s heartbeat. One late beat then lapsed the marker of a healthy turn,
 * which emitted a spurious terminal error while the worker kept running.
 *
 * Asserting the INEQUALITIES rather than the literals is deliberate: the
 * deadlines are env-overridable, so an operator can reintroduce exactly that
 * bug without touching this repo. These tests fail on the relationship,
 * whatever the numbers are.
 */

import { describe, expect, test } from "bun:test";
import { intervals } from "../../config/intervals.js";

describe("turn-liveness intervals", () => {
	test("the execution deadline clears three heartbeats", () => {
		// Two beats is not enough: a beat carries a 15s HTTP timeout, so a single
		// slow one can push the gap past twice the cadence without the worker
		// being unhealthy.
		expect(intervals.turnDefaultDeadlineMs).toBeGreaterThanOrEqual(
			3 * intervals.isolateTurnHeartbeatMs
		);
	});

	test("the sweep runs often enough to observe a lapsed deadline", () => {
		// A sweep slower than the deadline turns the deadline into the sweep
		// cadence, silently.
		expect(intervals.turnLivenessSweepIntervalMs).toBeLessThan(
			intervals.turnDefaultDeadlineMs
		);
	});

	test("the run reaper does not fire before the turn deadline", () => {
		// The reaper writes WORKER_DIED and the marker writes WORKER_UNRESPONSIVE.
		// If the reaper could fire first the two codes would race for the same
		// condition and the client's error would be arbitrary. Transitively this
		// is also what keeps the reaper clear of three missed heartbeats.
		expect(intervals.runsReaperStaleAfterSeconds * 1000).toBeGreaterThan(
			intervals.turnDefaultDeadlineMs
		);
	});
});
