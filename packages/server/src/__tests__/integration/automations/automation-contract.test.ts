/**
 * Compact automation contracts retained from the deleted broad suite.
 *
 * These are high-value queue/lifecycle boundaries: scheduled automations should
 * materialize only one active run, dispatcher reconciliation should close runs
 * that already produced a window, and complete_window provenance should close
 * a running queued run.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken, hashToken } from "../../../auth/oauth/utils";
import type { DbClient } from "../../../db/client";
import { getDb } from "../../../db/client";
import { ApiResponseRenderer } from "../../../gateway/api/response-renderer";
import { UnifiedThreadResponseConsumer } from "../../../gateway/platform/unified-thread-consumer";
import type { Env } from "../../../index";
import { createEvalRun } from "../../../runs/eval-runs";
import { createAutomationRun } from "../../../runs/queue-service";
import {
	AUTOMATION_EVAL_RUN_TYPE,
	AUTOMATION_RUN_TYPE,
} from "../../../runs/run-types";
import { nextRunAt } from "../../../utils/cron";
import { generateWindowToken } from "../../../utils/jwt";
import { computePendingWindow } from "../../../utils/window-utils";
import { handleAutomationMode } from "../../../tools/get_content/automation-mode";
import {
	dispatchPendingAutomationRuns,
	materializeDueAutomationRuns,
	reconcileAutomationRuns,
	runAutomationTick,
	sweepStaleAutomationRuns,
} from "../../../automations/automation";
import { advanceAutomationSchedule } from "../../../automations/schedule-cursor";
import { runAutomationReactionTask } from "../../../automations/reaction-task";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestEntity,
	createTestEvent,
} from "../../setup/test-fixtures";
import { post } from "../../setup/test-helpers";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

/**
 * Mint a `device_worker:run` PAT, optionally bound to a device worker_id.
 * Mirrors PersonalAccessTokenService.create but inlined so the test can
 * pre-set (or omit) the binding without going through the route. A null
 * `workerId` is the shape every credential except a mint-child-token child
 * arrives with — OAuth access tokens included.
 */
async function createWorkerPat(
	userId: string,
	organizationId: string,
	workerId: string | null,
	scope = "device_worker:run"
): Promise<{ token: string }> {
	const sql = getTestDb();
	const token = `owl_pat_${generateSecureToken(24)}`;
	const tokenHash = hashToken(token);
	const tokenPrefix = token.substring(0, 12);
	await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${tokenHash}, ${tokenPrefix}, ${userId}, ${organizationId},
      ${`Test worker PAT (${workerId ?? "unbound"})`}, ${scope}, ${workerId},
      NOW(), NOW()
    )
  `;
	return { token };
}

async function createAutomatedAutomation() {
	const sql = getTestDb();
	const dbClient = sql as unknown as DbClient;
	const workspace = await TestWorkspace.create({
		name: "Automation Contract Org",
	});

	const entity = await createTestEntity({
		name: "Automation Entity",
		organization_id: workspace.org.id,
		created_by: workspace.users.owner.id,
	});

	const agent = await createTestAgent({
		organizationId: workspace.org.id,
		ownerUserId: workspace.users.owner.id,
		agentId: "contract-agent",
		name: "Contract Agent",
	});

	const automation = (await workspace.owner.automations.create({
		entity_id: entity.id,
		slug: "contract-automation",
		name: "Contract Automation",
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
    UPDATE automations
    SET next_run_at = NOW() - INTERVAL '10 minutes'
    WHERE id = ${automationId}
  `;

	const api = await TestApiClient.for({
		organizationId: workspace.org.id,
		userId: workspace.users.owner.id,
		memberRole: "owner",
	});

	return {
		sql,
		dbClient,
		workspace,
		api,
		entityId: entity.id,
		agent,
		automationId,
	};
}

describe("automation contract", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("materializes one scheduled automation run and dedupes concurrent ticks", async () => {
		const { sql, automationId, agent, workspace } = await createAutomatedAutomation();

		const [resultA, resultB] = await Promise.all([
			materializeDueAutomationRuns({} as Env),
			materializeDueAutomationRuns({} as Env),
		]);

		expect(resultA.runsCreated + resultB.runsCreated).toBe(1);

		const runs = await sql`
      SELECT status, approved_input
      FROM runs
      WHERE automation_id = ${automationId}
        AND run_type = 'automation'
        AND organization_id = ${workspace.org.id}
    `;
		expect(runs).toHaveLength(1);
		expect(String(runs[0].status)).toBe("pending");

		const payload = runs[0].approved_input as Record<string, unknown>;
		expect(Number(payload.automation_id)).toBe(automationId);
		expect(payload.agent_id).toBe(agent.agentId);
		expect(payload.dispatch_source).toBe("scheduled");
	});

	it("completes a queued automation run from complete_window provenance", async () => {
		const { sql, dbClient, workspace, api, entityId, automationId, agent } =
			await createAutomatedAutomation();

		await createTestEvent({
			entity_id: entityId,
			organization_id: workspace.org.id,
			content: "Customer feedback that should be summarized.",
			occurred_at: new Date(Date.now() - 60 * 60 * 1000),
		});
		const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
		const queued = await createAutomationRun({
			organizationId: workspace.org.id,
			automationId,
			agentId: agent.agentId,
			windowStart: windowStart.toISOString(),
			windowEnd: windowEnd.toISOString(),
			dispatchSource: "scheduled",
		});

		await sql`
      UPDATE runs
      SET status = 'running',
          claimed_at = NOW(),
          claimed_by = ${`lobu:${agent.agentId}`},
          dispatched_message_id = 'msg-complete-window-provenance'
      WHERE id = ${queued.runId}
    `;

		// Bound to the queued run: on the arrival axis an unbound read recomputes
		// [mark, horizon) against a clock that has moved since the run was
		// queued, so its bounds would no longer match the run's snapshot.
		const content = (await handleAutomationMode(
			{ automation_id: automationId, run_id: queued.runId },
			{ JWT_SECRET: "test-jwt-secret-for-testing-only" } as Env,
			dbClient,
			{
				organizationId: workspace.org.id,
				userId: null,
			}
		)) as {
			window_token: string;
			window_start: string;
			window_end: string;
			entities?: Array<{
				id: number;
				name: string;
				type: string;
				metadata: Record<string, unknown>;
			}>;
		};
		expect(content.window_start).toBe(windowStart.toISOString());
		expect(content.window_end).toBe(windowEnd.toISOString());
		expect(content.entities).toEqual([
			expect.objectContaining({
				id: entityId,
				name: "Automation Entity",
				type: "brand",
			}),
		]);
		// Prompts are literal text delivered via the dispatch message; the read
		// path no longer stamps a rendered prompt onto the run.
		const [unstampedRun] =
			await sql`SELECT run_metadata FROM runs WHERE id = ${queued.runId}`;
		expect(
			(unstampedRun.run_metadata as Record<string, unknown> | null)
				?.prompt_rendered
		).toBeUndefined();

		const completion = (await api.automations.completeWindow({
			automation_id: String(automationId),
			run_id: queued.runId,
			window_token: content.window_token,
			extracted_data: { summary: "Automated automation summary" },
			run_metadata: {
				executor: "lobu-agent",
				managed_agent_id: agent.agentId,
				run_id: queued.runId,
				dispatch_source: "scheduled",
				prompt_rendered: "forged by completion payload",
			},
		})) as { action: string; run_id: number };

		const [run] = await sql`
      SELECT status, action_output, model_used, run_metadata
      FROM runs
      WHERE id = ${queued.runId}
    `;

		expect(completion.action).toBe("complete_window");
		expect(String(run.status)).toBe("completed");
		expect(completion.run_id).toBe(queued.runId);
		expect(run.action_output).toEqual({ summary: "Automated automation summary" });
		expect(String(run.model_used)).toBe("lobu-agent");
		// The forged prompt_rendered from the completion payload must be
		// stripped — that key is reserved for historical server-stamped runs.
		expect(
			(run.run_metadata as Record<string, unknown>).prompt_rendered
		).toBeUndefined();
		expect((run.run_metadata as Record<string, unknown>).executor).toBe(
			"lobu-agent"
		);
		expect((run.run_metadata as Record<string, unknown>).run_id).toBeUndefined();
	});

	it("skips automation runs pinned to a device worker (#802)", async () => {
		const { sql, dbClient, workspace, automationId, agent } =
			await createAutomatedAutomation();
		const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
		const queued = await createAutomationRun({
			organizationId: workspace.org.id,
			automationId,
			agentId: agent.agentId,
			windowStart: windowStart.toISOString(),
			windowEnd: windowEnd.toISOString(),
			dispatchSource: "scheduled",
		});

		// Pin the run to a device worker — the dispatcher in #798 will set this
		// when the automation is bound to a Mac/CLI device. Until that lands the
		// server-side claim path must already refuse to grab the row.
		await sql`
      UPDATE runs
      SET approved_input = approved_input || ${sql.json({ device_worker_id: "mac-device-abc" })}
      WHERE id = ${queued.runId}
    `;

		const result = await dispatchPendingAutomationRuns({
			db: dbClient,
		});

		expect(result.claimed).toBe(0);
		expect(result.dispatched).toBe(0);

		const [run] = await sql`
      SELECT status, claimed_by, claimed_at
      FROM runs
      WHERE id = ${queued.runId}
    `;
		expect(String(run.status)).toBe("pending");
		expect(run.claimed_by).toBeNull();
		expect(run.claimed_at).toBeNull();

		// Explicit runIds path must also refuse to claim — the dispatcher's
		// queueAndDispatchAutomationRun helper hits this branch when an automation run
		// is manually triggered.
		const targeted = await dispatchPendingAutomationRuns({
			db: dbClient,
			runIds: [queued.runId],
		});
		expect(targeted.claimed).toBe(0);

		const [stillPending] = await sql`
      SELECT status FROM runs WHERE id = ${queued.runId}
    `;
		expect(String(stillPending.status)).toBe("pending");
	});

	it("paginates automation reads by cursor and completes from multiple page tokens", async () => {
		const { sql, workspace, api, entityId, automationId } =
			await createAutomatedAutomation();

		const base = Date.UTC(2026, 0, 2, 12, 0, 0);
		const events = [];
		for (let i = 0; i < 5; i++) {
			events.push(
				await createTestEvent({
					entity_id: entityId,
					organization_id: workspace.org.id,
					title: `Paginated event ${i}`,
					content: `Paginated automation content ${i}`,
					occurred_at: new Date(base - i * 60_000),
					// Stored when they are dated: the requested range below selects
					// `created_at`, and this test is about cursor paging, not the axis.
					created_at: new Date(base - i * 60_000),
				})
			);
		}

		const preview = (await api.knowledge.read({
			automation_id: automationId,
			since: "2026-01-02",
			until: "2026-01-02",
			limit: 1,
		})) as { window_start: string; window_end: string };
		const run = await createAutomationRun({
			organizationId: workspace.org.id,
			automationId,
			windowStart: preview.window_start,
			windowEnd: preview.window_end,
			dispatchSource: "manual",
		});

		const page1 = (await api.knowledge.read({
			automation_id: automationId,
			run_id: run.runId,
			limit: 2,
		})) as {
			content: Array<{ id: number; occurred_at: string }>;
			window_token: string;
			page: {
				has_more: boolean;
				next_cursor?: { occurred_at: string; id: number };
			};
		};

		expect(page1.content.map((item) => item.id)).toEqual([
			events[0].id,
			events[1].id,
		]);
		expect(page1.page.has_more).toBe(true);
		expect(page1.page.next_cursor).toBeDefined();

		const page2 = (await api.knowledge.read({
			automation_id: automationId,
			run_id: run.runId,
			limit: 2,
			before_occurred_at: page1.page.next_cursor!.occurred_at,
			before_id: page1.page.next_cursor!.id,
		})) as {
			content: Array<{ id: number }>;
			window_token: string;
			page: {
				has_more: boolean;
				next_cursor?: { occurred_at: string; id: number };
			};
		};

		expect(page2.content.map((item) => item.id)).toEqual([
			events[2].id,
			events[3].id,
		]);
		expect(page2.page.has_more).toBe(true);
		const page3 = (await api.knowledge.read({
			automation_id: automationId,
			run_id: run.runId,
			limit: 2,
			before_occurred_at: page2.page.next_cursor!.occurred_at,
			before_id: page2.page.next_cursor!.id,
		})) as {
			content: Array<{ id: number }>;
			window_token: string;
			page: { has_more: boolean };
		};
		expect(page3.content.map((item) => item.id)).toEqual([events[4].id]);
		expect(page3.page.has_more).toBe(false);
		const completion = (await api.automations.completeWindow({
			automation_id: String(automationId),
			run_id: run.runId,
			window_tokens: [page1.window_token, page2.window_token, page3.window_token],
			extracted_data: { summary: "Summary across all pages" },
		})) as { action: string; run_id: number; content_linked: number };

		const links = await sql`
      SELECT event_id
      FROM automation_run_events
      WHERE run_id = ${completion.run_id}
      ORDER BY event_id
    `;

		expect(completion.action).toBe("complete_window");
		expect(completion.content_linked).toBe(5);
		expect(
			links.map((row) => Number(row.event_id)).sort((a, b) => a - b)
		).toEqual(
			[events[0].id, events[1].id, events[2].id, events[3].id, events[4].id].sort(
				(a, b) => a - b
			)
		);
	});

	it("links exact signed content IDs and a successful manual window resumes an auto-pause", async () => {
		const { sql, workspace, api, entityId, automationId } =
			await createAutomatedAutomation();

		const event = await createTestEvent({
			entity_id: entityId,
			organization_id: workspace.org.id,
			content: "Content returned to the automation worker.",
			occurred_at: new Date(Date.now() - 60 * 60 * 1000),
		});
		const windowStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		const windowEnd = new Date().toISOString();

		const run = await createAutomationRun({
			organizationId: workspace.org.id,
			automationId,
			windowStart,
			windowEnd,
			dispatchSource: "manual",
		});
		await sql`
      UPDATE automations
      SET consecutive_scheduled_failures = 5,
          schedule_auto_paused_at = date_trunc('milliseconds', current_timestamp)
      WHERE id = ${automationId}
    `;
		const windowToken = await generateWindowToken(
			{
				automation_id: automationId,
				run_id: run.runId,
				window_start: windowStart,
				window_end: windowEnd,
				content_count: 1,
				content_ids: [event.id],
			},
			{ JWT_SECRET: "test-jwt-secret-for-testing-only" } as Env
		);
		const completion = (await api.automations.completeWindow({
			automation_id: String(automationId),
			run_id: run.runId,
			window_token: windowToken,
			extracted_data: { summary: "Summary from exact content IDs" },
		})) as { action: string; run_id: number; content_linked: number };

		const [completedRun] = await sql`
      SELECT (run_metadata->>'content_analyzed')::int AS content_analyzed
      FROM runs
      WHERE id = ${completion.run_id}
    `;
		const links = await sql`
      SELECT event_id
      FROM automation_run_events
      WHERE run_id = ${completion.run_id}
    `;

		expect(completion.action).toBe("complete_window");
		expect(completion.content_linked).toBe(1);
		expect(Number(completedRun.content_analyzed)).toBe(1);
		expect(links.map((row) => Number(row.event_id))).toEqual([event.id]);
		const [recovered] = await sql`
      SELECT consecutive_scheduled_failures, schedule_auto_paused_at, next_run_at
      FROM automations WHERE id = ${automationId}
    `;
		expect(Number(recovered.consecutive_scheduled_failures)).toBe(0);
		expect(recovered.schedule_auto_paused_at).toBeNull();
		expect(recovered.next_run_at).not.toBeNull();
	});

	// #798 — device-pinned automation execution end-to-end:
	//
	//   automation.device_worker_id set
	//     → materializeDueAutomationRuns persists the pin into approved_input
	//     → server-side dispatcher refuses to claim (#802 covers this; checked
	//       above by the "skips automation runs pinned to a device worker" test)
	//     → device posts to /api/workers/me/runs/:id/complete-automation
	//         which stores the run result + advances last_fired_at.
	describe("device-pinned execution (#798)", () => {
		it("persists automations.device_worker_id and agent_kind into approved_input on materialization", async () => {
			const { sql, automationId } = await createAutomatedAutomation();

			// Register a device worker to anchor the foreign key.
			const [device] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES ('user-automation-pin', 'device-pin-1', 'macos', ${sql.json({})}, 'My Mac')
        RETURNING id
      `;
			const deviceWorkerId = String((device as { id: unknown }).id);

			await sql`
        UPDATE automations
        SET device_worker_id = ${deviceWorkerId}::uuid,
            agent_kind = 'claude-code'
        WHERE id = ${automationId}
      `;

			const result = await materializeDueAutomationRuns({} as Env);
			expect(result.runsCreated).toBe(1);

			const [run] = await sql`
        SELECT approved_input
        FROM runs
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
      `;
			const payload = run.approved_input as Record<string, unknown>;
			expect(payload.device_worker_id).toBe(deviceWorkerId);
			expect(payload.agent_kind).toBe("claude-code");
		});

		// The device contract: the CLI agent completes the run itself over MCP
		// (query_sdk → completeWindow) — the same pipeline as server-side
		// automation agents. The dispatcher's POST is only an exit report that
		// stamps device provenance on the already-completed run.
		it("exit report acks an MCP-completed run and stamps device provenance", async () => {
			const { sql, dbClient, workspace, api, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);

			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "11111111-1111-1111-1111-111111111111",
				agentKind: "claude-code",
			});

			// Move the run into `running` claimed by a specific worker — the device
			// path normally claims via /api/workers/poll; we shortcut here.
			const workerId = "mac-device-cli-test";
			await sql`
        UPDATE runs
        SET status = 'running',
            claimed_at = NOW(),
            claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

			// The spawned CLI agent completes over MCP, exactly like a server
			// agent: query_sdk → window_token → run_sdk (completeWindow).
			// Bound to the queued run — see the note on the provenance test above.
			const content = (await api.knowledge.read({
				automation_id: automationId,
				run_id: queued.runId,
			})) as {
				window_token: string;
			};
			const completion = (await api.automations.completeWindow({
				automation_id: String(automationId),
				run_id: queued.runId,
				window_token: content.window_token,
				extracted_data: { summary: "Looked at 5 events, no anomalies." },
				model: "device-cli:claude-code",
				run_metadata: {
					source: "device_worker",
					agent_kind: "claude-code",
					run_id: queued.runId,
				},
			})) as { run_id: number };

			// The subprocess exits; the dispatcher posts the exit report.
			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "Done — completed via complete_window.",
						duration_ms: 1234,
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			expect(response.status).toBe(200);
			const json = (await response.json()) as {
				ok: boolean;
				status: string;
				run_id?: number;
			};
			expect(json.ok).toBe(true);
			expect(json.status).toBe("completed");
			expect(Number(json.run_id)).toBe(completion.run_id);

			const [run] = await sql`
        SELECT status, completed_at, action_output, exit_code, exit_reason
        FROM runs
        WHERE id = ${queued.runId}
      `;
			expect(String(run.status)).toBe("completed");
			expect(run.completed_at).not.toBeNull();
			expect(run.action_output).toEqual({
				summary: "Looked at 5 events, no anomalies.",
			});
			expect(Number(run.exit_code)).toBe(0);
			expect(String(run.exit_reason)).toBe("ok");

			const [runProvenance] = await sql`
        SELECT model_used, (run_metadata->>'execution_time_ms')::int AS execution_time_ms
        FROM runs
        WHERE id = ${queued.runId}
      `;
			expect(Number(runProvenance.execution_time_ms)).toBe(1234);
			expect(String(runProvenance.model_used)).toBe("device-cli:claude-code");

			const [automation] = await sql`
        SELECT last_fired_at
        FROM automations
        WHERE id = ${automationId}
      `;
			expect(automation.last_fired_at).not.toBeNull();

			// A duplicate exit report acks idempotently without re-stamping.
			const dup = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "dup",
						duration_ms: 9,
						exit_code: 0,
					},
				}
			);
			expect(dup.status).toBe(200);
			const dupJson = (await dup.json()) as {
				status: string;
				idempotent?: boolean;
			};
			expect(dupJson.status).toBe("completed");
			expect(dupJson.idempotent).toBe(true);
			const [runAfterDup] = await sql`
        SELECT (run_metadata->>'execution_time_ms')::int AS execution_time_ms
        FROM runs WHERE id = ${queued.runId}
      `;
			expect(Number(runAfterDup.execution_time_ms)).toBe(1234);
		});

		it("exit report without duration_ms preserves run_metadata (jsonb_set strictness)", async () => {
			// jsonb_set is STRICT: stamping execution_time_ms with a NULL duration
			// (device report omits duration_ms, none recorded) must NOT null out the
			// run_metadata that complete_window already wrote.
			const { sql, dbClient, workspace, api, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "11111111-1111-1111-1111-111111111111",
				agentKind: "claude-code",
			});
			const workerId = "mac-device-cli-test-nodur";
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;
			// Bound to the queued run — see the note on the provenance test above.
			const content = (await api.knowledge.read({
				automation_id: automationId,
				run_id: queued.runId,
			})) as {
				window_token: string;
			};
			await api.automations.completeWindow({
				automation_id: String(automationId),
				run_id: queued.runId,
				window_token: content.window_token,
				extracted_data: { summary: "No-duration exit report case." },
				run_metadata: {
					source: "device_worker",
					agent_kind: "claude-code",
				},
			});

			// Exit report with NO duration_ms.
			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "done",
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			expect(response.status).toBe(200);

			const [run] = await sql`
        SELECT run_metadata, model_used FROM runs WHERE id = ${queued.runId}
      `;
			const meta = run.run_metadata as Record<string, unknown> | null;
			expect(meta).not.toBeNull();
			expect(meta?.source).toBe("device_worker");
			expect(meta?.agent_kind).toBe("claude-code");
			expect(String(run.model_used)).toBe("device-cli:claude-code");
		});

		// Content-less windows (device runs fetch their own context; nothing is
		// linked server-side) still fire the reaction script — the signal is the
		// extracted_data itself. The reaction log is surfaced on the window via
		// get_automation so the UI can show what the script did.
		it("fires the reaction script for a content-less window and surfaces the log", async () => {
			const { sql, dbClient, workspace, api, automationId, agent } =
				await createAutomatedAutomation();
			await api.automations.setReactionScript({
				automation_id: String(automationId),
				reaction_script: "export default async function reaction() { return; }",
			});
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "88888888-8888-8888-8888-888888888888",
				agentKind: "claude-code",
			});
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = 'mac-device-reaction-test'
        WHERE id = ${queued.runId}
      `;

			// Bound to the queued run — see the note on the provenance test above.
			const content = (await api.knowledge.read({
				automation_id: automationId,
				run_id: queued.runId,
			})) as {
				window_token: string;
			};
			const completion = (await api.automations.completeWindow({
				automation_id: String(automationId),
				run_id: queued.runId,
				window_token: content.window_token,
				extracted_data: { summary: "Device-run result, no server content." },
				run_metadata: { source: "device_worker", run_id: queued.runId },
			})) as {
				run_id: number;
				content_linked: number;
				reaction_status: string;
				reaction_task_run_id?: number;
			};

      // Zero content linked, yet the reaction fired for the completed run.
			// This test pins the gate + the log surface, not the sandbox itself:
			// runtimes without an isolated-vm build report 'failed' (the sandbox
			// suite covers executor health), so assert "attempted", never
			// 'skipped' — the pre-fix outcome this test exists to prevent.
			expect(completion.content_linked).toBe(0);
			expect(completion.reaction_status).toBe("queued");

			// The reaction is now a durable task committed with the window rather
			// than an inline call, so drive it the way the scheduler would before
			// asserting on its log. Crash safety itself is pinned in
			// reaction-crash-safety.test.ts.
			await runAutomationReactionTask(
				{
					organizationId: workspace.org.id,
					automationId,
					sourceRunId: completion.run_id,
				},
				{} as Env,
				Number(completion.reaction_task_run_id)
			);

			const reactionRows = await sql`
        SELECT reaction_type, tool_name FROM automation_reactions
        WHERE source_run_id = ${completion.run_id}
      `;
			expect(reactionRows.length).toBeGreaterThan(0);
			expect(String(reactionRows[0].reaction_type)).toBe("script_execution");

			// The window surfaces its reaction log through get_automation.
			const detail = (await api.automations.get({
				automation_id: String(automationId),
			})) as {
				windows: Array<{
					run_id: number;
					reactions?: Array<{ tool_name: string }>;
				}>;
			};
			const window = detail.windows.find(
				(w) => w.run_id === completion.run_id
			);
			expect(window).toBeDefined();
			expect(window?.reactions?.length ?? 0).toBeGreaterThan(0);
			expect(window?.reactions?.[0].tool_name).toBe("reaction_executor");
		});

		// Fail closed: the agent exiting cleanly WITHOUT calling complete_window
		// means no real work was recorded — the run must fail (and the schedule
		// advance), mirroring the server-side dispatch guard. This is exactly
		// the failure mode that masked the broken Reddit automation for a week.
		it("fails the run when the agent exits without calling complete_window", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "55555555-5555-5555-5555-555555555555",
				agentKind: "claude-code",
			});
			const workerId = "mac-device-nocomplete-test";
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

			const [before] =
				await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
			const beforeNextRun = before.next_run_at as Date | string | null;

			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output:
							"I looked at everything and it seems fine, nothing to report.",
						duration_ms: 50,
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			expect(response.status).toBe(200);
			const json = (await response.json()) as {
				ok: boolean;
				status: string;
				error?: string;
				nudge?: string;
				reason_code?: string;
				attempt?: number;
				max_attempts?: number;
			};
			// Default finalize_nudges budget is 1 → first miss is a device-held resume
			// (run stays running/claimed so the Mac can re-spawn).
			expect(json.status).toBe("resume");
			expect(json.reason_code).toBe("missing_complete_window");
			expect(json.attempt).toBe(1);
			expect(String(json.nudge ?? json.error ?? "")).toMatch(/completeWindow/i);
			expect(String(json.nudge ?? json.error ?? "")).toContain("automation_id");

			const [runAfterResume] = await sql`
        SELECT status, error_message, action_output, output_tail,
               approved_input->>'finalize_nudge_count' AS finalize_nudge_count
        FROM runs WHERE id = ${queued.runId}
      `;
			expect(String(runAfterResume.status)).toBe("running");
			expect(Number(runAfterResume.finalize_nudge_count)).toBe(1);
			expect(runAfterResume.action_output).toBeNull();
			expect(String(runAfterResume.output_tail)).toContain("nothing to report");

			// Second clean exit with no window exhausts the budget → terminal fail.
			const response2 = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "still nothing",
						duration_ms: 10,
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			expect(response2.status).toBe(200);
			const json2 = (await response2.json()) as {
				ok: boolean;
				status: string;
				error?: string;
				reason_code?: string;
			};
			expect(json2.status).toBe("failed");
			expect(json2.reason_code).toBe("missing_complete_window");
			expect(String(json2.error)).toMatch(/completeWindow/);

			const [run] = await sql`
        SELECT status, error_message, action_output, output_tail FROM runs WHERE id = ${queued.runId}
      `;
			expect(String(run.status)).toBe("failed");
			expect(String(run.error_message)).toMatch(/completeWindow/);
			expect(run.action_output).toBeNull();

			// Schedule must still advance so the automation doesn't re-fire forever.
			const [after] =
				await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
			const beforeMs = beforeNextRun ? new Date(beforeNextRun).getTime() : 0;
			const afterMs = after.next_run_at
				? new Date(after.next_run_at as string).getTime()
				: 0;
			expect(afterMs).toBeGreaterThan(beforeMs);
		});

		// Ambiguous delivery: the resume commits server-side but the device never
		// sees the response, so it retries the SAME exit report. Replaying it must
		// re-serve the grant it already earned — inferring a fresh attempt from the
		// stored count instead would burn the budget and fail the run one spawn
		// early, which is the delivery error being reinterpreted as work.
		it("replays the granted resume instead of consuming a second finalize attempt", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "66666666-6666-6666-6666-666666666666",
				agentKind: "claude-code",
			});
			const workerId = "mac-device-replay-test";
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

			const report = {
				worker_id: workerId,
				output: "exited without finalizing",
				duration_ms: 25,
				exit_code: 0,
				exit_reason: "ok",
				// First spawn runs under finalize_nudge_count = 0.
				finalize_attempt: 0,
			};

			const granted = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{ body: report }
			);
			expect(granted.status).toBe(200);
			const grantedJson = (await granted.json()) as {
				status: string;
				attempt?: number;
				nudge?: string;
			};
			expect(grantedJson.status).toBe("resume");
			expect(grantedJson.attempt).toBe(1);

			// Byte-identical replay of the same report — the device's retry after a
			// lost response.
			const replay = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{ body: report }
			);
			expect(replay.status).toBe(200);
			const replayJson = (await replay.json()) as {
				status: string;
				attempt?: number;
				reason_code?: string;
				idempotent?: boolean;
				nudge?: string;
			};
			expect(replayJson.status).toBe("resume");
			expect(replayJson.reason_code).toBe("missing_complete_window");
			expect(replayJson.attempt).toBe(1);
			expect(replayJson.idempotent).toBe(true);
			// The re-served nudge has to be usable, not just a status echo — the
			// device feeds it straight into the re-spawned prompt.
			expect(replayJson.nudge).toBe(grantedJson.nudge);

			const [afterReplay] = await sql`
        SELECT status,
               approved_input->>'finalize_nudge_count' AS finalize_nudge_count
        FROM runs WHERE id = ${queued.runId}
      `;
			expect(String(afterReplay.status)).toBe("running");
			// The replay consumed nothing: still exactly one granted resume.
			expect(Number(afterReplay.finalize_nudge_count)).toBe(1);

			// The genuinely-new spawn reports attempt 1 and exhausts the budget.
			const terminal = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{ body: { ...report, finalize_attempt: 1 } }
			);
			expect(terminal.status).toBe(200);
			expect(((await terminal.json()) as { status: string }).status).toBe(
				"failed"
			);
		});

		// Event turns have no completeWindow step — the agent's reply IS the work.
		// A clean device exit therefore completes the run rather than failing it,
		// and must not mint a window.
		it("completes an event-turn Automation on a clean device exit", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "event",
				deviceWorkerId: "77777777-7777-7777-7777-777777777777",
				agentKind: "claude-code",
			});
			const workerId = "mac-device-turn-test";
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId},
            approved_input = jsonb_set(
              COALESCE(approved_input, '{}'::jsonb),
              '{trigger_execution}', '"turn"'::jsonb
            )
        WHERE id = ${queued.runId}
      `;
			await sql`
        UPDATE automations
        SET consecutive_scheduled_failures = 3
        WHERE id = ${automationId}
      `;

			// Token-auth workers are trusted at the HTTP authorization layer, so the
			// terminal SQL transition itself must still enforce the run claim.
			const wrongWorker = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: "different-device",
						output: "late reply from a worker that lost the claim",
						duration_ms: 30,
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			expect(wrongWorker.status).toBe(200);
			expect(
				(await wrongWorker.json()) as {
					status: string;
					idempotent?: boolean;
				}
			).toMatchObject({ status: "running", idempotent: true });
			const [afterWrongWorker] = await sql`
        SELECT status, claimed_by FROM runs WHERE id = ${queued.runId}
      `;
			expect(String(afterWrongWorker.status)).toBe("running");
			expect(String(afterWrongWorker.claimed_by)).toBe(workerId);

			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "replied in the thread",
						duration_ms: 40,
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			expect(response.status).toBe(200);
			const json = (await response.json()) as {
				status: string;
				reason_code?: string;
				run_id?: number | null;
			};
			expect(json.status).toBe("completed");
			expect(json.reason_code).toBe("event_turn");
			expect(json.run_id).toBe(queued.runId);

			const [run] = await sql`
        SELECT status, action_output, exit_reason, model_used,
               run_metadata->>'execution_time_ms' AS execution_time_ms
        FROM runs WHERE id = ${queued.runId}
      `;
			expect(String(run.status)).toBe("completed");
			expect(run.action_output).toBeNull();
			expect(String(run.exit_reason)).toBe("ok");
			expect(String(run.model_used)).toBe("device-cli:claude-code");
			expect(Number(run.execution_time_ms)).toBe(40);
			const [automation] = await sql`
        SELECT consecutive_scheduled_failures
        FROM automations WHERE id = ${automationId}
      `;
			expect(Number(automation.consecutive_scheduled_failures)).toBe(3);


			// A duplicate report is a no-op ack, not a second completion.
			const dupe = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "replied in the thread",
						duration_ms: 40,
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			expect(dupe.status).toBe(200);
			const dupeJson = (await dupe.json()) as {
				status: string;
				idempotent?: boolean;
			};
			expect(dupeJson.status).toBe("completed");
			expect(dupeJson.idempotent).toBe(true);
		});

		it("complete-automation endpoint parks a failed run until provider quota resets", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);

			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "11111111-1111-1111-1111-111111111111",
				agentKind: "claude-code",
			});

			const workerId = "mac-device-cli-fail";
			await sql`
        UPDATE runs
        SET status = 'running',
            claimed_at = NOW(),
            claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

			const resetAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
			const providerReset = resetAt
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d{3}Z$/, "");
			const error = `429 Limit Exhausted. Your limit will reset at ${providerReset}`;
			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						error,
						duration_ms: 12,
						exit_reason: "crash",
						exit_code: 127,
					},
				}
			);
			expect(response.status).toBe(200);
			const json = (await response.json()) as { ok: boolean; status: string };
			expect(json.status).toBe("failed");

			const [run] = await sql`
        SELECT status, error_message, action_output, exit_code, exit_reason
        FROM runs
        WHERE id = ${queued.runId}
      `;
			expect(String(run.status)).toBe("failed");
			expect(String(run.error_message)).toBe(error);
			expect(run.action_output).toBeNull();
			expect(Number(run.exit_code)).toBe(127);
			expect(String(run.exit_reason)).toBe("crash");


			const [automation] = await sql`
        SELECT next_run_at FROM automations WHERE id = ${automationId}
      `;
			expect(new Date(automation.next_run_at as string).getTime()).toBe(
				Math.floor(resetAt.getTime() / 1000) * 1000 + 60_000
			);
		});

		it("complete-automation endpoint refuses non-Automation run types", async () => {
			const sql = getTestDb();
			const { workspace } = await createAutomatedAutomation();

			const [authRun] = await sql`
        INSERT INTO runs (organization_id, run_type, approval_status, status, created_at)
        VALUES (${workspace.org.id}, 'sync', 'auto', 'running', current_timestamp)
        RETURNING id
      `;
			const runId = Number((authRun as { id: unknown }).id);

			const response = await post(
				`/api/workers/me/runs/${runId}/complete-automation`,
				{
					body: { worker_id: "any", output: "", duration_ms: 1 },
				}
			);
			expect(response.status).toBe(409);
			const body = (await response.json()) as { error: string };
			expect(body.error).toMatch(/Automation/i);
		});

		it("complete-automation endpoint returns 404 for an unknown run id", async () => {
			const response = await post(
				"/api/workers/me/runs/999999999/complete-automation",
				{
					body: { worker_id: "any", output: "", duration_ms: 1 },
				}
			);
			expect(response.status).toBe(404);
		});

		// Pi review #1: schedule must advance on every terminal exit report or
		// the scheduler re-fires the automation every tick forever. This run never
		// calls complete_window, so once the finalize_nudges budget is spent the
		// report fails it — next_run_at must still move.
		it("advances automations.next_run_at on a terminal exit report", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);

			const [before] = await sql`
        SELECT next_run_at FROM automations WHERE id = ${automationId}
      `;
			const beforeNextRun = before.next_run_at as Date | string | null;

			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "22222222-2222-2222-2222-222222222222",
				agentKind: "claude-code",
			});

			const workerId = "mac-device-advance-test";
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

			// Default finalize_nudges budget is 1, so the first missing-window report
			// is a device-held resume — non-terminal, and it must NOT advance the
			// cursor. Only the budget-exhausted report below is terminal.
			const resume = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "agent exited without completing",
						duration_ms: 5,
					},
				}
			);
			expect(resume.status).toBe(200);
			expect(((await resume.json()) as { status: string }).status).toBe("resume");
			const [afterResume] = await sql`
        SELECT next_run_at FROM automations WHERE id = ${automationId}
      `;
			expect(new Date(afterResume.next_run_at as string).getTime()).toBe(
				beforeNextRun ? new Date(beforeNextRun).getTime() : 0
			);

			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: {
						worker_id: workerId,
						output: "agent exited without completing",
						duration_ms: 5,
					},
				}
			);
			expect(response.status).toBe(200);

			const [after] = await sql`
        SELECT next_run_at FROM automations WHERE id = ${automationId}
      `;
			const afterNextRun = after.next_run_at as Date | string | null;
			expect(afterNextRun).not.toBeNull();
			// The cron is `0 9 * * *` (daily 9am); the new tick must be strictly in
			// the future relative to the pre-completion value (which was forced
			// 10min in the past by createAutomatedAutomation).
			const beforeMs = beforeNextRun ? new Date(beforeNextRun).getTime() : 0;
			const afterMs = new Date(afterNextRun as string | Date).getTime();
			expect(afterMs).toBeGreaterThan(beforeMs);
			// And strictly in the future relative to "now".
			expect(afterMs).toBeGreaterThan(Date.now() - 1000);
		});

		// A second concurrent completion must be idempotent and reflect the winner.
		// Duplicate exit reports on a FAILED run must be idempotent: the second
		// report acks without re-failing or double-advancing the schedule
		// (failRun's RETURNING guard).
		it("treats a duplicate exit report as idempotent (no double schedule advance)", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);

			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "33333333-3333-3333-3333-333333333333",
				agentKind: "claude-code",
			});

			const workerId = "mac-device-idem-test";
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
        WHERE id = ${queued.runId}
      `;

			// Drain the finalize_nudges budget (default 1) so the next report is
			// terminal: the first missing-window exit is a device-held resume.
			const resume = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: { worker_id: workerId, output: "resume exit", duration_ms: 10 },
				}
			);
			expect(resume.status).toBe(200);
			expect(((await resume.json()) as { status: string }).status).toBe("resume");

			// First report past the budget fails the run (no complete_window happened).
			const first = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: { worker_id: workerId, output: "first exit", duration_ms: 11 },
				}
			);
			expect(first.status).toBe(200);
			expect(((await first.json()) as { status: string }).status).toBe(
				"failed"
			);

			const [afterFirst] =
				await sql`
          SELECT next_run_at, consecutive_scheduled_failures
          FROM automations WHERE id = ${automationId}
        `;
			const advancedOnce = new Date(afterFirst.next_run_at as string).getTime();
			expect(Number(afterFirst.consecutive_scheduled_failures)).toBe(1);

			// Second report acks the terminal state; no extra side effects.
			const second = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					body: { worker_id: workerId, output: "second exit", duration_ms: 12 },
				}
			);
			expect(second.status).toBe(200);
			const secondJson = (await second.json()) as {
				status: string;
				idempotent?: boolean;
			};
			expect(secondJson.status).toBe("failed");
			expect(secondJson.idempotent).toBe(true);

			const [afterSecond] =
				await sql`
          SELECT next_run_at, consecutive_scheduled_failures
          FROM automations WHERE id = ${automationId}
        `;
			expect(new Date(afterSecond.next_run_at as string).getTime()).toBe(
				advancedOnce
			);
			expect(Number(afterSecond.consecutive_scheduled_failures)).toBe(1);

		});

		// Device spoof: a same-user token bound to worker A cannot complete a run
		// pinned to worker B by lying in body.worker_id. A check keyed only on
		// `(user_id, body.worker_id)` would let a same-user attacker satisfy it
		// by registering worker B and POSTing worker B's id; the bound workerId
		// off the PAT row is what anchors it.
		it("rejects device spoof — token bound to worker A cannot complete worker B run", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();

			// Two registered device workers under the SAME user.
			const ownerUserId = workspace.users.owner.id;
			const [deviceA] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES (${ownerUserId}, 'worker-A', 'macos', ${sql.json({})}, 'Mac A')
        RETURNING id
      `;
			const [deviceB] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES (${ownerUserId}, 'worker-B', 'macos', ${sql.json({})}, 'Mac B')
        RETURNING id
      `;
			const deviceBId = String((deviceB as { id: unknown }).id);
			// deviceA.id is referenced via the bound PAT — no further use here.
			void deviceA;

			// Token bound to worker A.
			const { token: patForA } = await createWorkerPat(
				ownerUserId,
				workspace.org.id,
				"worker-A"
			);

			// Automation run pinned to worker B (via approved_input.device_worker_id).
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: deviceBId,
				agentKind: "claude-code",
			});
			// Claim the run as worker B so `authorizeRunForWorker` passes its
			// claimed_by check when the body posts worker_id=worker-B. The new
			// bound-workerId check (Fix A) is what should fire instead.
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = 'worker-B'
        WHERE id = ${queued.runId}
      `;

			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					token: patForA,
					body: { worker_id: "worker-B", output: "spoofed", duration_ms: 1 },
				}
			);
			expect(response.status).toBe(403);
			const body = (await response.json()) as { error: string };
			expect(body.error).toMatch(/worker_id_mismatch|Forbidden/);

			// Run must still be 'running' — nothing was completed.
			const [run] = await sql`
        SELECT status, action_output FROM runs WHERE id = ${queued.runId}
      `;
			expect(String(run.status)).toBe("running");
			expect(run.action_output).toBeNull();
		});

		// The device gate does not depend on the token carrying a worker
		// binding: `mcpAuthInfo.workerId` is read off the PAT row and nowhere
		// else, so every OAuth access token — and any mcp:write/mcp:admin PAT
		// the worker middleware admits — reaches this handler unbound. Such a
		// caller has no bound id to compare `body.worker_id` against, so the
		// device-ownership check is the only thing standing between it and
		// another of its own devices' pinned runs. These two pin that arm:
		// an unowned pin is rejected, an owned one still completes.
		it("rejects an unbound token completing a run pinned to another of the user's devices", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();

			const ownerUserId = workspace.users.owner.id;
			await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES (${ownerUserId}, 'unbound-worker-A', 'macos', ${sql.json({})}, 'Mac A')
      `;
			const [deviceB] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES (${ownerUserId}, 'unbound-worker-B', 'macos', ${sql.json({})}, 'Mac B')
        RETURNING id
      `;
			const deviceBId = String((deviceB as { id: unknown }).id);

			// No worker binding on the token — the OAuth/mcp:write shape.
			const { token: unboundPat } = await createWorkerPat(
				ownerUserId,
				workspace.org.id,
				null
			);

			const { windowStart, windowEnd } = await computePendingWindow(
				dbClient,
				automationId
			);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: deviceBId,
				agentKind: "claude-code",
			});
			// Claimed by worker A, so the idempotent claimed_by short-circuit
			// above lets the request reach the device check.
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = 'unbound-worker-A'
        WHERE id = ${queued.runId}
      `;

			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					token: unboundPat,
					body: {
						worker_id: "unbound-worker-A",
						output: "spoofed",
						duration_ms: 1,
					},
				}
			);
			expect(response.status).toBe(403);
			expect(((await response.json()) as { error: string }).error).toMatch(
				/Forbidden/
			);

			const [run] = await sql`
        SELECT status, action_output FROM runs WHERE id = ${queued.runId}
      `;
			expect(String(run.status)).toBe("running");
			expect(run.action_output).toBeNull();
		});

		it("admits an unbound token completing a run pinned to its own device", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();

			const ownerUserId = workspace.users.owner.id;
			const [device] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
        VALUES (${ownerUserId}, 'unbound-worker-own', 'macos', ${sql.json({})}, 'My Mac')
        RETURNING id
      `;
			const deviceId = String((device as { id: unknown }).id);

			const { token: unboundPat } = await createWorkerPat(
				ownerUserId,
				workspace.org.id,
				null
			);

			const { windowStart, windowEnd } = await computePendingWindow(
				dbClient,
				automationId
			);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: deviceId,
				agentKind: "claude-code",
			});
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = 'unbound-worker-own'
        WHERE id = ${queued.runId}
      `;

			const response = await post(
				`/api/workers/me/runs/${queued.runId}/complete-automation`,
				{
					token: unboundPat,
					body: {
						worker_id: "unbound-worker-own",
						output: "exited cleanly",
						duration_ms: 5,
						exit_code: 0,
						exit_reason: "ok",
					},
				}
			);
			// Past the gate: the exit report is processed normally (no
			// complete_window call, so the finalize nudge asks for a resume).
			expect(response.status).toBe(200);
			expect(((await response.json()) as { status: string }).status).toBe(
				"resume"
			);
		});
	});

	// Regression: an active automation run carrying a `dispatched_message_id` must
	// not crash reconciliation. The dispatched-id containment query bound the JS
	// array straight into `= ANY(${ids})`. The production pool (db/client.ts) runs
	// with `fetch_types: false`, so postgres.js can't infer the array element type
	// and ships the lone element as a scalar — PG then throws
	// `malformed array literal: "<uuid>"`. Because `automation` (every
	// tick) AND `check-stalled-executions` both call reconcileAutomationRuns, a single
	// such run wedged BOTH jobs — automations stopped firing in prod for 12 days (run
	// 146501 stuck `running` since 2026-05-13, which also blocked the reaper that
	// would have cleared it). Fix: bind via pgTextArray(...)::text[], the same
	// explicit-literal idiom every other ANY() in this file already uses.
	//
	// NOTE: this MUST exercise getDb() (the prod pool with fetch_types:false), not
	// the test-harness client — the latter fetches types and silently masks the
	// bug. Both clients point at the same DATABASE_URL test database here.
	describe("headless terminal delivery resolves automation runs on first claim (no SSE owner)", () => {
		// Regression for the owner-gate false-negative: automation dispatch never
		// opens an SSE connection on any pod, so terminal thread_response rows
		// used to throw "not owned by this gateway instance" on EVERY claim,
		// exhaust 30 retries, dead-letter, and skip resolveAutomationRunsByMessageIds
		// entirely — completions deferred to reconcile, failures to the 2h sweep.
		// These contracts drive the REAL consumer + ApiResponseRenderer against
		// the test DB with hasActiveConnection=false everywhere.
		async function makeRunningAutomationRun(messageId: string) {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
			});
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(),
            claimed_by = ${`lobu:${agent.agentId}`},
            dispatched_message_id = ${messageId}
        WHERE id = ${queued.runId}
      `;
			return {
				sql,
				workspace,
				automationId,
				runId: queued.runId,
				windowStart,
				windowEnd,
			};
		}

		function makeHeadlessConsumer() {
			const renderer = new ApiResponseRenderer({
				broadcast: () => undefined,
			} as never);
			const platformRegistry = {
				get: () => ({ getResponseRenderer: () => renderer }),
			};
			const sseManager = {
				broadcast: () => undefined,
				// No pod anywhere holds an SSE connection for a headless session.
				hasActiveConnection: () => false,
			};
			const queueStub = {
				start: async () => undefined,
				stop: async () => undefined,
				createQueue: async () => undefined,
				work: async () => undefined,
			};
			return new UnifiedThreadResponseConsumer(
				queueStub as never,
				platformRegistry as never,
				sseManager as never
			);
		}

		// Worker terminal rows carry teamId "api" (no platform field) and echo the
		// dispatch-time platformMetadata.source stamped by routes/public/agent.ts
		// from the session intent.
		function terminalPayload(messageId: string, runId: number, error?: string) {
			return {
				messageId,
				channelId: `api_automation_${runId}`,
				conversationId: `api_automation_${runId}`,
				userId: `automation-${runId}`,
				teamId: "api",
				timestamp: Date.now(),
				...(error ? { error } : { processedMessageIds: [messageId] }),
				platformMetadata: { source: "automation-run" },
			};
		}

		it("re-dispatches for a finalize nudge when the reply produced no window (first miss)", async () => {
			// Soft miss: the agent replied but skipped complete_window. Instead of
			// failing closed on the first miss, the run is re-dispatched (pending)
			// for one more bounded attempt — finalize_nudge_count records it.
			const messageId = randomUUID();
			const { sql, runId } = await makeRunningAutomationRun(messageId);

			await makeHeadlessConsumer().handleThreadResponse({
				id: "job-headless-1",
				data: terminalPayload(messageId, runId),
			} as never);

			const [run] = await sql`
        SELECT status, error_message, approved_input FROM runs WHERE id = ${runId}
      `;
			expect(String(run.status)).toBe("pending");
			expect(run.error_message).toBeNull();
			expect(
				Number(
					(run.approved_input as { finalize_nudge_count?: unknown })
						.finalize_nudge_count
				)
			).toBe(1);
		});

		it("fails the run when the finalize-nudge budget is exhausted (fail-closed guard)", async () => {
			const messageId = randomUUID();
			const { sql, runId } = await makeRunningAutomationRun(messageId);
			// Pre-exhaust the budget so the miss is terminal regardless of the
			// configured nudge count.
			await sql`
        UPDATE runs
        SET approved_input = jsonb_set(
          COALESCE(approved_input, '{}'::jsonb),
          '{finalize_nudge_count}',
          '999'::jsonb
        )
        WHERE id = ${runId}
      `;

			await makeHeadlessConsumer().handleThreadResponse({
				id: "job-headless-1b",
				data: terminalPayload(messageId, runId),
			} as never);

			const [run] =
				await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
			expect(String(run.status)).toBe("failed");
			expect(String(run.error_message)).toContain("completeWindow");
		});

		it("respects a per-automation finalize_nudges=0 override (fails immediately, no re-dispatch)", async () => {
			// The per-automation budget (execution_config.finalize_nudges) overrides the
			// global default. 0 = no nudge → the first miss fails immediately, the
			// opposite of the default semantics, proving the override is read.
			const messageId = randomUUID();
			const { sql, runId, automationId } = await makeRunningAutomationRun(messageId);
			await sql`
        UPDATE automations
        SET execution_config = '{"finalize_nudges": 0}'::jsonb
        WHERE id = ${automationId}
      `;

			await makeHeadlessConsumer().handleThreadResponse({
				id: "job-headless-nudge0",
				data: terminalPayload(messageId, runId),
			} as never);

			const [run] = await sql`
        SELECT status, error_message FROM runs WHERE id = ${runId}
      `;
			expect(String(run.status)).toBe("failed");
			expect(String(run.error_message)).toContain("completeWindow");
		});

		it("fails the run immediately on a worker error row (was: 2h stale sweep)", async () => {
			const messageId = randomUUID();
			const { sql, runId } = await makeRunningAutomationRun(messageId);

			await makeHeadlessConsumer().handleThreadResponse({
				id: "job-headless-3",
				data: terminalPayload(messageId, runId, "worker exited 1"),
			} as never);

			const [run] =
				await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
			expect(String(run.status)).toBe("failed");
			expect(String(run.error_message)).toBe("worker exited 1");
		});
	});

	it("reconciles without crashing when an active run carries a dispatched_message_id", async () => {
		const { sql, dbClient, workspace, automationId, agent } =
			await createAutomatedAutomation();
		const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
		const queued = await createAutomationRun({
			organizationId: workspace.org.id,
			automationId,
			agentId: agent.agentId,
			windowStart: windowStart.toISOString(),
			windowEnd: windowEnd.toISOString(),
			dispatchSource: "scheduled",
		});

		// Move the run to an active state with a dispatched_message_id and no
		// result output — mirrors prod's stuck run 146501 exactly, so the
		// first reconcile query is a no-op and execution reaches the buggy
		// dispatched-id containment query.
		await sql`
      UPDATE runs
      SET status = 'running',
          claimed_at = NOW(),
          claimed_by = ${`lobu:${agent.agentId}`},
          dispatched_message_id = 'f7623d32-b589-4085-9504-edbf30925961'
      WHERE id = ${queued.runId}
    `;

		// Pre-fix this rejects with `malformed array literal`; post-fix it resolves.
		const result = await reconcileAutomationRuns(getDb());
		expect(result.reconciled).toBe(0);
	});

	describe("Automation scheduler tick orchestration", () => {
		it("recovers an orphaned event-delivery claim for durable retry", async () => {
			const { sql, automationId } = await createAutomatedAutomation();
			const materialized = await materializeDueAutomationRuns({} as Env);
			expect(materialized.runsCreated).toBe(1);

			const [claimed] = await sql<{ id: number }>`
				UPDATE runs
				SET status = 'claimed',
					claimed_by = 'lobu-dispatcher',
					claimed_at = NOW() - INTERVAL '10 minutes',
					approved_input = approved_input || ${sql.json({
						dispatch_source: "event",
						device_worker_id: "11111111-1111-1111-1111-111111111111",
					})}
				WHERE automation_id = ${automationId}
				  AND run_type = 'automation'
				RETURNING id
			`;
			expect(claimed).toBeDefined();

			const result = await runAutomationTick({} as Env);
			expect(result.reset).toBe(1);

			const [recovered] = await sql`
				SELECT status, claimed_by, claimed_at
				FROM runs
				WHERE id = ${claimed.id}
			`;
			expect(recovered.status).toBe("pending");
			expect(recovered.claimed_by).toBeNull();
			expect(recovered.claimed_at).toBeNull();
		});

		it("recovers an orphaned eval claim, which nothing else would clear", async () => {
			const { sql, automationId } = await createAutomatedAutomation();
			await materializeDueAutomationRuns({} as Env);

			// Complete the materialized run so it is a valid eval source, then
			// replay it. The eval inherits `dispatch_source` verbatim.
			const [source] = await sql<{ id: number }>`
				UPDATE runs SET status = 'completed', completed_at = NOW()
				WHERE automation_id = ${automationId} AND run_type = ${AUTOMATION_RUN_TYPE}
				RETURNING id
			`;
			const evalRun = await createEvalRun(
				{ sourceRunId: source.id, caseKey: "orphan" },
				sql as unknown as DbClient
			);
			expect(evalRun?.created).toBe(true);

			// Strand it exactly as a dispatcher crash between claim and POST would.
			await sql`
				UPDATE runs
				SET status = 'claimed',
					claimed_by = 'lobu-dispatcher',
					claimed_at = NOW() - INTERVAL '10 minutes'
				WHERE id = ${evalRun?.runId ?? 0}
			`;

			const result = await runAutomationTick({} as Env);
			// The reaper's whole contract: the stranded eval is released. Scoped
			// to `automation` alone this is 0 and the eval lane stays wedged.
			expect(result.reset).toBe(1);

			// Deliberately NOT asserting a final status. The same tick's dispatch
			// phase adopts the freshly-pending eval and fails it here on
			// `isLobuGatewayRunning()`, which is false under vitest — an
			// environment limit, not a lane one. That it gets that far is the
			// point: the dispatcher does claim `automation_eval` rows.
			const [recoveredEval] = await sql<{ run_type: string }>`
				SELECT run_type FROM runs WHERE id = ${evalRun?.runId ?? 0}
			`;
			// Recovery must never relabel an eval into the live lane.
			expect(recoveredEval.run_type).toBe(AUTOMATION_EVAL_RUN_TYPE);
		});

		it("a failing eval never moves the live Automation's schedule", async () => {
			const { sql, automationId } = await createAutomatedAutomation();
			await materializeDueAutomationRuns({} as Env);

			const [source] = await sql<{ id: number }>`
				UPDATE runs SET status = 'completed', completed_at = NOW()
				WHERE automation_id = ${automationId} AND run_type = ${AUTOMATION_RUN_TYPE}
				RETURNING id
			`;
			const evalRun = await createEvalRun(
				{ sourceRunId: source.id, caseKey: "schedule" },
				sql as unknown as DbClient
			);

			const [before] = await sql<{ next_run_at: string | null }>`
				SELECT next_run_at FROM automations WHERE id = ${automationId}
			`;

			// Drive the eval through the dispatch lane. Under vitest the embedded
			// gateway is down, so it takes a `failAutomationRun` path — the same one
			// a session-create or message-POST failure takes in prod.
			await dispatchPendingAutomationRuns({} as Env);

			const [evalRow] = await sql<{ status: string }>`
				SELECT status FROM runs WHERE id = ${evalRun?.runId ?? 0}
			`;
			expect(evalRow.status).toBe("failed");

			// The cron cursor of the Automation it was only replaying is untouched,
			// and specifically not parked at NULL.
			const [after] = await sql<{ next_run_at: string | null }>`
				SELECT next_run_at FROM automations WHERE id = ${automationId}
			`;
			expect(after.next_run_at).toEqual(before.next_run_at);
			expect(after.next_run_at).not.toBeNull();
		});

		it("times out an eval that crashed mid-turn, leaving the live run alone", async () => {
			const { sql, automationId } = await createAutomatedAutomation();
			await materializeDueAutomationRuns({} as Env);

			const [source] = await sql<{ id: number }>`
				UPDATE runs SET status = 'completed', completed_at = NOW()
				WHERE automation_id = ${automationId} AND run_type = ${AUTOMATION_RUN_TYPE}
				RETURNING id
			`;
			const evalRun = await createEvalRun(
				{ sourceRunId: source.id, caseKey: "stale" },
				sql as unknown as DbClient
			);

			// Running, claimed long ago, and never heartbeated past the claim —
			// the coarse backstop shape for a crashed executor.
			await sql`
				UPDATE runs
				SET status = 'running',
					claimed_at = NOW() - INTERVAL '5 hours',
					last_heartbeat_at = NOW() - INTERVAL '5 hours'
				WHERE id = ${evalRun?.runId ?? 0}
			`;

			// A live run for the SAME Automation, freshly claimed — must survive.
			const live = await createAutomationRun({
				organizationId: (
					await sql<{ organization_id: string }>`
						SELECT organization_id FROM runs WHERE id = ${source.id}
					`
				)[0].organization_id,
				automationId,
				agentId: undefined,
				windowStart: new Date(Date.now() - 3600_000).toISOString(),
				windowEnd: new Date().toISOString(),
				dispatchSource: "manual",
			});
			await sql`
				UPDATE runs SET status = 'running', claimed_at = NOW(),
					last_heartbeat_at = NOW()
				WHERE id = ${live.runId}
			`;

			const swept = await sweepStaleAutomationRuns(getDb());
			expect(swept.timedOut).toBeGreaterThanOrEqual(1);

			const [stale] = await sql<{ status: string }>`
				SELECT status FROM runs WHERE id = ${evalRun?.runId ?? 0}
			`;
			expect(stale.status).toBe("timeout");

			const [survivor] = await sql<{ status: string }>`
				SELECT status FROM runs WHERE id = ${live.runId}
			`;
			expect(survivor.status).toBe("running");
		});

		// End-to-end regression for the 12-day outage: a stuck active run carrying a
		// dispatched_message_id used to make reconcile throw `malformed array literal`,
		// which (pre phase-isolation) aborted materialize + dispatch every tick. The
		// tick must now (a) not surface a reconcile error and (b) still materialize a
		// separate due automation.
		it("survives a wedging in-flight run and still materializes other due automations", async () => {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();

			// Automation A: a stuck active run with a dispatched_message_id and no window —
			// the exact shape of prod run 146501 that wedged reconcile.
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const stuck = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
			});
			await sql`
        UPDATE runs
        SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${agent.agentId}`},
            dispatched_message_id = 'f7623d32-b589-4085-9504-edbf30925961'
        WHERE id = ${stuck.runId}
      `;

			// Automation B: due, no active run, valid agent → must materialize this tick.
			const entityB = await createTestEntity({
				name: "Tick Entity B",
				organization_id: workspace.org.id,
				created_by: workspace.users.owner.id,
			});
			const automationB = (await workspace.owner.automations.create({
				entity_id: entityB.id,
				slug: "tick-automation-b",
				name: "Tick Automation B",
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
			const automationBId = Number(automationB.automation_id);
			await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${automationBId}`;

			const result = await runAutomationTick({} as Env);

			// No phase threw — the bind fix means reconcile handles the dispatched-id
			// array, and isolation means a phase failure wouldn't starve the rest.
			expect(result.errors).toEqual([]);
			// Automation B materialized despite automation A's stuck run.
			expect(result.runsCreated).toBeGreaterThanOrEqual(1);
			const [runB] = await sql`
        SELECT status FROM runs
        WHERE automation_id = ${automationBId} AND run_type = 'automation'
      `;
			expect(runB).toBeDefined();
		});

		// Item 1: an automation whose assigned agent no longer exists (and isn't device
		// pinned) must NOT be scheduled — no doomed run per tick — and be counted as
		// unrunnable for visibility. Mirrors prod orgs lobu-crm / lobu-team.
		it("does not schedule an automation whose agent does not exist; counts it unrunnable", async () => {
			const { sql, automationId } = await createAutomatedAutomation();

			// Point the automation at a non-existent agent, no device pin, due now.
			await sql`
        UPDATE automations
        SET managed_agent_id = 'ghost-agent-deleted', device_worker_id = NULL,
            next_run_at = NOW() - INTERVAL '10 minutes'
        WHERE id = ${automationId}
      `;

			const result = await materializeDueAutomationRuns({} as Env);

			expect(result.runsCreated).toBe(0);
			expect(result.unrunnable).toBeGreaterThanOrEqual(1);
			const runs = await sql`
        SELECT id FROM runs WHERE automation_id = ${automationId} AND run_type = 'automation'
      `;
			expect(runs).toHaveLength(0);
		});
	});

	describe("sweepStaleAutomationRuns liveness reaping", () => {
		it("finalizes a stale scheduled pending run and advances its automation schedule", async () => {
			const { sql, automationId } = await createAutomatedAutomation();
			const materialized = await materializeDueAutomationRuns({} as Env);
			expect(materialized.runsCreated).toBe(1);

			const [queued] = await sql`
        UPDATE runs
        SET created_at = NOW() - INTERVAL '3 hours'
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'pending'
        RETURNING id
      `;
			expect(queued).toBeDefined();

			const [sweepA, sweepB] = await Promise.all([
				sweepStaleAutomationRuns(sql),
				sweepStaleAutomationRuns(sql),
			]);
			expect(sweepA.timedOut + sweepB.timedOut).toBe(1);

			const [run] = await sql`
        SELECT status, completed_at, error_message
        FROM runs
        WHERE id = ${Number(queued.id)}
      `;
			expect(String(run.status)).toBe("timeout");
			expect(run.completed_at).not.toBeNull();
			expect(String(run.error_message ?? "")).toMatch(/pending.*2 hours/i);

			const [automation] =
				await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
			expect(new Date(automation.next_run_at as string).getTime()).toBeGreaterThan(
				Date.now()
			);

			const retry = await materializeDueAutomationRuns({} as Env);
			expect(retry.runsCreated).toBe(0);
		});

		it("leaves a fresh scheduled pending run available for dispatch", async () => {
			const { sql, automationId } = await createAutomatedAutomation();
			const materialized = await materializeDueAutomationRuns({} as Env);
			expect(materialized.runsCreated).toBe(1);

			const { timedOut } = await sweepStaleAutomationRuns(sql);
			expect(timedOut).toBe(0);
			const [run] = await sql`
        SELECT status FROM runs
        WHERE automation_id = ${automationId} AND run_type = 'automation'
      `;
			expect(String(run.status)).toBe("pending");
		});

		it("expires a stale manually triggered pending run without advancing its schedule", async () => {
			const { sql, automationId } = await createAutomatedAutomation();
			await materializeDueAutomationRuns({} as Env);
			await sql`
        UPDATE runs
        SET created_at = NOW() - INTERVAL '3 hours',
            approved_input = jsonb_set(
              approved_input,
              '{dispatch_source}',
              '"manual"'::jsonb
            )
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'pending'
      `;

			const { timedOut } = await sweepStaleAutomationRuns(sql);
			expect(timedOut).toBe(1);
			const [run] = await sql`
        SELECT status FROM runs
        WHERE automation_id = ${automationId} AND run_type = 'automation'
      `;
			expect(String(run.status)).toBe("timeout");
			const [automation] =
				await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
			expect(new Date(automation.next_run_at as string).getTime()).toBeLessThan(
				Date.now()
			);
		});

		it("finalizes a stale pending event run without advancing the schedule", async () => {
			// Device-pinned event deliveries that never get claimed (device offline)
			// must not sit pending forever and block the Automation's schedule path.
			// Timeout frees the slot; schedule projection is owned by scheduled runs.
			const { sql, automationId } = await createAutomatedAutomation();
			await materializeDueAutomationRuns({} as Env);
			const [before] =
				await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
			const nextBefore = new Date(before.next_run_at as string).getTime();

			await sql`
        UPDATE runs
        SET created_at = NOW() - INTERVAL '3 hours',
            approved_input = jsonb_set(
              approved_input,
              '{dispatch_source}',
              '"event"'::jsonb
            )
        WHERE automation_id = ${automationId}
          AND run_type = 'automation'
          AND status = 'pending'
      `;

			const { timedOut } = await sweepStaleAutomationRuns(sql);
			expect(timedOut).toBe(1);
			const [run] = await sql`
        SELECT status, error_message FROM runs
        WHERE automation_id = ${automationId} AND run_type = 'automation'
      `;
			expect(String(run.status)).toBe("timeout");
			expect(String(run.error_message ?? "")).toMatch(/pending/i);

			const [after] =
				await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
			// Event timeout must not advance schedule — leave next_run_at as it was
			// (still overdue from materialize, not pushed into the future).
			expect(new Date(after.next_run_at as string).getTime()).toBe(nextBefore);
		});

		// Seed a `running` automation run with controlled claim/heartbeat ages.
		// Omitting `heartbeatAgo` mirrors a client that never heartbeats — the
		// claim sets last_heartbeat_at == claimed_at, so the row must fall to the
		// coarse 2h path, never the fast heartbeat path.
		async function seedRunningAutomationRun(opts: {
			claimedAgo: string;
			heartbeatAgo?: string;
		}) {
			const { sql, dbClient, workspace, automationId, agent } =
				await createAutomatedAutomation();
			const { windowStart, windowEnd } = await computePendingWindow(dbClient, automationId);
			const queued = await createAutomationRun({
				organizationId: workspace.org.id,
				automationId,
				agentId: agent.agentId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				dispatchSource: "scheduled",
				deviceWorkerId: "11111111-1111-1111-1111-111111111111",
				agentKind: "claude-code",
			});
			const heartbeatAgo = opts.heartbeatAgo ?? opts.claimedAgo;
			await sql`
        UPDATE runs
        SET status = 'running',
            claimed_by = 'mac-sweep-test',
            claimed_at = NOW() - ${opts.claimedAgo}::interval,
            last_heartbeat_at = NOW() - ${heartbeatAgo}::interval
        WHERE id = ${queued.runId}
      `;
			return { sql, runId: queued.runId };
		}

		it("reaps a heartbeating run that went silent past the heartbeat window", async () => {
			// Beat once after claim (10m ago > claim 1h ago), then silent >3min.
			const { sql, runId } = await seedRunningAutomationRun({
				claimedAgo: "1 hour",
				heartbeatAgo: "10 minutes",
			});
			const { timedOut } = await sweepStaleAutomationRuns(sql);
			expect(timedOut).toBeGreaterThanOrEqual(1);
			const [row] =
				await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
			expect(String(row.status)).toBe("timeout");
			expect(String(row.error_message ?? "")).toMatch(/heartbeat went silent/i);
		});

		it("leaves a run with a fresh heartbeat running", async () => {
			const { sql, runId } = await seedRunningAutomationRun({
				claimedAgo: "1 hour",
				heartbeatAgo: "30 seconds",
			});
			await sweepStaleAutomationRuns(sql);
			const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
			expect(String(row.status)).toBe("running");
		});

		it("does not coarse-reap a live heartbeating run older than the 2h TTL", async () => {
			// Claimed 3h ago but heartbeating fresh (30s) → still alive. The coarse
			// 2h backstop must NOT touch it; only the (un-lapsed) fast path governs
			// a heartbeating run. Guards against killing a legitimately long turn.
			const { sql, runId } = await seedRunningAutomationRun({
				claimedAgo: "3 hours",
				heartbeatAgo: "30 seconds",
			});
			await sweepStaleAutomationRuns(sql);
			const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
			expect(String(row.status)).toBe("running");
		});

		it("does not fast-reap a recent run that never heartbeats", async () => {
			// last_heartbeat_at == claimed_at (no beat) + only 30m old → the fast
			// path must NOT fire; it stays running until the 2h coarse backstop.
			// Backward-compat guard for clients that do not heartbeat.
			const { sql, runId } = await seedRunningAutomationRun({
				claimedAgo: "30 minutes",
			});
			await sweepStaleAutomationRuns(sql);
			const [row] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
			expect(String(row.status)).toBe("running");
		});

		it("reaps a non-heartbeating run via the coarse 2h backstop", async () => {
			const { sql, runId } = await seedRunningAutomationRun({
				claimedAgo: "3 hours",
			});
			const { timedOut } = await sweepStaleAutomationRuns(sql);
			expect(timedOut).toBeGreaterThanOrEqual(1);
			const [row] =
				await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
			expect(String(row.status)).toBe("timeout");
			expect(String(row.error_message ?? "")).toMatch(/2 hours/i);
		});
	});
});


describe("automation schedule advancement", () => {
	// Manual triggers complete through the same advanceAutomationSchedule as
	// scheduled runs, but with next_run_at already sitting on the upcoming cron
	// tick. Advancing from max(now, next_run_at) compounded that: every manual
	// run's completion pushed the schedule one more tick out, so N manual runs
	// silently skipped N cron slots. The advance must converge on the next tick
	// after now, no matter how many completions land while the schedule is
	// already current.
	it("advanceAutomationSchedule is idempotent when next_run_at is already the upcoming tick", async () => {
		const { sql, dbClient, automationId } = await createAutomatedAutomation();

		const upcomingTick = nextRunAt("0 9 * * *", new Date());
		await sql`
      UPDATE automations SET next_run_at = ${upcomingTick}::timestamptz
      WHERE id = ${automationId}
    `;

		await advanceAutomationSchedule(dbClient, automationId);
		await advanceAutomationSchedule(dbClient, automationId);

		const [after] =
			await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
		expect(new Date(after.next_run_at as string).getTime()).toBe(
			new Date(upcomingTick).getTime()
		);
	});
});
