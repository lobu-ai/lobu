/**
 * Who besides an admin may decide a connector-operation run: the member whose
 * own device runs it, through a shared connection or a private one they created.
 * Both gates (web `manage_operations` and the chat card) and the approval
 * notification's recipients read the same `runDeciderUserIdSql`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEntityApprovalRun } from "../../gateway/connections/interaction-bridge";
import type { Env } from "../../index";
import { notifyActionApprovalNeeded } from "../../notifications/triggers";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestConnectorDefinition,
	createTestUser,
	seedOwnerContext,
} from "../setup/test-fixtures";

describe("run decider: a member's own device", () => {
	let orgId: string;
	let ownerCtx: ToolContext;
	let memberCtx: ToolContext;
	let otherCtx: ToolContext;
	let ownPrivate: number;
	let ownShared: number;
	let othersDevice: number;

	async function device(userId: string, workerId: string): Promise<string> {
		const sql = getTestDb();
		const [row] = await sql<{ id: string }>`
			INSERT INTO device_workers (user_id, worker_id, platform, organization_id)
			VALUES (${userId}, ${workerId}, 'headless', ${orgId})
			RETURNING id
		`;
		return row.id;
	}

	async function pinnedConnection(opts: {
		connectorKey: string;
		createdBy: string;
		deviceId: string;
		visibility: "private" | "org";
	}): Promise<number> {
		const connection = await createTestConnection({
			organization_id: orgId,
			connector_key: opts.connectorKey,
			created_by: opts.createdBy,
			visibility: opts.visibility,
			createDefaultFeed: false,
		});
		await getTestDb()`
			UPDATE connections SET device_worker_id = ${opts.deviceId}::uuid WHERE id = ${connection.id}
		`;
		return connection.id;
	}

	async function pendingRun(connectionId: number, connectorKey: string): Promise<number> {
		const sql = getTestDb();
		const [run] = await sql<{ id: number }>`
			INSERT INTO runs (
				organization_id, run_type, status, approval_status,
				connection_id, connector_key, action_key, policy_principal_kind
			) VALUES (
				${orgId}, 'action', 'pending', 'pending',
				${connectionId}, ${connectorKey}, 'run', 'user'
			)
			RETURNING id
		`;
		const runId = Number(run.id);
		await sql`
			INSERT INTO events (
				organization_id, origin_id, title, payload_text, run_id,
				semantic_type, interaction_type, interaction_status
			) VALUES (
				${orgId}, ${`run_${runId}_pending`}, 'run — pending approval',
				'Awaiting review', ${runId}, 'operation', 'approval', 'pending'
			)
		`;
		return runId;
	}

	function memberContext(base: ToolContext, userId: string): ToolContext {
		return { ...base, userId, memberRole: "member", scopes: ["mcp:read", "mcp:write"] };
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx } = await seedOwnerContext({ orgName: "Run Decider Team" });
		orgId = org.id;
		ownerCtx = ctx;
		const member = await createTestUser({ name: "Device Member" });
		const other = await createTestUser({ name: "Other Member" });
		await addUserToOrganization(member.id, org.id);
		await addUserToOrganization(other.id, org.id);
		memberCtx = memberContext(ctx, member.id);
		otherCtx = memberContext(ctx, other.id);

		const memberDevice = await device(member.id, "headless:decider-member");
		const ownerDevice = await device(ctx.userId as string, "headless:decider-owner");
		ownPrivate = await pinnedConnection({
			connectorKey: "demo.decider.private",
			createdBy: member.id,
			deviceId: memberDevice,
			visibility: "private",
		});
		ownShared = await pinnedConnection({
			connectorKey: "demo.decider.shared",
			createdBy: member.id,
			deviceId: memberDevice,
			visibility: "org",
		});
		// Created by the member but running on someone else's machine.
		othersDevice = await pinnedConnection({
			connectorKey: "demo.decider.elsewhere",
			createdBy: member.id,
			deviceId: ownerDevice,
			visibility: "private",
		});
	});

	afterAll(cleanupTestDatabase);

	it("lets the device owner approve their private operation for worker execution", async () => {
		const sql = getTestDb();
		await createTestConnectorDefinition({
			key: "demo.decider.private",
			name: "Private device operation",
			organization_id: orgId,
		});
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({ run: { name: "Run", kind: "write" } })},
				supports_execute = true
			WHERE organization_id = ${orgId} AND key = 'demo.decider.private'
		`;
		const runId = await pendingRun(ownPrivate, "demo.decider.private");
		const result = await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			memberCtx,
		);
		expect(result).toMatchObject({ approved: true, run_id: runId });
		const [run] = await sql`
			SELECT approval_status, status FROM runs WHERE id = ${runId}
		`;
		expect(run).toMatchObject({ approval_status: "approved", status: "pending" });
	});

	it("revokes the device owner's decision authority when their connection is unpinned or deleted", async () => {
		const sql = getTestDb();
		const [original] = await sql`
			SELECT device_worker_id FROM connections WHERE id = ${ownPrivate}
		`;
		for (const mutation of [
			sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${ownPrivate}`,
			sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${ownPrivate}`,
		]) {
			const runId = await pendingRun(ownPrivate, "demo.decider.private");
			try {
				expect((await resolveEntityApprovalRun(runId, orgId)).ownerUserId).toBe(memberCtx.userId);
				await mutation;
				expect((await resolveEntityApprovalRun(runId, orgId)).ownerUserId).toBeNull();
				for (const action of ["approve", "reject"] as const) {
					await expect(
						manageOperations({ action, run_id: runId }, {} as Env, memberCtx),
					).rejects.toThrow(/requires admin or owner access/);
				}
			} finally {
				await sql`
					UPDATE connections SET visibility = 'private',
						device_worker_id = ${original.device_worker_id}, deleted_at = NULL
					WHERE id = ${ownPrivate}
				`;
			}
		}
	});

	it("names the device owner as decider for a shared connection on their device, and a private one only they created", async () => {
		const own = await pendingRun(ownPrivate, "demo.decider.private");
		const shared = await pendingRun(ownShared, "demo.decider.shared");
		const elsewhere = await pendingRun(othersDevice, "demo.decider.elsewhere");

		expect(await resolveEntityApprovalRun(own, orgId)).toEqual({
			state: "pending",
			ownerUserId: memberCtx.userId,
		});
		expect((await resolveEntityApprovalRun(shared, orgId)).ownerUserId).toBe(memberCtx.userId);
		expect((await resolveEntityApprovalRun(elsewhere, orgId)).ownerUserId).toBeNull();
	});

	it("lets the device owner decide runs on their device and nobody else non-admin", async () => {
		const own = await pendingRun(ownPrivate, "demo.decider.private");
		await expect(
			manageOperations({ action: "reject", run_id: own }, {} as Env, otherCtx),
		).rejects.toThrow(/requires admin or owner access/);

		const rejected = (await manageOperations(
			{ action: "reject", run_id: own },
			{} as Env,
			memberCtx,
		)) as { rejected?: boolean; error?: string };
		expect(rejected.error).toBeUndefined();
		expect(rejected.rejected).toBe(true);

		const shared = await pendingRun(ownShared, "demo.decider.shared");
		await expect(
			manageOperations({ action: "reject", run_id: shared }, {} as Env, otherCtx),
		).rejects.toThrow(/requires admin or owner access/);
		expect(((await manageOperations(
			{ action: "reject", run_id: shared },
			{} as Env,
			memberCtx,
		)) as { rejected?: boolean }).rejected).toBe(true);

		const elsewhere = await pendingRun(othersDevice, "demo.decider.elsewhere");
		await expect(
			manageOperations({ action: "reject", run_id: elsewhere }, {} as Env, memberCtx),
		).rejects.toThrow(/requires admin or owner access/);
		const byOwner = (await manageOperations(
			{ action: "reject", run_id: elsewhere },
			{} as Env,
			ownerCtx,
		)) as { rejected?: boolean };
		expect(byOwner.rejected).toBe(true);
	});

	it("notifies the device owner alongside the admins, and only them", async () => {
		const sql = getTestDb();
		async function recipientsFor(connectionId: number, key: string): Promise<string[]> {
			const runId = await pendingRun(connectionId, key);
			const [event] = await sql<{ id: number }>`
				SELECT id FROM events WHERE run_id = ${runId} ORDER BY id DESC LIMIT 1
			`;
			await notifyActionApprovalNeeded({
				orgId,
				runId,
				actionKey: "run",
				connectionName: key,
				eventId: Number(event.id),
				operation: { name: "Run", input: {} },
			});
			const rows = await sql<{ user_id: string }>`
				SELECT DISTINCT nt.user_id
				FROM notification_targets nt
				JOIN events e ON e.id = nt.event_id
				WHERE e.organization_id = ${orgId}
				  AND (e.metadata->'delivery_request'->'context'->>'decisionRunId')::bigint = ${runId}
			`;
			return rows.map((row) => row.user_id).sort();
		}

		expect(await recipientsFor(ownPrivate, "demo.decider.private")).toEqual(
			[ownerCtx.userId, memberCtx.userId].sort(),
		);
		expect(await recipientsFor(ownShared, "demo.decider.shared")).toEqual(
			[ownerCtx.userId, memberCtx.userId].sort(),
		);
	});
});
