import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { getAutomation } from "../../../tools/get_automation";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createAutomationResultRun,
	createTestAgent,
	createTestEntity,
	createTestEvent,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("Automation window vocabulary", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("returns canonical automation_* keys", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const entity = await createTestEntity({
			name: "Window Vocab Co",
			organization_id: org.id,
		});
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageAutomations(
			{
				action: "create",
				entity_id: entity.id,
				slug: "window-vocab",
				name: "Window vocab",
				prompt: "Summarize.",
				managed_agent_id: agent.agentId,
				triggers: [{ kind: "schedule", cron: "0 0 * * *" }],
				sources: [
					{
						name: "src",
						query: "SELECT id FROM events WHERE connector_key = 'none'",
					},
				],
			},
			{} as Env,
			ctx,
		);

		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);
		expect(Number.isFinite(automationId)).toBe(true);

		const windowStart = "2026-07-21T00:00:00.000Z";
		await createAutomationResultRun({
			automationId: automationId,
			organizationId: org.id,
			granularity: "day",
			windowStart,
			windowEnd: "2026-07-22T00:00:00.000Z",
			entityIds: [entity.id],
			extractedData: { summary: "window" },
		});
		const turnRunId = await createAutomationResultRun({
			automationId,
			organizationId: org.id,
			windowStart: "2026-08-01T00:00:00.000Z",
			windowEnd: "2026-08-02T00:00:00.000Z",
		});
		const sql = getTestDb();
		await sql`
			UPDATE runs
			SET approved_input = approved_input - 'window_start' - 'window_end'
			WHERE id = ${turnRunId}
		`;
		// The fixture inserts completed history directly, bypassing the completion
		// handler, so plant the arrival mark the handler would have left behind.
		const expectedMark = new Date("2026-08-01T00:00:00.000Z");
		await sql`
			UPDATE automations
			SET next_window_start = ${expectedMark.toISOString()}::timestamptz
			WHERE id = ${automationId}
		`;
		await createTestEvent({
			entity_id: entity.id,
			content: "Pending after the completed window",
			occurred_at: new Date("2026-08-01T12:00:00.000Z"),
		});

		const detail = await getAutomation(
			{ automation_id: String(automationId) },
			{} as Env,
			ctx,
		);
		expect(detail.windows).toHaveLength(2);

		const window = detail.windows[0];
		expect(String(window.automation_id)).toBe(String(automationId));
		expect(window.automation_name).toBe("Window vocab");
		expect(detail.automation?.slug).toBe("window-vocab");
		// The pending window a claim would hand out starts at the mark and runs to
		// the arrival horizon — no period, no granularity.
		expect(detail.pending_analysis?.next_window?.start).toBe(expectedMark.toISOString());
		// Ends at the arrival horizon: behind the clock by the settle budget, give
		// or take the millisecond the database clock is rounded up by.
		expect(
			new Date(detail.pending_analysis?.next_window?.end as string).getTime(),
		).toBeLessThanOrEqual(Date.now() + 1);
		expect(
			new Date(detail.pending_analysis?.next_window?.end as string).getTime(),
		).toBeGreaterThan(expectedMark.getTime());
	});

});
