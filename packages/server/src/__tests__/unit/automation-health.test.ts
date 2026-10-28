import { describe, expect, it } from "bun:test";
import { computeAutomationHealth } from "../../automations/automation-health";

const NOW = 1_700_000_000_000;

describe("computeAutomationHealth", () => {
	it("does not require a dispatch from an external reference-capture subscription", () => {
		const input = {
			status: "active", nextRunAt: null, externalExecutor: true,
			triggers: [{ kind: "event" as const, connector_key: "synthetic.source",
				event_types: ["message.created"], capture: "references" as const }],
		};
		expect(computeAutomationHealth(input, NOW)).toMatchObject({ health: "healthy", reasons: [] });
		// Native subscribers still dispatch, even when they also retain references.
		expect(computeAutomationHealth({ ...input, externalExecutor: false }, NOW).reasons)
			.toContain("event trigger configured, but no dispatch observed yet");
		// Capture does not hide an actual execution failure or circuit breaker.
		expect(computeAutomationHealth({ ...input, latestRunStatus: "failed" }, NOW).health).toBe("degraded");
		expect(computeAutomationHealth({ ...input, scheduleAutoPausedAt: new Date(NOW) }, NOW).health).toBe("degraded");
	});

	it("does not exempt dispatching triggers merely because capture or an external executor exists", () => {
		const capture = { kind: "event" as const, connector_key: "synthetic.source",
			event_types: ["message.created"], capture: "references" as const };
		for (const trigger of [
			{ kind: "event" as const, connector_key: "synthetic.source", event_types: ["message.created"] },
			{ kind: "event" as const, source: "workspace" as const, event_types: ["summary.created"] },
		]) {
			expect(computeAutomationHealth({ status: "active", nextRunAt: null,
				externalExecutor: true, triggers: [capture, trigger] }, NOW).reasons)
				.toContain("event trigger configured, but no dispatch observed yet");
		}
	});

	it("gives an external schedule the notification grace before calling its due window unclaimed", () => {
		const every5m = { kind: "schedule" as const, cron: "*/5 * * * *", timezone: "UTC" };
		const input = { status: "active", externalExecutor: true, triggers: [every5m],
			nextRunAt: new Date(NOW - 30 * 60_000) };
		// Thirty minutes late is six native margins, but a client may still be on its way.
		expect(computeAutomationHealth(input, NOW)).toMatchObject({ health: "healthy", reasons: [] });
		expect(computeAutomationHealth({ ...input, externalExecutor: false }, NOW).reasons.join(" "))
			.toContain("missed firing");
		// Past the hour nobody is doing the work; the reason names the external lane.
		const twoHoursLate = { ...input, nextRunAt: new Date(NOW - 2 * 3600_000) };
		expect(computeAutomationHealth(twoHoursLate, NOW).reasons)
			.toEqual(["no external client claimed the due window: next_run_at overdue by ~120 min"]);
		expect(computeAutomationHealth({ ...twoHoursLate, latestRunStatus: "running" }, NOW).health).toBe("healthy");
		// A daily cadence gets the clamped six hours, not a whole day.
		const daily = { ...input, triggers: [{ ...every5m, cron: "0 9 * * *" }] };
		expect(computeAutomationHealth({ ...daily, nextRunAt: new Date(NOW - 5 * 3600_000) }, NOW).health).toBe("healthy");
		expect(computeAutomationHealth({ ...daily, nextRunAt: new Date(NOW - 7 * 3600_000) }, NOW).health).toBe("degraded");
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
