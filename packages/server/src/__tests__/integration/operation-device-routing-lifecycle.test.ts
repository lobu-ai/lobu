/**
 * A connection's physical device pin is exact operation placement. Moving the
 * connection changes only future claims; an in-flight run remains owned by the
 * worker that claimed it. A chrome-extension pin on a non-Chrome connector is
 * the exception: it is delegated scrape affinity, so the parent operation stays
 * inline on the gateway.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const CONNECTOR_KEY = "demo.ops.device-routing";
const ACTION_KEY = "echo";

type Device = {
	id: string;
	workerId: string;
	platform: "macos" | "chrome-extension";
};

async function seedDevice(
	userId: string,
	organizationId: string,
	label: string,
	platform: Device["platform"],
): Promise<Device> {
	const sql = getTestDb();
	const workerId = `${label.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [row] = (await sql`
		INSERT INTO device_workers (
			user_id, worker_id, platform, app_version, capabilities, label,
			organization_id, last_seen_at
		) VALUES (
			${userId}, ${workerId}, ${platform}, '0.1.0', ${sql.json([])}, ${label},
			${organizationId}, NOW() - INTERVAL '10 minutes'
		)
		RETURNING id
	`) as unknown as Array<{ id: string }>;
	return { id: String(row.id), workerId, platform };
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

async function completeAction(
	runId: number,
	workerId: string,
	output: Record<string, unknown>,
) {
	const response = await post("/api/workers/complete-action", {
		body: {
			run_id: runId,
			worker_id: workerId,
			status: "success",
			action_output: output,
		},
	});
	expect(response.status).toBe(200);
	return response.json() as Promise<{ success: boolean; reason?: string }>;
}

async function waitForPendingAction(
	connectionId: number,
	idempotencyKey: string,
): Promise<number> {
	const sql = getTestDb();
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const rows = (await sql`
			SELECT id
			FROM runs
			WHERE connection_id = ${connectionId}
			  AND run_type = 'action'
			  AND action_idempotency_key = ${idempotencyKey}
			  AND status = 'pending'
			LIMIT 1
		`) as unknown as Array<{ id: number }>;
		if (rows[0]) return Number(rows[0].id);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Pending action '${idempotencyKey}' was not created`);
}

async function operationReadiness(connectionId: number, ctx: ToolContext) {
	const result = (await manageOperations(
		{ action: "list_available", connection_id: connectionId },
		{} as Env,
		ctx,
	)) as {
		operations: Array<{
			operation_key: string;
			readiness: string;
			executable: boolean;
		}>;
	};
	return result.operations.find((operation) => operation.operation_key === ACTION_KEY);
}

/**
 * An inline run is owned by the gateway request that executed it
 * (`gateway-inline-<uuid>`), so "no device claimed this" is no longer
 * `claimed_by IS NULL` — it is "the owner is the gateway, not a device".
 */
function expectInlineCompleted(run: {
	status: string;
	claimed_by: string | null;
}): void {
	expect(run.status).toBe("completed");
	expect(run.claimed_by).toMatch(/^gateway-inline-/);
}

describe("connection-to-device operation routing lifecycle", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		delete process.env.LOBU_CLOUD_MODE;
		delete process.env.WORKER_API_TOKEN;
	});

	afterEach(async () => {
		await cleanupTestDatabase();
		delete process.env.LOBU_CLOUD_MODE;
		delete process.env.WORKER_API_TOKEN;
	});

	it("routes each operation to the connection's current physical device while preserving Chrome affinity", async () => {
		const { org, user, ctx } = await seedOwnerContext({
			orgName: "Operation Device Routing Org",
		});
		ctx.baseUrl = "https://gateway.test/lobu";
		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Device routing connector",
			organization_id: org.id,
			auth_schema: { methods: [{ type: "none" }] },
		});
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				[ACTION_KEY]: {
					name: "Echo",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
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
					async execute(ctx) {
						return { success: true, output: { inline: true, value: ctx.input.value } };
					}
				}
				module.exports = { ConnectorRuntime };
			`}
			WHERE connector_key = ${CONNECTOR_KEY}
		`;

		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: CONNECTOR_KEY,
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});
		const deviceA = await seedDevice(user.id, org.id, "Device A", "macos");
		const deviceB = await seedDevice(user.id, org.id, "Device B", "macos");
		await sql`
			UPDATE connections SET device_worker_id = ${deviceA.id}::uuid
			WHERE id = ${connection.id}
		`;

		// A stale physical pin is visible but not addressable until its first poll.
		expect(await operationReadiness(connection.id, ctx)).toMatchObject({
			readiness: "device_offline",
			executable: false,
		});
		expect((await poll(deviceA)).status).toBe(200);
		expect(await operationReadiness(connection.id, ctx)).toMatchObject({
			readiness: "ready",
			executable: true,
		});

		const firstKey = "device-routing:first";
		const firstExecution = manageOperations(
			{
				action: "execute",
				connection_id: connection.id,
				operation_key: ACTION_KEY,
				input: { value: "first" },
				idempotency_key: firstKey,
			},
			{} as Env,
			ctx,
		);
		const firstRunId = await waitForPendingAction(connection.id, firstKey);

		// The other device can poll, but the connection pin makes A the sole claimant.
		const bBeforeMove = (await (await poll(deviceB)).json()) as { run_id?: number };
		expect(bBeforeMove.run_id).toBeUndefined();
		const aClaim = (await (await poll(deviceA)).json()) as { run_id?: number };
		expect(aClaim.run_id).toBe(firstRunId);

		// Reassignment affects the next operation, not completion ownership of this one.
		await sql`
			UPDATE connections SET device_worker_id = ${deviceB.id}::uuid
			WHERE id = ${connection.id}
		`;
		expect(await completeAction(firstRunId, deviceB.workerId, { wrong: true })).toMatchObject({
			success: false,
		});
		expect(await completeAction(firstRunId, deviceA.workerId, { owner: "A" })).toEqual({
			success: true,
		});
		expect(await firstExecution).toMatchObject({
			status: "completed",
			output: { owner: "A" },
		});

		// Historical run attribution is immutable: moving the connection to device B
		// does not change firstRun's target or execution attribution.
		const firstRunDetails = (await manageOperations(
			{ action: "get_run", run_id: firstRunId },
			{} as Env,
			ctx,
		)) as { run: Record<string, unknown> };
		expect(firstRunDetails.run.target_device_worker_id).toBe(deviceA.id);
		expect(firstRunDetails.run.executed_by_device_worker_id).toBe(deviceA.id);
		expect(firstRunDetails.run.device_worker_id).toBe(deviceA.id);

		// list_runs filtered by device A finds firstRun even though connection was moved to B
		const runsForA = (await manageOperations(
			{ action: "list_runs", device_worker_id: deviceA.id },
			{} as Env,
			ctx,
		)) as { runs: Array<Record<string, unknown>> };
		expect(runsForA.runs.some((r) => r.id === firstRunId)).toBe(true);

		// list_runs filtered by device B does NOT claim firstRun
		const runsForBBeforeSecond = (await manageOperations(
			{ action: "list_runs", device_worker_id: deviceB.id },
			{} as Env,
			ctx,
		)) as { runs: Array<Record<string, unknown>> };
		expect(runsForBBeforeSecond.runs.some((r) => r.id === firstRunId)).toBe(false);

		// B going stale makes the moved target non-executable; its next poll both
		// restores readiness and is the only legal claim for the next operation.
		await sql`
			UPDATE device_workers SET last_seen_at = NOW() - INTERVAL '10 minutes'
			WHERE id = ${deviceB.id}::uuid
		`;
		expect(await operationReadiness(connection.id, ctx)).toMatchObject({
			readiness: "device_offline",
			executable: false,
		});
		const secondKey = "device-routing:second";
		const secondExecution = manageOperations(
			{
				action: "execute",
				connection_id: connection.id,
				operation_key: ACTION_KEY,
				input: { value: "second" },
				idempotency_key: secondKey,
			},
			{} as Env,
			ctx,
		);
		const secondRunId = await waitForPendingAction(connection.id, secondKey);
		const aAfterMove = (await (await poll(deviceA)).json()) as { run_id?: number };
		expect(aAfterMove.run_id).toBeUndefined();
		const bClaim = (await (await poll(deviceB)).json()) as { run_id?: number };
		expect(bClaim.run_id).toBe(secondRunId);
		expect(await operationReadiness(connection.id, ctx)).toMatchObject({
			readiness: "ready",
			executable: true,
		});
		expect(await completeAction(secondRunId, deviceA.workerId, { wrong: true })).toMatchObject({
			success: false,
		});
		expect(await completeAction(secondRunId, deviceB.workerId, { owner: "B" })).toEqual({
			success: true,
		});
		expect(await secondExecution).toMatchObject({
			status: "completed",
			output: { owner: "B" },
		});

		const secondRunDetails = (await manageOperations(
			{ action: "get_run", run_id: secondRunId },
			{} as Env,
			ctx,
		)) as { run: Record<string, unknown> };
		expect(secondRunDetails.run.target_device_worker_id).toBe(deviceB.id);
		expect(secondRunDetails.run.executed_by_device_worker_id).toBe(deviceB.id);
		expect(secondRunDetails.run.device_worker_id).toBe(deviceB.id);

		const runsForBAfterSecond = (await manageOperations(
			{ action: "list_runs", device_worker_id: deviceB.id },
			{} as Env,
			ctx,
		)) as { runs: Array<Record<string, unknown>> };
		expect(runsForBAfterSecond.runs.some((r) => r.id === secondRunId)).toBe(true);
		expect(runsForBAfterSecond.runs.some((r) => r.id === firstRunId)).toBe(false);

		// Chrome pinning a non-Chrome connector chooses delegated scrape affinity;
		// it must not move the connector's parent operation off the gateway.
		const chrome = await seedDevice(user.id, org.id, "Chrome", "chrome-extension");
		const chromeAffinityConnection = await createTestConnection({
			organization_id: org.id,
			connector_key: CONNECTOR_KEY,
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});
		await sql`
			UPDATE connections SET device_worker_id = ${chrome.id}::uuid
			WHERE id = ${chromeAffinityConnection.id}
		`;
		const chromeAffinityResult = await manageOperations(
			{
				action: "execute",
				connection_id: chromeAffinityConnection.id,
				operation_key: ACTION_KEY,
				input: { value: "chrome-affinity" },
				idempotency_key: "device-routing:chrome-affinity",
			},
			{} as Env,
			ctx,
		);
		expect(chromeAffinityResult).toMatchObject({
			status: "completed",
			output: { inline: true, value: "chrome-affinity" },
		});
		const [chromeRun] = (await sql`
			SELECT status, claimed_by, target_device_worker_id, executed_by_device_worker_id
			FROM runs
			WHERE connection_id = ${chromeAffinityConnection.id}
			  AND action_idempotency_key = 'device-routing:chrome-affinity'
		`) as unknown as Array<{
			status: string;
			claimed_by: string | null;
			target_device_worker_id: string | null;
			executed_by_device_worker_id: string | null;
		}>;
		expectInlineCompleted(chromeRun);
		expect(chromeRun.target_device_worker_id).toBeNull();
		expect(chromeRun.executed_by_device_worker_id).toBeNull();

		const runsForChrome = (await manageOperations(
			{ action: "list_runs", device_worker_id: chrome.id },
			{} as Env,
			ctx,
		)) as { runs: Array<Record<string, unknown>> };
		expect(runsForChrome.runs.some((r) => r.connection_id === chromeAffinityConnection.id)).toBe(false);

		// A connector whose key merely starts with "chrome" is still non-Chrome.
		// A chrome-extension pin therefore remains delegated browser affinity: the
		// parent connector operation stays inline and is never claimed by the device.
		const chromePrefixKey = "chromecast.demo";
		await createTestConnectorDefinition({
			key: chromePrefixKey,
			name: "Chrome-prefix non-Chrome connector",
			organization_id: org.id,
			auth_schema: { methods: [{ type: "none" }] },
		});
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				[ACTION_KEY]: {
					name: "Echo",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				},
			})}
			WHERE key = ${chromePrefixKey} AND organization_id = ${org.id}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`
				class ConnectorRuntime {
					async sync() { return { items: [] }; }
					async execute(ctx) {
						return { success: true, output: { inline: true, value: ctx.input.value } };
					}
				}
				module.exports = { ConnectorRuntime };
			`}
			WHERE connector_key = ${chromePrefixKey}
		`;
		const chromePrefixConnection = await createTestConnection({
			organization_id: org.id,
			connector_key: chromePrefixKey,
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});
		await sql`
			UPDATE connections SET device_worker_id = ${chrome.id}::uuid
			WHERE id = ${chromePrefixConnection.id}
		`;
		const chromePrefixIdempotencyKey = "device-routing:chrome-prefix";
		const chromePrefixResult = await manageOperations(
			{
				action: "execute",
				connection_id: chromePrefixConnection.id,
				operation_key: ACTION_KEY,
				input: { value: "chrome-prefix" },
				idempotency_key: chromePrefixIdempotencyKey,
			},
			{} as Env,
			ctx,
		);
		expect(chromePrefixResult).toMatchObject({
			status: "completed",
			output: { inline: true, value: "chrome-prefix" },
		});
		const [chromePrefixRun] = (await sql`
			SELECT status, claimed_by
			FROM runs
			WHERE connection_id = ${chromePrefixConnection.id}
			  AND action_idempotency_key = ${chromePrefixIdempotencyKey}
		`) as unknown as Array<{ status: string; claimed_by: string | null }>;
		expectInlineCompleted(chromePrefixRun);

		// A key outside the reserved `chrome.*` namespace is never native Chrome
		// execution: a Chrome pin on it is delegated browser affinity, so the
		// parent run completes inline on fleet even when stale provenance and the
		// active definition both still describe Chrome.
		const compiledDemoVersion = `compiled-${Date.now()}`;
		await createTestConnectorDefinition({
			key: "demo.device",
			name: "Demo device compiled override",
			version: compiledDemoVersion,
			organization_id: org.id,
			auth_schema: { methods: [{ type: "none" }] },
		});
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				[ACTION_KEY]: {
					name: "Echo",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				},
			})},
				required_capability = 'browser.scripting',
				runtime = ${sql.json({ platforms: ["chrome-extension"] })}
			WHERE key = 'demo.device' AND organization_id = ${org.id}
		`;
		await sql`
			INSERT INTO connector_versions (
				organization_id, connector_key, version, compiled_code,
				compiled_code_hash, compile_config_hash, source_path, created_at
			) VALUES (
				${org.id}, 'demo.device', ${compiledDemoVersion}, ${`
					class ConnectorRuntime {
						async sync() { return { items: [] }; }
						async execute(ctx) {
							return { success: true, output: { inline: true, value: ctx.input.value } };
						}
					}
					module.exports = { ConnectorRuntime };
				`}, 'compiled-demo-override-hash', ${COMPILE_CONFIG_HASH},
				${`device-manifest://chrome-extension/demo.device@${compiledDemoVersion}`}, NOW()
			)
		`;
		const compiledDemoConnection = await createTestConnection({
			organization_id: org.id,
			connector_key: "demo.device",
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});
		await sql`
			UPDATE connections SET device_worker_id = ${chrome.id}::uuid
			WHERE id = ${compiledDemoConnection.id}
		`;
		const compiledDemoResult = await manageOperations(
			{
				action: "execute",
				connection_id: compiledDemoConnection.id,
				operation_key: ACTION_KEY,
				input: { value: "compiled-demo-affinity" },
				idempotency_key: "device-routing:compiled-demo-affinity",
			},
			{} as Env,
			ctx,
		);
		expect(compiledDemoResult).toMatchObject({
			status: "completed",
			output: { inline: true, value: "compiled-demo-affinity" },
		});
		const [compiledDemoRun] = (await sql`
			SELECT status, claimed_by
			FROM runs
			WHERE connection_id = ${compiledDemoConnection.id}
			  AND action_idempotency_key = 'device-routing:compiled-demo-affinity'
		`) as unknown as Array<{ status: string; claimed_by: string | null }>;
		expectInlineCompleted(compiledDemoRun);

		await sql`
			UPDATE connections SET device_worker_id = NULL
			WHERE id = ${compiledDemoConnection.id}
		`;
		// Dropping the pin drops the only reason to run inline. Affinity is a fact
		// about the pinned device, not about the connector, so once the pin is gone
		// the connector's own `chrome-extension` runtime is authoritative and the
		// action queues for a Chrome device instead of resolving inline. Nothing
		// advertises one here, so an already-aborted caller observes the timeout.
		const unpinnedCompiledDemoKey = "device-routing:compiled-demo-unpinned";
		const unpinnedAbort = new AbortController();
		unpinnedAbort.abort();
		const unpinnedCompiledDemoResult = await manageOperations(
			{
				action: "execute",
				connection_id: compiledDemoConnection.id,
				operation_key: ACTION_KEY,
				input: { value: "compiled-demo-unpinned" },
				idempotency_key: unpinnedCompiledDemoKey,
			},
			{} as Env,
			{ ...ctx, abortSignal: unpinnedAbort.signal },
		);
		expect(unpinnedCompiledDemoResult).toMatchObject({ status: "timeout" });
		const [unpinnedCompiledDemoRun] = (await sql`
			SELECT status, claimed_by
			FROM runs
			WHERE connection_id = ${compiledDemoConnection.id}
			  AND action_idempotency_key = ${unpinnedCompiledDemoKey}
		`) as unknown as Array<{ status: string; claimed_by: string | null }>;
		expect(unpinnedCompiledDemoRun).toEqual({ status: "timeout", claimed_by: null });

		// The same key becomes device-native when the selected artifact is
		// metadata-only. No device advertises this manifest, so admission fails
		// before waiting for a device or attempting to resolve connector code inline.
		await sql`
			UPDATE connector_versions
			SET compiled_code = NULL,
				compiled_code_hash = 'mac-demo-manifest-hash',
				compile_config_hash = NULL,
				source_code = NULL,
				source_path = ${`device-manifest://macos/demo.device@${compiledDemoVersion}`}
			WHERE organization_id = ${org.id}
			  AND connector_key = 'demo.device'
			  AND version = ${compiledDemoVersion}
		`;
		await sql`
			UPDATE connector_definitions
			SET required_capability = 'local_directory',
				runtime = ${sql.json({ platforms: ["macos"] })}
			WHERE key = 'demo.device' AND organization_id = ${org.id}
		`;
		const manifestDemoKey = "device-routing:manifest-demo-unpinned";
		const aborted = new AbortController();
		aborted.abort();
		const manifestDemoResult = await manageOperations(
			{
				action: "execute",
				connection_id: compiledDemoConnection.id,
				operation_key: ACTION_KEY,
				input: { value: "manifest-demo-unpinned" },
				idempotency_key: manifestDemoKey,
			},
			{} as Env,
			{ ...ctx, abortSignal: aborted.signal },
		);
		expect(manifestDemoResult).toMatchObject({
			status: "failed",
			error_message: expect.stringMatching(/selected connector manifest.*eligible device/i),
		});
		const [manifestDemoRun] = (await sql`
			SELECT status, claimed_by
			FROM runs
			WHERE connection_id = ${compiledDemoConnection.id}
			  AND action_idempotency_key = ${manifestDemoKey}
		`) as unknown as Array<{ status: string; claimed_by: string | null }>;
		expect(manifestDemoRun).toEqual({ status: "failed", claimed_by: null });

		// Intrinsic connector runtime remains authoritative even without a pin.
		await sql`
			UPDATE connector_definitions
			SET runtime = ${sql.json({ platform: "macos" })},
				required_capability = 'computer_use'
			WHERE key = ${CONNECTOR_KEY} AND organization_id = ${org.id}
		`;
		const intrinsicConnection = await createTestConnection({
			organization_id: org.id,
			connector_key: CONNECTOR_KEY,
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});
		const intrinsicKey = "device-routing:intrinsic-runtime";
		const intrinsicExecution = manageOperations(
			{
				action: "execute",
				connection_id: intrinsicConnection.id,
				operation_key: ACTION_KEY,
				input: { value: "intrinsic" },
				idempotency_key: intrinsicKey,
			},
			{} as Env,
			ctx,
		);
		const intrinsicRunId = await waitForPendingAction(
			intrinsicConnection.id,
			intrinsicKey,
		);
		const intrinsicClaim = (await (
			await poll(deviceA, { computer_use: true })
		).json()) as { run_id?: number };
		expect(intrinsicClaim.run_id).toBe(intrinsicRunId);
		expect(
			await completeAction(intrinsicRunId, deviceA.workerId, {
				runtime: "device",
			}),
		).toEqual({ success: true });
		expect(await intrinsicExecution).toMatchObject({
			status: "completed",
			output: { runtime: "device" },
		});
	});
});
