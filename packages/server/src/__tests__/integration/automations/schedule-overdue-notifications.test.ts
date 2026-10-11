import { beforeEach, describe, expect, it } from "vitest";
import {
	automationScheduleOverdueNotificationKey,
	runAutomationScheduleOverdueNotificationSweep,
} from "../../../automations/schedule-overdue-notifications";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function createScheduledAutomation(name: string, cron: string) {
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
		triggers: [{ kind: "schedule", cron }],
		managed_agent_id: agent.agentId,
	})) as { automation_id: string };
	return { workspace, automationId: Number(created.automation_id) };
}

async function setDue(automationId: number, nextRunAt: Date, external = false) {
	const sql = getTestDb();
	await sql`
		UPDATE automations
		SET next_run_at = ${nextRunAt}::timestamptz,
			timezone = 'UTC',
			execution_config = CASE
				WHEN ${external} THEN '{"executor":{"kind":"external"}}'::jsonb
				ELSE execution_config
			END
		WHERE id = ${automationId}
	`;
}

async function overdueNotifications(orgId: string, automationId: number) {
	const sql = getTestDb();
	return (await sql`
		SELECT e.id, e.title, e.payload_text,
			to_jsonb(array_agg(t.user_id ORDER BY t.user_id)) AS target_user_ids
		FROM events e
		JOIN notification_targets t ON t.event_id = e.id
		WHERE e.organization_id = ${orgId}
		  AND e.metadata->>'_lobu_idempotency_key' LIKE 'automation:schedule-overdue:%'
		  AND e.metadata->>'resource_id' = ${String(automationId)}
		GROUP BY e.id, e.title, e.payload_text
		ORDER BY e.id
	`) as unknown as Array<{
		id: number;
		title: string;
		payload_text: string | null;
		target_user_ids: string[];
	}>;
}

describe("Automation schedule overdue notifications", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	// The production digest shape: an external-executor schedule that no client
	// claimed. Nothing fails, nothing pauses — only the cursor sits in the past.
	it("tells the admins once per missed due time when nothing runs", async () => {
		const { workspace, automationId } = await createScheduledAutomation(
			"Unclaimed digest",
			"*/20 * * * *",
		);
		const due = new Date(Date.now() - 3 * HOUR);
		await setDue(automationId, due, true);

		const first = await runAutomationScheduleOverdueNotificationSweep();
		expect(first).toMatchObject({ notified: 1, errors: 0 });
		expect(await runAutomationScheduleOverdueNotificationSweep()).toMatchObject({
			notified: 0,
			errors: 0,
		});

		const sent = await overdueNotifications(workspace.org.id, automationId);
		expect(sent).toHaveLength(1);
		expect(sent[0].title).toBe('Automation "Unclaimed digest" has not run');
		expect(sent[0].payload_text).toContain("external client");
		expect(sent[0].target_user_ids).toContain(workspace.users.owner.id);

		// A client claimed once, then went quiet again: a new episode.
		await setDue(automationId, new Date(Date.now() - 2 * HOUR), true);
		expect(await runAutomationScheduleOverdueNotificationSweep()).toMatchObject({
			notified: 1,
		});
		expect(await overdueNotifications(workspace.org.id, automationId)).toHaveLength(2);
		expect(automationScheduleOverdueNotificationKey(automationId, due)).toBe(
			`automation:schedule-overdue:${automationId}:${due.getTime()}`,
		);
	});

	it("waits one missed interval, at least an hour, before reporting", async () => {
		const { workspace, automationId } = await createScheduledAutomation(
			"Briefly late",
			"*/20 * * * *",
		);
		await setDue(automationId, new Date(Date.now() - 40 * MINUTE), true);

		expect(await runAutomationScheduleOverdueNotificationSweep()).toMatchObject({
			notified: 0,
		});
		expect(await overdueNotifications(workspace.org.id, automationId)).toHaveLength(0);
	});

	it("gives a daily schedule hours, not a whole day, of grace", async () => {
		const { workspace, automationId } = await createScheduledAutomation(
			"Daily report",
			"0 9 * * *",
		);
		const due = new Date("2026-10-11T09:00:00Z");
		await setDue(automationId, due);
		expect(await runAutomationScheduleOverdueNotificationSweep({
			now: due.getTime() + 3 * HOUR,
		})).toMatchObject({
			notified: 0,
		});

		expect(await runAutomationScheduleOverdueNotificationSweep({
			now: due.getTime() + 7 * HOUR,
		})).toMatchObject({
			notified: 1,
		});
		const sent = await overdueNotifications(workspace.org.id, automationId);
		expect(sent).toHaveLength(1);
		expect(sent[0].payload_text).not.toContain("external client");
	});

	it.each(["running", "grace", "invalid"])(
		"does not let an earlier %s schedule consume the delivery limit",
		async (reason) => {
			const now = Date.parse("2026-10-11T12:00:00Z");
			const earlier = await createScheduledAutomation("Earlier schedule", "0 9 * * *");
			const later = await createScheduledAutomation("Overdue schedule", "0 * * * *");
			const another = await createScheduledAutomation("Another overdue schedule", "0 * * * *");
			await setDue(earlier.automationId, new Date(now - 3 * HOUR));
			await setDue(later.automationId, new Date(now - 2 * HOUR));
			await setDue(another.automationId, new Date(now - 90 * MINUTE));
			const sql = getTestDb();
			if (reason === "running") {
				await sql`
					UPDATE automations SET schedule = '0 * * * *' WHERE id = ${earlier.automationId}
				`;
				await sql`
					INSERT INTO runs (organization_id, run_type, automation_id, status, approval_status)
					VALUES (${earlier.workspace.org.id}, 'automation', ${earlier.automationId}, 'running', 'auto')
				`;
			} else if (reason === "invalid") {
				await sql`UPDATE automations SET schedule = 'invalid' WHERE id = ${earlier.automationId}`;
			}

			expect(await runAutomationScheduleOverdueNotificationSweep({ now, limit: 1 }))
				.toMatchObject({ notified: 1, errors: 0 });
			expect(await overdueNotifications(earlier.workspace.org.id, earlier.automationId)).toHaveLength(0);
			expect(await overdueNotifications(later.workspace.org.id, later.automationId)).toHaveLength(1);
			expect(await overdueNotifications(another.workspace.org.id, another.automationId)).toHaveLength(0);
		},
	);

	// A managed run that is still working legitimately holds the cursor back:
	// the schedule advances when its window completes.
	it("does not report a schedule whose run is still in flight", async () => {
		const { workspace, automationId } = await createScheduledAutomation(
			"Long run",
			"*/20 * * * *",
		);
		await setDue(automationId, new Date(Date.now() - 90 * MINUTE));
		const sql = getTestDb();
		await sql`
			INSERT INTO runs
				(organization_id, run_type, automation_id, status, approval_status, created_at)
			VALUES
				(${workspace.org.id}, 'automation', ${automationId}, 'running', 'auto',
				 current_timestamp - interval '80 minutes')
		`;

		expect(await runAutomationScheduleOverdueNotificationSweep()).toMatchObject({
			notified: 0,
		});
		expect(await overdueNotifications(workspace.org.id, automationId)).toHaveLength(0);
	});

	// The auto-pause sweep already tells the admins about this one.
	it("leaves an auto-paused schedule to the auto-pause notice", async () => {
		const { workspace, automationId } = await createScheduledAutomation(
			"Paused schedule",
			"*/20 * * * *",
		);
		await setDue(automationId, new Date(Date.now() - 3 * HOUR));
		const sql = getTestDb();
		await sql`
			UPDATE automations
			SET consecutive_scheduled_failures = 5,
				schedule_auto_paused_at = current_timestamp
			WHERE id = ${automationId}
		`;

		expect(await runAutomationScheduleOverdueNotificationSweep()).toMatchObject({
			notified: 0,
		});
		expect(await overdueNotifications(workspace.org.id, automationId)).toHaveLength(0);
	});
});
