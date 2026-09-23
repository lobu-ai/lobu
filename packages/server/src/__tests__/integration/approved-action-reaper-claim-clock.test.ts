/**
 * Stale-run reaper — an approved local_action run's worker-claim clock starts
 * at APPROVAL, not at queue time.
 *
 * A run awaiting human approval is exempt from the claim timeout, but once the
 * human approves, the reaper judged the now-claimable row on its queue-time
 * `created_at`. Any approval that took longer than the reaper threshold was
 * timed out on the very next sweep, before a worker could poll it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { reapStaleRuns } from "../../scheduled/check-stalled-executions";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR = "demo.reaper.approved.action";
const STALE_THRESHOLD_SECONDS = 60;

describe("stale-run reaper claim clock for approved action runs", () => {
	let orgId: string;
	let ctx: ToolContext;
	let connectionId: number;
	let previousStaleThreshold: string | undefined;

	beforeAll(async () => {
		await initWorkspaceProvider();
		previousStaleThreshold = process.env.RUNS_REAPER_STALE_AFTER_SECONDS;
		process.env.RUNS_REAPER_STALE_AFTER_SECONDS = String(STALE_THRESHOLD_SECONDS);
	});

	afterAll(() => {
		if (previousStaleThreshold === undefined) {
			delete process.env.RUNS_REAPER_STALE_AFTER_SECONDS;
		} else {
			process.env.RUNS_REAPER_STALE_AFTER_SECONDS = previousStaleThreshold;
		}
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		const seeded = await seedOwnerContext({ orgName: "Reaper Approved Org" });
		orgId = seeded.org.id;
		ctx = seeded.ctx;
		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Reaper approved connector",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "none" }] },
		});
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				needs_approval: {
					name: "Needs approval",
					kind: "write",
					requiresApproval: true,
				},
			})}
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR}
		`;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: ctx.userId ?? undefined,
		});
		connectionId = conn.id;
	});

	async function queueApprovalAgedMinutes(minutes: number): Promise<number> {
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "needs_approval",
				input: {},
			},
			{} as Env,
			ctx,
		)) as { status?: string; run_id?: number; error?: string };
		expect(queued.error).toBeUndefined();
		expect(queued.status).toBe("pending_approval");
		const runId = Number(queued.run_id);
		// The human took `minutes` to decide: the run was queued that long ago.
		const sql = getTestDb();
		await sql`
			UPDATE runs
			SET created_at = current_timestamp - (${minutes}::int * interval '1 minute'),
			    run_at = current_timestamp - (${minutes}::int * interval '1 minute')
			WHERE id = ${runId}
		`;
		return runId;
	}

	it("does not time out a run approved just now after a long review", async () => {
		const runId = await queueApprovalAgedMinutes(10);
		const approved = (await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			ctx,
		)) as { approved?: boolean; error?: string };
		expect(approved.error).toBeUndefined();
		expect(approved.approved).toBe(true);

		const result = await reapStaleRuns();
		expect(result.acquired).toBe(true);

		const sql = getTestDb();
		const [row] = await sql`
			SELECT status, approval_status, error_message FROM runs WHERE id = ${runId}
		`;
		expect(row).toMatchObject({
			status: "pending",
			approval_status: "approved",
			error_message: null,
		});
	});

	it("still times out an approved run that no worker claims within the threshold", async () => {
		const runId = await queueApprovalAgedMinutes(10);
		const approved = (await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			ctx,
		)) as { approved?: boolean };
		expect(approved.approved).toBe(true);
		// The approval itself is now older than the threshold.
		const sql = getTestDb();
		await sql`
			UPDATE runs
			SET run_at = current_timestamp - (${STALE_THRESHOLD_SECONDS * 2}::int * interval '1 second')
			WHERE id = ${runId}
		`;

		await reapStaleRuns();

		const [row] = await sql`
			SELECT status FROM runs WHERE id = ${runId}
		`;
		expect(row.status).toBe("timeout");
	});
});
