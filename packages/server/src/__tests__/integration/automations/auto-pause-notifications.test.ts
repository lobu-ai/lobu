import { beforeEach, describe, expect, it } from "vitest";
import {
	automationAutoPauseNotificationKey,
	runAutomationAutoPauseNotificationSweep,
} from "../../../automations/auto-pause-notifications";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

async function createScheduledAutomation(name: string) {
	const workspace = await TestWorkspace.create({ name: `${name} workspace` });
	const entity = await createTestEntity({
		name: `${name} entity`,
		organization_id: workspace.org.id,
		created_by: workspace.users.owner.id,
	});
	const agent = await createTestAgent({
		organizationId: workspace.org.id,
		ownerUserId: workspace.users.owner.id,
		agentId: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-agent`,
		name: `${name} agent`,
	});
	const created = (await workspace.owner.automations.create({
		entity_id: entity.id,
		slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-automation`,
		name,
		prompt: "Run the scheduled task.",
		triggers: [{ kind: "schedule", cron: "0 * * * *" }],
		managed_agent_id: agent.agentId,
	})) as { automation_id: string };
	return {
		workspace,
		automationId: Number(created.automation_id),
	};
}

describe("Automation schedule auto-pause notifications", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("delivers once per pause generation to every admin/owner", async () => {
		const { workspace, automationId } =
			await createScheduledAutomation("Notification pause");
		const sql = getTestDb();
		const firstPause = new Date("2026-08-27T12:00:00.000Z");
		// The admin should see why the schedule paused without opening the run:
		// the latest failure's error is quoted, bounded, and an older one is not.
		const quotaError = `429 Weekly/Monthly Limit Exhausted. ${"Your plan quota is spent. ".repeat(20)}`;
		await sql`
			INSERT INTO runs (organization_id, run_type, automation_id, status, completed_at, error_message)
			VALUES
				(${workspace.org.id}, 'automation', ${automationId}, 'failed',
				 '2026-08-27T11:00:00.000Z'::timestamptz, 'executor timed out'),
				(${workspace.org.id}, 'automation', ${automationId}, 'failed',
				 '2026-08-27T11:59:59.000Z'::timestamptz, ${quotaError})
		`;
		await sql`
			UPDATE automations
			SET consecutive_scheduled_failures = 5,
				schedule_auto_paused_at = ${firstPause}::timestamptz
			WHERE id = ${automationId}
		`;

		expect(await runAutomationAutoPauseNotificationSweep()).toEqual({
			scanned: 1,
			attempted: 1,
			created: 1,
			errors: 0,
		});
		expect(await runAutomationAutoPauseNotificationSweep()).toEqual({
			scanned: 0,
			attempted: 0,
			created: 0,
			errors: 0,
		});

		const firstKey = automationAutoPauseNotificationKey(
			automationId,
			firstPause,
		);
		const firstEvents = await sql`
			SELECT
				e.id,
				e.title,
				e.payload_text,
				e.metadata,
				to_jsonb(array_agg(t.user_id ORDER BY t.user_id)) AS target_user_ids
			FROM events e
			JOIN notification_targets t ON t.event_id = e.id
			WHERE e.organization_id = ${workspace.org.id}
			  AND e.metadata->>'_lobu_idempotency_key' = ${firstKey}
			GROUP BY e.id, e.title, e.payload_text, e.metadata
		`;
		expect(firstEvents).toHaveLength(1);
		expect(firstEvents[0]?.title).toBe(
			'Automation "Notification pause" was auto-paused',
		);
		const body = String(firstEvents[0]?.payload_text);
		expect(body).toContain(
			`${Array.from(quotaError).slice(0, 300).join("").trimEnd()}…`,
		);
		expect(body).not.toContain(quotaError);
		expect(body).not.toContain("executor timed out");
		expect(
			[...(firstEvents[0]?.target_user_ids as string[])].sort(),
		).toEqual(
			[workspace.users.admin.id, workspace.users.owner.id].sort(),
		);
		expect(firstEvents[0]?.metadata).toMatchObject({
			notification_type: "generic",
			resource_type: "automation",
			resource_id: String(automationId),
		});

		const secondPause = new Date("2026-08-27T13:00:00.000Z");
		await sql`
			UPDATE automations
			SET schedule_auto_paused_at = NULL,
				consecutive_scheduled_failures = 0,
				next_run_at = current_timestamp + interval '1 hour'
			WHERE id = ${automationId}
		`;
		await sql`
			UPDATE automations
			SET consecutive_scheduled_failures = 5,
				schedule_auto_paused_at = ${secondPause}::timestamptz
			WHERE id = ${automationId}
		`;
		expect((await runAutomationAutoPauseNotificationSweep()).created).toBe(1);

		const notificationCount = await sql`
			SELECT id FROM events
			WHERE organization_id = ${workspace.org.id}
			  AND metadata->>'resource_type' = 'automation'
			  AND metadata->>'resource_id' = ${String(automationId)}
			  AND metadata ? '_lobu_idempotency_key'
		`;
		expect(notificationCount).toHaveLength(2);
	});

	it("does not let an organization without admins occupy the bounded window", async () => {
		const undeliverable = await createScheduledAutomation("No admin pause");
		const deliverable = await createScheduledAutomation("Deliverable pause");
		const sql = getTestDb();
		await sql`
			UPDATE "member" SET role = 'member'
			WHERE "organizationId" = ${undeliverable.workspace.org.id}
		`;
		await sql`
			UPDATE automations
			SET consecutive_scheduled_failures = 5,
				schedule_auto_paused_at = CASE id
					WHEN ${undeliverable.automationId} THEN '2026-08-27T11:00:00.000Z'::timestamptz
					ELSE '2026-08-27T12:00:00.000Z'::timestamptz
				END
			WHERE id IN (${undeliverable.automationId}, ${deliverable.automationId})
		`;

		const result = await runAutomationAutoPauseNotificationSweep({ limit: 1 });
		expect(result).toEqual({
			scanned: 1,
			attempted: 1,
			created: 1,
			errors: 0,
		});
		const [event] = await sql`
			SELECT organization_id, metadata->>'resource_id' AS resource_id
			FROM events
			WHERE metadata ? '_lobu_idempotency_key'
			  AND metadata->>'resource_type' = 'automation'
		`;
		expect(event.organization_id).toBe(deliverable.workspace.org.id);
		expect(event.resource_id).toBe(String(deliverable.automationId));
	});
});
