import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { materializeDueAutomationRuns } from "../../../automations/automation";
import * as runScriptModule from "../../../sandbox/run-script";
import { automationArrivalHorizon } from "../../../utils/window-utils";
import { ToolUserError } from "../../../utils/errors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestConnection, createTestEvent, seedOwnerContext } from "../../setup/test-fixtures";

describe("scheduled Automation unchanged gate", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	async function seedInvalidScript(skipIfUnchanged: boolean, invalid = "deleted feed") {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
		const connection = await createTestConnection({ organization_id: org.id, connector_key: "synthetic.scheduler" });
		const sql = getTestDb();
		const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${connection.id}`;
		const created = await manageAutomations({
			action: "create", slug: "deleted-feed-script", name: "Deleted feed script",
			managed_agent_id: agent.agentId,
			reaction_script: "export default async () => ({ checked: true });",
			sources: [{ name: "content", query: `@feed:${feed.id}` }],
			triggers: [{ kind: "schedule", cron: "* * * * *", execution: "window", skip_if_unchanged: skipIfUnchanged }],
		}, {} as Env, ctx) as { automation_id: string };
		if (invalid === "deleted feed") {
			await sql`UPDATE feeds SET deleted_at = now() WHERE id = ${feed.id}`;
		} else if (invalid === "invalid exports") {
			await sql`UPDATE automations SET reaction_script_compiled = 'module.exports = { default: 42 };'
				WHERE id = ${created.automation_id}`;
		} else if (invalid === "code-only configuration") {
			await sql`UPDATE automations SET execution_config = '{"model":"synthetic-model"}'::jsonb
				WHERE id = ${created.automation_id}`;
		} else {
			await sql`UPDATE automations SET reaction_script_compiled = 'module.exports = { prepare: async () => ({}) };',
				triggers = triggers || '[{"kind":"event","source":"workspace","event_kind":"synthetic.invalid","execution":"turn"}]'::jsonb
				WHERE id = ${created.automation_id}`;
		}
		await sql`UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${created.automation_id}`;
		const [initial] = await sql`SELECT next_run_at, next_window_start FROM automations WHERE id = ${created.automation_id}`;
		return { sql, ctx, automationId: created.automation_id, feedId: feed.id, initial };
	}

	it.each([true, false].flatMap(skipIfUnchanged =>
		["deleted feed", "invalid exports", "code-only configuration", "preparation configuration"].map(invalid => ({ skipIfUnchanged, invalid }))
	))("durably fails $invalid admission with skip_if_unchanged=$skipIfUnchanged", async ({ skipIfUnchanged, invalid }) => {
		const { sql, automationId, initial } = await seedInvalidScript(skipIfUnchanged, invalid);
		await sql.unsafe(`CREATE FUNCTION synthetic_reject_admission_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic failure-accounting outage'; END $$`);
		await sql.unsafe(`CREATE TRIGGER synthetic_reject_admission_failure BEFORE UPDATE OF consecutive_scheduled_failures
      ON automations FOR EACH ROW EXECUTE FUNCTION synthetic_reject_admission_failure()`);
		try {
			await materializeDueAutomationRuns({} as Env, sql);
			expect(await sql`SELECT id FROM runs WHERE automation_id = ${automationId}`).toHaveLength(0);
			const [state] = await sql`SELECT next_run_at, next_window_start, consecutive_scheduled_failures
				FROM automations WHERE id = ${automationId}`;
			expect(state).toMatchObject({ ...initial, consecutive_scheduled_failures: 0 });
		} finally {
			await sql.unsafe('DROP TRIGGER synthetic_reject_admission_failure ON automations');
			await sql.unsafe('DROP FUNCTION synthetic_reject_admission_failure()');
		}

		for (let attempt = 1; attempt <= 5; attempt++) {
			await sql`UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${automationId}`;
			await Promise.all([
				materializeDueAutomationRuns({} as Env, sql),
				materializeDueAutomationRuns({} as Env, sql),
			]);
			const runs = await sql`SELECT status, outcome, error_message, completed_at, approved_input FROM runs
				WHERE automation_id = ${automationId} AND run_type = 'automation' ORDER BY id`;
			expect(runs).toHaveLength(attempt);
			expect(runs.at(-1)).toMatchObject({ status: "failed", outcome: "infra_error",
				approved_input: { dispatch_source: "scheduled" } });
			const expectedError = {
				"deleted feed": "did not match any feed", "invalid exports": "Automation script must export",
				"code-only configuration": "A code-only module uses sandbox limits",
				"preparation configuration": "Preparation requires an owning native agent",
			}[invalid];
			expect(runs.at(-1).error_message).toContain(expectedError);
			if (invalid === "deleted feed") expect(runs.at(-1).approved_input.executor).toMatchObject({ kind: "script" });
			expect(runs.at(-1).completed_at).not.toBeNull();
			expect(await sql`SELECT id FROM runs WHERE automation_id = ${automationId} AND run_type = 'task'`).toHaveLength(0);
			const [state] = await sql`SELECT next_window_start, next_run_at, consecutive_scheduled_failures,
				schedule_auto_paused_at FROM automations WHERE id = ${automationId}`;
			expect(state.next_window_start).toEqual(initial.next_window_start);
			expect(state.consecutive_scheduled_failures).toBe(attempt);
			if (attempt === 5) {
				expect(state.next_run_at).toBeNull();
				expect(state.schedule_auto_paused_at).not.toBeNull();
			} else {
				expect(new Date(state.next_run_at).getTime()).toBeGreaterThan(Date.now());
				expect(await materializeDueAutomationRuns({} as Env, sql)).toMatchObject({ dueAutomations: 0 });
			}
		}
	});

	it("retries an uncommitted database failure during script source normalization", async () => {
		const { sql, automationId, initial } = await seedInvalidScript(true);
		const unavailable = (client: DbClient): DbClient => new Proxy(client, {
			apply(target, self, args) {
				const text = Array.isArray(args[0]) ? args[0].join('') : '';
				if (text.includes('FROM feeds f')) return target`SELECT 1 / 0`;
				return Reflect.apply(target, self, args);
			},
			get(target, key) {
				if (key === 'begin' || key === 'savepoint') return (...args: unknown[]) => {
					const callback = args.pop() as (tx: DbClient) => Promise<unknown>;
					return (target[key] as (...a: unknown[]) => Promise<unknown>)(...args, (tx: DbClient) => callback(unavailable(tx)));
				};
				return Reflect.get(target, key);
			},
		});
		await materializeDueAutomationRuns({} as Env, unavailable(sql));
		expect(await sql`SELECT id FROM runs WHERE automation_id = ${automationId}`).toHaveLength(0);
		const [state] = await sql`SELECT next_run_at, next_window_start, consecutive_scheduled_failures
			FROM automations WHERE id = ${automationId}`;
		expect(state).toMatchObject({ ...initial, consecutive_scheduled_failures: 0 });
		await materializeDueAutomationRuns({} as Env, sql);
		expect(await sql`SELECT status FROM runs WHERE automation_id = ${automationId}`).toEqual([{ status: "failed" }]);
	});

	it.each([
		{ name: "RuntimeUnavailable", message: "Synthetic isolate runtime outage" },
		{ name: "CompileError", code: "INTERNAL" as const, message: "Synthetic compiler host outage" },
	])("retries a $name sandbox host failure while inspecting the stored script", async (failure) => {
		const { sql, ctx, automationId, initial } = await seedInvalidScript(true);
		const outage = vi.spyOn(runScriptModule, "runScript").mockResolvedValue({
			success: false, logs: [], durationMs: 0, sdkCalls: 0, skippedCalls: 0, traceDropped: 0, sdkCallTrace: [],
			startedSideEffects: [], requiredMcpScopes: [], sideEffectPreview: [], error: failure,
		});
		let manualError: unknown;
		try {
			await materializeDueAutomationRuns({} as Env, sql);
			manualError = await manageAutomations({ action: "trigger", automation_id: automationId }, {} as Env, ctx)
				.then(() => undefined, (error: unknown) => error);
		} finally {
			outage.mockRestore();
		}
		expect(await sql`SELECT id FROM runs WHERE automation_id = ${automationId}`).toHaveLength(0);
		const [state] = await sql`SELECT next_run_at, next_window_start, consecutive_scheduled_failures
			FROM automations WHERE id = ${automationId}`;
		expect(state).toMatchObject({ ...initial, consecutive_scheduled_failures: 0 });
		// A host outage is not a refusal of the stored script on either path.
		expect(manualError).toBeInstanceOf(Error);
		expect(manualError).not.toBeInstanceOf(ToolUserError);
		await materializeDueAutomationRuns({} as Env, sql);
		expect(await sql`SELECT status FROM runs WHERE automation_id = ${automationId}`).toEqual([{ status: "failed" }]);
		const [recovered] = await sql`SELECT consecutive_scheduled_failures FROM automations WHERE id = ${automationId}`;
		expect(recovered.consecutive_scheduled_failures).toBe(1);
	});

	it("refuses a manual trigger of an invalid stored script without persisting an attempt", async () => {
		const { sql, ctx, automationId } = await seedInvalidScript(true, "invalid exports");
		await expect(manageAutomations({ action: "trigger", automation_id: automationId }, {} as Env, ctx))
			.rejects.toMatchObject({ httpStatus: 422 });
		expect(await sql`SELECT id FROM runs WHERE automation_id = ${automationId}`).toHaveLength(0);
	});

	it.each([
		{ name: "RuntimeUnavailable", message: "Synthetic isolate runtime outage" },
		{ name: "CompileError", code: "INTERNAL" as const, message: "Synthetic compiler host outage" },
	])("retries a transient $name inspection outage without charging a healthy script", async (failure) => {
		const { sql, automationId, feedId, initial } = await seedInvalidScript(true);
		await sql`UPDATE feeds SET deleted_at = NULL WHERE id = ${feedId}`;
		const outage = vi.spyOn(runScriptModule, "runScript").mockResolvedValueOnce({
			success: false, logs: [], durationMs: 0, sdkCalls: 0, skippedCalls: 0, traceDropped: 0, sdkCallTrace: [],
			startedSideEffects: [], requiredMcpScopes: [], sideEffectPreview: [], error: failure,
		});
		try {
			await materializeDueAutomationRuns({} as Env, sql);
		} finally {
			outage.mockRestore();
		}
		expect(await sql`SELECT id FROM runs WHERE automation_id = ${automationId}`).toHaveLength(0);
		const [state] = await sql`SELECT next_run_at, next_window_start, consecutive_scheduled_failures
			FROM automations WHERE id = ${automationId}`;
		expect(state).toMatchObject({ ...initial, consecutive_scheduled_failures: 0 });
		await materializeDueAutomationRuns({} as Env, sql);
		expect(await sql`SELECT status FROM runs WHERE automation_id = ${automationId}`).toEqual([{ status: "pending" }]);
		const [recovered] = await sql`SELECT consecutive_scheduled_failures FROM automations WHERE id = ${automationId}`;
		expect(recovered.consecutive_scheduled_failures).toBe(0);
	});

	it("records source-read failures without advancing arrivals and applies the scheduled failure budget", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
		const created = await manageAutomations({
			action: "create", slug: "source-cast-failure", name: "Source cast failure",
			prompt: "Summarize counted arrivals.", managed_agent_id: agent.agentId,
			sources: [{ name: "counted", query: "SELECT id FROM events WHERE (metadata->>'count')::integer > 0" }],
			triggers: [{ kind: "schedule", cron: "* * * * *", execution: "window", skip_if_unchanged: true }],
		}, {} as Env, ctx) as { automation_id: string };
		const sql = getTestDb();
		await createTestEvent({ organization_id: org.id, content: "An invalid numeric arrival", metadata: { count: "invalid" } });
		const [initial] = await sql`SELECT next_window_start FROM automations WHERE id = ${created.automation_id}`;

		for (let attempt = 1; attempt <= 5; attempt++) {
			await sql`UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${created.automation_id}`;
			// Overlapping scheduler passes must persist and count only one failure
			// for the observed due cursor, even while both read the broken source.
			await Promise.all([materializeDueAutomationRuns(), materializeDueAutomationRuns()]);
			const runs = await sql`SELECT status, outcome, error_message, completed_at, approved_input FROM runs
				WHERE automation_id = ${created.automation_id} AND run_type = 'automation' ORDER BY id`;
			expect(runs).toHaveLength(attempt);
			expect(runs.at(-1)).toMatchObject({ status: "failed", outcome: "infra_error", approved_input: { dispatch_source: "scheduled" } });
			expect(runs.at(-1).error_message).toContain("SQLSTATE 22P02");
			expect(runs.at(-1).completed_at).not.toBeNull();
			const [state] = await sql`SELECT next_window_start, next_run_at, consecutive_scheduled_failures,
				schedule_auto_paused_at FROM automations WHERE id = ${created.automation_id}`;
			expect(state.next_window_start).toEqual(initial.next_window_start);
			expect(state.consecutive_scheduled_failures).toBe(attempt);
			if (attempt === 5) {
				expect(state.next_run_at).toBeNull();
				expect(state.schedule_auto_paused_at).not.toBeNull();
			} else {
				expect(new Date(state.next_run_at).getTime()).toBeGreaterThan(Date.now());
			}
		}
		expect(await materializeDueAutomationRuns()).toMatchObject({ dueAutomations: 0 });
	});

	it("rolls back source-failure admission when failure accounting cannot commit, then retries", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
		const created = await manageAutomations({
			action: "create", slug: "source-failure-rollback", name: "Source failure rollback",
			prompt: "Summarize counted arrivals.", managed_agent_id: agent.agentId,
			sources: [{ name: "counted", query: "SELECT id FROM events WHERE (metadata->>'count')::integer > 0" }],
			triggers: [{ kind: "schedule", cron: "* * * * *", execution: "window", skip_if_unchanged: true }],
		}, {} as Env, ctx) as { automation_id: string };
		const sql = getTestDb();
		await createTestEvent({ organization_id: org.id, content: "Invalid count", metadata: { count: "invalid" } });
		await sql`UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${created.automation_id}`;
		const [initial] = await sql`SELECT next_run_at, next_window_start FROM automations WHERE id = ${created.automation_id}`;
		await sql.unsafe(`CREATE FUNCTION synthetic_reject_source_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic failure-accounting outage'; END $$`);
		await sql.unsafe(`CREATE TRIGGER synthetic_reject_source_failure BEFORE UPDATE OF consecutive_scheduled_failures
      ON automations FOR EACH ROW EXECUTE FUNCTION synthetic_reject_source_failure()`);
		try {
			await materializeDueAutomationRuns();
			expect(await sql`SELECT id FROM runs WHERE automation_id = ${created.automation_id}`).toHaveLength(0);
			const [state] = await sql`SELECT next_run_at, next_window_start, consecutive_scheduled_failures
				FROM automations WHERE id = ${created.automation_id}`;
			expect(state).toMatchObject({ ...initial, consecutive_scheduled_failures: 0 });
		} finally {
			await sql.unsafe('DROP TRIGGER synthetic_reject_source_failure ON automations');
			await sql.unsafe('DROP FUNCTION synthetic_reject_source_failure()');
		}
		await materializeDueAutomationRuns();
		const [run] = await sql`SELECT status FROM runs WHERE automation_id = ${created.automation_id}`;
		expect(run.status).toBe("failed");
		const [state] = await sql`SELECT consecutive_scheduled_failures, next_run_at > now() AS advanced
			FROM automations WHERE id = ${created.automation_id}`;
		expect(state).toMatchObject({ consecutive_scheduled_failures: 1, advanced: true });
	});

	it("prepares scheduled runs even when configured sources are empty", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
		const created = await manageAutomations({
			action: "create",
			slug: "scheduled-preparation",
			name: "Scheduled preparation",
			prompt: "Read the saved calculated source.",
			managed_agent_id: agent.agentId,
			reaction_script: "export async function prepare() { return { calculated: [{ total: 42 }] }; }",
			triggers: [{ kind: "schedule", cron: "* * * * *", execution: "window", active_run: "coalesce", skip_if_unchanged: true }],
		}, {} as Env, ctx) as { automation_id: string };
		const sql = getTestDb();
		await sql`UPDATE automations SET next_run_at = now() - interval '1 hour' WHERE id = ${created.automation_id}`;
		// A queue consumer on another connection can claim a committed task as
		// soon as it is inserted, before the scheduler writes its parent marker.
		const visibleTasks: unknown[] = [];
		let taskInserts = 0;
		const observe = (client: DbClient): DbClient => new Proxy(client, {
			apply(target, self, args) {
				const query = Reflect.apply(target, self, args);
				const text = Array.isArray(args[0]) ? args[0].join('') : '';
				if (text.includes('INSERT INTO public.runs')) {
					return query.then(async (rows: unknown) => {
						taskInserts++;
						visibleTasks.push(...await sql`
							SELECT t.id FROM runs t
							WHERE t.automation_id = ${created.automation_id}
							  AND t.action_key = 'automation-preparation'
							  AND t.status = 'pending'
							`);
						return rows;
					});
				}
				return query;
			},
			get(target, key) {
				// Forward both begin forms: `begin(fn)` and `begin('read only', fn)`.
				if (key === 'begin' || key === 'savepoint') return (...args: unknown[]) => {
					const callback = args.pop() as (tx: DbClient) => Promise<unknown>;
					return (target[key] as (...a: unknown[]) => Promise<unknown>)(...args, (tx: DbClient) => callback(observe(tx)));
				};
				return Reflect.get(target, key);
			},
		});
		expect(await materializeDueAutomationRuns({} as Env, observe(sql))).toMatchObject({ runsCreated: 1, skipped: 0 });
		expect(taskInserts).toBe(1);
		expect(visibleTasks).toEqual([]);
		const runs = await sql`SELECT id, status FROM runs WHERE automation_id = ${created.automation_id} AND run_type = 'automation'`;
		expect(runs).toHaveLength(1);
		expect(runs[0].status).toBe("pending");
		const tasks = await sql`
			SELECT t.id FROM runs t JOIN runs r ON r.id = t.parent_run_id
			WHERE r.id = ${runs[0].id} AND t.action_key = 'automation-preparation'
			  AND r.run_metadata->>'preparation_task_run_id' = t.id::text
		`;
		expect(tasks).toHaveLength(1);
	});

	it("persists an empty-window cursor so the next period can dispatch new data", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageAutomations(
			{
				action: "create",
				slug: "empty-minute-batch",
				name: "Empty minute batch",
				prompt: "Summarize newly landed GitHub content.",
				managed_agent_id: agent.agentId,
				sources: [
					{
						name: "github",
						query:
							"SELECT id, payload_text FROM events WHERE connector_key = 'never-present' ORDER BY occurred_at DESC",
					},
				],
				triggers: [
					{
						kind: "schedule",
						cron: "* * * * *",
						execution: "window",
						active_run: "coalesce",
						skip_if_unchanged: true,
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
		const sql = getTestDb();
		await sql`
			UPDATE automations
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${automationId}
		`;

		// A skip must book the exact database horizon inspected before source execution.
		let inspectedHorizon: string | undefined;
		const admittedStatuses: string[] = [];
		const observe = (client: DbClient): DbClient => new Proxy(client, {
			apply(target, self, args) {
				const query = Reflect.apply(target, self, args);
				const text = Array.isArray(args[0]) ? args[0].join('') : '';
				if (!inspectedHorizon && text.includes('last_completed_window_start') && text.includes('FOR UPDATE')) {
					return query.then(async (rows: Array<{ db_now: string | Date; oldest_open_transaction: string | Date | null }>) => {
						inspectedHorizon = automationArrivalHorizon(
							new Date(rows[0].db_now),
							rows[0].oldest_open_transaction ? new Date(rows[0].oldest_open_transaction) : null,
						).toISOString();
						await sql`SELECT pg_sleep(0.02)`;
						return rows;
					});
				}
				if (text.includes('INSERT INTO runs')) {
					return query.then(async (rows: Array<{ id: number }>) => {
						const [run] = await sql`SELECT status FROM runs WHERE id = ${rows[0].id}`;
						admittedStatuses.push(run?.status as string ?? 'uncommitted');
						return rows;
					});
				}
				return query;
			},
			get(target, key) {
				// Forward both begin forms: `begin(fn)` and `begin('read only', fn)`.
				if (key === 'begin' || key === 'savepoint') return (...args: unknown[]) => {
					const callback = args.pop() as (tx: DbClient) => Promise<unknown>;
					return (target[key] as (...a: unknown[]) => Promise<unknown>)(...args, (tx: DbClient) => callback(observe(tx)));
				};
				return Reflect.get(target, key);
			},
		});
		const result = await materializeDueAutomationRuns({} as Env, observe(sql));
		// A dispatcher on another replica must never see a pending no-op.
		expect(admittedStatuses).toEqual(['uncommitted']);

		expect(result).toMatchObject({
			dueAutomations: 1,
			runsCreated: 0,
			skipped: 1,
		});
		const runs = await sql`
			SELECT id, approved_input->>'window_start' AS window_start,
			       approved_input->>'window_end' AS window_end, run_metadata,
			       action_output, output_tail, outcome, status
			FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
		`;
		expect(runs).toHaveLength(1);
		expect(inspectedHorizon).toBeDefined();
		expect(new Date(runs[0].window_end as string).toISOString()).toBe(inspectedHorizon);
		expect(runs[0]).toMatchObject({
			status: "completed",
			outcome: "scoreable",
			action_output: {},
			output_tail: "No-op: scheduled source content is unchanged.",
		});
		expect(runs[0].run_metadata).toMatchObject({
			content_analyzed: 0,
			skipped_unchanged: true,
		});
		const [automation] = await sql`
			SELECT next_run_at > current_timestamp AS advanced, next_window_start
			FROM automations WHERE id = ${automationId}
		`;
		expect(automation?.advanced).toBe(true);
		expect(new Date(automation.next_window_start as string).toISOString()).toBe(
			new Date(runs[0].window_end as string).toISOString(),
		);

		const nextOccurredAt = new Date(
			new Date(runs[0].window_end as string).getTime() + 30_000,
		);
		await sql`
			INSERT INTO events (
				entity_ids, organization_id, origin_id, payload_type, payload_text,
				semantic_type, connector_key, occurred_at
			) VALUES (
				'{}'::bigint[], ${org.id}, 'next-period-event', 'text', 'new data',
				'content', 'never-present', ${nextOccurredAt}
			)
		`;
		await sql`
			UPDATE automations
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${automationId}
		`;

		const nextResult = await materializeDueAutomationRuns({} as Env, sql);
		expect(nextResult).toMatchObject({
			dueAutomations: 1,
			runsCreated: 1,
			skipped: 0,
		});
		const [nextRun] = await sql`
			SELECT approved_input
			FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
			ORDER BY id DESC
			LIMIT 1
		`;
		expect(nextRun.approved_input).toMatchObject({
			window_start: new Date(runs[0].window_end as string).toISOString(),
		});
	});

	it("does not treat its own empty-window cursor as default-source content", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageAutomations(
			{
				action: "create",
				slug: "empty-default-source",
				name: "Empty default source",
				prompt: "Summarize new workspace content.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "schedule",
						cron: "* * * * *",
						skip_if_unchanged: true,
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
		const sql = getTestDb();
		const makeDue = () => sql`
			UPDATE automations
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${automationId}
		`;

		await makeDue();
		const first = await materializeDueAutomationRuns({} as Env, sql);
		await makeDue();
		const second = await materializeDueAutomationRuns({} as Env, sql);

		expect(first).toMatchObject({ runsCreated: 0, skipped: 1 });
		expect(second).toMatchObject({ runsCreated: 0, skipped: 1 });
		const runs = await sql`
			SELECT id, status, run_metadata FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
		`;
		expect(runs).toHaveLength(2);
		expect(runs.every((run) => run.status === "completed")).toBe(true);
		expect(
			runs.every(
				(run) =>
					(run.run_metadata as Record<string, unknown>).skipped_unchanged === true,
			),
		).toBe(true);
	});
});
