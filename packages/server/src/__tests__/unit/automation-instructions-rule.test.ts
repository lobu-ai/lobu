import { describe, expect, test } from "bun:test";
import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import {
	assertAutomationInstructions,
	automationRequiresInstructions,
} from "../../automations/triggers";

const eventTurn: AutomationTrigger = {
	kind: "event",
	connector_key: "slack",
	event_types: ["message.created"],
	execution: "turn",
};

// An omitted execution defaults to "turn" per the contract schema.
const eventDefault = {
	kind: "event",
	connector_key: "slack",
	event_types: ["message.created"],
} as AutomationTrigger;

const eventWindow: AutomationTrigger = {
	kind: "event",
	connector_key: "github",
	event_types: ["pull_request.created"],
	execution: "window",
};

const workspaceEventDefault: AutomationTrigger = {
	kind: "event",
	source: "workspace",
	event_types: ["risk_detected"],
};

const schedule: AutomationTrigger = {
	kind: "schedule",
	cron: "0 9 * * *",
};

describe("automationRequiresInstructions", () => {
	test("event-turn triggers (explicit or defaulted) do not require instructions", () => {
		expect(automationRequiresInstructions([eventTurn])).toBe(false);
		expect(automationRequiresInstructions([eventDefault])).toBe(false);
		expect(automationRequiresInstructions([eventTurn, eventDefault])).toBe(false);
	});

	test("schedule, window-event, and empty (manual) trigger sets require instructions", () => {
		expect(automationRequiresInstructions([schedule])).toBe(true);
		expect(automationRequiresInstructions([eventWindow])).toBe(true);
		expect(automationRequiresInstructions([workspaceEventDefault])).toBe(true);
		expect(automationRequiresInstructions([])).toBe(true);
		// Mixed: one non-turn trigger is enough.
		expect(automationRequiresInstructions([eventTurn, schedule])).toBe(true);
	});
});

describe("assertAutomationInstructions", () => {
	test("allows an event-turn Automation with no instruction text", () => {
		expect(() => assertAutomationInstructions([eventTurn], undefined)).not.toThrow();
		expect(() => assertAutomationInstructions([eventTurn], "")).not.toThrow();
	});

	test("rejects empty instructions for schedule/window/manual shapes", () => {
		for (const triggers of [
			[schedule],
			[eventWindow],
			[workspaceEventDefault],
			[] as AutomationTrigger[],
		]) {
			expect(() => assertAutomationInstructions(triggers, undefined)).toThrow(
				/needs instructions/
			);
			expect(() => assertAutomationInstructions(triggers, "   ")).toThrow(
				/needs instructions/
			);
		}
	});

	test("accepts any trigger shape once instruction text is present", () => {
		expect(() =>
			assertAutomationInstructions([schedule], "Do the digest.")
		).not.toThrow();
		expect(() => assertAutomationInstructions([], "Manual runbook.")).not.toThrow();
	});

	test("accepts a reaction script as the sole instruction source", () => {
		const script =
			"export default async (ctx, client) => { await client.automations.completeWindow({}); };";
		for (const triggers of [
			[schedule],
			[eventWindow],
			[workspaceEventDefault],
			[] as AutomationTrigger[],
		]) {
			expect(() =>
				assertAutomationInstructions(triggers, undefined, null, script)
			).not.toThrow();
		}
	});

	test("rejects a whitespace-only reaction script", () => {
		expect(() =>
			assertAutomationInstructions([schedule], undefined, null, "   ")
		).toThrow(/needs instructions/);
	});

	test("accepts a script executor as the sole instruction source", () => {
		const script = "export default async () => ({ ok: true });";
		for (const triggers of [
			[schedule],
			[eventWindow],
			[workspaceEventDefault],
			[] as AutomationTrigger[],
		]) {
			expect(() =>
				assertAutomationInstructions(triggers, undefined, null, null, script)
			).not.toThrow();
		}
	});

	test("still rejects the empty schedule/window/manual shape with a reaction absent", () => {
		for (const triggers of [
			[schedule],
			[eventWindow],
			[workspaceEventDefault],
			[] as AutomationTrigger[],
		]) {
			expect(() =>
				assertAutomationInstructions(triggers, undefined, null, null)
			).toThrow(/needs instructions/);
		}
	});
});

describe("validateReactionDefaultExport", () => {
	// Lazy import to avoid module-level side effects in the test harness.
	const loadValidator = () =>
		import("../../automations/reaction-executor").then(
			(m) => m.validateReactionDefaultExport,
		);

	test.skip("accepts a script with a default export (requires isolated-vm)", async () => {
		const validate = await loadValidator();
		const { compileReactionScript } = await import(
			"../../automations/reaction-executor",
		);
		const source = 'export default async () => { return "ok"; }';
		const compiled = await compileReactionScript(source);
		await expect(validate(compiled)).resolves.toBeUndefined();
	});

	test.skip("rejects a script with only named exports (requires isolated-vm)", async () => {
		const validate = await loadValidator();
		const { compileReactionScript } = await import(
			"../../automations/reaction-executor",
		);
		const source = 'export const input = { type: "object" }';
		const compiled = await compileReactionScript(source);
		await expect(validate(compiled)).rejects.toThrow(
			/default async function/,
		);
	});
});
