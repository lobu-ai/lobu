/**
 * An operation that runs under `auto` action mode must leave a trace in the
 * event ledger.
 *
 * Before this suite the `semantic_type='operation'` card was written ONLY on
 * the approval-queued branch, so an organization whose operations all resolve
 * to `auto` had a completely empty operation audit trail: the only path that
 * recorded anything was the one a human had already seen.
 *
 * The contract exercised here:
 *   - a non-queued (inline) run writes its dispatch card in the SAME
 *     transaction as the run row, so a run can never exist without its card;
 *   - the terminal outcome supersedes that card, so the ledger records what
 *     actually happened, not just that something was attempted;
 *   - a failed run records the failure the same way;
 *   - the approval path still writes exactly ONE pending card (no double-write).
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";

const CONNECTOR = "demo.ops.auto.ledger";

type LedgerRow = {
	id: string;
	origin_id: string;
	semantic_type: string;
	interaction_type: string;
	interaction_status: string | null;
	interaction_input: Record<string, unknown> | null;
	interaction_output: Record<string, unknown> | null;
	interaction_error: string | null;
	supersedes_event_id: string | null;
	superseded_by: string | null;
	connection_id: string | null;
	metadata: Record<string, unknown>;
};

async function operationLedger(
	orgId: string,
	runId: number,
): Promise<LedgerRow[]> {
	const sql = getTestDb();
	return (await sql`
		SELECT id, origin_id, semantic_type, interaction_type, interaction_status,
		       interaction_input, interaction_output, interaction_error,
		       supersedes_event_id, superseded_by, connection_id, metadata
		FROM events
		WHERE organization_id = ${orgId}
		  AND run_id = ${runId}
		  AND semantic_type = 'operation'
		ORDER BY id ASC
	`) as unknown as LedgerRow[];
}

describe("operation ledger under auto action mode", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const {
			org,
			user,
			ctx: ownerCtx,
		} = await seedOwnerContext({ orgName: "Auto Ledger Org" });
		ownerCtx.baseUrl = "https://gateway.test/lobu";
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;

		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Auto Ledger",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
		});

		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				echo: {
					name: "Echo",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				},
				needs_approval: {
					name: "Needs approval",
					kind: "write",
					requiresApproval: true,
				},
			})},
			supports_execute = true
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`
				class ConnectorRuntime {
					async sync() { return { items: [] }; }
					async execute(ctx) {
						if (ctx.input.value === 'boom') throw new Error('connector exploded');
						return { success: true, output: { value: ctx.input.value ?? null } };
					}
				}
				module.exports = { ConnectorRuntime };
			`}
			WHERE connector_key = ${CONNECTOR}
		`;

		// Every operation on this connection is `auto`, including one the
		// connector marks `requiresApproval` — the per-connection override wins.
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { echo: "auto", needs_approval: "auto" } },
		});
		connectionId = conn.id;

		const accountId = `acct_${connectionId}_auto_ledger`;
		await sql`
			INSERT INTO "account" (
			  id, "accountId", "providerId", "userId",
			  "accessToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"
			) VALUES (
			  ${accountId}, ${accountId}, 'test', ${userId},
			  'tok', ${new Date(Date.now() + 3_600_000).toISOString()}, 'read write', NOW(), NOW()
			)
		`;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: CONNECTOR,
			displayName: "auto ledger OAuth",
			profileKind: "oauth_account",
			provider: "test",
			accountId,
			status: "active",
			createdBy: userId,
		});
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connectionId}`;
	});

	it("records a completed auto run in the operation ledger", async () => {
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "echo",
				input: { value: "auto-ok" },
			},
			{} as Env,
			ctx,
		)) as { status: string; run_id: number };
		expect(result.status).toBe("completed");

		const rows = await operationLedger(orgId, result.run_id);
		// Two durable versions: the dispatch card and the terminal outcome that
		// supersedes it. `events` is append-only, so the chain is the history.
		expect(rows).toHaveLength(2);

		const [dispatched, terminal] = rows;
		expect(dispatched).toMatchObject({
			origin_id: `run_${result.run_id}_auto`,
			interaction_status: "approved",
			interaction_input: { value: "auto-ok" },
		});
		expect(Number(dispatched.connection_id)).toBe(connectionId);
		expect(dispatched.metadata.operation_key).toBe("echo");
		expect(dispatched.superseded_by).not.toBeNull();

		expect(terminal).toMatchObject({
			interaction_status: "completed",
			interaction_output: { value: "auto-ok" },
			superseded_by: null,
		});
		expect(Number(terminal.supersedes_event_id)).toBe(Number(dispatched.id));
	});

	it("records a failed auto run in the operation ledger", async () => {
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "echo",
				input: { value: "boom" },
			},
			{} as Env,
			ctx,
		)) as { status: string; run_id: number };
		expect(result.status).toBe("failed");

		const rows = await operationLedger(orgId, result.run_id);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			interaction_status: "failed",
			superseded_by: null,
		});
		expect(rows[1].interaction_error).toContain("connector exploded");
	});

	it("binds the dispatch card to the run row: no run without its card", async () => {
		const sql = getTestDb();
		const runs = (await sql`
			SELECT r.id
			FROM runs r
			WHERE r.organization_id = ${orgId}
			  AND r.run_type = 'action'
			  AND r.connector_key = ${CONNECTOR}
			  AND NOT EXISTS (
			    SELECT 1 FROM events e
			    WHERE e.organization_id = r.organization_id
			      AND e.run_id = r.id
			      AND e.semantic_type = 'operation'
			  )
		`) as unknown as Array<{ id: string }>;
		expect(runs).toEqual([]);
	});

	it("records a device-executed auto run when the worker reports completion", async () => {
		delete process.env.WORKER_API_TOKEN;
		const sql = getTestDb();
		const workerId = `auto-ledger-device-${Date.now()}`;
		const [device] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, app_version, capabilities, label,
				organization_id, last_seen_at
			) VALUES (
				${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json([])}, 'Auto Ledger Device',
				${orgId}, NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const deviceConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { echo: "auto" } },
		});
		await sql`
			UPDATE connections SET device_worker_id = ${String(device.id)}::uuid
			WHERE id = ${deviceConn.id}
		`;
		const idempotencyKey = `auto-ledger:device:${Date.now()}`;
		const execution = manageOperations(
			{
				action: "execute",
				connection_id: deviceConn.id,
				operation_key: "echo",
				input: { value: "device-ok" },
				idempotency_key: idempotencyKey,
			},
			{} as Env,
			ctx,
		) as Promise<{ status: string; run_id: number }>;

		const deadline = Date.now() + 5_000;
		let runId = 0;
		while (Date.now() < deadline && runId === 0) {
			const rows = (await sql`
				SELECT id FROM runs
				WHERE connection_id = ${deviceConn.id}
				  AND run_type = 'action'
				  AND action_idempotency_key = ${idempotencyKey}
				LIMIT 1
			`) as unknown as Array<{ id: number }>;
			if (rows[0]) runId = Number(rows[0].id);
			else await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(runId).toBeGreaterThan(0);

		// The card exists the moment the run does — before any worker touches it.
		const dispatched = await operationLedger(orgId, runId);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].interaction_status).toBe("approved");

		const claim = (await (
			await post("/api/workers/poll", {
				body: {
					worker_id: workerId,
					platform: "macos",
					app_version: "0.1.0",
					label: workerId,
					capabilities: {},
				},
			})
		).json()) as { run_id?: number };
		expect(claim.run_id).toBe(runId);
		const completed = await post("/api/workers/complete-action", {
			body: {
				run_id: runId,
				worker_id: workerId,
				status: "success",
				action_output: { value: "device-ok" },
			},
		});
		expect(completed.status).toBe(200);
		expect(await execution).toMatchObject({ status: "completed" });

		const rows = await operationLedger(orgId, runId);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			interaction_status: "completed",
			superseded_by: null,
		});
		expect(Number(rows[1].supersedes_event_id)).toBe(Number(rows[0].id));
	});

	it("still writes exactly one pending card on the approval path", async () => {
		const sql = getTestDb();
		await sql`
			UPDATE connections
			SET config = ${sql.json({ action_modes: { echo: "auto", needs_approval: "approval" } })}
			WHERE id = ${connectionId}
		`;
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "needs_approval",
				input: {},
			},
			{} as Env,
			ctx,
		)) as { status: string; run_id: number };
		expect(queued.status).toBe("pending_approval");

		const rows = await operationLedger(orgId, queued.run_id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			origin_id: `run_${queued.run_id}_pending`,
			interaction_type: "approval",
			interaction_status: "pending",
		});
	});
});
