/**
 * Automation reactions must survive a crash between the window commit and the
 * script running.
 *
 * The reaction used to execute INLINE, after `complete_window`'s transaction had
 * already committed. A process death in that gap lost it permanently: the run
 * was durably `completed`, and `complete_window` short-circuits on an
 * already-completed run, so no replay path would ever fire it again. These
 * tests pin the durable handoff that replaces it — the task row commits WITH the
 * window — plus the rehydration and retry classification the inline loop used to own.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	automationReactionIdempotencyKey,
	type AutomationReactionTaskPayload,
} from "../../../automations/reaction-enqueue";
import { runAutomationReactionTask } from "../../../automations/reaction-task";
import type { Env } from "../../../index";
import { createAutomationRun } from "../../../runs/queue-service";
import {
	AUTOMATION_REACTION_TASK,
	AUTOMATION_REACTION_TASK_QUEUE,
} from "../../../scheduled/task-definitions";
import { computePendingWindow } from "../../../utils/window-utils";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

const DEVICE_WORKER_ID = "77777777-7777-7777-7777-777777777777";

/** A reaction-bearing Automation with one claimed, running window ready to complete. */
async function seedRunnableWindow(reactionScript: string) {
	const sql = getTestDb();
	const workspace = await TestWorkspace.create({ name: "Reaction Durability Org" });
	const entity = await createTestEntity({
		name: "Reaction Entity",
		organization_id: workspace.org.id,
		created_by: workspace.users.owner.id,
	});
	const agent = await createTestAgent({
		organizationId: workspace.org.id,
		ownerUserId: workspace.users.owner.id,
		agentId: "reaction-agent",
		name: "Reaction Agent",
	});
	const automation = (await workspace.owner.automations.create({
		entity_id: entity.id,
		slug: "reaction-automation",
		name: "Reaction Automation",
		prompt: "Summarize content for the bound entities.",
		triggers: [
			{
				kind: "schedule",
				cron: "0 9 * * *",
				execution: "window",
				active_run: "coalesce",
				skip_if_unchanged: false,
			},
		],
		managed_agent_id: agent.agentId,
	})) as { automation_id: string };
	const automationId = Number(automation.automation_id);

	await sql`
    UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes'
    WHERE id = ${automationId}
  `;

	const api = await TestApiClient.for({
		organizationId: workspace.org.id,
		userId: workspace.users.owner.id,
		memberRole: "owner",
	});
	await api.automations.setReactionScript({
		automation_id: String(automationId),
		reaction_script: reactionScript,
	});
	const { windowStart, windowEnd } = await computePendingWindow(sql as never, automationId);
	const queued = await createAutomationRun({
		organizationId: workspace.org.id,
		automationId,
		agentId: agent.agentId,
		windowStart: windowStart.toISOString(),
		windowEnd: windowEnd.toISOString(),
		dispatchSource: "scheduled",
		deviceWorkerId: DEVICE_WORKER_ID,
		agentKind: "claude-code",
	});
	await sql`
    UPDATE runs
    SET status = 'running', claimed_at = NOW(), claimed_by = 'reaction-durability-test'
    WHERE id = ${queued.runId}
  `;

	return { sql, workspace, api, automationId, runId: queued.runId };
}

/**
 * A window token for a queued run.
 *
 * Bound with `run_id`: on the arrival axis an unbound read recomputes
 * `[mark, horizon)` against a clock that has moved since the run was queued, so
 * its bounds would no longer match the run's snapshot and `complete_window`
 * would reject them. Real callers bind the same way.
 */
async function issueWindowToken(
	api: Awaited<ReturnType<typeof seedRunnableWindow>>["api"],
	automationId: number,
	runId: number,
) {
	const content = (await api.knowledge.read({
		automation_id: automationId,
		run_id: runId,
	})) as {
		window_token: string;
	};
	return content.window_token;
}

async function completeWindow(
	api: Awaited<ReturnType<typeof seedRunnableWindow>>["api"],
	automationId: number,
	runId: number,
	extracted: Record<string, unknown> = { summary: "Reaction durability run." },
	windowToken?: string,
) {
	const token = windowToken ?? (await issueWindowToken(api, automationId, runId));
	return (await api.automations.completeWindow({
		automation_id: String(automationId),
		run_id: runId,
		window_token: token,
		extracted_data: extracted,
		run_metadata: { source: "device_worker", run_id: runId },
	})) as {
		run_id: number;
		reaction_status: string;
		reaction_task_run_id?: number;
	};
}

/** The durable reaction task rows for a source run, newest first. */
function reactionTasks(sql: ReturnType<typeof getTestDb>, runId: number) {
	return sql`
    SELECT id, status, action_key, action_input, max_attempts, organization_id,
           automation_id, parent_run_id, queue_name,
           run_metadata->>'reaction_script_compiled' AS reaction_script_compiled
    FROM runs
    WHERE run_type = 'task'
      AND action_key = ${AUTOMATION_REACTION_TASK}
      AND idempotency_key = ${automationReactionIdempotencyKey(runId)}
    ORDER BY id DESC
  `;
}

describe("automation reaction crash safety", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("commits a durable reaction task with the window instead of running it inline", async () => {
		const { sql, automationId, runId, api } = await seedRunnableWindow(
			"export default async function reaction() { return; }",
		);

		const completion = await completeWindow(api, automationId, runId);

		// The handoff is committed, not executed: the caller is told it is queued
		// and the script has demonstrably not run yet.
		expect(completion.reaction_status).toBe("queued");
		const logged = await sql`
      SELECT id FROM automation_reactions WHERE source_run_id = ${runId}
    `;
		expect(logged.length).toBe(0);

		// This row is what survives a crash. Before the fix nothing existed here,
		// so a process death after commit lost the reaction permanently.
		const tasks = await reactionTasks(sql, runId);
		expect(tasks.length).toBe(1);
		expect(completion.reaction_task_run_id).toBe(Number(tasks[0].id));
		expect(String(tasks[0].status)).toBe("pending");
		// A dedicated lane keeps old rolling-deploy pods, which only work the
		// shared `task` queue, from claiming and exhausting an unknown handler.
		expect(String(tasks[0].queue_name)).toBe(AUTOMATION_REACTION_TASK_QUEUE);
		expect(Number(tasks[0].automation_id)).toBe(automationId);
		expect(Number(tasks[0].parent_run_id)).toBe(runId);
		// Retry budget matches the inline loop it replaced.
		expect(Number(tasks[0].max_attempts)).toBe(3);
		expect(String(tasks[0].reaction_script_compiled)).toContain("reaction");

		// It committed atomically with the completed run.
		const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
		expect(String(run.status)).toBe("completed");
	});

	it("rehydrates the window context from the source run and runs the script", async () => {
		// The script writes what it received into knowledge, so the assertion is on
		// the context the sandbox actually saw — not on a serialized bundle.
		const { sql, automationId, runId, api, workspace } = await seedRunnableWindow(
			`export default async function reaction(ctx, client) {
        await client.knowledge.save({
          semantic_type: 'note',
          title: 'reaction-echo',
          content: JSON.stringify({
            run_id: ctx.window.run_id,
            automation_id: ctx.window.automation_id,
            window_start: ctx.window.window_start,
            window_end: ctx.window.window_end,
            summary: ctx.extracted_data.summary,
            automation_slug: ctx.automation.slug,
          }),
        });
      }`,
		);

		await completeWindow(api, automationId, runId, { summary: "Churn rose 4%." });

		const [task] = await reactionTasks(sql, runId);
		const payload = (task.action_input as { payload: AutomationReactionTaskPayload })
			.payload;
		expect(payload).toEqual({
			organizationId: workspace.org.id,
			automationId,
			sourceRunId: runId,
		});

		const outcome = await runAutomationReactionTask(
			payload,
			{} as Env,
			Number(task.id),
			2,
		);
		expect(outcome.status).toBe("success");

		const [echo] = await sql`
      SELECT payload_text FROM events
      WHERE organization_id = ${workspace.org.id} AND title = 'reaction-echo'
      ORDER BY id DESC LIMIT 1
    `;
		expect(echo).toBeDefined();
		const seen = JSON.parse(String(echo.payload_text));
		expect(seen.run_id).toBe(runId);
		expect(seen.automation_id).toBe(automationId);
		expect(seen.summary).toBe("Churn rose 4%.");
		expect(seen.automation_slug).toBe("reaction-automation");
		// Arrival-axis windows have no granularity, and the SDK field is gone with
		// it. The BOUNDS are what a reaction reads; asserting the key is absent
		// keeps a reintroduced field from going unnoticed.
		expect(seen).not.toHaveProperty("granularity");
		expect(seen.window_start).toBeTruthy();
		expect(seen.window_end).toBeTruthy();

		// The run is logged where get_automation already surfaces it. TWO rows: the
		// script wrapper, and the `knowledge.save` the script itself performed.
		// That save declares no `automation_source` and is credited from the
		// stamped acting session instead, so the write that actually touched the
		// workspace is recorded rather than attributed to nobody.
		const logged = await sql`
      SELECT reaction_type, tool_args
      FROM automation_reactions WHERE source_run_id = ${runId}
      ORDER BY reaction_type
    `;
		expect(logged.map((row) => String(row.reaction_type))).toEqual([
			"content_saved",
			"script_execution",
		]);
		expect(logged[1].tool_args).toEqual({ attempt: 2 });
	});

	/**
	 * The end-to-end claim, through the REAL executor rather than a simulated
	 * session: reaction-executor stamps `actingAutomationId`, the sandbox SDK
	 * carries it, `manage_entity` resolves it, and the row names the subject.
	 *
	 * `automation-source-surface` proves the two write surfaces resolve without a
	 * declaration, but it builds the acting session by hand. Only this path
	 * proves the executor actually stamps what those surfaces now read — the
	 * link that made `entity_id` 2-of-1143 rows in production.
	 */
	it("records the subject a real reaction acted on, end to end", async () => {
		// The subject is resolved here and inlined, so the assertion depends only
		// on the attribution chain and not on how `ctx.entities` is hydrated.
		const seedSql = getTestDb();
		const script = (entityId: number) =>
			`export default async function reaction(ctx, client) {
        await client.entities.update({
          entity_id: ${entityId},
          metadata: { provisioning_status: 'provisioned' },
        });
      }`;
		const { sql, automationId, runId, api } = await seedRunnableWindow(
			script(0),
		);
		const [subject] = await seedSql<{ id: number }>`
      SELECT id FROM entities WHERE name = 'Reaction Entity' ORDER BY id DESC LIMIT 1
    `;
		await api.automations.setReactionScript({
			automation_id: String(automationId),
			reaction_script: script(Number(subject.id)),
		});

		await completeWindow(api, automationId, runId, { summary: "Provisioned." });
		const [task] = await reactionTasks(sql, runId);
		const payload = (task.action_input as { payload: AutomationReactionTaskPayload })
			.payload;
		const outcome = await runAutomationReactionTask(
			payload,
			{} as Env,
			Number(task.id),
			1,
		);
		expect(outcome.status).toBe("success");

		const logged = await sql<{
			reaction_type: string;
			entity_id: number | string | null;
			automation_id: number | string;
		}>`
      SELECT reaction_type, entity_id, automation_id
      FROM automation_reactions WHERE source_run_id = ${runId}
      ORDER BY reaction_type
    `;
		expect(logged.map((row) => String(row.reaction_type))).toEqual([
			"entity_updated",
			"script_execution",
		]);
		// The subject, which is the whole point of the row.
		expect(Number(logged[0].entity_id)).toBe(Number(subject.id));
		expect(Number(logged[0].automation_id)).toBe(automationId);

		// And the write itself landed on the entity, so the row is not crediting
		// a mutation that silently did nothing.
		const [updated] = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${subject.id}
    `;
		expect(updated.metadata).toMatchObject({ provisioning_status: "provisioned" });
	});

	it("does not queue a second reaction when the completion is replayed", async () => {
		const { sql, automationId, runId, api } = await seedRunnableWindow(
			"export default async function reaction() { return; }",
		);

		const token = await issueWindowToken(api, automationId, runId);
		await completeWindow(api, automationId, runId, undefined, token);
		const first = await reactionTasks(sql, runId);
		expect(first.length).toBe(1);

		// Drive the task to completion, which CLOSES the scheduler's in-flight
		// idempotency window — the point at which a naive re-enqueue would insert a
		// duplicate rather than conflict.
		await sql`UPDATE runs SET status = 'completed' WHERE id = ${first[0].id}`;

		const replay = await completeWindow(api, automationId, runId, undefined, token);
		expect(replay.reaction_status).toBe("skipped");

		const after = await reactionTasks(sql, runId);
		expect(after.length).toBe(1);
		expect(Number(after[0].id)).toBe(Number(first[0].id));
	});

	it("settles without retrying when the script fails deterministically", async () => {
		// A compile failure is non-transient: retrying re-burns the executor budget
		// for no chance of recovery, so the handler must NOT ask for another attempt.
		const { sql, automationId, runId, api, workspace } = await seedRunnableWindow(
			"export default async function reaction() { return; }",
		);
		await sql`
      UPDATE automations
      SET reaction_script_compiled = 'this is not valid javascript ((('
      WHERE id = ${automationId}
    `;
		await completeWindow(api, automationId, runId);
		const [task] = await reactionTasks(sql, runId);

		const outcome = await runAutomationReactionTask(
			{ organizationId: workspace.org.id, automationId, sourceRunId: runId },
			{} as Env,
			Number(task.id),
		);

		expect(outcome.status).toBe("failed");
		// The failure is durably recorded rather than silently swallowed.
		const logged = await sql`
      SELECT tool_result FROM automation_reactions WHERE source_run_id = ${runId}
    `;
		expect(logged.length).toBe(1);
		expect((logged[0].tool_result as { success: boolean }).success).toBe(false);
	});

	it.each([
		[
			"edited",
			`export default async function replacement(ctx, client) {
        await client.knowledge.save({
          semantic_type: 'note',
          title: 'replacement-reaction',
          content: 'wrong script',
        });
      }`,
		],
		["cleared", null],
	])("runs the completion-time script when the live script is %s", async (_state, liveScript) => {
		const { sql, automationId, runId, api, workspace } = await seedRunnableWindow(
			`export default async function completionSnapshot(ctx, client) {
        await client.knowledge.save({
          semantic_type: 'note',
          title: 'completion-reaction',
          content: 'completion-time script',
        });
      }`,
		);
		await completeWindow(api, automationId, runId);
		const [task] = await reactionTasks(sql, runId);

		await sql`
      UPDATE automations
      SET reaction_script_compiled = ${liveScript}
      WHERE id = ${automationId}
    `;

		const outcome = await runAutomationReactionTask(
			{ organizationId: workspace.org.id, automationId, sourceRunId: runId },
			{} as Env,
			Number(task.id),
		);
		expect(outcome.status).toBe("success");

		const events = await sql`
      SELECT title FROM events
      WHERE organization_id = ${workspace.org.id}
        AND title IN ('completion-reaction', 'replacement-reaction')
      ORDER BY id
    `;
		expect(events.map((event) => String(event.title))).toEqual(["completion-reaction"]);
	});

	it("skips a task whose source run is no longer completable", async () => {
		const { sql, automationId, runId, api, workspace } = await seedRunnableWindow(
			"export default async function reaction() { return; }",
		);
		await completeWindow(api, automationId, runId);
		const [task] = await reactionTasks(sql, runId);

		// A task that outlived its run must settle, never retry against state that
		// will never appear.
		const missing = await runAutomationReactionTask(
			{ organizationId: workspace.org.id, automationId, sourceRunId: runId + 9999 },
			{} as Env,
			Number(task.id),
		);
		expect(missing).toEqual({ status: "skipped", reason: "source run not found" });

		await sql`UPDATE runs SET status = 'failed' WHERE id = ${runId}`;
		const notCompleted = await runAutomationReactionTask(
			{ organizationId: workspace.org.id, automationId, sourceRunId: runId },
			{} as Env,
			Number(task.id),
		);
		// Asserted on the REASON, not just the status: every skip in this test
		// would otherwise pass for the wrong cause.
		expect(notCompleted).toEqual({
			status: "skipped",
			reason: "source run is failed",
		});

		// Cross-org payloads resolve nothing rather than leaking another org's run.
		const otherOrg = await TestWorkspace.create({ name: "Other Org" });
		const crossOrg = await runAutomationReactionTask(
			{ organizationId: otherOrg.org.id, automationId, sourceRunId: runId },
			{} as Env,
			Number(task.id),
		);
		expect(crossOrg).toEqual({
			status: "skipped",
			reason: "source run not found",
		});
	});

	it("queues nothing when the Automation has no reaction script", async () => {
		const { sql, automationId, runId, api } = await seedRunnableWindow(
			"export default async function reaction() { return; }",
		);
		await sql`
      UPDATE automations SET reaction_script_compiled = NULL, reaction_script = NULL
      WHERE id = ${automationId}
    `;

		const completion = await completeWindow(api, automationId, runId);

		expect(completion.reaction_status).toBe("skipped");
		const tasks = await reactionTasks(sql, runId);
		expect(tasks.length).toBe(0);
	});
});
