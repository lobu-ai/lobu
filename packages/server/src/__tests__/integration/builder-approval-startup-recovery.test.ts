/**
 * RunsQueue startup recovery must leave human-approval rows alone.
 *
 * A builder approval (manage_agents / manage_automations / agent_ask) is a
 * `run_type='internal'` row that RunsQueue never claims: it has no
 * `queue_name`, and approve flips it to approved + running under a
 * `gateway-inline-*` lease. Startup recovery reset every claimed/running
 * `internal` row older than the recovery window to `pending` with no owner,
 * without looking at `approval_status`. That produced approved + pending +
 * unowned, a state that nothing handles: re-approve can neither reconcile it
 * (needs `running`) nor claim it (needs approval `pending`), TTL expiry skips
 * approved rows, and no queue consumer or reaper picks it up. The run was
 * stranded for good, even when its apply had already succeeded and only the
 * completed card was left to write.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RunsQueue } from "../../gateway/infrastructure/queue/runs-queue";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { insertEvent } from "../../utils/insert-event";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { ownerToolContext, seedOwnerContext } from "../setup/test-fixtures";

// Fail ONLY the terminal 'completed' card INSERT, so approve's apply succeeds
// and persists its output while phase 2 rolls back — the state a real card
// write failure (or a crash right after the apply) leaves behind.
const FAIL_COMPLETED_TRIGGER = `
CREATE OR REPLACE FUNCTION test_recovery_fail_completed_card() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'completed' THEN
    RAISE EXCEPTION 'simulated terminal approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_recovery_fail_completed_card_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_recovery_fail_completed_card();
`;
const DROP_FAIL_TRIGGER = `
DROP TRIGGER IF EXISTS test_recovery_fail_completed_card_trg ON events;
DROP FUNCTION IF EXISTS test_recovery_fail_completed_card();
`;

/** A pending agent_ask run + its pending card, the shape `queueAgentAsk` makes. */
async function seedAgentAskRun(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, action_input,
			created_by_user_id, approval_status, status, created_at
		) VALUES (
			${organizationId}, 'internal', 'agent_ask',
			${sql.json({ question: "Ship it?", input_schema: { type: "object" } })},
			${userId}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	await insertEvent({
		entityIds: [],
		organizationId,
		originId: `run_${runId}_pending`,
		title: "Ship it?",
		content: null,
		semanticType: "operation",
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		interactionInputSchema: { type: "object" },
		metadata: { tool: "notify", action_key: "agent_ask", run_id: runId },
		authorName: "agent",
	});
	return runId;
}

/** Run RunsQueue's startup recovery the way a restarted pod does. */
async function restartQueue(): Promise<void> {
	const queue = new RunsQueue();
	await queue.start();
	await queue.stop();
}

describe("RunsQueue startup recovery and builder approvals", () => {
	let orgId: string;
	let humanCtx: ToolContext;
	let userId: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user } = await seedOwnerContext({
			orgName: "Builder Recovery Org",
		});
		orgId = org.id;
		userId = user.id;
		humanCtx = ownerToolContext(orgId, userId);
		humanCtx.baseUrl = "https://gateway.test/lobu";
	});

	afterEach(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
	});

	it("a restart does not strand an approved builder run; re-approve reconciles it", async () => {
		const sql = getTestDb();
		const runId = await seedAgentAskRun(orgId, userId);

		await sql.unsafe(FAIL_COMPLETED_TRIGGER);
		await expect(
			manageOperations(
				{ action: "approve", run_id: runId, input: { decision: "ship it" } },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/terminal approval-event write failure/);
		await sql.unsafe(DROP_FAIL_TRIGGER);

		const [claimed] = await sql<{ claimed_by: string | null }>`
			SELECT claimed_by FROM runs WHERE id = ${runId}
		`;
		expect(claimed.claimed_by).toMatch(/^gateway-inline-/);

		// Older than the 10-minute startup recovery window, then a pod restarts.
		await sql`
			UPDATE runs SET claimed_at = NOW() - INTERVAL '11 minutes'
			WHERE id = ${runId}
		`;
		await restartQueue();

		const [afterRestart] = await sql<{
			status: string;
			approval_status: string;
			claimed_by: string | null;
			action_output: Record<string, unknown> | null;
		}>`
			SELECT status, approval_status, claimed_by, action_output
			FROM runs WHERE id = ${runId}
		`;
		expect(afterRestart.approval_status).toBe("approved");
		expect(afterRestart.status).toBe("running");
		expect(afterRestart.claimed_by).toBe(claimed.claimed_by);
		expect(afterRestart.action_output).toEqual({
			answer: { decision: "ship it" },
		});

		// The existing reconcile path finishes it from the durable output.
		const retried = (await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; error?: string };
		expect(retried.error).toBeUndefined();
		expect(retried.approved).toBe(true);
		const [finalRow] = await sql<{
			status: string;
			action_output: Record<string, unknown> | null;
		}>`SELECT status, action_output FROM runs WHERE id = ${runId}`;
		expect(finalRow.status).toBe("completed");
		expect(finalRow.action_output).toEqual({ answer: { decision: "ship it" } });
		const [card] = await sql<{ interaction_status: string }>`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${runId} AND organization_id = ${orgId}
			  AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(card.interaction_status).toBe("completed");
	});

	it("still resets a stale queue-claimed internal row for a fresh claim", async () => {
		const sql = getTestDb();
		const [row] = await sql<{ id: number }>`
			INSERT INTO runs (
				organization_id, run_type, queue_name, action_input,
				status, claimed_by, claimed_at, created_at
			) VALUES (
				${orgId}, 'internal', 'test-recovery-queue', ${sql.json({})},
				'claimed', 'gateway-crashed-pod', NOW() - INTERVAL '11 minutes', NOW()
			)
			RETURNING id
		`;
		await restartQueue();
		const [recovered] = await sql<{ status: string; claimed_by: string | null }>`
			SELECT status, claimed_by FROM runs WHERE id = ${row.id}
		`;
		expect(recovered.status).toBe("pending");
		expect(recovered.claimed_by).toBeNull();
	});
});
