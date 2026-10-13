import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	activateAutomationSignal,
	planAutomationActivationsForRuntimeConnection,
} from "../../../automations/activation";
import type { Env } from "../../../index";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { getAutomation } from "../../../tools/get_automation";
import { dispatchPendingAutomationRuns } from "../../../automations/automation";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("Automation connector-event activation", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("round-trips triggers and queues each unique delivery without an LLM on duplicates", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			slug: "agentconn-runtime-test",
			created_by: user.id,
		});
		// A chat runtime id names a credentialed chat connection.
		await getTestDb()`UPDATE connections SET credential_mode = 'byo' WHERE id = ${connection.id}`;
		const trigger = {
			kind: "event" as const,
			source: "connector" as const,
			connector_key: "github",
			connection_id: connection.id,
			event_types: ["pull_request.created"],
			match: { repository: "lobu-ai/lobu" },
			execution: "turn" as const,
			active_run: "queue" as const,
			output: "silent" as const,
			skip_if_unchanged: true,
		};
		const created = await manageAutomations(
			{
				action: "create",
				slug: "github-pr-created",
				name: "GitHub PR created",
				prompt: "Review the incoming pull request.",
				managed_agent_id: agent.agentId,
				triggers: [trigger],
			},
			{} as Env,
			ctx
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);

		const signal = {
			connector_key: "github",
			connection_id: connection.id,
			resource_type: "pull_request",
			resource_ref: "github:pull_request:lobu-ai/lobu#208",
			event_type: "pull_request.created",
			delivery_id: "event:91",
			label: "PR 208",
			input_text: "Review PR 208",
			attributes: { repository: "lobu-ai/lobu", pull_number: 208 },
		};
		const runtimePlan = await planAutomationActivationsForRuntimeConnection({
			connectionOrganizationId: org.id,
			runtimeConnectionId: "runtime-test",
			signal: { ...signal, connection_id: undefined },
		});
		expect(runtimePlan.signal.connection_id).toBe(connection.id);
		expect(runtimePlan.backgroundTargets).toHaveLength(1);
		expect(runtimePlan.replyTargets).toHaveLength(0);
		const first = await activateAutomationSignal({
			organizationId: org.id,
			signal,
		});
		const duplicate = await activateAutomationSignal({
			organizationId: org.id,
			signal,
		});
		const second = await activateAutomationSignal({
			organizationId: org.id,
			signal: { ...signal, delivery_id: "event:92" },
		});

		expect(first).toMatchObject([
			{ automationId, created: true, disposition: "queued" },
		]);
		expect(duplicate).toMatchObject([
			{ automationId, created: false, disposition: "duplicate" },
		]);
		expect(second).toMatchObject([
			{ automationId, created: true, disposition: "queued" },
		]);

		const sql = getTestDb();
		const [stored] = await sql`
			SELECT triggers FROM automations WHERE id = ${automationId}
		`;
		expect(stored?.triggers).toEqual([trigger]);
		const detail = await getAutomation(
			{ automation_id: String(automationId) },
			{} as Env,
			ctx
		);
		expect(detail.automation?.triggers).toEqual([trigger]);
		const runs = await sql`
			SELECT approved_input
			FROM runs
			WHERE automation_id = ${automationId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(2);
		expect(runs[0]?.approved_input).toMatchObject({
			dispatch_source: "event",
			trigger_execution: "turn",
			delivery_ids: ["event:91"],
		});
	});

	it("coalesces waiting deliveries into one durable pending run", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const created = await manageAutomations(
			{
				action: "create",
				slug: "github-pr-window",
				name: "GitHub PR window",
				prompt: "Summarize changed pull requests.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						connector_key: "github",
						connection_id: connection.id,
						event_types: ["pull_request.updated"],
						execution: "window",
						active_run: "coalesce",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);
		const baseSignal = {
			connector_key: "github",
			connection_id: connection.id,
			event_type: "pull_request.updated",
			occurred_at: "2026-07-18T23:30:00.000Z",
			label: "PR changed",
			input_text: "A pull request changed",
		};
		await activateAutomationSignal({
			organizationId: org.id,
			signal: { ...baseSignal, delivery_id: "event:101" },
		});
		const coalesced = await activateAutomationSignal({
			organizationId: org.id,
			signal: {
				...baseSignal,
				delivery_id: "event:102",
				occurred_at: "2026-07-20T01:15:00.000Z",
			},
		});

		expect(coalesced).toMatchObject([
			{ automationId, created: false, disposition: "coalesced" },
		]);
		const sql = getTestDb();
		const runs = await sql`
			SELECT approved_input FROM runs WHERE automation_id = ${automationId}
		`;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.approved_input).toMatchObject({
			delivery_ids: ["event:101", "event:102"],
			trigger_execution: "window",
			window_start: "2026-07-18T23:30:00.000Z",
			window_end: "2026-07-20T01:15:00.001Z",
		});
	});

	it("does not coalesce deliveries from incompatible triggers", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const created = await manageAutomations(
			{
				action: "create",
				slug: "github-mixed-delivery-policy",
				name: "GitHub mixed delivery policy",
				prompt: "Handle changed pull requests.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						connector_key: "github",
						connection_id: connection.id,
						event_types: ["pull_request.created"],
						execution: "turn",
						active_run: "queue",
						output: "silent",
					},
					{
						kind: "event",
						connector_key: "github",
						connection_id: connection.id,
						event_types: ["pull_request.updated"],
						execution: "window",
						active_run: "coalesce",
						output: "silent",
					},
				],
			},
			{} as Env,
			ctx
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);
		const signal = {
			connector_key: "github",
			connection_id: connection.id,
			label: "PR changed",
			input_text: "A pull request changed.",
		};
		const [queued] = await activateAutomationSignal({
			organizationId: org.id,
			signal: {
				...signal,
				event_type: "pull_request.created",
				delivery_id: "event:mixed:created",
			},
		});
		const [windowed] = await activateAutomationSignal({
			organizationId: org.id,
			signal: {
				...signal,
				event_type: "pull_request.updated",
				delivery_id: "event:mixed:updated",
			},
		});

		expect(queued).toMatchObject({
			automationId,
			created: true,
			disposition: "queued",
		});
		expect(windowed).toMatchObject({
			automationId,
			created: true,
			disposition: "queued",
		});
		const runs = await getTestDb()`
			SELECT approved_input
			FROM runs
			WHERE automation_id = ${automationId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(2);
		expect(runs.map((run) => run.approved_input)).toMatchObject([
			{
				delivery_ids: ["event:mixed:created"],
				trigger_execution: "turn",
			},
			{
				delivery_ids: ["event:mixed:updated"],
				trigger_execution: "window",
			},
		]);
	});

	it("does not advance the schedule when an event delivery fails", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const created = await manageAutomations(
			{
				action: "create",
				slug: "event-failure-with-schedule",
				name: "Event failure with schedule",
				prompt: "Handle the delivery.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						connector_key: "github",
						connection_id: connection.id,
						event_types: ["pull_request.created"],
						execution: "turn",
					},
					{
						kind: "schedule",
						cron: "0 9 * * *",
						execution: "window",
					},
				],
			},
			{} as Env,
			ctx
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);
		const sql = getTestDb();
		await sql`
			UPDATE automations
			SET next_run_at = NOW() - INTERVAL '1 hour'
			WHERE id = ${automationId}
		`;
		const [activation] = await activateAutomationSignal({
			organizationId: org.id,
			signal: {
				connector_key: "github",
				connection_id: connection.id,
				event_type: "pull_request.created",
				delivery_id: "event:failed-dispatch",
				label: "PR created",
				input_text: "A pull request was created.",
			},
		});
		await sql`
			UPDATE runs
			SET approved_input = jsonb_set(
				approved_input,
				'{agent_id}',
				'"missing-agent"'::jsonb
			)
			WHERE id = ${activation.runId}
		`;

		await dispatchPendingAutomationRuns({ runIds: [activation.runId] });

		const [stored] = await sql`
			SELECT r.status, w.next_run_at
			FROM runs r
			JOIN automations w ON w.id = r.automation_id
			WHERE r.id = ${activation.runId}
		`;
		expect(stored.status).toBe("failed");
		expect(new Date(stored.next_run_at as string).getTime()).toBeLessThan(
			Date.now()
		);
	});

	it("applies unchanged-delivery policy per matching trigger", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const create = async (slug: string, skipIfUnchanged: boolean) => {
			const result = await manageAutomations(
				{
					action: "create",
					slug,
					name: slug,
					prompt: "Handle the connector delivery.",
					managed_agent_id: agent.agentId,
					triggers: [
						{
							kind: "event",
							connector_key: "github",
							connection_id: connection.id,
							event_types: ["pull_request.updated"],
							execution: "window",
							active_run: "queue",
							skip_if_unchanged: skipIfUnchanged,
						},
					],
				},
				{} as Env,
				ctx,
			);
			if (result.action !== "create" || !("automation_id" in result)) {
				throw new Error("Automation creation did not complete");
			}
			return Number(result.automation_id);
		};
		await create("skip-unchanged-deliveries", true);
		const alwaysRunId = await create("run-unchanged-deliveries", false);

		const activated = await activateAutomationSignal({
			organizationId: org.id,
			signal: {
				connector_key: "github",
				connection_id: connection.id,
				event_type: "pull_request.updated",
				delivery_id: "sync:77:event:42:0",
				label: "Unchanged PR",
				input_text: "The connector delivered an unchanged pull request.",
				unchanged: true,
			},
		});

		expect(activated).toMatchObject([
			{ automationId: alwaysRunId, created: true, disposition: "queued" },
		]);
		const runs = await getTestDb()`
			SELECT automation_id FROM runs WHERE run_type = 'automation'
		`;
		expect(runs.map((run) => Number(run.automation_id))).toEqual([alwaysRunId]);
	});

	it("rejects events and delivery modes the connector does not support", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const create = (slug: string, trigger: Record<string, unknown>) =>
			manageAutomations(
				{
					action: "create",
					slug,
					name: slug,
					prompt: "Handle the incoming event.",
					managed_agent_id: agent.agentId,
					triggers: [
						{
							kind: "event",
							connector_key: "github",
							connection_id: connection.id,
							event_types: ["pull_request.created"],
							...trigger,
						},
					],
				},
				{} as Env,
				ctx
			);

		await expect(
			create("unsupported-event", { event_types: ["pull_request.deleted"] })
		).rejects.toThrow(
			"GitHub does not support Automation event 'pull_request.deleted'"
		);
		await expect(
			create("unsupported-steering", {
				active_run: "steer",
				output: "reply_to_source",
			})
		).rejects.toThrow(
			"GitHub event 'pull_request.created' does not support steering"
		);
		await expect(
			create("unsupported-source-reply", { output: "reply_to_source" })
		).rejects.toThrow(
			"GitHub event 'pull_request.created' does not support replying to the source"
		);
	});
});
