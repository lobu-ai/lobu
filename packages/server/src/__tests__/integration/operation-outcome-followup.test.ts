/**
 * An operation a chat turn queued for approval continues that conversation
 * once it resolves: its terminal transition enqueues exactly one `wake_agent`
 * task carrying the outcome into the originating chat. Runs that never waited
 * for approval, and runs no chat turn created, enqueue nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertEntityApprovalPolicy } from "../../authz/entity-policy";
import type { Env } from "../../index";
import { operationOutcomeFollowupKey } from "../../operations/operation-outcome-followup";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";

const CONNECTOR = "demo.ops.outcome.followup";
const AGENT = "agent-outcome-followup";
const DELIVERY = {
	platform: "slack",
	conversationId: "slack:C-synthetic:1700000000.000100",
	channelId: "C-synthetic",
	connectionId: "conn-synthetic",
	teamId: "T-synthetic",
	userId: "U-synthetic",
};

type FollowupTask = {
	id: string;
	status: string;
	action_input: {
		name: string;
		payload: {
			agent_id: string;
			prompt: string;
			__delivery_context: typeof DELIVERY;
			__message_id: string;
			__created_by_agent: string;
		};
	};
};

async function followupTasks(runId: number): Promise<FollowupTask[]> {
	return (await getTestDb()`
		SELECT id, status, action_input
		FROM runs
		WHERE run_type = 'task'
		  AND action_key = 'wake_agent'
		  AND idempotency_key = ${operationOutcomeFollowupKey(runId)}
	`) as unknown as FollowupTask[];
}

describe("operation outcome follow-up turn", () => {
	let orgId: string;
	let userId: string;
	let ownerCtx: ToolContext;
	let turnCtx: ToolContext;
	let workerApiToken: string | undefined;

	beforeAll(async () => {
		workerApiToken = process.env.WORKER_API_TOKEN;
		delete process.env.WORKER_API_TOKEN;
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx } = await seedOwnerContext({
			orgName: "Outcome Followup Org",
		});
		ctx.baseUrl = "https://gateway.test/lobu";
		orgId = org.id;
		userId = user.id;
		ownerCtx = ctx;
		await createTestAgent({
			organizationId: orgId,
			agentId: AGENT,
			ownerUserId: userId,
		});
		// The verified context a chat turn's tool call carries.
		turnCtx = {
			...ctx,
			agentId: AGENT,
			clientId: "lobu-worker",
			sourceContext: { ...DELIVERY },
		};

		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Outcome Followup",
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
			})},
			supports_execute = true
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`
				class ConnectorRuntime {
					async sync() { return { items: [] }; }
					async execute(ctx) { return { success: true, output: { value: ctx.input.value } }; }
				}
				module.exports = { ConnectorRuntime };
			`}
			WHERE connector_key = ${CONNECTOR}
		`;
	});

	afterAll(() => {
		if (workerApiToken === undefined) delete process.env.WORKER_API_TOKEN;
		else process.env.WORKER_API_TOKEN = workerApiToken;
	});

	/** A device-pinned connection whose operations run under `effect`. */
	async function deviceConnection(effect: "approval" | "auto") {
		const sql = getTestDb();
		const workerId = `outcome-device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const [device] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, app_version, capabilities, label,
				organization_id, last_seen_at
			) VALUES (
				${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json([])}, 'Outcome Device',
				${orgId}, NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const connection = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			connectionId: connection.id,
			effects: { execute: effect },
		});
		await sql`
			UPDATE connections SET device_worker_id = ${String(device.id)}::uuid
			WHERE id = ${connection.id}
		`;
		return { connectionId: connection.id, workerId };
	}

	async function claim(workerId: string): Promise<number | undefined> {
		const res = await post("/api/workers/poll", {
			body: {
				worker_id: workerId,
				platform: "macos",
				app_version: "0.1.0",
				label: workerId,
				capabilities: {},
			},
		});
		return ((await res.json()) as { run_id?: number }).run_id;
	}

	function complete(
		workerId: string,
		runId: number,
		body: { status: "success" | "failure"; action_output?: unknown; error_message?: string },
	) {
		return post("/api/workers/complete-action", {
			body: { run_id: runId, worker_id: workerId, ...body },
		});
	}

	async function queueGated(ctx: ToolContext, value: string) {
		const device = await deviceConnection("approval");
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: device.connectionId,
				operation_key: "echo",
				input: { value },
			},
			{} as Env,
			ctx,
		)) as { status: string; run_id: number };
		expect(queued.status).toBe("pending_approval");
		return { ...device, runId: queued.run_id };
	}

	async function approveAndClaim(runId: number, workerId: string) {
		expect(
			await manageOperations({ action: "approve", run_id: runId }, {} as Env, ownerCtx),
		).toMatchObject({ approved: true });
		expect(await followupTasks(runId)).toHaveLength(0);
		expect(await claim(workerId)).toBe(runId);
	}

	it("continues the conversation once with the result when an approved operation completes", async () => {
		const { runId, workerId } = await queueGated(turnCtx, "hello");
		await approveAndClaim(runId, workerId);

		const done = await complete(workerId, runId, {
			status: "success",
			action_output: { value: "echoed-hello" },
		});
		expect(done.status).toBe(200);

		const tasks = await followupTasks(runId);
		expect(tasks).toHaveLength(1);
		const payload = tasks[0].action_input.payload;
		expect(tasks[0].action_input.name).toBe("wake_agent");
		expect(payload.agent_id).toBe(AGENT);
		expect(payload.__created_by_agent).toBe(AGENT);
		expect(payload.__delivery_context).toEqual({ ...DELIVERY });
		expect(payload.__message_id).toBe(`operation-outcome-${runId}`);
		expect(payload.prompt).toContain('"Echo"');
		expect(payload.prompt).toContain("was approved and completed");
		expect(payload.prompt).toContain('{"value":"echoed-hello"}');
	});

	it("a redelivered completion still yields exactly one follow-up", async () => {
		const { runId, workerId } = await queueGated(turnCtx, "twice");
		await approveAndClaim(runId, workerId);

		const body = { status: "success" as const, action_output: { value: "once" } };
		expect((await complete(workerId, runId, body)).status).toBe(200);
		expect((await complete(workerId, runId, body)).status).toBe(200);
		expect(await followupTasks(runId)).toHaveLength(1);

		// Even once the first follow-up has run, the operation run itself
		// remembers it was reported.
		await getTestDb()`
			UPDATE runs SET status = 'completed', completed_at = now()
			WHERE idempotency_key = ${operationOutcomeFollowupKey(runId)}
		`;
		expect((await complete(workerId, runId, body)).status).toBe(200);
		expect(await followupTasks(runId)).toHaveLength(1);
	});

	it("reports a failed approved operation with its error", async () => {
		const { runId, workerId } = await queueGated(turnCtx, "fail");
		await approveAndClaim(runId, workerId);

		const failed = await complete(workerId, runId, {
			status: "failure",
			error_message: "synthetic device error",
		});
		expect(failed.status).toBe(200);

		const tasks = await followupTasks(runId);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].action_input.payload.prompt).toContain("was approved but failed");
		expect(tasks[0].action_input.payload.prompt).toContain("Error: synthetic device error");
	});

	it("reports a rejection", async () => {
		const { runId } = await queueGated(turnCtx, "reject");
		expect(
			await manageOperations(
				{ action: "reject", run_id: runId, reason: "not today" },
				{} as Env,
				ownerCtx,
			),
		).toMatchObject({ rejected: true });

		const tasks = await followupTasks(runId);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].action_input.payload.prompt).toContain("was rejected");
		expect(tasks[0].action_input.payload.prompt).toContain("Reason: not today");
	});

	it("does not follow up an operation that never waited for approval", async () => {
		const { connectionId, workerId } = await deviceConnection("auto");
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "echo",
				input: { value: "auto" },
				background: true,
			},
			{} as Env,
			turnCtx,
		)) as { status: string; run_id: number };
		expect(queued.status).toBe("in_progress");
		expect(await claim(workerId)).toBe(queued.run_id);
		expect(
			(await complete(workerId, queued.run_id, {
				status: "success",
				action_output: { value: "auto" },
			})).status,
		).toBe(200);

		const [run] = await getTestDb()`SELECT status, run_metadata FROM runs WHERE id = ${queued.run_id}`;
		expect(run.status).toBe("completed");
		// The origin is recorded, but an ungated run keeps its in-turn result.
		expect(run.run_metadata.turn_origin).toMatchObject({ agent_id: AGENT });
		expect(await followupTasks(queued.run_id)).toHaveLength(0);
	});

	it("does not follow up an operation no chat turn created", async () => {
		const { runId, workerId } = await queueGated(ownerCtx, "human");
		await approveAndClaim(runId, workerId);
		expect(
			(await complete(workerId, runId, {
				status: "success",
				action_output: { value: "human" },
			})).status,
		).toBe(200);

		const [run] = await getTestDb()`SELECT status, run_metadata FROM runs WHERE id = ${runId}`;
		expect(run.status).toBe("completed");
		expect(run.run_metadata.turn_origin).toBeUndefined();
		expect(await followupTasks(runId)).toHaveLength(0);
	});

	it("does not follow up an auto operation blocked by policy before dispatch", async () => {
		const { connectionId, workerId } = await deviceConnection("auto");
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "echo",
				input: { value: "blocked-before-dispatch" },
				background: true,
			},
			{} as Env,
			turnCtx,
		)) as { status: string; run_id: number };
		expect(queued.status).toBe("in_progress");
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			connectionId,
			effects: { execute: "deny" },
		});
		expect(await claim(workerId)).toBeUndefined();
		const [run] = await getTestDb()`
			SELECT status, approval_status FROM runs WHERE id = ${queued.run_id}
		`;
		expect(run).toMatchObject({ status: "cancelled", approval_status: "rejected" });
		expect(await followupTasks(queued.run_id)).toHaveLength(0);
	});
});
