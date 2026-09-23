/**
 * Connection delete — an APPROVED local_action run that no worker has claimed
 * yet must not execute afterwards.
 *
 * Approval of a `local_action` keeps `status='pending'` so the worker poll can
 * claim it. Deleting the connection expires only `approval_status='pending'`
 * runs, and its run cancel only matched feed-backed runs, so the approved run
 * stayed claimable against a tombstoned connection and a worker still ran the
 * mutation.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";

const CONNECTOR = "demo.delete.approved.action";

async function pollFleet(): Promise<{ run_id?: number; skipped_run_id?: number }> {
	const res = await post("/api/workers/poll", {
		body: { worker_id: "approved-delete-fleet-worker", capabilities: {} },
		token: "test-fleet-token",
		env: { WORKER_API_TOKEN: "test-fleet-token" },
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { run_id?: number; skipped_run_id?: number };
}

describe("connection delete cancels approved-but-unclaimed action runs", () => {
	let orgId: string;
	let ctx: ToolContext;

	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		delete process.env.WORKER_API_TOKEN;
		const seeded = await seedOwnerContext({ orgName: "Approved Delete Org" });
		orgId = seeded.org.id;
		ctx = seeded.ctx;
		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Approved delete connector",
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
	});

	async function queueAndApprove(connectionId: number): Promise<number> {
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

		const approved = (await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			ctx,
		)) as { approved?: boolean; error?: string };
		expect(approved.error).toBeUndefined();
		expect(approved.approved).toBe(true);
		return runId;
	}

	it("terminalizes the approved run and a worker poll never claims it", async () => {
		const sql = getTestDb();
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: ctx.userId ?? undefined,
		});
		const runId = await queueAndApprove(conn.id);
		const [beforeDelete] = await sql`
			SELECT status, approval_status FROM runs WHERE id = ${runId}
		`;
		expect(beforeDelete).toMatchObject({
			status: "pending",
			approval_status: "approved",
		});

		const deleted = (await manageConnections(
			{ action: "delete", connection_id: conn.id },
			{} as Env,
			ctx,
		)) as { deleted?: boolean; error?: string };
		expect(deleted.error).toBeUndefined();
		expect(deleted.deleted).toBe(true);

		const [row] = await sql`
			SELECT status, completed_at, claimed_by FROM runs WHERE id = ${runId}
		`;
		expect(row.status).toBe("cancelled");
		expect(row.completed_at).not.toBeNull();
		expect(row.claimed_by).toBeNull();

		// The approval card must not keep saying "executing" for a run that
		// will never execute.
		const [card] = await sql`
			SELECT interaction_status, metadata FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND run_id = ${runId}
			  AND interaction_type = 'approval'
		`;
		expect(card?.interaction_status).toBe("failed");
		expect(card?.metadata?.run_status).toBe("cancelled");

		const polled = await pollFleet();
		expect(polled.run_id).toBeUndefined();
		expect(polled.skipped_run_id).toBeUndefined();
		const [afterPoll] = await sql`
			SELECT status, claimed_by FROM runs WHERE id = ${runId}
		`;
		expect(afterPoll).toMatchObject({ status: "cancelled", claimed_by: null });
	});

	it("a worker poll never claims a run whose connection another path tombstoned", async () => {
		const sql = getTestDb();
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: ctx.userId ?? undefined,
		});
		const runId = await queueAndApprove(conn.id);
		// A tombstone written outside handleDelete (for example a chat-store
		// removal) does not run the delete's run cancellation.
		await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${conn.id}`;

		const polled = await pollFleet();
		expect(polled.run_id).toBeUndefined();
		expect(polled.skipped_run_id).toBeUndefined();
		const [row] = await sql`
			SELECT status, claimed_by FROM runs WHERE id = ${runId}
		`;
		expect(row).toMatchObject({ status: "pending", claimed_by: null });
	});

	it("cancels a cardless auto transport run without blocking the delete", async () => {
		// Device feed reads and browser dispatch insert pending auto action runs
		// with no operation card; the delete must still succeed and cancel them.
		const sql = getTestDb();
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: ctx.userId ?? undefined,
		});
		const [run] = await sql`
			INSERT INTO runs (
				organization_id, run_type, connection_id, connector_key,
				action_key, approval_status, status, created_at
			) VALUES (
				${orgId}, 'action', ${conn.id}, ${CONNECTOR},
				'needs_approval', 'auto', 'pending', NOW()
			)
			RETURNING id
		`;

		const deleted = (await manageConnections(
			{ action: "delete", connection_id: conn.id },
			{} as Env,
			ctx,
		)) as { deleted?: boolean; error?: string };
		expect(deleted.error).toBeUndefined();
		expect(deleted.deleted).toBe(true);
		const [row] = await sql`SELECT status FROM runs WHERE id = ${run.id}`;
		expect(row.status).toBe("cancelled");
	});

	it("leaves an approved run on another connection claimable", async () => {
		const sql = getTestDb();
		const deletedConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: ctx.userId ?? undefined,
		});
		const keptConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: ctx.userId ?? undefined,
		});
		const keptRunId = await queueAndApprove(keptConn.id);

		const deleted = (await manageConnections(
			{ action: "delete", connection_id: deletedConn.id },
			{} as Env,
			ctx,
		)) as { deleted?: boolean };
		expect(deleted.deleted).toBe(true);

		const [row] = await sql`
			SELECT status, approval_status FROM runs WHERE id = ${keptRunId}
		`;
		expect(row).toMatchObject({ status: "pending", approval_status: "approved" });
		const polled = await pollFleet();
		// A post-claim artifact failure returns skipped_run_id; either field proves
		// the live connection's run passed the claim predicate.
		expect(Number(polled.run_id ?? polled.skipped_run_id)).toBe(keptRunId);
	});
});
