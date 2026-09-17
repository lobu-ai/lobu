import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPILE_CONFIG_HASH } from "@lobu/connector-worker/compile";
import type { Env } from "../../index";
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

const CONNECTOR_KEY = "demo.ops.targeting-invariants";
const ACTION_KEY = "echo";

type Device = {
	id: string;
	workerId: string;
	platform: "macos";
};

async function seedDevice(
	userId: string,
	organizationId: string,
	label: string,
): Promise<Device> {
	const sql = getTestDb();
	const workerId = `${label.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [row] = (await sql`
		INSERT INTO device_workers (
			user_id, worker_id, platform, app_version, capabilities, label,
			organization_id, last_seen_at
		) VALUES (
			${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json([])}, ${label},
			${organizationId}, NOW()
		)
		RETURNING id
	`) as unknown as Array<{ id: string }>;
	return { id: String(row.id), workerId, platform: "macos" };
}

async function poll(
	device: Device,
	capabilities: Record<string, boolean> = {},
) {
	return post("/api/workers/poll", {
		body: {
			worker_id: device.workerId,
			platform: device.platform,
			app_version: "0.1.0",
			label: device.workerId,
			capabilities,
		},
	});
}

describe("device run targeting and execution invariants", () => {
	let ctx: ToolContext;
	let user: { id: string };
	let org: { id: string };
	let deviceA: Device;
	let deviceB: Device;

	beforeEach(async () => {
		const seeded = await seedOwnerContext();
		ctx = seeded.ctx;
		user = seeded.user;
		org = seeded.org;
		initWorkspaceProvider({} as Env);

		deviceA = await seedDevice(user.id, org.id, "Mac A");
		deviceB = await seedDevice(user.id, org.id, "Mac B");

		// Register connector requiring computer_use capability
		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Device Targeting Invariant Connector",
			organization_id: org.id,
			auth_schema: { methods: [{ type: "none" }] },
		});
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET runtime = ${sql.json({ platform: "macos" })},
				required_capability = 'computer_use',
				actions_schema = ${sql.json({
					[ACTION_KEY]: {
						name: "Echo",
						kind: "write",
						requiresApproval: false,
						input_schema: {
							type: "object",
							required: ["value"],
							properties: { value: { type: "string" } },
						},
						output_schema: {
							type: "object",
							properties: { echoed: { type: "string" } },
						},
					},
				})}
			WHERE key = ${CONNECTOR_KEY} AND organization_id = ${org.id}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`
				class ConnectorRuntime {
					async sync() { return { items: [] }; }
					async execute(ctx) { return { success: true, output: { echoed: ctx.input.value } }; }
				}
				module.exports = { ConnectorRuntime };
			`},
			compile_config_hash = ${COMPILE_CONFIG_HASH}
			WHERE connector_key = ${CONNECTOR_KEY}
		`;
	});

	afterEach(async () => {
		await cleanupTestDatabase();
	});

	it("enforces that targeted runs can only be claimed by target device and stamps executed_by_device_worker_id", async () => {
		const sql = getTestDb();
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: CONNECTOR_KEY,
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});

		// Pin connection to Device A
		await sql`
			UPDATE connections SET device_worker_id = ${deviceA.id}::uuid
			WHERE id = ${connection.id}
		`;

		// Prime devices so server knows their IDs and capabilities
		await poll(deviceA, { computer_use: true });
		await poll(deviceB, { computer_use: true });

		const idempotencyKey = "targeting-test-run-1";
		const executionPromise = manageOperations(
			{
				action: "execute",
				connection_id: connection.id,
				operation_key: ACTION_KEY,
				input: { value: "test-targeting" },
				idempotency_key: idempotencyKey,
			},
			{} as Env,
			ctx,
		);

		// Wait for run row to exist
		let runRow: { id: number; target_device_worker_id: string | null; executed_by_device_worker_id: string | null } | null = null;
		for (let i = 0; i < 50; i++) {
			const [row] = (await sql`
				SELECT id, target_device_worker_id, executed_by_device_worker_id
				FROM runs
				WHERE connection_id = ${connection.id} AND action_idempotency_key = ${idempotencyKey}
			`) as unknown as Array<{ id: number; target_device_worker_id: string | null; executed_by_device_worker_id: string | null }>;
			if (row) {
				runRow = row;
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(runRow).not.toBeNull();
		// INVARIANT: target_device_worker_id must match the pinned device
		expect(runRow!.target_device_worker_id).toBe(deviceA.id);
		expect(runRow!.executed_by_device_worker_id).toBeNull();

		// The pin is captured as the target at creation, so a still-pending run is
		// already attributed to — and listable under — its device before any claim.
		// This is what keeps pending work visible now that the device filter no
		// longer consults the connection's live pin (#3213).
		const pendingDetails = (await manageOperations(
			{ action: "get_run", run_id: runRow!.id },
			{} as Env,
			ctx,
		)) as { run: Record<string, unknown> };
		expect(pendingDetails.run.status).toBe("pending");
		expect(pendingDetails.run.device_worker_id).toBe(deviceA.id);
		const pendingRunsA = (await manageOperations(
			{ action: "list_runs", device_worker_id: deviceA.id },
			{} as Env,
			ctx,
		)) as { runs: Array<Record<string, unknown>> };
		expect(pendingRunsA.runs.some((r) => r.id === runRow!.id)).toBe(true);

		// Device B (even though capable) polls — MUST NOT claim the run targeted to Device A!
		const bPoll = (await (await poll(deviceB, { computer_use: true })).json()) as { run_id?: number };
		expect(bPoll.run_id).toBeUndefined();

		// Device A polls — MUST claim the run targeted to Device A!
		const aPoll = (await (await poll(deviceA, { computer_use: true })).json()) as { run_id?: number };
		expect(aPoll.run_id).toBe(runRow!.id);

		// INVARIANT: upon claim, executed_by_device_worker_id must be stamped
		const [claimedRow] = (await sql`
			SELECT status, target_device_worker_id, executed_by_device_worker_id
			FROM runs WHERE id = ${runRow!.id}
		`) as unknown as Array<{ status: string; target_device_worker_id: string | null; executed_by_device_worker_id: string | null }>;
		expect(claimedRow.status).toBe("running");
		expect(claimedRow.target_device_worker_id).toBe(deviceA.id);
		expect(claimedRow.executed_by_device_worker_id).toBe(deviceA.id);

		// Complete action
		await post("/api/workers/complete-action", {
			body: {
				run_id: runRow!.id,
				worker_id: deviceA.workerId,
				action_output: { echoed: "test-targeting" },
				status: "success",
			},
		});

		const result = await executionPromise;
		expect(result).toMatchObject({
			status: "completed",
			output: { echoed: "test-targeting" },
		});

		// INVARIANT: Repinning connection to Device B does NOT mutate historical run attribution
		await sql`
			UPDATE connections SET device_worker_id = ${deviceB.id}::uuid
			WHERE id = ${connection.id}
		`;

		const runDetails = (await manageOperations(
			{ action: "get_run", run_id: runRow!.id },
			{} as Env,
			ctx,
		)) as { run: Record<string, unknown> };
		expect(runDetails.run.target_device_worker_id).toBe(deviceA.id);
		expect(runDetails.run.executed_by_device_worker_id).toBe(deviceA.id);
		expect(runDetails.run.device_worker_id).toBe(deviceA.id);

		// list_runs filtered by device A finds the run
		const runsA = (await manageOperations(
			{ action: "list_runs", device_worker_id: deviceA.id },
			{} as Env,
			ctx,
		)) as { runs: Array<Record<string, unknown>> };
		expect(runsA.runs.some((r) => r.id === runRow!.id)).toBe(true);

		// list_runs filtered by device B does NOT return the run executed on A
		const runsB = (await manageOperations(
			{ action: "list_runs", device_worker_id: deviceB.id },
			{} as Env,
			ctx,
		)) as { runs: Array<Record<string, unknown>> };
		expect(runsB.runs.some((r) => r.id === runRow!.id)).toBe(false);
	});

	it("does not attribute a server-executed run to a device pinned after it completed", async () => {
		const sql = getTestDb();
		// A connection that is NOT device-pinned, running server-side: both
		// immutable attribution columns stay NULL, which is the normal shape for
		// every server-executed run.
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: CONNECTOR_KEY,
			created_by: user.id,
		});
		const [inserted] = (await sql`
			INSERT INTO runs (
				organization_id, run_type, connection_id, connector_key,
				action_key, status, approval_status, claimed_by,
				created_at, completed_at
			) VALUES (
				${org.id}, 'action', ${connection.id}, ${CONNECTOR_KEY},
				${ACTION_KEY}, 'completed', 'auto', 'server-worker-1',
				now() - interval '1 day', now() - interval '1 day'
			)
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const runId = Number(inserted.id);

		const reportedDevice = async () => {
			const res = (await manageOperations(
				{ action: "get_run", run_id: runId },
				{} as Env,
				ctx,
			)) as { run: Record<string, unknown> };
			// The run is terminal and never re-executes across these reads.
			expect(res.run.status).toBe("completed");
			return res.run.device_worker_id ?? null;
		};

		expect(await reportedDevice()).toBeNull();

		// INVARIANT: pinning the connection AFTER the run finished must not
		// retroactively attribute that run to the newly pinned device (#3213).
		await sql`
			UPDATE connections SET device_worker_id = ${deviceB.id}::uuid
			WHERE id = ${connection.id}
		`;
		expect(await reportedDevice()).toBeNull();

		await sql`
			UPDATE connections SET device_worker_id = ${deviceA.id}::uuid
			WHERE id = ${connection.id}
		`;
		expect(await reportedDevice()).toBeNull();

		// The device filter must agree with the field it filters on: neither pin
		// may sweep in a run that no device ever claimed.
		for (const device of [deviceA, deviceB]) {
			const listed = (await manageOperations(
				{ action: "list_runs", device_worker_id: device.id },
				{} as Env,
				ctx,
			)) as { runs: Array<Record<string, unknown>> };
			expect(listed.runs.some((r) => r.id === runId)).toBe(false);
		}
	});
});
