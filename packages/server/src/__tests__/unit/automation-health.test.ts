import { describe, expect, it } from "bun:test";
import { computeAutomationHealth } from "../../automations/automation-health";

const NOW = 1_700_000_000_000;

describe("computeAutomationHealth", () => {
	it("does not mistake externally due work for a missed native dispatch, but surfaces failure", () => {
		const input = { status: "active", nextRunAt: new Date(NOW - 3600_000), externalExecutor: true };
		expect(computeAutomationHealth(input, NOW).health).toBe("healthy");
		expect(computeAutomationHealth({ ...input, latestRunStatus: "failed" }, NOW).health).toBe("degraded");
	});
	it("puts the durable schedule auto-pause reason first", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: null,
				consecutiveScheduledFailures: 5,
				scheduleAutoPausedAt: new Date(NOW - 60_000).toISOString(),
				latestRunStatus: "failed",
				latestRunError: "executor timed out",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.reasons[0]).toBe(
			"schedule auto-paused after 5 consecutive execution failures",
		);
	});

	it("degrades an active automation whose latest run failed", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(), // on schedule
				latestRunStatus: "failed",
				latestRunError: "No model is configured",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.last_scheduling_error).toBe("No model is configured");
		expect(result.reasons.join(" ")).toContain("No model is configured");
		expect(result.last_run_outcome).toBeNull();
	});

	it("labels the degraded reason with the stamped run outcome", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "failed",
				latestRunError: "z.ai returned an error:\n429 Weekly/Monthly Limit Exhausted",
				latestRunOutcome: "infra_error",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.last_run_outcome).toBe("infra_error");
		expect(result.reasons.join(" ")).toContain("latest run failed (infra_error)");
	});

	it("echoes a scoreable outcome on a healthy automation", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "completed",
				latestRunOutcome: "scoreable",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
		expect(result.last_run_outcome).toBe("scoreable");
	});

	it("degrades on a timeout latest run too", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "timeout",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
	});

	it("stays healthy when the latest run succeeded and the schedule is current", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "completed",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
		expect(result.reasons).toHaveLength(0);
	});

	it("degrades an event automation with neither activation stamp nor run", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: null,
				latestRunStatus: null,
				triggers: [
					{ kind: "event", connector_key: "slack", event_types: ["message.created"] },
				],
				lastEventActivationAt: null,
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.reasons).toContain(
			"event trigger configured, but no dispatch observed yet",
		);
	});

	it("keeps a stamped event automation healthy without Automation run history", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: null,
				latestRunStatus: null,
				triggers: [
					{ kind: "event", connector_key: "slack", event_types: ["message.created"] },
				],
				lastEventActivationAt: new Date(NOW - 60_000).toISOString(),
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
		expect(result.reasons).toHaveLength(0);
	});

	it("keeps a severe rolling failure pattern degraded after one success", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "completed",
				recentTerminalRunStatuses: [
					"completed",
					...Array.from({ length: 99 }, () => "failed"),
				],
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.reasons.join(" ")).toContain(
			"99 of 100 recent terminal runs failed or timed out",
		);
	});

	it("recovers once failures are below half of a meaningful recent window", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW + 60_000).toISOString(),
				latestRunStatus: "completed",
				recentTerminalRunStatuses: [
					...Array.from({ length: 6 }, () => "completed"),
					...Array.from({ length: 4 }, () => "failed"),
				],
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
		expect(result.reasons).toHaveLength(0);
	});

	it("does not degrade an archived automation whose latest run failed", () => {
		const result = computeAutomationHealth(
			{
				status: "archived",
				nextRunAt: new Date(NOW - 10_000_000).toISOString(),
				latestRunStatus: "failed",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
	});

	it("still degrades on a missed firing when the run did not fail (regression)", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
				latestRunStatus: "completed",
			},
			NOW,
		);
		expect(result.health).toBe("degraded");
		expect(result.reasons.join(" ")).toContain("missed firing");
	});

	it("does not degrade an overdue schedule while a run is in flight", () => {
		const result = computeAutomationHealth(
			{
				status: "active",
				nextRunAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
				latestRunStatus: "running",
			},
			NOW,
		);
		expect(result.health).toBe("healthy");
	});
});
